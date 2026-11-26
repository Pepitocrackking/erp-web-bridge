-- Seed de desarrollo: dos organizaciones de prueba. SOLO para entornos locales/demo.
--
-- Re-aplicable: todos los ids son fijos y cada INSERT lleva ON CONFLICT DO NOTHING, así que
-- ejecutarlo varias veces no duplica ni cambia nada. Se aplica solo tras `supabase db reset`;
-- para re-aplicarlo a mano: `docker exec -i supabase_db_erp-web-bridge psql -U postgres < supabase/seed.sql`.
--
-- Organización A  "Distribuidora Demo" (erp_type saint)   slug demo-saint
--   API key de desarrollo:  erp_dev_demo_saint_key
-- Organización B  "Comercial Beta" (erp_type mock)         slug demo-mock
--   API key de desarrollo:  erp_dev_demo_mock_key
-- Solo se guarda el hash SHA-256 de cada clave. Contraseña de todos los usuarios: demo1234
--   admin@demo-saint.test    owner de A          cliente@demo-saint.test  customer de A (C00001)
--   staff@demo-saint.test    staff de A          admin@demo-mock.test     owner de B

-- ---------------------------------------------------------------------------
-- Usuarios (auth.users + auth.identities, para poder iniciar sesión de verdad)
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
)
SELECT
  '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
  extensions.crypt('demo1234', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''
FROM (VALUES
  ('a0000000-0000-4000-8000-000000000001'::uuid, 'admin@demo-saint.test'),
  ('a0000000-0000-4000-8000-000000000002'::uuid, 'staff@demo-saint.test'),
  ('a0000000-0000-4000-8000-000000000003'::uuid, 'cliente@demo-saint.test'),
  ('a0000000-0000-4000-8000-000000000004'::uuid, 'admin@demo-mock.test')
) AS u (id, email)
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
SELECT
  u.id::text, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  'email', now(), now(), now()
FROM auth.users u
WHERE u.id IN (
  'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000004'
)
ON CONFLICT (provider_id, provider) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Organizaciones
-- ---------------------------------------------------------------------------
INSERT INTO public.organizations (id, name, slug, erp_type, api_key_hash) VALUES
  ('b0000000-0000-4000-8000-00000000000a', 'Distribuidora Demo', 'demo-saint', 'saint',
   encode(extensions.digest('erp_dev_demo_saint_key', 'sha256'), 'hex')),
  ('b0000000-0000-4000-8000-00000000000b', 'Comercial Beta', 'demo-mock', 'mock',
   encode(extensions.digest('erp_dev_demo_mock_key', 'sha256'), 'hex'))
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Listas de precio
-- ---------------------------------------------------------------------------
INSERT INTO public.price_lists (id, org_id, code, name, is_default) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000a', 'L1', 'Detal',      true),
  ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000a', 'L2', 'Mayorista',  false),
  ('c0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-00000000000a', 'L3', 'Distribuidor', false),
  ('c0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-00000000000b', 'L1', 'General',     true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Productos: 30 para A y 15 para B. Precios y existencias deterministas.
-- ---------------------------------------------------------------------------
INSERT INTO public.products (id, org_id, erp_sku, name, description, category, image_urls, price_usd, stock, sync_hash, is_active)
SELECT
  ('d0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'b0000000-0000-4000-8000-00000000000a',
  'P' || lpad(n::text, 5, '0'),
  'Producto demo ' || n,
  CASE WHEN n % 3 = 0 THEN 'Descripción de ejemplo del producto ' || n ELSE NULL END,
  (ARRAY['Alimentos', 'Bebidas', 'Limpieza', 'Cuidado personal', 'Papelería'])[1 + n % 5],
  CASE WHEN n % 4 = 0 THEN ARRAY['https://example.com/img/p' || n || '.jpg'] ELSE '{}'::text[] END,
  round((1 + (n * 37 % 900) / 10.0)::numeric, 2),
  (n * 13 % 200)::numeric,
  encode(extensions.digest('P' || lpad(n::text, 5, '0') || '|' || n || '|demo', 'sha256'), 'hex'),
  n % 10 <> 0   -- cada décimo producto está inactivo
FROM generate_series(1, 30) AS n
ON CONFLICT DO NOTHING;

INSERT INTO public.products (id, org_id, erp_sku, name, category, price_usd, stock, sync_hash, is_active)
SELECT
  ('d1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'b0000000-0000-4000-8000-00000000000b',
  'M' || lpad(n::text, 4, '0'),
  'Artículo beta ' || n,
  (ARRAY['Ferretería', 'Eléctrico', 'Hogar'])[1 + n % 3],
  round((2 + (n * 53 % 500) / 10.0)::numeric, 2),
  (n * 7 % 100)::numeric,
  encode(extensions.digest('M' || lpad(n::text, 4, '0') || '|' || n || '|beta', 'sha256'), 'hex'),
  true
FROM generate_series(1, 15) AS n
ON CONFLICT DO NOTHING;

-- Precios por lista de A: mayorista -10 % y distribuidor -18 % sobre el precio base.
INSERT INTO public.product_prices (org_id, product_id, price_list_id, price_usd)
SELECT p.org_id, p.id, l.id,
       round((p.price_usd * (1 - CASE l.code WHEN 'L2' THEN 0.10 ELSE 0.18 END))::numeric, 2)
FROM public.products p
JOIN public.price_lists l ON l.org_id = p.org_id AND l.code IN ('L2', 'L3')
WHERE p.org_id = 'b0000000-0000-4000-8000-00000000000a'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Clientes B2B (algunos cerca o por encima de su límite de crédito)
-- ---------------------------------------------------------------------------
INSERT INTO public.b2b_customers (id, org_id, erp_customer_code, tax_id, business_name, credit_limit_usd, current_debt_usd, price_list_id) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000a', 'C00001', 'J-30000001-1', 'Abastos La Esquina C.A.',    5000, 1200.50, 'c0000000-0000-4000-8000-000000000002'),
  ('e0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000a', 'C00002', 'J-30000002-2', 'Bodegón El Progreso',        2000, 1950.00, 'c0000000-0000-4000-8000-000000000002'),
  ('e0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-00000000000a', 'C00003', 'J-30000003-3', 'Licorería Los Andes',         1000, 1250.00, 'c0000000-0000-4000-8000-000000000001'),
  ('e0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-00000000000a', 'C00004', 'J-30000004-4', 'Mayorista Oriente S.A.',    20000, 3000.00, 'c0000000-0000-4000-8000-000000000003'),
  ('e0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-00000000000a', 'C00005', 'V-12345678-9', 'Pedro Pérez (contado)',         0,    0.00, NULL),
  ('e1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b', 'C00001', 'J-40000001-1', 'Ferretería Central',         3000,  500.00, 'c0000000-0000-4000-8000-000000000004'),
  ('e1000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000b', 'C00002', 'J-40000002-2', 'Electro Hogar C.A.',          1500, 1400.00, 'c0000000-0000-4000-8000-000000000004')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Membresías
-- ---------------------------------------------------------------------------
INSERT INTO public.org_members (org_id, user_id, role, customer_id) VALUES
  ('b0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001', 'owner',    NULL),
  ('b0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000002', 'staff',    NULL),
  ('b0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000003', 'customer', 'e0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000004', 'owner',    NULL)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Tasas de cambio (el trigger deja vigente la última insertada) y un par de pedidos y logs
-- ---------------------------------------------------------------------------
INSERT INTO public.exchange_rates (id, org_id, rate_bs, source, set_by, created_at) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000a', 36.2000, 'manual', 'a0000000-0000-4000-8000-000000000001', '2026-11-24 12:00:00+00'),
  ('f0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000a', 36.5000, 'manual', 'a0000000-0000-4000-8000-000000000001', '2026-11-25 12:00:00+00'),
  ('f1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b', 36.5000, 'manual', 'a0000000-0000-4000-8000-000000000004', '2026-11-25 12:00:00+00')
ON CONFLICT DO NOTHING;

INSERT INTO public.web_orders (id, org_id, customer_id, status, erp_order_reference, total_usd, exchange_rate_used, items, synced_at, created_at) VALUES
  ('aa000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000a', 'e0000000-0000-4000-8000-000000000001',
   'pending_sync', NULL, 25.00, 36.5000,
   '[{"sku":"P00001","quantity":10,"unit_price_usd":1.5},{"sku":"P00002","quantity":5,"unit_price_usd":2.0}]'::jsonb,
   NULL, '2026-11-26 09:00:00+00'),
  ('aa000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000a', 'e0000000-0000-4000-8000-000000000004',
   'synced_to_erp', 'PED-000123', 120.00, 36.2000,
   '[{"sku":"P00003","quantity":20,"unit_price_usd":6.0}]'::jsonb,
   '2026-11-25 15:00:00+00', '2026-11-25 14:00:00+00')
ON CONFLICT DO NOTHING;

INSERT INTO public.sync_logs (id, org_id, direction, entity, records_processed, status, created_at) VALUES
  ('ab000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000a', 'erp_to_cloud', 'products',  30, 'success', '2026-11-26 08:00:00+00'),
  ('ab000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000a', 'erp_to_cloud', 'customers',  5, 'success', '2026-11-26 08:01:00+00'),
  ('ab000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-00000000000b', 'erp_to_cloud', 'products',  15, 'success', '2026-11-26 08:00:00+00')
ON CONFLICT DO NOTHING;

UPDATE public.organizations SET last_sync_at = '2026-11-26 08:01:00+00'
 WHERE id = 'b0000000-0000-4000-8000-00000000000a' AND last_sync_at IS NULL;
UPDATE public.organizations SET last_sync_at = '2026-11-26 08:00:00+00'
 WHERE id = 'b0000000-0000-4000-8000-00000000000b' AND last_sync_at IS NULL;
