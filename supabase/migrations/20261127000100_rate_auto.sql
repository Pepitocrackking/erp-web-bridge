-- Fase 9 (tareas 9.2 a 9.4): tasa de cambio automática (BCV).
--
-- Cada organización puede activar la lectura automática de la tasa oficial. La API (que conecta
-- como `postgres`) revisa periódicamente las organizaciones activadas y registra la tasa en
-- `exchange_rates` con source = 'bcv' solo si cambió. Estas columnas guardan la configuración
-- (la cambia un administrador con `set_rate_auto_settings`) y el resultado de la última revisión
-- (lo escribe la API; el panel lo muestra y avisa si falla).
--
-- rate_auto_status:
--   ok               se registró una tasa nueva.
--   unchanged        la fuente respondió y la tasa es la misma.
--   manual_priority  hay una tasa manual de hoy y la organización pidió respetarla.
--   source_failed    ninguna fuente respondió: se conserva la última tasa.
--   jump_rejected    la lectura varió demasiado frente a la tasa vigente: no se aplicó.
ALTER TABLE public.organizations
  ADD COLUMN rate_auto_enabled          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN rate_auto_interval_minutes INT NOT NULL DEFAULT 60
    CHECK (rate_auto_interval_minutes BETWEEN 15 AND 1440),
  ADD COLUMN rate_auto_respect_manual   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN rate_auto_checked_at       TIMESTAMPTZ,
  ADD COLUMN rate_auto_ok_at            TIMESTAMPTZ,
  ADD COLUMN rate_auto_status           TEXT
    CHECK (rate_auto_status IN ('ok', 'unchanged', 'manual_priority', 'source_failed', 'jump_rejected')),
  ADD COLUMN rate_auto_detail           TEXT CHECK (rate_auto_detail IS NULL OR length(rate_auto_detail) <= 500),
  ADD COLUMN rate_auto_provider         TEXT;

COMMENT ON COLUMN public.organizations.rate_auto_checked_at IS
  'Última vez que la API reclamó esta organización para actualizar la tasa (también evita que dos instancias lo hagan a la vez).';

-- El panel lee la configuración y el estado. La escritura va solo por la función de abajo.
GRANT SELECT (
  rate_auto_enabled, rate_auto_interval_minutes, rate_auto_respect_manual,
  rate_auto_checked_at, rate_auto_ok_at, rate_auto_status, rate_auto_detail, rate_auto_provider
) ON public.organizations TO authenticated;

-- ---------------------------------------------------------------------------
-- set_rate_auto_settings: un owner/admin activa o desactiva la tasa automática.
-- SECURITY DEFINER porque `authenticated` no tiene UPDATE sobre estas columnas; valida ella misma
-- quién llama. Misma respuesta si la organización no existe o no se administra (forbidden).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.set_rate_auto_settings(
  p_org_id           UUID,
  p_enabled          BOOLEAN,
  p_interval_minutes INT,
  p_respect_manual   BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT private.is_org_admin(p_org_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_interval_minutes IS NULL OR p_interval_minutes NOT BETWEEN 15 AND 1440 THEN
    RAISE EXCEPTION 'invalid_interval' USING ERRCODE = '22023';
  END IF;
  UPDATE public.organizations
     SET rate_auto_enabled = p_enabled,
         rate_auto_interval_minutes = p_interval_minutes,
         rate_auto_respect_manual = p_respect_manual,
         -- Al activarla se revisa en la siguiente vuelta, no dentro de una hora.
         rate_auto_checked_at = CASE WHEN p_enabled AND NOT rate_auto_enabled THEN NULL ELSE rate_auto_checked_at END
   WHERE id = p_org_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_rate_auto_settings(UUID, BOOLEAN, INT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_rate_auto_settings(UUID, BOOLEAN, INT, BOOLEAN)
  TO authenticated;
