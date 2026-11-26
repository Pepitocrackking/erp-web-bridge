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
  type TestCustomer,
  type TestTenant,
} from "./helpers";

type Item = { sku: string; quantity: number };

describe("pedidos (Postgres real)", () => {
  let app: INestApplication;
  let pool: Pool;
  let a: TestTenant;
  let b: TestTenant;
  let cust: TestCustomer; // cliente de A: límite 1000, deuda 100
  let adminA: string;
  let staffA: string;
  let adminB: string;
  let mayorListId: string;
  const orgs: string[] = [];
  const users: string[] = [];

  beforeAll(async () => {
    pool = newPool();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
  });

  const seedCatalog = async (orgId: string) => {
    const list = await pool.query<{ id: string }>(
      "INSERT INTO public.price_lists (org_id, code, name) VALUES ($1, 'MAYOR', 'Mayorista') RETURNING id",
      [orgId],
    );
    const products: Array<[string, number, boolean]> = [
      ["P1", 10, true],
      ["P2", 25.5, true],
      ["P3", 5, false], // inactivo
      ["D1", 0.1, true],
      ["D2", 0.2, true],
      ["LIST", 10, true], // con precio especial en la lista MAYOR
    ];
    for (const [sku, price, active] of products) {
      await pool.query(
        `INSERT INTO public.products (org_id, erp_sku, name, price_usd, stock, sync_hash, is_active)
         VALUES ($1, $2, $3, $4, 100, 'h', $5)`,
        [orgId, sku, `Producto ${sku}`, price, active],
      );
    }
    await pool.query(
      `INSERT INTO public.product_prices (org_id, product_id, price_list_id, price_usd)
       SELECT $1, id, $2, 8 FROM public.products WHERE org_id = $1 AND erp_sku = 'LIST'`,
      [orgId, list.rows[0]!.id],
    );
    return list.rows[0]!.id;
  };

  beforeEach(async () => {
    a = await createTenant(pool);
    b = await createTenant(pool);
    orgs.push(a.orgId, b.orgId);
    mayorListId = await seedCatalog(a.orgId);
    await seedCatalog(b.orgId);
    await pool.query("UPDATE public.organizations SET exchange_rate_bs = 36.5 WHERE id = $1", [
      a.orgId,
    ]);
    cust = await createCustomerUser(pool, a.orgId, { creditLimit: 1000, debt: 100 });
    adminA = await createStaffUser(pool, a.orgId, "admin");
    staffA = await createStaffUser(pool, a.orgId, "staff");
    adminB = await createStaffUser(pool, b.orgId, "admin");
    users.push(cust.userId, adminA, staffA, adminB);
  });

  afterAll(async () => {
    await cleanup(pool, orgs, users);
    await app.close();
    await pool.end();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (u: string) => `Bearer ${userToken(u)}`;

  const create = (orgId: string, userId: string | undefined, body: unknown) => {
    const req = http().post(`/v1/orgs/${orgId}/orders`);
    return (userId ? req.set("Authorization", bearer(userId)) : req).send(body as object);
  };
  /** Pedido del cliente de A. */
  const order = (items: Item[], c: TestCustomer = cust, orgId = a.orgId) =>
    create(orgId, c.userId, { items });
  const pending = (key?: string, q = "") => {
    const req = http().get(`/v1/orders/pending${q}`);
    return key ? req.set("x-api-key", key) : req;
  };
  const confirm = (key: string | undefined, orderId: string, body: unknown) => {
    const req = http().post(`/v1/orders/${orderId}/confirm`);
    return (key ? req.set("x-api-key", key) : req).send(body as object);
  };

  const dbOrders = async (orgId: string) =>
    (
      await pool.query(
        "SELECT * FROM public.web_orders WHERE org_id = $1 ORDER BY created_at, id",
        [orgId],
      )
    ).rows;
  const setStatus = (id: string, status: string) =>
    pool.query("UPDATE public.web_orders SET status = $2 WHERE id = $1", [id, status]);
  const setDebt = (customerId: string, debt: number, limit: number) =>
    pool.query(
      "UPDATE public.b2b_customers SET current_debt_usd = $2, credit_limit_usd = $3 WHERE id = $1",
      [customerId, debt, limit],
    );

  describe("crear un pedido", () => {
    it("el comprador crea su pedido: precios, total y tasa los pone el servidor", async () => {
      const res = await create(a.orgId, cust.userId, {
        items: [
          { sku: "P1", quantity: 3 },
          { sku: "P2", quantity: 2 },
        ],
        notes: "Entregar por la tarde",
      }).expect(201);

      expect(res.body).toMatchObject({
        customer_code: cust.customerCode,
        status: "pending_sync",
        total_usd: 81, // 3 × 10 + 2 × 25.50
        exchange_rate_used: 36.5,
        notes: "Entregar por la tarde",
        items: [
          { sku: "P1", quantity: 3, unit_price_usd: 10 },
          { sku: "P2", quantity: 2, unit_price_usd: 25.5 },
        ],
      });
      expect(res.body.id).toEqual(expect.any(String));
      expect(res.body.erp_order_reference ?? null).toBeNull();

      const [row] = await dbOrders(a.orgId);
      expect(row).toMatchObject({
        id: res.body.id,
        org_id: a.orgId,
        customer_id: cust.customerId,
        status: "pending_sync",
        erp_order_reference: null,
        notes: "Entregar por la tarde",
      });
      expect(Number(row.total_usd)).toBe(81);
      expect(Number(row.exchange_rate_used)).toBe(36.5);
      expect(row.items).toEqual([
        { sku: "P1", quantity: 3, unit_price_usd: 10 },
        { sku: "P2", quantity: 2, unit_price_usd: 25.5 },
      ]);
    });

    it("usa el precio de la lista del cliente si existe y el precio base si no", async () => {
      await pool.query("UPDATE public.b2b_customers SET price_list_id = $2 WHERE id = $1", [
        cust.customerId,
        mayorListId,
      ]);
      const res = await order([
        { sku: "LIST", quantity: 10 }, // 8 en la lista MAYOR (10 de base)
        { sku: "P1", quantity: 1 }, // sin precio en la lista: 10 de base
      ]).expect(201);
      expect(res.body.items).toEqual([
        { sku: "LIST", quantity: 10, unit_price_usd: 8 },
        { sku: "P1", quantity: 1, unit_price_usd: 10 },
      ]);
      expect(res.body.total_usd).toBe(90);
    });

    it("suma con exactitud decimal (sin errores de coma flotante)", async () => {
      const res = await order([
        { sku: "D1", quantity: 1 },
        { sku: "D2", quantity: 1 },
      ]).expect(201);
      expect(res.body.total_usd).toBe(0.3); // en coma flotante 0.1 + 0.2 = 0.30000000000000004
      expect((await dbOrders(a.orgId))[0]!.total_usd).toBe("0.30");
    });

    it("rechaza SKU inexistentes, inactivos o de otra organización con 422 y no crea nada", async () => {
      await pool.query(
        "INSERT INTO public.products (org_id, erp_sku, name, price_usd, stock, sync_hash) VALUES ($1, 'SOLO-B', 'x', 1, 1, 'h')",
        [b.orgId],
      );
      const res = await order([
        { sku: "P1", quantity: 1 },
        { sku: "NO-EXISTE", quantity: 1 },
        { sku: "P3", quantity: 1 },
        { sku: "SOLO-B", quantity: 1 },
      ]).expect(422);
      expect(res.body.skus.sort()).toEqual(["NO-EXISTE", "P3", "SOLO-B"]);
      expect(await dbOrders(a.orgId)).toHaveLength(0);
    });

    it("rechaza un SKU repetido en el carrito con 422", async () => {
      const res = await order([
        { sku: "P1", quantity: 1 },
        { sku: "P1", quantity: 2 },
      ]).expect(422);
      expect(res.body.skus).toEqual(["P1"]);
      expect(await dbOrders(a.orgId)).toHaveLength(0);
    });

    it("rechaza cuerpos inválidos con 400, incluidos precio, total, cliente, estado y org_id", async () => {
      const items = [{ sku: "P1", quantity: 1 }];
      const bads: unknown[] = [
        {},
        { items: [] },
        { items: [{ sku: "P1", quantity: 0 }] },
        { items: [{ sku: "P1", quantity: 1.5 }] },
        { items: [{ sku: "P1", quantity: "2" }] },
        { items: [{ sku: "P1", quantity: 1, unit_price_usd: 0.01 }] },
        { items, total_usd: 0.01 },
        { items, customer_id: randomUUID() },
        { items, customer_code: "OTRO" },
        { items, status: "approved" },
        { items, org_id: b.orgId },
        { items, exchange_rate_used: 9999 },
        { items: Array.from({ length: 201 }, (_, i) => ({ sku: `S${i}`, quantity: 1 })) },
      ];
      for (const bad of bads) await create(a.orgId, cust.userId, bad).expect(400);
      expect(await dbOrders(a.orgId)).toHaveLength(0);
    });
  });

  describe("quién puede crear pedidos", () => {
    it("el personal (admin, staff) no crea pedidos: 403", async () => {
      await create(a.orgId, adminA, { items: [{ sku: "P1", quantity: 1 }] }).expect(403);
      await create(a.orgId, staffA, { items: [{ sku: "P1", quantity: 1 }] }).expect(403);
      expect(await dbOrders(a.orgId)).toHaveLength(0);
    });

    it("quien no es miembro de la organización recibe 404, igual que si no existiera", async () => {
      const other = await create(a.orgId, adminB, { items: [{ sku: "P1", quantity: 1 }] }).expect(
        404,
      );
      const missing = await create(randomUUID(), adminB, {
        items: [{ sku: "P1", quantity: 1 }],
      }).expect(404);
      expect(other.body.message).toBe(missing.body.message);
      await order([{ sku: "P1", quantity: 1 }], cust, b.orgId).expect(404); // comprador de A en B
      expect(await dbOrders(a.orgId)).toHaveLength(0);
      expect(await dbOrders(b.orgId)).toHaveLength(0);
    });

    it("exige JWT: sin token, vencido, anon y x-api-key dan 401", async () => {
      const body = { items: [{ sku: "P1", quantity: 1 }] };
      await create(a.orgId, undefined, body).expect(401);
      const old = signJwt({
        sub: cust.userId,
        role: "authenticated",
        exp: Math.floor(Date.now() / 1000) - 5,
      });
      await http()
        .post(`/v1/orgs/${a.orgId}/orders`)
        .set("Authorization", `Bearer ${old}`)
        .send(body)
        .expect(401);
      const anon = signJwt({
        sub: cust.userId,
        role: "anon",
        exp: Math.floor(Date.now() / 1000) + 60,
      });
      await http()
        .post(`/v1/orgs/${a.orgId}/orders`)
        .set("Authorization", `Bearer ${anon}`)
        .send(body)
        .expect(401);
      await http()
        .post(`/v1/orgs/${a.orgId}/orders`)
        .set("x-api-key", a.apiKey)
        .send(body)
        .expect(401);
    });

    it("un orgId que no es UUID da 400", async () => {
      await create("no-es-uuid", cust.userId, { items: [{ sku: "P1", quantity: 1 }] }).expect(400);
    });

    it("un cliente inactivo en el ERP o una organización inactiva no pueden pedir: 403", async () => {
      await pool.query("UPDATE public.b2b_customers SET is_active = false WHERE id = $1", [
        cust.customerId,
      ]);
      await order([{ sku: "P1", quantity: 1 }]).expect(403);
      await pool.query("UPDATE public.b2b_customers SET is_active = true WHERE id = $1", [
        cust.customerId,
      ]);
      await pool.query("UPDATE public.organizations SET is_active = false WHERE id = $1", [
        a.orgId,
      ]);
      await order([{ sku: "P1", quantity: 1 }]).expect(403);
      expect(await dbOrders(a.orgId)).toHaveLength(0);
    });
  });

  describe("límite de crédito", () => {
    // Cliente: límite 1000, deuda 100 → disponible 900.
    it("acepta un pedido que llega exactamente al límite y rechaza un centavo más", async () => {
      await order([{ sku: "P1", quantity: 90 }]).expect(201); // 900 → 100 + 900 = 1000
      const res = await order([{ sku: "D1", quantity: 1 }]).expect(422); // +0.10
      expect(res.body).toMatchObject({
        code: "credit_limit_exceeded",
        credit_limit_usd: 1000,
        current_debt_usd: 100,
        pending_orders_usd: 900,
        order_total_usd: 0.1,
        available_usd: 0,
      });
      expect(await dbOrders(a.orgId)).toHaveLength(1);
    });

    it("un pedido que por sí solo supera el disponible se rechaza y no deja nada", async () => {
      const res = await order([{ sku: "P1", quantity: 91 }]).expect(422); // 910 > 900
      expect(res.body).toMatchObject({
        code: "credit_limit_exceeded",
        pending_orders_usd: 0,
        order_total_usd: 910,
        available_usd: 900,
      });
      expect(await dbOrders(a.orgId)).toHaveLength(0);
    });

    it("los pedidos aún no en deuda (pending_sync y synced_to_erp) consumen crédito", async () => {
      const first = await order([{ sku: "P1", quantity: 50 }]).expect(201); // 500
      await order([{ sku: "P1", quantity: 41 }]).expect(422); // 100 + 500 + 410 > 1000
      await setStatus(first.body.id, "synced_to_erp"); // el borrador ya está en el ERP, aún no es deuda
      const res = await order([{ sku: "P1", quantity: 41 }]).expect(422);
      expect(res.body.pending_orders_usd).toBe(500);
      await order([{ sku: "P1", quantity: 40 }]).expect(201); // 100 + 500 + 400 = 1000
    });

    it("los pedidos aprobados, rechazados, anulados o con error no consumen crédito", async () => {
      for (const status of ["approved", "rejected", "cancelled", "error"]) {
        const o = await order([{ sku: "P1", quantity: 10 }]).expect(201);
        await setStatus(o.body.id, status);
      }
      const res = await order([{ sku: "P1", quantity: 90 }]).expect(201); // todo el disponible: 900
      expect(res.body.total_usd).toBe(900);
    });

    it("la deuda del ERP cuenta, y un saldo a favor (deuda negativa) amplía el disponible", async () => {
      await setDebt(cust.customerId, 950, 1000);
      await order([{ sku: "P1", quantity: 6 }]).expect(422); // disponible 50
      await order([{ sku: "P1", quantity: 5 }]).expect(201);
      // Con 200 a favor y 50 pendientes quedan 1000 + 200 - 50 = 1150 disponibles.
      await setDebt(cust.customerId, -200, 1000);
      const res = await order([{ sku: "P1", quantity: 116 }]).expect(422); // 1160 > 1150
      expect(res.body).toMatchObject({
        current_debt_usd: -200,
        pending_orders_usd: 50,
        available_usd: 1150,
      });
      await order([{ sku: "P1", quantity: 115 }]).expect(201); // 1150 exactos
    });

    it("un cliente sin límite de crédito (0) no puede pedir", async () => {
      await setDebt(cust.customerId, 0, 0);
      const res = await order([{ sku: "D1", quantity: 1 }]).expect(422);
      expect(res.body).toMatchObject({ code: "credit_limit_exceeded", available_usd: 0 });
    });

    it("pedidos simultáneos del mismo cliente nunca superan el límite", async () => {
      await setDebt(cust.customerId, 0, 1000);
      // 8 pedidos de 300 a la vez: caben 3 (900), no 4 (1200).
      const results = await Promise.all(
        Array.from({ length: 8 }, () => order([{ sku: "P1", quantity: 30 }])),
      );
      const ok = results.filter((r) => r.status === 201);
      const rejected = results.filter((r) => r.status === 422);
      expect(ok).toHaveLength(3);
      expect(rejected).toHaveLength(5);
      expect(rejected.every((r) => r.body.code === "credit_limit_exceeded")).toBe(true);
      const rows = await dbOrders(a.orgId);
      expect(rows).toHaveLength(3);
      expect(rows.reduce((sum, r) => sum + Number(r.total_usd), 0)).toBe(900);
    });

    it("el crédito de un cliente no afecta a otro de la misma organización ni de otra", async () => {
      await order([{ sku: "P1", quantity: 90 }]).expect(201); // agota el crédito de cust
      const other = await createCustomerUser(pool, a.orgId, { creditLimit: 1000, debt: 0 });
      const otherB = await createCustomerUser(pool, b.orgId, { creditLimit: 1000, debt: 0 });
      users.push(other.userId, otherB.userId);
      await order([{ sku: "P1", quantity: 100 }], other).expect(201);
      await order([{ sku: "P1", quantity: 100 }], otherB, b.orgId).expect(201);
    });
  });

  describe("GET /v1/orders/pending (agente)", () => {
    it("lista solo los pedidos por enviar de SU organización, los más antiguos primero", async () => {
      const o1 = await order([{ sku: "P1", quantity: 1 }]).expect(201);
      const o2 = await order([{ sku: "P2", quantity: 1 }]).expect(201);
      const o3 = await order([{ sku: "D1", quantity: 1 }]).expect(201);
      await setStatus(o3.body.id, "synced_to_erp");
      const custB = await createCustomerUser(pool, b.orgId, { creditLimit: 500 });
      users.push(custB.userId);
      await order([{ sku: "P1", quantity: 1 }], custB, b.orgId).expect(201);

      const res = await pending(a.apiKey).expect(200);
      expect(res.body.orders.map((o: { id: string }) => o.id)).toEqual([o1.body.id, o2.body.id]);
      expect(res.body.orders[0]).toMatchObject({
        customer_code: cust.customerCode,
        status: "pending_sync",
        total_usd: 10,
        exchange_rate_used: 36.5,
        items: [{ sku: "P1", quantity: 1, unit_price_usd: 10 }],
      });
      const resB = await pending(b.apiKey).expect(200);
      expect(resB.body.orders).toHaveLength(1);
      expect(resB.body.orders[0].customer_code).toBe(custB.customerCode);
    });

    it("consultar no cambia nada: dos consultas devuelven lo mismo", async () => {
      await order([{ sku: "P1", quantity: 1 }]).expect(201);
      const r1 = await pending(a.apiKey).expect(200);
      const r2 = await pending(a.apiKey).expect(200);
      expect(r2.body).toEqual(r1.body);
      expect((await dbOrders(a.orgId))[0]!.status).toBe("pending_sync");
    });

    it("respeta limit y lo valida", async () => {
      for (let i = 0; i < 3; i++) await order([{ sku: "D1", quantity: 1 }]).expect(201);
      expect((await pending(a.apiKey, "?limit=2").expect(200)).body.orders).toHaveLength(2);
      for (const q of ["?limit=0", "?limit=501", "?limit=abc", "?otro=1"]) {
        await pending(a.apiKey, q).expect(400);
      }
    });

    it("exige la x-api-key del agente: un JWT de usuario no sirve", async () => {
      await pending().expect(401);
      await pending("falsa").expect(401);
      await http().get("/v1/orders/pending").set("Authorization", bearer(adminA)).expect(401);
    });
  });

  describe("POST /v1/orders/:id/confirm (agente)", () => {
    const placed = async (items: Item[] = [{ sku: "P1", quantity: 1 }]) =>
      (await order(items).expect(201)).body.id as string;
    const logs = async (orgId: string) =>
      (
        await pool.query(
          "SELECT * FROM public.sync_logs WHERE org_id = $1 AND entity = 'orders' ORDER BY created_at",
          [orgId],
        )
      ).rows;

    it("confirma: pasa a synced_to_erp con la referencia, deja sync_logs y sale de pendientes", async () => {
      const id = await placed();
      const res = await confirm(a.apiKey, id, { erp_order_reference: "PED-0001" }).expect(200);
      expect(res.body).toMatchObject({
        id,
        status: "synced_to_erp",
        erp_order_reference: "PED-0001",
        duplicate: false,
      });
      expect(Math.abs(Date.parse(res.body.synced_at) - Date.now())).toBeLessThan(10_000);

      const [row] = await dbOrders(a.orgId);
      expect(row).toMatchObject({ status: "synced_to_erp", erp_order_reference: "PED-0001" });
      expect(row.synced_at).not.toBeNull();
      expect((await pending(a.apiKey).expect(200)).body.orders).toHaveLength(0);
      const log = await logs(a.orgId);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        direction: "cloud_to_erp",
        entity: "orders",
        records_processed: 1,
        status: "success",
      });
    });

    it("confirmar dos veces el mismo pedido no lo duplica ni cambia nada", async () => {
      const id = await placed();
      const first = await confirm(a.apiKey, id, { erp_order_reference: "PED-0001" }).expect(200);
      const second = await confirm(a.apiKey, id, { erp_order_reference: "PED-0001" }).expect(200);
      expect(second.body).toEqual({ ...first.body, duplicate: true });
      const rows = await dbOrders(a.orgId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.synced_at.toISOString()).toBe(first.body.synced_at);
      expect(await logs(a.orgId)).toHaveLength(1);
    });

    it("confirmaciones simultáneas del mismo pedido: una sola lo cambia", async () => {
      // Varias rondas con muchas peticiones a la vez: una sola no basta para ver la carrera.
      for (let round = 0; round < 8; round++) {
        const id = await placed([{ sku: "D1", quantity: 1 }]);
        const reference = `PED-R${round}`;
        const results = await Promise.all(
          Array.from({ length: 20 }, () =>
            confirm(a.apiKey, id, { erp_order_reference: reference }),
          ),
        );
        expect(results.map((r) => r.status)).toEqual(Array(20).fill(200));
        expect(results.filter((r) => r.body.duplicate === false)).toHaveLength(1);
        expect(new Set(results.map((r) => r.body.synced_at)).size).toBe(1);
      }
      // Ocho pedidos confirmados: ocho filas en sync_logs, no una por petición.
      expect(await logs(a.orgId)).toHaveLength(8);
      expect(await dbOrders(a.orgId)).toHaveLength(8);
    });

    it("otra referencia sobre un pedido ya confirmado da 409 y no lo cambia", async () => {
      const id = await placed();
      await confirm(a.apiKey, id, { erp_order_reference: "PED-0001" }).expect(200);
      const res = await confirm(a.apiKey, id, { erp_order_reference: "PED-9999" }).expect(409);
      expect(res.body.erp_order_reference).toBe("PED-0001");
      expect((await dbOrders(a.orgId))[0]!.erp_order_reference).toBe("PED-0001");
    });

    it("un pedido anulado, rechazado o con error no se puede confirmar: 409", async () => {
      for (const status of ["cancelled", "rejected", "error"]) {
        const id = await placed();
        await setStatus(id, status);
        const res = await confirm(a.apiKey, id, { erp_order_reference: `R-${status}` }).expect(409);
        expect(res.body.status).toBe(status);
      }
      expect((await dbOrders(a.orgId)).every((o) => o.erp_order_reference === null)).toBe(true);
      expect(await logs(a.orgId)).toHaveLength(0);
    });

    it("una referencia del ERP no se puede usar en dos pedidos de la misma organización", async () => {
      const id1 = await placed();
      const id2 = await placed();
      await confirm(a.apiKey, id1, { erp_order_reference: "PED-0001" }).expect(200);
      await confirm(a.apiKey, id2, { erp_order_reference: "PED-0001" }).expect(409);
      expect((await dbOrders(a.orgId)).find((o) => o.id === id2)).toMatchObject({
        status: "pending_sync",
        erp_order_reference: null,
      });
    });

    it("la misma referencia en otra organización es otro pedido distinto", async () => {
      const id = await placed();
      const custB = await createCustomerUser(pool, b.orgId, { creditLimit: 500 });
      users.push(custB.userId);
      const idB = (await order([{ sku: "P1", quantity: 1 }], custB, b.orgId).expect(201)).body.id;
      await confirm(a.apiKey, id, { erp_order_reference: "PED-0001" }).expect(200);
      await confirm(b.apiKey, idB, { erp_order_reference: "PED-0001" }).expect(200);
    });

    it("la clave de A no confirma pedidos de B: 404 y B queda intacto", async () => {
      const custB = await createCustomerUser(pool, b.orgId, { creditLimit: 500 });
      users.push(custB.userId);
      const idB = (await order([{ sku: "P1", quantity: 1 }], custB, b.orgId).expect(201)).body.id;
      await confirm(a.apiKey, idB, { erp_order_reference: "PED-0001" }).expect(404);
      expect((await dbOrders(b.orgId))[0]).toMatchObject({
        status: "pending_sync",
        erp_order_reference: null,
      });
      expect(await logs(b.orgId)).toHaveLength(0);
    });

    it("un pedido inexistente da 404 y un id que no es UUID da 400", async () => {
      await confirm(a.apiKey, randomUUID(), { erp_order_reference: "X" }).expect(404);
      await confirm(a.apiKey, "no-es-uuid", { erp_order_reference: "X" }).expect(400);
    });

    it("rechaza cuerpos inválidos con 400, incluido cambiar el estado", async () => {
      const id = await placed();
      for (const bad of [
        {},
        { erp_order_reference: "" },
        { erp_order_reference: "x".repeat(65) },
        { erp_order_reference: "A", status: "approved" },
        { erp_order_reference: 7 },
      ]) {
        await confirm(a.apiKey, id, bad).expect(400);
      }
      expect((await dbOrders(a.orgId))[0]!.status).toBe("pending_sync");
    });

    it("exige la x-api-key: sin clave, falsa, organización inactiva o JWT de usuario dan 401", async () => {
      const id = await placed();
      const off = await createTenant(pool, { isActive: false });
      orgs.push(off.orgId);
      await confirm(undefined, id, { erp_order_reference: "X" }).expect(401);
      await confirm("falsa", id, { erp_order_reference: "X" }).expect(401);
      await confirm(off.apiKey, id, { erp_order_reference: "X" }).expect(401);
      await http()
        .post(`/v1/orders/${id}/confirm`)
        .set("Authorization", bearer(adminA))
        .send({ erp_order_reference: "X" })
        .expect(401);
      expect((await dbOrders(a.orgId))[0]!.status).toBe("pending_sync");
    });
  });

  describe("fallo permanente y reintento", () => {
    const placed = async () =>
      (await order([{ sku: "P1", quantity: 1 }]).expect(201)).body.id as string;
    const fail = (key: string | undefined, orderId: string, body: unknown) => {
      const req = http().post(`/v1/orders/${orderId}/fail`);
      return (key ? req.set("x-api-key", key) : req).send(body as object);
    };
    const retry = (orgId: string, userId: string | undefined, orderId: string) => {
      const req = http().post(`/v1/orgs/${orgId}/orders/${orderId}/retry`);
      return userId ? req.set("Authorization", bearer(userId)) : req;
    };
    const errorLogs = async (orgId: string) =>
      (
        await pool.query(
          "SELECT * FROM public.sync_logs WHERE org_id = $1 AND entity = 'orders' AND status = 'error'",
          [orgId],
        )
      ).rows;

    it("el agente marca el pedido con error y el motivo; sale de pendientes y queda en sync_logs", async () => {
      const id = await placed();
      const res = await fail(a.apiKey, id, {
        error_detail: "  El cliente C9 no existe en el ERP ",
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id,
        status: "error",
        error_detail: "El cliente C9 no existe en el ERP",
        duplicate: false,
      });
      expect(await dbOrders(a.orgId)).toMatchObject([
        { status: "error", error_detail: "El cliente C9 no existe en el ERP" },
      ]);
      expect((await pending(a.apiKey).expect(200)).body.orders).toHaveLength(0);
      const logs = await errorLogs(a.orgId);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ direction: "cloud_to_erp", records_processed: 0 });
      expect(logs[0].error_detail).toContain(id);
    });

    it("informar dos veces el mismo fallo no cambia nada y conserva el primer motivo", async () => {
      const id = await placed();
      await fail(a.apiKey, id, { error_detail: "primero" }).expect(200);
      const second = await fail(a.apiKey, id, { error_detail: "segundo" }).expect(200);
      expect(second.body).toEqual({
        id,
        status: "error",
        error_detail: "primero",
        duplicate: true,
      });
      expect((await dbOrders(a.orgId))[0]!.error_detail).toBe("primero");
      expect(await errorLogs(a.orgId)).toHaveLength(1);
    });

    it("un pedido ya confirmado, anulado o aprobado no se puede marcar con error: 409", async () => {
      for (const status of ["synced_to_erp", "approved", "rejected", "cancelled"]) {
        const id = await placed();
        await setStatus(id, status);
        const res = await fail(a.apiKey, id, { error_detail: "x" }).expect(409);
        expect(res.body.status).toBe(status);
      }
      expect((await dbOrders(a.orgId)).every((o) => o.error_detail === null)).toBe(true);
      expect(await errorLogs(a.orgId)).toHaveLength(0);
    });

    it("valida el cuerpo, el id y la clave; y no cruza organizaciones", async () => {
      const id = await placed();
      for (const bad of [
        {},
        { error_detail: " " },
        { error_detail: "x".repeat(1001) },
        { error_detail: "x", status: "approved" },
      ]) {
        await fail(a.apiKey, id, bad).expect(400);
      }
      await fail(a.apiKey, "no-es-uuid", { error_detail: "x" }).expect(400);
      await fail(a.apiKey, randomUUID(), { error_detail: "x" }).expect(404);
      await fail(undefined, id, { error_detail: "x" }).expect(401);
      await fail("falsa", id, { error_detail: "x" }).expect(401);
      await fail(b.apiKey, id, { error_detail: "x" }).expect(404); // la clave de B no ve pedidos de A
      expect((await dbOrders(a.orgId))[0]).toMatchObject({
        status: "pending_sync",
        error_detail: null,
      });
    });

    it("el personal reintenta un pedido en error: vuelve a pendiente, sin motivo, y el agente lo recoge", async () => {
      const id = await placed();
      for (const staff of [staffA, adminA]) {
        // Pendiente -> error (lo informa el agente) -> pendiente (lo reintenta el personal).
        await fail(a.apiKey, id, { error_detail: "cliente inexistente" }).expect(200);
        const res = await retry(a.orgId, staff, id).expect(200);
        expect(res.body).toEqual({ id, status: "pending_sync", changed: true });
        expect((await dbOrders(a.orgId))[0]).toMatchObject({
          status: "pending_sync",
          error_detail: null,
        });
        expect(
          (await pending(a.apiKey).expect(200)).body.orders.map((o: { id: string }) => o.id),
        ).toEqual([id]);
      }
    });

    it("reintentar uno ya pendiente es inocuo (changed=false) y otros estados dan 409", async () => {
      const id = await placed();
      const res = await retry(a.orgId, adminA, id).expect(200);
      expect(res.body).toEqual({ id, status: "pending_sync", changed: false });
      for (const status of ["synced_to_erp", "approved", "rejected", "cancelled"]) {
        await setStatus(id, status);
        const r = await retry(a.orgId, adminA, id).expect(409);
        expect(r.body.status).toBe(status);
      }
    });

    it("un comprador no reintenta pedidos (403), un extraño recibe 404 y sin JWT 401", async () => {
      const id = await placed();
      await fail(a.apiKey, id, { error_detail: "x" }).expect(200);
      await retry(a.orgId, cust.userId, id).expect(403);
      await retry(a.orgId, adminB, id).expect(404); // el admin de B no es miembro de A
      await retry(a.orgId, undefined, id).expect(401);
      await retry(a.orgId, adminA, randomUUID()).expect(404);
      expect((await dbOrders(a.orgId))[0]).toMatchObject({ status: "error", error_detail: "x" });
    });
  });
});
