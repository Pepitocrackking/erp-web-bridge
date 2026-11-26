"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Cliente de Supabase del navegador: toma la sesión de las cookies y usa el JWT del usuario, así
 * que RLS decide qué lecturas y eventos de Realtime le llegan. Las variables `NEXT_PUBLIC_*`
 * deben escribirse literales para que Next las incruste al compilar.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

/**
 * Fija el JWT del usuario en Realtime ANTES de suscribirse. Si el canal se une primero con la clave
 * anónima, Realtime evalúa la suscripción con el rol `anon` (sin permiso de lectura) y la rechaza
 * con "invalid column for filter": el cliente aún no ha leído la sesión de las cookies.
 * Devuelve false si no hay sesión (entonces no se debe suscribir).
 */
export async function authorizeRealtime(
  supabase: ReturnType<typeof createClient>,
): Promise<boolean> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return false;
  await supabase.realtime.setAuth(session.access_token);
  return true;
}
