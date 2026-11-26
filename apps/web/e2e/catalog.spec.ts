import { expect, test } from "@playwright/test";
import { USERS, login, loginAndOpenCatalog } from "./helpers";

// Datos del seed (demo-saint, tasa 36,50): P00001 cuesta $ 4,70 en la lista base y $ 4,23 en la
// lista Mayorista del cliente C00001 (-10 %). 4,23 x 36,5 = 154,395 -> Bs. 154,40.

test.describe("acceso", () => {
  test("sin sesión, /catalogo manda al login", async ({ page }) => {
    await page.goto("/catalogo");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("una contraseña incorrecta no entra y muestra el error", async ({ page }) => {
    await login(page, USERS.customer, "mala-clave");
    // Next añade su propio role="alert" (anunciador de rutas): se acota al mensaje del formulario.
    await expect(page.locator("form").getByRole("alert")).toHaveText(
      "Correo o contraseña incorrectos.",
    );
    await expect(page).toHaveURL(/\/login$/);
  });

  test("salir cierra la sesión", async ({ page }) => {
    await loginAndOpenCatalog(page, USERS.customer);
    await page.getByRole("button", { name: "Salir" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/catalogo");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("catálogo", () => {
  test("el comprador ve su precio de lista en USD y en Bs con la tasa vigente", async ({
    page,
  }) => {
    await loginAndOpenCatalog(page, USERS.customer);
    await expect(page.getByTestId("rate")).toHaveText("Tasa del día: Bs. 36,50 por USD");

    await page.getByRole("searchbox", { name: "Buscar productos" }).fill("P00001");
    await page.getByRole("button", { name: "Buscar" }).click();
    const card = page.getByRole("article", { name: "Producto demo 1" });
    await expect(card.getByTestId("price-usd")).toHaveText("$ 4,23");
    await expect(card.getByTestId("price-bs")).toHaveText("Bs. 154,40");
    await expect(page.getByTestId("result-count")).toHaveText("1 producto");
  });

  test("el personal ve el precio base", async ({ page }) => {
    await loginAndOpenCatalog(page, USERS.admin);
    await page.getByRole("searchbox", { name: "Buscar productos" }).fill("P00001");
    await page.getByRole("button", { name: "Buscar" }).click();
    const card = page.getByRole("article", { name: "Producto demo 1" });
    await expect(card.getByTestId("price-usd")).toHaveText("$ 4,70");
    await expect(card.getByTestId("price-bs")).toHaveText("Bs. 171,55");
  });

  test("busca por nombre y sin resultados lo dice", async ({ page }) => {
    await loginAndOpenCatalog(page, USERS.customer);
    const box = page.getByRole("searchbox", { name: "Buscar productos" });
    await box.fill("demo 2");
    await page.getByRole("button", { name: "Buscar" }).click();
    // Producto demo 2, 20 (inactivo, oculto), 21..29: solo los activos.
    await expect(page.getByRole("article", { name: "Producto demo 2", exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "Producto demo 20" })).toHaveCount(0);

    await box.fill("zzz-no-existe");
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect(page.getByText("No hay productos que coincidan con la búsqueda.")).toBeVisible();
  });

  test("caracteres especiales en la búsqueda no rompen la página", async ({ page }) => {
    await loginAndOpenCatalog(page, USERS.customer);
    await page.getByRole("searchbox", { name: "Buscar productos" }).fill('a,b)(%_"\\');
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect(page.getByTestId("result-count")).toBeVisible();
  });

  test("filtra por categoría y el contador coincide con el total", async ({ page }) => {
    await loginAndOpenCatalog(page, USERS.customer);
    const chip = page.getByRole("link", { name: /^Bebidas \(\d+\)$/ });
    const count = Number((await chip.textContent())!.match(/\((\d+)\)/)![1]);
    await chip.click();
    await expect(page).toHaveURL(/category=Bebidas/);
    await expect(page.getByTestId("result-count")).toHaveText(
      count === 1 ? "1 producto" : `${count} productos`,
    );
    await expect(chip).toHaveAttribute("aria-current", "page");
  });

  test("el comprador no ve productos inactivos y el personal tampoco en el catálogo", async ({
    page,
  }) => {
    await loginAndOpenCatalog(page, USERS.staff);
    await page.getByRole("searchbox", { name: "Buscar productos" }).fill("P00010");
    await page.getByRole("button", { name: "Buscar" }).click(); // P00010 está inactivo
    await expect(page.getByText("No hay productos que coincidan con la búsqueda.")).toBeVisible();
  });

  test("aislamiento entre empresas: cada usuario ve solo su catálogo", async ({ page }) => {
    await loginAndOpenCatalog(page, USERS.otherOrgAdmin);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Comercial Beta");
    await expect(page.getByRole("article", { name: /^Artículo beta/ }).first()).toBeVisible();
    await expect(page.getByRole("article", { name: /^Producto demo/ })).toHaveCount(0);
  });

  test("la paginación reparte los productos activos en páginas de 24", async ({ page }) => {
    // demo-saint tiene 30 productos y 3 inactivos: 27 visibles = 24 + 3.
    await loginAndOpenCatalog(page, USERS.customer);
    await expect(page.getByTestId("result-count")).toHaveText("27 productos");
    await expect(page.getByRole("article")).toHaveCount(24);
    await expect(page.getByText("Página 1 de 2")).toBeVisible();
    await page.getByRole("link", { name: "Siguiente →" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByRole("article")).toHaveCount(3);
    await expect(page.getByText("Página 2 de 2")).toBeVisible();
  });

  test("una empresa con pocos productos no muestra paginación", async ({ page }) => {
    await loginAndOpenCatalog(page, USERS.otherOrgAdmin);
    await expect(page.getByRole("navigation", { name: "Paginación" })).toHaveCount(0);
  });
});
