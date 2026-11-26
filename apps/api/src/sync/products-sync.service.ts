import { ConflictException, Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { ProductSyncBatch, SyncResult } from "@erp-web-bridge/shared-types";
import type { PoolClient } from "pg";
import { BatchRunner, type BatchCounts } from "./batch-runner";

/**
 * Upsert masivo en UNA sentencia: `unnest` de arreglos paralelos + `ON CONFLICT`. Las filas cuyo
 * contenido no cambió no se tocan (ni `updated_at`): se comparan los campos, no solo `sync_hash`,
 * porque el hash del agente no cubre categoría ni estado. `xmax = 0` distingue altas de cambios.
 */
const UPSERT_SQL = `
  WITH incoming AS (
    SELECT * FROM unnest(
      $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::text[], $8::boolean[]
    ) AS t(erp_sku, name, category, price_usd, stock, sync_hash, is_active)
  ), upserted AS (
    INSERT INTO public.products (org_id, erp_sku, name, category, price_usd, stock, sync_hash, is_active)
    SELECT $1::uuid, erp_sku, name, category, price_usd, stock, sync_hash, is_active FROM incoming
    ON CONFLICT (org_id, erp_sku) DO UPDATE SET
      name = EXCLUDED.name,
      category = EXCLUDED.category,
      price_usd = EXCLUDED.price_usd,
      stock = EXCLUDED.stock,
      sync_hash = EXCLUDED.sync_hash,
      is_active = EXCLUDED.is_active
    WHERE (products.name, products.category, products.price_usd, products.stock,
           products.sync_hash, products.is_active)
      IS DISTINCT FROM
          (EXCLUDED.name, EXCLUDED.category, EXCLUDED.price_usd, EXCLUDED.stock,
           EXCLUDED.sync_hash, EXCLUDED.is_active)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted)::int AS inserted,
         count(*) FILTER (WHERE NOT inserted)::int AS updated
    FROM upserted`;

@Injectable()
export class ProductsSyncService {
  constructor(private readonly runner: BatchRunner) {}

  ingest(orgId: string, batch: ProductSyncBatch): Promise<SyncResult> {
    // `ON CONFLICT DO UPDATE` no admite la misma clave dos veces en una sentencia, y un SKU
    // repetido en el lote es ambiguo (¿cuál manda?). Se rechaza en vez de elegir uno al azar.
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    for (const record of batch.records) {
      if (seen.has(record.sku)) duplicated.add(record.sku);
      seen.add(record.sku);
    }
    if (duplicated.size > 0) {
      throw new UnprocessableEntityException({
        message: "SKU repetidos dentro del lote",
        skus: [...duplicated].slice(0, 20),
      });
    }

    return this.runner.run(orgId, "products", batch.batch_id, (client) =>
      this.apply(client, orgId, batch),
    );
  }

  private async apply(
    client: PoolClient,
    orgId: string,
    batch: ProductSyncBatch,
  ): Promise<BatchCounts> {
    const { records } = batch;
    let inserted = 0;
    let updated = 0;

    if (records.length > 0) {
      const res = await client.query<{ inserted: number; updated: number }>(UPSERT_SQL, [
        orgId,
        records.map((r) => r.sku),
        records.map((r) => r.name),
        records.map((r) => r.category ?? null),
        records.map((r) => r.price_usd),
        records.map((r) => r.stock),
        records.map((r) => r.sync_hash),
        records.map((r) => r.active),
      ]);
      inserted = res.rows[0]?.inserted ?? 0;
      updated = res.rows[0]?.updated ?? 0;
    }

    let deactivated: number | null = null;
    if (batch.full_reconciliation && batch.reconciliation_id) {
      // Se sella lo recibido (cambie o no) con el id de esta reconciliación.
      if (records.length > 0) {
        await client.query(
          `UPDATE public.products SET reconciliation_id = $2
            WHERE org_id = $1 AND erp_sku = ANY($3::text[]) AND reconciliation_id IS DISTINCT FROM $2`,
          [orgId, batch.reconciliation_id, records.map((r) => r.sku)],
        );
      }
      if (batch.final_batch) {
        deactivated = await this.finishReconciliation(
          client,
          orgId,
          batch.reconciliation_id,
          batch.total_records ?? 0,
        );
      }
    }

    return {
      received: records.length,
      inserted,
      updated,
      unchanged: records.length - inserted - updated,
      deactivated,
    };
  }

  /**
   * Último lote de una reconciliación: desactiva lo que el ERP ya no envió, pero solo si se
   * recibió exactamente el inventario anunciado. Si no cuadra (se perdió un lote, o llegó
   * fuera de orden) se aborta con 409 y la transacción revierte TAMBIÉN este lote: no se
   * desactiva nada y el agente puede reiniciar la reconciliación.
   */
  private async finishReconciliation(
    client: PoolClient,
    orgId: string,
    reconciliationId: string,
    expectedTotal: number,
  ): Promise<number> {
    const stamped = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.products WHERE org_id = $1 AND reconciliation_id = $2",
      [orgId, reconciliationId],
    );
    const received = stamped.rows[0]?.n ?? 0;
    if (received !== expectedTotal) {
      throw new ConflictException({
        message: "Reconciliación incompleta: no se desactivó ningún producto",
        expected_total: expectedTotal,
        received_total: received,
      });
    }
    const res = await client.query(
      `UPDATE public.products SET is_active = false
        WHERE org_id = $1 AND is_active AND reconciliation_id IS DISTINCT FROM $2`,
      [orgId, reconciliationId],
    );
    return res.rowCount ?? 0;
  }
}
