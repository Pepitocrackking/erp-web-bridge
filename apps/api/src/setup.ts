import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * Un lote de 1000 productos pesa unos cientos de KB; el límite por defecto de Express (100 KB)
 * lo rechazaría. Se fija un tope explícito, pensado para el lote máximo con textos largos.
 */
export const JSON_BODY_LIMIT = "5mb";

/** Configuración común de `main.ts` y de las pruebas, para que se comporten igual. */
export function configureApp(app: INestApplication): void {
  (app as NestExpressApplication).useBodyParser("json", { limit: JSON_BODY_LIMIT });
}
