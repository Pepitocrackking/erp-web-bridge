import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { SyncResult } from "@erp-web-bridge/shared-types";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.module";

export type SyncEntity = "products" | "customers";

export interface BatchCounts {
  /** Registros que traía el lote. */
  received: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Solo en el último lote de una reconciliación completa. */
  deactivated: number | null;
}

/**
 * Ejecuta un lote de sincronización de forma atómica e idempotente.
 *
 * Todo ocurre en una transacción como `postgres` (salta RLS): el aislamiento entre tenants lo
 * garantiza el código, así que `orgId` viene SIEMPRE de la API key y cada sentencia lo filtra.
 *
 *  1. Bloqueo asesor por (org, entidad, batch_id): dos envíos simultáneos del mismo lote se
 *     serializan.
 *  2. Si el batch_id ya se registró con éxito (el agente reenvió porque perdió la respuesta),
 *     se devuelve `duplicate: true` sin repetir el trabajo.
 *  3. `work` aplica los datos. Si lanza, se revierte todo y no queda ni bitácora de éxito.
 *  4. Se anota en `sync_logs` y se actualiza `organizations.last_sync_at`, en la misma transacción.
 */
@Injectable()
export class BatchRunner {
  constructor(private readonly db: DatabaseService) {}

  async run(
    orgId: string,
    entity: SyncEntity,
    batchId: string,
    work: (client: PoolClient) => Promise<BatchCounts>,
  ): Promise<SyncResult> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `sync:${orgId}:${entity}:${batchId}`,
      ]);

      const previous = await client.query<{ records_processed: number }>(
        `SELECT records_processed FROM public.sync_logs
          WHERE org_id = $1 AND entity = $2 AND batch_id = $3 AND status IN ('success', 'partial')`,
        [orgId, entity, batchId],
      );
      if (previous.rows[0]) {
        await client.query("COMMIT");
        return {
          batch_id: batchId,
          duplicate: true,
          received: previous.rows[0].records_processed,
          inserted: null,
          updated: null,
          unchanged: null,
          deactivated: null,
        };
      }

      const counts = await work(client);

      await client.query(
        `INSERT INTO public.sync_logs (org_id, direction, entity, batch_id, records_processed, status)
         VALUES ($1, 'erp_to_cloud', $2, $3, $4, 'success')`,
        [orgId, entity, batchId, counts.received],
      );
      await client.query("UPDATE public.organizations SET last_sync_at = now() WHERE id = $1", [
        orgId,
      ]);
      await client.query("COMMIT");
      return { batch_id: batchId, duplicate: false, ...counts };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw translateDbError(err);
    } finally {
      client.release();
    }
  }
}

/**
 * Los errores de datos de Postgres (clase 22: desbordamiento numérico, caracteres inválidos...)
 * son culpa del cuerpo recibido, no del servidor: se devuelven como 422 en lugar de un 500.
 */
function translateDbError(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("22")) {
    return new UnprocessableEntityException(
      `Datos fuera de rango o con caracteres no permitidos (${code})`,
    );
  }
  return err;
}
