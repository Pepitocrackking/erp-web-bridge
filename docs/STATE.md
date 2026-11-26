# STATE

Memoria del proyecto entre sesiones. Lo actualiza la skill `guardar-estado` y lo lee `retomar`. Se importa desde `CLAUDE.md`, así que se carga solo tras un `/clear`.

## Posición
- **Fase actual:** 5, Agente Go: **todas las tareas (5.1 a 5.7) y el Gate 5 completos**; en cierre (push, PR y merge por `phase-gate`).
- **Rama:** `phase-5/agent`
- **Siguiente:** Fase 6 (Web), rama `phase-6/web`, tarea 6.1.

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
- **Fase 5** (Gate 5 verificado el 2026-11-26): agente Go. Evidencia en `docs/evidence/phase-5.md`.
  - Módulo `packages/erp-agent` (un `.exe` de ~18 MB, `CGO_ENABLED=0`). Paquetes en `internal/`: `erp` (modelo canónico + interfaz `Adapter`), `erp/mock`, `erp/saint` (lee `mapping.saint.yaml`, sin columnas en el código), `delta` (hash SHA-256 de `skupreciostocknombre` con 2 decimales; el diff compara una huella que además cubre categoría y activo), `batch` (lotes con la forma exacta del contrato, validados con el Zod real), `sync` (ciclo delta/reconciliación; `ErrEmptyInventory` protege el catálogo), `store` (SQLite pura Go: huellas, `meta`, cola `outbox`; WAL + synchronous FULL), `api` (cliente y clasificación de errores), `sender` (de uno en uno y en orden, backoff 1 s a 5 min con jitter, respeta `Retry-After`), `config` (YAML estricto), `agent` (une todo, heartbeat, apagado limpio). README del agente y `agent.example.yaml`.
  - Uso: `erp-agent -config agent.yaml [-once] [-reconcile]`; secretos por `ERP_AGENT_API_KEY` y `ERP_AGENT_SAINT_DSN`. Prueba contra el sandbox real: `SAINT_TEST_DSN` (si no, se omite).
  - E2E real: 311 productos y 48 clientes con conteos y sumas iguales; 1 producto mutado = 1 registro en `sync_logs`; corte de red y `kill -9` del agente sin pérdida de datos; la reconciliación desactiva lo eliminado.
  - Backlog que quedó fuera: ejecutar el agente como servicio de Windows; validar el mapeo contra un Saint real; pedidos hacia el ERP (Fase 7).

## Siguiente acción
Cerrar la Fase 5 (push, PR, CI y merge con `phase-gate`) y escribir aquí el relevo de la Fase 6.

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
- **Crédito de pedidos:** `current_debt_usd` + pedidos en `pending_sync` y `synced_to_erp` + total nuevo ≤ `credit_limit_usd`; los aprobados se asumen ya reflejados en la deuda tras la siguiente sincronización de clientes.

## Trampas conocidas del entorno
- **Supabase local (Fase 3):** CLI 3.4.0 en la raíz (`pnpm exec supabase ...`; atajos `pnpm db:start|stop|reset|status`; ver `docs/supabase-local.md`). La pila usa los puertos 54321 a 54324, la BD es `postgresql://postgres:postgres@127.0.0.1:54322/postgres` y el contenedor `supabase_db_erp-web-bridge`. `pnpm test:db` corre las 30 pruebas de RLS. El primer `supabase start` descarga imágenes (~4 min). En Git Bash, `docker exec ... psql -f /tmp/x.sql` convierte la ruta: pasar el SQL por stdin (`docker exec -i ... psql < archivo`). El CLI muestra avisos pidiendo cambiar a la "pila experimental": ignorarlos, no cambiar `config.jsonc`. El contenedor `supabase_vector_*` entra en bucle de reinicios: es solo el recolector de logs y no afecta a nada.
- **Las pruebas de la API necesitan la base arriba:** `pnpm db:start` antes de `pnpm test`; si no, las suites de integración fallan por conexión. Crean sus propios tenants (ids aleatorios) y los borran; no dependen del seed ni lo ensucian. Los límites de rate limiting se suben en `apps/api/test/setup-env.ts`.
- **No filtrar con `grep` la salida de jest para decidir si pasó:** una suite que no compila aparece como `Test suite failed to run` y no suma al conteo de pruebas; mirar siempre `Test Suites:` y el código de salida. Y encadenar con `&&` solo comandos cuyo código de salida sea fiable (un `| grep` lo enmascara).
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

## Bloqueos y preguntas abiertas
- Ninguno.

## Cómo levantar el proyecto
- Supabase local: `pnpm db:start`, `pnpm db:reset` (migraciones y seed), `pnpm test:db` (RLS); detalles en `docs/supabase-local.md`.
- Sandbox de Saint: `bash scripts/saint-sandbox.sh up` (o `powershell -File scripts\saint-sandbox.ps1 up`); detalles en `docs/saint-sandbox.md`.
- TypeScript: `pnpm install`, luego `pnpm build`, `pnpm test` (necesita Supabase arriba), `pnpm lint`, `pnpm format:check`. API compilada: `PORT=3001 node apps/api/dist/main.js`; `GET /health`, `/docs` y `/openapi.json`. Variables en `.env.example` (`DATABASE_URL`, `SUPABASE_JWT_SECRET`, `RATE_LIMIT_*`, `TRUST_PROXY`, `DOCS_ENABLED`). Claves de desarrollo del seed: `erp_dev_demo_saint_key` (org `demo-saint`) y `erp_dev_demo_mock_key` (org `demo-mock`).
- Go: `cd packages/erp-agent && go build ./... && go test ./... && go vet ./... && gofmt -l .` (con `SAINT_TEST_DSN` definida corre también la prueba contra el sandbox real). Agente: `CGO_ENABLED=0 go build -o erp-agent.exe ./cmd/erp-agent` y `erp-agent -config agent.yaml [-once] [-reconcile]` (ver `packages/erp-agent/README.md` y `agent.example.yaml`).
- **Receta E2E del agente (la usó el Gate 5; sirve para la Fase 7):** `bash scripts/saint-sandbox.sh reset`, `pnpm db:reset`, `pnpm build`, `PORT=3001 node apps/api/dist/main.js` (en segundo plano), crear una organización propia por `docker exec -i supabase_db_erp-web-bridge psql -U postgres` con `api_key_hash = encode(extensions.digest('<clave>','sha256'),'hex')`, y correr el agente con un `agent.yaml` (en el scratchpad) apuntando a `http://localhost:3001`. Mutar Saint con `docker exec -i saint-sql bash -c '/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MSSQL_SA_PASSWORD" ...' < archivo.sql` (con `MSYS_NO_PATHCONV=1`). Al terminar: borrar la organización de prueba y `saint-sandbox.sh reset`.
- Validar el flujo de trabajo: `bash scripts/validate-workflow.sh`.

## Última actualización
2026-11-26. Fase 5 completa y con el Gate verificado; cierre en curso.
