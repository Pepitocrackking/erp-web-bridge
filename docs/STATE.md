# STATE

Memoria del proyecto entre sesiones. Lo actualiza la skill `guardar-estado` y lo lee `retomar`. Se importa desde `CLAUDE.md`, así que se carga solo tras un `/clear`.

## Posición
- **Fase actual:** 4, API (NestJS)
- **Rama:** `phase-4/api` (creada desde `main` tras el merge del PR #4; aún sin push)
- **Última tarea completada:** 4.4 (errores en `sync_logs` y heartbeat). Antes: 4.3 (clientes), 4.2 (productos), 4.1 (autenticación).
- **Estado de la fase:** en curso. Siguiente tarea: 4.5

## Fases cerradas
- **Fase 0** (PR #1, fusionado el 2026-11-26): repo, `CLAUDE.md`, ROADMAP, STATE, 4 skills, plantilla de PR y `scripts/validate-workflow.sh`.
  - Pendiente menor: el usuario confirma que `/retomar` aparece como skill en una sesión nueva (último criterio del Gate 0).
- **Fase 1** (PR #2, fusionado el 2026-11-26): sandbox de Saint en Docker. Evidencia en `docs/evidence/phase-1.md`.
  - `docker-compose.yml` (servicios `saint-sql` y `saint-init`), `.env.example`, `infra/saint-sandbox/` (init SQL idempotente, seed generado por `tools/gen-seed.mjs`, `mapping.saint.yaml`, `tools/` con reset/mutate/checksum/validate-mapping/gate), `scripts/saint-sandbox.sh` y `.ps1`, `docs/saint-sandbox.md`.
  - Datos: 311 productos, 10 categorías, 3 depósitos (001, 002, 003), 48 clientes (algunos cerca o por encima de su límite de crédito). Códigos `P00001...` y `C00001...`.
  - Cómo levantarlo: `bash scripts/saint-sandbox.sh up` (ver "Cómo levantar el proyecto").
- **Fase 2** (PR #3, fusionado el 2026-11-26): monorepo y CI. Evidencia en `docs/evidence/phase-2.md`.
  - Workspace pnpm + Turborepo: `apps/api` (NestJS 11, `GET /health`), `apps/web` (Next.js 16 + Tailwind 4), `packages/shared-types` (contratos Zod en `src/contracts.ts`: `productSchema`, `productRecordSchema` con `sync_hash`, `customerSchema`, `orderSchema`, `syncBatchSchema` discriminado por `kind`, máx. 1000 registros; snake_case canónico, esquemas estrictos, 32 pruebas), módulo Go `packages/erp-agent` (`cmd/erp-agent`, `internal/version`).
  - CI en `.github/workflows/ci.yml` (jobs `typescript` y `go`, en cada PR y push a `main`), verde a la primera en el PR. ESLint + Prettier (`pnpm lint`, `pnpm format`, `pnpm format:check`) y `gofmt`/`go vet` en el job de Go.
- **Fase 3** (PR #4, fusionado el 2026-11-26, CI en verde): base de datos multi-tenant en Supabase local. Evidencia en `docs/evidence/phase-3.md`.
  - CLI `supabase` 3.4.0 (devDependency), `supabase/config.jsonc`, 3 migraciones (`base`, `schema`, `rls`), `seed.sql` con 2 organizaciones, `supabase/tests/rls.test.mjs` (30 pruebas, `pnpm test:db`), atajos `pnpm db:start|stop|reset|status`, `docs/supabase-local.md`.

## Siguiente acción
Ejecutar la tarea **4.5** (tasa de cambio manual). Después 4.6 y 4.7 en orden, y `phase-gate` con el Gate 4 (bloque `## Fase 4` del ROADMAP). La tanda de dudas ya se resolvió (sin preguntas: se aplicó lo de abajo). **Hecho en 4.1** (ya existe, reutilizar): `src/config.ts` (`loadConfig`, `APP_CONFIG`), `src/database/database.module.ts` (módulo global; `DatabaseService.pool` y `withUser(userId, fn)` para consultas bajo RLS), `src/auth/` (`ApiKeyGuard` pone `req.agent = {orgId, slug}`, decorador `@Agent()`; `JwtGuard` + `@CurrentUser()`; `verifyHs256Jwt` propio con `node:crypto`, porque `jose` es solo ESM y rompe jest; algoritmo fijado a HS256, exige `exp`, `sub` y `role=authenticated`), y `test/helpers.ts` (`createTenant`, `createStaffUser`, `cleanup`, `userToken`, `signJwt`: pruebas de integración con tenants propios, sin depender del seed). Los guards se aplican con `@UseGuards(...)` por controlador. **Hecho en 4.2:** `src/sync/` con `BatchRunner` (transacción por lote: bloqueo asesor por org+entidad+batch_id, idempotencia por `batch_id` vía `sync_logs`, bitácora `success` y `organizations.last_sync_at` en la misma transacción, errores de datos de Postgres clase 22 a 422), `ProductsSyncService` (upsert por `unnest` + `ON CONFLICT`, compara campos para no tocar filas sin cambios) y `SyncController`; `src/common/zod-validation.pipe.ts`; `src/setup.ts` (`configureApp`: cuerpo JSON hasta 5 MB; `main.ts` y las pruebas crean la app con `bodyParser: false`). **Hecho en 4.3:** `CustomersSyncService` (mismo patrón; el ERP no pisa `price_list_id`) y `src/sync/reconciliation.ts` (`applyReconciliation` y `findDuplicates`, compartidos por productos y clientes). **Hecho en 4.4:** `SyncFailureLogInterceptor` (`@SyncEntityName`) anota en `sync_logs` (`status = error`, `batch_id` solo si es UUID válido, detalle `código + mensaje` acotado a 1000, sin valores del lote; los 500 guardan texto genérico) todo fallo de un lote de un agente autenticado, incluidos 400, 409 y 422; un lote fallido no consume su `batch_id`. `POST /v1/agent/heartbeat` (`src/agent/`): actualiza `organizations.last_heartbeat_at` y `agent_version` (migración `20261126000400_agent_heartbeat.sql`) y solo escribe en `sync_logs` (`entity = heartbeat`) si el agente reporta `last_error`, para no generar una fila por minuto. Contratos `heartbeatSchema` y `heartbeatResponseSchema`. Plan para el resto (si no hay motivo para cambiarlo, seguirlo):

- **Acceso a datos: `pg` directo, no supabase-js.** Ya es devDependency de la raíz (pasarla a `dependencies` de `apps/api`). El upsert masivo de 5.000 productos se hace con una sola sentencia (`INSERT ... SELECT * FROM unnest(...) ON CONFLICT (org_id, erp_sku) DO UPDATE`), por lotes de hasta 1000 como fija `SYNC_BATCH_MAX_RECORDS`. Conectar como `postgres` salta RLS: **el aislamiento entre tenants lo garantiza el código** (el `org_id` sale siempre de la API key, nunca del cuerpo) y hay que probarlo (Gate: una key de A no escribe en B).
- **Endpoints de usuario (JWT, p. ej. tasa de cambio en 4.5):** preferible ejecutar la consulta en una transacción con `SET LOCAL ROLE authenticated` y `request.jwt.claims` (como hacen las pruebas de `supabase/tests/rls.test.mjs`), de modo que RLS y las políticas ya escritas aplican solos. Verificar el JWT con el secreto HS256 local (`JWT_SECRET` de `supabase status`: `super-secret-jwt-token-with-at-least-32-characters-long`); en producción habrá que pasar a JWKS.
- **Validación:** reutilizar los esquemas Zod de `packages/shared-types` (`syncBatchSchema`, `customerSchema`, `orderSchema`...) con un pipe propio; no duplicar contratos. **Rate limiting:** `@nestjs/throttler`. **OpenAPI:** `@nestjs/swagger`. Nest sigue en 11.x (no subir a 12, ver Decisiones).
- **API key:** la clave llega en `x-api-key`, se hashea con SHA-256 (hex) y se busca por `organizations.api_key_hash` (único). Comparar en tiempo constante. Claves de desarrollo del seed: `erp_dev_demo_saint_key` (org A, `demo-saint`, id `b0000000-0000-4000-8000-00000000000a`) y `erp_dev_demo_mock_key` (org B, `demo-mock`, id `...00000b`). Organización inactiva (`is_active = false`) debe rechazarse.
- **Pedidos (4.6):** los crea solo la API (los usuarios no tienen INSERT en `web_orders`). Validar límite de crédito: `current_debt_usd` + pedidos aún no sincronizados + total nuevo ≤ `credit_limit_usd`. El precio sale de la lista del cliente (`product_prices`, y si no hay, `products.price_usd`), la tasa de `organizations.exchange_rate_bs`. Confirmación idempotente: pasar a `synced_to_erp` con `erp_order_reference` una sola vez; confirmar dos veces no duplica ni cambia nada (Gate). Estados válidos: `pending_sync`, `synced_to_erp`, `approved`, `rejected`, `cancelled`, `error`.
- **Tasa (4.5):** insertar en `exchange_rates` (`source = manual`, `set_by` = usuario); el trigger `apply_exchange_rate` actualiza `organizations.exchange_rate_bs`.
- **Sincronización (4.2 a 4.4):** cada lote deja una fila en `sync_logs` (`direction = erp_to_cloud`, `entity`, `batch_id`, `status` en `success|partial|error`) y actualiza `organizations.last_sync_at`. **DECIDIDO (4.2):** una reconciliación completa viaja en varios lotes con `full_reconciliation: true` y un `reconciliation_id` común (UUID); el último lleva `final_batch: true` y `total_records` (el tamaño del inventario completo). Cada fila recibida se sella con `reconciliation_id`; solo en el último lote se desactiva (`is_active = false`, no se borra) lo que no tenga el sello, y únicamente si el conteo de sellados == `total_records`; si no cuadra: 409, se revierte también ese lote y no se desactiva nada (el reintento con el mismo `batch_id` sigue permitido). Los lotes deben enviarse en orden y de uno en uno (el agente de la Fase 5 lo cumplirá). Migración `20261126000300_sync_reconciliation.sql`. SKU repetido dentro de un lote: 422. `sync_hash` lo calcula el agente; la API lo guarda y puede usarlo para omitir filas sin cambios.
- **Pruebas de integración contra Postgres real** (Gate): usar la base local de Supabase (`pnpm db:start`, `pnpm db:reset` para el seed) con Jest + supertest, sin mocks de base. Crear sus propios tenants con ids propios o transacciones, y no depender de que el seed esté en un estado concreto. Medir y registrar en la evidencia los tiempos de ingesta de 5.000 productos.
- **Variables de entorno:** `DATABASE_URL` (por defecto `postgresql://postgres:postgres@127.0.0.1:54322/postgres`) y `SUPABASE_JWT_SECRET`; documentarlas en `.env.example`, sin secretos reales.
- **CI:** el job `typescript` no levanta Supabase. Para las pruebas de integración del Gate 4 conviene añadir un job que instale el CLI y haga `supabase start` (descarga imágenes, unos minutos); el Gate pide que corran en verde, y si el CI no puede, dejar constancia en la evidencia de dónde se ejecutaron.

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
- **NestJS 11.x, no 12.** Nest 12 es solo ESM y rompe jest/ts-jest y el consumo de `shared-types` (CommonJS): con la 12, `pnpm test` en la API falló con `Must use import to load ES Module`. No subir a 12 sin migrar todo el workspace a ESM.
- TypeScript fijado en `~5.9.3` (la 7.x está disponible pero no se ha probado con Nest, Next ni ts-jest).

## Trampas conocidas del entorno
- **Supabase local (Fase 3):** CLI 3.4.0 en la raíz (`pnpm exec supabase ...`; atajos `pnpm db:start|stop|reset|status`; ver `docs/supabase-local.md`). La pila usa los puertos 54321 a 54324, la BD es `postgresql://postgres:postgres@127.0.0.1:54322/postgres` y el contenedor `supabase_db_erp-web-bridge`. `pnpm test:db` corre las 30 pruebas de RLS. El primer `supabase start` descarga imágenes (~4 min). En Git Bash, `docker exec ... psql -f /tmp/x.sql` convierte la ruta: pasar el SQL por stdin (`docker exec -i ... psql < archivo`). El CLI muestra avisos pidiendo cambiar a la "pila experimental": ignorarlos, no cambiar `config.jsonc`.
- **Git Credential Manager:** había un diálogo "Select an account" en cada push (dos cuentas guardadas). Resuelto con `git config --local credential.https://github.com.username Pepitocrackking` en este repo. Si reaparece en un clon nuevo, repetirlo.
- Un `git push` puede tardar más de 2 minutos en terminar: usarlo con `run_in_background` o esperar su notificación, no lanzar otro.
- `pnpm-workspace.yaml` tiene `allowBuilds: '@parcel/watcher': false` (dependencia nativa opcional de jest, solo para `--watch`). pnpm 12 bloquea los scripts de build de las dependencias nuevas: si un `pnpm install` termina con `ERR_PNPM_IGNORED_BUILDS`, decidir con `pnpm approve-builds '<pkg>'` o `'!<pkg>'`.
- pnpm 12 aplica una política de edad mínima de releases: una versión recién publicada puede hacer fallar `pnpm install` ("lockfile contains entries that the active policies reject"). Si el lockfile es propio, `rm pnpm-lock.yaml && pnpm install`.
- En este shell los heredocs largos (`cat > f <<'EOF'` con muchos archivos en un solo comando) fallan con `unexpected EOF`: crear archivos con la herramienta Write. Un `python3 - <<...` vacío se cuelga: no usarlo.
- Prettier ignora md, docs, infra, scripts, `docker-compose.yml` y Go (`.prettierignore`); si no, reformatea archivos de otras fases.
- `pnpm install` desde un clon limpio tarda unos 2 minutos.

## Bloqueos y preguntas abiertas
- Ninguno.

## Cómo levantar el proyecto
- Supabase local: `pnpm db:start`, `pnpm db:reset` (migraciones y seed), `pnpm test:db` (RLS); detalles en `docs/supabase-local.md`.
- Sandbox de Saint: `bash scripts/saint-sandbox.sh up` (o `powershell -File scripts\saint-sandbox.ps1 up`); detalles en `docs/saint-sandbox.md`.
- TypeScript: `pnpm install`, luego `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check`. API compilada: `PORT=3001 node apps/api/dist/main.js` y `GET /health`.
- Go: `cd packages/erp-agent && go build ./... && go test ./... && go vet ./... && gofmt -l .`
- Validar el flujo de trabajo: `bash scripts/validate-workflow.sh`.

## Última actualización
2026-11-26. Fase 4 en curso: 4.1 a 4.4 hechas (API: 72 pruebas, 62 de integración contra Postgres real; ingesta de 5.000 productos en ~0,4 s).
