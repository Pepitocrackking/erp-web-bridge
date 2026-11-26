import { createPublicKey, type JsonWebKey, type KeyObject } from "node:crypto";

/** Lo mínimo de `fetch` que necesita el caché (permite sustituirlo en las pruebas). */
export type JwksFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Las claves se consideran frescas durante este tiempo. */
const TTL_MS = 10 * 60_000;
/** Mínimo entre dos descargas: un `kid` inventado no puede hacer que se consulte a Auth en cada petición. */
const MIN_REFRESH_MS = 30_000;
/** Si Auth no responde, se sigue sirviendo la copia hasta este tiempo desde la última descarga buena. */
const MAX_STALE_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 3_000;
const MAX_KEYS = 20;

/**
 * Claves públicas con las que Supabase Auth firma los JWT (JWKS), en memoria.
 *
 * Solo se aceptan claves EC P-256 con `kid` y sin otro algoritmo ni uso distinto de firma. Las
 * descargas están limitadas en frecuencia, comparten una sola petición en vuelo y, si Auth está
 * caído, se sigue sirviendo la última copia buena durante una hora.
 */
export class JwksCache {
  private keys = new Map<string, KeyObject>();
  private loadedAt = 0;
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: JwksFetch = (u, init) => fetch(u, init),
    private readonly now: () => number = Date.now,
  ) {}

  /** La clave pública del `kid`, o null si no existe o no se pudo obtener. Nunca lanza. */
  async getKey(kid: string): Promise<KeyObject | null> {
    const t = this.now();
    const fresh = t - this.loadedAt < TTL_MS;
    if (fresh && this.keys.has(kid)) return this.keys.get(kid)!;

    // Si ya hay una descarga en curso, todas las peticiones la esperan (si no, las que llegan
    // justo después del arranque verían un caché vacío y fallarían).
    if (this.inflight) await this.inflight;
    else if (t - this.lastAttempt >= MIN_REFRESH_MS) await this.refresh();

    const age = this.now() - this.loadedAt;
    return age < MAX_STALE_MS ? (this.keys.get(kid) ?? null) : null;
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.download().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async download(): Promise<void> {
    this.lastAttempt = this.now();
    try {
      const response = await this.fetchImpl(this.url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return;
      const keys = parseJwks(await response.json());
      this.keys = keys;
      this.loadedAt = this.now();
    } catch {
      // Auth caído o respuesta ilegible: se conserva lo que hubiera.
    }
  }
}

function parseJwks(body: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const list = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) return keys;
  for (const entry of list.slice(0, MAX_KEYS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const jwk = entry as JsonWebKey & { kid?: unknown; alg?: unknown; use?: unknown };
    if (typeof jwk.kid !== "string" || jwk.kid === "") continue;
    if (jwk.kty !== "EC" || jwk.crv !== "P-256") continue;
    if (jwk.alg !== undefined && jwk.alg !== "ES256") continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    } catch {
      // Clave mal formada: se ignora.
    }
  }
  return keys;
}
