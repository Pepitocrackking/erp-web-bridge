# Manual de Arquitectura y Contexto: Puente ERP-a-Web y Catálogo B2B Multimoneda

## 1. Contexto del Fundador y Visión del Proyecto
* **Perfil del Desarrollador:** Orlando Guerra, Ingeniero de Sistemas y Desarrollador Full Stack con sólida experiencia en sistemas ERP empresariales (Saint Enterprise, Odoo), microservicios en Go/Python, backends en NestJS, bases de datos PostgreSQL/Supabase y frontends modernos en Next.js/React.
* **Visión Comercial:** Este proyecto es la pieza central del portafolio para fundar una agencia de desarrollo de software, automatización e integración empresarial. Su objetivo es demostrar a pymes, distribuidoras y comercios que sus sistemas administrativos locales pueden conectarse de forma segura, resiliente y en tiempo real con un catálogo web B2B/B2C moderno.
* **Contexto Operativo (Mercado Venezuela / LATAM):**
  * **ERPs predominantes:** **Saint Enterprise** (SQL Server en servidor local Windows), **Odoo** (PostgreSQL / JSON-RPC) y **Chrystal / Cristal** (motor relacional local).
  * **Retos de infraestructura:** Cortes eléctricos frecuentes, ausencia de IP pública fija en los comercios, firewalls locales y manejo obligatorio de doble moneda (**USD y Bolívares** con tasa oficial BCV y márgenes por lista de precios).

---

## 2. Estrategias de Arquitectura e Integración (Reglas de Oro)
1. **Agente Local "Outbound-Only" (De adentro hacia afuera):** Nunca se abren puertos en el router del cliente. Un binario compilado en Go o Python corre como servicio en Windows/Linux dentro de la red del comercio, lee el ERP y empuja los cambios por HTTPS hacia la API en la nube. Si cae internet o la luz, la web sigue operando con el último estado válido.
2. **Sincronización Diferencial por Hash (Delta Sync):** El agente local calcula un hash (`SHA256`) de `sku + precio + stock + nombre` y lo compara contra una base SQLite local. Solo envía a la nube los registros modificados, ahorrando +90% de ancho de banda.
3. **Patrón Adapter Modular:** El agente implementa una interfaz común (`ERPAdapter`) con implementaciones intercambiables: `SaintAdapter`, `OdooAdapter`, `ChrystalAdapter` y un `MockAdapter` (vital para demos en vivo sin ERP físico).
4. **Cero Riesgo Contable:** Los pedidos generados en la web nunca escriben directo en tablas fiscales; se inyectan como **Presupuestos o Pedidos en borrador** para aprobación interna.
5. **Motor Multimoneda Desacoplado:** El puente almacena la tasa de cambio vigente en la nube y calcula precios en Bs y USD dinámicamente sin alterar los costos base del ERP.

---

## 3. Stack Tecnológico Definido
* **Monorepo:** Turborepo o `pnpm workspaces`.
* **Frontend (`apps/web`):** Next.js (App Router), TypeScript, Tailwind CSS, PWA (instalable en móviles, soporte offline básico).
* **Backend Core (`apps/api`):** NestJS, TypeScript, validación con Zod/class-validator, autenticación por `x-api-key` para agentes y JWT para usuarios.
* **Base de Datos y Realtime (`Supabase`):** PostgreSQL con **Row Level Security (RLS)** estricto por `org_id` y **Supabase Realtime** para reflejar sincronizaciones al instante en el panel admin.
* **Agente Conector (`packages/erp-agent`):** Go (ideal para compilar un `.exe` sin dependencias) o Python + SQLite local.

---

## 4. Estructura de Carpetas Sugerida
```text
erp-web-bridge/
├── apps/
│   ├── web/                  # Catálogo B2B + Panel Admin + Simulador ERP
│   └── api/                  # API NestJS (Ingesta masiva, tasas BCV, pedidos)
├── packages/
│   ├── erp-agent/            # Binario local (Adapters: Saint, Odoo, Chrystal, Mock)
│   └── shared-types/         # Contratos DTO compartidos entre API, Web y Agente
├── supabase/
│   └── migrations/           # Esquema SQL y políticas RLS
└── docker-compose.yml
```

---

## 5. Modelo de Datos Base (PostgreSQL / Supabase)
```sql
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  erp_type TEXT NOT NULL, -- 'saint' | 'odoo' | 'chrystal' | 'mock'
  exchange_rate_bs NUMERIC(12, 4) DEFAULT 1.00,
  last_sync_at TIMESTAMPTZ,
  api_key_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  erp_sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  price_usd NUMERIC(12, 2) NOT NULL,
  stock NUMERIC(12, 2) DEFAULT 0,
  sync_hash TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, erp_sku)
);

CREATE TABLE b2b_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  erp_customer_code TEXT NOT NULL,
  tax_id TEXT NOT NULL,
  business_name TEXT NOT NULL,
  credit_limit_usd NUMERIC(12, 2) DEFAULT 0,
  current_debt_usd NUMERIC(12, 2) DEFAULT 0,
  UNIQUE(org_id, erp_customer_code)
);

CREATE TABLE web_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES b2b_customers(id),
  status TEXT DEFAULT 'pending_sync', -- 'pending_sync' | 'synced_to_erp' | 'error'
  erp_order_reference TEXT,
  total_usd NUMERIC(12, 2) NOT NULL,
  exchange_rate_used NUMERIC(12, 4) NOT NULL,
  items JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL, -- 'erp_to_cloud' | 'cloud_to_erp'
  records_processed INT DEFAULT 0,
  status TEXT NOT NULL,
  error_detail TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 6. Características Clave para el Portafolio (Modo Demo)
* **Acceso Demo en 1 Clic:** Botón *"Entrar como Administrador Demo"* sin registro previo.
* **Simulador de ERP en Vivo:** Vista dentro del panel admin que emula una tabla de inventario local (Saint/Odoo), permite editar precios o stock y disparar una sincronización real contra la API para ver cómo el catálogo web y la conversión Bs/USD se actualizan en vivo.

---

## 7. Preguntas que el Agente debe hacer al Usuario antes de Codificar
1. ¿Prefieres construir el agente local (`packages/erp-agent`) en **Go** (compilación a ejecutable único `.exe` muy ligero) o en **Python**?
2. Para el flujo de pedidos B2B en el MVP, ¿deseas incluir validación de límite de crédito y carrito con precios escalonados por volumen, o empezamos con un catálogo B2B con carrito estándar y conversión USD/Bs?
3. ¿Cómo deseas obtener la tasa de cambio en el MVP: mediante un endpoint/scraper automatizado de tasa oficial (BCV) con respaldo manual, o ingreso manual desde el panel administrativo?
4. ¿Quieres que el proyecto incluya un `docker-compose.yml` con una base de datos PostgreSQL simulando las tablas reales de Saint (`SAPROD`, `SAEXIS`) para probar el `SaintAdapter` localmente desde el día uno?