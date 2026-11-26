import { createHmac, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { hashApiKey } from "../src/auth/api-key";
import { loadConfig } from "../src/config";

/** Ayudas para las pruebas de integración contra la base real de `pnpm db:start`. */

export const config = loadConfig();

export function newPool(): Pool {
  return new Pool({ connectionString: config.databaseUrl, max: 4 });
}

export interface TestTenant {
  orgId: string;
  slug: string;
  apiKey: string;
}

/** Crea una organización propia (id, slug y clave aleatorios): no depende del seed. */
export async function createTenant(
  pool: Pool,
  opts: { isActive?: boolean; erpType?: string } = {},
): Promise<TestTenant> {
  const orgId = randomUUID();
  const suffix = orgId.slice(0, 8);
  const apiKey = `test_key_${randomUUID()}`;
  await pool.query(
    `INSERT INTO public.organizations (id, name, slug, erp_type, api_key_hash, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      orgId,
      `Test ${suffix}`,
      `test-${suffix}`,
      opts.erpType ?? "mock",
      hashApiKey(apiKey),
      opts.isActive ?? true,
    ],
  );
  return { orgId, slug: `test-${suffix}`, apiKey };
}

/** Crea un usuario de auth.users y lo hace miembro (personal) de la organización. */
export async function createStaffUser(
  pool: Pool,
  orgId: string,
  role: "owner" | "admin" | "staff" = "admin",
): Promise<string> {
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO auth.users (id, aud, role, email) VALUES ($1, 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@test.local`],
  );
  await pool.query(`INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, $3)`, [
    orgId,
    userId,
    role,
  ]);
  return userId;
}

/** Un comprador del catálogo: usuario con rol customer atado a su cliente B2B. */
export interface TestCustomer {
  userId: string;
  customerId: string;
  customerCode: string;
}

/** Crea un cliente B2B (con límite, deuda y lista de precios) y un usuario con rol customer. */
export async function createCustomerUser(
  pool: Pool,
  orgId: string,
  opts: {
    creditLimit?: number;
    debt?: number;
    priceListId?: string | null;
    isActive?: boolean;
  } = {},
): Promise<TestCustomer> {
  const customerId = randomUUID();
  const customerCode = `C-${customerId.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO public.b2b_customers
       (id, org_id, erp_customer_code, tax_id, business_name, credit_limit_usd, current_debt_usd,
        price_list_id, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      customerId,
      orgId,
      customerCode,
      "J-1",
      "Cliente de prueba",
      opts.creditLimit ?? 0,
      opts.debt ?? 0,
      opts.priceListId ?? null,
      opts.isActive ?? true,
    ],
  );
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO auth.users (id, aud, role, email) VALUES ($1, 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@test.local`],
  );
  await pool.query(
    `INSERT INTO public.org_members (org_id, user_id, role, customer_id) VALUES ($1, $2, 'customer', $3)`,
    [orgId, userId, customerId],
  );
  return { userId, customerId, customerCode };
}

/** Borra los tenants de prueba (las FK en cascada limpian el resto) y sus usuarios. */
export async function cleanup(pool: Pool, orgIds: string[], userIds: string[] = []): Promise<void> {
  if (orgIds.length)
    await pool.query(`DELETE FROM public.organizations WHERE id = ANY($1::uuid[])`, [orgIds]);
  if (userIds.length)
    await pool.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [userIds]);
}

/** Firma un JWT HS256 como lo haría Supabase Auth. */
export function signJwt(
  claims: Record<string, unknown>,
  secret: string = config.jwtSecret,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const data = `${b64(header)}.${b64(claims)}`;
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}

export function userToken(userId: string, ttlSeconds = 3600): string {
  return signJwt({
    sub: userId,
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}
