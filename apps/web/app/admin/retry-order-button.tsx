"use client";

import { useActionState } from "react";
import type { FormState } from "../../lib/form-state";
import { retryOrder } from "./actions";

const initial: FormState = { error: null, info: null };

/** Botón «Reintentar» de un pedido en error. El nuevo estado llega al panel por Realtime. */
export function RetryOrderButton({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState(retryOrder, initial);
  return (
    <form action={action} className="mt-1 flex flex-wrap items-center gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-slate-400 px-2 py-0.5 text-xs font-medium hover:bg-slate-100 disabled:opacity-60"
      >
        {pending ? "Reintentando…" : "Reintentar"}
      </button>
      {state.error && (
        <span role="alert" className="text-xs text-red-700">
          {state.error}
        </span>
      )}
      {state.info && (
        <span role="status" className="text-xs text-emerald-800">
          {state.info}
        </span>
      )}
    </form>
  );
}
