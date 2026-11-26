-- Row Level Security por organización (tenant).
--
-- Modelo de acceso:
--   * Usuarios web (rol Postgres `authenticated`): ven y tocan solo lo de las organizaciones
--     a las que pertenecen (org_members), según su rol:
--       owner/admin  administran la organización.
--       staff        personal: lectura de todo el catálogo, clientes, pedidos y bitácora.
--       customer     comprador B2B: solo su cliente, sus pedidos y el catálogo activo.
--   * `anon` no tiene acceso a nada.
--   * El agente y la API de ingesta usan service_role (BYPASSRLS) y comprueban la x-api-key
--     en la API; por eso aquí no hay políticas de escritura para sincronización.
--
-- Defensa en profundidad: además de RLS, se revocan los permisos por defecto de Supabase y se
-- conceden solo los necesarios (por columna donde hace falta). Un permiso omitido aquí es una
-- escritura denegada, no un hueco.
--
-- Nota: no se usa FORCE ROW LEVEL SECURITY porque las funciones auxiliares (SECURITY DEFINER,
-- dueño postgres) deben leer org_members saltándose RLS para evitar recursión.

-- ---------------------------------------------------------------------------
-- Funciones auxiliares, en un esquema no expuesto por la API REST
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE FUNCTION private.org_role(p_org UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.role
    FROM public.org_members m
   WHERE m.org_id = p_org AND m.user_id = (SELECT auth.uid())
$$;

CREATE FUNCTION private.is_org_member(p_org UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$ SELECT private.org_role(p_org) IS NOT NULL $$;

CREATE FUNCTION private.is_org_staff(p_org UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$ SELECT coalesce(private.org_role(p_org) IN ('owner', 'admin', 'staff'), false) $$;

CREATE FUNCTION private.is_org_admin(p_org UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$ SELECT coalesce(private.org_role(p_org) IN ('owner', 'admin'), false) $$;

CREATE FUNCTION private.is_org_owner(p_org UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$ SELECT coalesce(private.org_role(p_org) = 'owner', false) $$;

-- Cliente B2B al que está atado el usuario (NULL si es personal o no es miembro).
CREATE FUNCTION private.member_customer_id(p_org UUID)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.customer_id
    FROM public.org_members m
   WHERE m.org_id = p_org AND m.user_id = (SELECT auth.uid())
$$;

-- Lista de precios de su cliente B2B (NULL si no aplica).
CREATE FUNCTION private.member_price_list_id(p_org UUID)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.price_list_id
    FROM public.org_members m
    JOIN public.b2b_customers c ON c.org_id = m.org_id AND c.id = m.customer_id
   WHERE m.org_id = p_org AND m.user_id = (SELECT auth.uid())
$$;

REVOKE ALL ON FUNCTION
  private.org_role(UUID), private.is_org_member(UUID), private.is_org_staff(UUID),
  private.is_org_admin(UUID), private.is_org_owner(UUID), private.member_customer_id(UUID),
  private.member_price_list_id(UUID)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  private.org_role(UUID), private.is_org_member(UUID), private.is_org_staff(UUID),
  private.is_org_admin(UUID), private.is_org_owner(UUID), private.member_customer_id(UUID),
  private.member_price_list_id(UUID)
TO authenticated;

-- Las funciones de trigger no deben ser invocables desde la API.
REVOKE ALL ON FUNCTION public.set_updated_at(), public.apply_exchange_rate()
  FROM PUBLIC, anon, authenticated;

-- Lo que se cree después en `public` no queda expuesto por defecto: cada migración concede
-- explícitamente lo que necesite.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Activar RLS y partir de cero en permisos
-- ---------------------------------------------------------------------------
ALTER TABLE public.organizations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_lists     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_prices  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.b2b_customers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_rates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.web_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_logs       ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON
  public.organizations, public.org_members, public.price_lists, public.products,
  public.product_prices, public.b2b_customers, public.exchange_rates, public.web_orders,
  public.sync_logs
FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- organizations: api_key_hash nunca sale por la API de usuarios (SELECT por columna).
-- Consecuencia: `select *` falla para authenticated; hay que listar columnas.
-- ---------------------------------------------------------------------------
GRANT SELECT (id, name, slug, erp_type, exchange_rate_bs, last_sync_at, is_active, created_at, updated_at)
  ON public.organizations TO authenticated;
GRANT UPDATE (name) ON public.organizations TO authenticated;

CREATE POLICY organizations_select ON public.organizations
  FOR SELECT TO authenticated USING (private.is_org_member(id));
CREATE POLICY organizations_update ON public.organizations
  FOR UPDATE TO authenticated
  USING (private.is_org_admin(id)) WITH CHECK (private.is_org_admin(id));

-- ---------------------------------------------------------------------------
-- org_members: cada quien ve su fila; los administradores ven y gestionan la organización.
-- Solo un owner puede crear, tocar o quitar owners (evita escalada de privilegios).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_members TO authenticated;

CREATE POLICY org_members_select ON public.org_members
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR private.is_org_admin(org_id));
CREATE POLICY org_members_insert ON public.org_members
  FOR INSERT TO authenticated
  WITH CHECK (private.is_org_owner(org_id) OR (private.is_org_admin(org_id) AND role <> 'owner'));
CREATE POLICY org_members_update ON public.org_members
  FOR UPDATE TO authenticated
  USING (private.is_org_owner(org_id) OR (private.is_org_admin(org_id) AND role <> 'owner'))
  WITH CHECK (private.is_org_owner(org_id) OR (private.is_org_admin(org_id) AND role <> 'owner'));
CREATE POLICY org_members_delete ON public.org_members
  FOR DELETE TO authenticated
  USING (private.is_org_owner(org_id) OR (private.is_org_admin(org_id) AND role <> 'owner'));

-- ---------------------------------------------------------------------------
-- price_lists y product_prices: el personal ve todo; el cliente solo su lista.
-- Los administradores las gestionan.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.price_lists TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_prices TO authenticated;

CREATE POLICY price_lists_select ON public.price_lists
  FOR SELECT TO authenticated
  USING (private.is_org_staff(org_id) OR id = private.member_price_list_id(org_id));
CREATE POLICY price_lists_insert ON public.price_lists
  FOR INSERT TO authenticated WITH CHECK (private.is_org_admin(org_id));
CREATE POLICY price_lists_update ON public.price_lists
  FOR UPDATE TO authenticated
  USING (private.is_org_admin(org_id)) WITH CHECK (private.is_org_admin(org_id));
CREATE POLICY price_lists_delete ON public.price_lists
  FOR DELETE TO authenticated USING (private.is_org_admin(org_id));

CREATE POLICY product_prices_select ON public.product_prices
  FOR SELECT TO authenticated
  USING (private.is_org_staff(org_id) OR price_list_id = private.member_price_list_id(org_id));
CREATE POLICY product_prices_insert ON public.product_prices
  FOR INSERT TO authenticated WITH CHECK (private.is_org_admin(org_id));
CREATE POLICY product_prices_update ON public.product_prices
  FOR UPDATE TO authenticated
  USING (private.is_org_admin(org_id)) WITH CHECK (private.is_org_admin(org_id));
CREATE POLICY product_prices_delete ON public.product_prices
  FOR DELETE TO authenticated USING (private.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- products: los datos vienen del ERP (service_role). Los administradores solo editan lo
-- que el ERP no conoce: descripción e imágenes. El cliente solo ve productos activos.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.products TO authenticated;
GRANT UPDATE (description, image_urls) ON public.products TO authenticated;

CREATE POLICY products_select ON public.products
  FOR SELECT TO authenticated
  USING (private.is_org_staff(org_id) OR (private.is_org_member(org_id) AND is_active));
CREATE POLICY products_update ON public.products
  FOR UPDATE TO authenticated
  USING (private.is_org_admin(org_id)) WITH CHECK (private.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- b2b_customers: vienen del ERP. El personal ve todos; el cliente, solo el suyo.
-- Los administradores pueden asignar la lista de precios.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.b2b_customers TO authenticated;
GRANT UPDATE (price_list_id) ON public.b2b_customers TO authenticated;

CREATE POLICY b2b_customers_select ON public.b2b_customers
  FOR SELECT TO authenticated
  USING (private.is_org_staff(org_id) OR id = private.member_customer_id(org_id));
CREATE POLICY b2b_customers_update ON public.b2b_customers
  FOR UPDATE TO authenticated
  USING (private.is_org_admin(org_id)) WITH CHECK (private.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- exchange_rates: lo leen todos los miembros (el catálogo muestra Bs); lo registra un
-- administrador, a su nombre, y solo como 'manual'. El historial es inmutable.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.exchange_rates TO authenticated;
GRANT INSERT (org_id, rate_bs, source, set_by) ON public.exchange_rates TO authenticated;

CREATE POLICY exchange_rates_select ON public.exchange_rates
  FOR SELECT TO authenticated USING (private.is_org_member(org_id));
CREATE POLICY exchange_rates_insert ON public.exchange_rates
  FOR INSERT TO authenticated
  WITH CHECK (
    private.is_org_admin(org_id)
    AND source = 'manual'
    AND set_by = (SELECT auth.uid())
  );

-- ---------------------------------------------------------------------------
-- web_orders: el personal ve todos; el cliente, los suyos. Los pedidos se CREAN solo desde
-- la API (service_role), que valida el límite de crédito y calcula totales. El personal
-- puede anular un pedido que aún no llegó al ERP.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.web_orders TO authenticated;
GRANT UPDATE (status, notes) ON public.web_orders TO authenticated;

CREATE POLICY web_orders_select ON public.web_orders
  FOR SELECT TO authenticated
  USING (private.is_org_staff(org_id) OR customer_id = private.member_customer_id(org_id));
CREATE POLICY web_orders_cancel ON public.web_orders
  FOR UPDATE TO authenticated
  USING (private.is_org_staff(org_id) AND status IN ('pending_sync', 'error'))
  WITH CHECK (private.is_org_staff(org_id) AND status = 'cancelled');

-- ---------------------------------------------------------------------------
-- sync_logs: solo lectura para el personal. Los escribe la API.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.sync_logs TO authenticated;

CREATE POLICY sync_logs_select ON public.sync_logs
  FOR SELECT TO authenticated USING (private.is_org_staff(org_id));
