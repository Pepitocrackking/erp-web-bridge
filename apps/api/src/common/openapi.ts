import { applyDecorators } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger";
import type { SchemaObject } from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
import { z } from "zod";

/**
 * La documentación sale de los MISMOS esquemas Zod de `shared-types` con los que se valida, así
 * que un contrato no puede divergir de su documentación. `input` para cuerpos (con valores por
 * defecto sin aplicar) y `output` para respuestas.
 */
export function toSchema(schema: z.ZodType, io: "input" | "output" = "output"): SchemaObject {
  const json = z.toJSONSchema(schema, {
    target: "openapi-3.0",
    io,
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete json.$schema; // OpenAPI no lleva `$schema` dentro de un esquema
  return json as SchemaObject;
}

const ERROR_SCHEMA: SchemaObject = {
  type: "object",
  properties: {
    statusCode: { type: "integer" },
    message: { description: "Texto o detalle estructurado del error" },
    error: { type: "string" },
  },
  required: ["statusCode", "message"],
};

const ERROR_TEXT: Record<number, string> = {
  400: "Cuerpo o parámetros inválidos (esquema estricto: no se admiten campos de más)",
  401: "Credenciales ausentes, inválidas o vencidas",
  403: "No autorizado para esta acción",
  404: "Recurso no encontrado",
  409: "Conflicto con el estado actual del recurso",
  413: "Cuerpo demasiado grande (máximo 5 MB)",
  422: "Datos bien formados pero rechazados por una regla de negocio",
  429: "Demasiadas solicitudes; ver la cabecera Retry-After",
};

export interface EndpointDoc {
  tag: string;
  summary: string;
  description?: string;
  /** Quién llama: el agente local (x-api-key), un usuario (JWT) o nadie (público). */
  auth: "agent" | "user" | "none";
  body?: z.ZodType;
  response?: { status: number; description: string; schema: z.ZodType };
  /** Errores propios del endpoint; 401 y 429 se añaden solos si no es público. */
  errors?: number[];
}

/** Documenta un endpoint de una vez: etiqueta, resumen, autenticación, cuerpo, respuesta y errores. */
export function ApiEndpoint(doc: EndpointDoc): MethodDecorator {
  const errors = new Set(doc.errors ?? []);
  if (doc.auth !== "none") {
    errors.add(401);
    errors.add(429);
  }
  const decorators: Array<MethodDecorator | ClassDecorator> = [
    ApiTags(doc.tag),
    ApiOperation({ summary: doc.summary, description: doc.description }),
  ];
  if (doc.auth === "agent") decorators.push(ApiSecurity("agent-api-key"));
  if (doc.auth === "user") decorators.push(ApiBearerAuth("user-jwt"));
  if (doc.body) decorators.push(ApiBody({ schema: toSchema(doc.body, "input") }));
  if (doc.response) {
    decorators.push(
      ApiResponse({
        status: doc.response.status,
        description: doc.response.description,
        schema: toSchema(doc.response.schema),
      }),
    );
  }
  for (const status of [...errors].sort((a, b) => a - b)) {
    decorators.push(
      ApiResponse({
        status,
        description: ERROR_TEXT[status] ?? "Error",
        schema: ERROR_SCHEMA,
      }),
    );
  }
  return applyDecorators(...decorators) as MethodDecorator;
}
