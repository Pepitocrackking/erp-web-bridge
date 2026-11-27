export interface RateLimitConfig {
  /** Ventana de conteo en segundos. */
  windowSeconds: number;
  /** Peticiones por ventana, por IP y por ruta, en el resto de endpoints. */
  default: number;
  /** Ingesta masiva del agente (/v1/sync/*). */
  sync: number;
  /** Escrituras de usuarios con efecto en dinero: crear pedidos y fijar la tasa. */
  strict: number;
}

/** Aviso externo (webhook) cuando el agente local de una organización deja de dar señales. */
export interface NotifyConfig {
  /** NOTIFY_WEBHOOK_URL. Vacío = apagado (el panel avisa igual). https, o http hacia localhost. */
  webhookUrl: string | null;
  /** NOTIFY_WEBHOOK_SECRET. Si existe, el cuerpo se firma con HMAC-SHA256 en `x-erp-bridge-signature`. */
  webhookSecret: string | null;
  /** NOTIFY_OFFLINE_AFTER_SECONDS: sin latido durante este tiempo = sin conexión (igual que el panel). */
  offlineAfterSeconds: number;
  /** NOTIFY_CHECK_INTERVAL_SECONDS: cada cuánto revisa la API las organizaciones. */
  checkIntervalSeconds: number;
}

/** Fuentes de la tasa oficial (BCV) y límites de la lectura automática. */
export interface BcvConfig {
  /** BCV_URL: portada de bcv.org.ve (fuente primaria). */
  primaryUrl: string;
  /** BCV_FALLBACK_URL: API pública de respaldo (formato DolarAPI). Vacío = sin respaldo. */
  fallbackUrl: string | null;
  /** BCV_TIMEOUT_MS: espera máxima por fuente. */
  timeoutMs: number;
  /** BCV_MAX_JUMP_PERCENT: variación máxima aceptada frente a la tasa anterior. */
  maxJumpPercent: number;
  /** BCV_CHECK_INTERVAL_SECONDS: cada cuánto revisa la API qué organizaciones deben actualizar. */
  checkIntervalSeconds: number;
}

export interface AppConfig {
  databaseUrl: string;
  /** Secreto HS256 con el que Supabase Auth firma los JWT (SUPABASE_JWT_SECRET). */
  jwtSecret: string;
  /**
   * JWKS de Supabase Auth (SUPABASE_JWKS_URL): claves públicas con las que se verifican los JWT ES256,
   * que es como firma el CLI reciente y los proyectos nuevos.
   */
  jwksUrl: string;
  /** Emisor exigido en el claim `iss` (SUPABASE_JWT_ISSUER). Vacío = no se comprueba. */
  jwtIssuer: string | null;
  rateLimit: RateLimitConfig;
  /**
   * Cuántos proxies de confianza hay delante de la API (TRUST_PROXY). Apagado por defecto: así
   * un cliente no puede saltarse el rate limit inventando la cabecera X-Forwarded-For.
   */
  trustProxy: boolean | number;
  /** Publica /docs y /openapi.json (DOCS_ENABLED, por defecto sí). */
  docsEnabled: boolean;
  notify: NotifyConfig;
  bcv: BcvConfig;
}

/** Entero positivo de una variable de entorno; cualquier otra cosa cae al valor por defecto. */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw.trim())) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function parseTrustProxy(raw: string | undefined): boolean | number {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === "true") return true;
  if (/^[0-9]+$/.test(value)) return Number(value) || false;
  return false;
}

/**
 * URL del webhook. Una URL mal escrita detiene el arranque: ignorarla en silencio dejaría al
 * operador creyendo que está protegido por un aviso que nunca se envía.
 */
function parseWebhookUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`NOTIFY_WEBHOOK_URL no es una URL válida: ${JSON.stringify(value)}`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return value;
  throw new Error("NOTIFY_WEBHOOK_URL debe ser https (http solo se admite hacia localhost)");
}

/** URL de una fuente de tasa: https, o http hacia localhost (pruebas). Una mal escrita detiene el arranque. */
function parseSourceUrl(
  name: string,
  raw: string | undefined,
  fallback: string | null,
): string | null {
  const value = raw === undefined ? fallback : raw.trim() || null;
  if (value === null) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} no es una URL válida: ${JSON.stringify(value)}`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return value;
  throw new Error(`${name} debe ser https (http solo se admite hacia localhost)`);
}

/** Valores por defecto: la base y el secreto de la pila local de `supabase start`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    jwtSecret: env.SUPABASE_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long",
    jwksUrl: env.SUPABASE_JWKS_URL ?? "http://127.0.0.1:54321/auth/v1/.well-known/jwks.json",
    jwtIssuer: env.SUPABASE_JWT_ISSUER?.trim() || null,
    rateLimit: {
      windowSeconds: positiveInt(env.RATE_LIMIT_WINDOW_SECONDS, 60),
      default: positiveInt(env.RATE_LIMIT_DEFAULT, 120),
      sync: positiveInt(env.RATE_LIMIT_SYNC, 60),
      strict: positiveInt(env.RATE_LIMIT_STRICT, 20),
    },
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    docsEnabled: env.DOCS_ENABLED?.trim().toLowerCase() !== "false",
    notify: {
      webhookUrl: parseWebhookUrl(env.NOTIFY_WEBHOOK_URL),
      webhookSecret: env.NOTIFY_WEBHOOK_SECRET?.trim() || null,
      offlineAfterSeconds: positiveInt(env.NOTIFY_OFFLINE_AFTER_SECONDS, 180),
      checkIntervalSeconds: positiveInt(env.NOTIFY_CHECK_INTERVAL_SECONDS, 60),
    },
    bcv: {
      primaryUrl: parseSourceUrl("BCV_URL", env.BCV_URL, "https://www.bcv.org.ve/") as string,
      fallbackUrl: parseSourceUrl(
        "BCV_FALLBACK_URL",
        env.BCV_FALLBACK_URL,
        "https://ve.dolarapi.com/v1/dolares/oficial",
      ),
      timeoutMs: positiveInt(env.BCV_TIMEOUT_MS, 10_000),
      maxJumpPercent: positiveInt(env.BCV_MAX_JUMP_PERCENT, 25),
      checkIntervalSeconds: positiveInt(env.BCV_CHECK_INTERVAL_SECONDS, 60),
    },
  };
}

export const APP_CONFIG = Symbol("APP_CONFIG");
