# erp-web-bridge

[![CI](https://github.com/Pepitocrackking/erp-web-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Pepitocrackking/erp-web-bridge/actions/workflows/ci.yml)

**Puente seguro entre el ERP local de un comercio (Saint Enterprise primero, Odoo después) y un catálogo web B2B multimoneda (USD y Bs).**

Un agente local escrito en Go lee el ERP y empuja los cambios por HTTPS hacia la nube. No abre puertos en el cliente, tolera cortes de luz e internet y **nunca escribe en tablas fiscales**: los pedidos web vuelven al ERP como borradores. En la nube, una API NestJS y Supabase (PostgreSQL con RLS y Realtime) alimentan un catálogo B2B instalable como PWA y un panel de administración que se actualiza en vivo.

Está pensado para pymes y distribuidoras de Venezuela y LATAM: ERP local en Windows, sin IP pública fija, cortes de luz frecuentes y doble moneda con tasa de cambio.

| Catálogo del comprador (USD y Bs) | Panel de administración en vivo |
|---|---|
| ![Catálogo](docs/screenshots/02-catalogo.png) | ![Panel](docs/screenshots/04-panel.png) |

## Arquitectura

```mermaid
flowchart LR
  subgraph LOCAL["Red del comercio (sin puertos abiertos)"]
    ERP[("ERP local<br/>Saint · SQL Server")]
    AG["erp-agent (Go)<br/>servicio de Windows<br/>SQLite: huellas y cola"]
    ERP -- "lee (SELECT)" --> AG
    AG -- "borradores de pedido<br/>(INSERT acotado, login erp_agent)" --> ERP
  end
  subgraph NUBE["Nube"]
    API["API NestJS<br/>x-api-key · JWT · rate limit"]
    DB[("Supabase<br/>PostgreSQL + RLS + Realtime")]
    WEB["Web Next.js (PWA)<br/>catálogo B2B · panel · simulador"]
    API --- DB
    WEB -- "lecturas con el JWT del usuario<br/>(RLS decide)" --> DB
    WEB -- "pedidos y tasa<br/>(acciones de servidor)" --> API
  end
  AG == "HTTPS saliente: solo lo que cambió<br/>+ latido cada minuto" ==> API
  API -. "webhook firmado<br/>(agente sin conexión)" .-> HOOK(["Tu sistema de avisos"])
  USER(["Comprador / personal"]) --> WEB
```

**Cómo viaja un pedido** (de la web al ERP, sin tocar lo fiscal):

```mermaid
sequenceDiagram
  actor C as Comprador
  participant W as Web
  participant A as API
  participant G as erp-agent
  participant E as ERP (Saint)
  C->>W: Confirmar pedido
  W->>A: crear pedido (JWT)
  A->>A: precio, total y crédito (límite − deuda − en curso)
  A-->>W: pending_sync
  loop cada ciclo del agente
    G->>A: GET /v1/orders/pending
    G->>E: INSERT borrador (SAPEDIDO / SAITEMPED)
    G->>A: POST /v1/orders/:id/confirm (referencia)
  end
  A-->>W: synced_to_erp (panel en vivo)
  Note over G,E: Si el ERP lo rechaza (cliente o SKU inexistente),<br/>el pedido pasa a «error» con el motivo y el personal lo reintenta
```

### Decisiones de diseño

- **Agente «solo saliente».** Nunca se abre un puerto en el router del cliente. Si cae internet o la luz, la web sigue con el último estado válido y el agente retoma sin perder nada (cola SQLite con escritura síncrona; probado con `kill -9`).
- **Sincronización diferencial por hash.** El agente guarda una huella SHA-256 de `sku + precio + stock + nombre` y solo envía lo que cambió; una reconciliación completa (diaria) detecta lo eliminado. Con 5.000 productos: ~0,4 s el alta y ~0,2 s un reenvío sin cambios.
- **Cero riesgo contable, en tres capas.** (1) Lista blanca en el código: solo `SELECT` y `INSERT` en las dos tablas del borrador; (2) un login SQL dedicado (`erp_agent`) sin permisos sobre lo fiscal, que el agente verifica al arrancar y, si puede escribir de más, **se niega a procesar pedidos**; (3) pruebas que comparan la huella de las tablas fiscales antes y después. Detalle en [docs/saint-sandbox.md](docs/saint-sandbox.md).
- **Multi-tenant con RLS.** Cada consulta del usuario corre con su JWT y PostgreSQL decide qué ve; el lado del agente filtra siempre por la organización de su `x-api-key`. 48 pruebas de RLS.
- **Multimoneda desacoplada.** El ERP guarda USD; la tasa vive en la nube y los Bs se calculan al mostrar, sin alterar los costos base. Una sola función de conversión compartida entre API y web.
- **Patrón Adapter.** El agente habla con el ERP mediante una interfaz; hoy `saint` (nombres de tablas y columnas en un archivo de mapeo, no en el código) y `mock` (demos sin ERP). `odoo` está en el backlog.

## Qué incluye

| Pieza | Qué hace |
|---|---|
| `packages/erp-agent` | Agente en Go (un `.exe` de ~18 MB sin dependencias). Sync delta, cola con reintentos y backoff, latido, pedidos hacia el ERP y **servicio de Windows** (`erp-agent service install`: arranque automático, reinicio ante fallo, log con rotación). |
| `apps/api` | NestJS: ingesta masiva idempotente, pedidos con validación de crédito, tasa de cambio, OpenAPI en `/docs`, JWT ES256/HS256, rate limiting y **aviso por webhook** si un agente deja de dar señales ([docs/agent-alerts.md](docs/agent-alerts.md)). |
| `apps/web` | Next.js 16 + Tailwind 4: catálogo B2B (búsqueda, categorías, precio por lista), carrito con crédito, panel de administración **en vivo** con alertas, simulador de ERP, solicitudes de acceso, **PWA** instalable con catálogo sin conexión. |
| `supabase/` | Migraciones SQL, RLS y seed con dos organizaciones. |
| `infra/saint-sandbox` | SQL Server 2022 en Docker que replica las tablas de Saint (`SAPROD`, `SAEXIS`, `SACLIE`, `SADEPO`, `SAINSTA`) con 311 productos y 48 clientes, para probar el adaptador de verdad. |

## Guion de demo (5 minutos)

Requisitos y arranque: ver [Probarlo en local](#probarlo-en-local). Capturas de cada paso en [`docs/screenshots/`](docs/screenshots).

1. **Un clic, sin registro.** Abre `http://localhost:3100/login` y pulsa **«Entrar como Administrador Demo»**. Estás en el panel de la «Distribuidora Demo»: estado del agente, tasa del día, pedidos, clientes con su crédito y la bitácora de sincronización.
2. **El ERP cambia, la web lo refleja al instante.** En el panel abre **«Simulador de ERP»**: es la tabla de inventario de un ERP local. Cambia el precio o la existencia de un producto y pulsa **«Sincronizar con la nube»**. Los cambios viajan por la misma API de ingesta que usa el agente real, y solo se envía lo modificado.
3. **Dos pestañas.** En otra ventana entra como comprador (`cliente@demo-saint.test` / `demo1234`): el catálogo muestra el precio de su lista mayorista en USD y en Bs, y **cambia en vivo** cuando sincronizas en el paso 2, sin recargar.
4. **La tasa manda.** En el panel escribe una tasa nueva y pulsa **«Fijar tasa»**: todos los precios en Bs del catálogo se recalculan en vivo. El historial queda registrado.
5. **Un pedido con crédito.** Como comprador agrega productos al carrito. Verás el total en USD y Bs y **tu crédito disponible** (límite − deuda − pedidos en curso). Si el pedido lo supera, no se puede confirmar. Confirma uno: aparece en el panel como **«Pendiente de enviar al ERP»**.
6. **Del pedido al borrador del ERP** (con el agente real y el sandbox de Saint, ver abajo). El agente lo recoge, lo deja como borrador en `SAPEDIDO` y el panel pasa a **«Enviado al ERP»** con la referencia, sin recargar. Si el ERP lo rechaza, el panel muestra el motivo y un botón **«Reintentar»**.
7. **Cuando algo falla.** Detén el agente (o espera 3 minutos sin latido): el panel muestra el banner **«El agente local no responde»** con un «Qué hacer», un contador en la cabecera y el número en el título de la pestaña. Con un webhook configurado, también llega el aviso a tu sistema.

![Alerta de agente sin conexión](docs/screenshots/06-alerta-agente.png)

## Probarlo en local

Requisitos: Docker, Node ≥ 24, pnpm ≥ 12 y Go ≥ 1.26 (solo para el agente).

```bash
pnpm install
grep '^NEXT_PUBLIC_' .env.example > apps/web/.env.local   # URL y clave pública de la pila local (en PowerShell: Select-String)
pnpm db:start                           # Supabase local (la primera vez descarga imágenes)
pnpm db:reset                           # migraciones + seed: 2 organizaciones, usuarios de prueba
pnpm build

PORT=3001 node apps/api/dist/main.js    # API
cd apps/web && DEMO_MODE=true pnpm exec next start -p 3100   # web (comandos en Git Bash o WSL)
```

Para el paso 6 (agente real contra un Saint de prueba):

```bash
bash scripts/saint-sandbox.sh up                       # SQL Server con las tablas de Saint
cd packages/erp-agent
cp agent.example.yaml agent.yaml                       # api.api_key: erp_dev_demo_saint_key, dsn con el login erp_agent
CGO_ENABLED=0 go build -o erp-agent.exe ./cmd/erp-agent
./erp-agent.exe -config agent.yaml                     # o como servicio: erp-agent service install -config agent.yaml
```

`DEMO_MODE=true` habilita el botón de acceso demo y el simulador: **no lo actives en producción real**. Para llevarlo a producción (imágenes Docker de la API y la web, Supabase en la nube) sigue [docs/deploy.md](docs/deploy.md). Más detalle en [docs/supabase-local.md](docs/supabase-local.md), [docs/saint-sandbox.md](docs/saint-sandbox.md) y [packages/erp-agent/README.md](packages/erp-agent/README.md).

## Calidad

Cada fase se cerró con una compuerta de verificación con datos reales (evidencia en [`docs/evidence/`](docs/evidence)):

| Qué | Pruebas |
|---|---|
| Contratos compartidos (Zod) | 102 |
| API (la mayoría, de integración contra PostgreSQL real) | 205 |
| Web (unitarias) | 87 |
| RLS multi-tenant | 48 |
| Agente Go (16 paquetes, con `-race`; incluye pruebas contra el SQL Server del sandbox) | `go test ./...` |
| E2E de punta a punta con Playwright (UI, Realtime, PWA, agente real y sandbox de Saint) | 50 |

El CI (GitHub Actions) corre formato, lint, las pruebas de RLS y de TypeScript con una base Supabase real, el build, y `gofmt`, `go vet`, build y pruebas del agente, en cada PR. Las E2E de Playwright necesitan la pila completa y se corren a mano (`pnpm e2e` en `apps/web`).

## Estructura

```
erp-web-bridge/
├── apps/
│   ├── api/                 # NestJS: ingesta, pedidos, tasa, alertas
│   └── web/                 # Next.js: catálogo, panel, simulador, PWA
├── packages/
│   ├── erp-agent/           # agente Go (adapters saint y mock, servicio de Windows)
│   └── shared-types/        # contratos Zod compartidos y conversión de moneda
├── supabase/                # migraciones, RLS, seed y pruebas de RLS
├── infra/saint-sandbox/     # SQL Server en Docker que replica tablas de Saint
├── scripts/                 # sandbox, validación y prueba del servicio de Windows
└── docs/                    # ROADMAP, evidencias por fase, guías y capturas
```

## Siguientes pasos (backlog v1)

`OdooAdapter` · scraper de la tasa BCV con respaldo manual · precios escalonados por volumen · notificaciones por WhatsApp · `ChrystalAdapter` · actualización automática del agente · validar el `SaintAdapter` contra una base real de un cliente piloto (los nombres de columnas son de mejor esfuerzo y viven en `infra/saint-sandbox/mapping.saint.yaml`).

El plan completo por fases está en [docs/ROADMAP.md](docs/ROADMAP.md).
