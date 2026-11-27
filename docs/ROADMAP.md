# ROADMAP: erp-web-bridge

Fuente de verdad del avance. Las skills `next-task` y `phase-gate` leen y actualizan este archivo.

**Formato (no cambiar, lo parsean las skills):**
- Cada fase es un encabezado `## Fase N: nombre`.
- Cada tarea es `- [ ] **N.M** descripción` y se marca `- [x]` solo cuando su verificación pasó.
- Cada fase termina con `### Gate N`: los criterios que `phase-gate` comprueba con evidencia fresca antes de abrir el PR.
- Rama de cada fase: `phase-N/<slug>`.

**Alcance MVP:** fases 0 a 8. **v1:** fases 9 a 15 (el antiguo backlog v1). Lo que queda fuera está en el [Backlog posterior](#backlog-posterior).

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
- [x] **2.4** GitHub Actions: lint, test y build de TypeScript y de Go en cada PR.
- [x] **2.5** Lint y formato configurados (ESLint/Prettier y `golangci-lint` o `go vet`).

### Gate 2
- [x] `pnpm install && pnpm build && pnpm test` terminan en verde desde un clon limpio.
- [x] `go build ./... && go test ./...` en verde.
- [x] El workflow de CI queda en verde en el propio PR.

---

## Fase 3: Base de datos y multi-tenant
Rama: `phase-3/database`

- [x] **3.1** Supabase local con el CLI; migraciones en `supabase/migrations/`.
- [x] **3.2** Esquema del manual más las correcciones: `org_members` y roles, `price_lists` y precios por lista, historial `exchange_rates`, imágenes y descripción de producto, estados completos del pedido.
- [x] **3.3** Políticas RLS por `org_id` en todas las tablas.
- [x] **3.4** Pruebas automáticas de RLS: el tenant A no puede leer ni escribir datos del tenant B.
- [x] **3.5** Seed de dos organizaciones de prueba.

### Gate 3
- [x] Las migraciones se aplican desde cero sin errores.
- [x] Las pruebas de RLS pasan, incluidos los casos negativos.
- [x] Re-aplicar el seed no duplica datos.

---

## Fase 4: API (NestJS)
Rama: `phase-4/api`

- [x] **4.1** Autenticación de agentes por `x-api-key` (comparación contra hash) y JWT para usuarios.
- [x] **4.2** `POST /v1/sync/products`: upsert masivo por `(org_id, erp_sku)`, con desactivación de productos ausentes en una reconciliación completa.
- [x] **4.3** `POST /v1/sync/customers`: clientes con límite de crédito y deuda.
- [x] **4.4** `sync_logs` en cada sincronización y endpoint de `heartbeat` del agente.
- [x] **4.5** Tasa de cambio manual: endpoints para fijarla y consultarla, con historial.
- [x] **4.6** Pedidos: creación con validación de límite de crédito, `GET /v1/orders/pending` para el agente y confirmación idempotente.
- [x] **4.7** Rate limiting, validación estricta de entrada y documentación OpenAPI.

### Gate 4
- [x] Pruebas de integración contra un Postgres real (no mocks) en verde.
- [x] Ingesta de 5.000 productos medida y registrada en la evidencia.
- [x] Una API key de la organización A no puede escribir en la B.
- [x] Confirmar dos veces el mismo pedido no lo duplica.

---

## Fase 5: Agente Go
Rama: `phase-5/agent`

- [x] **5.1** Interfaz `ERPAdapter` y modelo canónico.
- [x] **5.2** `MockAdapter` con datos y mutaciones deterministas.
- [x] **5.3** `SaintAdapter` contra el sandbox, usando el mapeo configurable.
- [x] **5.4** Almacén SQLite de hashes y delta sync SHA256 de `sku + precio + stock + nombre`.
- [x] **5.5** Reconciliación completa periódica para detectar productos eliminados o desactivados.
- [x] **5.6** Cliente HTTPS con reintentos con backoff, cola local y tolerancia a la caída de red o de luz.
- [x] **5.7** Configuración por archivo, logs estructurados y `heartbeat`.

### Gate 5
- [x] E2E real: sandbox, agente, API, base de datos con 300 o más productos sincronizados y conteos iguales.
- [x] Se muta 1 producto: el agente envía exactamente 1 registro (se comprueba en `sync_logs`).
- [x] Se corta la red con el agente corriendo: no pierde datos y se pone al día al volver.
- [x] Pruebas unitarias del hash y del diff en verde.

---

## Fase 6: Web (catálogo, carrito y panel)
Rama: `phase-6/web`

- [x] **6.1** Catálogo B2B con búsqueda, categorías y precios en USD y Bs según la tasa vigente.
- [x] **6.2** Login de cliente B2B con aprobación por el admin.
- [x] **6.3** Carrito y checkout con validación de límite de crédito.
- [x] **6.4** Panel admin: tasa de cambio, clientes, pedidos y estado de sincronización en tiempo real (Supabase Realtime).
- [x] **6.5** "Entrar como Administrador Demo" en 1 clic.
- [x] **6.6** Simulador de ERP: tabla editable de inventario que dispara una sincronización real.
- [x] **6.7** PWA instalable con catálogo en caché.

### Gate 6
- [x] E2E con Playwright en verde: demo, edición en el simulador, el catálogo cambia en vivo.
- [x] Un pedido que supera el límite de crédito es rechazado.
- [x] Lighthouse PWA válido.

---

## Fase 7: Pedidos hacia el ERP
Rama: `phase-7/orders-to-erp`

- [x] **7.1** El agente consulta los pedidos pendientes y los escribe en el sandbox solo como borrador.
- [x] **7.2** Confirmación a la API con la referencia del ERP; estados `pending_sync`, `synced_to_erp`, `error`, con reintento.
- [x] **7.3** Garantía de cero riesgo contable: prueba automática que falla si el agente escribe en tablas fiscales.
- [x] **7.4** El panel muestra el estado del pedido y el motivo de cualquier error.

### Gate 7
- [x] E2E real: pedido en la web, borrador en el sandbox, estado `synced_to_erp` en el panel.
- [x] La prueba de no escritura fiscal pasa.
- [x] Reintentar un pedido no crea un borrador duplicado.

---

## Fase 8: Endurecimiento y portafolio
Rama: `phase-8/portfolio`

- [x] **8.1** Instalador del agente como servicio de Windows.
- [x] **8.2** Alertas de "agente sin conexión" en el panel.
- [x] **8.3** README final con diagrama de arquitectura, capturas y guion de demo.
- [x] **8.4** Despliegue de web y API, con Supabase en la nube.
- [x] **8.5** Revisión de seguridad (claves, RLS, dependencias) y `LICENSE`.
- [x] **8.6** Comando único `demo` que levanta todo desde un clon limpio.

### Gate 8
- [x] Desde un clon limpio, el comando `demo` levanta el sistema y el flujo completo funciona.
- [x] El servicio de Windows se instala, arranca y se desinstala (probado).
- [x] No hay secretos en el historial (escaneo).

---

## Fase 9: Tasa BCV automática
Rama: `phase-9/bcv-rate`

- [x] **9.1** Servicio de la API que obtiene la tasa oficial de bcv.org.ve (fuente primaria) y de una API pública de respaldo (secundaria), con tiempos de espera, validación de rango y pruebas contra servidores simulados (HTML real guardado como fixture).
- [x] **9.2** Tarea programada por organización (activable y con hora configurable) que registra la tasa con `source = 'bcv'` solo si cambió; la tasa manual sigue mandando si es más reciente que la última automática y la organización lo pide.
- [ ] **9.3** Respaldo y alertas: si ambas fuentes fallan se conserva la última tasa y el panel avisa; si la tasa cambia más de un umbral entre lecturas se descarta y se avisa.
- [ ] **9.4** Panel: interruptor «Tasa automática (BCV)», fuente y hora de la última tasa, botón «Actualizar ahora» y respaldo manual intacto.

### Gate 9
- [ ] Con las fuentes simuladas: la tasa se actualiza, cae a la secundaria, cae a la manual y el panel lo refleja.
- [ ] Una lectura absurda (fuera de rango o salto > umbral) no se aplica.
- [ ] Prueba real de red contra bcv.org.ve (informativa: se documenta el resultado, no bloquea).

---

## Fase 10: Precios escalonados y listas de precios
Rama: `phase-10/tiered-pricing`

- [ ] **10.1** Modelo: tramos de precio por volumen (`product_price_tiers`) y asignación de lista a cliente, con RLS y pruebas.
- [ ] **10.2** Motor de precios único en `shared-types` (lista del cliente + tramo por cantidad) usado por la API como autoridad.
- [ ] **10.3** El carrito y la creación de pedidos cotizan con el motor; el pedido guarda el precio aplicado por línea.
- [ ] **10.4** Panel: gestión de listas, tramos y asignación de listas a clientes.
- [ ] **10.5** Catálogo y carrito muestran el precio por tramo y cuánto falta para el siguiente.

### Gate 10
- [ ] E2E: dos clientes con listas distintas ven y pagan precios distintos; un tramo de volumen cambia el total.
- [ ] La API recalcula y rechaza un precio manipulado desde el cliente.
- [ ] RLS: un cliente no ve listas ni tramos ajenos.

---

## Fase 11: Actualización automática del agente
Rama: `phase-11/agent-autoupdate`

- [ ] **11.1** La API publica el manifiesto de versión del agente (versión, URL, SHA-256, firma).
- [ ] **11.2** El agente comprueba el manifiesto, descarga, verifica hash y firma, y deja el binario nuevo preparado.
- [ ] **11.3** Intercambio seguro del binario por el servicio de Windows, con reversión si la versión nueva no arranca.
- [ ] **11.4** Panel: versión del agente de cada organización y aviso de desactualizado.

### Gate 11
- [ ] Actualización real v1 a v2 con el servicio de Windows, sin perder la cola `outbox`.
- [ ] Un binario con hash o firma erróneos se rechaza.
- [ ] Una versión que no arranca revierte sola.

---

## Fase 12: OdooAdapter
Rama: `phase-12/odoo-adapter`

- [ ] **12.1** Sandbox de Odoo Community en Docker con datos equivalentes a los de Saint.
- [ ] **12.2** `erp/odoo`: lectura de productos, existencias y clientes por JSON-RPC, con mapeo configurable.
- [ ] **12.3** Escritura de pedidos solo como presupuestos en borrador (`sale.order` en `draft`), con la misma lista blanca y aislamiento que Saint.
- [ ] **12.4** Configuración (`erp.type: odoo`) y documentación.

### Gate 12
- [ ] E2E: catálogo sincronizado desde Odoo y pedido web convertido en presupuesto borrador; ningún documento confirmado ni factura.
- [ ] Las pruebas de aislamiento de escritura pasan también para Odoo.

---

## Fase 13: ChrystalAdapter
Rama: `phase-13/chrystal-adapter`

- [ ] **13.1** Sandbox supuesto de Chrystal en Docker (motor SQL genérico) y mapeo configurable.
- [ ] **13.2** `erp/chrystal`: lectura de productos, existencias y clientes.
- [ ] **13.3** Escritura de pedidos solo como borradores, con lista blanca.
- [ ] **13.4** Documentación marcando el adaptador como **no validado contra Chrystal real**.

### Gate 13
- [ ] E2E contra el sandbox supuesto: sincronización y pedido borrador.
- [ ] Las pruebas de aislamiento de escritura pasan.

---

## Fase 14: Notificaciones por WhatsApp
Rama: `phase-14/whatsapp`

- [ ] **14.1** Puerto `Notifier` con proveedor WhatsApp Cloud API de Meta, plantillas y simulador local para pruebas.
- [ ] **14.2** Eventos: pedido recibido, enviado al ERP, rechazado, acceso aprobado y agente sin conexión.
- [ ] **14.3** Preferencias: teléfono del cliente con consentimiento y destinatarios del personal; cola con reintentos.
- [ ] **14.4** Panel: configuración, plantillas y registro de envíos.

### Gate 14
- [ ] E2E con el simulador: cada evento genera su mensaje una sola vez, sin consentimiento no se envía.
- [ ] No hay credenciales en el repositorio.

---

## Fase 15: Validación del SaintAdapter
Rama: `phase-15/saint-validation`

- [ ] **15.1** Herramienta de descubrimiento de esquema de solo lectura que compara una base Saint real con el mapeo y genera un informe.
- [ ] **15.2** Variantes de mapeo por versión de Saint y modo de prueba en seco (dry-run) del agente.
- [ ] **15.3** Guía de piloto: checklist, permisos mínimos del login y plan de reversión.

### Gate 15
- [ ] La herramienta detecta correctamente un esquema con columnas faltantes o renombradas (sandbox alterado).
- [ ] La validación contra una base real queda pendiente de un cliente piloto: se documenta, no se simula.

---

## Backlog posterior
- Validación real del `SaintAdapter` y de los demás adaptadores con bases de clientes piloto.
- Despliegue en nube real, CSP con nonces, rate limiting compartido, cifrado DPAPI de `agent.yaml`.
