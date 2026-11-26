import { defineConfig, devices } from "@playwright/test";

/**
 * E2E contra la pila local real: `pnpm db:start` (Supabase completo) y `pnpm db:reset` (seed)
 * antes de correr `pnpm --filter @erp-web-bridge/web e2e`. Playwright compila y levanta la web.
 * No corren en el CI (necesitan PostgREST y Realtime); ver docs/evidence/phase-6.md.
 */
const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  // Comparten una base real: en serie para que un test no pise los datos de otro.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", locale: "es-VE" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm build && pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
