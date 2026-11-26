import { createHmac, timingSafeEqual } from "node:crypto";

export class JwtError extends Error {}

export interface JwtClaims {
  sub: string;
  role: "authenticated";
  exp: number;
  [claim: string]: unknown;
}

const SEGMENT = /^[A-Za-z0-9_-]+$/;

function decodeJson(segment: string): Record<string, unknown> {
  if (!SEGMENT.test(segment)) throw new JwtError("token mal formado");
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new JwtError("token mal formado");
    }
    return value as Record<string, unknown>;
  } catch (err) {
    if (err instanceof JwtError) throw err;
    throw new JwtError("token mal formado");
  }
}

/**
 * Verifica un JWT firmado con HS256 (el que emite Supabase Auth en local) y devuelve sus claims.
 *
 * El algoritmo está fijado: cualquier otro (`none`, HS512, RS256...) se rechaza, así no hay
 * confusión de algoritmo. Se exige `exp` vigente, `sub` y `role = authenticated`; la clave
 * `anon` o `service_role` de Supabase no sirve como sesión de usuario.
 * `nowSeconds` es inyectable para poder probar la expiración.
 *
 * En producción Supabase firma con claves asimétricas (JWKS): habrá que sustituir esta función.
 */
export function verifyHs256Jwt(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): JwtClaims {
  if (!secret) throw new JwtError("secreto JWT no configurado");
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("token mal formado");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = decodeJson(headerB64);
  if (header.alg !== "HS256") throw new JwtError("algoritmo no permitido");

  if (!SEGMENT.test(signatureB64)) throw new JwtError("token mal formado");
  const expected = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest();
  const given = Buffer.from(signatureB64, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new JwtError("firma inválida");
  }

  const claims = decodeJson(payloadB64);
  if (typeof claims.exp !== "number") throw new JwtError("token sin exp");
  if (claims.exp <= nowSeconds) throw new JwtError("token vencido");
  if (typeof claims.nbf === "number" && claims.nbf > nowSeconds) {
    throw new JwtError("token aún no válido");
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new JwtError("token sin sub");
  }
  if (claims.role !== "authenticated") throw new JwtError("rol no permitido");
  return claims as JwtClaims;
}
