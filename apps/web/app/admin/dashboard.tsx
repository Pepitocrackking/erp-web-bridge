"use client";

import { formatBs, formatUsd, usdToBs } from "@erp-web-bridge/shared-types";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PANEL_LIST_SIZE,
  agentStatus,
  customerAvailableUsd,
  fetchCustomers,
  fetchOrgStatus,
  canRetryOrder,
  mergeById,
  orderErrorText,
  orderStatusLabel,
  syncEntityLabel,
  toOrderRow,
  toRateEntry,
  toSyncLogRow,
  type CustomerRow,
  type OrderRow,
  type OrgStatus,
  type RateEntry,
  type SyncLogRow,
} from "../../lib/admin";
import { authorizeRealtime, createClient } from "../../lib/supabase/client";
import { RateForm } from "./rate-form";
import { RetryOrderButton } from "./retry-order-button";

export interface DashboardData {
  org: OrgStatus;
  rates: RateEntry[];
  customers: { rows: CustomerRow[]; total: number };
  orders: OrderRow[];
  logs: SyncLogRow[];
}

const BADGE = {
  online: "bg-emerald-100 text-emerald-800",
  offline: "bg-red-100 text-red-800",
  never: "bg-slate-200 text-slate-700",
} as const;

const ORDER_BADGE: Record<string, string> = {
  pending_sync: "bg-amber-100 text-amber-800",
  synced_to_erp: "bg-emerald-100 text-emerald-800",
  approved: "bg-emerald-100 text-emerald-800",
  error: "bg-red-100 text-red-800",
  rejected: "bg-red-100 text-red-800",
  cancelled: "bg-slate-200 text-slate-700",
};

/** Fecha y hora local del navegador. Se renderiza distinto en servidor y cliente: sin aviso de hidratación. */
function When({ iso }: { iso: string | null }) {
  return (
    <time dateTime={iso ?? undefined} suppressHydrationWarning>
      {iso ? new Date(iso).toLocaleString("es-VE") : "—"}
    </time>
  );
}

/** Reloj que se actualiza cada `ms`, para que "hace cuánto" y el estado del agente avancen solos. */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

export function AdminDashboard({
  orgId,
  canSetRate,
  initial,
}: {
  orgId: string;
  canSetRate: boolean;
  initial: DashboardData;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [org, setOrg] = useState(initial.org);
  const [rates, setRates] = useState(initial.rates);
  const [customers, setCustomers] = useState(initial.customers);
  const [orders, setOrders] = useState(initial.orders);
  const [logs, setLogs] = useState(initial.logs);
  const [live, setLive] = useState(false);
  const now = useNow(15_000);

  const refreshOrg = useCallback(async () => {
    try {
      setOrg(await fetchOrgStatus(supabase, orgId));
    } catch {
      // Un fallo puntual de red no debe romper el panel: el siguiente evento o sondeo lo corrige.
    }
  }, [supabase, orgId]);

  const refreshCustomers = useCallback(async () => {
    try {
      setCustomers(await fetchCustomers(supabase, orgId));
    } catch {
      // ídem
    }
  }, [supabase, orgId]);

  // El latido del agente cambia `organizations`, que no emite eventos: se relee cada 30 s.
  useEffect(() => {
    const timer = window.setInterval(refreshOrg, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshOrg]);

  // Supabase Realtime: cambios de la bitácora, los pedidos y las tasas de esta organización.
  useEffect(() => {
    const filter = `org_id=eq.${orgId}`;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    void authorizeRealtime(supabase).then((authorized) => {
      if (cancelled || !authorized) return;
      channel = supabase
        .channel(`admin-${orgId}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "sync_logs", filter },
          (payload) => {
            const row = toSyncLogRow(payload.new as Parameters<typeof toSyncLogRow>[0]);
            setLogs((list) => mergeById(list, row, PANEL_LIST_SIZE));
            void refreshOrg(); // last_sync_at cambió
            if (row.entity === "customers") void refreshCustomers();
          },
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "web_orders", filter },
          (payload) => {
            if (payload.eventType === "DELETE") return;
            const row = toOrderRow(payload.new as Parameters<typeof toOrderRow>[0]);
            setOrders((list) => mergeById(list, row, PANEL_LIST_SIZE));
          },
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "exchange_rates", filter },
          (payload) => {
            const entry = toRateEntry(payload.new as Parameters<typeof toRateEntry>[0]);
            setRates((list) => mergeById(list, entry, PANEL_LIST_SIZE));
            setOrg((o) => ({ ...o, rateBs: entry.rateBs }));
          },
        )
        .subscribe((status) => setLive(status === "SUBSCRIBED"));
    });
    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [supabase, orgId, refreshOrg, refreshCustomers]);

  const agent = agentStatus(org.lastHeartbeatAt, now);
  const customerName = useMemo(
    () => new Map(customers.rows.map((c) => [c.id, c.name])),
    [customers.rows],
  );

  return (
    <div className="flex flex-col gap-8">
      <section
        aria-label="Estado de sincronización"
        className="rounded-lg border border-slate-200 p-4"
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Estado de sincronización</h2>
          <span
            data-testid="live-status"
            className={`rounded px-2 py-1 text-xs font-medium ${live ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700"}`}
          >
            {live ? "En vivo" : "Conectando…"}
          </span>
        </div>
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-slate-600">Agente local</dt>
            <dd>
              <span
                data-testid="agent-status"
                className={`rounded px-2 py-1 text-sm font-medium ${BADGE[agent.level]}`}
              >
                {agent.text}
              </span>
              {org.agentVersion && (
                <span className="ml-2 text-xs text-slate-500">v{org.agentVersion}</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-slate-600">Última sincronización</dt>
            <dd data-testid="last-sync">
              <When iso={org.lastSyncAt} />
            </dd>
          </div>
          <div>
            <dt className="text-sm text-slate-600">Pedidos por enviar al ERP</dt>
            <dd data-testid="pending-orders">
              {orders.filter((o) => o.status === "pending_sync").length}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-label="Tasa de cambio" className="rounded-lg border border-slate-200 p-4">
        <h2 className="mb-3 text-lg font-semibold">Tasa de cambio</h2>
        <p className="mb-3">
          Vigente: <strong data-testid="current-rate">{formatBs(org.rateBs)}</strong> por USD
        </p>
        {canSetRate ? (
          <RateForm currentRate={org.rateBs} />
        ) : (
          <p className="text-sm text-slate-600">Solo un administrador puede cambiar la tasa.</p>
        )}
        <details className="mt-4">
          <summary className="cursor-pointer text-sm underline">Historial reciente</summary>
          <ul className="mt-2 text-sm" data-testid="rate-history">
            {rates.slice(0, 10).map((r) => (
              <li key={r.id} className="flex gap-3">
                <span>{formatBs(r.rateBs)}</span>
                <span className="text-slate-600">{r.source}</span>
                <When iso={r.createdAt} />
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section aria-label="Pedidos">
        <h2 className="mb-3 text-lg font-semibold">Pedidos</h2>
        {orders.length === 0 ? (
          <p className="text-slate-600">Aún no hay pedidos.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="orders-table">
              <thead>
                <tr className="border-b border-slate-300">
                  <th className="py-2">Pedido</th>
                  <th>Cliente</th>
                  <th>Total</th>
                  <th>Estado</th>
                  <th>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b border-slate-200" data-order-id={o.id}>
                    <td className="py-2 font-mono text-xs">{o.id.slice(0, 8)}</td>
                    <td>{customerName.get(o.customerId) ?? "—"}</td>
                    <td>
                      {formatUsd(o.totalUsd)}
                      <br />
                      <span className="text-xs text-slate-600">
                        {formatBs(usdToBs(o.totalUsd, o.rateUsed))}
                      </span>
                    </td>
                    <td>
                      <span
                        data-testid="order-status"
                        className={`rounded px-2 py-0.5 text-xs font-medium ${ORDER_BADGE[o.status] ?? "bg-slate-200"}`}
                      >
                        {orderStatusLabel(o.status)}
                      </span>
                      {o.erpReference && (
                        <span data-testid="order-ref" className="ml-1 text-xs text-slate-600">
                          {o.erpReference}
                        </span>
                      )}
                      {orderErrorText(o.status, o.errorDetail) && (
                        <p data-testid="order-error" className="mt-1 text-xs text-red-700">
                          <strong>Motivo:</strong> {orderErrorText(o.status, o.errorDetail)}
                        </p>
                      )}
                      {canRetryOrder(o.status) && <RetryOrderButton orderId={o.id} />}
                    </td>
                    <td>
                      <When iso={o.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-label="Clientes">
        <h2 className="mb-1 text-lg font-semibold">Clientes</h2>
        <p className="mb-3 text-sm text-slate-600" data-testid="customers-count">
          {customers.rows.length === customers.total
            ? `${customers.total} clientes`
            : `Mostrando ${customers.rows.length} de ${customers.total} clientes`}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="customers-table">
            <thead>
              <tr className="border-b border-slate-300">
                <th className="py-2">Código</th>
                <th>Cliente</th>
                <th>RIF</th>
                <th className="text-right">Límite</th>
                <th className="text-right">Deuda</th>
                <th className="text-right">Disponible</th>
              </tr>
            </thead>
            <tbody>
              {customers.rows.map((c) => (
                <tr key={c.id} className="border-b border-slate-200">
                  <td className="py-2 font-mono text-xs">{c.code}</td>
                  <td>
                    {c.name}
                    {!c.isActive && <span className="ml-1 text-xs text-slate-500">(inactivo)</span>}
                  </td>
                  <td>{c.taxId}</td>
                  <td className="text-right">{formatUsd(c.creditLimitUsd)}</td>
                  <td className="text-right">{formatUsd(c.debtUsd)}</td>
                  <td className="text-right">
                    {formatUsd(customerAvailableUsd(c.creditLimitUsd, c.debtUsd))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="Bitácora de sincronización">
        <h2 className="mb-3 text-lg font-semibold">Bitácora de sincronización</h2>
        {logs.length === 0 ? (
          <p className="text-slate-600">Todavía no hay sincronizaciones.</p>
        ) : (
          <ul className="text-sm" data-testid="sync-log">
            {logs.map((l) => (
              <li key={l.id} className="flex flex-wrap gap-x-3 border-b border-slate-200 py-2">
                <When iso={l.createdAt} />
                <span className="font-medium">{syncEntityLabel(l.entity)}</span>
                <span>{l.records} registros</span>
                <span className={l.status === "error" ? "text-red-700" : "text-emerald-800"}>
                  {l.status === "success"
                    ? "Correcta"
                    : l.status === "partial"
                      ? "Parcial"
                      : "Con error"}
                </span>
                {l.errorDetail && <span className="text-red-700">{l.errorDetail}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
