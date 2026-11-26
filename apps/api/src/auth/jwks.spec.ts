import { generateKeyPairSync, type JsonWebKey } from "node:crypto";
import { JwksCache, type JwksFetch } from "./jwks";

const jwk = (kid: string, extra: Record<string, unknown> = {}) => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid, alg: "ES256", ...extra };
};

/** Un fetch falso que sirve `keys` y cuenta las llamadas. */
function fakeFetch(keys: () => unknown[]) {
  return jest.fn<ReturnType<JwksFetch>, Parameters<JwksFetch>>(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ keys: keys() }),
  }));
}

describe("JwksCache", () => {
  let now: number;
  const clock = () => now;
  beforeEach(() => {
    now = 1_000_000;
  });

  it("descarga las claves una vez y sirve las siguientes desde la memoria", async () => {
    const fetchFn = fakeFetch(() => [jwk("k1"), jwk("k2")]);
    const cache = new JwksCache("http://auth/jwks", fetchFn, clock);
    expect(await cache.getKey("k1")).not.toBeNull();
    expect(await cache.getKey("k2")).not.toBeNull();
    expect(await cache.getKey("k1")).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]![0]).toBe("http://auth/jwks");
  });

  it("un kid desconocido refresca como mucho una vez cada 30 s (no amplifica ataques)", async () => {
    const fetchFn = fakeFetch(() => [jwk("k1")]);
    const cache = new JwksCache("http://auth/jwks", fetchFn, clock);
    expect(await cache.getKey("k1")).not.toBeNull();
    for (let i = 0; i < 50; i++) expect(await cache.getKey(`falso-${i}`)).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now += 31_000;
    expect(await cache.getKey("falso-otro")).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("recoge una clave nueva tras una rotación", async () => {
    let keys = [jwk("viejo")];
    const fetchFn = fakeFetch(() => keys);
    const cache = new JwksCache("http://auth/jwks", fetchFn, clock);
    expect(await cache.getKey("viejo")).not.toBeNull();
    keys = [jwk("viejo"), jwk("nuevo")];
    now += 31_000;
    expect(await cache.getKey("nuevo")).not.toBeNull();
  });

  it("ignora claves que no son EC P-256 o no tienen kid", async () => {
    const fetchFn = fakeFetch(() => [
      jwk("rsa", { kty: "RSA", n: "x", e: "AQAB" }),
      jwk("p384", { crv: "P-384" }),
      jwk("otro-alg", { alg: "RS256" }),
      jwk("cifrado", { use: "enc" }),
      { ...jwk("sin-kid"), kid: undefined },
      jwk("bueno"),
    ]);
    const cache = new JwksCache("http://auth/jwks", fetchFn, clock);
    for (const kid of ["rsa", "p384", "otro-alg", "cifrado"]) {
      expect(await cache.getKey(kid)).toBeNull();
    }
    expect(await cache.getKey("bueno")).not.toBeNull();
  });

  it("si la descarga falla devuelve null sin lanzar, y reintenta pasados 30 s", async () => {
    const fetchFn = jest
      .fn<ReturnType<JwksFetch>, Parameters<JwksFetch>>()
      .mockRejectedValueOnce(new Error("sin red"))
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ keys: [jwk("k1")] }) });
    const cache = new JwksCache("http://auth/jwks", fetchFn, clock);
    expect(await cache.getKey("k1")).toBeNull();
    expect(await cache.getKey("k1")).toBeNull(); // dentro de los 30 s: no reintenta
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now += 31_000;
    expect(await cache.getKey("k1")).not.toBeNull();
  });

  it("tolera respuestas inválidas (HTTP de error, JSON raro)", async () => {
    for (const response of [
      { ok: false, status: 500, json: async () => ({}) },
      { ok: true, status: 200, json: async () => "texto" },
      { ok: true, status: 200, json: async () => ({ keys: "no" }) },
      { ok: true, status: 200, json: async () => ({ keys: [null, 5, "x"] }) },
    ]) {
      const cache = new JwksCache("http://auth/jwks", async () => response, clock);
      expect(await cache.getKey("k1")).toBeNull();
    }
  });

  it("si las claves caducan y la descarga falla, sigue sirviendo las viejas hasta 1 hora", async () => {
    let fail = false;
    const fetchFn = jest.fn<ReturnType<JwksFetch>, Parameters<JwksFetch>>(async () => {
      if (fail) throw new Error("caído");
      return { ok: true, status: 200, json: async () => ({ keys: [jwk("k1")] }) };
    });
    const cache = new JwksCache("http://auth/jwks", fetchFn, clock);
    expect(await cache.getKey("k1")).not.toBeNull();
    fail = true;
    now += 11 * 60_000; // vencido el TTL de 10 minutos
    expect(await cache.getKey("k1")).not.toBeNull(); // Auth caído: sirve la copia
    now += 60 * 60_000; // más de 1 hora desde la última descarga buena
    expect(await cache.getKey("k1")).toBeNull();
  });

  it("peticiones simultáneas comparten una sola descarga", async () => {
    const fetchFn = fakeFetch(() => [jwk("k1")]);
    const cache = new JwksCache("http://auth/jwks", fetchFn, clock);
    const results = await Promise.all(Array.from({ length: 20 }, () => cache.getKey("k1")));
    expect(results.every((k) => k !== null)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
