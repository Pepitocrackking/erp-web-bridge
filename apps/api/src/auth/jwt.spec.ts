import { createHmac, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { hashApiKey } from "./api-key";
import { decodeHeader, verifyEs256Jwt, verifyHs256Jwt, JwtError } from "./jwt";

const SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const NOW = 1_800_000_000; // segundos Unix fijos para que las pruebas sean deterministas

const b64 = (v: unknown) =>
  Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

function sign(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
  secret = SECRET,
) {
  const data = `${b64(header)}.${b64(payload)}`;
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}

const valid = { sub: "u-1", role: "authenticated", exp: NOW + 60 };

describe("verifyHs256Jwt", () => {
  it("acepta un token válido y devuelve los claims", () => {
    expect(verifyHs256Jwt(sign(valid), SECRET, NOW)).toEqual(valid);
  });

  it("rechaza una firma hecha con otro secreto", () => {
    expect(() =>
      verifyHs256Jwt(
        sign(valid, undefined, "otro-secreto-distinto-de-32-caracteres!!"),
        SECRET,
        NOW,
      ),
    ).toThrow(JwtError);
  });

  it("rechaza un token manipulado (payload cambiado, firma original)", () => {
    const [h, , s] = sign(valid).split(".");
    const forged = `${h}.${b64({ ...valid, sub: "otro" })}.${s}`;
    expect(() => verifyHs256Jwt(forged, SECRET, NOW)).toThrow(JwtError);
  });

  it("rechaza alg none y cualquier alg distinto de HS256", () => {
    expect(() =>
      verifyHs256Jwt(`${b64({ alg: "none", typ: "JWT" })}.${b64(valid)}.`, SECRET, NOW),
    ).toThrow(JwtError);
    expect(() => verifyHs256Jwt(sign(valid, { alg: "HS512", typ: "JWT" }), SECRET, NOW)).toThrow(
      JwtError,
    );
    expect(() => verifyHs256Jwt(sign(valid, { alg: "RS256", typ: "JWT" }), SECRET, NOW)).toThrow(
      JwtError,
    );
  });

  it("rechaza un token vencido y uno sin exp", () => {
    expect(() => verifyHs256Jwt(sign({ ...valid, exp: NOW - 1 }), SECRET, NOW)).toThrow(/vencido/);
    expect(() => verifyHs256Jwt(sign({ sub: "u-1", role: "authenticated" }), SECRET, NOW)).toThrow(
      JwtError,
    );
  });

  it("rechaza un token que aún no es válido (nbf)", () => {
    expect(() => verifyHs256Jwt(sign({ ...valid, nbf: NOW + 100 }), SECRET, NOW)).toThrow(JwtError);
  });

  it("rechaza basura y tokens mal formados", () => {
    for (const bad of ["", "abc", "a.b", "a.b.c.d", "....", "no.es.jwt"]) {
      expect(() => verifyHs256Jwt(bad, SECRET, NOW)).toThrow(JwtError);
    }
  });

  it("exige sub y role=authenticated", () => {
    expect(() =>
      verifyHs256Jwt(sign({ role: "authenticated", exp: NOW + 60 }), SECRET, NOW),
    ).toThrow(JwtError);
    expect(() =>
      verifyHs256Jwt(sign({ sub: "u-1", role: "anon", exp: NOW + 60 }), SECRET, NOW),
    ).toThrow(JwtError);
    expect(() =>
      verifyHs256Jwt(sign({ sub: "u-1", role: "service_role", exp: NOW + 60 }), SECRET, NOW),
    ).toThrow(JwtError);
  });

  it("rechaza un secreto vacío", () => {
    expect(() => verifyHs256Jwt(sign(valid), "", NOW)).toThrow(JwtError);
  });
});

describe("verifyEs256Jwt (claves asimétricas de Supabase Auth)", () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const otherPair = generateKeyPairSync("ec", { namedCurve: "P-256" });

  function signEs(
    payload: Record<string, unknown>,
    privateKey: KeyObject = pair.privateKey,
    header: Record<string, unknown> = { alg: "ES256", typ: "JWT", kid: "k1" },
  ) {
    const data = `${b64(header)}.${b64(payload)}`;
    const signature = cryptoSign("sha256", Buffer.from(data), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `${data}.${signature.toString("base64url")}`;
  }

  it("acepta un token firmado con la clave y devuelve los claims", () => {
    expect(verifyEs256Jwt(signEs(valid), pair.publicKey, NOW)).toEqual(valid);
  });

  it("rechaza una firma hecha con otra clave y un payload manipulado", () => {
    expect(() => verifyEs256Jwt(signEs(valid, otherPair.privateKey), pair.publicKey, NOW)).toThrow(
      JwtError,
    );
    const [h, , s] = signEs(valid).split(".");
    expect(() =>
      verifyEs256Jwt(`${h}.${b64({ ...valid, sub: "otro" })}.${s}`, pair.publicKey, NOW),
    ).toThrow(JwtError);
  });

  it("rechaza una firma con formato DER (solo vale r||s de 64 bytes) y firmas de otro largo", () => {
    const data = `${b64({ alg: "ES256", typ: "JWT", kid: "k1" })}.${b64(valid)}`;
    const der = cryptoSign("sha256", Buffer.from(data), pair.privateKey); // DER por defecto
    expect(() =>
      verifyEs256Jwt(`${data}.${der.toString("base64url")}`, pair.publicKey, NOW),
    ).toThrow(JwtError);
    expect(() => verifyEs256Jwt(`${data}.`, pair.publicKey, NOW)).toThrow(JwtError);
  });

  it("exige que el encabezado diga ES256 (no acepta HS256 ni none con esa clave)", () => {
    expect(() =>
      verifyEs256Jwt(
        signEs(valid, pair.privateKey, { alg: "HS256", typ: "JWT" }),
        pair.publicKey,
        NOW,
      ),
    ).toThrow(/algoritmo/);
    expect(() =>
      verifyEs256Jwt(`${b64({ alg: "none" })}.${b64(valid)}.`, pair.publicKey, NOW),
    ).toThrow(JwtError);
  });

  it("aplica las mismas reglas de claims que HS256", () => {
    expect(() => verifyEs256Jwt(signEs({ ...valid, exp: NOW - 1 }), pair.publicKey, NOW)).toThrow(
      /vencido/,
    );
    expect(() => verifyEs256Jwt(signEs({ ...valid, role: "anon" }), pair.publicKey, NOW)).toThrow(
      JwtError,
    );
    expect(() =>
      verifyEs256Jwt(signEs({ role: "authenticated", exp: NOW + 60 }), pair.publicKey, NOW),
    ).toThrow(JwtError);
  });

  it("rechaza una clave que no es de curva P-256", () => {
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" });
    expect(() => verifyEs256Jwt(signEs(valid, p384.privateKey), p384.publicKey, NOW)).toThrow(
      JwtError,
    );
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => verifyEs256Jwt(signEs(valid), rsa.publicKey, NOW)).toThrow(JwtError);
  });
});

describe("decodeHeader", () => {
  it("lee alg y kid, y rechaza lo mal formado", () => {
    expect(decodeHeader(sign(valid, { alg: "ES256", kid: "abc" }))).toMatchObject({
      alg: "ES256",
      kid: "abc",
    });
    for (const bad of ["", "abc", "a.b", "!!!.b.c"]) {
      expect(() => decodeHeader(bad)).toThrow(JwtError);
    }
  });
});

describe("hashApiKey", () => {
  it("es SHA-256 en hex y determinista", () => {
    // sha256("erp_dev_demo_saint_key"), el mismo valor que guarda el seed
    expect(hashApiKey("erp_dev_demo_saint_key")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey("erp_dev_demo_saint_key")).toBe(hashApiKey("erp_dev_demo_saint_key"));
    expect(hashApiKey("a")).not.toBe(hashApiKey("b"));
  });
});
