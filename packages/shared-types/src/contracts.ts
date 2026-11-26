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
  /** true cuando el lote forma parte del inventario completo: la API desactiva lo que no venga. */
  full_reconciliation: z.boolean(),
  /**
   * Una reconciliacion completa puede ocupar varios lotes (SYNC_BATCH_MAX_RECORDS cada uno).
   * Todos comparten el mismo reconciliation_id; el ultimo lleva final_batch=true y total_records
   * (cuantos registros tiene el inventario completo). Solo entonces la API desactiva los que
   * no llegaron, y solo si lo recibido cuadra con total_records: asi un lote perdido no
   * desactiva medio catalogo. Requeridos si full_reconciliation=true; prohibidos si es false.
   */
  reconciliation_id: z.uuid().optional(),
  final_batch: z.boolean().optional(),
  total_records: z.number().int().nonnegative().optional(),
};

function checkReconciliation(
  batch: {
    full_reconciliation: boolean;
    reconciliation_id?: string | undefined;
    final_batch?: boolean | undefined;
    total_records?: number | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: "custom", path: [path], message });
  if (!batch.full_reconciliation) {
    if (batch.reconciliation_id !== undefined)
      issue("reconciliation_id", "solo en reconciliacion completa");
    if (batch.final_batch !== undefined) issue("final_batch", "solo en reconciliacion completa");
    if (batch.total_records !== undefined)
      issue("total_records", "solo en reconciliacion completa");
    return;
  }
  if (batch.reconciliation_id === undefined)
    issue("reconciliation_id", "requerido en reconciliacion completa");
  if (batch.final_batch === undefined) issue("final_batch", "requerido en reconciliacion completa");
  if (batch.final_batch === true && batch.total_records === undefined) {
    issue("total_records", "requerido en el ultimo lote");
  }
  if (batch.final_batch === false && batch.total_records !== undefined) {
    issue("total_records", "solo en el ultimo lote");
  }
}

export const productSyncBatchSchema = z
  .strictObject({
    ...batchBase,
    kind: z.literal("products"),
    records: z.array(productRecordSchema).max(SYNC_BATCH_MAX_RECORDS),
  })
  .superRefine(checkReconciliation);
export type ProductSyncBatch = z.infer<typeof productSyncBatchSchema>;

export const customerSyncBatchSchema = z
  .strictObject({
    ...batchBase,
    kind: z.literal("customers"),
    records: z.array(customerSchema).max(SYNC_BATCH_MAX_RECORDS),
  })
  .superRefine(checkReconciliation);
export type CustomerSyncBatch = z.infer<typeof customerSyncBatchSchema>;

export const syncBatchSchema = z.discriminatedUnion("kind", [
  productSyncBatchSchema,
  customerSyncBatchSchema,
]);
export type SyncBatch = z.infer<typeof syncBatchSchema>;

/**
 * Respuesta de POST /v1/sync/*. `duplicate` es true si el batch_id ya se habia procesado con
 * exito (reenvio del agente): no se repite el trabajo y los conteos desglosados no estan disponibles.
 */
export const syncResultSchema = z.strictObject({
  batch_id: z.uuid(),
  duplicate: z.boolean(),
  received: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative().nullable(),
  updated: z.number().int().nonnegative().nullable(),
  unchanged: z.number().int().nonnegative().nullable(),
  /** Registros desactivados por una reconciliacion completa (solo en su ultimo lote). */
  deactivated: z.number().int().nonnegative().nullable(),
});
export type SyncResult = z.infer<typeof syncResultSchema>;

/** Latido del agente (POST /v1/agent/heartbeat). */
export const heartbeatSchema = z.strictObject({
  agent_version: z.string().trim().min(1).max(64),
  /** Lotes que el agente tiene en su cola local sin enviar (por red caida, p. ej.). */
  queue_depth: z.number().int().nonnegative().optional(),
  /** Ultimo error del agente, si lo hay: la API lo anota en sync_logs. */
  last_error: z.string().trim().min(1).max(500).nullable().optional(),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

export const heartbeatResponseSchema = z.strictObject({
  ok: z.literal(true),
  /** Hora del servidor: el agente puede detectar un reloj desfasado. */
  server_time: z.iso.datetime(),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

/** Maximo que cabe en exchange_rates.rate_bs (NUMERIC(12,4)). */
export const EXCHANGE_RATE_MAX = 99_999_999.9999;

/** Cuerpo de POST /v1/orgs/:orgId/exchange-rate: solo la tasa; la fuente es siempre manual. */
export const exchangeRateInputSchema = z.strictObject({
  rate_bs: z.number().finite().positive().max(EXCHANGE_RATE_MAX),
});
export type ExchangeRateInput = z.infer<typeof exchangeRateInputSchema>;

/** Una fila del historial de tasas (exchange_rates). */
export const exchangeRateEntrySchema = z.strictObject({
  id: z.uuid(),
  org_id: z.uuid(),
  rate_bs: z.number().positive(),
  source: z.enum(["manual", "bcv"]),
  set_by: z.uuid().nullable(),
  created_at: z.iso.datetime(),
});
export type ExchangeRateEntry = z.infer<typeof exchangeRateEntrySchema>;

/** Tasa vigente. source/set_by/set_at son null si nunca se fijo una (la tasa por defecto es 1). */
export const currentExchangeRateSchema = z.strictObject({
  org_id: z.uuid(),
  rate_bs: z.number().positive(),
  source: z.enum(["manual", "bcv"]).nullable(),
  set_by: z.uuid().nullable(),
  set_at: z.iso.datetime().nullable(),
});
export type CurrentExchangeRate = z.infer<typeof currentExchangeRateSchema>;

export const exchangeRateHistoryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ExchangeRateHistoryQuery = z.infer<typeof exchangeRateHistoryQuerySchema>;

export const exchangeRateHistorySchema = z.strictObject({
  items: z.array(exchangeRateEntrySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type ExchangeRateHistory = z.infer<typeof exchangeRateHistorySchema>;

/** Maximo de lineas de un pedido y de unidades por linea (protege a la API y al ERP). */
export const ORDER_MAX_LINES = 200;
export const ORDER_MAX_QUANTITY = 1_000_000;

/**
 * Cuerpo de POST /v1/orgs/:orgId/orders. Solo SKU y cantidad: precios, total, tasa, cliente y
 * estado los fija el servidor, asi que el cliente no puede mandarlos.
 */
export const createOrderInputSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        sku: nonEmpty,
        quantity: z.number().int().positive().max(ORDER_MAX_QUANTITY),
      }),
    )
    .min(1)
    .max(ORDER_MAX_LINES),
  notes: z.string().trim().min(1).max(500).optional(),
});
export type CreateOrderInput = z.infer<typeof createOrderInputSchema>;

/** Pedido tal como lo devuelve la API: el contrato del agente mas su identidad. */
export const webOrderSchema = orderSchema.extend({
  id: z.uuid(),
  notes: z.string().nullable(),
  created_at: z.iso.datetime(),
});
export type WebOrder = z.infer<typeof webOrderSchema>;

export const pendingOrdersQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type PendingOrdersQuery = z.infer<typeof pendingOrdersQuerySchema>;

export const pendingOrdersSchema = z.strictObject({
  orders: z.array(webOrderSchema),
});
export type PendingOrders = z.infer<typeof pendingOrdersSchema>;

/** Cuerpo de POST /v1/orders/:orderId/confirm: el agente informa la referencia del borrador en el ERP. */
export const confirmOrderInputSchema = z.strictObject({
  erp_order_reference: z.string().trim().min(1).max(64),
});
export type ConfirmOrderInput = z.infer<typeof confirmOrderInputSchema>;

/** duplicate=true: el pedido ya estaba confirmado con esa misma referencia; no se cambio nada. */
export const confirmOrderResultSchema = z.strictObject({
  id: z.uuid(),
  status: orderStatusSchema,
  erp_order_reference: z.string(),
  synced_at: z.iso.datetime(),
  duplicate: z.boolean(),
});
export type ConfirmOrderResult = z.infer<typeof confirmOrderResultSchema>;

/** Largo máximo del motivo de un fallo permanente (cabe en la fila de web_orders y en el panel). */
export const ORDER_ERROR_DETAIL_MAX = 1000;

/** Cuerpo de POST /v1/orders/:orderId/fail: el ERP no puede aceptar el pedido y reintentar no lo arregla. */
export const failOrderInputSchema = z.strictObject({
  error_detail: z.string().trim().min(1).max(ORDER_ERROR_DETAIL_MAX),
});
export type FailOrderInput = z.infer<typeof failOrderInputSchema>;

/** duplicate=true: el pedido ya estaba en error; no se cambió nada (se conserva el primer motivo). */
export const failOrderResultSchema = z.strictObject({
  id: z.uuid(),
  status: orderStatusSchema,
  error_detail: z.string().nullable(),
  duplicate: z.boolean(),
});
export type FailOrderResult = z.infer<typeof failOrderResultSchema>;

/** changed=false: el pedido ya estaba pendiente de enviar; no se cambió nada. */
export const retryOrderResultSchema = z.strictObject({
  id: z.uuid(),
  status: orderStatusSchema,
  changed: z.boolean(),
});
export type RetryOrderResult = z.infer<typeof retryOrderResultSchema>;
