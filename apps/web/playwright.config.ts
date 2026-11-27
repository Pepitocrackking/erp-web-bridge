import { defineConfig, devices } from "@playwright/test";

/**
 * E2E contra la pila local real: `pnpm db:start` (Supabase completo) y `pnpm db:reset` (seed)
 * antes de correr `pnpm --filter @erp-web-bridge/web e2e`. Playwright compila y levanta la API
 * (puerto 3001) y la web (puerto 3100). No corren en el CI (necesitan PostgREST y Realtime);
 * ver docs/evidence/phase-6.md.
 */
const WEB_PORT = 3100;
const API_PORT = 3001;
const BCV_SIM_PORT = 3999;

export default defineConfig({
  testDir: "./e2e",
  // Comparten una base real: en serie para que un test no pise los datos de otro.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    locale: "es-VE",
    // Solo para probar las imágenes de Docker (docs/deploy.md): la web del contenedor apunta a Supabase por
    // `host.docker.internal`, que el navegador del anfitrión no resuelve. Ej.:
    //   E2E_HOST_RESOLVER_RULES="MAP host.docker.internal 127.0.0.1"
    launchOptions: process.env.E2E_HOST_RESOLVER_RULES
      ? { args: [`--host-resolver-rules=${process.env.E2E_HOST_RESOLVER_RULES}`] }
      : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node e2e/bcv-sim.mjs",
      url: `http://127.0.0.1:${BCV_SIM_PORT}/bcv`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      // La API usa por defecto la base y el secreto JWT de la pila local.
      command: "pnpm --filter @erp-web-bridge/api... build && node ../api/dist/main.js",
      // Las fuentes de la tasa BCV apuntan al simulador (e2e/bcv-sim.mjs), no a internet; la revisión periódica va cada 2 s.
      env: {
        PORT: String(API_PORT),
        BCV_URL: `http://127.0.0.1:${BCV_SIM_PORT}/bcv`,
        BCV_FALLBACK_URL: `http://127.0.0.1:${BCV_SIM_PORT}/api`,
        BCV_CHECK_INTERVAL_SECONDS: "2",
        BCV_SCHEDULER: "true",
      },
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: true,
      timeout: 240_000,
    },
    {
      command: `pnpm build && pnpm exec next start -p ${WEB_PORT}`,
      env: { API_URL: `http://localhost:${API_PORT}`, DEMO_MODE: "true" },
      url: `http://localhost:${WEB_PORT}/login`,
      reuseExistingServer: true,
      timeout: 240_000,
    },
  ],
});
