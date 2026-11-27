import { execFileSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";

/** Usuarios del seed (contraseña común). */
export const USERS = {
  customer: "cliente@demo-saint.test", // comprador del cliente C00001 (lista Mayorista, -10 %)
  admin: "admin@demo-saint.test", // owner de demo-saint
  staff: "staff@demo-saint.test",
  otherOrgAdmin: "admin@demo-mock.test", // owner de demo-mock
} as const;
export const PASSWORD = "demo1234";

/** Pila local: la clave anon es pública por diseño (la de `supabase start`, sin secretos). */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
export const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
export const API_URL = "http://localhost:3001";
/** Organización demo-saint del seed. */
export const DEMO_ORG_ID = "b0000000-0000-4000-8000-00000000000a";

export async function login(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

export async function loginAndOpenCatalog(page: Page, email: string) {
  await login(page, email);
  await expect(page).toHaveURL(/\/catalogo$/);
}

/** Ejecuta SQL en la base de Supabase local (contenedor de `pnpm db:start`) y devuelve la salida sin formato. */
export function psql(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "supabase_db_erp-web-bridge",
      "psql",
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-t",
      "-A",
      "-q",
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  ).trim();
}
