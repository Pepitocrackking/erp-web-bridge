import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { catchError, from, mergeMap, throwError, type Observable } from "rxjs";
import type { AuthedRequest } from "../auth/auth.guards";
import { DatabaseService } from "../database/database.module";
import type { SyncEntity } from "./batch-runner";

const ENTITY_KEY = "sync:entity";

/** Indica a qué entidad de `sync_logs` pertenece un endpoint, para anotar sus fallos. */
export const SyncEntityName = (entity: SyncEntity) => SetMetadata(ENTITY_KEY, entity);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DETAIL = 1000;

/**
 * Deja una fila `status = error` en `sync_logs` cuando falla un lote de sincronización de un agente
 * ya autenticado: cuerpo inválido (400), reconciliación incompleta (409), datos fuera de rango
 * (422) o un fallo interno. Va aparte de `BatchRunner` porque este revierte su transacción, y
 * porque los errores de validación ocurren antes de que el lote llegue a él.
 *
 * El detalle lleva solo el código y el mensaje de la API (con rutas de campo, nunca valores del
 * lote) y se acota a 1000 caracteres. Las fallas internas guardan un texto genérico: la causa va
 * al log del servidor. Anotar el error nunca debe tapar el error original.
 */
@Injectable()
export class SyncFailureLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(SyncFailureLogInterceptor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const entity = this.reflector.get<SyncEntity | undefined>(ENTITY_KEY, context.getHandler());
    const req = context.switchToHttp().getRequest<AuthedRequest & { body?: unknown }>();
    return next.handle().pipe(
      catchError((err: unknown) => {
        if (!entity || !req.agent) return throwError(() => err);
        return from(this.record(req.agent.orgId, entity, req.body, err)).pipe(
          mergeMap(() => throwError(() => err)),
        );
      }),
    );
  }

  private async record(
    orgId: string,
    entity: SyncEntity,
    body: unknown,
    err: unknown,
  ): Promise<void> {
    try {
      const rawId = (body as { batch_id?: unknown } | null | undefined)?.batch_id;
      const batchId = typeof rawId === "string" && UUID.test(rawId) ? rawId : null;
      await this.db.pool.query(
        `INSERT INTO public.sync_logs (org_id, direction, entity, batch_id, records_processed, status, error_detail)
         VALUES ($1, 'erp_to_cloud', $2, $3, 0, 'error', $4)`,
        [orgId, entity, batchId, this.describe(err)],
      );
    } catch (logErr) {
      this.logger.error(`No se pudo anotar el fallo de sync en sync_logs: ${String(logErr)}`);
    }
  }

  private describe(err: unknown): string {
    if (err instanceof HttpException) {
      const response = err.getResponse();
      const text = typeof response === "string" ? response : JSON.stringify(response);
      return `${err.getStatus()} ${text}`.slice(0, MAX_DETAIL);
    }
    this.logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return "500 Error interno";
  }
}
