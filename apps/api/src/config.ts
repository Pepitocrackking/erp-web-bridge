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

export interface AppConfig {
  databaseUrl: string;
  /** Secreto HS256 con el que Supabase Auth firma los JWT (SUPABASE_JWT_SECRET). */
  jwtSecret: string;
  rateLimit: RateLimitConfig;
  /**
   * Cuántos proxies de confianza hay delante de la API (TRUST_PROXY). Apagado por defecto: así
   * un cliente no puede saltarse el rate limit inventando la cabecera X-Forwarded-For.
   */
  trustProxy: boolean | number;
  /** Publica /docs y /openapi.json (DOCS_ENABLED, por defecto sí). */
  docsEnabled: boolean;
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

/** Valores por defecto: la base y el secreto de la pila local de `supabase start`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    jwtSecret: env.SUPABASE_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long",
    rateLimit: {
      windowSeconds: positiveInt(env.RATE_LIMIT_WINDOW_SECONDS, 60),
      default: positiveInt(env.RATE_LIMIT_DEFAULT, 120),
      sync: positiveInt(env.RATE_LIMIT_SYNC, 60),
      strict: positiveInt(env.RATE_LIMIT_STRICT, 20),
    },
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    docsEnabled: env.DOCS_ENABLED?.trim().toLowerCase() !== "false",
  };
}

export const APP_CONFIG = Symbol("APP_CONFIG");
