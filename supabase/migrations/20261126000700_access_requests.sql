-- Fase 6, tarea 6.2: registro de compradores B2B con aprobación del administrador.
--
-- Flujo:
--   1. El comprador crea su cuenta con Supabase Auth (signUp). Hasta aquí no pertenece a ninguna
--      organización, así que RLS no le deja ver nada del catálogo.
--   2. Pide acceso a una empresa con `request_customer_access(slug, RIF, razón social)`. Se crea
--      una solicitud `pending`. No puede escribir en la tabla directamente: solo por la función.
--   3. Un owner/admin de esa empresa la aprueba con `approve_access_request`, que crea la
--      membresía `customer` atada al cliente del ERP cuyo RIF coincide (o al que el admin elija),
--      o la rechaza con `reject_access_request`.
--
-- Las funciones son SECURITY DEFINER (necesitan escribir en org_members y leer auth.users) y
-- por eso validan ellas mismas quién llama y a qué organización pertenece cada fila. Se
-- conceden solo a `authenticated`; `anon` y PUBLIC no pueden ejecutarlas.
--
-- Códigos de error (mensaje de la excepción; la web los traduce):
--   unauthenticated, invalid_tax_id, org_not_found, already_member, request_not_pending,
--   customer_not_found, no_matching_customer, ambiguous_customer, forbidden (42501).

-- RIF/cédula comparables: sin guiones, puntos ni espacios y en mayúsculas ("j-30.000001-1" = "J300000011").
CREATE FUNCTION private.normalize_tax_id(p_tax_id TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$ SELECT upper(regexp_replace(coalesce(p_tax_id, ''), '[^A-Za-z0-9]', '', 'g')) $$;

CREATE TABLE public.customer_access_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  -- Copiado de auth.users al pedir acceso, para que el admin sepa quién es sin leer auth.
  email         TEXT NOT NULL,
  -- Nombre de la empresa al pedir acceso: el solicitante aún no es miembro y no puede leer `organizations`.
  org_name      TEXT NOT NULL,
  tax_id        TEXT NOT NULL CHECK (length(btrim(tax_id)) BETWEEN 1 AND 40),
  business_name TEXT CHECK (business_name IS NULL OR length(business_name) <= 200),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  -- Cliente del ERP al que quedó atado el comprador (solo si se aprobó).
  customer_id   UUID,
  decision_note TEXT CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  decided_by    UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id),
  FOREIGN KEY (org_id, customer_id) REFERENCES public.b2b_customers (org_id, id),
  -- Una solicitud aprobada siempre tiene cliente y decisión; una pendiente, ninguna.
  CHECK (
    (status = 'approved') = (customer_id IS NOT NULL)
    AND (status = 'pending') = (decided_at IS NULL)
  )
);

CREATE INDEX customer_access_requests_org_status_idx
  ON public.customer_access_requests (org_id, status, created_at);
CREATE INDEX customer_access_requests_user_idx ON public.customer_access_requests (user_id);

CREATE TRIGGER customer_access_requests_set_updated_at BEFORE UPDATE ON public.customer_access_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.customer_access_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_access_requests FROM anon, authenticated;

-- Solo lectura: el solicitante ve la suya (para saber si sigue pendiente) y los administradores
-- ven las de su organización. Toda escritura pasa por las funciones de abajo.
GRANT SELECT ON public.customer_access_requests TO authenticated;
CREATE POLICY customer_access_requests_select ON public.customer_access_requests
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR private.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- request_customer_access: el comprador pide acceso a una empresa por su slug.
-- Pedir otra vez actualiza la solicitud (p. ej. tras un rechazo, con el RIF corregido).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.request_customer_access(
  p_org_slug      TEXT,
  p_tax_id        TEXT,
  p_business_name TEXT DEFAULT NULL
)
RETURNS public.customer_access_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_org   UUID;
  v_name  TEXT;
  v_email TEXT;
  v_req   public.customer_access_requests;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF length(btrim(coalesce(p_tax_id, ''))) NOT BETWEEN 1 AND 40
     OR private.normalize_tax_id(p_tax_id) = '' THEN
    RAISE EXCEPTION 'invalid_tax_id';
  END IF;

  SELECT o.id, o.name INTO v_org, v_name
    FROM public.organizations o
   WHERE o.slug = lower(btrim(coalesce(p_org_slug, ''))) AND o.is_active;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'org_not_found';
  END IF;

  IF EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = v_org AND m.user_id = v_uid) THEN
    RAISE EXCEPTION 'already_member';
  END IF;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = v_uid;

  INSERT INTO public.customer_access_requests (org_id, user_id, email, org_name, tax_id, business_name)
  VALUES (v_org, v_uid, coalesce(v_email, ''), v_name, btrim(p_tax_id), nullif(btrim(coalesce(p_business_name, '')), ''))
  ON CONFLICT (org_id, user_id) DO UPDATE
    SET tax_id        = EXCLUDED.tax_id,
        business_name = EXCLUDED.business_name,
        email         = EXCLUDED.email,
        org_name      = EXCLUDED.org_name,
        status        = 'pending',
        customer_id   = NULL,
        decision_note = NULL,
        decided_by    = NULL,
        decided_at    = NULL
  RETURNING * INTO v_req;
  RETURN v_req;
END;
$$;

-- ---------------------------------------------------------------------------
-- approve_access_request: un admin de la empresa aprueba y ata al comprador a un cliente.
-- Sin p_customer_id, el cliente es el único activo cuyo RIF coincide con el de la solicitud.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.approve_access_request(p_request_id UUID, p_customer_id UUID DEFAULT NULL)
RETURNS public.customer_access_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_req      public.customer_access_requests;
  v_customer UUID;
  v_matches  INT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_req FROM public.customer_access_requests WHERE id = p_request_id FOR UPDATE;
  -- Misma respuesta si no existe o es de otra empresa: no se revela qué ids existen.
  IF NOT FOUND OR NOT private.is_org_admin(v_req.org_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'request_not_pending';
  END IF;

  IF p_customer_id IS NOT NULL THEN
    SELECT c.id INTO v_customer
      FROM public.b2b_customers c
     WHERE c.id = p_customer_id AND c.org_id = v_req.org_id AND c.is_active;
    IF v_customer IS NULL THEN
      RAISE EXCEPTION 'customer_not_found';
    END IF;
  ELSE
    SELECT count(*), min(c.id::text)::uuid INTO v_matches, v_customer
      FROM public.b2b_customers c
     WHERE c.org_id = v_req.org_id AND c.is_active
       AND private.normalize_tax_id(c.tax_id) = private.normalize_tax_id(v_req.tax_id);
    IF v_matches = 0 THEN
      RAISE EXCEPTION 'no_matching_customer';
    ELSIF v_matches > 1 THEN
      RAISE EXCEPTION 'ambiguous_customer';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.org_members m WHERE m.org_id = v_req.org_id AND m.user_id = v_req.user_id
  ) THEN
    RAISE EXCEPTION 'already_member';
  END IF;

  INSERT INTO public.org_members (org_id, user_id, role, customer_id)
  VALUES (v_req.org_id, v_req.user_id, 'customer', v_customer);

  UPDATE public.customer_access_requests
     SET status = 'approved', customer_id = v_customer, decided_by = v_uid, decided_at = now()
   WHERE id = v_req.id
  RETURNING * INTO v_req;
  RETURN v_req;
END;
$$;

-- ---------------------------------------------------------------------------
-- reject_access_request
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.reject_access_request(p_request_id UUID, p_note TEXT DEFAULT NULL)
RETURNS public.customer_access_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_req public.customer_access_requests;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_req FROM public.customer_access_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR NOT private.is_org_admin(v_req.org_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'request_not_pending';
  END IF;

  UPDATE public.customer_access_requests
     SET status = 'rejected', decision_note = left(nullif(btrim(coalesce(p_note, '')), ''), 500),
         decided_by = v_uid, decided_at = now()
   WHERE id = v_req.id
  RETURNING * INTO v_req;
  RETURN v_req;
END;
$$;

-- ---------------------------------------------------------------------------
-- Permisos: solo usuarios autenticados pueden ejecutar las funciones de la API.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.request_customer_access(TEXT, TEXT, TEXT),
  public.approve_access_request(UUID, UUID),
  public.reject_access_request(UUID, TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.request_customer_access(TEXT, TEXT, TEXT),
  public.approve_access_request(UUID, UUID),
  public.reject_access_request(UUID, TEXT)
TO authenticated;

-- normalize_tax_id solo la usan las funciones de arriba (que corren como su dueño).
REVOKE ALL ON FUNCTION private.normalize_tax_id(TEXT) FROM PUBLIC;
