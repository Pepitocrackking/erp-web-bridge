"use client";

import { useActionState } from "react";
import type { FormState } from "../../lib/form-state";
import { register } from "./actions";

const initial: FormState = { error: null, info: null };
const INPUT = "rounded border border-slate-300 px-3 py-2 text-base font-normal";

export function RegisterForm({ empresa }: { empresa: string }) {
  const [state, action, pending] = useActionState(register, initial);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="empresa" value={empresa} />
      <label className="flex flex-col gap-1 text-sm font-medium">
        Correo
        <input name="email" type="email" autoComplete="email" required className={INPUT} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Contraseña (mínimo 8 caracteres)
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          className={INPUT}
        />
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-red-700">
          {state.error}
        </p>
      )}
      {state.info && (
        <p role="status" className="text-sm text-emerald-800">
          {state.info}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
      >
        {pending ? "Creando cuenta…" : "Crear cuenta"}
      </button>
    </form>
  );
}
