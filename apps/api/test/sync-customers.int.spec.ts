import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { Pool } from "pg";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";
import { cleanup, createTenant, newPool, type TestTenant } from "./helpers";

interface Cust {
  customer_code: string;
  tax_id: string;
  business_name: string;
  credit_limit_usd: number;
  current_debt_usd: number;
  active: boolean;
}

const customer = (code: string, over: Partial<Cust> = {}): Cust => ({
  customer_code: code,
  tax_id: `J-${code}-0`,
  business_name: `Cliente ${code}`,
  credit_limit_usd: 5000,
  current_debt_usd: 1250.5,
  active: true,
  ...over,
});

const many = (n: number, prefix = "C"): Cust[] =>
  Array.from({ length: n }, (_, i) => customer(`${prefix}${String(i).padStart(5, "0")}`));

const batch = (records: Cust[], extra: Record<string, unknown> = {}) => ({
  batch_id: randomUUID(),
  sent_at: new Date().toISOString(),
  kind: "customers",
  full_reconciliation: false,
  records,
  ...extra,
});

describe("POST /v1/sync/customers (Postgres real)", () => {
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

  const post = (key: string | undefined, body: unknown) => {
    const req = request(app.getHttpServer()).post("/v1/sync/customers");
    return key === undefined
      ? req.send(body as object)
      : req.set("x-api-key", key).send(body as object);
  };

  const rows = async (orgId: string) =>
    (
      await pool.query(
        `SELECT erp_customer_code, tax_id, business_name, credit_limit_usd::float AS credit_limit_usd,
                current_debt_usd::float AS current_debt_usd, is_active, price_list_id, updated_at
           FROM public.b2b_customers WHERE org_id = $1 ORDER BY erp_customer_code`,
        [orgId],
      )
    ).rows;

  const successLogs = async (orgId: string) =>
    (
      await pool.query(
        "SELECT * FROM public.sync_logs WHERE org_id = $1 AND entity = 'customers' AND status = 'success' ORDER BY created_at",
        [orgId],
      )
    ).rows;

  it("inserta clientes con límite de crédito y deuda, y anota sync_logs y last_sync_at", async () => {
    const body = batch([customer("C1"), customer("C2", { current_debt_usd: -30, active: false })]);
    const res = await post(a.apiKey, body).expect(200);
    expect(res.body).toEqual({
      batch_id: body.batch_id,
      duplicate: false,
      received: 2,
      inserted: 2,
      updated: 0,
      unchanged: 0,
      deactivated: null,
    });
    const stored = await rows(a.orgId);
    expect(stored[0]).toMatchObject({
      erp_customer_code: "C1",
      tax_id: "J-C1-0",
      business_name: "Cliente C1",
      credit_limit_usd: 5000,
      current_debt_usd: 1250.5,
      is_active: true,
    });
    // La deuda puede ser negativa (saldo a favor) y el estado inactivo se respeta.
    expect(stored[1]).toMatchObject({ current_debt_usd: -30, is_active: false });
    const log = await successLogs(a.orgId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      direction: "erp_to_cloud",
      entity: "customers",
      batch_id: body.batch_id,
      records_processed: 2,
      status: "success",
    });
    const org = await pool.query("SELECT last_sync_at FROM public.organizations WHERE id = $1", [
      a.orgId,
    ]);
    expect(org.rows[0].last_sync_at).not.toBeNull();
  });

  it("actualiza deuda y límite por (org_id, customer_code) sin duplicar", async () => {
    await post(a.apiKey, batch([customer("C1"), customer("C2")])).expect(200);
    const res = await post(
      a.apiKey,
      batch([
        customer("C1", { current_debt_usd: 4999.99, credit_limit_usd: 8000 }),
        customer("C3"),
      ]),
    ).expect(200);
    expect(res.body).toMatchObject({ received: 2, inserted: 1, updated: 1, unchanged: 0 });
    const stored = await rows(a.orgId);
    expect(stored.map((r) => r.erp_customer_code)).toEqual(["C1", "C2", "C3"]);
    expect(stored[0]).toMatchObject({ current_debt_usd: 4999.99, credit_limit_usd: 8000 });
  });

  it("no toca las filas sin cambios y conserva la lista de precios asignada desde el panel", async () => {
    await post(a.apiKey, batch(many(30))).expect(200);
    const pl = await pool.query<{ id: string }>(
      `INSERT INTO public.price_lists (org_id, code, name, is_default) VALUES ($1, 'L1', 'Lista 1', true)
       RETURNING id`,
      [a.orgId],
    );
    await pool.query(
      "UPDATE public.b2b_customers SET price_list_id = $2 WHERE org_id = $1 AND erp_customer_code = 'C00000'",
      [a.orgId, pl.rows[0]!.id],
    );
    const before = await rows(a.orgId);
    const res = await post(
      a.apiKey,
      batch(many(29).concat(customer("C00029", { credit_limit_usd: 1 }))),
    ).expect(200);
    expect(res.body).toMatchObject({ received: 30, inserted: 0, updated: 1, unchanged: 29 });
    const after = await rows(a.orgId);
    expect(after[0]!.price_list_id).toBe(pl.rows[0]!.id); // el ERP no pisa la lista de precios
    expect(after.slice(0, 29).map((r) => r.updated_at)).toEqual(
      before.slice(0, 29).map((r) => r.updated_at),
    );
  });

  it("es idempotente por batch_id (reenvío y envíos simultáneos)", async () => {
    const body = batch([customer("C1")]);
    await post(a.apiKey, body).expect(200);
    await post(a.apiKey, batch([customer("C1", { current_debt_usd: 7 })])).expect(200);
    const res = await post(a.apiKey, body).expect(200);
    expect(res.body).toMatchObject({ duplicate: true, received: 1, inserted: null });
    expect((await rows(a.orgId))[0]).toMatchObject({ current_debt_usd: 7 });
    expect(await successLogs(a.orgId)).toHaveLength(2);

    const same = batch(many(100));
    const [r1, r2] = await Promise.all([post(b.apiKey, same), post(b.apiKey, same)]);
    expect([r1.body.duplicate, r2.body.duplicate].sort()).toEqual([false, true]);
    expect(await successLogs(b.orgId)).toHaveLength(1);
  });

  it("una API key de A no escribe clientes en B", async () => {
    await post(b.apiKey, batch([customer("C1", { credit_limit_usd: 100 })])).expect(200);
    const bBefore = await rows(b.orgId);
    await post(a.apiKey, batch([customer("C1", { credit_limit_usd: 999999 })])).expect(200);
    await post(a.apiKey, { ...batch([customer("C1")]), org_id: b.orgId }).expect(400);
    expect(await rows(b.orgId)).toEqual(bBefore);
    expect((await rows(a.orgId))[0]).toMatchObject({ credit_limit_usd: 999999 });
  });

  it("rechaza sin clave, con clave falsa y con organización inactiva", async () => {
    const off = await createTenant(pool, { isActive: false });
    orgs.push(off.orgId);
    await post(undefined, batch([customer("C1")])).expect(401);
    await post("falsa", batch([customer("C1")])).expect(401);
    await post(off.apiKey, batch([customer("C1")])).expect(401);
  });

  describe("validación estricta", () => {
    it("rechaza cuerpos inválidos con 400 y no guarda nada", async () => {
      const bads: unknown[] = [
        batch([customer("C1"), { ...customer("C2"), credit_limit_usd: -1 }]),
        batch([{ ...customer("C1"), extra: 1 } as Cust]),
        batch([{ ...customer("C1"), tax_id: "   " }]),
        batch([{ customer_code: "C1" } as Cust]),
        { ...batch([]), kind: "products" },
        { ...batch([customer("C1")]), org_id: randomUUID() },
        batch(many(1001)),
      ];
      for (const bad of bads) await post(a.apiKey, bad).expect(400);
      expect(await rows(a.orgId)).toHaveLength(0);
      expect(await successLogs(a.orgId)).toHaveLength(0);
    });

    it("rechaza códigos repetidos en el lote con 422", async () => {
      const res = await post(
        a.apiKey,
        batch([customer("C1"), customer("C2"), customer("C1")]),
      ).expect(422);
      expect(res.body.codes).toEqual(["C1"]);
      expect(await rows(a.orgId)).toHaveLength(0);
    });

    it("los importes fuera de rango y los NUL son 422 y no dejan rastro", async () => {
      await post(
        a.apiKey,
        batch([customer("C1"), customer("C2", { credit_limit_usd: 1e12 })]),
      ).expect(422);
      await post(a.apiKey, batch([customer("C1", { current_debt_usd: -1e12 })])).expect(422);
      await post(a.apiKey, batch([customer("C1", { business_name: "a\u0000b" })])).expect(422);
      expect(await rows(a.orgId)).toHaveLength(0);
      expect(await successLogs(a.orgId)).toHaveLength(0);
    });
  });

  describe("reconciliación completa en varios lotes", () => {
    const recon = (id: string, records: Cust[], final: boolean, total?: number) =>
      batch(records, {
        full_reconciliation: true,
        reconciliation_id: id,
        final_batch: final,
        ...(final ? { total_records: total } : {}),
      });

    it("desactiva los clientes que el ERP ya no envía, solo en el último lote", async () => {
      const all = many(1500);
      await post(a.apiKey, batch(all.slice(0, 1000))).expect(200);
      await post(a.apiKey, batch(all.slice(1000))).expect(200);
      // Un cliente de otra organización con el mismo código no debe verse afectado.
      await post(b.apiKey, batch(all.slice(0, 10))).expect(200);

      const remaining = all.filter((_, i) => i < 100 || i >= 150); // fuera los índices 100..149
      const id = randomUUID();
      const r1 = await post(a.apiKey, recon(id, remaining.slice(0, 1000), false)).expect(200);
      expect(r1.body.deactivated).toBeNull();
      expect((await rows(a.orgId)).every((r) => r.is_active)).toBe(true);
      const r2 = await post(
        a.apiKey,
        recon(id, remaining.slice(1000), true, remaining.length),
      ).expect(200);
      expect(r2.body.deactivated).toBe(50);

      const inactive = (await rows(a.orgId))
        .filter((r) => !r.is_active)
        .map((r) => r.erp_customer_code);
      expect(inactive).toEqual(all.slice(100, 150).map((c) => c.customer_code));
      expect((await rows(b.orgId)).every((r) => r.is_active)).toBe(true);
    });

    it("si lo recibido no cuadra con total_records responde 409 y no cambia nada", async () => {
      await post(a.apiKey, batch(many(8))).expect(200);
      const logsBefore = (await successLogs(a.orgId)).length;
      const res = await post(a.apiKey, recon(randomUUID(), many(3), true, 5)).expect(409);
      expect(res.body).toMatchObject({ expected_total: 5, received_total: 3 });
      expect((await rows(a.orgId)).every((r) => r.is_active)).toBe(true);
      expect((await successLogs(a.orgId)).length).toBe(logsBefore);
    });

    it("los productos y los clientes tienen reconciliaciones independientes", async () => {
      await post(a.apiKey, batch(many(4))).expect(200);
      await request(app.getHttpServer())
        .post("/v1/sync/products")
        .set("x-api-key", a.apiKey)
        .send({
          batch_id: randomUUID(),
          sent_at: new Date().toISOString(),
          kind: "products",
          full_reconciliation: true,
          reconciliation_id: randomUUID(),
          final_batch: true,
          total_records: 0,
          records: [],
        })
        .expect(200);
      expect((await rows(a.orgId)).every((r) => r.is_active)).toBe(true);
    });
  });
});
