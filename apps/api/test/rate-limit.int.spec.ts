import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { Pool } from "pg";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";
import {
  cleanup,
  createCustomerUser,
  createTenant,
  newPool,
  userToken,
  type TestTenant,
} from "./helpers";

// Límites pequeños y una ventana corta, fijados ANTES de crear la aplicación (la configuración se lee ahí).
const LIMITS = {
  RATE_LIMIT_WINDOW_SECONDS: "3",
  RATE_LIMIT_DEFAULT: "5",
  RATE_LIMIT_SYNC: "3",
  RATE_LIMIT_STRICT: "2",
};

describe("rate limiting (Postgres real)", () => {
  let app: INestApplication;
  let pool: Pool;
  let a: TestTenant;
  let userId: string;
  const saved: Record<string, string | undefined> = {};
  const orgs: string[] = [];
  const users: string[] = [];

  beforeAll(async () => {
    for (const [k, v] of Object.entries(LIMITS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    pool = newPool();
    a = await createTenant(pool);
    orgs.push(a.orgId);
    userId = (await createCustomerUser(pool, a.orgId, { creditLimit: 100 })).userId;
    users.push(userId);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await cleanup(pool, orgs, users);
    await app.close();
    await pool.end();
  });

  const http = () => request(app.getHttpServer());
  const emptyBatch = (kind: "products" | "customers") => ({
    batch_id: randomUUID(),
    sent_at: new Date().toISOString(),
    kind,
    full_reconciliation: false,
    records: [],
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("pasado el límite responde 429 con Retry-After y un mensaje claro", async () => {
    // GET /v1/orders/pending sin clave: devuelve 401, pero cada intento cuenta (frena la fuerza bruta).
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await http().get("/v1/orders/pending")).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401]);

    const res = await http().get("/v1/orders/pending").expect(429);
    expect(res.body).toMatchObject({ statusCode: 429 });
    expect(res.body.message).toMatch(/demasiadas solicitudes/i);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(3);
  });

  it("el límite se restablece al terminar la ventana", async () => {
    await sleep(3200);
    await http().get("/v1/orders/pending").expect(401);
  });

  it("la ingesta tiene su propio límite, por ruta", async () => {
    await sleep(3200);
    for (let i = 0; i < 3; i++) {
      await http()
        .post("/v1/sync/products")
        .set("x-api-key", a.apiKey)
        .send(emptyBatch("products"))
        .expect(200);
    }
    await http()
      .post("/v1/sync/products")
      .set("x-api-key", a.apiKey)
      .send(emptyBatch("products"))
      .expect(429);
    // Otra ruta de ingesta tiene su propio contador.
    await http()
      .post("/v1/sync/customers")
      .set("x-api-key", a.apiKey)
      .send(emptyBatch("customers"))
      .expect(200);
  });

  it("un 429 no ejecuta nada: el lote rechazado no deja bitácora", async () => {
    await sleep(3200);
    for (let i = 0; i < 3; i++) {
      await http()
        .post("/v1/sync/products")
        .set("x-api-key", a.apiKey)
        .send(emptyBatch("products"))
        .expect(200);
    }
    const before = (
      await pool.query("SELECT count(*)::int AS n FROM public.sync_logs WHERE org_id = $1", [
        a.orgId,
      ])
    ).rows[0].n;
    await http()
      .post("/v1/sync/products")
      .set("x-api-key", a.apiKey)
      .send(emptyBatch("products"))
      .expect(429);
    const after = (
      await pool.query("SELECT count(*)::int AS n FROM public.sync_logs WHERE org_id = $1", [
        a.orgId,
      ])
    ).rows[0].n;
    expect(after).toBe(before);
  });

  it("las escrituras de usuarios con dinero (pedidos, tasa) tienen el límite más estricto", async () => {
    await sleep(3200);
    const auth = `Bearer ${userToken(userId)}`;
    const body = { items: [{ sku: "NO-EXISTE", quantity: 1 }] };
    const first = await http()
      .post(`/v1/orgs/${a.orgId}/orders`)
      .set("Authorization", auth)
      .send(body);
    const second = await http()
      .post(`/v1/orgs/${a.orgId}/orders`)
      .set("Authorization", auth)
      .send(body);
    expect([first.status, second.status]).not.toContain(429);
    await http()
      .post(`/v1/orgs/${a.orgId}/orders`)
      .set("Authorization", auth)
      .send(body)
      .expect(429);
  });

  it("no se puede evitar el límite inventando X-Forwarded-For", async () => {
    await sleep(3200);
    const results: number[] = [];
    for (let i = 0; i < 7; i++) {
      results.push(
        (
          await http()
            .get("/v1/orders/pending")
            .set("X-Forwarded-For", `10.0.0.${i + 1}`)
        ).status,
      );
    }
    expect(results.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(results.slice(5)).toEqual([429, 429]);
  });

  it("/health nunca se limita (lo usan los balanceadores y las sondas)", async () => {
    for (let i = 0; i < 25; i++) await http().get("/health").expect(200);
  });
});
