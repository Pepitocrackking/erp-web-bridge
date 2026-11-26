export interface AppConfig {
  databaseUrl: string;
  /** Secreto HS256 con el que Supabase Auth firma los JWT (SUPABASE_JWT_SECRET). */
  jwtSecret: string;
}

/** Valores por defecto: la base y el secreto de la pila local de `supabase start`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    jwtSecret: env.SUPABASE_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long",
  };
}

export const APP_CONFIG = Symbol("APP_CONFIG");
