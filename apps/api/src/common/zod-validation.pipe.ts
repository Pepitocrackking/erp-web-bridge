import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { z } from "zod";

const MAX_ISSUES_REPORTED = 20;

/**
 * Valida el cuerpo con un esquema Zod de `shared-types` (los contratos no se duplican en la API).
 * Devuelve el valor ya parseado (con los `trim()` aplicados). Un lote malo de 1000 registros
 * puede generar miles de errores: solo se informan los primeros.
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new BadRequestException({
      message: "Cuerpo inválido",
      issues: result.error.issues.slice(0, MAX_ISSUES_REPORTED).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
      total_issues: result.error.issues.length,
    });
  }
}
