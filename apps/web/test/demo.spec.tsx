import { demoAdminCredentials, isDemoMode } from "../lib/demo";

describe("isDemoMode", () => {
  it("solo con DEMO_MODE=true exacto (sin interpretar valores 'parecidos')", () => {
    expect(isDemoMode({ DEMO_MODE: "true" })).toBe(true);
    for (const off of [undefined, "", "false", "TRUE", "1", "yes", " true", "true "]) {
      expect(isDemoMode({ DEMO_MODE: off })).toBe(false);
    }
    expect(isDemoMode({})).toBe(false);
  });
});

describe("demoAdminCredentials", () => {
  it("fuera del modo demo no hay credenciales: no se puede entrar", () => {
    expect(demoAdminCredentials({})).toBeNull();
    expect(demoAdminCredentials({ DEMO_MODE: "false", DEMO_ADMIN_EMAIL: "a@b.c" })).toBeNull();
  });

  it("en modo demo usa las del seed por defecto o las de entorno", () => {
    expect(demoAdminCredentials({ DEMO_MODE: "true" })).toEqual({
      email: "admin@demo-saint.test",
      password: "demo1234",
    });
    expect(
      demoAdminCredentials({
        DEMO_MODE: "true",
        DEMO_ADMIN_EMAIL: "otro@demo.test",
        DEMO_ADMIN_PASSWORD: "clave-larga-123",
      }),
    ).toEqual({ email: "otro@demo.test", password: "clave-larga-123" });
  });
});
