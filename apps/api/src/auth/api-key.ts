import { createHash, timingSafeEqual } from "node:crypto";

/** SHA-256 (hex) de la x-api-key; es lo que se guarda en `organizations.api_key_hash`. */
export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

/** Comparación de hashes hex en tiempo constante. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
