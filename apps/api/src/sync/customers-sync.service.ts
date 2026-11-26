import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { CustomerSyncBatch, SyncResult } from "@erp-web-bridge/shared-types";
import type { PoolClient } from "pg";
import { BatchRunner, type BatchCounts } from "./batch-runner";
import { applyReconciliation, findDuplicates } from "./reconciliation";

/**
 * Mismo patrón que los productos: una sola sentencia con `unnest` + `ON CONFLICT`, que solo toca
 * las filas que cambiaron. `price_list_id` no se incluye: la lista de precios de un cliente la
 * asigna el panel, y la sincronización con el ERP no debe pisarla.
 */
const UPSERT_SQL = `
  WITH incoming AS (
    SELECT * FROM unnest(
      $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::boolean[]
    ) AS t(erp_customer_code, tax_id, business_name, credit_limit_usd, current_debt_usd, is_active)
  ), upserted AS (
    INSERT INTO public.b2b_customers
      (org_id, erp_customer_code, tax_id, business_name, credit_limit_usd, current_debt_usd, is_active)
    SELECT $1::uuid, erp_customer_code, tax_id, business_name, credit_limit_usd, current_debt_usd,
           is_active
      FROM incoming
    ON CONFLICT (org_id, erp_customer_code) DO UPDATE SET
      tax_id = EXCLUDED.tax_id,
      business_name = EXCLUDED.business_name,
      credit_limit_usd = EXCLUDED.credit_limit_usd,
      current_debt_usd = EXCLUDED.current_debt_usd,
      is_active = EXCLUDED.is_active
    WHERE (b2b_customers.tax_id, b2b_customers.business_name, b2b_customers.credit_limit_usd,
           b2b_customers.current_debt_usd, b2b_customers.is_active)
      IS DISTINCT FROM
          (EXCLUDED.tax_id, EXCLUDED.business_name, EXCLUDED.credit_limit_usd,
           EXCLUDED.current_debt_usd, EXCLUDED.is_active)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted)::int AS inserted,
         count(*) FILTER (WHERE NOT inserted)::int AS updated
    FROM upserted`;

@Injectable()
export class CustomersSyncService {
  constructor(private readonly runner: BatchRunner) {}

  ingest(orgId: string, batch: CustomerSyncBatch): Promise<SyncResult> {
    const duplicated = findDuplicates(batch.records.map((r) => r.customer_code));
    if (duplicated.length > 0) {
      throw new UnprocessableEntityException({
        message: "Códigos de cliente repetidos dentro del lote",
        codes: duplicated.slice(0, 20),
      });
    }
    return this.runner.run(orgId, "customers", batch.batch_id, (client) =>
      this.apply(client, orgId, batch),
    );
  }

  private async apply(
    client: PoolClient,
    orgId: string,
    batch: CustomerSyncBatch,
  ): Promise<BatchCounts> {
    const { records } = batch;
    let inserted = 0;
    let updated = 0;

    if (records.length > 0) {
      const res = await client.query<{ inserted: number; updated: number }>(UPSERT_SQL, [
        orgId,
        records.map((r) => r.customer_code),
        records.map((r) => r.tax_id),
        records.map((r) => r.business_name),
        records.map((r) => r.credit_limit_usd),
        records.map((r) => r.current_debt_usd),
        records.map((r) => r.active),
      ]);
      inserted = res.rows[0]?.inserted ?? 0;
      updated = res.rows[0]?.updated ?? 0;
    }

    const deactivated =
      batch.full_reconciliation && batch.reconciliation_id
        ? await applyReconciliation(
            client,
            "customers",
            orgId,
            { ...batch, reconciliation_id: batch.reconciliation_id },
            records.map((r) => r.customer_code),
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
