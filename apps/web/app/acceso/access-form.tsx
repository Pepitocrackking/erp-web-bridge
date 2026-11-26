"use client";

import { useActionState } from "react";
import type { FormState } from "../../lib/form-state";
import { requestAccess } from "./actions";

const initial: FormState = { error: null };
const INPUT = "rounded border border-slate-300 px-3 py-2 text-base font-normal";

export function AccessForm({ empresa }: { empresa: string }) {
  const [state, action, pending] = useActionState(requestAccess, initial);
  return (
    <form action={action} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium">
        Código de la empresa
        <input name="empresa" defaultValue={empresa} required className={INPUT} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        RIF o cédula (como lo tiene tu proveedor)
        <input name="taxId" required className={INPUT} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Razón social (opcional)
        <input name="businessName" className={INPUT} />
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-red-700">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
      >
        {pending ? "Enviando…" : "Solicitar acceso"}
      </button>
    </form>
  );
}
