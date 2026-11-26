"use client";

import { useActionState } from "react";
import type { FormState } from "../../lib/form-state";
import { setExchangeRate } from "./actions";

const initial: FormState = { error: null, info: null };

export function RateForm({ currentRate }: { currentRate: number }) {
  const [state, action, pending] = useActionState(setExchangeRate, initial);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-sm font-medium">
        Nueva tasa (Bs por USD)
        <input
          name="rate"
          inputMode="decimal"
          defaultValue={String(currentRate).replace(".", ",")}
          required
          className="w-36 rounded border border-slate-300 px-3 py-2 font-normal"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
      >
        {pending ? "Guardando…" : "Fijar tasa"}
      </button>
      {state.error && (
        <p role="alert" className="w-full text-sm text-red-700">
          {state.error}
        </p>
      )}
      {state.info && (
        <p role="status" className="w-full text-sm text-emerald-800">
          {state.info}
        </p>
      )}
    </form>
  );
}
