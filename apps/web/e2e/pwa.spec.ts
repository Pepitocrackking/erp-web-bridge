import { expect, test, type Page } from "@playwright/test";
import { USERS, loginAndOpenCatalog } from "./helpers";

/** Espera a que el service worker esté activo y controlando la página. */
async function serviceWorkerReady(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

/** Lee ancho y alto de un PNG a partir de su cabecera IHDR. */
function pngSize(png: Buffer) {
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test.describe("PWA instalable", () => {
  test("el manifiesto declara una app instalable con iconos reales", async ({ page, request }) => {
    await page.goto("/login");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      /manifest\.webmanifest/,
    );
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#047857");

    const res = await request.get("/manifest.webmanifest");
    expect(res.status()).toBe(200);
    const manifest = await res.json();
    expect(manifest).toMatchObject({
      short_name: "ERP Bridge",
      start_url: "/catalogo",
      scope: "/",
      display: "standalone",
      lang: "es",
    });
    expect(manifest.name).toBeTruthy();

    const purposes = (manifest.icons as { purpose: string }[]).map((i) => i.purpose);
    expect(purposes).toEqual(expect.arrayContaining(["any", "maskable"]));
    for (const icon of manifest.icons as { src: string; sizes: string; type: string }[]) {
      const img = await request.get(icon.src);
      expect(img.status(), icon.src).toBe(200);
      expect(img.headers()["content-type"]).toContain("image/png");
      const { width, height } = pngSize(await img.body());
      expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
    }
  });

  test("Chrome la considera instalable (sin errores de instalabilidad)", async ({
    page,
    context,
  }) => {
    await page.goto("/login");
    await serviceWorkerReady(page);
    const client = await context.newCDPSession(page);
    const { installabilityErrors } = await client.send("Page.getInstallabilityErrors");
    expect(installabilityErrors).toEqual([]);
  });

  test("el service worker queda activo con alcance en toda la app y sin caché del navegador", async ({
    page,
    request,
  }) => {
    await page.goto("/login");
    await serviceWorkerReady(page);
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toMatch(/\/$/);
    const sw = await request.get("/sw.js");
    expect(sw.headers()["cache-control"]).toContain("no-cache");
    expect(sw.headers()["service-worker-allowed"]).toBe("/");
  });
});

test.describe("catálogo sin conexión", () => {
  test("lo ya visitado se ve sin red, con aviso; lo no visitado muestra la página sin conexión", async ({
    page,
    context,
  }) => {
    await page.goto("/login");
    await serviceWorkerReady(page);
    await loginAndOpenCatalog(page, USERS.customer);

    // Visitas de documento (las que guarda el service worker): el catálogo y una búsqueda.
    await page.goto("/catalogo");
    await page.getByRole("searchbox", { name: "Buscar productos" }).fill("P00001");
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect(page.getByRole("article", { name: "Producto demo 1" })).toBeVisible();
    await expect(page.getByTestId("price-usd")).toHaveText("$ 4,23");
    // Dale un momento al service worker para terminar de guardar la última respuesta.
    await page.waitForTimeout(500);

    await context.setOffline(true);
    try {
      const cached = await page.goto("/catalogo?q=P00001");
      expect(cached?.headers()["x-erpwb-cache"]).toBe("hit");
      await expect(page.getByRole("article", { name: "Producto demo 1" })).toBeVisible();
      await expect(page.getByTestId("price-usd")).toHaveText("$ 4,23");
      await expect(page.getByTestId("price-bs")).toContainText("Bs.");
      await expect(page.getByTestId("offline-banner")).toContainText("Sin conexión");

      // Una búsqueda que nunca se abrió no se inventa: página sin conexión.
      await page.goto("/catalogo?q=nunca-visitada");
      await expect(page.getByRole("heading", { name: "Sin conexión" })).toBeVisible();
      await page.goto("/carrito");
      await expect(page.getByRole("heading", { name: "Sin conexión" })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }

    // Con red vuelve a mostrar lo de ahora y el aviso desaparece.
    await page.goto("/catalogo?q=P00001");
    await expect(page.getByTestId("offline-banner")).toHaveCount(0);
  });

  test("PRIVACIDAD: al cerrar sesión el catálogo guardado se borra", async ({ page, context }) => {
    await page.goto("/login");
    await serviceWorkerReady(page);
    await loginAndOpenCatalog(page, USERS.customer);
    await page.goto("/catalogo");
    await expect(page.getByTestId("rate")).toBeVisible();
    await page.waitForTimeout(500);

    await page.getByRole("button", { name: "Salir" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await context.setOffline(true);
    try {
      await page.goto("/catalogo");
      // Nada de la sesión anterior: ni precios ni catálogo, solo la página sin conexión.
      await expect(page.getByRole("heading", { name: "Sin conexión" })).toBeVisible();
      await expect(page.getByTestId("price-usd")).toHaveCount(0);
    } finally {
      await context.setOffline(false);
    }
  });

  test("PRIVACIDAD: otra persona que entra por /login no ve el catálogo de la anterior", async ({
    page,
    context,
  }) => {
    await page.goto("/login");
    await serviceWorkerReady(page);
    await loginAndOpenCatalog(page, USERS.customer);
    await page.goto("/catalogo");
    await expect(page.getByTestId("rate")).toBeVisible();
    await page.waitForTimeout(500);

    // La sesión se cierra "por fuera" (cookies borradas) y otra persona abre la pantalla de entrada.
    await context.clearCookies();
    await page.goto("/login");

    await context.setOffline(true);
    try {
      await page.goto("/catalogo");
      await expect(page.getByRole("heading", { name: "Sin conexión" })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test("un visitante sin sesión nunca recibe un catálogo guardado", async ({ page }) => {
    await page.goto("/login");
    await serviceWorkerReady(page);
    const response = await page.goto("/catalogo"); // sin sesión: redirige a /login
    expect(response?.headers()["x-erpwb-cache"]).toBeUndefined();
    await expect(page).toHaveURL(/\/login$/);
  });
});
