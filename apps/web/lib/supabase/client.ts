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
