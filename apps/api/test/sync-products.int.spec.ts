import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { Pool } from "pg";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";
import { cleanup, createTenant, newPool, type TestTenant } from "./helpers";

interface Rec {
  sku: string;
  name: string;
  category: string | null;
  price_usd: number;
  stock: number;
  active: boolean;
  sync_hash: string;
}

const product = (sku: string, over: Partial<Rec> = {}): Rec => ({
  sku,
  name: `Producto ${sku}`,
  category: "General",
  price_usd: 10.5,
  stock: 7,
  active: true,
  sync_hash: `h-${sku}`,
  ...over,
});

const many = (n: number, prefix = "P", over: Partial<Rec> = {}): Rec[] =>
  Array.from({ length: n }, (_, i) => product(`${prefix}${String(i).padStart(5, "0")}`, over));

const batch = (records: Rec[], extra: Record<string, unknown> = {}) => ({
  batch_id: randomUUID(),
  sent_at: new Date().toISOString(),
  kind: "products",
  full_reconciliation: false,
  records,
  ...extra,
});

describe("POST /v1/sync/products (Postgres real)", () => {
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

  // Cada prueba usa tenants nuevos: no dependen del seed ni entre sí.
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
    const req = request(app.getHttpServer()).post("/v1/sync/products");
    return key === undefined
      ? req.send(body as object)
      : req.set("x-api-key", key).send(body as object);
  };

  const rows = async (orgId: string) =>
    (
      await pool.query(
        `SELECT erp_sku, name, category, price_usd::float AS price_usd, stock::float AS stock,
                sync_hash, is_active, updated_at
           FROM public.products WHERE org_id = $1 ORDER BY erp_sku`,
        [orgId],
      )
    ).rows;

  const successLogs = async (orgId: string) =>
    (
      await pool.query(
        "SELECT * FROM public.sync_logs WHERE org_id = $1 AND status = 'success' ORDER BY created_at",
        [orgId],
      )
    ).rows;

  describe("ingesta y upsert", () => {
    it("inserta los productos, anota sync_logs y actualiza last_sync_at", async () => {
      const body = batch([product("A1"), product("A2", { category: null, active: false })]);
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
      expect(stored.map((r) => [r.erp_sku, r.category, r.is_active])).toEqual([
        ["A1", "General", true],
        ["A2", null, false],
      ]);
      expect(stored[0]).toMatchObject({
        name: "Producto A1",
        price_usd: 10.5,
        stock: 7,
        sync_hash: "h-A1",
      });

      const log = await successLogs(a.orgId);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        direction: "erp_to_cloud",
        entity: "products",
        batch_id: body.batch_id,
        records_processed: 2,
        status: "success",
      });
      const org = await pool.query("SELECT last_sync_at FROM public.organizations WHERE id = $1", [
        a.orgId,
      ]);
      expect(org.rows[0].last_sync_at).not.toBeNull();
    });

    it("el upsert es por (org_id, sku): cambia precio y stock sin duplicar filas", async () => {
      await post(a.apiKey, batch([product("A1"), product("A2")])).expect(200);
      const res = await post(
        a.apiKey,
        batch([product("A1", { price_usd: 99.99, stock: 3, sync_hash: "nuevo" }), product("A3")]),
      ).expect(200);
      expect(res.body).toMatchObject({ received: 2, inserted: 1, updated: 1, unchanged: 0 });
      const stored = await rows(a.orgId);
      expect(stored.map((r) => r.erp_sku)).toEqual(["A1", "A2", "A3"]);
      expect(stored[0]).toMatchObject({ price_usd: 99.99, stock: 3, sync_hash: "nuevo" });
    });

    it("no toca las filas sin cambios (ni su updated_at)", async () => {
      await post(a.apiKey, batch(many(50))).expect(200);
      const before = await rows(a.orgId);
      const res = await post(a.apiKey, batch(many(50))).expect(200);
      expect(res.body).toMatchObject({ received: 50, inserted: 0, updated: 0, unchanged: 50 });
      const after = await rows(a.orgId);
      expect(after.map((r) => r.updated_at)).toEqual(before.map((r) => r.updated_at));
    });

    it("distingue los cambios solo de categoría o de estado aunque el hash sea igual", async () => {
      await post(a.apiKey, batch([product("A1"), product("A2")])).expect(200);
      const res = await post(
        a.apiKey,
        batch([product("A1", { category: "Otra" }), product("A2", { active: false })]),
      ).expect(200);
      expect(res.body).toMatchObject({ updated: 2, unchanged: 0 });
      const stored = await rows(a.orgId);
      expect(stored.map((r) => [r.category, r.is_active])).toEqual([
        ["Otra", true],
        ["General", false],
      ]);
    });

    it("guarda tal cual nombres con comas, comillas, llaves y acentos", async () => {
      const name = `Aceite "Premium", 1L {oferta} ñandú \\ \\\\ 'x'`;
      await post(a.apiKey, batch([product("A1", { name, category: "NULL" })])).expect(200);
      const [row] = await rows(a.orgId);
      expect(row.name).toBe(name);
      expect(row.category).toBe("NULL");
    });

    it("acepta un lote vacío", async () => {
      const res = await post(a.apiKey, batch([])).expect(200);
      expect(res.body).toMatchObject({ received: 0, inserted: 0, updated: 0, unchanged: 0 });
    });

    it("acepta un lote de 1000 productos (más de 100 KB de cuerpo)", async () => {
      const body = batch(many(1000, "G", { name: "x".repeat(120) }));
      expect(JSON.stringify(body).length).toBeGreaterThan(100 * 1024);
      const res = await post(a.apiKey, body).expect(200);
      expect(res.body.inserted).toBe(1000);
    });
  });

  describe("idempotencia por batch_id", () => {
    it("reenviar el mismo lote devuelve duplicate y no repite el trabajo ni la bitácora", async () => {
      const body = batch([product("A1")]);
      await post(a.apiKey, body).expect(200);
      // Entre medio el ERP cambió el producto: un reenvío viejo no debe pisarlo.
      await post(a.apiKey, batch([product("A1", { price_usd: 50, sync_hash: "n" })])).expect(200);
      const res = await post(a.apiKey, body).expect(200);
      expect(res.body).toMatchObject({
        batch_id: body.batch_id,
        duplicate: true,
        received: 1,
        inserted: null,
      });
      expect((await rows(a.orgId))[0]).toMatchObject({ price_usd: 50 });
      expect(await successLogs(a.orgId)).toHaveLength(2);
    });

    it("dos envíos simultáneos del mismo lote se procesan una sola vez", async () => {
      const body = batch(many(200));
      const [r1, r2] = await Promise.all([post(a.apiKey, body), post(a.apiKey, body)]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      expect([r1.body.duplicate, r2.body.duplicate].sort()).toEqual([false, true]);
      expect(await successLogs(a.orgId)).toHaveLength(1);
      expect(await rows(a.orgId)).toHaveLength(200);
    });

    it("el mismo batch_id en otra organización es un lote distinto", async () => {
      const body = batch([product("A1")]);
      await post(a.apiKey, body).expect(200);
      const res = await post(b.apiKey, body).expect(200);
      expect(res.body.duplicate).toBe(false);
      expect(await rows(b.orgId)).toHaveLength(1);
    });
  });

  describe("aislamiento entre organizaciones", () => {
    it("una API key de A no escribe en B: ni con los mismos SKU ni con un org_id en el cuerpo", async () => {
      await post(
        b.apiKey,
        batch([product("S1", { price_usd: 1 }), product("S2", { price_usd: 2 })]),
      ).expect(200);
      const bBefore = await rows(b.orgId);

      // A manda los mismos SKU con otros datos.
      await post(a.apiKey, batch([product("S1", { price_usd: 999, name: "de A" })])).expect(200);
      // A intenta colar el org_id de B por todos los medios posibles.
      await post(a.apiKey, {
        ...batch([product("S1", { price_usd: 777 })]),
        org_id: b.orgId,
      }).expect(400);
      await request(app.getHttpServer())
        .post(`/v1/sync/products?org_id=${b.orgId}`)
        .set("x-api-key", a.apiKey)
        .set("x-org-id", b.orgId)
        .send(batch([product("S1", { price_usd: 555 })]))
        .expect(200);

      expect(await rows(b.orgId)).toEqual(bBefore);
      const aRows = await rows(a.orgId);
      expect(aRows).toHaveLength(1);
      expect(aRows[0]).toMatchObject({ erp_sku: "S1", price_usd: 555 });
      expect(await successLogs(b.orgId)).toHaveLength(1);
    });

    it("una reconciliación completa de A no desactiva productos de B", async () => {
      await post(b.apiKey, batch(many(10, "B"))).expect(200);
      const recon = randomUUID();
      await post(
        a.apiKey,
        batch([product("A1")], {
          full_reconciliation: true,
          reconciliation_id: recon,
          final_batch: true,
          total_records: 1,
        }),
      ).expect(200);
      expect((await rows(b.orgId)).every((r) => r.is_active)).toBe(true);
    });
  });

  describe("autenticación", () => {
    it("rechaza sin clave, con clave falsa y con una organización inactiva", async () => {
      const off = await createTenant(pool, { isActive: false });
      orgs.push(off.orgId);
      await post(undefined, batch([product("A1")])).expect(401);
      await post("clave-falsa", batch([product("A1")])).expect(401);
      await post(off.apiKey, batch([product("A1")])).expect(401);
      expect(await rows(off.orgId)).toHaveLength(0);
    });
  });

  describe("validación estricta", () => {
    it("rechaza cuerpos inválidos con 400 y detalle, sin escribir nada", async () => {
      const bad = batch([product("A1"), { ...product("A2"), price_usd: -5 }, { sku: "A3" } as Rec]);
      const res = await post(a.apiKey, bad).expect(400);
      expect(res.body.issues.length).toBeGreaterThan(0);
      expect(res.body.issues[0]).toHaveProperty("path");
      expect(await rows(a.orgId)).toHaveLength(0);
      expect(await successLogs(a.orgId)).toHaveLength(0);
    });

    it("rechaza campos extra, tipo de lote equivocado y lotes de más de 1000", async () => {
      await post(a.apiKey, { ...batch([product("A1")]), extra: 1 }).expect(400);
      await post(a.apiKey, batch([{ ...product("A1"), extra: 1 } as Rec])).expect(400);
      await post(a.apiKey, { ...batch([]), kind: "customers" }).expect(400);
      await post(a.apiKey, batch(many(1001))).expect(400);
      await post(a.apiKey, "no es json").expect(400);
      await post(a.apiKey, undefined).expect(400);
    });

    it("rechaza SKU repetidos dentro del lote con 422", async () => {
      const res = await post(a.apiKey, batch([product("A1"), product("A2"), product("A1")])).expect(
        422,
      );
      expect(res.body.skus).toEqual(["A1"]);
      expect(await rows(a.orgId)).toHaveLength(0);
    });

    it("los datos fuera de rango o con NUL son 422, no 500, y no dejan rastro", async () => {
      await post(a.apiKey, batch([product("A1"), product("A2", { price_usd: 1e12 })])).expect(422);
      await post(a.apiKey, batch([product("A1", { name: "mal\u0000nombre" })])).expect(422);
      expect(await rows(a.orgId)).toHaveLength(0);
      expect(await successLogs(a.orgId)).toHaveLength(0);
    });

    it("un lote con un registro inválido no guarda ni los válidos", async () => {
      // El SKU de solo espacios queda vacío tras el trim y Zod rechaza el lote completo.
      await post(a.apiKey, batch([product("A1"), product("   ")])).expect(400);
      expect(await rows(a.orgId)).toHaveLength(0);
    });
  });

  describe("reconciliación completa en varios lotes", () => {
    const recon = (id: string, records: Rec[], final: boolean, total?: number) =>
      batch(records, {
        full_reconciliation: true,
        reconciliation_id: id,
        final_batch: final,
        ...(final ? { total_records: total } : {}),
      });

    it("desactiva solo lo que no viene en el inventario completo (3 lotes)", async () => {
      const all = many(2500);
      await post(a.apiKey, batch(all.slice(0, 1000))).expect(200);
      await post(a.apiKey, batch(all.slice(1000, 2000))).expect(200);
      await post(a.apiKey, batch(all.slice(2000))).expect(200);
      expect((await rows(a.orgId)).filter((r) => r.is_active)).toHaveLength(2500);

      // El ERP ya no tiene los 100 productos del índice 1200 al 1299.
      const remaining = [...all.slice(0, 1200), ...all.slice(1300)];
      const id = randomUUID();
      const r1 = await post(a.apiKey, recon(id, remaining.slice(0, 1000), false)).expect(200);
      const r2 = await post(a.apiKey, recon(id, remaining.slice(1000, 2000), false)).expect(200);
      expect(r1.body.deactivated).toBeNull();
      expect(r2.body.deactivated).toBeNull();
      // Hasta el último lote no se desactiva nada.
      expect((await rows(a.orgId)).filter((r) => r.is_active)).toHaveLength(2500);

      const r3 = await post(
        a.apiKey,
        recon(id, remaining.slice(2000), true, remaining.length),
      ).expect(200);
      expect(r3.body).toMatchObject({ deactivated: 100, inserted: 0, updated: 0 });

      const stored = await rows(a.orgId);
      const inactive = stored.filter((r) => !r.is_active).map((r) => r.erp_sku);
      expect(inactive).toEqual(all.slice(1200, 1300).map((r) => r.sku));
      expect(stored).toHaveLength(2500); // se desactivan, no se borran
    });

    it("un producto desactivado que reaparece en el ERP vuelve a activarse", async () => {
      await post(a.apiKey, batch(many(3))).expect(200);
      const id1 = randomUUID();
      await post(a.apiKey, recon(id1, many(3).slice(0, 2), true, 2)).expect(200);
      expect((await rows(a.orgId)).map((r) => r.is_active)).toEqual([true, true, false]);

      const res = await post(a.apiKey, batch([many(3)[2]!])).expect(200);
      expect(res.body.updated).toBe(1);
      expect((await rows(a.orgId)).map((r) => r.is_active)).toEqual([true, true, true]);
    });

    it("si lo recibido no cuadra con total_records responde 409 y no desactiva ni guarda nada", async () => {
      await post(a.apiKey, batch(many(10))).expect(200);
      const logsBefore = (await successLogs(a.orgId)).length;
      const id = randomUUID();
      // Se "perdió" el primer lote: llegan 4 de los 6 anunciados.
      const res = await post(a.apiKey, recon(id, many(4, "Z"), true, 6)).expect(409);
      expect(res.body).toMatchObject({ expected_total: 6, received_total: 4 });
      const stored = await rows(a.orgId);
      expect(stored).toHaveLength(10); // los Z tampoco quedaron: el lote final se revirtió
      expect(stored.every((r) => r.is_active)).toBe(true);
      expect((await successLogs(a.orgId)).length).toBe(logsBefore);
    });

    it("un reintento del último lote tras un 409 puede completarse", async () => {
      await post(a.apiKey, batch(many(5))).expect(200);
      const id = randomUUID();
      const finalBody = recon(id, many(5).slice(3), true, 5);
      await post(a.apiKey, finalBody).expect(409); // faltaba el primer lote
      await post(a.apiKey, recon(id, many(5).slice(0, 3), false)).expect(200);
      const res = await post(a.apiKey, finalBody).expect(200); // mismo batch_id: el 409 no lo consumió
      expect(res.body.deactivated).toBe(0);
    });

    it("una reconciliación vacía con total_records=0 desactiva todo el catálogo", async () => {
      await post(a.apiKey, batch(many(4))).expect(200);
      const res = await post(a.apiKey, recon(randomUUID(), [], true, 0)).expect(200);
      expect(res.body.deactivated).toBe(4);
    });
  });

  describe("rendimiento", () => {
    it("ingesta 5.000 productos en 5 lotes de 1000 y vuelve a ingestarlos sin cambios", async () => {
      const all = many(5000, "M", { name: "Producto de prueba de rendimiento" });
      const chunk = (i: number) => all.slice(i * 1000, (i + 1) * 1000);

      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 5; i++) await post(a.apiKey, batch(chunk(i))).expect(200);
      const firstMs = Number(process.hrtime.bigint() - t0) / 1e6;
      expect(await rows(a.orgId)).toHaveLength(5000);

      const t1 = process.hrtime.bigint();
      for (let i = 0; i < 5; i++) {
        const res = await post(a.apiKey, batch(chunk(i))).expect(200);
        expect(res.body.unchanged).toBe(1000);
      }
      const secondMs = Number(process.hrtime.bigint() - t1) / 1e6;

      // La evidencia del Gate 4 recoge estas cifras.
      console.info(
        `INGESTA 5000 productos (5 lotes de 1000): alta ${firstMs.toFixed(0)} ms, ` +
          `reenvío sin cambios ${secondMs.toFixed(0)} ms`,
      );
      expect(firstMs).toBeLessThan(30_000);
      expect(secondMs).toBeLessThan(30_000);
    }, 120_000);
  });
});
