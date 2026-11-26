import { expect, test, type Page } from "@playwright/test";
import {
  ANON_KEY,
  API_URL,
  DEMO_ORG_ID,
  PASSWORD,
  SUPABASE_URL,
  USERS,
  loginAndOpenCatalog,
} from "./helpers";

// Comprador del seed: cliente C00001 (lista Mayorista, -10 %), límite $ 5.000, deuda $ 1.200,50 y un
// pedido pendiente de $ 25 -> crédito disponible inicial $ 3.774,50 (baja con cada pedido que se haga).
// P00001 cuesta $ 4,23 en su lista (Bs. 154,40 con la tasa 36,50).

async function addToCart(page: Page, sku: string, name: string, quantity: number) {
  await page.getByRole("searchbox", { name: "Buscar productos" }).fill(sku);
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page.getByRole("article", { name })).toBeVisible();
  // Si la lista de resultados se vuelve a pintar mientras se escribe, la cantidad vuelve a 1 y el
  // clic agregaría la cantidad equivocada: se reescribe hasta que el valor se mantenga.
  const input = page.getByLabel(`Cantidad de ${name}`);
  await expect(async () => {
    await input.fill(String(quantity));
    await expect(input).toHaveValue(String(quantity), { timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await page.getByRole("button", { name: `Agregar ${name} al carrito` }).click();
}

async function openCart(page: Page) {
  await page.getByRole("link", { name: /^Carrito/ }).click();
  await expect(page.getByRole("heading", { name: "Tu carrito" })).toBeVisible();
}

const money = (text: string | null) =>
  Number((text ?? "").replace(/[^\d,-]/g, "").replace(",", "."));

test.describe("carrito y pedidos", () => {
  test("agrega, cambia cantidades, calcula en USD y Bs y quita líneas", async ({ page }) => {
    await loginAndOpenCatalog(page, USERS.customer);
    await expect(page.getByTestId("cart-count")).toHaveText("(0)");
    await addToCart(page, "P00001", "Producto demo 1", 10);
    await expect(page.getByTestId("cart-count")).toHaveText("(1)");
    await addToCart(page, "P00002", "Producto demo 2", 2);
    await expect(page.getByTestId("cart-count")).toHaveText("(2)");
    await openCart(page);

    // 10 x 4,23 = 42,30
    await expect(page.getByTestId("line-usd-P00001")).toHaveText("$ 42,30");
    const total = money(await page.getByTestId("total-usd").textContent());
    const bs = money(await page.getByTestId("total-bs").textContent());
    expect(total).toBeGreaterThan(42.3);
    expect(bs).toBeCloseTo(total * 36.5, 1);

    // Cambiar la cantidad recalcula; sale al perder el foco.
    await page.getByLabel("Cantidad de Producto demo 1").fill("20");
    await page.getByLabel("Cantidad de Producto demo 1").blur();
    await expect(page.getByTestId("line-usd-P00001")).toHaveText("$ 84,60");

    await page.getByRole("button", { name: "Quitar Producto demo 2" }).click();
    await expect(page.getByTestId("line-P00002")).toHaveCount(0);
    await expect(page.getByTestId("total-usd")).toHaveText("$ 84,60");

    // El carrito sobrevive a recargar la página.
    await page.reload();
    await expect(page.getByTestId("line-usd-P00001")).toHaveText("$ 84,60");

    await page.getByRole("button", { name: "Vaciar carrito" }).click();
    await expect(page.getByText("Tu carrito está vacío.")).toBeVisible();
  });

  test("un pedido dentro del crédito se crea y descuenta del crédito disponible", async ({
    page,
  }) => {
    await loginAndOpenCatalog(page, USERS.customer);
    await addToCart(page, "P00001", "Producto demo 1", 10);
    await openCart(page);
    await expect(page.getByTestId("total-usd")).toHaveText("$ 42,30");
    const before = money(await page.getByTestId("credit-available").textContent());

    await page.getByLabel(/^Notas para el proveedor/).fill("Entregar por la tarde");
    await page.getByRole("button", { name: "Confirmar pedido" }).click();
    await expect(page.getByRole("heading", { name: "Pedido recibido" })).toBeVisible();
    await expect(page.getByTestId("placed-total")).toHaveText("Total: $ 42,30 · Bs. 1.543,95");
    await expect(page.getByTestId("placed-id")).toHaveText(/^[0-9a-f]{8}$/);

    // El carrito quedó vacío y el crédito disponible bajó exactamente el total del pedido.
    await page.goto("/catalogo");
    await expect(page.getByTestId("cart-count")).toHaveText("(0)");
    await addToCart(page, "P00001", "Producto demo 1", 1);
    await openCart(page);
    const after = money(await page.getByTestId("credit-available").textContent());
    expect(after).toBeCloseTo(before - 42.3, 2);
  });

  test("un pedido que supera el límite de crédito no se puede enviar", async ({ page }) => {
    await loginAndOpenCatalog(page, USERS.customer);
    // 20.000 x 4,23 = 84.600: muy por encima de cualquier crédito disponible de este cliente.
    await addToCart(page, "P00001", "Producto demo 1", 20000);
    await openCart(page);
    await expect(page.getByTestId("over-credit")).toContainText("supera tu crédito disponible");
    await expect(page.getByRole("button", { name: "Confirmar pedido" })).toBeDisabled();
  });

  test("la API rechaza con 422 un pedido que supera el crédito y no crea nada", async ({
    request,
  }) => {
    const auth = await request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      headers: { apikey: ANON_KEY },
      data: { email: USERS.customer, password: PASSWORD },
    });
    expect(auth.ok()).toBeTruthy();
    const token = (await auth.json()).access_token as string;
    const headers = { authorization: `Bearer ${token}`, apikey: ANON_KEY };
    const countOrders = async () =>
      (
        await (
          await request.get(`${SUPABASE_URL}/rest/v1/web_orders?select=id`, { headers })
        ).json()
      ).length;
    const before = await countOrders();

    const res = await request.post(`${API_URL}/v1/orgs/${DEMO_ORG_ID}/orders`, {
      headers,
      data: { items: [{ sku: "P00001", quantity: 20000 }] },
    });
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("credit_limit_exceeded");
    expect(body.order_total_usd).toBeGreaterThan(body.available_usd);
    expect(body.credit_limit_usd).toBe(5000);
    expect(await countOrders()).toBe(before);

    // El cuerpo solo admite SKU y cantidad: un precio inventado se rechaza.
    const tampered = await request.post(`${API_URL}/v1/orgs/${DEMO_ORG_ID}/orders`, {
      headers,
      data: { items: [{ sku: "P00001", quantity: 1, unit_price_usd: 0.01 }] },
    });
    expect(tampered.status()).toBe(400);
    expect(await countOrders()).toBe(before);
  });

  test("el personal no tiene carrito", async ({ page }) => {
    await loginAndOpenCatalog(page, USERS.admin);
    await expect(page.getByRole("link", { name: /^Carrito/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Agregar/ }).first()).toHaveCount(0);
    await page.goto("/carrito");
    await expect(page).toHaveURL(/\/catalogo$/);
  });
});
