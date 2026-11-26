import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("sin variables usa la base local de Supabase y límites por defecto", () => {
    const c = loadConfig({});
    expect(c.databaseUrl).toContain("127.0.0.1:54322");
    expect(c.rateLimit).toEqual({ windowSeconds: 60, default: 120, sync: 60, strict: 20 });
    expect(c.trustProxy).toBe(false);
    expect(c.docsEnabled).toBe(true);
  });

  it("lee los límites de las variables de entorno", () => {
    const c = loadConfig({
      RATE_LIMIT_WINDOW_SECONDS: "10",
      RATE_LIMIT_DEFAULT: "5",
      RATE_LIMIT_SYNC: "3",
      RATE_LIMIT_STRICT: "2",
    });
    expect(c.rateLimit).toEqual({ windowSeconds: 10, default: 5, sync: 3, strict: 2 });
  });

  it.each(["0", "-5", "abc", "", "1.5", "NaN"])(
    "un límite inválido (%p) cae al valor por defecto, nunca a 0 ni a ilimitado",
    (bad) => {
      expect(
        loadConfig({ RATE_LIMIT_DEFAULT: bad, RATE_LIMIT_WINDOW_SECONDS: bad }).rateLimit,
      ).toMatchObject({
        windowSeconds: 60,
        default: 120,
      });
    },
  );

  it("TRUST_PROXY: número de saltos, true o apagado", () => {
    expect(loadConfig({ TRUST_PROXY: "1" }).trustProxy).toBe(1);
    expect(loadConfig({ TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: "cualquier cosa" }).trustProxy).toBe(false);
  });

  it("DOCS_ENABLED=false apaga la documentación", () => {
    expect(loadConfig({ DOCS_ENABLED: "false" }).docsEnabled).toBe(false);
    expect(loadConfig({ DOCS_ENABLED: "true" }).docsEnabled).toBe(true);
    expect(loadConfig({ DOCS_ENABLED: "no sé" }).docsEnabled).toBe(true);
  });
});
