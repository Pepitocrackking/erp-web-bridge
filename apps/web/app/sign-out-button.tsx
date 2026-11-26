"use client";

import { signOut } from "./login/actions";
import { clearPrivateCache } from "./pwa";

/** Cerrar sesión: antes de salir se olvidan las páginas guardadas para uso sin conexión (son de este usuario). */
export function SignOutButton({ className = "underline" }: { className?: string }) {
  return (
    <form action={signOut} onSubmit={() => clearPrivateCache()}>
      <button className={className}>Salir</button>
    </form>
  );
}
