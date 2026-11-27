import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { USERS, loginAndOpenCatalog, psql } from "./helpers";

/**
 * Genera las capturas del README (docs/screenshots/*.png) con datos reales del seed.
 * No es una prueba: solo corre con SCREENSHOTS=1, así que no afecta a la suite normal.
 *
 *   SCREENSHOTS=1 pnpm exec playwright test e2e/screenshots.spec.ts      (en apps/web, tras `pnpm db:reset`)
 */
test.skip(!process.env.SCREENSHOTS, "solo con SCREENSHOTS=1");
test.use({ viewport: { width: 1280, height: 800 } });

// Las imágenes del seed apuntan a example.com (para probar el manejo de imágenes): en las capturas se
// reemplazan por un marcador neutro en vez de una imagen rota.
const PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#e2e8f0"/><text x="200" y="158" font-family="sans-serif" font-size="22" fill="#64748b" text-anchor="middle">Imagen del producto</text></svg>`;
test.beforeEach(async ({ page }) => {
  await page.route("https://example.com/img/**", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: PLACEHOLDER }),
  );
});

const DEMO_AGENT_KEY = "erp_dev_demo_saint_key"; // clave de agente del seed (demo-saint)

const OUT = path.resolve(__dirname, "../../../docs/screenshots");
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`), animations: "disabled" });

async function addToCart(page: Page, sku: string, name: string, quantity: number) {
  await page.getByRole("searchbox", { name: "Buscar productos" }).fill(sku);
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page.getByRole("article", { name })).toBeVisible();
  const input = page.getByLabel(`Cantidad de ${name}`);
  await expect(async () => {
    await input.fill(String(quantity));
    await expect(input).toHaveValue(String(quantity), { timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await page.getByRole("button", { name: `Agregar ${name} al carrito` }).click();
}

async function demoAdmin(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Entrar como Administrador Demo" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId("live-status")).toHaveText("En vivo");
}

test.describe("capturas del README", () => {
  test("acceso con un clic (modo demo)", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("button", { name: "Entrar como Administrador Demo" }),
    ).toBeVisible();
    await shot(page, "01-login");
  });

  test("catálogo del comprador en USD y Bs", async ({ page }) => {
    await loginAndOpenCatalog(page, USERS.customer);
    await expect(page.getByTestId("price-bs").first()).toBeVisible();
    await shot(page, "02-catalogo");
  });

  test("carrito con validación de crédito", async ({ page }) => {
    await loginAndOpenCatalog(page, USERS.customer);
    await addToCart(page, "P00001", "Producto demo 1", 10);
    await addToCart(page, "P00002", "Producto demo 2", 2);
    await page.getByRole("link", { name: /^Carrito/ }).click();
    await expect(page.getByRole("heading", { name: "Tu carrito" })).toBeVisible();
    await expect(page.getByTestId("total-usd")).toBeVisible();
    await shot(page, "03-carrito");
  });

  test("panel de administración en vivo", async ({ page, request }) => {
    const previous = psql(
      "select coalesce(last_heartbeat_at::text, '') from public.organizations where slug = 'demo-saint'",
    );
    try {
      // Un latido real, como el del agente: el panel muestra «Conectado».
      const beat = await request.post("http://localhost:3001/v1/agent/heartbeat", {
        headers: { "x-api-key": DEMO_AGENT_KEY },
        data: { agent_version: "1.0.0", queue_depth: 0 },
      });
      expect(beat.status()).toBe(200);
      await demoAdmin(page);
      await expect(page.getByTestId("agent-status")).toHaveText("Conectado");
      await expect(page.getByTestId("current-rate")).toContainText("Bs.");
      await shot(page, "04-panel");
    } finally {
      psql(
        `update public.organizations set last_heartbeat_at = ${
          previous ? `'${previous}'::timestamptz` : "null"
        }, agent_version = null where slug = 'demo-saint'`,
      );
    }
  });

  test("simulador de ERP", async ({ page }) => {
    await demoAdmin(page);
    await page.goto("/admin/simulador");
    await expect(page.getByRole("heading", { name: "Simulador de ERP" })).toBeVisible();
    await expect(page.getByTestId("inventory-table")).toBeVisible();
    await shot(page, "05-simulador");
  });

  test("alerta de agente sin conexión", async ({ page }) => {
    const previous = psql(
      "select coalesce(last_heartbeat_at::text, '') from public.organizations where slug = 'demo-saint'",
    );
    try {
      psql(
        "update public.organizations set last_heartbeat_at = now() - interval '12 minutes' where slug = 'demo-saint'",
      );
      await demoAdmin(page);
      await expect(page.getByTestId("panel-alert").first()).toContainText(
        "El agente local no responde",
      );
      await shot(page, "06-alerta-agente");
    } finally {
      psql(
        `update public.organizations set last_heartbeat_at = ${
          previous ? `'${previous}'::timestamptz` : "null"
        } where slug = 'demo-saint'`,
      );
    }
  });
});
