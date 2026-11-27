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

/**
 * Cabeceras de endurecimiento en TODAS las respuestas (también 401 y 404): el navegador no adivina
 * el tipo de contenido, la API no se puede enmarcar y no se filtra el origen. Las respuestas de la
 * API dependen de quién pregunta, así que no deben guardarse en cachés compartidas (proxies, CDN):
 * `no-store`, salvo en la documentación (`/docs`), cuyos archivos estáticos sí pueden cachearse.
 * HSTS lo pone el proxy HTTPS de delante (ver docs/deploy.md).
 */
export function securityHeaders(
  req: { path: string },
  res: { setHeader(name: string, value: string): unknown },
  next: () => void,
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!req.path.startsWith("/docs")) res.setHeader("Cache-Control", "no-store");
  next();
}

/** Configuración común de `main.ts` y de las pruebas, para que se comporten igual. */
export function configureApp(app: INestApplication, config?: Pick<AppConfig, "trustProxy">): void {
  const express = app as NestExpressApplication;
  express.useBodyParser("json", { limit: JSON_BODY_LIMIT });
  // No anunciar el framework.
  express.disable("x-powered-by");
  express.use(securityHeaders);
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
