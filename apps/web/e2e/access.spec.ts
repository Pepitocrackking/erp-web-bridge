import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, USERS, login, loginAndOpenCatalog } from "./helpers";

// Cada ejecución crea usuarios nuevos (correo único): `pnpm db:reset` los limpia.
const uniqueEmail = (tag: string) =>
  `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.test`;

async function register(page: Page, email: string) {
  await page.goto("/registro");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel(/^Contraseña/).fill(PASSWORD);
  await page.getByRole("button", { name: "Crear cuenta" }).click();
  await expect(page).toHaveURL(/\/acceso/);
}

async function askAccess(page: Page, empresa: string, taxId: string, name = "") {
  await page.getByLabel("Código de la empresa").fill(empresa);
  await page.getByLabel(/^RIF o cédula/).fill(taxId);
  if (name) await page.getByLabel(/^Razón social/).fill(name);
  await page.getByRole("button", { name: "Solicitar acceso" }).click();
}

async function logout(page: Page) {
  await page.getByRole("button", { name: "Salir" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

/** La tarjeta de la solicitud de ese correo en el panel del admin. */
const requestCard = (page: Page, email: string) => page.getByRole("listitem", { name: email });

async function openRequests(page: Page) {
  await page.goto("/admin/solicitudes");
  await expect(page.getByRole("heading", { name: "Solicitudes de acceso" })).toBeVisible();
}

test.describe("registro y aprobación de compradores", () => {
  test("flujo completo: registro, solicitud, aprobación por RIF y acceso a su precio", async ({
    page,
  }) => {
    const email = uniqueEmail("rif");
    await register(page, email);
    await askAccess(page, "demo-saint", "j-30000002-2", "Bodegón El Progreso");
    await expect(page.getByText("Pendiente de aprobación")).toBeVisible();
    await expect(
      page.getByText("El administrador de Distribuidora Demo debe aprobarla"),
    ).toBeVisible();

    // Pendiente: no ve el catálogo.
    await page.goto("/catalogo");
    await expect(page).toHaveURL(/\/acceso$/);
    await logout(page);

    // El admin la aprueba: el cliente se sugiere solo porque el RIF coincide.
    await loginAndOpenCatalog(page, USERS.admin);
    await openRequests(page);
    const card = requestCard(page, email);
    await expect(card).toContainText("RIF: j-30000002-2");
    await expect(card.getByLabel("Cliente del ERP")).toHaveValue(/.+/);
    await card.getByRole("button", { name: "Aprobar" }).click();
    await expect(page.getByRole("status")).toHaveText("Solicitud aprobada.");
    await expect(requestCard(page, email)).toHaveCount(0);
    await logout(page);

    // Ya como comprador: ve el catálogo con el precio de su lista (Mayorista, -10 %).
    await login(page, email);
    await expect(page).toHaveURL(/\/catalogo$/);
    await page.getByRole("searchbox", { name: "Buscar productos" }).fill("P00001");
    await page.getByRole("button", { name: "Buscar" }).click();
    const product = page.getByRole("article", { name: "Producto demo 1" });
    await expect(product.getByTestId("price-usd")).toHaveText("$ 4,23");
    // Un comprador no administra accesos.
    await page.goto("/admin/solicitudes");
    await expect(page).toHaveURL(/\/catalogo$/);
  });

  test("con un RIF desconocido el admin debe elegir el cliente", async ({ page }) => {
    const email = uniqueEmail("sinrif");
    await register(page, email);
    await askAccess(page, "demo-saint", "J-99999999-9");
    await logout(page);

    await loginAndOpenCatalog(page, USERS.admin);
    await openRequests(page);
    const card = requestCard(page, email);
    await expect(card).toContainText("Ningún cliente tiene este RIF");
    // Sin elegir cliente, aprobar por RIF falla con un mensaje claro y no aprueba nada.
    await card.getByRole("button", { name: "Aprobar" }).click();
    await expect(requestCard(page, email).getByRole("alert")).toContainText(
      "Ningún cliente tiene ese RIF",
    );

    // Elige al cliente C00004 (lista Distribuidor, -18 %).
    await requestCard(page, email)
      .getByLabel("Cliente del ERP")
      .selectOption({ label: "C00004 · Mayorista Oriente S.A. · J-30000004-4" });
    await requestCard(page, email).getByRole("button", { name: "Aprobar" }).click();
    await expect(page.getByRole("status")).toHaveText("Solicitud aprobada.");
    await logout(page);

    await login(page, email);
    await page.getByRole("searchbox", { name: "Buscar productos" }).fill("P00001");
    await page.getByRole("button", { name: "Buscar" }).click();
    const product = page.getByRole("article", { name: "Producto demo 1" });
    await expect(product.getByTestId("price-usd")).toHaveText("$ 3,85");
    await expect(product.getByTestId("price-bs")).toHaveText("Bs. 140,53");
  });

  test("rechazar muestra el motivo al solicitante y le deja pedirlo de nuevo", async ({ page }) => {
    const email = uniqueEmail("rechazo");
    await register(page, email);
    await askAccess(page, "demo-saint", "J-11111111-1");
    await logout(page);

    await loginAndOpenCatalog(page, USERS.admin);
    await openRequests(page);
    await requestCard(page, email).getByLabel("Motivo (opcional)").fill("No te conocemos");
    await requestCard(page, email).getByRole("button", { name: "Rechazar" }).click();
    await expect(page.getByRole("status")).toHaveText("Solicitud rechazada.");
    await logout(page);

    await login(page, email);
    await expect(page).toHaveURL(/\/acceso$/);
    await expect(page.getByText("Rechazada")).toBeVisible();
    await expect(page.getByText(/Motivo: No te conocemos/)).toBeVisible();

    // Corrige el RIF y vuelve a pedirlo: la solicitud queda pendiente otra vez.
    await askAccess(page, "demo-saint", "J-30000001-1");
    await expect(page.getByText("Pendiente de aprobación")).toBeVisible();
    await expect(page.getByText("Rechazada")).toHaveCount(0);
  });

  test("pedir acceso a una empresa que no existe da un error claro", async ({ page }) => {
    await register(page, uniqueEmail("noexiste"));
    await askAccess(page, "empresa-fantasma", "J-30000001-1");
    await expect(page.locator("form").getByRole("alert")).toHaveText(
      "No existe una empresa con ese código.",
    );
  });

  test("el admin de otra empresa no ve las solicitudes ajenas", async ({ page }) => {
    const email = uniqueEmail("ajena");
    await register(page, email);
    await askAccess(page, "demo-saint", "J-30000001-1");
    await logout(page);

    await loginAndOpenCatalog(page, USERS.otherOrgAdmin);
    await openRequests(page);
    await expect(requestCard(page, email)).toHaveCount(0);
  });

  test("el personal sin rol de administrador no entra al panel de solicitudes", async ({
    page,
  }) => {
    await loginAndOpenCatalog(page, USERS.staff);
    await page.goto("/admin/solicitudes");
    await expect(page).toHaveURL(/\/catalogo$/);
  });

  test("las contraseñas cortas se rechazan al registrarse", async ({ page }) => {
    await page.goto("/registro");
    await page.getByLabel("Correo").fill(uniqueEmail("corta"));
    await page.getByLabel(/^Contraseña/).fill("123");
    await page.getByRole("button", { name: "Crear cuenta" }).click();
    // minLength del navegador lo frena antes de llegar al servidor.
    await expect(page).toHaveURL(/\/registro$/);
  });
});
