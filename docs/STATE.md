# STATE

Memoria del proyecto entre sesiones. Lo actualiza la skill `guardar-estado` y lo lee `retomar`. Se importa desde `CLAUDE.md`, así que se carga solo tras un `/clear`.

## Posición
- **Fase actual:** 7, Pedidos hacia el ERP
- **Rama:** `phase-7/orders-to-erp` (sin push todavía)
- **Última tarea completada:** 7.1 (el agente escribe los pedidos pendientes en el sandbox como borrador).
- **Estado de la fase:** en curso. Siguiente tarea: 7.2

## Fases cerradas
- **Fase 0** (PR #1, fusionado el 2026-11-26): repo, `CLAUDE.md`, ROADMAP, STATE, 4 skills, plantilla de PR y `scripts/validate-workflow.sh`.
  - Pendiente menor: el usuario confirma que `/retomar` aparece como skill en una sesión nueva (último criterio del Gate 0).
- **Fase 1** (PR #2, fusionado el 2026-11-26): sandbox de Saint en Docker. Evidencia en `docs/evidence/phase-1.md`.
  - `docker-compose.yml` (servicios `saint-sql` y `saint-init`), `.env.example`, `infra/saint-sandbox/` (init SQL idempotente, seed generado por `tools/gen-seed.mjs`, `mapping.saint.yaml`, `tools/` con reset/mutate/checksum/validate-mapping/gate), `scripts/saint-sandbox.sh` y `.ps1`, `docs/saint-sandbox.md`.
  - Datos: 311 productos, 10 categorías, 3 depósitos (001, 002, 003), 48 clientes (algunos cerca o por encima de su límite de crédito). Códigos `P00001...` y `C00001...`.
- **Fase 2** (PR #3, fusionado el 2026-11-26): monorepo y CI. Evidencia en `docs/evidence/phase-2.md`.
  - Workspace pnpm + Turborepo: `apps/api` (NestJS 11), `apps/web` (Next.js 16 + Tailwind 4), `packages/shared-types` (contratos Zod en `src/contracts.ts`), módulo Go `packages/erp-agent` (`cmd/erp-agent`, `internal/version`).
  - CI en `.github/workflows/ci.yml` (jobs `typescript` y `go`, en cada PR y push a `main`). ESLint + Prettier (`pnpm lint`, `pnpm format`, `pnpm format:check`) y `gofmt`/`go vet` en el job de Go.
- **Fase 3** (PR #4, fusionado el 2026-11-26, CI en verde): base de datos multi-tenant en Supabase local. Evidencia en `docs/evidence/phase-3.md`.
  - CLI `supabase` 3.4.0 (devDependency), `supabase/config.jsonc`, migraciones, `seed.sql` con 2 organizaciones, `supabase/tests/rls.test.mjs` (30 pruebas, `pnpm test:db`), atajos `pnpm db:start|stop|reset|status`, `docs/supabase-local.md`.
- **Fase 4** (PR #5, fusionado el 2026-11-26, CI en verde): API NestJS. Evidencia en `docs/evidence/phase-4.md`.
  - 156 pruebas en la API (135 de integración contra Postgres real, con tenants propios que borran al terminar), shared-types 90, RLS 30. Ingesta de 5.000 productos en ~0,4 s (alta) y ~0,2 s (reenvío sin cambios). OpenAPI en `/docs` y `/openapi.json`.
  - **El CI ahora levanta Supabase local** (`pnpm exec supabase start -x realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor`: solo base de datos y GoTrue) antes de `pnpm test:db` y `pnpm test`.
  - Migraciones nuevas: `..0300_sync_reconciliation.sql`, `..0400_agent_heartbeat.sql`, `..0500_orders.sql`.
  - Backlog que quedó fuera: validar stock; clave de idempotencia al CREAR pedidos; endpoint para que el agente marque un pedido como `error`/`rejected`/`approved`; pedidos hechos por el personal a nombre de un cliente; JWKS en producción.
- **Fase 5** (PR #6, fusionado el 2026-11-26, CI en verde): agente Go. Evidencia en `docs/evidence/phase-5.md`.
  - Módulo `packages/erp-agent` (un `.exe` de ~18 MB, `CGO_ENABLED=0`). Paquetes en `internal/`: `erp` (modelo canónico + interfaz `Adapter`), `erp/mock`, `erp/saint` (lee `mapping.saint.yaml`, sin columnas en el código), `delta` (hash SHA-256 de `skupreciostocknombre` con 2 decimales; el diff compara una huella que además cubre categoría y activo), `batch` (lotes con la forma exacta del contrato, validados con el Zod real), `sync` (ciclo delta/reconciliación; `ErrEmptyInventory` protege el catálogo), `store` (SQLite pura Go: huellas, `meta`, cola `outbox`; WAL + synchronous FULL), `api` (cliente y clasificación de errores), `sender` (de uno en uno y en orden, backoff 1 s a 5 min con jitter, respeta `Retry-After`), `config` (YAML estricto), `agent` (une todo, heartbeat, apagado limpio). README del agente y `agent.example.yaml`.
  - Uso: `erp-agent -config agent.yaml [-once] [-reconcile]`; secretos por `ERP_AGENT_API_KEY` y `ERP_AGENT_SAINT_DSN`. Prueba contra el sandbox real: `SAINT_TEST_DSN` (si no, se omite).
  - E2E real: 311 productos y 48 clientes con conteos y sumas iguales; 1 producto mutado = 1 registro en `sync_logs`; corte de red y `kill -9` del agente sin pérdida de datos; la reconciliación desactiva lo eliminado.
  - Backlog que quedó fuera: ejecutar el agente como servicio de Windows; validar el mapeo contra un Saint real; pedidos hacia el ERP (Fase 7).

- **Fase 6** (PR #7, fusionado el 2026-11-26, CI en verde): web. Evidencia en `docs/evidence/phase-6.md`.
  - **Rutas de `apps/web`:** `/login` (+ botón demo), `/registro`, `/acceso` (pedir acceso y ver su estado), `/catalogo` (búsqueda, categorías, 24 por página, **en vivo** por Realtime), `/carrito`, `/admin` (panel en vivo), `/admin/solicitudes`, `/admin/simulador`, `/offline`, manifiesto e iconos PWA. El proxy (`proxy.ts`) refresca la sesión y protege `/catalogo`, `/carrito`, `/acceso` y `/admin`.
  - **Migraciones nuevas:** `..0600` (vista `catalog_categories`), `..0700` (`customer_access_requests` y las funciones `request_/approve_/reject_access_request`), `..0800` (publicación `supabase_realtime` con `sync_logs`, `web_orders`, `exchange_rates`; lectura del latido), `..0900` (`products` a Realtime). RLS: 48 pruebas.
  - **Cómo lee y escribe la web:** lecturas con el JWT del usuario por PostgREST (RLS decide); escrituras de negocio por la API desde **acciones de servidor** de Next con el JWT de la sesión (sin CORS): crear pedido, fijar tasa. `API_URL` (o `NEXT_PUBLIC_API_URL`) la define `lib/api-url.ts`.
  - **Dinero:** `shared-types/money.ts` (`usdToBs`, `lineTotalUsd`, `sumUsd`, `formatUsd`, `formatBs`) es la única fuente de conversión. El carrito (localStorage, solo SKU y cantidad) se cotiza en el servidor; la API sigue siendo la autoridad del precio, el total y el crédito.
  - **Corrección a la Fase 4:** el Auth de Supabase firma con **ES256**; la API ahora verifica ES256 con el JWKS (`JwksCache`, `JwtVerifier`) además de HS256. Variables `SUPABASE_JWKS_URL` y `SUPABASE_JWT_ISSUER` (opcional).
  - **Modo demo:** `DEMO_MODE=true` (variable de servidor) habilita "Entrar como Administrador Demo" y el simulador de ERP (clave de agente del seed o `SIMULATOR_API_KEY`). **No definirla en producción real.**
  - **PWA:** service worker propio (`public/sw.js`): estáticos cache-first, `/catalogo` red-primero con caída a la misma URL guardada; el caché de páginas se vacía al pedir `/login` y al cerrar sesión (siempre usar `SignOutButton`). Lighthouse 11 PWA 100 %.
  - **Pruebas:** web 70, shared-types 100, API 175, RLS 48 y **45 E2E de Playwright** (`pnpm e2e` en `apps/web`; levanta la API en 3001 y la web en 3100; necesita Supabase **completo** y `pnpm db:reset`; no corren en el CI). `lib/sync-hash.ts` calcula el `sync_hash` igual que el agente Go (mismos vectores).
  - Backlog que quedó fuera: selector de organización (hoy se usa la primera membresía); pedidos hechos por el personal a nombre de un cliente; validar stock al crear pedidos; correo de aviso al aprobar un acceso; buscador en el desplegable de clientes (carga hasta 1000); `SUPABASE_JWT_ISSUER` fijado en producción.

## Decisiones de la Fase 7 (tomadas al iniciar, sin tanda de preguntas: todas las propuestas por defecto)
- Borrador en `SAPEDIDO` (cabecera, `NumeroWeb` UNIQUE = id del pedido web, `Estado`='B') y `SAITEMPED` (renglones), correlativo `PW0000001` con la secuencia `SQ_SAPEDIDO_WEB`. Mapeo en la sección `order_draft` de `mapping.saint.yaml` (ninguna columna en el código).
- Interfaz `erp.OrderWriter` (aparte de `erp.Adapter`, que sigue siendo de solo lectura); la cumplen `saint` y `mock`. `*erp.RejectedError` = rechazo permanente (cliente o SKU inexistente o inactivo en el ERP); cualquier otro error es transitorio.
- Paquete `internal/orders` (`Processor.Cycle`): de uno en uno y en orden, `limit` 50 (config `orders.enabled` / `orders.limit`); rechazo = se anota y se sigue; error transitorio = corta el ciclo. Se ejecuta dentro de cada ciclo del agente (`App.ordersCycle`), y su error hace fallar `-once`.
- **No** se hace la página `/pedidos` del comprador (no está en el ROADMAP): 7.4 se cumple con el panel `/admin`.
- Pendiente para 7.2: tras escribir el borrador, el agente debe llamar a `confirm` (hoy `Processor` NO confirma: por eso los pedidos siguen `pending_sync` y cada ciclo los vuelve a ver, con `Created=false`); un rechazo debe informarse a la API (endpoint nuevo `POST /v1/orders/:orderId/fail`).
- Para 7.3: crear en el sandbox las tablas fiscales de ejemplo (`SAFACT`, `SAITEMFAC`, `SAACXC`), el login SQL `erp_agent` con GRANT solo a los borradores y DENY a las fiscales, la lista blanca en el código (`OrderDraft.WriteTables()`) y la prueba que intenta escribir en una fiscal.
- Los datos de 7.1 se verificaron con una corrida real (org de prueba `e2e-fase7`, ya borrada): 2 borradores con `Estado`='B', 3 renglones cada uno, la segunda pasada no duplicó. Las pruebas de integración usan `SAINT_TEST_DSN='sqlserver://sa:Saint_Demo_2026%21@localhost:14330?database=SAINT_DEMO&encrypt=disable'` y limpian lo que escriben.

## Siguiente acción
Ejecutar la tarea **7.1** del bloque `## Fase 7` de `docs/ROADMAP.md` (el agente consulta los pedidos pendientes y los escribe en el sandbox **solo como borrador**). Después 7.2 a 7.4 en orden y `phase-gate` con el Gate 7. Como es la primera tarea de la fase, `next-task` hace la **única tanda de dudas** con AskUserQuestion; abajo, lo que existe, lo que falta y mi propuesta por defecto (si no hay motivo para cambiarla, no preguntar).

**Esfuerzo sugerido:** alto para 7.1 (escritura en el ERP, idempotencia), 7.2 (estados, reintentos, endpoint nuevo) y 7.3 (garantía de no escritura fiscal: seguridad de datos); bajo para 7.4 (el panel ya muestra el estado, ver abajo).

**Lo que ya existe (no rehacer):**
- **API** (`apps/api/src/orders/`): `GET /v1/orders/pending?limit=` (cabecera `x-api-key`; devuelve `{orders: WebOrder[]}`, los más antiguos primero; cada pedido trae `id`, `customer_code`, `status`, `total_usd`, `exchange_rate_used`, `items[{sku, quantity, unit_price_usd}]`, `erp_order_reference`, `notes`, `created_at`) y `POST /v1/orders/:orderId/confirm` (cuerpo `{erp_order_reference}`; idempotente: la misma referencia devuelve `duplicate: true`, otra referencia o un estado que no admite confirmación da 409; pasa el pedido a `synced_to_erp`). La referencia del ERP es única por organización (índice parcial). Estados de `web_orders.status`: `pending_sync`, `synced_to_erp`, `approved`, `rejected`, `cancelled`, `error`; columnas `erp_order_reference`, `error_detail`, `synced_at`. **El crédito** cuenta los pedidos en `pending_sync` y `synced_to_erp`.
- **Falta en la API:** un endpoint para que el agente informe un fallo permanente (`error` + `error_detail`) y, quizá, uno para reintentar un pedido en `error` (hoy el personal solo puede anular pedidos `pending_sync`/`error` por RLS). Es el backlog de la Fase 4 ("endpoint para que el agente marque un pedido como error/rejected/approved").
- **Agente Go** (`packages/erp-agent`): la interfaz `erp.Adapter` (`internal/erp/adapter.go`) solo tiene `Products` y `Customers`; hay `erp/mock` y `erp/saint` (lee `infra/saint-sandbox/mapping.saint.yaml`, **sin columnas en el código**). `internal/api/client.go` tiene `SendBatch` y `Heartbeat`; `internal/sender` (cola SQLite, backoff, clasificación de errores), `internal/store` (SQLite pura Go), `internal/agent` (une todo, heartbeat, apagado limpio). Receta E2E de la Fase 5 más abajo en "Cómo levantar el proyecto".
- **Sandbox de Saint** (`infra/saint-sandbox/init/01-schema.sql`): solo `SAINSTA`, `SADEPO`, `SAPROD`, `SAEXIS`, `SACLIE`. **No hay tablas de pedidos ni de facturación**: hay que crearlas (idempotente, con `tools/gen-seed.mjs` y `scripts/saint-sandbox.sh reset` como hasta ahora).
- **Web:** el panel `/admin` ya muestra cada pedido con su estado, la referencia del ERP y `error_detail`, **en vivo** (Realtime sobre `web_orders`, los UPDATE se funden por id). Para 7.4 solo harían falta ajustes menores y una pantalla "mis pedidos" del comprador si se decide.

**Puntos de diseño abiertos para la tanda de dudas (mi propuesta por defecto entre paréntesis):**
1. **Qué escribe el agente en el sandbox y cómo se garantiza el "cero riesgo contable" (7.3).** (Añadir al sandbox una cabecera y un detalle de pedido en borrador —p. ej. `SAPEDIDO`/`SAITEMPED` con `NumeroWeb` único = id del pedido web— más tablas fiscales de ejemplo —`SAFACT`, `SAITEMFAC`, `SAACXC`— que el agente nunca toca. El mapeo `mapping.saint.yaml` gana una sección `order_draft`. La garantía va en **tres capas**: lista blanca de tablas en el código del agente, un **login SQL dedicado** del agente con `GRANT` solo sobre las tablas de borrador y `DENY` sobre las fiscales, y una prueba automática que intenta escribir en una fiscal y debe fallar.)
2. **Idempotencia (Gate 7: reintentar no duplica).** (El id del pedido web viaja como `NumeroWeb` con índice único; el agente hace "insertar si no existe" en una transacción y devuelve la referencia existente si ya estaba; luego confirma, y la confirmación ya es idempotente.)
3. **Estados y reintentos (7.2).** (Errores transitorios —red, ERP caído— se reintentan con el backoff del agente y el pedido sigue en `pending_sync`; los permanentes —cliente o SKU inexistente en el ERP— llaman a un endpoint nuevo `POST /v1/orders/:orderId/fail` con `error_detail`, que lo pasa a `error`; el personal lo reintenta desde el panel con un botón que lo devuelve a `pending_sync`, y la anulación sigue como hasta ahora.)
4. **Orden de llegada y lotes.** (Se procesan uno a uno y en orden, igual que el sender de lotes; `limit` de 50 por ciclo.)
5. **E2E del Gate 7** (pedido en la web, borrador en el sandbox, `synced_to_erp` en el panel): (un Playwright que crea el pedido como comprador, ejecuta el binario del agente con `-once` contra el sandbox real y comprueba el panel y una consulta a SQL Server; requiere Docker con `saint-sql` y una organización de prueba con clave de agente propia, ver la receta.)
6. **"Mis pedidos" para el comprador.** (Una página `/pedidos` de solo lectura con estado y referencia: pequeña y útil para la demo; si no se quiere, 7.4 se cumple con el panel.)

**Comandos de la fase:** `pnpm db:start` (Supabase **completo**; si la pila ya corría con `-x`, `pnpm db:stop && pnpm db:start`), `bash scripts/saint-sandbox.sh up|reset`, `pnpm build`, `PORT=3001 node apps/api/dist/main.js`, `cd packages/erp-agent && go test ./...`, `pnpm test`, `pnpm test:db`, `pnpm e2e` (en `apps/web`), `pnpm lint`, `pnpm format:check`, `bash scripts/validate-workflow.sh`.

## Hilo de contexto (por qué estamos haciendo esto)
- **Quién:** Orlando Guerra, ingeniero de sistemas full stack. Usa este proyecto como pieza central del portafolio de una agencia de software, y quiere que pueda escalar y venderse.
- **Qué se construye:** un agente local en Go que lee el ERP del comercio (Saint primero) y empuja los cambios por HTTPS a una API NestJS con Supabase, más un catálogo B2B con precios en USD y Bs y pedidos que vuelven al ERP como borradores.
- **Por qué Saint y no Odoo primero:** Saint es el ERP que domina el mercado objetivo (Venezuela). Como no hay un Saint real a mano, se prueba con un sandbox SQL Server en Docker. Odoo queda en el backlog v1.
- **Cómo se trabaja:** ciclo `next-task` por tarea, `phase-gate` al cerrar la fase, `guardar-estado` antes de `/clear`, `retomar` después. La memoria vive en este archivo y en `docs/ROADMAP.md`, no en la conversación.

## Acuerdos con el usuario
- Comunicación en español. Solo quiere ver un resumen al terminar cada fase; entre fases no hay que consultarle lo que ya está decidido.
- Dio permiso total para trabajar y **delegó el merge de los PR en `phase-gate`**. El merge solo ocurre si el Gate pasó entero.
- **Todas las dudas se resuelven al inicio de cada fase** (al analizar el bloque del ROADMAP, con una sola tanda de preguntas). Después la fase corre sola: no preguntar entre tareas ni pedir confirmación de comandos; decidir con criterio y anotar la decisión aquí.
- Permisos: `.claude/settings.local.json` (gitignored) tiene `defaultMode: bypassPermissions` y allow de todas las herramientas; solo quedan en `deny` force-push, `reset --hard`, borrar repos y `rm -rf /*`.
- **La sesión de Claude Code se abre en `d:\proyectosLimoncin` (carpeta padre), no en el repo.** Por eso las skills de `erp-web-bridge/.claude/skills/` y su `settings.local.json` no se cargaban. Solución: en `d:\proyectosLimoncin\.claude\` hay skills delegadoras (`retomar`, `next-task`, `phase-gate`, `guardar-estado`, que remiten a las reales del repo) y una copia de `settings.local.json` con los mismos permisos. Si se cambian las skills o permisos del repo, las delegadoras no necesitan cambio, pero `settings.local.json` debe mantenerse igual en ambos sitios. Esa carpeta padre no es un repo git.
- Una rama y un PR por fase. Nada de push directo a `main`.
- Hace `/clear` cuando se lo digo, y arranca la fase siguiente con `/retomar`.
- Cuenta de GitHub: **Pepitocrackking** (la activa en `gh`; también está autenticada THO-Orlando, sin uso).
- Los commits van con el correo `noreply` de GitHub (`361565448+Pepitocrackking@users.noreply.github.com`), pasado con `git -c user.name="Orlando Guerra" -c user.email=...`. No se modifica la configuración global de git, porque el repo es público y el correo global es personal.
- Cada commit termina con la línea `Co-Authored-By` que indique el entorno; cada PR, con la línea de atribución de Claude Code.

## Decisiones vigentes
- Agente en Go. Saint es el ERP principal, probado con un sandbox SQL Server 2022 en Docker.
- Odoo, el scraper BCV y los precios escalonados están en el backlog v1. En el MVP: carrito estándar con validación de límite de crédito y tasa de cambio manual.
- Los pedidos web llegan al ERP solo como borradores, nunca en tablas fiscales.
- El nombre exacto de las columnas de Saint es de mejor esfuerzo; vive en `infra/saint-sandbox/mapping.saint.yaml` y debe validarse contra una base real.
- Las skills se llaman `guardar-estado` y `retomar` (no `checkpoint` ni `resume`) porque `/resume` y `/checkpoint` son comandos integrados de Claude Code y tienen prioridad sobre las skills del proyecto. Evitar nombres de comandos integrados al crear skills nuevas.
- **NestJS 11.x, no 12.** Nest 12 es solo ESM y rompe jest/ts-jest y el consumo de `shared-types` (CommonJS). No subir a 12 sin migrar todo el workspace a ESM. Por lo mismo: `@nestjs/swagger` en **11.x** (la 12 exige Nest 12), `@apidevtools/swagger-parser` en la **10** (la 13 es solo ESM) y **sin `jose`** (solo ESM): el JWT HS256 se verifica con `node:crypto` en `apps/api/src/auth/jwt.ts`.
- TypeScript fijado en `~5.9.3` (la 7.x está disponible pero no se ha probado con Nest, Next ni ts-jest).
- **API (Fase 4):** `pg` directo (no supabase-js), conectando como `postgres` (salta RLS) en el lado del agente, **con el aislamiento entre tenants garantizado por el código** (el `org_id` sale siempre de la API key y cada sentencia lo filtra; hay pruebas); los endpoints de usuario ejecutan como `authenticated` con los claims del JWT (`DatabaseService.withUser`), así que RLS decide. Los esquemas Zod de `shared-types` son la única fuente de verdad de los contratos: validan en la API y generan el OpenAPI.
- **JWT de usuario (Fase 6):** la API verifica ES256 (JWKS de Supabase Auth) y HS256 (secreto compartido); el algoritmo lo fija la clave, nunca el token. Sin `jose` (solo ESM): todo con `node:crypto`.
- **Web (Fase 6):** el estado del carrito vive en el navegador y se cotiza siempre en el servidor; las lecturas van por RLS y las escrituras de negocio por la API desde acciones de servidor; la PWA no guarda páginas de un usuario para otro.
- **Crédito de pedidos:** `current_debt_usd` + pedidos en `pending_sync` y `synced_to_erp` + total nuevo ≤ `credit_limit_usd`; los aprobados se asumen ya reflejados en la deuda tras la siguiente sincronización de clientes.

## Trampas conocidas del entorno
- **Supabase local (Fase 3):** CLI 3.4.0 en la raíz (`pnpm exec supabase ...`; atajos `pnpm db:start|stop|reset|status`; ver `docs/supabase-local.md`). La pila usa los puertos 54321 a 54324, la BD es `postgresql://postgres:postgres@127.0.0.1:54322/postgres` y el contenedor `supabase_db_erp-web-bridge`. `pnpm test:db` corre las 30 pruebas de RLS. El primer `supabase start` descarga imágenes (~4 min). En Git Bash, `docker exec ... psql -f /tmp/x.sql` convierte la ruta: pasar el SQL por stdin (`docker exec -i ... psql < archivo`). El CLI muestra avisos pidiendo cambiar a la "pila experimental": ignorarlos, no cambiar `config.jsonc`. El contenedor `supabase_vector_*` entra en bucle de reinicios: es solo el recolector de logs y no afecta a nada.
- **Las pruebas de la API necesitan la base arriba:** `pnpm db:start` antes de `pnpm test`; si no, las suites de integración fallan por conexión. Crean sus propios tenants (ids aleatorios) y los borran; no dependen del seed ni lo ensucian. Los límites de rate limiting se suben en `apps/api/test/setup-env.ts`.
- **No filtrar con `grep` la salida de jest para decidir si pasó:** una suite que no compila aparece como `Test suite failed to run` y no suma al conteo de pruebas; mirar siempre `Test Suites:` y el código de salida. Y encadenar con `&&` solo comandos cuyo código de salida sea fiable (un `| grep` lo enmascara).
- **`pnpm db:start` no añade servicios si la pila ya corre con `-x` (la del CI/Fase 4):** dice "Stopped services: [kong, rest, realtime...]" y no los levanta. Para la pila completa: `pnpm db:stop && pnpm db:start`, luego `pnpm db:reset`. Comprobar con `docker ps` que están `supabase_kong_*` y `supabase_rest_*` antes de los E2E.
- **Playwright en Windows:** los navegadores se instalan con `pnpm exec playwright install chromium` (en `apps/web`). Next añade su propio `role="alert"` (route announcer): acotar los selectores de alertas al formulario.
- **Dependencias solo ESM rompen jest** (CommonJS): `jose`, `@apidevtools/swagger-parser` 13, Nest 12. Antes de añadir una dependencia a la API, comprobar su `"type": "module"`.
- **`pnpm approve-builds` reescribe `pnpm-workspace.yaml` sin el estilo de Prettier:** después, `pnpm exec prettier --write pnpm-workspace.yaml` (si no, `pnpm format:check` falla).
- **Git Credential Manager:** había un diálogo "Select an account" en cada push (dos cuentas guardadas). Resuelto con `git config --local credential.https://github.com.username Pepitocrackking` en este repo. Si reaparece en un clon nuevo, repetirlo.
- Un `git push` puede tardar más de 2 minutos en terminar: usarlo con `run_in_background` o esperar su notificación, no lanzar otro.
- `pnpm-workspace.yaml` tiene `allowBuilds` para `@parcel/watcher` y `@scarf/scarf` en `false`. pnpm 12 bloquea los scripts de build de las dependencias nuevas: si un `pnpm install` termina con `ERR_PNPM_IGNORED_BUILDS`, decidir con `pnpm approve-builds '<pkg>'` o `'!<pkg>'`.
- pnpm 12 aplica una política de edad mínima de releases: una versión recién publicada puede hacer fallar `pnpm install` ("lockfile contains entries that the active policies reject"). Si el lockfile es propio, `rm pnpm-lock.yaml && pnpm install`. Además, `pnpm add <paquete>` sin versión puede traer una major que exige una plataforma más nueva (pasó con `@nestjs/swagger` 12): mirar `pnpm view <paquete> peerDependencies` y fijar la versión.
- En este shell los heredocs largos y los `node -e '...'` con muchas comillas fallan con `unexpected EOF`: crear archivos con las herramientas Write/Edit, o escribir el script en un archivo (`$TEMP/x.js`) y ejecutarlo. Un `python3 - <<...` vacío se cuelga: no usarlo. No pasar a Write rutas relativas con `..\..` (creó un directorio `D:\Users` por error; ya se borró).
- Prettier ignora md, docs, infra, scripts, `docker-compose.yml` y Go (`.prettierignore`); si no, reformatea archivos de otras fases.
- `pnpm install` desde un clon limpio tarda entre 30 s y 2 min.

- **Windows/Git Bash:** `taskkill //IM nombre.exe //F` y `taskkill //PID n //F` (doble barra); el PID de la API se saca con `netstat -ano | grep :3001`. `grep -P` no funciona en este shell. Los `.exe` y los `.db` van en el scratchpad, no en el repo (`.gitignore` ya cubre `*.exe`, `*.db`, `*.db-wal`, `*.db-shm`).
- **Go + SQLite pura Go:** `modernc.org/sqlite` no necesita CGO, pero `go test -race` sí lo usa para el detector (funciona en esta máquina). El agente usa una sola conexión SQLite (`SetMaxOpenConns(1)`): no abrir transacciones anidadas con el mismo `Store`.

- **Realtime:** hay que fijar el JWT con `authorizeRealtime(supabase)` (`apps/web/lib/supabase/client.ts`) **antes de `.subscribe()`**; si no, el canal se une como `anon` y falla con `invalid column for filter org_id` (mensaje `system` en el websocket) aunque el callback diga `SUBSCRIBED`. Una tabla solo emite eventos si está en la publicación `supabase_realtime` (migraciones `..0800` y `..0900`).
- **JWT de usuario = ES256** en el Auth actual: las pruebas de la API que firman HS256 a mano **no** demuestran que un login real funcione; comprobar siempre con un token de GoTrue (`POST /auth/v1/token?grant_type=password`).
- **Lighthouse ≥ 12 ya no tiene categoría PWA:** usar `pnpm dlx lighthouse@11 ... --only-categories=pwa` con `CHROME_PATH` (Chrome del sistema).
- **E2E (Playwright):** el helper de login usa `exact: true` para "Entrar" (en `/login` hay también "Entrar como Administrador Demo"); Next añade su propio `role="alert"`, así que acotar los selectores de alertas al formulario. Las pruebas deben tolerar datos de corridas anteriores (usuarios, pedidos y productos nuevos) y restaurar lo que cambian en un `finally`.

## Bloqueos y preguntas abiertas
- Ninguno.

## Cómo levantar el proyecto
- Supabase local: `pnpm db:start`, `pnpm db:reset` (migraciones y seed), `pnpm test:db` (RLS); detalles en `docs/supabase-local.md`.
- Sandbox de Saint: `bash scripts/saint-sandbox.sh up` (o `powershell -File scripts\saint-sandbox.ps1 up`); detalles en `docs/saint-sandbox.md`.
- TypeScript: `pnpm install`, luego `pnpm build`, `pnpm test` (necesita Supabase arriba), `pnpm lint`, `pnpm format:check`. API compilada: `PORT=3001 node apps/api/dist/main.js`; `GET /health`, `/docs` y `/openapi.json`. Variables en `.env.example` (`DATABASE_URL`, `SUPABASE_JWT_SECRET`, `RATE_LIMIT_*`, `TRUST_PROXY`, `DOCS_ENABLED`). Claves de desarrollo del seed: `erp_dev_demo_saint_key` (org `demo-saint`) y `erp_dev_demo_mock_key` (org `demo-mock`).
- Go: `cd packages/erp-agent && go build ./... && go test ./... && go vet ./... && gofmt -l .` (con `SAINT_TEST_DSN` definida corre también la prueba contra el sandbox real). Agente: `CGO_ENABLED=0 go build -o erp-agent.exe ./cmd/erp-agent` y `erp-agent -config agent.yaml [-once] [-reconcile]` (ver `packages/erp-agent/README.md` y `agent.example.yaml`).
- **Receta E2E del agente (la usó el Gate 5; sirve para la Fase 7):** `bash scripts/saint-sandbox.sh reset`, `pnpm db:reset`, `pnpm build`, `PORT=3001 node apps/api/dist/main.js` (en segundo plano), crear una organización propia por `docker exec -i supabase_db_erp-web-bridge psql -U postgres` con `api_key_hash = encode(extensions.digest('<clave>','sha256'),'hex')`, y correr el agente con un `agent.yaml` (en el scratchpad) apuntando a `http://localhost:3001`. Mutar Saint con `docker exec -i saint-sql bash -c '/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MSSQL_SA_PASSWORD" ...' < archivo.sql` (con `MSYS_NO_PATHCONV=1`). Al terminar: borrar la organización de prueba y `saint-sandbox.sh reset`.
- Web: copiar las variables `NEXT_PUBLIC_*` de `.env.example` a `apps/web/.env.local` (gitignored) y `pnpm --filter @erp-web-bridge/web dev`. E2E: `pnpm db:reset` y luego `pnpm e2e` dentro de `apps/web` (compila y levanta la API y la web; usa `DEMO_MODE=true`; los navegadores se instalan una vez con `pnpm exec playwright install chromium`).
- Validar el flujo de trabajo: `bash scripts/validate-workflow.sh`.

## Última actualización
2026-11-26. Tarea 7.1 hecha (borradores en el sandbox). Falta 7.2 a 7.4 y el Gate 7.
