import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { ANON_KEY, API_URL, PASSWORD, SUPABASE_URL, login } from "./helpers";

/**
 * Gate 7, de punta a punta y con todo real: el comprador hace un pedido en la web, el BINARIO del
 * agente (login SQL restringido erp_agent) lo deja como borrador en el sandbox de Saint (SQL Server
 * en Docker) y el panel de administración lo muestra «Enviado al ERP» con su referencia, sin recargar.
 * Después se simula que la confirmación se perdió y se vuelve a ejecutar el agente: no hay un
 * segundo borrador.
 *
 * Necesita: `pnpm db:start` (Supabase completo), `bash scripts/saint-sandbox.sh up` (contenedor
 * saint-sql) y Go para compilar el agente. Crea y borra su propia organización (e2e-gate7).
 */

const ORG_SLUG = "e2e-gate7";
const AGENT_KEY = "erp_e2e_gate7_key";
const ADMIN = "admin-gate7@example.test";
const BUYER = "buyer-gate7@example.test";
const REPO = path.resolve(__dirname, "../../..");
const MAPPING = path.join(REPO, "infra/saint-sandbox/mapping.saint.yaml").replaceAll("\\", "/");
// Login restringido del sandbox (infra/saint-sandbox/init/04-agent-login.sql); NUNCA sa.
const AGENT_DSN =
  "sqlserver://erp_agent:Agent_Demo_2026%21@localhost:14330?database=SAINT_DEMO&encrypt=disable";

function psql(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "supabase_db_erp-web-bridge",
      "psql",
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-t",
      "-A",
      "-q",
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  ).trim();
}

/** Consulta al SQL Server del sandbox como administrador (solo para comprobar, nunca para escribir). */
function sandbox(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "saint-sql",
      "bash",
      "-c",
      `/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -d SAINT_DEMO -h -1 -W -b -Q "SET NOCOUNT ON; ${sql}"`,
    ],
    { encoding: "utf8" },
  )
    .replaceAll("\r", "")
    .trim();
}

function cleanup() {
  psql(`delete from public.organizations where slug = '${ORG_SLUG}'`);
  psql(`delete from auth.users where email in ('${ADMIN}', '${BUYER}')`);
}

test.describe("Gate 7: del pedido web al borrador del ERP", () => {
  let dir: string;
  let exe: string;
  let config: string;

  /** Ejecuta el binario del agente un ciclo (-once) y devuelve su registro (stderr). */
  function runAgent(): { code: number | null; log: string } {
    const r = spawnSync(exe, ["-config", config, "-once"], { encoding: "utf8", timeout: 120_000 });
    return { code: r.status, log: `${r.stdout}${r.stderr}` };
  }

  test.beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "gate7-"));
    exe = path.join(dir, process.platform === "win32" ? "erp-agent.exe" : "erp-agent");
    config = path.join(dir, "agent.yaml");
    execFileSync("go", ["build", "-o", exe, "./cmd/erp-agent"], {
      cwd: path.join(REPO, "packages/erp-agent"),
      env: { ...process.env, CGO_ENABLED: "0" },
    });
    writeFileSync(
      config,
      [
        "api:",
        `  url: ${API_URL}`,
        `  api_key: ${AGENT_KEY}`,
        "erp:",
        "  type: saint",
        "  saint:",
        `    dsn: "${AGENT_DSN}"`,
        `    mapping_file: ${MAPPING}`,
        "store:",
        `  path: ${path.join(dir, "agent.db").replaceAll("\\", "/")}`,
        "log:",
        "  format: text",
        "",
      ].join("\n"),
    );
    cleanup();
    psql(
      `insert into public.organizations (name, slug, erp_type, api_key_hash)
       values ('E2E Gate 7', '${ORG_SLUG}', 'saint', encode(extensions.digest('${AGENT_KEY}', 'sha256'), 'hex'))`,
    );
  });

  test.afterAll(() => {
    try {
      cleanup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pedido en la web → borrador en el sandbox → «Enviado al ERP» en el panel, y reintentar no duplica", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);

    // 1) El agente real sincroniza el sandbox (catálogo y clientes) a la organización de prueba.
    const sync = runAgent();
    expect(sync.code, sync.log).toBe(0);
    expect(sync.log).toContain("login del ERP verificado");

    // 2) Usuarios: un administrador y un comprador atado a un cliente con crédito holgado.
    const signup = async (email: string) => {
      const res = await request.post(`${SUPABASE_URL}/auth/v1/signup`, {
        headers: { apikey: ANON_KEY },
        data: { email, password: PASSWORD },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      return (body.user?.id ?? body.id) as string;
    };
    const adminId = await signup(ADMIN);
    const buyerId = await signup(BUYER);
    const org = psql(`select id from public.organizations where slug = '${ORG_SLUG}'`);
    const customer = psql(
      `select id || '|' || erp_customer_code from public.b2b_customers
        where org_id = '${org}' and is_active order by credit_limit_usd - current_debt_usd desc limit 1`,
    );
    const [customerId, customerCode] = customer.split("|") as [string, string];
    const sku = psql(
      `select erp_sku from public.products where org_id = '${org}' and is_active and stock > 5 order by erp_sku limit 1`,
    );
    psql(
      `insert into public.org_members (org_id, user_id, role) values ('${org}', '${adminId}', 'admin')`,
    );
    psql(
      `insert into public.org_members (org_id, user_id, role, customer_id) values ('${org}', '${buyerId}', 'customer', '${customerId}')`,
    );

    // 3) El administrador abre el panel y lo deja suscrito en vivo.
    await login(page, ADMIN);
    await expect(page).toHaveURL(/\/catalogo$/);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Panel de administración" })).toBeVisible();
    await expect(page.getByTestId("live-status")).toHaveText("En vivo");

    // 4) El comprador hace su pedido por la API real con su JWT (la misma que usa la web).
    const auth = await request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      headers: { apikey: ANON_KEY },
      data: { email: BUYER, password: PASSWORD },
    });
    const token = (await auth.json()).access_token as string;
    const created = await request.post(`${API_URL}/v1/orgs/${org}/orders`, {
      headers: { authorization: `Bearer ${token}` },
      data: { items: [{ sku, quantity: 2 }], notes: "Pedido del Gate 7" },
    });
    expect(created.status()).toBe(201);
    const order = await created.json();
    const id = order.id as string;

    const row = page.locator(`tr[data-order-id="${id}"]`);
    await expect(row.getByTestId("order-status")).toHaveText("Pendiente de enviar al ERP", {
      timeout: 15_000,
    });
    expect(sandbox(`SELECT COUNT(*) FROM SAPEDIDO WHERE NumeroWeb = '${id}'`)).toBe("0");

    // 5) El agente real lo recoge y lo deja como borrador; el panel cambia sin recargar.
    const first = runAgent();
    expect(first.code, first.log).toBe(0);
    expect(first.log).toContain("borrador creado");
    await expect(row.getByTestId("order-status")).toHaveText("Enviado al ERP", { timeout: 20_000 });
    const reference = (await row.getByTestId("order-ref").textContent()) ?? "";
    expect(reference).toMatch(/^PW\d{7}$/);
    await expect(row.getByTestId("order-error")).toHaveCount(0);

    // 6) En SQL Server: un borrador ('B') con el id web, el cliente, el total y los renglones del pedido.
    const header = sandbox(
      `SELECT NumeroD + '|' + Estado + '|' + CodClie + '|' + CAST(Monto AS VARCHAR(20)) FROM SAPEDIDO WHERE NumeroWeb = '${id}'`,
    );
    expect(header).toBe(`${reference}|B|${customerCode}|${Number(order.total_usd).toFixed(2)}`);
    expect(
      sandbox(
        `SELECT CAST(SUM(Cantidad) AS VARCHAR(20)) + '|' + MIN(CodProd) FROM SAITEMPED WHERE NumeroD = '${reference}'`,
      ),
    ).toBe(`2.000|${sku}`);
    expect(
      psql(`select status || '|' || erp_order_reference from public.web_orders where id = '${id}'`),
    ).toBe(`synced_to_erp|${reference}`);

    // 7) Reintento: se simula que la confirmación se perdió (la nube cree que sigue pendiente) y el
    //    agente corre otra vez. Debe reutilizar el MISMO borrador, no crear otro.
    psql(
      `update public.web_orders set status = 'pending_sync', erp_order_reference = null, synced_at = null where id = '${id}'`,
    );
    await expect(row.getByTestId("order-status")).toHaveText("Pendiente de enviar al ERP", {
      timeout: 15_000,
    });
    const second = runAgent();
    expect(second.code, second.log).toBe(0);
    expect(second.log).toContain("el borrador ya existía");
    expect(second.log).not.toContain("borrador creado");
    await expect(row.getByTestId("order-status")).toHaveText("Enviado al ERP", { timeout: 20_000 });
    await expect(row.getByTestId("order-ref")).toHaveText(reference);
    expect(sandbox(`SELECT COUNT(*) FROM SAPEDIDO WHERE NumeroWeb = '${id}'`)).toBe("1");
    expect(sandbox(`SELECT COUNT(*) FROM SAITEMPED WHERE NumeroD = '${reference}'`)).toBe("1");

    // 8) Limpieza del sandbox (el agente no puede borrar: se hace como administrador).
    sandbox(
      `DELETE FROM SAITEMPED WHERE NumeroD = '${reference}'; DELETE FROM SAPEDIDO WHERE NumeroWeb = '${id}'`,
    );
    expect(customerCode).toMatch(/^C\d+$/);
  });
});
