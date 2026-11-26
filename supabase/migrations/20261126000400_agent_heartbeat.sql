-- Fase 4 (API, tarea 4.4): latido del agente local.
-- Cada heartbeat actualiza estas dos columnas en lugar de insertar una fila en sync_logs, para no
-- generar un registro por minuto y por organización; sync_logs solo guarda los latidos que
-- reportan un error del agente.
ALTER TABLE public.organizations ADD COLUMN last_heartbeat_at TIMESTAMPTZ;
ALTER TABLE public.organizations ADD COLUMN agent_version TEXT;
