"use client";

import { useMemo, useState, useTransition } from "react";
import { changedRows, rowErrors, SIMULATOR_MAX_CHANGES, type SimRow } from "../../../lib/simulator";
import { syncSimulatedInventory, type SyncOutcome } from "./actions";

const INPUT = "w-full rounded border border-slate-300 px-2 py-1 text-sm";

const EMPTY_NEW = { sku: "", name: "", category: "", priceUsd: "", stock: "" };

export function Simulator({ initial }: { initial: SimRow[] }) {
  const [baseline, setBaseline] = useState(initial);
  const [rows, setRows] = useState(initial);
  const [draft, setDraft] = useState(EMPTY_NEW);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, startSending] = useTransition();

  const pending = useMemo(() => changedRows(baseline, rows), [baseline, rows]);
  const pendingSkus = useMemo(() => new Set(pending.map((r) => r.sku.trim())), [pending]);
  const invalid = pending.some((r) => rowErrors(r).length > 0);

  function edit(sku: string, change: Partial<SimRow>) {
    setResult(null);
    setRows((list) => list.map((r) => (r.sku === sku ? { ...r, ...change } : r)));
  }

  function addRow() {
    const row: SimRow = {
      sku: draft.sku.trim(),
      name: draft.name.trim(),
      category: draft.category.trim() || null,
      priceUsd: Number(draft.priceUsd.replace(",", ".")),
      stock: Number(draft.stock.replace(",", ".")),
      active: true,
    };
    const errors = rowErrors(row);
    if (draft.priceUsd.trim() === "" || draft.stock.trim() === "") {
      errors.push("Indica precio y existencia.");
    }
    if (rows.some((r) => r.sku.trim() === row.sku)) errors.push("Ya existe ese código.");
    if (errors.length > 0) {
      setDraftError(errors[0]!);
      return;
    }
    setDraftError(null);
    setResult(null);
    setRows((list) => [row, ...list]);
    setDraft(EMPTY_NEW);
  }

  function send() {
    setResult(null);
    startSending(async () => {
      const res = await syncSimulatedInventory(pending);
      if (res.ok) {
        const o: SyncOutcome = res.outcome;
        // Lo enviado pasa a ser la copia sincronizada: ya no hay cambios pendientes.
        setBaseline(rows);
        setResult({
          ok: true,
          text: `Sincronización completa: ${o.received} enviados, ${o.inserted} nuevos, ${o.updated} actualizados, ${o.unchanged} sin cambios.`,
        });
      } else {
        setResult({ ok: false, text: res.message });
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Agregar producto" className="rounded-lg border border-slate-200 p-4">
        <h2 className="mb-3 font-semibold">Agregar un producto al inventario</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
          {(
            [
              ["sku", "Código"],
              ["name", "Descripción"],
              ["category", "Categoría"],
              ["priceUsd", "Precio USD"],
              ["stock", "Existencia"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex flex-col gap-1 text-xs font-medium">
              {label}
              <input
                value={draft[key]}
                onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                inputMode={key === "priceUsd" || key === "stock" ? "decimal" : undefined}
                className={INPUT}
              />
            </label>
          ))}
          <div className="flex items-end">
            <button
              onClick={addRow}
              className="w-full rounded border border-emerald-700 px-3 py-1 text-sm font-medium text-emerald-800 hover:bg-emerald-50"
            >
              Agregar
            </button>
          </div>
        </div>
        {draftError && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {draftError}
          </p>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={send}
          disabled={
            pending.length === 0 || invalid || pending.length > SIMULATOR_MAX_CHANGES || sending
          }
          className="rounded bg-emerald-700 px-5 py-2 font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {sending ? "Sincronizando…" : "Sincronizar con la nube"}
        </button>
        <p className="text-sm text-slate-700" data-testid="pending-changes">
          {pending.length === 0
            ? "Sin cambios pendientes"
            : pending.length === 1
              ? "1 cambio pendiente"
              : `${pending.length} cambios pendientes`}
        </p>
        {invalid && (
          <p role="alert" className="text-sm text-red-700">
            Hay filas con errores: corrígelas para poder sincronizar.
          </p>
        )}
      </div>
      {result && (
        <p
          role={result.ok ? "status" : "alert"}
          data-testid="sync-result"
          className={`rounded p-3 text-sm ${result.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}
        >
          {result.text}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm" data-testid="inventory-table">
          <caption className="sr-only">Inventario del ERP simulado</caption>
          <thead>
            <tr className="border-b border-slate-300">
              <th className="py-2">Código</th>
              <th>Descripción</th>
              <th>Categoría</th>
              <th>Precio USD</th>
              <th>Existencia</th>
              <th>Activo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const errors = rowErrors(r);
              const changed = pendingSkus.has(r.sku.trim());
              return (
                <tr
                  key={r.sku}
                  data-sku={r.sku}
                  data-changed={changed}
                  className={`border-b border-slate-200 ${changed ? "bg-amber-50" : ""}`}
                >
                  <td className="py-2 font-mono text-xs">{r.sku}</td>
                  <td>
                    <input
                      aria-label={`Descripción de ${r.sku}`}
                      value={r.name}
                      onChange={(e) => edit(r.sku, { name: e.target.value })}
                      className={INPUT}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Categoría de ${r.sku}`}
                      value={r.category ?? ""}
                      onChange={(e) => edit(r.sku, { category: e.target.value || null })}
                      className={INPUT}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Precio de ${r.sku}`}
                      type="number"
                      step="0.01"
                      min="0"
                      value={Number.isNaN(r.priceUsd) ? "" : r.priceUsd}
                      onChange={(e) => edit(r.sku, { priceUsd: e.target.valueAsNumber })}
                      className={`${INPUT} w-28`}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Existencia de ${r.sku}`}
                      type="number"
                      step="1"
                      min="0"
                      value={Number.isNaN(r.stock) ? "" : r.stock}
                      onChange={(e) => edit(r.sku, { stock: e.target.valueAsNumber })}
                      className={`${INPUT} w-24`}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Activo ${r.sku}`}
                      type="checkbox"
                      checked={r.active}
                      onChange={(e) => edit(r.sku, { active: e.target.checked })}
                    />
                    {errors.length > 0 && <p className="text-xs text-red-700">{errors[0]}</p>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
