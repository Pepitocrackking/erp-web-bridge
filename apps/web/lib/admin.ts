import { EXCHANGE_RATE_MAX } from "@erp-web-bridge/shared-types";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Un agente que no ha dado señales en este tiempo se considera sin conexión (el latido es cada minuto). */
export const AGENT_ONLINE_WINDOW_MS = 3 * 60_000;

export interface AgentStatus {
  level: "online" | "offline" | "never";
  text: string;
}

export function agentStatus(lastHeartbeatAt: string | null, nowMs: number): AgentStatus {
  const seen = lastHeartbeatAt ? Date.parse(lastHeartbeatAt) : Number.NaN;
  if (Number.isNaN(seen)) return { level: "never", text: "Nunca se ha conectado" };
  const age = nowMs - seen;
  if (age < AGENT_ONLINE_WINDOW_MS) return { level: "online", text: "Conectado" };
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return { level: "offline", text: `Sin conexión desde hace ${minutes} min` };
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return { level: "offline", text: `Sin conexión desde hace ${hours} h` };
  return { level: "offline", text: `Sin conexión desde hace ${Math.floor(hours / 24)} d` };
}

export type AlertLevel = "error" | "warning" | "info";

export interface PanelAlert {
  id: "agent-offline" | "agent-never" | "orders-error";
  level: AlertLevel;
  title: string;
  detail: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Lo que el personal debe ver al abrir el panel, de lo más grave a lo menos. Sale del mismo estado
 * que el resto del panel (latido del agente y pedidos), así que se actualiza en vivo.
 */
export function panelAlerts(input: {
  agent: AgentStatus;
  orders: readonly { status: string }[];
}): PanelAlert[] {
  const alerts: PanelAlert[] = [];
  const waiting = input.orders.filter((o) => o.status === "pending_sync").length;
  const failed = input.orders.filter((o) => o.status === "error").length;

  if (input.agent.level === "offline") {
    const waitingText =
      waiting > 0
        ? ` ${waiting === 1 ? "1 pedido espera al agente" : `${waiting} pedidos esperan al agente`} para llegar al ERP.`
        : "";
    alerts.push({
      id: "agent-offline",
      level: "error",
      title: "El agente local no responde",
      detail: `${input.agent.text}. El catálogo muestra el último estado válido: precios y existencias pueden estar desactualizados.${waitingText}`,
    });
  } else if (input.agent.level === "never") {
    alerts.push({
      id: "agent-never",
      level: "info",
      title: "Aún no hay un agente conectado",
      detail:
        "Instala el agente en el equipo del ERP (erp-agent service install) con la clave de esta organización para empezar a sincronizar.",
    });
  }
  if (failed > 0) {
    alerts.push({
      id: "orders-error",
      level: "warning",
      title: `${plural(failed, "pedido", "pedidos")} con error`,
      detail: "El ERP no los aceptó. Revisa el motivo en la lista de pedidos y usa «Reintentar».",
    });
  }
  return alerts;
}

/** Resumen para la cabecera: cuántas alertas piden atención (la informativa no cuenta) y su gravedad. */
export function alertSummary(alerts: readonly PanelAlert[]): {
  count: number;
  level: AlertLevel | null;
  label: string;
} {
  const count = alerts.filter((a) => a.level !== "info").length;
  const level = alerts.some((a) => a.level === "error")
    ? "error"
    : alerts.some((a) => a.level === "warning")
      ? "warning"
      : alerts.length > 0
        ? "info"
        : null;
  return { count, level, label: count === 0 ? "Sin alertas" : plural(count, "alerta", "alertas") };
}

/** Pone `row` al principio (lo más nuevo primero) o la reemplaza en su sitio si ya estaba; recorta a `max`. */
export function mergeById<T extends { id: string }>(list: T[], row: T, max: number): T[] {
  const index = list.findIndex((item) => item.id === row.id);
  if (index >= 0) return list.map((item, i) => (i === index ? row : item));
  return [row, ...list].slice(0, max);
}

const ORDER_LABELS: Record<string, string> = {
  pending_sync: "Pendiente de enviar al ERP",
  synced_to_erp: "Enviado al ERP",
  approved: "Aprobado",
  rejected: "Rechazado",
  cancelled: "Anulado",
  error: "Error",
};
export const orderStatusLabel = (status: string) => ORDER_LABELS[status] ?? status;

/** Un id de pedido es un UUID; la acción de reintento lo comprueba antes de armar la URL de la API. */
export const isOrderId = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Solo un pedido en error se puede reintentar desde el panel. */
export const canRetryOrder = (status: string) => status === "error";

/**
 * Motivo del error de un pedido tal como lo ve el personal. Un pedido en error siempre muestra
 * algo (aunque el agente no mandara detalle); en otros estados solo si hay un motivo guardado.
 */
export function orderErrorText(status: string, detail: string | null): string | null {
  const text = detail?.trim();
  if (text) return text;
  return status === "error" ? "El ERP no aceptó el pedido (sin más detalle)." : null;
}

/** Traduce la respuesta de POST /v1/orgs/:orgId/orders/:orderId/retry a un mensaje para el personal. */
export function retryOutcome(
  status: number,
  body: { status?: string; changed?: boolean } | null,
): { error: string | null; info?: string } {
  if (status === 200) {
    return body?.changed === false
      ? { error: null, info: "El pedido ya estaba pendiente de enviar al ERP." }
      : {
          error: null,
          info: "El pedido volvió a la cola: el agente lo enviará al ERP en su próximo ciclo.",
        };
  }
  if (status === 403) return { error: "Solo el personal de la empresa puede reintentar pedidos." };
  if (status === 404) return { error: "No se encontró el pedido." };
  if (status === 409) {
    const now = body?.status ? orderStatusLabel(body.status) : "otro estado";
    return { error: `El pedido ya no está en error (ahora: ${now}), no se puede reintentar.` };
  }
  if (status === 429) return { error: "Demasiados intentos seguidos. Espera un minuto." };
  return { error: "No se pudo reintentar el pedido. Inténtalo de nuevo." };
}

const ENTITY_LABELS: Record<string, string> = {
  products: "Productos",
  customers: "Clientes",
  orders: "Pedidos",
  heartbeat: "Latido del agente",
};
export const syncEntityLabel = (entity: string) => ENTITY_LABELS[entity] ?? entity;

/** Crédito libre de un cliente según el ERP (límite - deuda), en centavos para no arrastrar decimales. */
export function customerAvailableUsd(limitUsd: number, debtUsd: number): number {
  return Math.max(Math.round(limitUsd * 100) - Math.round(debtUsd * 100), 0) / 100;
}

/** Tasa escrita por el administrador: acepta coma o punto, hasta 4 decimales; null si no es válida. */
export function parseRateInput(text: string): number | null {
  const cleaned = text.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,4})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return value > 0 && value <= EXCHANGE_RATE_MAX ? value : null;
}

// ---------------------------------------------------------------------------
// Lecturas con el JWT del usuario (RLS decide qué ve). Sirven en el servidor y en el navegador.
// ---------------------------------------------------------------------------

export interface OrgStatus {
  name: string;
  rateBs: number;
  lastSyncAt: string | null;
  lastHeartbeatAt: string | null;
  agentVersion: string | null;
}

export interface RateEntry {
  id: string;
  rateBs: number;
  source: string;
  createdAt: string;
}

export interface CustomerRow {
  id: string;
  code: string;
  name: string;
  taxId: string;
  creditLimitUsd: number;
  debtUsd: number;
  isActive: boolean;
}

export interface OrderRow {
  id: string;
  customerId: string;
  status: string;
  totalUsd: number;
  rateUsed: number;
  erpReference: string | null;
  errorDetail: string | null;
  createdAt: string;
}

export interface SyncLogRow {
  id: string;
  entity: string;
  direction: string;
  records: number;
  status: string;
  errorDetail: string | null;
  createdAt: string;
}

export const PANEL_LIST_SIZE = 50;

function must<T>(
  result: { data: T | null; error: { message: string } | null },
  what: string,
): NonNullable<T> {
  if (result.error) throw new Error(`No se pudo leer ${what}: ${result.error.message}`);
  if (result.data === null || result.data === undefined) {
    throw new Error(`No se encontró ${what}`);
  }
  return result.data as NonNullable<T>;
}

export async function fetchOrgStatus(supabase: SupabaseClient, orgId: string): Promise<OrgStatus> {
  const { data: o, error } = await supabase
    .from("organizations")
    .select("name, exchange_rate_bs, last_sync_at, last_heartbeat_at, agent_version")
    .eq("id", orgId)
    .single();
  if (error) throw new Error(`No se pudo leer la organización: ${error.message}`);
  return {
    name: o.name,
    rateBs: Number(o.exchange_rate_bs),
    lastSyncAt: o.last_sync_at,
    lastHeartbeatAt: o.last_heartbeat_at,
    agentVersion: o.agent_version,
  };
}

interface RateDbRow {
  id: string;
  rate_bs: number | string;
  source: string;
  created_at: string;
}
export const toRateEntry = (r: RateDbRow): RateEntry => ({
  id: r.id,
  rateBs: Number(r.rate_bs),
  source: r.source,
  createdAt: r.created_at,
});

export async function fetchRates(supabase: SupabaseClient, orgId: string): Promise<RateEntry[]> {
  const rows = must(
    await supabase
      .from("exchange_rates")
      .select("id, rate_bs, source, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(PANEL_LIST_SIZE),
    "las tasas",
  );
  return (rows as RateDbRow[]).map(toRateEntry);
}

export async function fetchCustomers(
  supabase: SupabaseClient,
  orgId: string,
): Promise<{ rows: CustomerRow[]; total: number }> {
  const result = await supabase
    .from("b2b_customers")
    .select(
      "id, erp_customer_code, business_name, tax_id, credit_limit_usd, current_debt_usd, is_active",
      {
        count: "exact",
      },
    )
    .eq("org_id", orgId)
    .order("business_name", { ascending: true })
    .limit(200);
  const data = must(result, "los clientes");
  return {
    total: result.count ?? data.length,
    rows: data.map((c) => ({
      id: c.id,
      code: c.erp_customer_code,
      name: c.business_name,
      taxId: c.tax_id,
      creditLimitUsd: Number(c.credit_limit_usd),
      debtUsd: Number(c.current_debt_usd),
      isActive: c.is_active,
    })),
  };
}

interface OrderDbRow {
  id: string;
  customer_id: string;
  status: string;
  total_usd: number | string;
  exchange_rate_used: number | string;
  erp_order_reference: string | null;
  error_detail: string | null;
  created_at: string;
}
export const toOrderRow = (o: OrderDbRow): OrderRow => ({
  id: o.id,
  customerId: o.customer_id,
  status: o.status,
  totalUsd: Number(o.total_usd),
  rateUsed: Number(o.exchange_rate_used),
  erpReference: o.erp_order_reference,
  errorDetail: o.error_detail,
  createdAt: o.created_at,
});

export async function fetchOrders(supabase: SupabaseClient, orgId: string): Promise<OrderRow[]> {
  const rows = must(
    await supabase
      .from("web_orders")
      .select(
        "id, customer_id, status, total_usd, exchange_rate_used, erp_order_reference, error_detail, created_at",
      )
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(PANEL_LIST_SIZE),
    "los pedidos",
  );
  return (rows as OrderDbRow[]).map(toOrderRow);
}

interface LogDbRow {
  id: string;
  entity: string;
  direction: string;
  records_processed: number;
  status: string;
  error_detail: string | null;
  created_at: string;
}
export const toSyncLogRow = (l: LogDbRow): SyncLogRow => ({
  id: l.id,
  entity: l.entity,
  direction: l.direction,
  records: l.records_processed,
  status: l.status,
  errorDetail: l.error_detail,
  createdAt: l.created_at,
});

export async function fetchSyncLogs(
  supabase: SupabaseClient,
  orgId: string,
): Promise<SyncLogRow[]> {
  const rows = must(
    await supabase
      .from("sync_logs")
      .select("id, entity, direction, records_processed, status, error_detail, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(PANEL_LIST_SIZE),
    "la bitácora",
  );
  return (rows as LogDbRow[]).map(toSyncLogRow);
}
