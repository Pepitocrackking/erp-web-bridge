import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ANON_KEY, PASSWORD, SUPABASE_URL, login, psql } from "./helpers";

/**
 * Fase 9: tasa automática (BCV). Organización propia (e2e-rate) para no tocar el seed. Las fuentes
 * son el simulador e2e/bcv-sim.mjs (puerto 3999), al que apunta la API que levanta Playwright; la
 * API revisa cada 2 s. Si ya había una API corriendo antes (reuseExistingServer), no usa el
 * simulador: pararla antes de correr esta prueba.
 */

const ORG_SLUG = "e2e-rate";
const ADMIN = "admin-rate@example.test";
const STAFF = "staff-rate@example.test";
const SIM = "http://127.0.0.1:3999/control";

const sim = (request: APIRequestContext, data: Record<string, unknown>) =>
  request.post(SIM, { data });

function cleanup() {
  psql(`delete from public.organizations where slug = '${ORG_SLUG}'`);
  psql(`delete from auth.users where email in ('${ADMIN}', '${STAFF}')`);
}

async function signup(request: APIRequestContext, email: string, role: "admin" | "staff") {
  const res = await request.post(`${SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: ANON_KEY },
    data: { email, password: PASSWORD },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const id = (body.user?.id ?? body.id) as string;
  psql(
    `insert into public.org_members (org_id, user_id, role)
     select id, '${id}', '${role}' from public.organizations where slug = '${ORG_SLUG}'`,
  );
}

async function openPanel(page: Page, email = ADMIN) {
  await login(page, email);
  await expect(page).toHaveURL(/\/catalogo$/);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Panel de administración" })).toBeVisible();
  await expect(page.getByTestId("live-status")).toHaveText("En vivo");
}

const auto = (page: Page) => page.getByTestId("rate-auto");
const status = (page: Page) => page.getByTestId("rate-auto-status");
// Solo las alertas de la tasa: esta organización no tiene agente y el panel muestra su aviso informativo.
const alertIds = (page: Page) =>
  page.locator('[data-testid="panel-alert"][data-alert-id^="rate-auto"]');

test.describe("tasa automática del BCV", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request }) => {
    cleanup();
    psql(
      `insert into public.organizations (name, slug, erp_type, api_key_hash)
       values ('E2E Tasa', '${ORG_SLUG}', 'mock', encode(extensions.digest('erp_e2e_rate_key', 'sha256'), 'hex'))`,
    );
    await signup(request, ADMIN, "admin");
    await signup(request, STAFF, "staff");
  });

  test.beforeEach(async ({ request }) => {
    await sim(request, { bcv: "ok", api: "ok", rate: 40.1234 });
  });

  test.afterAll(async ({ request }) => {
    await sim(request, { bcv: "ok", api: "ok", rate: 40.1234 });
    cleanup();
  });

  test("el personal que no administra ve el estado pero no los controles", async ({ page }) => {
    await openPanel(page, STAFF);
    await expect(auto(page)).toHaveAttribute("data-enabled", "false");
    await expect(status(page)).toContainText("Desactivada");
    await expect(page.getByTestId("rate-auto-refresh")).toHaveCount(0);
    await expect(page.getByTestId("rate-auto-enabled")).toHaveCount(0);
    await expect(auto(page)).toContainText("Solo un administrador");
  });

  test("activarla: la tasa del BCV llega sola, con fuente bcv en el historial", async ({
    page,
  }) => {
    await openPanel(page);
    await expect(status(page)).toContainText("Desactivada");
    await expect(page.getByTestId("current-rate")).not.toContainText("40,12");

    await page.getByTestId("rate-auto-enabled").check();
    await page.getByLabel("Revisar cada").selectOption("15");
    await auto(page).getByRole("button", { name: "Guardar" }).click();
    await expect(auto(page).getByRole("status").first()).toContainText("activada");

    // La API revisa cada 2 s: la tasa llega sin recargar (Realtime de exchange_rates).
    await expect(page.getByTestId("current-rate")).toContainText("40,12", { timeout: 20_000 });
    await expect(status(page)).toContainText("Tasa actualizada (bcv.org.ve)", { timeout: 20_000 });
    await page.getByText("Historial reciente").click();
    await expect(page.getByTestId("rate-history").locator("li").first()).toContainText("bcv");
    await expect(alertIds(page)).toHaveCount(0);
  });

  test("caen las dos fuentes: alerta en el panel, la tasa se conserva; al volver, se limpia", async ({
    page,
    request,
  }) => {
    await openPanel(page);
    await sim(request, { bcv: "down", api: "down" });

    await auto(page).getByRole("button", { name: "Actualizar ahora" }).click();
    await expect(auto(page).getByRole("alert")).toContainText("ninguna fuente", {
      ignoreCase: true,
    });
    await expect(alertIds(page)).toHaveCount(1);
    await expect(alertIds(page)).toHaveAttribute("data-alert-id", "rate-auto-failed");
    await expect(page.getByTestId("alert-counter")).toHaveText("1 alerta");
    await expect(page.getByTestId("current-rate")).toContainText("40,12");

    await sim(request, { bcv: "ok" });
    await auto(page).getByRole("button", { name: "Actualizar ahora" }).click();
    await expect(alertIds(page)).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("alert-counter")).toHaveText("Sin alertas");
  });

  test("solo responde la API de respaldo: se usa y se indica", async ({ page, request }) => {
    await openPanel(page);
    await sim(request, { bcv: "down", rate: 41.5 });
    await auto(page).getByRole("button", { name: "Actualizar ahora" }).click();
    await expect(page.getByTestId("current-rate")).toContainText("41,50", { timeout: 20_000 });
    await expect(status(page)).toContainText("dolarapi");
  });

  test("un salto absurdo se descarta con aviso y solo se aplica si el administrador lo fuerza", async ({
    page,
    request,
  }) => {
    await openPanel(page);
    await sim(request, { rate: 4150 });

    await auto(page).getByRole("button", { name: "Actualizar ahora" }).click();
    await expect(auto(page).getByRole("alert")).toContainText("Aceptar aunque cambie mucho");
    await expect(page.getByTestId("current-rate")).toContainText("41,50");
    await expect(alertIds(page)).toHaveAttribute("data-alert-id", "rate-auto-jump");
    await expect(status(page)).toHaveAttribute("data-status", "jump_rejected");

    await auto(page)
      .getByLabel(/Aceptar aunque cambie mucho/)
      .check();
    await auto(page).getByRole("button", { name: "Actualizar ahora" }).click();
    await expect(page.getByTestId("current-rate")).toContainText("4.150", { timeout: 20_000 });
    await expect(alertIds(page)).toHaveCount(0, { timeout: 20_000 });
  });

  test("la tasa manual de hoy tiene prioridad sobre la automática", async ({ page, request }) => {
    await openPanel(page);
    await page.getByLabel("Nueva tasa (Bs por USD)").fill("4200");
    await page.getByRole("button", { name: "Fijar tasa" }).click();
    await expect(page.getByTestId("current-rate")).toContainText("4.200");

    await sim(request, { rate: 4210 }); // dentro del umbral: solo la prioridad manual lo frena
    await auto(page).getByRole("button", { name: "Actualizar ahora" }).click();
    await expect(auto(page).getByRole("status").last()).toContainText("tasa manual");
    await expect(page.getByTestId("current-rate")).toContainText("4.200");
    await expect(status(page)).toHaveAttribute("data-status", "manual_priority");
    await expect(alertIds(page)).toHaveCount(0);
  });

  test("desactivarla la deja quieta: la API no vuelve a tocar la tasa", async ({
    page,
    request,
  }) => {
    await openPanel(page);
    await page.getByTestId("rate-auto-enabled").uncheck();
    await auto(page).getByRole("button", { name: "Guardar" }).click();
    await expect(auto(page).getByRole("status").first()).toContainText("desactivada");
    await expect(status(page)).toContainText("Desactivada");

    await sim(request, { rate: 4300 });
    await page.waitForTimeout(6_000); // varias vueltas de la API (cada 2 s)
    await expect(page.getByTestId("current-rate")).toContainText("4.200");
  });
});
