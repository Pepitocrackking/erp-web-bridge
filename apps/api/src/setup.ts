import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { AppConfig } from "./config";

/**
 * Un lote de 1000 productos pesa unos cientos de KB; el límite por defecto de Express (100 KB)
 * lo rechazaría. Se fija un tope explícito, pensado para el lote máximo con textos largos.
 */
export const JSON_BODY_LIMIT = "5mb";

export const API_VERSION = "0.1.0";

/** Configuración común de `main.ts` y de las pruebas, para que se comporten igual. */
export function configureApp(app: INestApplication, config?: Pick<AppConfig, "trustProxy">): void {
  const express = app as NestExpressApplication;
  express.useBodyParser("json", { limit: JSON_BODY_LIMIT });
  // No anunciar el framework.
  express.disable("x-powered-by");
  // Sin proxy de confianza, X-Forwarded-For se ignora y no sirve para esquivar el rate limit.
  express.set("trust proxy", config?.trustProxy ?? false);
}

/** Publica la especificación en /openapi.json y la interfaz Swagger UI en /docs (si están activadas). */
export function setupDocs(app: INestApplication, config: Pick<AppConfig, "docsEnabled">): void {
  if (!config.docsEnabled) return;
  const spec = new DocumentBuilder()
    .setTitle("erp-web-bridge API")
    .setDescription(
      "Puente ERP-a-web y catálogo B2B multimoneda. Los agentes locales (x-api-key) empujan " +
        "productos y clientes y recogen pedidos; los usuarios (JWT de Supabase) gestionan la tasa " +
        "de cambio y crean pedidos. Los esquemas de los cuerpos son estrictos: no se admiten campos de más.",
    )
    .setVersion(API_VERSION)
    .addApiKey(
      {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description:
          "Clave del agente de una organización. Identifica a la organización: nunca se envía su id.",
      },
      "agent-api-key",
    )
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "JWT de Supabase Auth (HS256 en local).",
      },
      "user-jwt",
    )
    .build();
  const document = SwaggerModule.createDocument(app, spec, { autoTagControllers: false });
  SwaggerModule.setup("docs", app, document, { jsonDocumentUrl: "openapi.json" });
}
