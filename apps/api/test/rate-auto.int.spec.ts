import "reflect-metadata";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { Pool } from "pg";
import { AppModule } from "../src/app.module";
import type { AppConfig } from "../src/config";
import { DatabaseService } from "../src/database/database.module";
import { RateAutoService } from "../src/exchange-rate/rate-auto.service";
import { configureApp } from "../src/setup";
import {
  cleanup,
  config,
  createCustomerUser,
  createStaffUser,
  createTenant,
  newPool,
  userToken,
  type TestTenant,
} from "./helpers";

const HTML = readFileSync(join(__dirname, "fixtures", "bcv-rates-excerpt.html"), "utf8");

/** Fuentes simuladas: el BCV (HTML real con la cifra cambiada) y la API de respaldo (JSON). */
let bcvMode: "ok" | "down";
let apiMode: "ok" | "down";
let bcvRate: number;
let apiRate: number;
let requests: number;

const bcvHtml = (rate: number) => HTML.replace("926,35920000", rate.toFixed(8).replace(".", ","));

describe("tasa automática BCV (Postgres real, fuentes simuladas)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let server: Server;
  let base: string;
  let app: INestApplication;
  const orgs: string[] = [];
  const users: string[] = [];

  const cfg = (over: Partial<AppConfig["bcv"]> = {}): AppConfig => ({
    ...config,
    bcv: {
      ...config.bcv,
      primaryUrl: `${base}/bcv`,
      fallbackUrl: `${base}/api`,
      timeoutMs: 2000,
      maxJumpPercent: 25,
      schedulerEnabled: false,
      ...over,
    },
  });
  const service = (over: Partial<AppConfig["bcv"]> = {}) => new RateAutoService(db, cfg(over));

  async function tenant(auto: Partial<{ enabled: boolean; respect: boolean }> = {}) {
    const t = await createTenant(pool);
    orgs.push(t.orgId);
    await pool.query(
      `UPDATE public.organizations
          SET rate_auto_enabled = $2, rate_auto_respect_manual = $3
        WHERE id = $1`,
      [t.orgId, auto.enabled ?? true, auto.respect ?? true],
    );
    return t;
  }
  /** Tasa manual con la fecha que se pida (el trigger la copia a la organización). */
  async function manualRate(t: TestTenant, rate: number, ageHours = 0) {
    await pool.query(
      `INSERT INTO public.exchange_rates (org_id, rate_bs, source, created_at)
       VALUES ($1, $2, 'manual', now() - make_interval(hours => $3::int))`,
      [t.orgId, rate, ageHours],
    );
  }
  const org = async (t: TestTenant) =>
    (
      await pool.query(
        `SELECT exchange_rate_bs::float AS rate, rate_auto_status AS status,
                rate_auto_detail AS detail, rate_auto_provider AS provider,
                rate_auto_ok_at AS ok_at
           FROM public.organizations WHERE id = $1`,
        [t.orgId],
      )
    ).rows[0];
  const history = async (t: TestTenant) =>
    (
      await pool.query(
        `SELECT rate_bs::float AS rate, source, set_by FROM public.exchange_rates
          WHERE org_id = $1 ORDER BY created_at, id`,
        [t.orgId],
      )
    ).rows;
  const makeDue = (t: TestTenant) =>
    pool.query("UPDATE public.organizations SET rate_auto_checked_at = NULL WHERE id = $1", [
      t.orgId,
    ]);

  beforeAll(async () => {
    pool = newPool();
    db = new DatabaseService(config);
    server = createServer((req, res) => {
      requests++;
      if (req.url?.startsWith("/bcv")) {
        if (bcvMode === "down") {
          res.statusCode = 503;
          return res.end("mantenimiento");
        }
        res.setHeader("content-type", "text/html");
        return res.end(bcvHtml(bcvRate));
      }
      if (apiMode === "down") {
        res.statusCode = 500;
        return res.end("{}");
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ promedio: apiRate, fechaActualizacion: "2026-11-27" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // La aplicación completa lee las fuentes de las variables de entorno (ver loadConfig).
    process.env.BCV_URL = `${base}/bcv`;
    process.env.BCV_FALLBACK_URL = `${base}/api`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
  });

  beforeEach(() => {
    bcvMode = "ok";
    apiMode = "ok";
    bcvRate = 40.1234;
    apiRate = 40.5;
    requests = 0;
  });

  afterAll(async () => {
    delete process.env.BCV_URL;
    delete process.env.BCV_FALLBACK_URL;
    await cleanup(pool, orgs, users);
    await app.close();
    await db.onModuleDestroy();
    await pool.end();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  describe("revisión periódica", () => {
    it("registra la tasa del BCV con source 'bcv', sin usuario, y no repite si no cambió", async () => {
      const t = await tenant();
      expect(await service().runDue()).toEqual({ processed: expect.any(Number) });
      expect(await org(t)).toMatchObject({ rate: 40.1234, status: "ok", provider: "bcv.org.ve" });
      expect(await history(t)).toEqual([{ rate: 40.1234, source: "bcv", set_by: null }]);

      // Todavía no le toca: no se vuelve a consultar.
      const before = requests;
      await service().runDue();
      expect(requests).toBe(before);

      // Le toca otra vez, misma tasa: no hay fila nueva y el estado es 'unchanged'.
      await makeDue(t);
      await service().runDue();
      expect(await history(t)).toHaveLength(1);
      expect(await org(t)).toMatchObject({ status: "unchanged", provider: "bcv.org.ve" });

      // Cambia la tasa: fila nueva.
      bcvRate = 41;
      await makeDue(t);
      await service().runDue();
      expect((await history(t)).map((h) => h.rate)).toEqual([40.1234, 41]);
      expect((await org(t)).rate).toBe(41);
    });

    it("consulta las fuentes UNA vez aunque haya varias organizaciones", async () => {
      const a = await tenant();
      const b = await tenant();
      requests = 0;
      await service().runDue();
      // Pueden existir otras organizaciones de otras pruebas; lo que importa es una sola lectura.
      expect(requests).toBe(1);
      expect((await org(a)).rate).toBe(40.1234);
      expect((await org(b)).rate).toBe(40.1234);
    });

    it("no toca organizaciones con la tasa automática apagada ni inactivas", async () => {
      const off = await tenant({ enabled: false });
      const inactive = await tenant();
      await pool.query("UPDATE public.organizations SET is_active = false WHERE id = $1", [
        inactive.orgId,
      ]);
      await service().runDue();
      expect(await history(off)).toHaveLength(0);
      expect(await history(inactive)).toHaveLength(0);
      expect((await org(off)).rate).toBe(1);
    });

    it("respeta el intervalo de cada organización", async () => {
      const t = await tenant();
      await service().runDue();
      await pool.query(
        `UPDATE public.organizations
            SET rate_auto_interval_minutes = 15,
                rate_auto_checked_at = now() - interval '10 minutes'
          WHERE id = $1`,
        [t.orgId],
      );
      bcvRate = 42;
      await service().runDue();
      expect((await org(t)).rate).toBe(40.1234); // 10 min < 15: aún no
      await pool.query(
        "UPDATE public.organizations SET rate_auto_checked_at = now() - interval '16 minutes' WHERE id = $1",
        [t.orgId],
      );
      await service().runDue();
      expect((await org(t)).rate).toBe(42);
    });

    it("dos instancias a la vez no duplican la fila", async () => {
      const t = await tenant();
      await Promise.all([service().runDue(), service().runDue(), service().runDue()]);
      expect(await history(t)).toHaveLength(1);
    });
  });

  describe("respaldo y alertas", () => {
    it("si el BCV cae, usa la API pública de respaldo", async () => {
      const t = await tenant();
      bcvMode = "down";
      await service().runDue();
      expect(await org(t)).toMatchObject({ rate: 40.5, status: "ok", provider: "dolarapi" });
      expect((await history(t))[0]).toMatchObject({ source: "bcv" });
    });

    it("si caen las dos fuentes, conserva la última tasa y deja el aviso", async () => {
      const t = await tenant();
      await manualRate(t, 39, 72); // manual de hace 3 días: no bloquea
      bcvMode = "down";
      apiMode = "down";
      await service().runDue();
      const o = await org(t);
      expect(o).toMatchObject({ rate: 39, status: "source_failed" });
      expect(o.detail).toMatch(/Ninguna fuente/);
      expect(o.ok_at).toBeNull();
      expect(await history(t)).toHaveLength(1);
    });

    it("sin la API de respaldo configurada, un fallo del BCV es source_failed", async () => {
      const t = await tenant();
      bcvMode = "down";
      await service({ fallbackUrl: null }).runDue();
      expect((await org(t)).status).toBe("source_failed");
    });

    it("al volver la fuente, se recupera y se anota ok_at", async () => {
      const t = await tenant();
      bcvMode = "down";
      apiMode = "down";
      await service().runDue();
      expect((await org(t)).status).toBe("source_failed");
      bcvMode = "ok";
      await makeDue(t);
      await service().runDue();
      const o = await org(t);
      expect(o).toMatchObject({ status: "ok", rate: 40.1234, detail: null });
      expect(o.ok_at).not.toBeNull();
    });

    it("una lectura con un salto brusco no se aplica", async () => {
      const t = await tenant({ respect: false });
      await manualRate(t, 40, 72);
      bcvRate = 4000; // 100 veces más: error de lectura
      apiRate = 4000;
      await service().runDue();
      const o = await org(t);
      expect(o).toMatchObject({ rate: 40, status: "jump_rejected" });
      expect(o.detail).toMatch(/varía/);
      expect(await history(t)).toHaveLength(1);
    });

    it("el umbral es configurable", async () => {
      const t = await tenant({ respect: false });
      await manualRate(t, 40, 72);
      bcvRate = 44; // +10 %
      await service({ maxJumpPercent: 5 }).runDue();
      expect((await org(t)).status).toBe("jump_rejected");
      await makeDue(t);
      await service({ maxJumpPercent: 25 }).runDue();
      expect(await org(t)).toMatchObject({ status: "ok", rate: 44 });
    });

    it("una página del BCV con otro formato no se aplica y cae a la secundaria", async () => {
      const t = await tenant();
      bcvRate = Number.NaN; // "NaN" no es una cifra venezolana
      await service().runDue();
      expect(await org(t)).toMatchObject({ provider: "dolarapi", rate: 40.5 });
    });
  });

  describe("prioridad de la tasa manual", () => {
    it("una manual de hoy gana si la organización lo pide", async () => {
      const t = await tenant({ respect: true });
      await manualRate(t, 40, 0);
      bcvRate = 41;
      await service().runDue();
      expect(await org(t)).toMatchObject({ rate: 40, status: "manual_priority" });
      expect(await history(t)).toHaveLength(1);
    });

    it("una manual de hace días no bloquea a la automática", async () => {
      const t = await tenant({ respect: true });
      await manualRate(t, 40, 72);
      bcvRate = 41;
      await service().runDue();
      expect(await org(t)).toMatchObject({ rate: 41, status: "ok" });
    });

    it("si la organización no pide respetarla, la automática la reemplaza", async () => {
      const t = await tenant({ respect: false });
      await manualRate(t, 40, 0);
      bcvRate = 41;
      await service().runDue();
      expect(await org(t)).toMatchObject({ rate: 41, status: "ok" });
    });
  });

  describe("API de usuario", () => {
    let a: TestTenant;
    let b: TestTenant;
    let adminA: string;
    let staffA: string;
    let customerA: string;
    let adminB: string;
    const auth = (id: string) => `Bearer ${userToken(id)}`;
    const url = (orgId: string, tail = "") => `/v1/orgs/${orgId}/exchange-rate/auto${tail}`;

    beforeEach(async () => {
      a = await tenant({ enabled: false });
      b = await tenant({ enabled: false });
      adminA = await createStaffUser(pool, a.orgId, "admin");
      staffA = await createStaffUser(pool, a.orgId, "staff");
      customerA = (await createCustomerUser(pool, a.orgId)).userId;
      adminB = await createStaffUser(pool, b.orgId, "admin");
      users.push(adminA, staffA, customerA, adminB);
    });

    it("cualquier miembro lee la configuración; un no miembro recibe 404; sin token, 401", async () => {
      for (const u of [adminA, staffA, customerA]) {
        const res = await request(app.getHttpServer())
          .get(url(a.orgId))
          .set("Authorization", auth(u));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          org_id: a.orgId,
          enabled: false,
          interval_minutes: 60,
          respect_manual: true,
          status: null,
        });
      }
      await request(app.getHttpServer())
        .get(url(a.orgId))
        .set("Authorization", auth(adminB))
        .expect(404);
      await request(app.getHttpServer()).get(url(a.orgId)).expect(401);
    });

    it("un administrador la activa y la configura; el personal y los compradores no", async () => {
      const body = { enabled: true, interval_minutes: 30, respect_manual: false };
      const ok = await request(app.getHttpServer())
        .put(url(a.orgId))
        .set("Authorization", auth(adminA))
        .send(body);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject(body);

      for (const u of [staffA, customerA, adminB]) {
        await request(app.getHttpServer())
          .put(url(a.orgId))
          .set("Authorization", auth(u))
          .send({ enabled: false, interval_minutes: 60, respect_manual: true })
          .expect(403);
      }
      const row = await org(a);
      expect(row).toBeDefined();
      expect(
        (
          await pool.query("SELECT rate_auto_enabled AS e FROM public.organizations WHERE id=$1", [
            a.orgId,
          ])
        ).rows[0].e,
      ).toBe(true);
    });

    it.each([
      { enabled: true, interval_minutes: 5, respect_manual: true },
      { enabled: true, interval_minutes: 2000, respect_manual: true },
      { enabled: true, interval_minutes: 30.5, respect_manual: true },
      { enabled: "sí", interval_minutes: 30, respect_manual: true },
      { enabled: true, interval_minutes: 30 },
      { enabled: true, interval_minutes: 30, respect_manual: true, extra: 1 },
    ])("rechaza una configuración inválida %j", async (bad) => {
      await request(app.getHttpServer())
        .put(url(a.orgId))
        .set("Authorization", auth(adminA))
        .send(bad)
        .expect(400);
    });

    it("al activarla, la revisión ocurre en la siguiente vuelta", async () => {
      await pool.query(
        "UPDATE public.organizations SET rate_auto_checked_at = now() WHERE id = $1",
        [a.orgId],
      );
      await request(app.getHttpServer())
        .put(url(a.orgId))
        .set("Authorization", auth(adminA))
        .send({ enabled: true, interval_minutes: 60, respect_manual: true })
        .expect(200);
      await service().runDue();
      expect(await org(a)).toMatchObject({ rate: 40.1234, status: "ok" });
    });

    it("«Actualizar ahora» consulta las fuentes aunque la automática esté apagada", async () => {
      const res = await request(app.getHttpServer())
        .post(url(a.orgId, "/refresh"))
        .set("Authorization", auth(adminA))
        .send({});
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: "ok", provider: "bcv.org.ve", enabled: false });
      expect(await org(a)).toMatchObject({ rate: 40.1234 });
    });

    it("«Actualizar ahora» rechaza un salto, y con force lo acepta", async () => {
      await manualRate(a, 40, 72);
      bcvRate = 4000;
      const res = await request(app.getHttpServer())
        .post(url(a.orgId, "/refresh"))
        .set("Authorization", auth(adminA))
        .send({});
      expect(res.body).toMatchObject({ status: "jump_rejected" });
      expect((await org(a)).rate).toBe(40);

      const forced = await request(app.getHttpServer())
        .post(url(a.orgId, "/refresh"))
        .set("Authorization", auth(adminA))
        .send({ force: true });
      expect(forced.body).toMatchObject({ status: "ok" });
      expect((await org(a)).rate).toBe(4000);
    });

    it("«Actualizar ahora» solo para administradores", async () => {
      for (const u of [staffA, customerA, adminB]) {
        await request(app.getHttpServer())
          .post(url(a.orgId, "/refresh"))
          .set("Authorization", auth(u))
          .send({})
          .expect(403);
      }
      expect(requests).toBe(0);
    });
  });
});
