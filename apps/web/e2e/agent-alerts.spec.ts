import { expect, test } from "@playwright/test";
import { ANON_KEY, API_URL, PASSWORD, SUPABASE_URL, login, psql } from "./helpers";

/**
 * Tarea 8.2: alertas de "agente sin conexión" en el panel, con una organización propia
 * (e2e-alerts) para no tocar el seed. El latido viejo se simula por SQL; el latido nuevo lo manda
 * la API real, igual que el agente.
 */

const ORG_SLUG = "e2e-alerts";
const AGENT_KEY = "erp_e2e_alerts_key";
const ADMIN = "admin-alerts@example.test";
const TITLE = "Panel · ERP Web Bridge";

const heartbeatAgo = (minutes: number | null) =>
  psql(
    `update public.organizations set last_heartbeat_at = ${
      minutes === null ? "null" : `now() - interval '${minutes} minutes'`
    } where slug = '${ORG_SLUG}'`,
  );

function cleanup() {
  psql(`delete from public.organizations where slug = '${ORG_SLUG}'`);
  psql(`delete from auth.users where email = '${ADMIN}'`);
}

test.describe("alertas de agente sin conexión", () => {
  test.beforeAll(async ({ request }) => {
    cleanup();
    psql(
      `insert into public.organizations (name, slug, erp_type, api_key_hash)
       values ('E2E Alertas', '${ORG_SLUG}', 'mock', encode(extensions.digest('${AGENT_KEY}', 'sha256'), 'hex'))`,
    );
    const res = await request.post(`${SUPABASE_URL}/auth/v1/signup`, {
      headers: { apikey: ANON_KEY },
      data: { email: ADMIN, password: PASSWORD },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const adminId = (body.user?.id ?? body.id) as string;
    psql(
      `insert into public.org_members (org_id, user_id, role)
       select id, '${adminId}', 'admin' from public.organizations where slug = '${ORG_SLUG}'`,
    );
  });

  test.afterAll(() => cleanup());

  async function openPanel(page: import("@playwright/test").Page) {
    await login(page, ADMIN);
    await expect(page).toHaveURL(/\/catalogo$/);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Panel de administración" })).toBeVisible();
    await expect(page.getByTestId("live-status")).toHaveText("En vivo");
  }

  const heartbeat = (request: import("@playwright/test").APIRequestContext) =>
    request.post(`${API_URL}/v1/agent/heartbeat`, {
      headers: { "x-api-key": AGENT_KEY },
      data: { agent_version: "e2e", queue_depth: 0 },
    });

  test("un agente que nunca se conectó muestra un aviso informativo, sin contarlo como alerta", async ({
    page,
  }) => {
    heartbeatAgo(null);
    await openPanel(page);
    const alert = page.getByTestId("panel-alert");
    await expect(alert).toHaveCount(1);
    await expect(alert).toHaveAttribute("data-alert-id", "agent-never");
    await expect(alert).toContainText("Aún no hay un agente conectado");
    await expect(page.getByTestId("alert-counter")).toHaveText("Sin alertas");
    await expect(page).toHaveTitle(TITLE);
  });

  test("caída y recuperación EN VIVO: banner, contador, título de la pestaña y desaparición sin recargar", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    expect((await heartbeat(request)).status()).toBe(200);
    await openPanel(page);

    // Con el agente al día no hay alertas.
    await expect(page.getByTestId("agent-status")).toHaveText("Conectado");
    await expect(page.getByTestId("panel-alert")).toHaveCount(0);
    await expect(page.getByTestId("alert-counter")).toHaveText("Sin alertas");

    // El agente deja de dar señales (el panel relee la organización cada 30 s).
    heartbeatAgo(10);
    const banner = page.getByTestId("panel-alert");
    await expect(banner).toHaveAttribute("data-alert-id", "agent-offline", { timeout: 60_000 });
    await expect(banner).toHaveAttribute("data-level", "error");
    await expect(banner).toHaveAttribute("role", "alert");
    await expect(banner).toContainText("El agente local no responde");
    await expect(banner).toContainText("Sin conexión desde hace 10 min");
    await expect(page.getByTestId("agent-status")).toContainText("Sin conexión");
    const counter = page.getByTestId("alert-counter");
    await expect(counter).toHaveText("1 alerta");
    await expect(counter).toHaveAttribute("data-level", "error");
    await expect(page).toHaveTitle(`(1) ${TITLE}`);

    // Es accionable: dice qué hacer, con los comandos reales del servicio.
    await banner.getByText("Qué hacer").click();
    await expect(banner).toContainText("erp-agent service status");
    await expect(banner).toContainText("erp-agent service start");
    await expect(banner).toContainText("erp-agent.log");

    // El contador de la cabecera lleva al detalle.
    await counter.click();
    await expect(page).toHaveURL(/#alertas$/);

    // El agente vuelve: la alerta desaparece sin recargar.
    expect((await heartbeat(request)).status()).toBe(200);
    await expect(page.getByTestId("panel-alert")).toHaveCount(0, { timeout: 60_000 });
    await expect(counter).toHaveText("Sin alertas");
    await expect(page).toHaveTitle(TITLE);
    await expect(page.getByTestId("agent-status")).toHaveText("Conectado");
  });

  test("al abrir el panel con el agente ya caído, el banner está desde el primer momento", async ({
    page,
  }) => {
    heartbeatAgo(45);
    await openPanel(page);
    await expect(page.getByTestId("panel-alert")).toHaveAttribute("data-alert-id", "agent-offline");
    await expect(page.getByTestId("alert-counter")).toHaveText("1 alerta");
    await expect(page.getByTestId("panel-alert")).toContainText("Sin conexión desde hace 45 min");
  });
});
