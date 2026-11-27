import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { AllSourcesFailedError, checkJump, lookupRate } from "./rate-lookup";
import {
  BcvSource,
  DolarApiSource,
  parseBcvHtml,
  parseDolarApi,
  parseVeNumber,
  RateSourceError,
  type RateSource,
} from "./rate-sources";

const REAL_HTML = readFileSync(
  join(__dirname, "..", "..", "test", "fixtures", "bcv-rates-excerpt.html"),
  "utf8",
);

describe("parseVeNumber", () => {
  it.each([
    ["926,35920000", 926.3592],
    [" 1.016,86449384", 1016.86449384],
    ["18,28126443", 18.28126443],
    ["36", 36],
    ["1.234.567,5", 1234567.5],
  ])("lee %p", (raw, expected) => {
    expect(parseVeNumber(raw)).toBeCloseTo(expected, 8);
  });

  it.each(["", "abc", "1,2,3", "12.34", "1.2345,6", "--", "36,", ",5", "N/D"])(
    "rechaza %p",
    (raw) => {
      expect(parseVeNumber(raw)).toBeNull();
    },
  );
});

describe("parseBcvHtml (HTML real de bcv.org.ve)", () => {
  it("toma el dólar y no la primera cifra de la página (el euro)", () => {
    const { rate, valueDate } = parseBcvHtml(REAL_HTML);
    expect(rate).toBeCloseTo(926.3592, 4);
    expect(rate).not.toBeCloseTo(1016.86449384, 2);
    expect(valueDate).toBe("2026-11-27T00:00:00-04:00");
  });

  it("falla si falta el bloque del dólar", () => {
    const html = REAL_HTML.replace('id="dolar"', 'id="otra"');
    expect(() => parseBcvHtml(html)).toThrow(RateSourceError);
  });

  it("falla si el bloque no trae una cifra legible", () => {
    const html = REAL_HTML.replace("926,35920000", "N/D");
    expect(() => parseBcvHtml(html)).toThrow(/cifra ilegible/);
  });

  it("falla con una página que no es la portada", () => {
    expect(() => parseBcvHtml("<html><body>Mantenimiento</body></html>")).toThrow(
      /bloque del dólar/,
    );
  });
});

describe("parseDolarApi", () => {
  it("usa el promedio", () => {
    expect(parseDolarApi({ promedio: 926.3592, fechaActualizacion: "2026-11-27" })).toEqual({
      rate: 926.3592,
      valueDate: "2026-11-27",
    });
  });
  it("cae a venta si no hay promedio", () => {
    expect(parseDolarApi({ venta: 40 }).rate).toBe(40);
  });
  it.each([null, {}, { promedio: "926" }, { promedio: 0 }, { promedio: -3 }, { promedio: 1e12 }])(
    "rechaza %p",
    (body) => {
      expect(() => parseDolarApi(body)).toThrow(RateSourceError);
    },
  );
});

describe("fuentes contra servidores simulados", () => {
  let server: Server;
  let base: string;
  let mode: "ok" | "500" | "slow" | "garbage" | "redirect";

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (mode === "500") {
        res.statusCode = 500;
        res.end("boom");
      } else if (mode === "slow") {
        setTimeout(() => res.end("{}"), 2000).unref();
      } else if (mode === "garbage") {
        res.end("esto no es ni html del BCV ni json");
      } else if (mode === "redirect") {
        res.statusCode = 302;
        res.setHeader("location", "http://example.invalid/");
        res.end();
      } else if (req.url?.startsWith("/api")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ promedio: 50.5, fechaActualizacion: "2026-11-27" }));
      } else {
        res.setHeader("content-type", "text/html");
        res.end(REAL_HTML);
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  beforeEach(() => {
    mode = "ok";
  });

  it("BcvSource lee la tasa de la portada", async () => {
    const got = await new BcvSource(`${base}/`, 3000).fetchRate();
    expect(got.rate).toBeCloseTo(926.3592, 4);
    expect(got.provider).toBe("bcv.org.ve");
  });

  it("DolarApiSource lee la tasa del JSON", async () => {
    const got = await new DolarApiSource(`${base}/api`, 3000).fetchRate();
    expect(got).toMatchObject({ rate: 50.5, provider: "dolarapi" });
  });

  it.each(["500", "garbage", "redirect"] as const)("BcvSource falla con %s", async (m) => {
    mode = m;
    await expect(new BcvSource(`${base}/`, 3000).fetchRate()).rejects.toBeInstanceOf(
      RateSourceError,
    );
  });

  it("falla por tiempo de espera", async () => {
    mode = "slow";
    await expect(new DolarApiSource(`${base}/api`, 150).fetchRate()).rejects.toThrow(
      /no se pudo conectar/,
    );
  });

  it("falla si no hay nadie escuchando", async () => {
    await expect(new BcvSource("http://127.0.0.1:1/", 1000).fetchRate()).rejects.toBeInstanceOf(
      RateSourceError,
    );
  });
});

describe("lookupRate", () => {
  const ok = (provider: string, rate: number): RateSource => ({
    provider,
    fetchRate: async () => ({ provider, rate, valueDate: null }),
  });
  const bad = (provider: string): RateSource => ({
    provider,
    fetchRate: async () => {
      throw new RateSourceError(provider, "caída");
    },
  });

  it("usa la primaria si responde, sin tocar la secundaria", async () => {
    const second = jest.fn();
    const got = await lookupRate([ok("a", 10), { provider: "b", fetchRate: second }]);
    expect(got).toMatchObject({ provider: "a", rate: 10, failures: [] });
    expect(second).not.toHaveBeenCalled();
  });

  it("cae a la secundaria y registra el fallo de la primaria", async () => {
    const got = await lookupRate([bad("a"), ok("b", 11)]);
    expect(got.provider).toBe("b");
    expect(got.failures).toEqual([{ provider: "a", error: "a: caída" }]);
  });

  it("una lectura fuera de rango cuenta como fallo y pasa a la siguiente", async () => {
    const got = await lookupRate([ok("a", -5), ok("b", 12)]);
    expect(got).toMatchObject({ provider: "b", rate: 12 });
    expect(got.failures).toHaveLength(1);
  });

  it("si todas fallan lanza AllSourcesFailedError con cada motivo", async () => {
    await expect(lookupRate([bad("a"), bad("b")])).rejects.toMatchObject({
      name: "AllSourcesFailedError",
      failures: [{ provider: "a" }, { provider: "b" }],
    });
    await expect(lookupRate([])).rejects.toBeInstanceOf(AllSourcesFailedError);
  });
});

describe("checkJump", () => {
  it("acepta cambios dentro del umbral y rechaza los mayores, hacia arriba y hacia abajo", () => {
    expect(checkJump(100, 110, 25)).toEqual({ ok: true, changePercent: 10 });
    expect(checkJump(100, 125, 25).ok).toBe(true);
    expect(checkJump(100, 126, 25).ok).toBe(false);
    expect(checkJump(100, 70, 25).ok).toBe(false);
    expect(checkJump(100, 10000, 25).ok).toBe(false);
  });
  it("sin tasa anterior, o con la inicial 1.0, acepta cualquier valor", () => {
    expect(checkJump(null, 926, 25).ok).toBe(true);
    expect(checkJump(1, 926, 25).ok).toBe(true);
  });
});
