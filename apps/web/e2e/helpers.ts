import { expect, type Page } from "@playwright/test";

/** Usuarios del seed (contraseña común). */
export const USERS = {
  customer: "cliente@demo-saint.test", // comprador del cliente C00001 (lista Mayorista, -10 %)
  admin: "admin@demo-saint.test", // owner de demo-saint
  staff: "staff@demo-saint.test",
  otherOrgAdmin: "admin@demo-mock.test", // owner de demo-mock
} as const;
export const PASSWORD = "demo1234";

export async function login(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

export async function loginAndOpenCatalog(page: Page, email: string) {
  await login(page, email);
  await expect(page).toHaveURL(/\/catalogo$/);
}
