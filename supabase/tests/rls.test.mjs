// Pruebas de RLS contra la base local de Supabase (`pnpm db:start`, luego `pnpm test:db`).
//
// Cada prueba corre en una transacción que se revierte, con dos tenants (A y B) y usuarios de
// cada rol. Las consultas se ejecutan con el rol Postgres `authenticated` (o `anon`) y los
// claims JWT en `request.jwt.claims`, que es exactamente lo que hace PostgREST. Nunca con
// service_role, que se salta RLS.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import pg from "pg";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
after(() => pool.end());

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ORG_A = id(1);
const ORG_B = id(2);

const U_OWNER_A = id(11);
const U_ADMIN_A = id(12);
const U_STAFF_A = id(13);
const U_CUST_A1 = id(14);
const U_OWNER_B = id(21);
const U_CUST_B = id(22);
const U_NOBODY = id(99); // autenticado, sin membresía en ninguna organización

const C_A1 = id(101); // atado a U_CUST_A1, lista PL_A2
const C_A2 = id(102); // otro cliente de A, sin usuario
const C_B1 = id(103); // atado a U_CUST_B

const PL_A1 = id(201); // lista por defecto de A
const PL_A2 = id(202);
const PL_B = id(203);

const P_A_ACTIVE = id(301);
const P_A_INACTIVE = id(302);
const P_B = id(303);

const O_A1 = id(401); // cliente A1, pending_sync
const O_A2 = id(402); // cliente A2, pending_sync
const O_A1_SYNCED = id(403); // cliente A1, synced_to_erp
const O_B = id(404);

const ITEMS = JSON.stringify([{ sku: "X", quantity: 1, unit_price_usd: 1 }]);

async function seed(c) {
  await c.query(
    `INSERT INTO public.organizations (id, name, slug, erp_type, api_key_hash) VALUES
       ($1, 'Org A', 'org-a', 'mock', 'hash-a'),
       ($2, 'Org B', 'org-b', 'mock', 'hash-b')`,
    [ORG_A, ORG_B],
  );
  const users = [U_OWNER_A, U_ADMIN_A, U_STAFF_A, U_CUST_A1, U_OWNER_B, U_CUST_B, U_NOBODY];
  for (const u of users) {
    await c.query(
      `INSERT INTO auth.users (id, aud, role, email)
       VALUES ($1, 'authenticated', 'authenticated', $2)`,
      [u, `${u}@test.local`],
    );
  }
  await c.query(
    `INSERT INTO public.price_lists (id, org_id, code, name, is_default) VALUES
       ($1, $4, 'L1', 'Lista 1', true), ($2, $4, 'L2', 'Lista 2', false),
       ($3, $5, 'L1', 'Lista 1', true)`,
    [PL_A1, PL_A2, PL_B, ORG_A, ORG_B],
  );
  await c.query(
    `INSERT INTO public.products (id, org_id, erp_sku, name, price_usd, stock, sync_hash, is_active) VALUES
       ($1, $4, 'SKU-1', 'Activo A', 10, 5, 'h', true),
       ($2, $4, 'SKU-2', 'Inactivo A', 20, 5, 'h', false),
       ($3, $5, 'SKU-1', 'Activo B', 30, 5, 'h', true)`,
    [P_A_ACTIVE, P_A_INACTIVE, P_B, ORG_A, ORG_B],
  );
  await c.query(
    `INSERT INTO public.product_prices (org_id, product_id, price_list_id, price_usd) VALUES
       ($1, $3, $4, 9), ($1, $3, $5, 8), ($2, $6, $7, 7)`,
    [ORG_A, ORG_B, P_A_ACTIVE, PL_A1, PL_A2, P_B, PL_B],
  );
  await c.query(
    `INSERT INTO public.b2b_customers (id, org_id, erp_customer_code, tax_id, business_name, credit_limit_usd, price_list_id) VALUES
       ($1, $4, 'C1', 'J-1', 'Cliente A1', 1000, $5),
       ($2, $4, 'C2', 'J-2', 'Cliente A2', 500, NULL),
       ($3, $6, 'C1', 'J-3', 'Cliente B1', 800, NULL)`,
    [C_A1, C_A2, C_B1, ORG_A, PL_A2, ORG_B],
  );
  await c.query(
    `INSERT INTO public.org_members (org_id, user_id, role, customer_id) VALUES
       ($1, $3, 'owner', NULL), ($1, $4, 'admin', NULL), ($1, $5, 'staff', NULL),
       ($1, $6, 'customer', $7),
       ($2, $8, 'owner', NULL), ($2, $9, 'customer', $10)`,
    [ORG_A, ORG_B, U_OWNER_A, U_ADMIN_A, U_STAFF_A, U_CUST_A1, C_A1, U_OWNER_B, U_CUST_B, C_B1],
  );
  await c.query(
    `INSERT INTO public.web_orders (id, org_id, customer_id, status, total_usd, exchange_rate_used, items) VALUES
       ($1, $5, $6, 'pending_sync', 10, 40, $9),
       ($2, $5, $7, 'pending_sync', 20, 40, $9),
       ($3, $5, $6, 'synced_to_erp', 30, 40, $9),
       ($4, $8, $10, 'pending_sync', 40, 40, $9)`,
    [O_A1, O_A2, O_A1_SYNCED, O_B, ORG_A, C_A1, C_A2, ORG_B, ITEMS, C_B1],
  );
  await c.query(
    `INSERT INTO public.exchange_rates (org_id, rate_bs) VALUES ($1, 40), ($2, 41)`,
    [ORG_A, ORG_B],
  );
  await c.query(
    `INSERT INTO public.sync_logs (org_id, direction, entity, status) VALUES
       ($1, 'erp_to_cloud', 'products', 'success'), ($2, 'erp_to_cloud', 'products', 'success')`,
    [ORG_A, ORG_B],
  );
}

/** Ejecuta `fn` con los fixtures cargados, dentro de una transacción que siempre se revierte. */
async function withTenants(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await seed(c);
    await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

/** Cambia la sesión al usuario (rol `authenticated`) o a `anon` si no se pasa usuario. */
async function as(c, userId) {
  await c.query("RESET ROLE");
  if (userId) {
    const claims = JSON.stringify({ sub: userId, role: "authenticated" });
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims]);
    await c.query("SET LOCAL ROLE authenticated");
  } else {
    await c.query("SELECT set_config('request.jwt.claims', '', true)");
    await c.query("SET LOCAL ROLE anon");
  }
}

/** Ejecuta una sentencia sin romper la transacción si falla. */
async function attempt(c, sql, params = []) {
  await c.query("SAVEPOINT attempt");
  try {
    const r = await c.query(sql, params);
    await c.query("RELEASE SAVEPOINT attempt");
    return { rows: r.rows, rowCount: r.rowCount };
  } catch (error) {
    await c.query("ROLLBACK TO SAVEPOINT attempt");
    return { error };
  }
}

/** Escritura bloqueada: o el motor la rechaza (42501 / FK) o RLS la deja en 0 filas. */
function assertBlocked(r, label) {
  if (r.error) {
    assert.ok(
      ["42501", "23503"].includes(r.error.code),
      `${label}: error inesperado ${r.error.code} ${r.error.message}`,
    );
  } else {
    assert.equal(r.rowCount, 0, `${label}: la escritura afectó ${r.rowCount} fila(s)`);
  }
}

function assertDenied(r, label) {
  assert.ok(r.error, `${label}: debía fallar`);
  assert.equal(r.error.code, "42501", `${label}: ${r.error.message}`);
}

const ids = (r) => r.rows.map((row) => row.id ?? row.org_id ?? row.user_id).sort();

describe("anon", () => {
  const tables = [
    "organizations",
    "org_members",
    "price_lists",
    "products",
    "product_prices",
    "b2b_customers",
    "exchange_rates",
    "web_orders",
    "sync_logs",
    "catalog_categories",
  ];

  for (const t of tables) {
    it(`no puede leer ${t}`, () =>
      withTenants(async (c) => {
        await as(c, null);
        assertDenied(await attempt(c, `SELECT count(*) FROM public.${t}`), t);
      }));
  }

  it("no puede escribir", () =>
    withTenants(async (c) => {
      await as(c, null);
      assertDenied(
        await attempt(c, `INSERT INTO public.exchange_rates (org_id, rate_bs) VALUES ($1, 99)`, [
          ORG_A,
        ]),
        "insert tasa",
      );
      assertDenied(await attempt(c, `UPDATE public.products SET description = 'x'`), "update");
      assertDenied(await attempt(c, `DELETE FROM public.web_orders`), "delete");
    }));
});

describe("aislamiento de lectura entre tenants", () => {
  it("sin membresía no se ve nada", () =>
    withTenants(async (c) => {
      await as(c, U_NOBODY);
      for (const t of [
        "org_members",
        "price_lists",
        "products",
        "product_prices",
        "b2b_customers",
        "web_orders",
        "exchange_rates",
        "sync_logs",
      ]) {
        const r = await attempt(c, `SELECT org_id FROM public.${t}`);
        assert.equal(r.rowCount, 0, `${t} visible sin membresía`);
      }
      const orgs = await attempt(c, `SELECT id FROM public.organizations`);
      assert.equal(orgs.rowCount, 0);
    }));

  it("el owner de A ve lo suyo (control positivo) y nada de B", () =>
    withTenants(async (c) => {
      await as(c, U_OWNER_A);
      const org = await attempt(c, `SELECT id FROM public.organizations`);
      assert.deepEqual(ids(org), [ORG_A]);

      const checks = {
        price_lists: [PL_A1, PL_A2],
        products: [P_A_ACTIVE, P_A_INACTIVE],
        b2b_customers: [C_A1, C_A2],
        web_orders: [O_A1, O_A2, O_A1_SYNCED],
      };
      for (const [t, expected] of Object.entries(checks)) {
        const r = await attempt(c, `SELECT id FROM public.${t}`);
        assert.deepEqual(ids(r), [...expected].sort(), t);
      }
      const members = await attempt(c, `SELECT user_id FROM public.org_members`);
      assert.deepEqual(ids(members), [U_OWNER_A, U_ADMIN_A, U_STAFF_A, U_CUST_A1].sort());

      for (const t of ["product_prices", "exchange_rates", "sync_logs"]) {
        const r = await attempt(c, `SELECT org_id FROM public.${t}`);
        assert.ok(r.rowCount > 0, `${t}: control positivo vacío`);
        assert.ok(
          r.rows.every((row) => row.org_id === ORG_A),
          `${t}: aparecen filas de otra organización`,
        );
      }
    }));

  it("el owner de B no ve nada de A (simétrico)", () =>
    withTenants(async (c) => {
      await as(c, U_OWNER_B);
      for (const t of ["price_lists", "products", "b2b_customers", "web_orders"]) {
        const r = await attempt(c, `SELECT id, org_id FROM public.${t}`);
        assert.ok(r.rowCount > 0, `${t}: control positivo vacío`);
        assert.ok(
          r.rows.every((row) => row.org_id === ORG_B),
          `${t} filtra filas de A`,
        );
      }
    }));

  it("filtrar explícitamente por el org_id ajeno devuelve 0 filas", () =>
    withTenants(async (c) => {
      await as(c, U_OWNER_A);
      for (const t of [
        "organizations",
        "price_lists",
        "products",
        "b2b_customers",
        "web_orders",
        "exchange_rates",
        "sync_logs",
        "org_members",
        "product_prices",
      ]) {
        const col = t === "organizations" ? "id" : "org_id";
        const r = await attempt(c, `SELECT 1 FROM public.${t} WHERE ${col} = $1`, [ORG_B]);
        assert.equal(r.rowCount, 0, t);
      }
    }));
});

describe("escrituras entre tenants (casos negativos)", () => {
  it("el owner de A no puede insertar en B", () =>
    withTenants(async (c) => {
      await as(c, U_OWNER_A);
      assertBlocked(
        await attempt(
          c,
          `INSERT INTO public.price_lists (org_id, code, name) VALUES ($1, 'X', 'X')`,
          [ORG_B],
        ),
        "price_lists",
      );
      assertBlocked(
        await attempt(
          c,
          `INSERT INTO public.product_prices (org_id, product_id, price_list_id, price_usd) VALUES ($1, $2, $3, 1)`,
          [ORG_B, P_B, PL_B],
        ),
        "product_prices",
      );
      assertBlocked(
        await attempt(
          c,
          `INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`,
          [ORG_B, U_NOBODY],
        ),
        "org_members",
      );
      assertBlocked(
        await attempt(
          c,
          `INSERT INTO public.exchange_rates (org_id, rate_bs, set_by) VALUES ($1, 999, $2)`,
          [ORG_B, U_OWNER_A],
        ),
        "exchange_rates",
      );
      assertBlocked(
        await attempt(
          c,
          `INSERT INTO public.web_orders (org_id, customer_id, total_usd, exchange_rate_used, items) VALUES ($1, $2, 1, 1, $3)`,
          [ORG_B, C_B1, ITEMS],
        ),
        "web_orders",
      );
      assertBlocked(
        await attempt(
          c,
          `INSERT INTO public.sync_logs (org_id, direction, entity, status) VALUES ($1, 'erp_to_cloud', 'products', 'success')`,
          [ORG_B],
        ),
        "sync_logs",
      );
    }));

  it("el owner de A no puede actualizar ni borrar datos de B", () =>
    withTenants(async (c) => {
      await as(c, U_OWNER_A);
      const writes = [
        ["org", `UPDATE public.organizations SET name = 'hackeada' WHERE id = $1`],
        ["products", `UPDATE public.products SET description = 'x' WHERE org_id = $1`],
        ["customers", `UPDATE public.b2b_customers SET price_list_id = NULL WHERE org_id = $1`],
        ["orders", `UPDATE public.web_orders SET status = 'cancelled' WHERE org_id = $1`],
        ["members update", `UPDATE public.org_members SET role = 'staff' WHERE org_id = $1`],
        ["members delete", `DELETE FROM public.org_members WHERE org_id = $1`],
        ["price_lists update", `UPDATE public.price_lists SET name = 'x' WHERE org_id = $1`],
        ["price_lists delete", `DELETE FROM public.price_lists WHERE org_id = $1`],
        ["prices update", `UPDATE public.product_prices SET price_usd = 0 WHERE org_id = $1`],
        ["prices delete", `DELETE FROM public.product_prices WHERE org_id = $1`],
        ["products delete", `DELETE FROM public.products WHERE org_id = $1`],
        ["orders delete", `DELETE FROM public.web_orders WHERE org_id = $1`],
      ];
      for (const [label, sql] of writes) {
        assertBlocked(await attempt(c, sql, [ORG_B]), label);
      }
      // y B conserva todo intacto
      await c.query("RESET ROLE");
      const org = await c.query(`SELECT name FROM public.organizations WHERE id = $1`, [ORG_B]);
      assert.equal(org.rows[0].name, "Org B");
      const orders = await c.query(
        `SELECT count(*)::int AS n FROM public.web_orders WHERE org_id = $1 AND status = 'pending_sync'`,
        [ORG_B],
      );
      assert.equal(orders.rows[0].n, 1);
    }));

  it("un cliente de A no puede tocar datos de B", () =>
    withTenants(async (c) => {
      await as(c, U_CUST_A1);
      assertBlocked(
        await attempt(c, `UPDATE public.web_orders SET status = 'cancelled' WHERE id = $1`, [O_B]),
        "cancelar pedido de B",
      );
      assertBlocked(
        await attempt(c, `DELETE FROM public.b2b_customers WHERE id = $1`, [C_B1]),
        "borrar cliente de B",
      );
      assertBlocked(
        await attempt(
          c,
          `INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [ORG_B, U_CUST_A1],
        ),
        "auto-asignarse a B",
      );
    }));

  it("las claves foráneas compuestas impiden referenciar filas de otro tenant", () =>
    withTenants(async (c) => {
      await as(c, U_OWNER_A);
      // precio en org A apuntando a un producto de B
      const r1 = await attempt(
        c,
        `INSERT INTO public.product_prices (org_id, product_id, price_list_id, price_usd) VALUES ($1, $2, $3, 1)`,
        [ORG_A, P_B, PL_A1],
      );
      assert.equal(r1.error?.code, "23503", "producto de otro tenant");
      // cliente de A con lista de precios de B
      const r2 = await attempt(
        c,
        `UPDATE public.b2b_customers SET price_list_id = $2 WHERE id = $1`,
        [C_A1, PL_B],
      );
      assert.equal(r2.error?.code, "23503", "lista de otro tenant");
    }));
});

describe("roles dentro de una organización", () => {
  it("staff: lee todo el catálogo pero no administra", () =>
    withTenants(async (c) => {
      await as(c, U_STAFF_A);
      const products = await attempt(c, `SELECT id FROM public.products`);
      assert.deepEqual(ids(products), [P_A_ACTIVE, P_A_INACTIVE].sort());
      assert.ok((await attempt(c, `SELECT 1 FROM public.sync_logs`)).rowCount > 0);

      assertBlocked(
        await attempt(c, `UPDATE public.products SET description = 'x' WHERE id = $1`, [P_A_ACTIVE]),
        "editar producto",
      );
      assertBlocked(
        await attempt(c, `INSERT INTO public.price_lists (org_id, code, name) VALUES ($1, 'Z', 'Z')`, [
          ORG_A,
        ]),
        "crear lista",
      );
      assertBlocked(
        await attempt(
          c,
          `INSERT INTO public.exchange_rates (org_id, rate_bs, set_by) VALUES ($1, 50, $2)`,
          [ORG_A, U_STAFF_A],
        ),
        "fijar tasa",
      );
      assertBlocked(
        await attempt(c, `UPDATE public.org_members SET role = 'admin' WHERE user_id = $1`, [
          U_STAFF_A,
        ]),
        "autopromoverse",
      );
    }));

  it("staff: puede anular un pedido pendiente, no aprobarlo ni anular uno ya sincronizado", () =>
    withTenants(async (c) => {
      await as(c, U_STAFF_A);
      assertBlocked(
        await attempt(c, `UPDATE public.web_orders SET status = 'approved' WHERE id = $1`, [O_A1]),
        "aprobar",
      );
      assertBlocked(
        await attempt(c, `UPDATE public.web_orders SET status = 'cancelled' WHERE id = $1`, [
          O_A1_SYNCED,
        ]),
        "anular sincronizado",
      );
      const ok = await attempt(
        c,
        `UPDATE public.web_orders SET status = 'cancelled' WHERE id = $1`,
        [O_A1],
      );
      assert.equal(ok.rowCount, 1);
      assertDenied(
        await attempt(c, `UPDATE public.web_orders SET total_usd = 0 WHERE id = $1`, [O_A2]),
        "cambiar el total",
      );
    }));

  it("customer: solo ve su cliente, sus pedidos y el catálogo activo", () =>
    withTenants(async (c) => {
      await as(c, U_CUST_A1);
      assert.deepEqual(ids(await attempt(c, `SELECT id FROM public.b2b_customers`)), [C_A1]);
      assert.deepEqual(ids(await attempt(c, `SELECT id FROM public.web_orders`)), [
        O_A1,
        O_A1_SYNCED,
      ].sort());
      assert.deepEqual(ids(await attempt(c, `SELECT id FROM public.products`)), [P_A_ACTIVE]);
      assert.deepEqual(ids(await attempt(c, `SELECT id FROM public.price_lists`)), [PL_A2]);
      const prices = await attempt(c, `SELECT price_list_id, price_usd FROM public.product_prices`);
      assert.deepEqual(
        prices.rows.map((r) => [r.price_list_id, Number(r.price_usd)]),
        [[PL_A2, 8]],
      );
      assert.equal((await attempt(c, `SELECT 1 FROM public.sync_logs`)).rowCount, 0);
      assert.deepEqual(ids(await attempt(c, `SELECT user_id FROM public.org_members`)), [U_CUST_A1]);
      assert.equal((await attempt(c, `SELECT 1 FROM public.exchange_rates`)).rowCount, 1);
    }));

  it("customer: no puede escribir pedidos, ni subir de rol, ni editar el catálogo", () =>
    withTenants(async (c) => {
      await as(c, U_CUST_A1);
      assertDenied(
        await attempt(
          c,
          `INSERT INTO public.web_orders (org_id, customer_id, total_usd, exchange_rate_used, items) VALUES ($1, $2, 1, 1, $3)`,
          [ORG_A, C_A1, ITEMS],
        ),
        "crear pedido directo",
      );
      assertBlocked(
        await attempt(c, `UPDATE public.web_orders SET status = 'cancelled' WHERE id = $1`, [O_A1]),
        "anular su pedido",
      );
      assertBlocked(
        await attempt(c, `UPDATE public.org_members SET role = 'owner' WHERE user_id = $1`, [
          U_CUST_A1,
        ]),
        "subir de rol",
      );
      assertBlocked(
        await attempt(c, `UPDATE public.b2b_customers SET price_list_id = $2 WHERE id = $1`, [
          C_A1,
          PL_A1,
        ]),
        "cambiarse de lista",
      );
      assertDenied(
        await attempt(c, `UPDATE public.b2b_customers SET credit_limit_usd = 1e9 WHERE id = $1`, [
          C_A1,
        ]),
        "subirse el crédito",
      );
      assertBlocked(
        await attempt(c, `UPDATE public.products SET description = 'x'`),
        "editar productos",
      );
    }));

  it("admin no puede crear ni tocar owners; el owner sí", () =>
    withTenants(async (c) => {
      await as(c, U_ADMIN_A);
      assertBlocked(
        await attempt(
          c,
          `INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [ORG_A, U_NOBODY],
        ),
        "crear owner",
      );
      assertBlocked(
        await attempt(c, `UPDATE public.org_members SET role = 'admin' WHERE user_id = $1`, [
          U_OWNER_A,
        ]),
        "degradar al owner",
      );
      assertBlocked(
        await attempt(c, `DELETE FROM public.org_members WHERE user_id = $1`, [U_OWNER_A]),
        "expulsar al owner",
      );
      assertBlocked(
        await attempt(c, `UPDATE public.org_members SET role = 'owner' WHERE user_id = $1`, [
          U_ADMIN_A,
        ]),
        "autopromoverse a owner",
      );
      const staff = await attempt(
        c,
        `INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'staff')`,
        [ORG_A, U_NOBODY],
      );
      assert.equal(staff.rowCount, 1, "el admin sí puede añadir personal");

      await as(c, U_OWNER_A);
      const owner = await attempt(
        c,
        `UPDATE public.org_members SET role = 'owner' WHERE user_id = $1`,
        [U_NOBODY],
      );
      assert.equal(owner.rowCount, 1, "el owner sí puede promover");
    }));

  it("admin: gestiona listas de precio y asigna lista a un cliente", () =>
    withTenants(async (c) => {
      await as(c, U_ADMIN_A);
      const created = await attempt(
        c,
        `INSERT INTO public.price_lists (org_id, code, name) VALUES ($1, 'L3', 'Lista 3')`,
        [ORG_A],
      );
      assert.equal(created.rowCount, 1);
      const assigned = await attempt(
        c,
        `UPDATE public.b2b_customers SET price_list_id = $2 WHERE id = $1`,
        [C_A2, PL_A1],
      );
      assert.equal(assigned.rowCount, 1);
      const desc = await attempt(
        c,
        `UPDATE public.products SET description = 'nueva' WHERE id = $1`,
        [P_A_ACTIVE],
      );
      assert.equal(desc.rowCount, 1);
      // pero no los datos que pertenecen al ERP
      assertDenied(
        await attempt(c, `UPDATE public.products SET price_usd = 0 WHERE id = $1`, [P_A_ACTIVE]),
        "cambiar precio del ERP",
      );
      assertDenied(
        await attempt(c, `UPDATE public.web_orders SET total_usd = 0 WHERE id = $1`, [O_A1]),
        "cambiar total de un pedido",
      );
    }));
});

describe("vista catalog_categories", () => {
  const withCategories = async (c) => {
    await c.query(
      `UPDATE public.products
          SET category = CASE id WHEN $1 THEN 'Alimentos' WHEN $2 THEN 'Inactiva' ELSE 'Ferretería' END`,
      [P_A_ACTIVE, P_A_INACTIVE],
    );
  };
  const SELECT_VIEW = `SELECT org_id, category, product_count FROM public.catalog_categories`;

  it("cuenta solo productos activos de la propia organización (comprador y personal)", () =>
    withTenants(async (c) => {
      await withCategories(c);
      for (const user of [U_CUST_A1, U_STAFF_A, U_OWNER_A]) {
        await as(c, user);
        const r = await attempt(c, SELECT_VIEW);
        assert.deepEqual(
          r.rows.map((row) => [row.org_id, row.category, row.product_count]),
          [[ORG_A, "Alimentos", 1]],
          `usuario ${user}`,
        );
      }
      await as(c, U_CUST_B);
      const b = await attempt(c, SELECT_VIEW);
      assert.deepEqual(b.rows.map((row) => [row.org_id, row.category]), [[ORG_B, "Ferretería"]]);
    }));

  it("un autenticado sin membresía no ve categorías y la vista no admite escrituras", () =>
    withTenants(async (c) => {
      await withCategories(c);
      await as(c, U_NOBODY);
      assert.equal((await attempt(c, SELECT_VIEW)).rowCount, 0);
      await as(c, U_OWNER_A);
      const write = await attempt(c, `UPDATE public.catalog_categories SET category = 'x'`);
      // 55000: la vista agregada no es actualizable; 42501: sin permiso. Ambas son rechazos.
      assert.ok(["42501", "55000"].includes(write.error?.code), "la vista no admite escrituras");
    }));
});

describe("datos sensibles y tasa de cambio", () => {
  it("api_key_hash no se puede leer ni modificar desde un usuario", () =>
    withTenants(async (c) => {
      for (const u of [U_OWNER_A, U_ADMIN_A, U_STAFF_A, U_CUST_A1]) {
        await as(c, u);
        assertDenied(await attempt(c, `SELECT api_key_hash FROM public.organizations`), "select");
        assertDenied(await attempt(c, `SELECT * FROM public.organizations`), "select *");
        assertDenied(
          await attempt(c, `UPDATE public.organizations SET api_key_hash = 'robada' WHERE id = $1`, [
            ORG_A,
          ]),
          "update",
        );
        const ok = await attempt(c, `SELECT id, name, exchange_rate_bs FROM public.organizations`);
        assert.equal(ok.rowCount, 1);
      }
    }));

  it("el admin fija la tasa a su nombre y se actualiza la tasa vigente", () =>
    withTenants(async (c) => {
      await as(c, U_ADMIN_A);
      const ins = await attempt(
        c,
        `INSERT INTO public.exchange_rates (org_id, rate_bs, set_by) VALUES ($1, 55.25, $2)`,
        [ORG_A, U_ADMIN_A],
      );
      assert.equal(ins.rowCount, 1);
      const org = await attempt(c, `SELECT exchange_rate_bs FROM public.organizations`);
      assert.equal(Number(org.rows[0].exchange_rate_bs), 55.25);

      // B no se movió
      await c.query("RESET ROLE");
      const b = await c.query(`SELECT exchange_rate_bs FROM public.organizations WHERE id = $1`, [
        ORG_B,
      ]);
      assert.equal(Number(b.rows[0].exchange_rate_bs), 41);
    }));

  it("la tasa no se puede falsear: autor ajeno, origen distinto de manual, valor no positivo", () =>
    withTenants(async (c) => {
      await as(c, U_ADMIN_A);
      assertBlocked(
        await attempt(
          c,
          `INSERT INTO public.exchange_rates (org_id, rate_bs, set_by) VALUES ($1, 50, $2)`,
          [ORG_A, U_OWNER_A],
        ),
        "set_by ajeno",
      );
      assertBlocked(
        await attempt(
          c,
          `INSERT INTO public.exchange_rates (org_id, rate_bs, source, set_by) VALUES ($1, 50, 'bcv', $2)`,
          [ORG_A, U_ADMIN_A],
        ),
        "source bcv",
      );
      const neg = await attempt(
        c,
        `INSERT INTO public.exchange_rates (org_id, rate_bs, set_by) VALUES ($1, -1, $2)`,
        [ORG_A, U_ADMIN_A],
      );
      assert.equal(neg.error?.code, "23514", "CHECK rate_bs > 0");
    }));

  it("el historial de tasas es inmutable", () =>
    withTenants(async (c) => {
      await as(c, U_OWNER_A);
      assertDenied(await attempt(c, `UPDATE public.exchange_rates SET rate_bs = 1`), "update");
      assertDenied(await attempt(c, `DELETE FROM public.exchange_rates`), "delete");
    }));

  it("las funciones auxiliares y de trigger no se pueden llamar desde la API", () =>
    withTenants(async (c) => {
      await as(c, null);
      assertDenied(await attempt(c, `SELECT private.is_org_member($1)`, [ORG_A]), "anon private");
      await as(c, U_OWNER_A);
      assertDenied(await attempt(c, `SELECT public.apply_exchange_rate()`), "apply_exchange_rate");
      assertDenied(await attempt(c, `SELECT public.set_updated_at()`), "set_updated_at");
    }));
});

describe("service_role (control: es lo que usa la API de ingesta)", () => {
  it("ve ambos tenants, lo que demuestra que las pruebas anteriores no son vacuas", () =>
    withTenants(async (c) => {
      await c.query("RESET ROLE");
      await c.query("SET LOCAL ROLE service_role");
      const r = await attempt(
        c,
        `SELECT DISTINCT org_id FROM public.products WHERE org_id IN ($1, $2)`,
        [ORG_A, ORG_B],
      );
      assert.deepEqual(ids(r), [ORG_A, ORG_B]);
    }));
});
