import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { AgentAlertsService } from "../src/agent/agent-alerts.service";
import type { AppConfig, NotifyConfig } from "../src/config";
import { DatabaseService } from "../src/database/database.module";
import { cleanup, config, createTenant, newPool, type TestTenant } from "./helpers";

interface Received {
  headers: IncomingMessage["headers"];
  raw: string;
  body: Record<string, unknown>;
}

describe("aviso de agente sin conexión (webhook)", () => {
  let pool: Pool;
  let server: Server;
  let url: string;
  let received: Received[];
  let respondWith: number;
  let db: DatabaseService;
  const tenants: TestTenant[] = [];
  /** Estado de `agent_offline_notified_at` de las organizaciones que NO son de la prueba, para dejarlas como estaban. */
  let untouched: { id: string; notified: Date | null }[] = [];

  const notify = (over: Partial<NotifyConfig> = {}): AppConfig => ({
    ...config,
    notify: {
      webhookUrl: url,
      webhookSecret: null,
      offlineAfterSeconds: 180,
      checkIntervalSeconds: 60,
      ...over,
    },
  });
  const service = (over: Partial<NotifyConfig> = {}) => new AgentAlertsService(db, notify(over));

  /** Cambia el latido de una organización a "hace N segundos" (null = nunca). */
  async function heartbeatAgo(t: TestTenant, seconds: number | null) {
    await pool.query(
      `UPDATE public.organizations
         SET last_heartbeat_at = CASE WHEN $2::int IS NULL THEN NULL ELSE now() - make_interval(secs => $2::int) END
       WHERE id = $1`,
      [t.orgId, seconds],
    );
  }
  const notified = async (t: TestTenant) =>
    (
      await pool.query(
        "SELECT agent_offline_notified_at AS at FROM public.organizations WHERE id = $1",
        [t.orgId],
      )
    ).rows[0].at as Date | null;
  const mine = (t: TestTenant) =>
    received.filter((r) => (r.body.organization as { id: string }).id === t.orgId);

  beforeAll(async () => {
    pool = newPool();
    db = new DatabaseService(config);
    untouched = (
      await pool.query("SELECT id, agent_offline_notified_at AS notified FROM public.organizations")
    ).rows;
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        received.push({
          headers: req.headers,
          raw,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        res.statusCode = respondWith;
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });

  beforeEach(() => {
    received = [];
    respondWith = 200;
  });

  afterAll(async () => {
    // Las organizaciones del seed pudieron entrar en la revisión: se dejan como estaban.
    for (const o of untouched)
      await pool.query(
        "UPDATE public.organizations SET agent_offline_notified_at = $2 WHERE id = $1",
        [o.id, o.notified],
      );
    await cleanup(
      pool,
      tenants.map((t) => t.orgId),
    );
    await new Promise<void>((r) => server.close(() => r()));
    await db.onModuleDestroy();
    await pool.end();
  });

  async function tenant(): Promise<TestTenant> {
    const t = await createTenant(pool);
    tenants.push(t);
    return t;
  }

  it("avisa UNA vez cuando el agente lleva más de la ventana sin latido", async () => {
    const t = await tenant();
    await heartbeatAgo(t, 600);
    const svc = service();

    await svc.check();
    expect(mine(t)).toHaveLength(1);
    const msg = mine(t)[0];
    expect(msg.body).toMatchObject({
      event: "agent.offline",
      organization: { id: t.orgId, slug: t.slug },
    });
    expect(msg.body.offline_for_seconds as number).toBeGreaterThanOrEqual(600);
    expect(typeof msg.body.last_heartbeat_at).toBe("string");
    expect(typeof msg.body.message).toBe("string");
    expect(msg.headers["x-erp-bridge-event"]).toBe("agent.offline");
    expect(await notified(t)).not.toBeNull();

    await svc.check();
    await svc.check();
    expect(mine(t)).toHaveLength(1); // no se repite mientras siga caído
  });

  it("no avisa si el latido es reciente ni si el agente nunca se conectó", async () => {
    const reciente = await tenant();
    const nunca = await tenant();
    await heartbeatAgo(reciente, 30);
    await heartbeatAgo(nunca, null);
    await service().check();
    expect(mine(reciente)).toHaveLength(0);
    expect(mine(nunca)).toHaveLength(0);
    expect(await notified(reciente)).toBeNull();
    expect(await notified(nunca)).toBeNull();
  });

  it("respeta la ventana configurada", async () => {
    const t = await tenant();
    await heartbeatAgo(t, 120); // 2 min
    await service({ offlineAfterSeconds: 180 }).check();
    expect(mine(t)).toHaveLength(0);
    await service({ offlineAfterSeconds: 60 }).check();
    expect(mine(t)).toHaveLength(1);
  });

  it("no avisa de organizaciones desactivadas", async () => {
    const t = await tenant();
    await heartbeatAgo(t, 900);
    await pool.query("UPDATE public.organizations SET is_active = false WHERE id = $1", [t.orgId]);
    await service().check();
    expect(mine(t)).toHaveLength(0);
  });

  it("avisa la recuperación una sola vez y vuelve a avisar si cae de nuevo", async () => {
    const t = await tenant();
    await heartbeatAgo(t, 600);
    const svc = service();
    await svc.check(); // offline
    await pool.query("UPDATE public.organizations SET last_heartbeat_at = now() WHERE id = $1", [
      t.orgId,
    ]);

    await svc.check();
    expect(mine(t).map((r) => r.body.event)).toEqual(["agent.offline", "agent.online"]);
    expect(await notified(t)).toBeNull();
    await svc.check();
    expect(mine(t)).toHaveLength(2); // sin repetir

    await heartbeatAgo(t, 900); // cae otra vez
    await svc.check();
    expect(mine(t).map((r) => r.body.event)).toEqual([
      "agent.offline",
      "agent.online",
      "agent.offline",
    ]);
  });

  it("si el webhook falla, no se da por avisado y se reintenta en la siguiente revisión", async () => {
    const t = await tenant();
    await heartbeatAgo(t, 600);
    const svc = service();
    respondWith = 500;

    const failed = await svc.check();
    expect(mine(t)).toHaveLength(1); // se intentó
    expect(failed.offline).toBe(0); // pero no cuenta como enviado
    expect(await notified(t)).toBeNull();

    respondWith = 200;
    const ok = await svc.check();
    expect(mine(t)).toHaveLength(2);
    expect(ok.offline).toBeGreaterThanOrEqual(1);
    expect(await notified(t)).not.toBeNull();
    await svc.check();
    expect(mine(t)).toHaveLength(2);
  });

  it("un webhook caído (conexión rechazada) tampoco rompe la revisión", async () => {
    const t = await tenant();
    await heartbeatAgo(t, 600);
    const result = await service({ webhookUrl: "http://127.0.0.1:1/nadie" }).check();
    expect(result.offline).toBe(0);
    expect(await notified(t)).toBeNull();
  });

  it("firma el cuerpo con HMAC-SHA256 si hay secreto, y no firma si no lo hay", async () => {
    const t = await tenant();
    await heartbeatAgo(t, 600);
    await service({ webhookSecret: "s3creto" }).check();
    const msg = mine(t)[0];
    const expected = `sha256=${createHmac("sha256", "s3creto").update(msg.raw).digest("hex")}`;
    expect(msg.headers["x-erp-bridge-signature"]).toBe(expected);

    const t2 = await tenant();
    await heartbeatAgo(t2, 600);
    await service().check();
    expect(mine(t2)[0].headers["x-erp-bridge-signature"]).toBeUndefined();
  });

  it("dos instancias de la API a la vez no duplican el aviso", async () => {
    const t = await tenant();
    await heartbeatAgo(t, 600);
    await Promise.all([service().check(), service().check(), service().check()]);
    expect(mine(t)).toHaveLength(1);
  });

  it("sin webhook configurado no hace nada ni toca la base", async () => {
    const t = await tenant();
    await heartbeatAgo(t, 600);
    const svc = new AgentAlertsService(db, notify({ webhookUrl: null }));
    expect(await svc.check()).toEqual({ offline: 0, online: 0 });
    expect(mine(t)).toHaveLength(0);
    expect(await notified(t)).toBeNull();
  });

  it("el temporizador solo se arma con webhook y se libera al cerrar", () => {
    const off = new AgentAlertsService(db, notify({ webhookUrl: null }));
    off.onModuleInit();
    expect(off.isRunning()).toBe(false);
    const on = service({ checkIntervalSeconds: 3600 });
    on.onModuleInit();
    expect(on.isRunning()).toBe(true);
    on.onModuleDestroy();
    expect(on.isRunning()).toBe(false);
  });
});
