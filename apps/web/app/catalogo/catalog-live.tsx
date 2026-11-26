"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authorizeRealtime, createClient } from "../../lib/supabase/client";

/** Espera tras el último evento antes de recargar: una carga masiva no provoca una recarga por fila. */
const REFRESH_DELAY_MS = 400;

/**
 * Mantiene el catálogo al día: se suscribe a los cambios de productos y de la tasa de su
 * organización (Supabase Realtime, con el JWT del usuario: RLS decide qué eventos le llegan) y,
 * cuando algo cambia, vuelve a pedir la página al servidor. No pinta nada con el contenido del
 * evento: los precios siempre salen de la consulta con RLS.
 */
export function CatalogLive({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [live, setLive] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let timer: number | undefined;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => router.refresh(), REFRESH_DELAY_MS);
    };
    const filter = `org_id=eq.${orgId}`;

    void authorizeRealtime(supabase).then((authorized) => {
      if (cancelled || !authorized) return;
      channel = supabase
        .channel(`catalog-${orgId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "products", filter },
          refresh,
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "exchange_rates", filter },
          refresh,
        )
        .subscribe((status) => setLive(status === "SUBSCRIBED"));
    });

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [orgId, router]);

  return <span data-testid="catalog-live" data-state={live ? "live" : "connecting"} hidden />;
}
