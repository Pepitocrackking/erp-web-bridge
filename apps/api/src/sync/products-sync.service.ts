import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { ProductSyncBatch, SyncResult } from "@erp-web-bridge/shared-types";
import type { PoolClient } from "pg";
import { BatchRunner, type BatchCounts } from "./batch-runner";
import { applyReconciliation, findDuplicates } from "./reconciliation";

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
    // Un SKU repetido en el lote es ambiguo (¿cuál manda?): se rechaza en vez de elegir uno.
    const duplicated = findDuplicates(batch.records.map((r) => r.sku));
    if (duplicated.length > 0) {
      throw new UnprocessableEntityException({
        message: "SKU repetidos dentro del lote",
        skus: duplicated.slice(0, 20),
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

    const deactivated =
      batch.full_reconciliation && batch.reconciliation_id
        ? await applyReconciliation(
            client,
            "products",
            orgId,
            { ...batch, reconciliation_id: batch.reconciliation_id },
            records.map((r) => r.sku),
          )
        : null;

    return {
      received: records.length,
      inserted,
      updated,
      unchanged: records.length - inserted - updated,
      deactivated,
    };
  }
}
