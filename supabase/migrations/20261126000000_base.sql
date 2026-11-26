-- Migración base: extensiones y utilidades compartidas por el resto del esquema.
-- Idempotente en lo posible (IF NOT EXISTS / CREATE OR REPLACE).

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Mantiene `updated_at` al día en cualquier tabla que tenga esa columna.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
