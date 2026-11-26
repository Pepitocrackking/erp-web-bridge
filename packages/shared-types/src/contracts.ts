import { z } from "zod";

/**
 * Contratos compartidos entre agente, API y web. Los nombres de campo (snake_case)
 * son los canonicos de `infra/saint-sandbox/mapping.saint.yaml` y del modelo del manual.
 * Los precios y costos viajan siempre en USD; los Bs se calculan en la nube.
 */

/** Maximo de registros por lote de sincronizacion (protege a la API de cargas enormes). */
export const SYNC_BATCH_MAX_RECORDS = 1000;

const money = z.number().finite().nonnegative();
const nonEmpty = z.string().trim().min(1);

export const productSchema = z.strictObject({
  sku: nonEmpty,
  name: nonEmpty,
  category: z.string().nullable().optional(),
  price_usd: money,
  stock: money,
  active: z.boolean(),
});
export type Product = z.infer<typeof productSchema>;

/** Producto dentro de un lote: el agente calcula el hash de sku + precio + stock + nombre. */
export const productRecordSchema = productSchema.extend({
  sync_hash: nonEmpty,
});
export type ProductRecord = z.infer<typeof productRecordSchema>;

export const customerSchema = z.strictObject({
  customer_code: nonEmpty,
  tax_id: nonEmpty,
  business_name: nonEmpty,
  credit_limit_usd: money,
  current_debt_usd: z.number().finite(),
  active: z.boolean(),
});
export type Customer = z.infer<typeof customerSchema>;

/** Debe coincidir con el CHECK de `web_orders.status` en `supabase/migrations`. */
export const ORDER_STATUSES = [
  "pending_sync",
  "synced_to_erp",
  "approved",
  "rejected",
  "cancelled",
  "error",
] as const;
export const orderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

export const orderItemSchema = z.strictObject({
  sku: nonEmpty,
  quantity: z.number().int().positive(),
  unit_price_usd: money,
});
export type OrderItem = z.infer<typeof orderItemSchema>;

export const orderSchema = z.strictObject({
  customer_code: nonEmpty,
  items: z.array(orderItemSchema).min(1),
  total_usd: money,
  exchange_rate_used: z.number().finite().positive(),
  status: orderStatusSchema,
  erp_order_reference: z.string().nullable().optional(),
});
export type Order = z.infer<typeof orderSchema>;

const batchBase = {
  batch_id: z.uuid(),
  sent_at: z.iso.datetime(),
  /** true cuando el lote es el inventario completo: la API desactiva lo que no venga. */
  full_reconciliation: z.boolean(),
};

export const syncBatchSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...batchBase,
    kind: z.literal("products"),
    records: z.array(productRecordSchema).max(SYNC_BATCH_MAX_RECORDS),
  }),
  z.strictObject({
    ...batchBase,
    kind: z.literal("customers"),
    records: z.array(customerSchema).max(SYNC_BATCH_MAX_RECORDS),
  }),
]);
export type SyncBatch = z.infer<typeof syncBatchSchema>;
