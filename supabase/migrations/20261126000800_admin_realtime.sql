-- Fase 6, tarea 6.4: panel de administración en tiempo real.
--
-- 1. Supabase Realtime solo emite los cambios de las tablas que están en la publicación
--    `supabase_realtime` (viene vacía). Se añaden las tres que el panel sigue en vivo:
--    bitácora de sincronización, pedidos y tasas. Realtime aplica RLS con el JWT de cada
--    suscriptor: un usuario solo recibe los eventos de filas que ya puede leer.
--    `organizations` no se publica a propósito: tiene permisos por columna (api_key_hash no se
--    puede leer) y los eventos de Realtime los evalúa con el rol del suscriptor; el panel relee
--    la fila cuando llega un evento de la bitácora.
--
-- 2. El panel muestra si el agente está conectado, así que los usuarios pueden leer las dos
--    columnas del latido (la 0200 solo concedió las columnas anteriores).

DO $$
BEGIN
  -- La publicación la crea la imagen de Postgres de Supabase; si el entorno no la trae (p. ej. un
  -- CI sin el servicio Realtime), se crea aquí con el mismo nombre que espera Realtime.
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    -- Idempotente: solo se añade lo que aún no está.
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sync_logs'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.sync_logs;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'web_orders'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.web_orders;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'exchange_rates'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.exchange_rates;
    END IF;
  END IF;
END
$$;

GRANT SELECT (last_heartbeat_at, agent_version) ON public.organizations TO authenticated;
