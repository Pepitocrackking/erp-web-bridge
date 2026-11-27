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

describe("loadConfig: aviso de agente sin conexión (NOTIFY_*)", () => {
  it("por defecto está apagado y usa la misma ventana que el panel (3 min)", () => {
    expect(loadConfig({}).notify).toEqual({
      webhookUrl: null,
      webhookSecret: null,
      offlineAfterSeconds: 180,
      checkIntervalSeconds: 60,
    });
  });

  it("lee la URL, el secreto y los tiempos", () => {
    const c = loadConfig({
      NOTIFY_WEBHOOK_URL: " https://hooks.ejemplo.com/erp ",
      NOTIFY_WEBHOOK_SECRET: "s3creto",
      NOTIFY_OFFLINE_AFTER_SECONDS: "600",
      NOTIFY_CHECK_INTERVAL_SECONDS: "30",
    });
    expect(c.notify).toEqual({
      webhookUrl: "https://hooks.ejemplo.com/erp",
      webhookSecret: "s3creto",
      offlineAfterSeconds: 600,
      checkIntervalSeconds: 30,
    });
  });

  it("una URL vacía lo deja apagado", () => {
    expect(loadConfig({ NOTIFY_WEBHOOK_URL: "  " }).notify.webhookUrl).toBeNull();
  });

  it("http solo se admite hacia localhost", () => {
    expect(loadConfig({ NOTIFY_WEBHOOK_URL: "http://localhost:9000/x" }).notify.webhookUrl).toBe(
      "http://localhost:9000/x",
    );
    expect(loadConfig({ NOTIFY_WEBHOOK_URL: "http://127.0.0.1:9000/x" }).notify.webhookUrl).toBe(
      "http://127.0.0.1:9000/x",
    );
    expect(() => loadConfig({ NOTIFY_WEBHOOK_URL: "http://hooks.ejemplo.com/x" })).toThrow(
      /NOTIFY_WEBHOOK_URL/,
    );
  });

  it.each(["no es una url", "ftp://x.com/y", "javascript:alert(1)", "https://"])(
    "una URL inválida (%p) detiene el arranque con un mensaje claro, no se ignora en silencio",
    (bad) => {
      expect(() => loadConfig({ NOTIFY_WEBHOOK_URL: bad })).toThrow(/NOTIFY_WEBHOOK_URL/);
    },
  );

  it.each(["0", "-1", "abc", "1.5"])("un tiempo inválido (%p) cae al valor por defecto", (bad) => {
    const c = loadConfig({
      NOTIFY_OFFLINE_AFTER_SECONDS: bad,
      NOTIFY_CHECK_INTERVAL_SECONDS: bad,
    });
    expect(c.notify.offlineAfterSeconds).toBe(180);
    expect(c.notify.checkIntervalSeconds).toBe(60);
  });
});
