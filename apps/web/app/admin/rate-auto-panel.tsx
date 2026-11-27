"use client";

import { useActionState, useEffect } from "react";
import {
  RATE_AUTO_INTERVALS,
  intervalLabel,
  rateAutoStatusText,
  type RateAutoState,
} from "../../lib/admin";
import type { FormState } from "../../lib/form-state";
import { refreshRateAuto, saveRateAuto } from "./actions";

const initial: FormState = { error: null, info: null };

const STATUS_COLOR: Record<string, string> = {
  ok: "text-emerald-800",
  unchanged: "text-emerald-800",
  manual_priority: "text-slate-700",
  source_failed: "text-amber-800",
  jump_rejected: "text-amber-800",
};

function When({ iso }: { iso: string | null }) {
  return (
    <time dateTime={iso ?? undefined} suppressHydrationWarning>
      {iso ? new Date(iso).toLocaleString("es-VE") : "—"}
    </time>
  );
}

/**
 * Tasa automática (BCV): interruptor, intervalo, prioridad de la tasa manual, resultado de la
 * última lectura y «Actualizar ahora». Solo un administrador cambia algo; el resto solo lee.
 */
export function RateAutoPanel({
  auto,
  canEdit,
  onChanged,
}: {
  auto: RateAutoState;
  canEdit: boolean;
  /** Se llama tras guardar o actualizar, para releer el estado de la organización. */
  onChanged: () => void;
}) {
  const [saveState, save, saving] = useActionState(saveRateAuto, initial);
  const [refreshState, refresh, refreshing] = useActionState(refreshRateAuto, initial);

  useEffect(() => {
    if (saveState.info || saveState.error) onChanged();
  }, [saveState, onChanged]);
  useEffect(() => {
    if (refreshState.info || refreshState.error) onChanged();
  }, [refreshState, onChanged]);

  return (
    <div
      data-testid="rate-auto"
      data-enabled={auto.enabled ? "true" : "false"}
      className="mt-4 rounded border border-slate-200 p-3"
    >
      <h3 className="mb-2 text-sm font-semibold">Tasa automática (BCV)</h3>
      <p className="mb-3 text-sm">
        <span data-testid="rate-auto-status" data-status={auto.status ?? "none"}>
          <span className={auto.status ? (STATUS_COLOR[auto.status] ?? "") : "text-slate-600"}>
            {rateAutoStatusText(auto)}
          </span>
        </span>
        {auto.enabled && (
          <span className="ml-2 text-xs text-slate-600">
            Última revisión: <When iso={auto.checkedAt} /> · cada{" "}
            {intervalLabel(auto.intervalMinutes)}
          </span>
        )}
      </p>

      {canEdit ? (
        <>
          <form action={save} className="flex flex-wrap items-end gap-4">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={auto.enabled}
                key={`e-${auto.enabled}`}
                data-testid="rate-auto-enabled"
              />
              Actualizar automáticamente
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Revisar cada
              <select
                name="interval"
                defaultValue={auto.intervalMinutes}
                key={`i-${auto.intervalMinutes}`}
                className="rounded border border-slate-300 px-2 py-1 font-normal"
              >
                {(RATE_AUTO_INTERVALS.includes(auto.intervalMinutes)
                  ? RATE_AUTO_INTERVALS
                  : [...RATE_AUTO_INTERVALS, auto.intervalMinutes].sort((a, b) => a - b)
                ).map((m) => (
                  <option key={m} value={m}>
                    {intervalLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="respectManual"
                defaultChecked={auto.respectManual}
                key={`r-${auto.respectManual}`}
              />
              Respetar la tasa manual de hoy
            </label>
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
            >
              {saving ? "Guardando…" : "Guardar"}
            </button>
            {saveState.error && (
              <p role="alert" className="w-full text-sm text-red-700">
                {saveState.error}
              </p>
            )}
            {saveState.info && (
              <p role="status" className="w-full text-sm text-emerald-800">
                {saveState.info}
              </p>
            )}
          </form>

          <form action={refresh} className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={refreshing}
              data-testid="rate-auto-refresh"
              className="rounded border border-slate-400 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-60"
            >
              {refreshing ? "Consultando…" : "Actualizar ahora"}
            </button>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input type="checkbox" name="force" />
              Aceptar aunque cambie mucho o haya una tasa manual de hoy
            </label>
            {refreshState.error && (
              <p role="alert" className="w-full text-sm text-red-700">
                {refreshState.error}
              </p>
            )}
            {refreshState.info && (
              <p role="status" className="w-full text-sm text-emerald-800">
                {refreshState.info}
              </p>
            )}
          </form>
        </>
      ) : (
        <p className="text-sm text-slate-600">
          Solo un administrador puede configurar la tasa automática.
        </p>
      )}
    </div>
  );
}
