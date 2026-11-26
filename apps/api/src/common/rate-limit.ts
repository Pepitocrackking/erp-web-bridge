import { SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { RateLimitConfig } from "../config";

export type RateGroup = "default" | "sync" | "strict";

const KEY = "rate-limit:group";

/**
 * Elige el grupo de límite de una ruta (o de todo un controlador):
 *  - `sync`: ingesta masiva del agente;
 *  - `strict`: escrituras de usuarios con efecto en dinero (crear pedidos, fijar la tasa);
 *  - sin decorador: `default`.
 * Los números salen de la configuración (variables RATE_LIMIT_*), no del código.
 */
export const RateLimit = (group: RateGroup) => SetMetadata(KEY, group);

/** Límite de peticiones por ventana para la ruta del contexto. Lo usa ThrottlerModule. */
export function limitFor(
  reflector: Reflector,
  config: RateLimitConfig,
  context: ExecutionContext,
): number {
  const group =
    reflector.getAllAndOverride<RateGroup | undefined>(KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? "default";
  return config[group];
}
