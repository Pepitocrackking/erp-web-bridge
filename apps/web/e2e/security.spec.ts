import { expect, test } from "@playwright/test";

// Tarea 8.5: cabeceras de endurecimiento de la web (next.config.mjs), comprobadas en el servidor real.

test.describe("cabeceras de seguridad de la web", () => {
  for (const path of ["/login", "/registro", "/offline"]) {
    test(`${path} no se puede enmarcar ni adivinar y no filtra el origen`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      const h = res.headers();
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["x-frame-options"]).toBe("DENY");
      expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(h["permissions-policy"]).toContain("camera=()");
      expect(h["x-powered-by"]).toBeUndefined();
    });
  }

  test("una redirección de sesión (/admin sin login) también las lleva", async ({ request }) => {
    const res = await request.get("/admin", { maxRedirects: 0 });
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.headers()["x-frame-options"]).toBe("DENY");
  });

  test("el service worker conserva su política de caché propia", async ({ request }) => {
    const res = await request.get("/sw.js");
    const h = res.headers();
    expect(h["cache-control"]).toContain("no-store");
    expect(h["service-worker-allowed"]).toBe("/");
    expect(h["x-content-type-options"]).toBe("nosniff");
  });

  test("la app sigue funcionando con las cabeceras (la PWA y el login no se rompen)", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Correo")).toBeVisible();
    const embedded = await page.evaluate(() => window.top === window.self);
    expect(embedded).toBe(true);
  });
});
