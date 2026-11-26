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
  createStaffUser,
  createTenant,
  newPool,
  signJwt,
  userToken,
  type TestTenant,
} from "./helpers";

describe("tasa de cambio manual (Postgres real)", () => {
  let app: INestApplication;
  let pool: Pool;
  let a: TestTenant;
  let b: TestTenant;
  let ownerA: string;
  let adminA: string;
  let staffA: string;
  let customerA: string;
  let adminB: string;
  const orgs: string[] = [];
  const users: string[] = [];

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
    ownerA = await createStaffUser(pool, a.orgId, "owner");
    adminA = await createStaffUser(pool, a.orgId, "admin");
    staffA = await createStaffUser(pool, a.orgId, "staff");
    customerA = (await createCustomerUser(pool, a.orgId)).userId;
    adminB = await createStaffUser(pool, b.orgId, "admin");
    users.push(ownerA, adminA, staffA, customerA, adminB);
  });

  afterAll(async () => {
    await cleanup(pool, orgs, users);
    await app.close();
    await pool.end();
  });

  const url = (orgId: string) => `/v1/orgs/${orgId}/exchange-rate`;
  const auth = (userId: string) => `Bearer ${userToken(userId)}`;
  const set = (orgId: string, userId: string | undefined, body: unknown) => {
    const req = request(app.getHttpServer()).post(url(orgId));
    return (userId ? req.set("Authorization", auth(userId)) : req).send(body as object);
  };
  const current = (orgId: string, userId?: string) => {
    const req = request(app.getHttpServer()).get(url(orgId));
    return userId ? req.set("Authorization", auth(userId)) : req;
  };
  const history = (orgId: string, userId: string, query = "") =>
    request(app.getHttpServer())
      .get(`${url(orgId)}/history${query}`)
      .set("Authorization", auth(userId));

  const orgRate = async (orgId: string) =>
    Number(
      (await pool.query("SELECT exchange_rate_bs FROM public.organizations WHERE id = $1", [orgId]))
        .rows[0].exchange_rate_bs,
    );
  const historyRows = async (orgId: string) =>
    (
      await pool.query(
        "SELECT * FROM public.exchange_rates WHERE org_id = $1 ORDER BY created_at",
        [orgId],
      )
    ).rows;

  describe("fijar la tasa (POST)", () => {
    it("un owner y un admin la fijan: actualiza la tasa vigente y deja historial a su nombre", async () => {
      const res = await set(a.orgId, adminA, { rate_bs: 36.5 }).expect(201);
      expect(res.body).toMatchObject({
        org_id: a.orgId,
        rate_bs: 36.5,
        source: "manual",
        set_by: adminA,
      });
      expect(res.body.id).toEqual(expect.any(String));
      expect(await orgRate(a.orgId)).toBe(36.5);

      await set(a.orgId, ownerA, { rate_bs: 40.1234 }).expect(201);
      expect(await orgRate(a.orgId)).toBe(40.1234);

      const rows = await historyRows(a.orgId);
      expect(rows.map((r) => [Number(r.rate_bs), r.source, r.set_by])).toEqual([
        [36.5, "manual", adminA],
        [40.1234, "manual", ownerA],
      ]);
    });

    it("redondea a 4 decimales y devuelve el valor guardado", async () => {
      const res = await set(a.orgId, adminA, { rate_bs: 36.123456 }).expect(201);
      expect(res.body.rate_bs).toBe(36.1235);
      expect(await orgRate(a.orgId)).toBe(36.1235);
    });

    it("el personal (staff) y los compradores (customer) no pueden fijarla: 403 y nada cambia", async () => {
      await set(a.orgId, staffA, { rate_bs: 99 }).expect(403);
      await set(a.orgId, customerA, { rate_bs: 99 }).expect(403);
      expect(await orgRate(a.orgId)).toBe(1);
      expect(await historyRows(a.orgId)).toHaveLength(0);
    });

    it("un admin de otra organización no la fija en la mía", async () => {
      await set(a.orgId, adminB, { rate_bs: 99 }).expect(403);
      expect(await orgRate(a.orgId)).toBe(1);
      expect(await historyRows(a.orgId)).toHaveLength(0);
      expect(await orgRate(b.orgId)).toBe(1);
    });

    it("un usuario autenticado sin ninguna organización tampoco", async () => {
      const lonely = randomUUID();
      await pool.query(
        "INSERT INTO auth.users (id, aud, role, email) VALUES ($1, 'authenticated', 'authenticated', $2)",
        [lonely, `${lonely}@test.local`],
      );
      users.push(lonely);
      await set(a.orgId, lonely, { rate_bs: 99 }).expect(403);
      await set(randomUUID(), lonely, { rate_bs: 99 }).expect(403);
    });

    it("exige JWT: sin token, vencido, anon, service_role y x-api-key dan 401", async () => {
      const exp = Math.floor(Date.now() / 1000);
      await set(a.orgId, undefined, { rate_bs: 99 }).expect(401);
      const old = signJwt({ sub: adminA, role: "authenticated", exp: exp - 10 });
      await request(app.getHttpServer())
        .post(url(a.orgId))
        .set("Authorization", `Bearer ${old}`)
        .send({ rate_bs: 99 })
        .expect(401);
      const anon = signJwt({ sub: adminA, role: "anon", exp: exp + 60 });
      await request(app.getHttpServer())
        .post(url(a.orgId))
        .set("Authorization", `Bearer ${anon}`)
        .send({ rate_bs: 99 })
        .expect(401);
      const svc = signJwt({ role: "service_role", exp: exp + 60 });
      await request(app.getHttpServer())
        .post(url(a.orgId))
        .set("Authorization", `Bearer ${svc}`)
        .send({ rate_bs: 99 })
        .expect(401);
      await request(app.getHttpServer())
        .post(url(a.orgId))
        .set("x-api-key", a.apiKey)
        .send({ rate_bs: 99 })
        .expect(401);
      expect(await historyRows(a.orgId)).toHaveLength(0);
    });

    it("rechaza cuerpos inválidos con 400, incluidos source, set_by y org_id", async () => {
      const bads: unknown[] = [
        {},
        { rate_bs: 0 },
        { rate_bs: -5 },
        { rate_bs: "36.5" },
        { rate_bs: null },
        { rate_bs: 1e9 },
        { rate_bs: 36, source: "bcv" },
        { rate_bs: 36, set_by: randomUUID() },
        { rate_bs: 36, org_id: b.orgId },
      ];
      for (const bad of bads) await set(a.orgId, adminA, bad).expect(400);
      expect(await historyRows(a.orgId)).toHaveLength(0);
      expect(await orgRate(a.orgId)).toBe(1);
    });

    it("rechaza un orgId que no es UUID con 400", async () => {
      await set("no-es-uuid" as string, adminA, { rate_bs: 36 }).expect(400);
    });
  });

  describe("consultar la tasa vigente (GET)", () => {
    it("antes de fijar ninguna devuelve la tasa por defecto (1) sin origen", async () => {
      const res = await current(a.orgId, adminA).expect(200);
      expect(res.body).toEqual({
        org_id: a.orgId,
        rate_bs: 1,
        source: null,
        set_by: null,
        set_at: null,
      });
    });

    it("después de fijarla devuelve la última, con quién y cuándo", async () => {
      await set(a.orgId, adminA, { rate_bs: 36 }).expect(201);
      await set(a.orgId, ownerA, { rate_bs: 37.25 }).expect(201);
      const res = await current(a.orgId, adminA).expect(200);
      expect(res.body).toMatchObject({
        org_id: a.orgId,
        rate_bs: 37.25,
        source: "manual",
        set_by: ownerA,
      });
      expect(Math.abs(Date.parse(res.body.set_at) - Date.now())).toBeLessThan(10_000);
    });

    it("la leen todos los miembros, incluidos staff y compradores (el catálogo muestra Bs)", async () => {
      await set(a.orgId, adminA, { rate_bs: 36 }).expect(201);
      for (const u of [ownerA, adminA, staffA, customerA]) {
        const res = await current(a.orgId, u).expect(200);
        expect(res.body.rate_bs).toBe(36);
      }
    });

    it("quien no es miembro recibe 404, igual que si la organización no existiera", async () => {
      await set(a.orgId, adminA, { rate_bs: 36 }).expect(201);
      const other = await current(a.orgId, adminB).expect(404);
      const missing = await current(randomUUID(), adminB).expect(404);
      expect(other.body.message).toBe(missing.body.message);
    });

    it("exige JWT", async () => {
      await current(a.orgId).expect(401);
    });

    it("cada organización tiene su propia tasa", async () => {
      await set(a.orgId, adminA, { rate_bs: 36 }).expect(201);
      await set(b.orgId, adminB, { rate_bs: 50 }).expect(201);
      expect((await current(a.orgId, adminA)).body.rate_bs).toBe(36);
      expect((await current(b.orgId, adminB)).body.rate_bs).toBe(50);
    });
  });

  describe("historial (GET /history)", () => {
    it("lista de la más reciente a la más antigua, con total y paginación", async () => {
      for (const rate of [30, 31, 32, 33, 34])
        await set(a.orgId, adminA, { rate_bs: rate }).expect(201);
      const all = await history(a.orgId, staffA).expect(200);
      expect(all.body).toMatchObject({ total: 5, limit: 50, offset: 0 });
      expect(all.body.items.map((i: { rate_bs: number }) => i.rate_bs)).toEqual([
        34, 33, 32, 31, 30,
      ]);
      expect(all.body.items[0]).toMatchObject({
        org_id: a.orgId,
        source: "manual",
        set_by: adminA,
      });

      const page = await history(a.orgId, staffA, "?limit=2&offset=1").expect(200);
      expect(page.body.items.map((i: { rate_bs: number }) => i.rate_bs)).toEqual([33, 32]);
      expect(page.body).toMatchObject({ total: 5, limit: 2, offset: 1 });
    });

    it("no mezcla organizaciones y un no miembro recibe 404", async () => {
      await set(a.orgId, adminA, { rate_bs: 36 }).expect(201);
      await set(b.orgId, adminB, { rate_bs: 50 }).expect(201);
      const res = await history(a.orgId, adminA).expect(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].rate_bs).toBe(36);
      await history(a.orgId, adminB).expect(404);
    });

    it("rechaza límites inválidos con 400 y exige JWT", async () => {
      for (const q of ["?limit=0", "?limit=201", "?offset=-1", "?limit=abc", "?otro=1"]) {
        await history(a.orgId, adminA, q).expect(400);
      }
      await request(app.getHttpServer())
        .get(`${url(a.orgId)}/history`)
        .expect(401);
    });
  });

  it("la clave del agente no sirve en la ruta de usuarios, ni el JWT en la del agente", async () => {
    await request(app.getHttpServer()).get(url(a.orgId)).set("x-api-key", a.apiKey).expect(401);
    await request(app.getHttpServer())
      .post("/v1/sync/products")
      .set("Authorization", auth(adminA))
      .send({})
      .expect(401);
  });
});
