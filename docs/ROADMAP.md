# ROADMAP: erp-web-bridge

Fuente de verdad del avance. Las skills `next-task` y `phase-gate` leen y actualizan este archivo.

**Formato (no cambiar, lo parsean las skills):**
- Cada fase es un encabezado `## Fase N: nombre`.
- Cada tarea es `- [ ] **N.M** descripción` y se marca `- [x]` solo cuando su verificación pasó.
- Cada fase termina con `### Gate N`: los criterios que `phase-gate` comprueba con evidencia fresca antes de abrir el PR.
- Rama de cada fase: `phase-N/<slug>`.

**Alcance MVP:** fases 0 a 8. Lo que queda fuera está en el [Backlog v1](#backlog-v1).

---

## Fase 0: Bootstrap y flujo de trabajo
Rama: `phase-0/bootstrap`

- [x] **0.1** Repo público `Pepitocrackking/erp-web-bridge` con `main`, README, `.gitignore` y `.gitattributes`.
- [x] **0.2** Manual del proyecto copiado a `docs/manual-proyecto-1.md`.
- [x] **0.3** `CLAUDE.md` con decisiones, flujo de trabajo e importación de `docs/STATE.md`.
- [x] **0.4** `docs/ROADMAP.md` y `docs/STATE.md`.
- [x] **0.5** Skills `next-task`, `phase-gate`, `guardar-estado` y `retomar` en `.claude/skills/`.
- [x] **0.6** Plantilla de PR y script `scripts/validate-workflow.sh` que valida skills, ROADMAP y STATE.

### Gate 0
- [x] `bash scripts/validate-workflow.sh` termina con código 0.
- [x] Las 4 skills tienen frontmatter válido (`name` igual al nombre de su carpeta y `description` no vacía).
- [x] PR de `phase-0/bootstrap` abierto contra `main` con la evidencia en el cuerpo (PR #1).
- [ ] Tras el merge, en una sesión nueva `/retomar` aparece como skill disponible (lo confirma el usuario).

---

## Fase 1: Sandbox de Saint en Docker
Rama: `phase-1/saint-sandbox`

Objetivo: un SQL Server en contenedor con las tablas básicas de Saint y datos realistas, para desarrollar y probar el `SaintAdapter` sin un Saint real.

- [x] **1.1** `docker-compose.yml` con SQL Server 2022, healthcheck, volumen y `.env.example` (sin contraseñas reales).
- [x] **1.2** Script de esquema `infra/saint-sandbox/init/01-schema.sql`: base `SAINT_DEMO` con `SAPROD` (código, descripción, categoría, costo, precios 1 a 3, existencia, activo), `SAEXIS` (existencia por depósito), `SADEPO`, `SAINSTA` y `SACLIE` (código, nombre, RIF, límite de crédito, saldo).
- [x] **1.3** Seed determinista `02-seed.sql`: al menos 300 productos en 8 o más categorías, 3 depósitos y 40 o más clientes con límite y saldo. Datos de una distribuidora venezolana verosímil.
- [x] **1.4** `infra/saint-sandbox/mapping.saint.yaml`: mapeo configurable de columnas de Saint a campos canónicos (`sku`, `name`, `category`, `cost_usd`, `price_usd`, `stock`, `active`).
- [x] **1.5** Scripts `scripts/saint-sandbox.sh` y `.ps1` con `up`, `reset` y `mutate` (cambia precio y stock de productos concretos para simular actividad del ERP).
- [x] **1.6** `docs/saint-sandbox.md`: cómo levantarlo, qué tablas hay y la advertencia de que el esquema es de mejor esfuerzo y debe validarse contra una base real.

### Gate 1
- [x] Desde cero (`down -v` y luego `up`) el contenedor queda `healthy` en menos de 90 s.
- [x] Consultas reales devuelven: al menos 300 filas en `SAPROD`, 3 en `SADEPO`, al menos 40 en `SACLIE`, y `SAEXIS` consistente con la suma de existencias de `SAPROD`.
- [x] `mutate` cambia las filas esperadas y `reset` restaura el estado original (se comprueba con un checksum de la tabla).
- [x] Volver a ejecutar el init no duplica datos (idempotencia).

---

## Fase 2: Monorepo y CI
Rama: `phase-2/monorepo-ci`

- [x] **2.1** Workspace `pnpm` con Turborepo: `apps/web`, `apps/api`, `packages/shared-types`.
- [x] **2.2** Módulo Go en `packages/erp-agent` con estructura base (`cmd/`, `internal/`).
- [x] **2.3** `shared-types`: contratos DTO (producto, cliente, pedido, lote de sincronización) con validación Zod.
- [ ] **2.4** GitHub Actions: lint, test y build de TypeScript y de Go en cada PR.
- [ ] **2.5** Lint y formato configurados (ESLint/Prettier y `golangci-lint` o `go vet`).

### Gate 2
- [ ] `pnpm install && pnpm build && pnpm test` terminan en verde desde un clon limpio.
- [ ] `go build ./... && go test ./...` en verde.
- [ ] El workflow de CI queda en verde en el propio PR.

---

## Fase 3: Base de datos y multi-tenant
Rama: `phase-3/database`

- [ ] **3.1** Supabase local con el CLI; migraciones en `supabase/migrations/`.
- [ ] **3.2** Esquema del manual más las correcciones: `org_members` y roles, `price_lists` y precios por lista, historial `exchange_rates`, imágenes y descripción de producto, estados completos del pedido.
- [ ] **3.3** Políticas RLS por `org_id` en todas las tablas.
- [ ] **3.4** Pruebas automáticas de RLS: el tenant A no puede leer ni escribir datos del tenant B.
- [ ] **3.5** Seed de dos organizaciones de prueba.

### Gate 3
- [ ] Las migraciones se aplican desde cero sin errores.
- [ ] Las pruebas de RLS pasan, incluidos los casos negativos.
- [ ] Re-aplicar el seed no duplica datos.

---

## Fase 4: API (NestJS)
Rama: `phase-4/api`

- [ ] **4.1** Autenticación de agentes por `x-api-key` (comparación contra hash) y JWT para usuarios.
- [ ] **4.2** `POST /v1/sync/products`: upsert masivo por `(org_id, erp_sku)`, con desactivación de productos ausentes en una reconciliación completa.
- [ ] **4.3** `POST /v1/sync/customers`: clientes con límite de crédito y deuda.
- [ ] **4.4** `sync_logs` en cada sincronización y endpoint de `heartbeat` del agente.
- [ ] **4.5** Tasa de cambio manual: endpoints para fijarla y consultarla, con historial.
- [ ] **4.6** Pedidos: creación con validación de límite de crédito, `GET /v1/orders/pending` para el agente y confirmación idempotente.
- [ ] **4.7** Rate limiting, validación estricta de entrada y documentación OpenAPI.

### Gate 4
- [ ] Pruebas de integración contra un Postgres real (no mocks) en verde.
- [ ] Ingesta de 5.000 productos medida y registrada en la evidencia.
- [ ] Una API key de la organización A no puede escribir en la B.
- [ ] Confirmar dos veces el mismo pedido no lo duplica.

---

## Fase 5: Agente Go
Rama: `phase-5/agent`

- [ ] **5.1** Interfaz `ERPAdapter` y modelo canónico.
- [ ] **5.2** `MockAdapter` con datos y mutaciones deterministas.
- [ ] **5.3** `SaintAdapter` contra el sandbox, usando el mapeo configurable.
- [ ] **5.4** Almacén SQLite de hashes y delta sync SHA256 de `sku + precio + stock + nombre`.
- [ ] **5.5** Reconciliación completa periódica para detectar productos eliminados o desactivados.
- [ ] **5.6** Cliente HTTPS con reintentos con backoff, cola local y tolerancia a la caída de red o de luz.
- [ ] **5.7** Configuración por archivo, logs estructurados y `heartbeat`.

### Gate 5
- [ ] E2E real: sandbox, agente, API, base de datos con 300 o más productos sincronizados y conteos iguales.
- [ ] Se muta 1 producto: el agente envía exactamente 1 registro (se comprueba en `sync_logs`).
- [ ] Se corta la red con el agente corriendo: no pierde datos y se pone al día al volver.
- [ ] Pruebas unitarias del hash y del diff en verde.

---

## Fase 6: Web (catálogo, carrito y panel)
Rama: `phase-6/web`

- [ ] **6.1** Catálogo B2B con búsqueda, categorías y precios en USD y Bs según la tasa vigente.
- [ ] **6.2** Login de cliente B2B con aprobación por el admin.
- [ ] **6.3** Carrito y checkout con validación de límite de crédito.
- [ ] **6.4** Panel admin: tasa de cambio, clientes, pedidos y estado de sincronización en tiempo real (Supabase Realtime).
- [ ] **6.5** "Entrar como Administrador Demo" en 1 clic.
- [ ] **6.6** Simulador de ERP: tabla editable de inventario que dispara una sincronización real.
- [ ] **6.7** PWA instalable con catálogo en caché.

### Gate 6
- [ ] E2E con Playwright en verde: demo, edición en el simulador, el catálogo cambia en vivo.
- [ ] Un pedido que supera el límite de crédito es rechazado.
- [ ] Lighthouse PWA válido.

---

## Fase 7: Pedidos hacia el ERP
Rama: `phase-7/orders-to-erp`

- [ ] **7.1** El agente consulta los pedidos pendientes y los escribe en el sandbox solo como borrador.
- [ ] **7.2** Confirmación a la API con la referencia del ERP; estados `pending_sync`, `synced_to_erp`, `error`, con reintento.
- [ ] **7.3** Garantía de cero riesgo contable: prueba automática que falla si el agente escribe en tablas fiscales.
- [ ] **7.4** El panel muestra el estado del pedido y el motivo de cualquier error.

### Gate 7
- [ ] E2E real: pedido en la web, borrador en el sandbox, estado `synced_to_erp` en el panel.
- [ ] La prueba de no escritura fiscal pasa.
- [ ] Reintentar un pedido no crea un borrador duplicado.

---

## Fase 8: Endurecimiento y portafolio
Rama: `phase-8/portfolio`

- [ ] **8.1** Instalador del agente como servicio de Windows.
- [ ] **8.2** Alertas de "agente sin conexión" en el panel.
- [ ] **8.3** README final con diagrama de arquitectura, capturas y guion de demo.
- [ ] **8.4** Despliegue de web y API, con Supabase en la nube.
- [ ] **8.5** Revisión de seguridad (claves, RLS, dependencias) y `LICENSE`.
- [ ] **8.6** Comando único `demo` que levanta todo desde un clon limpio.

### Gate 8
- [ ] Desde un clon limpio, el comando `demo` levanta el sistema y el flujo completo funciona.
- [ ] El servicio de Windows se instala, arranca y se desinstala (probado).
- [ ] No hay secretos en el historial (escaneo).

---

## Backlog v1
- `OdooAdapter` (Odoo community en Docker, JSON-RPC).
- Scraper de la tasa BCV con respaldo manual.
- Precios escalonados por volumen y listas de precios con interfaz.
- Notificaciones por WhatsApp.
- `ChrystalAdapter`.
- Actualización automática del agente.
- Validación del `SaintAdapter` contra una base real de un cliente piloto.
