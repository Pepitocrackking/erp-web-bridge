import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { productSyncHash } from "../lib/sync-hash";
import {
  ANON_KEY,
  API_URL,
  DEMO_ORG_ID,
  PASSWORD,
  SUPABASE_URL,
  USERS,
  loginAndOpenCatalog,
} from "./helpers";

// Clave de agente del seed (organización demo-saint): la usa el agente Go real.
const AGENT_KEY = "erp_dev_demo_saint_key";

async function openPanel(page: Page, email: string) {
  await loginAndOpenCatalog(page, email);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Panel de administración" })).toBeVisible();
  // Realtime está suscrito: a partir de aquí los cambios llegan sin recargar.
  await expect(page.getByTestId("live-status")).toHaveText("En vivo");
}

async function setRate(page: Page, value: string) {
  await page.getByLabel("Nueva tasa (Bs por USD)").fill(value);
  await page.getByRole("button", { name: "Fijar tasa" }).click();
}

test.describe("panel de administración", () => {
  test("muestra el estado de sincronización, clientes, pedidos y bitácora del seed", async ({
    page,
  }) => {
    await openPanel(page, USERS.admin);
    await expect(page.getByTestId("current-rate")).toContainText("Bs.");
    await expect(page.getByTestId("agent-status")).toBeVisible();
    await expect(page.getByTestId("last-sync")).not.toHaveText("—");

    // Clientes del seed con su crédito: C00001 $ 5.000,00 de límite y $ 1.200,50 de deuda.
    const c1 = page.getByTestId("customers-table").getByRole("row", { name: /C00001/ });
    await expect(c1).toContainText("$ 5.000,00");
    await expect(c1).toContainText("$ 1.200,50");
    await expect(c1).toContainText("$ 3.799,50");
    await expect(page.getByTestId("customers-count")).toHaveText("5 clientes");

    // Pedidos del seed: uno pendiente y uno ya enviado al ERP con su referencia.
    const orders = page.getByTestId("orders-table");
    // (puede haber más pendientes si se corrió la suite sin `pnpm db:reset`)
    await expect(
      orders.getByRole("row", { name: /Pendiente de enviar al ERP/ }).first(),
    ).toBeVisible();
    await expect(orders.getByRole("row", { name: /Enviado al ERP.*PED-000123/ })).toBeVisible();
    await expect(page.getByTestId("sync-log")).toContainText("Productos");
  });

  test("la tasa se cambia desde el panel y el catálogo la usa", async ({ page }) => {
    await openPanel(page, USERS.admin);
    try {
      await setRate(page, "40,25");
      await expect(page.getByRole("status").filter({ hasText: "Tasa actualizada" })).toHaveText(
        "Tasa actualizada a Bs. 40,25.",
      );
      await expect(page.getByTestId("current-rate")).toHaveText("Bs. 40,25");
      await expect(page.getByTestId("rate-history").locator("li").first()).toContainText(
        "Bs. 40,25",
      );

      await page.goto("/catalogo");
      await expect(page.getByTestId("rate")).toHaveText("Tasa del día: Bs. 40,25 por USD");
    } finally {
      await page.goto("/admin");
      await setRate(page, "36,5");
      await expect(page.getByTestId("current-rate")).toHaveText("Bs. 36,50");
    }
  });

  test("una tasa inválida se rechaza sin llamar a la API", async ({ page }) => {
    await openPanel(page, USERS.admin);
    await setRate(page, "-5");
    await expect(page.locator("form").getByRole("alert")).toContainText("tasa válida");
    await expect(page.getByTestId("current-rate")).toHaveText("Bs. 36,50");
  });

  test("EN VIVO: un segundo administrador ve el cambio de tasa sin recargar", async ({
    browser,
  }) => {
    const watcherCtx = await browser.newContext();
    const actorCtx = await browser.newContext();
    const watcher = await watcherCtx.newPage();
    const actor = await actorCtx.newPage();
    try {
      await openPanel(watcher, USERS.staff); // el personal solo mira
      await expect(watcher.getByTestId("current-rate")).toHaveText("Bs. 36,50");
      await openPanel(actor, USERS.admin);

      await setRate(actor, "41,10");
      await expect(actor.getByTestId("current-rate")).toHaveText("Bs. 41,10");
      // El observador no recargó: llega por Realtime.
      await expect(watcher.getByTestId("current-rate")).toHaveText("Bs. 41,10", {
        timeout: 15_000,
      });
    } finally {
      await setRate(actor, "36,5");
      await expect(actor.getByTestId("current-rate")).toHaveText("Bs. 36,50");
      await watcherCtx.close();
      await actorCtx.close();
    }
  });

  test("EN VIVO: una sincronización del agente aparece en la bitácora sin recargar", async ({
    page,
    request,
  }) => {
    await openPanel(page, USERS.admin);
    const before = await page.getByTestId("sync-log").locator("li").count();

    const sku = `E2E-${randomUUID().slice(0, 8)}`;
    const product = { sku, name: `Producto E2E ${sku}`, price_usd: 1.5, stock: 7 };
    const res = await request.post(`${API_URL}/v1/sync/products`, {
      headers: { "x-api-key": AGENT_KEY },
      data: {
        kind: "products",
        batch_id: randomUUID(),
        sent_at: new Date().toISOString(),
        full_reconciliation: false,
        records: [
          { ...product, category: "Pruebas", active: true, sync_hash: productSyncHash(product) },
        ],
      },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).inserted).toBe(1);

    await expect(page.getByTestId("sync-log").locator("li")).toHaveCount(before + 1, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("sync-log").locator("li").first()).toContainText("Productos");
    await expect(page.getByTestId("sync-log").locator("li").first()).toContainText("1 registros");
  });

  test("EN VIVO: un pedido nuevo del comprador aparece en el panel sin recargar", async ({
    page,
    request,
  }) => {
    await openPanel(page, USERS.admin);
    const pendingBefore = Number(await page.getByTestId("pending-orders").textContent());
    const rowsBefore = await page.getByTestId("orders-table").locator("tbody tr").count();

    // El comprador crea un pedido por la API real con su JWT.
    const auth = await request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      headers: { apikey: ANON_KEY },
      data: { email: USERS.customer, password: PASSWORD },
    });
    const token = (await auth.json()).access_token as string;
    const order = await request.post(`${API_URL}/v1/orgs/${DEMO_ORG_ID}/orders`, {
      headers: { authorization: `Bearer ${token}` },
      data: { items: [{ sku: "P00001", quantity: 2 }] },
    });
    expect(order.status()).toBe(201);
    const id = (await order.json()).id as string;

    const row = page.locator(`tr[data-order-id="${id}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("Abastos La Esquina C.A.");
    await expect(row).toContainText("Pendiente de enviar al ERP");
    await expect(row).toContainText("$ 8,46"); // 2 x 4,23 (lista Mayorista)
    await expect(page.getByTestId("orders-table").locator("tbody tr")).toHaveCount(rowsBefore + 1);
    await expect(page.getByTestId("pending-orders")).toHaveText(String(pendingBefore + 1));
  });

  test("EN VIVO: un pedido que el ERP rechaza muestra su motivo y el personal lo reintenta", async ({
    page,
    request,
  }) => {
    await openPanel(page, USERS.admin);

    const auth = await request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      headers: { apikey: ANON_KEY },
      data: { email: USERS.customer, password: PASSWORD },
    });
    const token = (await auth.json()).access_token as string;
    const created = await request.post(`${API_URL}/v1/orgs/${DEMO_ORG_ID}/orders`, {
      headers: { authorization: `Bearer ${token}` },
      data: { items: [{ sku: "P00001", quantity: 1 }] },
    });
    expect(created.status()).toBe(201);
    const id = (await created.json()).id as string;

    const row = page.locator(`tr[data-order-id="${id}"]`);
    await expect(row.getByTestId("order-status")).toHaveText("Pendiente de enviar al ERP", {
      timeout: 15_000,
    });
    await expect(row.getByTestId("order-error")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Reintentar" })).toHaveCount(0);

    // El agente informa que el ERP no puede aceptar el pedido (lo que hace el binario real).
    const reason = 'El cliente "C00001" no existe en el ERP';
    const failed = await request.post(`${API_URL}/v1/orders/${id}/fail`, {
      headers: { "x-api-key": AGENT_KEY },
      data: { error_detail: reason },
    });
    expect(failed.status()).toBe(200);

    // Sin recargar: el estado cambia y el panel muestra el motivo y el botón.
    await expect(row.getByTestId("order-status")).toHaveText("Error", { timeout: 15_000 });
    await expect(row.getByTestId("order-error")).toHaveText(`Motivo: ${reason}`);
    await expect(row.getByRole("button", { name: "Reintentar" })).toBeVisible();

    // El personal lo reintenta: vuelve a la cola y desaparecen el motivo y el botón.
    await row.getByRole("button", { name: "Reintentar" }).click();
    await expect(row.getByTestId("order-status")).toHaveText("Pendiente de enviar al ERP", {
      timeout: 15_000,
    });
    await expect(row.getByTestId("order-error")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Reintentar" })).toHaveCount(0);

    // Lo recoge el agente: queda enviado al ERP con su referencia (y deja de contar como pendiente).
    const reference = `E2E-${randomUUID().slice(0, 8)}`;
    const confirmed = await request.post(`${API_URL}/v1/orders/${id}/confirm`, {
      headers: { "x-api-key": AGENT_KEY },
      data: { erp_order_reference: reference },
    });
    expect(confirmed.status()).toBe(200);
    await expect(row.getByTestId("order-status")).toHaveText("Enviado al ERP", { timeout: 15_000 });
    await expect(row.getByTestId("order-ref")).toHaveText(reference);
    await expect(row.getByTestId("order-error")).toHaveCount(0);
  });

  test("el personal no administrador ve el panel pero no puede cambiar la tasa; el comprador no entra", async ({
    page,
  }) => {
    await openPanel(page, USERS.staff);
    await expect(page.getByText("Solo un administrador puede cambiar la tasa.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Fijar tasa" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Solicitudes de acceso" })).toHaveCount(0);

    await page.getByRole("button", { name: "Salir" }).click();
    await loginAndOpenCatalog(page, USERS.customer);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/catalogo$/);
  });

  test("un admin de otra empresa solo ve sus propios datos", async ({ page }) => {
    await openPanel(page, USERS.otherOrgAdmin);
    await expect(page.getByTestId("customers-count")).toHaveText("2 clientes");
    await expect(page.getByTestId("customers-table")).not.toContainText("Abastos La Esquina");
    await expect(page.getByTestId("orders-table")).toHaveCount(0); // demo-mock no tiene pedidos
  });
});
