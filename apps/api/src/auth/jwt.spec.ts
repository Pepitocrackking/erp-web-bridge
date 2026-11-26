import { createHmac } from "node:crypto";
import { hashApiKey } from "./api-key";
import { verifyHs256Jwt, JwtError } from "./jwt";

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

describe("hashApiKey", () => {
  it("es SHA-256 en hex y determinista", () => {
    // sha256("erp_dev_demo_saint_key"), el mismo valor que guarda el seed
    expect(hashApiKey("erp_dev_demo_saint_key")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey("erp_dev_demo_saint_key")).toBe(hashApiKey("erp_dev_demo_saint_key"));
    expect(hashApiKey("a")).not.toBe(hashApiKey("b"));
  });
});
