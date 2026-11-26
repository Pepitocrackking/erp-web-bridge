-- Fase 6, tarea 6.6: el catálogo web se actualiza en vivo cuando llega una sincronización.
--
-- `products` entra en la publicación de Realtime. Realtime aplica RLS con el JWT de cada
-- suscriptor: el personal recibe todos los cambios de su organización y un comprador solo los de
-- productos activos (políticas products_select). Un cliente nunca recibe eventos de otra
-- organización. La web filtra además por `org_id` y, al recibir un evento, vuelve a pedir la
-- página (no confía en el contenido del evento para pintar precios).
--
-- Coste: una carga inicial grande (miles de filas) genera un evento por fila para quien esté
-- suscrito; la web los agrupa con una espera corta antes de recargar.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'products'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.products;
  END IF;
END
$$;
