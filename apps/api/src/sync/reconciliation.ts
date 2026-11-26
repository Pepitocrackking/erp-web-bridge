import { ConflictException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { SyncEntity } from "./batch-runner";

// Los nombres de tabla y de clave salen de este mapa fijo, nunca de la entrada del usuario:
// por eso es seguro interpolarlos en el SQL.
const TARGETS: Record<SyncEntity, { table: string; key: string }> = {
  products: { table: "public.products", key: "erp_sku" },
  customers: { table: "public.b2b_customers", key: "erp_customer_code" },
};

export interface ReconciliationPart {
  reconciliation_id: string;
  final_batch?: boolean | undefined;
  total_records?: number | undefined;
}

/**
 * Parte de un lote que pertenece a una reconciliación completa en varios lotes.
 *
 * Sella con `reconciliation_id` todas las filas recibidas (hayan cambiado o no). Solo en el
 * último lote desactiva (`is_active = false`, nunca borra) lo que no lleve el sello, y únicamente
 * si el número de sellados coincide con `total_records`. Si no cuadra (se perdió un lote o llegó
 * fuera de orden) lanza 409: la transacción del lote se revierte entera, no se desactiva nada y el
 * agente puede reiniciar la reconciliación.
 *
 * Devuelve cuántas filas se desactivaron, o `null` si este lote no era el último.
 */
export async function applyReconciliation(
  client: PoolClient,
  entity: SyncEntity,
  orgId: string,
  part: ReconciliationPart,
  keys: string[],
): Promise<number | null> {
  const { table, key } = TARGETS[entity];

  if (keys.length > 0) {
    await client.query(
      `UPDATE ${table} SET reconciliation_id = $2
        WHERE org_id = $1 AND ${key} = ANY($3::text[]) AND reconciliation_id IS DISTINCT FROM $2`,
      [orgId, part.reconciliation_id, keys],
    );
  }
  if (!part.final_batch) return null;

  const expected = part.total_records ?? 0;
  const stamped = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1 AND reconciliation_id = $2`,
    [orgId, part.reconciliation_id],
  );
  const received = stamped.rows[0]?.n ?? 0;
  if (received !== expected) {
    throw new ConflictException({
      message: `Reconciliación incompleta: no se desactivó ningún registro de ${entity}`,
      expected_total: expected,
      received_total: received,
    });
  }
  const res = await client.query(
    `UPDATE ${table} SET is_active = false
      WHERE org_id = $1 AND is_active AND reconciliation_id IS DISTINCT FROM $2`,
    [orgId, part.reconciliation_id],
  );
  return res.rowCount ?? 0;
}

/** Claves repetidas dentro de un lote: `ON CONFLICT DO UPDATE` no admite la misma fila dos veces. */
export function findDuplicates(keys: string[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) duplicated.add(k);
    seen.add(k);
  }
  return [...duplicated];
}
