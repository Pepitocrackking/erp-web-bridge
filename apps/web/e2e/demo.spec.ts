import { expect, test } from "@playwright/test";

// Playwright arranca la web con DEMO_MODE=true (ver playwright.config.ts).

test.describe("modo demo", () => {
  test("un clic entra al panel como administrador, sin registro", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Entrar como Administrador Demo" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "Panel de administración" })).toBeVisible();
    await expect(page.getByText("Distribuidora Demo")).toBeVisible();
    // Es administrador de verdad: puede cambiar la tasa y ver las solicitudes de acceso.
    await expect(page.getByRole("button", { name: "Fijar tasa" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Solicitudes de acceso" })).toBeVisible();
  });

  test("la sesión demo se puede cerrar y el botón sigue disponible", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Entrar como Administrador Demo" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.getByRole("button", { name: "Salir" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole("button", { name: "Entrar como Administrador Demo" }),
    ).toBeVisible();
  });
});
