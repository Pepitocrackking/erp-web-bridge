/**
 * Configuración pública de Supabase. Son variables `NEXT_PUBLIC_*`: la clave `anon` es pública por
 * diseño (lo que protege los datos es RLS), nunca se usa aquí la `service_role`.
 */
export function supabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY (ver .env.example).",
    );
  }
  return { url, anonKey };
}
