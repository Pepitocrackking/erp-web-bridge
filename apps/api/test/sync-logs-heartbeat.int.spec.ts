import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { Pool } from "pg";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";
import { cleanup, createTenant, newPool, type TestTenant } from "./helpers";

const product = (sku: string, over: Record<string, unknown> = {}) => ({
  sku,
  name: `Producto ${sku}`,
  category: "General",
  price_usd: 10,
  stock: 5,
  active: true,
  sync_hash: `h-${sku}`,
  ...over,
});

const batch = (kind: "products" | "customers", records: unknown[], extra = {}) => ({
  batch_id: randomUUID(),
  sent_at: new Date().toISOString(),
  kind,
  full_reconciliation: false,
  records,
  ...extra,
});

describe("sync_logs de errores y heartbeat (Postgres real)", () => {
  let app: INestApplication;
  let pool: Pool;
  let a: TestTenant;
  let b: TestTenant;
  const orgs: string[] = [];

  beforeAll(async () => {
    pool = newPool();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
  });

  beforeEach(async () => {
    a = await createTenant(pool);
    b = await createTenant(pool);
    orgs.push(a.orgId, b.orgId);
  });

  afterAll(async () => {
    await cleanup(pool, orgs);
    await app.close();
    await pool.end();
  });

  const post = (path: string, key: string | undefined, body: unknown) => {
    const req = request(app.getHttpServer()).post(path);
    return key === undefined
      ? req.send(body as object)
      : req.set("x-api-key", key).send(body as object);
  };

  const logs = async (orgId: string) =>
    (
      await pool.query("SELECT * FROM public.sync_logs WHERE org_id = $1 ORDER BY created_at", [
        orgId,
      ])
    ).rows;

  const org = async (orgId: string) =>
    (await pool.query("SELECT * FROM public.organizations WHERE id = $1", [orgId])).rows[0];

  describe("fallos de sincronización", () => {
    it("un lote con cuerpo inválido deja una fila de error con su batch_id y no toca last_sync_at", async () => {
      const bad = batch("products", [product("A1", { price_usd: -1 })]);
      await post("/v1/sync/products", a.apiKey, bad).expect(400);
      const log = await logs(a.orgId);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        direction: "erp_to_cloud",
        entity: "products",
        batch_id: bad.batch_id,
        records_processed: 0,
        status: "error",
      });
      expect(log[0].error_detail).toContain("400");
      expect(log[0].error_detail).toContain("price_usd");
      expect((await org(a.orgId)).last_sync_at).toBeNull();
    });

    it("un cuerpo sin batch_id válido se anota con batch_id nulo", async () => {
      await post("/v1/sync/customers", a.apiKey, { kind: "customers", batch_id: "no-uuid" }).expect(
        400,
      );
      await post("/v1/sync/customers", a.apiKey, "basura").expect(400);
      const log = await logs(a.orgId);
      expect(log).toHaveLength(2);
      expect(
        log.every((l) => l.entity === "customers" && l.batch_id === null && l.status === "error"),
      ).toBe(true);
    });

    it("una reconciliación incompleta (409) y un SKU repetido (422) quedan anotados", async () => {
      const incomplete = batch("products", [product("A1")], {
        full_reconciliation: true,
        reconciliation_id: randomUUID(),
        final_batch: true,
        total_records: 9,
      });
      await post("/v1/sync/products", a.apiKey, incomplete).expect(409);
      const dup = batch("products", [product("A1"), product("A1")]);
      await post("/v1/sync/products", a.apiKey, dup).expect(422);
      const log = await logs(a.orgId);
      expect(log.map((l) => [l.status, l.batch_id])).toEqual([
        ["error", incomplete.batch_id],
        ["error", dup.batch_id],
      ]);
      expect(log[0].error_detail).toContain("409");
      expect(log[0].error_detail).toContain("Reconciliación incompleta");
      expect(log[1].error_detail).toContain("422");
    });

    it("el error de un lote no impide reintentarlo con el mismo batch_id", async () => {
      const body = batch("products", [product("A1", { price_usd: 1e12 })]);
      await post("/v1/sync/products", a.apiKey, body).expect(422);
      // El agente corrige el dato y reenvía el mismo lote.
      const fixed = { ...body, records: [product("A1")] };
      const res = await post("/v1/sync/products", a.apiKey, fixed).expect(200);
      expect(res.body.duplicate).toBe(false);
      const log = await logs(a.orgId);
      expect(log.map((l) => l.status)).toEqual(["error", "success"]);
      expect((await org(a.orgId)).last_sync_at).not.toBeNull();
    });

    it("no guarda datos del lote en el detalle del error y lo acota", async () => {
      const secret = "NOMBRE-SECRETO-DEL-CLIENTE";
      const bad = batch("customers", [
        {
          customer_code: "C1",
          tax_id: "J-1",
          business_name: secret,
          credit_limit_usd: -1,
          current_debt_usd: 0,
          active: true,
        },
      ]);
      await post("/v1/sync/customers", a.apiKey, bad).expect(400);
      const [log] = await logs(a.orgId);
      expect(log.error_detail).not.toContain(secret);
      expect(log.error_detail.length).toBeLessThanOrEqual(1000);
    });

    it("los fallos se anotan solo en la organización de la clave", async () => {
      await post("/v1/sync/products", a.apiKey, { basura: true }).expect(400);
      expect(await logs(a.orgId)).toHaveLength(1);
      expect(await logs(b.orgId)).toHaveLength(0);
    });

    it("sin credenciales válidas no se escribe ninguna bitácora", async () => {
      await post("/v1/sync/products", undefined, batch("products", [])).expect(401);
      await post("/v1/sync/products", "falsa", batch("products", [])).expect(401);
      const total = await pool.query(
        "SELECT count(*)::int AS n FROM public.sync_logs WHERE org_id = ANY($1::uuid[])",
        [[a.orgId, b.orgId]],
      );
      expect(total.rows[0].n).toBe(0);
    });

    it("cada lote exitoso y cada fallido deja exactamente una fila", async () => {
      await post("/v1/sync/products", a.apiKey, batch("products", [product("A1")])).expect(200);
      await post("/v1/sync/customers", a.apiKey, batch("customers", [])).expect(200);
      await post("/v1/sync/products", a.apiKey, { basura: true }).expect(400);
      const log = await logs(a.orgId);
      expect(log.map((l) => [l.entity, l.status])).toEqual([
        ["products", "success"],
        ["customers", "success"],
        ["products", "error"],
      ]);
    });
  });

  describe("POST /v1/agent/heartbeat", () => {
    const beat = (key: string | undefined, body: unknown) => post("/v1/agent/heartbeat", key, body);

    it("registra el latido, la versión y devuelve la hora del servidor", async () => {
      const res = await beat(a.apiKey, { agent_version: "0.3.1", queue_depth: 0 }).expect(200);
      expect(res.body.ok).toBe(true);
      expect(Math.abs(Date.parse(res.body.server_time) - Date.now())).toBeLessThan(10_000);
      const row = await org(a.orgId);
      expect(row.agent_version).toBe("0.3.1");
      expect(row.last_heartbeat_at).not.toBeNull();
    });

    it("un latido normal no escribe en sync_logs; uno con last_error sí", async () => {
      await beat(a.apiKey, { agent_version: "0.3.1" }).expect(200);
      await beat(a.apiKey, { agent_version: "0.3.1", last_error: null }).expect(200);
      expect(await logs(a.orgId)).toHaveLength(0);
      await beat(a.apiKey, {
        agent_version: "0.3.1",
        queue_depth: 4,
        last_error: "sin red hace 20 min",
      }).expect(200);
      const log = await logs(a.orgId);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        entity: "heartbeat",
        direction: "erp_to_cloud",
        status: "error",
        error_detail: "sin red hace 20 min",
        batch_id: null,
      });
    });

    it("el último latido manda y no toca last_sync_at", async () => {
      await beat(a.apiKey, { agent_version: "0.1.0" }).expect(200);
      const first = (await org(a.orgId)).last_heartbeat_at as Date;
      await beat(a.apiKey, { agent_version: "0.2.0" }).expect(200);
      const row = await org(a.orgId);
      expect(row.agent_version).toBe("0.2.0");
      expect(row.last_heartbeat_at.getTime()).toBeGreaterThanOrEqual(first.getTime());
      expect(row.last_sync_at).toBeNull();
    });

    it("la clave de A solo actualiza a A", async () => {
      await beat(a.apiKey, { agent_version: "9.9.9", last_error: "x" }).expect(200);
      const rowB = await org(b.orgId);
      expect(rowB.agent_version).toBeNull();
      expect(rowB.last_heartbeat_at).toBeNull();
      expect(await logs(b.orgId)).toHaveLength(0);
      await beat(a.apiKey, { agent_version: "1", org_id: b.orgId }).expect(400);
    });

    it("rechaza sin clave, con clave falsa, con organización inactiva y con cuerpo inválido", async () => {
      const off = await createTenant(pool, { isActive: false });
      orgs.push(off.orgId);
      await beat(undefined, { agent_version: "1" }).expect(401);
      await beat("falsa", { agent_version: "1" }).expect(401);
      await beat(off.apiKey, { agent_version: "1" }).expect(401);
      expect((await org(off.orgId)).last_heartbeat_at).toBeNull();
      for (const bad of [
        {},
        { agent_version: "" },
        { agent_version: "1", queue_depth: -1 },
        { agent_version: "1", last_error: "x".repeat(501) },
      ]) {
        await beat(a.apiKey, bad).expect(400);
      }
      expect((await org(a.orgId)).last_heartbeat_at).toBeNull();
    });
  });
});
