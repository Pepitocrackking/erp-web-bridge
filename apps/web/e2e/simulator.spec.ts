import { expect, test, type Page } from "@playwright/test";
import { USERS, loginAndOpenCatalog } from "./helpers";

// Escenario del Gate 6: se edita el inventario del ERP simulado, se sincroniza de verdad y el
// catálogo web de OTRO navegador cambia en vivo, con la conversión Bs/USD incluida.
// P00001 en el seed: precio base $ 4,70 (Bs. 171,55 a 36,50), existencia 13.

async function openSimulator(page: Page, email: string) {
  await loginAndOpenCatalog(page, email);
  await page.goto("/admin/simulador");
  await expect(page.getByRole("heading", { name: "Simulador de ERP" })).toBeVisible();
  await expect(page.getByTestId("inventory-table")).toBeVisible();
}

async function searchSku(page: Page, sku: string) {
  await page.getByRole("searchbox", { name: "Buscar productos" }).fill(sku);
  await page.getByRole("button", { name: "Buscar" }).click();
}

async function syncChanges(page: Page) {
  await page.getByRole("button", { name: "Sincronizar con la nube" }).click();
  await expect(page.getByTestId("sync-result")).toContainText("Sincronización completa");
}

test.describe("simulador de ERP", () => {
  test("EN VIVO: editar precio y existencia en el simulador cambia el catálogo web sin recargar", async ({
    browser,
  }) => {
    const watcherCtx = await browser.newContext();
    const erpCtx = await browser.newContext();
    const watcher = await watcherCtx.newPage(); // personal viendo el catálogo (precio base)
    const buyerCtx = await browser.newContext();
    const buyer = await buyerCtx.newPage(); // comprador (ve existencias)
    const erp = await erpCtx.newPage();
    try {
      await loginAndOpenCatalog(watcher, USERS.staff);
      await searchSku(watcher, "P00001");
      const card = watcher.getByRole("article", { name: "Producto demo 1" });
      await expect(card.getByTestId("price-usd")).toHaveText("$ 4,70");
      await expect(card.getByTestId("price-bs")).toHaveText("Bs. 171,55");
      await expect(watcher.getByTestId("catalog-live")).toHaveAttribute("data-state", "live");

      await loginAndOpenCatalog(buyer, USERS.customer);
      await searchSku(buyer, "P00001");
      await expect(buyer.getByRole("article", { name: "Producto demo 1" })).toContainText(
        "Disponible",
      );
      await expect(buyer.getByTestId("catalog-live")).toHaveAttribute("data-state", "live");

      await openSimulator(erp, USERS.admin);
      await expect(erp.getByTestId("pending-changes")).toHaveText("Sin cambios pendientes");

      // Edita precio y existencia: queda marcado como pendiente.
      await erp.getByLabel("Precio de P00001").fill("5");
      await erp.getByLabel("Existencia de P00001").fill("3");
      await expect(erp.getByTestId("pending-changes")).toHaveText("1 cambio pendiente");
      await expect(erp.locator('tr[data-sku="P00001"]')).toHaveAttribute("data-changed", "true");

      await syncChanges(erp);
      await expect(erp.getByTestId("sync-result")).toContainText("1 actualizados");
      await expect(erp.getByTestId("pending-changes")).toHaveText("Sin cambios pendientes");

      // Sin recargar: el catálogo del personal muestra el precio nuevo en USD y en Bs (5 x 36,5 = 182,50)...
      await expect(card.getByTestId("price-usd")).toHaveText("$ 5,00", { timeout: 15_000 });
      await expect(card.getByTestId("price-bs")).toHaveText("Bs. 182,50");
      // ...y el del comprador, la existencia nueva.
      await expect(buyer.getByRole("article", { name: "Producto demo 1" })).toContainText(
        "Quedan 3",
        {
          timeout: 15_000,
        },
      );
    } finally {
      // Devuelve el inventario a su estado original.
      await erp.reload();
      await erp.getByLabel("Precio de P00001").fill("4.7");
      await erp.getByLabel("Existencia de P00001").fill("13");
      await erp.getByRole("button", { name: "Sincronizar con la nube" }).click();
      await expect(erp.getByTestId("sync-result")).toContainText("Sincronización completa");
      await watcherCtx.close();
      await buyerCtx.close();
      await erpCtx.close();
    }
  });

  test("sincronizar solo envía lo modificado y un producto nuevo aparece en el catálogo", async ({
    page,
  }) => {
    await openSimulator(page, USERS.admin);
    const sku = `SIM-${Date.now().toString(36)}`;
    await page.getByLabel("Código", { exact: true }).fill(sku);
    await page.getByLabel("Descripción", { exact: true }).fill("Producto del simulador");
    await page.getByLabel("Categoría", { exact: true }).fill("Pruebas");
    await page.getByLabel("Precio USD", { exact: true }).fill("2,50");
    await page.getByLabel("Existencia", { exact: true }).fill("20");
    await page.getByRole("button", { name: "Agregar", exact: true }).click();
    await expect(page.getByTestId("pending-changes")).toHaveText("1 cambio pendiente");

    await syncChanges(page);
    await expect(page.getByTestId("sync-result")).toContainText(
      "1 enviados, 1 nuevos, 0 actualizados",
    );

    await page.goto("/catalogo");
    await searchSku(page, sku);
    const card = page.getByRole("article", { name: "Producto del simulador" });
    await expect(card.getByTestId("price-usd")).toHaveText("$ 2,50");
    await expect(card.getByTestId("price-bs")).toHaveText("Bs. 91,25");
  });

  test("valida las filas antes de enviar", async ({ page }) => {
    await openSimulator(page, USERS.admin);
    await page.getByRole("button", { name: "Agregar", exact: true }).click();
    await expect(page.locator("section").getByRole("alert")).toBeVisible();
    await page.getByLabel("Precio de P00002").fill("-3");
    await expect(page.getByText("Hay filas con errores")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sincronizar con la nube" })).toBeDisabled();
  });

  test("solo los administradores de la organización demo usan el simulador", async ({ page }) => {
    await loginAndOpenCatalog(page, USERS.staff);
    await page.goto("/admin/simulador");
    await expect(page).toHaveURL(/\/catalogo$/);
    await page.getByRole("button", { name: "Salir" }).click();

    await loginAndOpenCatalog(page, USERS.otherOrgAdmin);
    await page.goto("/admin/simulador");
    await expect(
      page.getByText("solo está disponible en la organización de demostración"),
    ).toBeVisible();
    await page.goto("/admin");
    await expect(page.getByRole("link", { name: "Simulador de ERP" })).toHaveCount(0);
  });
});
