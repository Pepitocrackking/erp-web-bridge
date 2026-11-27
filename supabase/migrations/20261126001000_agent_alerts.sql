-- Fase 8 (tarea 8.2): aviso externo cuando el agente local deja de dar señales.
--
-- La API revisa periódicamente las organizaciones (si NOTIFY_WEBHOOK_URL está definida) y avisa UNA
-- vez cuando el agente cae y otra cuando vuelve. Esta columna es la memoria de ese aviso: no es nula
-- desde que se avisó la caída hasta que se avisa la recuperación. Así un reinicio de la API, o varias
-- instancias de la API a la vez, no repiten avisos.
--
-- No se concede a `authenticated`: los permisos de `organizations` son por columna (ver ..0200 y
-- ..0800), así que la web no la ve. Es estado interno de la API, que conecta como `postgres`.
ALTER TABLE public.organizations ADD COLUMN agent_offline_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN public.organizations.agent_offline_notified_at IS
  'Cuándo la API avisó (webhook) que el agente dejó de dar señales; NULL = sin aviso pendiente de recuperación.';
