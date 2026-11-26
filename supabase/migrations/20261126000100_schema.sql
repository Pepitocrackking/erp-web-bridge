-- Esquema multi-tenant del puente ERP-a-Web.
--
-- Correspondencia con los contratos de `packages/shared-types` (snake_case canónico):
--   sku            -> products.erp_sku
--   active         -> products.is_active / b2b_customers.is_active
--   customer_code  -> b2b_customers.erp_customer_code
--   items          -> web_orders.items (JSONB; cada ítem lleva `sku`, no un id interno)
--   status         -> web_orders.status (mismos valores que ORDER_STATUSES)
--
-- Todo precio y costo se guarda en USD. Los Bs se calculan en la nube con la tasa vigente.
-- El costo del ERP NO se almacena: el catálogo lo lee el cliente B2B y no debe exponerlo.
--
-- Las claves únicas (org_id, id) permiten claves foráneas compuestas, de modo que una fila
-- de un tenant nunca puede apuntar a una fila de otro tenant, ni siquiera con service_role.
-- Las políticas RLS están en la migración siguiente.

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
CREATE TABLE public.organizations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  slug             TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  erp_type         TEXT NOT NULL CHECK (erp_type IN ('saint', 'odoo', 'chrystal', 'mock')),
  -- Tasa vigente (Bs por USD). La mantiene el trigger de exchange_rates.
  exchange_rate_bs NUMERIC(12, 4) NOT NULL DEFAULT 1.0000 CHECK (exchange_rate_bs > 0),
  last_sync_at     TIMESTAMPTZ,
  -- SHA-256 (hex) de la x-api-key del agente. La clave tiene alta entropía, así que se busca
  -- directamente por hash; el texto plano nunca se guarda.
  api_key_hash     TEXT NOT NULL UNIQUE,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- price_lists: listas de precio (Saint expone Precio1/2/3)
-- ---------------------------------------------------------------------------
CREATE TABLE public.price_lists (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  code       TEXT NOT NULL CHECK (length(btrim(code)) > 0),
  name       TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, code),
  UNIQUE (org_id, id)
);

-- A lo sumo una lista por defecto por organización.
CREATE UNIQUE INDEX price_lists_one_default_per_org
  ON public.price_lists (org_id) WHERE is_default;

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
CREATE TABLE public.products (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  erp_sku     TEXT NOT NULL CHECK (length(btrim(erp_sku)) > 0),
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  description TEXT,
  category    TEXT,
  -- Imágenes del catálogo (URLs). Las gestiona el panel, no el ERP.
  image_urls  TEXT[] NOT NULL DEFAULT '{}',
  -- Precio base (lista por defecto) que viaja en el lote de sincronización.
  price_usd   NUMERIC(12, 2) NOT NULL CHECK (price_usd >= 0),
  stock       NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (stock >= 0),
  sync_hash   TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, erp_sku),
  UNIQUE (org_id, id)
);

CREATE INDEX products_org_active_idx ON public.products (org_id, is_active);
CREATE INDEX products_org_category_idx ON public.products (org_id, category);

-- ---------------------------------------------------------------------------
-- product_prices: precio de un producto en una lista (la base vive en products.price_usd)
-- ---------------------------------------------------------------------------
CREATE TABLE public.product_prices (
  org_id        UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  product_id    UUID NOT NULL,
  price_list_id UUID NOT NULL,
  price_usd     NUMERIC(12, 2) NOT NULL CHECK (price_usd >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, price_list_id),
  FOREIGN KEY (org_id, product_id) REFERENCES public.products (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, price_list_id) REFERENCES public.price_lists (org_id, id) ON DELETE CASCADE
);

CREATE INDEX product_prices_org_idx ON public.product_prices (org_id);
CREATE INDEX product_prices_list_idx ON public.product_prices (price_list_id);

-- ---------------------------------------------------------------------------
-- b2b_customers
-- ---------------------------------------------------------------------------
CREATE TABLE public.b2b_customers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  erp_customer_code TEXT NOT NULL CHECK (length(btrim(erp_customer_code)) > 0),
  tax_id            TEXT NOT NULL CHECK (length(btrim(tax_id)) > 0),
  business_name     TEXT NOT NULL CHECK (length(btrim(business_name)) > 0),
  credit_limit_usd  NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (credit_limit_usd >= 0),
  -- Puede ser negativa (saldo a favor del cliente), igual que en el contrato.
  current_debt_usd  NUMERIC(12, 2) NOT NULL DEFAULT 0,
  price_list_id     UUID,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, erp_customer_code),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, price_list_id) REFERENCES public.price_lists (org_id, id)
);

CREATE INDEX b2b_customers_price_list_idx ON public.b2b_customers (org_id, price_list_id);

-- ---------------------------------------------------------------------------
-- org_members: quién pertenece a qué organización y con qué rol
-- ---------------------------------------------------------------------------
CREATE TABLE public.org_members (
  org_id      UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  -- owner/admin/staff: personal de la organización. customer: comprador B2B de un cliente.
  role        TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff', 'customer')),
  customer_id UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id),
  -- Un usuario con rol customer debe estar atado a un cliente; el personal, no.
  CHECK ((role = 'customer') = (customer_id IS NOT NULL)),
  FOREIGN KEY (org_id, customer_id) REFERENCES public.b2b_customers (org_id, id) ON DELETE CASCADE
);

CREATE INDEX org_members_user_idx ON public.org_members (user_id);

-- ---------------------------------------------------------------------------
-- exchange_rates: historial de tasas (la última fila manda)
-- ---------------------------------------------------------------------------
CREATE TABLE public.exchange_rates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  rate_bs    NUMERIC(12, 4) NOT NULL CHECK (rate_bs > 0),
  source     TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'bcv')),
  set_by     UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX exchange_rates_org_created_idx ON public.exchange_rates (org_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- web_orders: pedidos de la web; llegan al ERP solo como borradores
-- ---------------------------------------------------------------------------
CREATE TABLE public.web_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  customer_id         UUID NOT NULL,
  -- pending_sync: esperando al agente. synced_to_erp: el agente creó el borrador en el ERP.
  -- approved: el ERP lo aprobó. rejected: el ERP lo rechazó. cancelled: anulado antes del ERP.
  -- error: el agente no pudo crearlo (ver error_detail).
  status              TEXT NOT NULL DEFAULT 'pending_sync'
    CHECK (status IN ('pending_sync', 'synced_to_erp', 'approved', 'rejected', 'cancelled', 'error')),
  erp_order_reference TEXT,
  error_detail        TEXT,
  notes               TEXT,
  total_usd           NUMERIC(12, 2) NOT NULL CHECK (total_usd >= 0),
  exchange_rate_used  NUMERIC(12, 4) NOT NULL CHECK (exchange_rate_used > 0),
  items               JSONB NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) > 0),
  synced_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, customer_id) REFERENCES public.b2b_customers (org_id, id)
);

CREATE INDEX web_orders_org_status_idx ON public.web_orders (org_id, status, created_at);
CREATE INDEX web_orders_customer_idx ON public.web_orders (org_id, customer_id);

-- ---------------------------------------------------------------------------
-- sync_logs: bitácora de cada sincronización y latido del agente
-- ---------------------------------------------------------------------------
CREATE TABLE public.sync_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  direction         TEXT NOT NULL CHECK (direction IN ('erp_to_cloud', 'cloud_to_erp')),
  entity            TEXT NOT NULL CHECK (entity IN ('products', 'customers', 'orders', 'heartbeat')),
  batch_id          UUID,
  records_processed INT NOT NULL DEFAULT 0 CHECK (records_processed >= 0),
  status            TEXT NOT NULL CHECK (status IN ('success', 'partial', 'error')),
  error_detail      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sync_logs_org_created_idx ON public.sync_logs (org_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
CREATE TRIGGER organizations_set_updated_at BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER product_prices_set_updated_at BEFORE UPDATE ON public.product_prices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER b2b_customers_set_updated_at BEFORE UPDATE ON public.b2b_customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER web_orders_set_updated_at BEFORE UPDATE ON public.web_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Registrar una tasa nueva actualiza la tasa vigente de la organización. SECURITY DEFINER
-- porque quien registra la tasa no necesariamente puede actualizar `organizations`.
CREATE FUNCTION public.apply_exchange_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.organizations
     SET exchange_rate_bs = NEW.rate_bs
   WHERE id = NEW.org_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_exchange_rate() FROM PUBLIC;

CREATE TRIGGER exchange_rates_apply AFTER INSERT ON public.exchange_rates
  FOR EACH ROW EXECUTE FUNCTION public.apply_exchange_rate();
