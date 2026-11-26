# STATE

Memoria del proyecto entre sesiones. Lo actualiza la skill `guardar-estado` y lo lee `retomar`. Se importa desde `CLAUDE.md`, así que se carga solo tras un `/clear`.

## Posición
- **Fase actual:** 5, Agente Go
- **Rama:** `phase-5/agent` (creada desde `main` tras el merge del PR #5; aún sin push)
- **Última tarea completada:** 5.1 (paquete `internal/erp`: `Product`, `ProductRecord`, `Customer`, interfaz `Adapter` con `Type/Products/Customers`, constantes `TypeSaint`/`TypeMock`; pruebas de JSON snake_case contra el contrato).
- **Además:** 5.2 hecha (`internal/erp/mock`: `mock.New(Config{Products,Customers,Seed})` determinista; mutaciones `SetPrice/SetStock/SetActive/Remove/Add` y `Mutate()` por pasos; seguro entre goroutines).
- **Además:** 5.3 hecha (`internal/erp/saint`: `LoadMapping`/`ParseMapping` valida el YAML (identificadores con regex, `true_when` obligatorio); `New(db, mapping, logger)`; consultas SELECT generadas desde el mapeo con LEFT JOIN a SAINSTA para la categoría; filas inválidas se omiten con `slog.Warn`, stock negativo = 0, SKU repetido = error). Prueba real `TestSandboxReal` (se activa con `SAINT_TEST_DSN='sqlserver://sa:<pwd url-encoded>@localhost:14330?database=SAINT_DEMO&encrypt=disable'`; sin ella se omite): 311 productos, 48 clientes. Dependencias añadidas: `go-mssqldb` v1.12.0 y `yaml.v3`; CI ya cachea por `go.sum`.
- **Estado de la fase:** en curso. Siguiente tarea: 5.4 (hash SHA-256 y SQLite `modernc.org/sqlite`; esfuerzo alto)

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

## Siguiente acción
Ejecutar la tarea **5.1** (interfaz `ERPAdapter` y modelo canónico). Después 5.2 a 5.7 en orden, y `phase-gate` con el Gate 5 (bloque `## Fase 5` del ROADMAP). Como es la primera tarea de la fase, `next-task` hace la **única tanda de dudas** con AskUserQuestion; mi propuesta por defecto para cada una (si no hay motivo para cambiarla, no preguntar):

- **Esfuerzo sugerido:** alto para 5.1 (interfaz que heredan 5.2 a 5.7), 5.4, 5.5 y 5.6 (hash, reconciliación, cola y pérdida de datos); medio para 5.2, 5.3 y 5.7. 5.6 es el único candidato a **muy alto** si falla dos veces (cortes de red o de luz).
- **Estado del módulo Go:** `packages/erp-agent`, módulo `github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent`, `go 1.26` (Go 1.26.5 instalado), **sin dependencias todavía** (ni `go.sum`). Solo existen `cmd/erp-agent/main.go` (imprime la versión) y `internal/version`. Estructura prevista en `internal/` (adapters, sync, cola local), un paquete por responsabilidad. Comandos: `cd packages/erp-agent && go build ./... && go test ./... && go vet ./... && gofmt -l .`.
- **Dependencias propuestas** (un único `.exe` sin CGO): SQL Server `github.com/microsoft/go-mssqldb`; SQLite **pura Go** `modernc.org/sqlite` (no `mattn/go-sqlite3`, que necesita CGO y rompe el `.exe` sin dependencias); YAML `gopkg.in/yaml.v3`; logs con `log/slog` en JSON (biblioteca estándar). Al añadir la primera dependencia aparece `go.sum`: **cambiar `cache-dependency-path: packages/erp-agent/go.mod` por `go.sum` en el job `go` del CI** (o añadir ambos).
- **Configuración:** archivo YAML (URL de la API, `x-api-key`, conexión al ERP, intervalos de sincronización y de reconciliación, ruta de la cola/SQLite). Los secretos no se commitean: solo un `agent.example.yaml`. El mapeo de Saint ya existe en `infra/saint-sandbox/mapping.saint.yaml` (tabla, columna y `filter` por campo canónico): **el `SaintAdapter` lo lee, no hardcodea nombres de columnas**.
- **Modelo canónico:** espejo en Go de los contratos de `packages/shared-types/src/contracts.ts`, con los mismos nombres snake_case en JSON: `Product {sku, name, category?, price_usd, stock, active}`, `ProductRecord` (+ `sync_hash`), `Customer {customer_code, tax_id, business_name, credit_limit_usd, current_debt_usd, active}`. `ERPAdapter` mínimo: `Products(ctx)` y `Customers(ctx)` (lectura completa; el delta lo calcula la capa de sync, no el adaptador), más un nombre/tipo (`saint`, `mock`). Los pedidos hacia el ERP son de la Fase 7: **no implementarlos en la Fase 5**.
- **Hash (5.4):** SHA-256 de `sku + precio + stock + nombre`. Fijar una forma canónica **estable y documentada** (p. ej. campos unidos con un separador que no aparezca en los datos, `price_usd` y `stock` con 2 decimales como los guarda la base `NUMERIC(12,2)`, nombre sin espacios sobrantes) y probarla con vectores fijos. La API guarda `sync_hash` tal cual, no lo verifica. El diff compara contra la tabla de hashes del SQLite local; **solo se envía lo que cambió**.
- **E2E real (Gate 5):** sandbox de Saint (`bash scripts/saint-sandbox.sh up`, `saint-sql` en `localhost,14330`, base `SAINT_DEMO`, usuario `sa`, contraseña `MSSQL_SA_PASSWORD` del `.env`, ver `docs/saint-sandbox.md`) + agente + API compilada (`PORT=3001 node apps/api/dist/main.js` tras `pnpm build`) + Supabase local (`pnpm db:start`). **Usar una organización propia para el E2E**, no `demo-saint` del seed: esa ya tiene 45 productos que no están en Saint y los "conteos iguales" no cuadrarían (tras una reconciliación quedarían desactivados pero contados). Crear la organización por SQL con `erp_type = 'saint'` y `api_key_hash = sha256(clave)`, y comparar `SAPROD` (311) con `products` de esa organización. Para mutar un producto: `scripts/saint-sandbox.sh mutate` toca varios a la vez (`P00001` a `P00012` y el cliente `C00001`), así que para "se muta 1 producto" hace falta una sentencia `UPDATE` propia sobre un solo `CodProd` (con `SAEXIS`, manteniendo `SAPROD.Existen` = suma de `SAEXIS`). La comprobación es en `sync_logs` (`records_processed = 1` del lote de productos).
- **Corte de red (Gate 5):** probar con la API detenida/reiniciada (o un proxy local que se pueda cortar) mientras el agente corre: no debe perder datos y debe ponerse al día al volver. La cola local se persiste en SQLite **con su `batch_id` ya asignado**, y el reenvío usa el MISMO `batch_id` (la API es idempotente por `batch_id`: un reenvío devuelve `duplicate: true` sin repetir trabajo).
- **Contrato de la API que el agente debe respetar** (todo en `/docs` y `docs/evidence/phase-4.md`):
  - Autenticación: cabecera `x-api-key`. La organización sale de la clave; **nunca** se manda `org_id` (el esquema es estricto y lo rechaza con 400). 401 = clave falsa u organización inactiva.
  - `POST /v1/sync/products` y `POST /v1/sync/customers`: cuerpo `{batch_id (uuid), sent_at (ISO), kind, full_reconciliation, records (máx. 1000), [reconciliation_id, final_batch, total_records]}`. Respuesta 200 `{batch_id, duplicate, received, inserted, updated, unchanged, deactivated}`. Cuerpo máximo 5 MB. Los lotes se envían **en orden y de uno en uno**. SKU o `customer_code` repetidos en el lote: 422.
  - **Reconciliación completa:** varios lotes con `full_reconciliation: true` y un mismo `reconciliation_id` (uuid); el último lleva `final_batch: true` y `total_records` = tamaño total del inventario. Los intermedios llevan `final_batch: false` y **sin** `total_records`. En un lote normal esos tres campos no deben aparecer. Solo el último lote desactiva lo ausente (`is_active = false`, no borra) y solo si lo recibido cuadra con `total_records`; si no, **409** y se revierte ese lote (se puede reintentar con el mismo `batch_id`).
  - `POST /v1/agent/heartbeat`: `{agent_version, queue_depth?, last_error?}`; responde `{ok, server_time}`. Solo deja fila en `sync_logs` si trae `last_error`.
  - Errores a tratar: 400/422 = el lote es inválido (no reintentar igual: registrar y descartar o corregir); 401 = configuración; 409 = reconciliación incompleta; 413 = lote demasiado grande; **429 = rate limit, esperar `Retry-After`** (por defecto 60 peticiones por minuto en `/v1/sync/*`, por IP y por ruta); 5xx o red caída = reintentar con backoff.
  - Un lote fallido no consume su `batch_id`: se puede reenviar igual (corregido o no).
- **Trampa de datos:** la API guarda `price_usd` y `stock` con 2 decimales (`NUMERIC(12,2)`) y `credit_limit_usd`/`current_debt_usd` también; Saint usa 4 decimales en algunos campos (`Precio1`, `Costo`). El agente debe **redondear a 2 decimales antes de calcular el hash**, o el hash cambiaría sin que cambie lo guardado.
- **Pendiente heredado:** el CI del job `go` solo cachea por `go.mod`; ver arriba.

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

## Bloqueos y preguntas abiertas
- Ninguno.

## Cómo levantar el proyecto
- Supabase local: `pnpm db:start`, `pnpm db:reset` (migraciones y seed), `pnpm test:db` (RLS); detalles en `docs/supabase-local.md`.
- Sandbox de Saint: `bash scripts/saint-sandbox.sh up` (o `powershell -File scripts\saint-sandbox.ps1 up`); detalles en `docs/saint-sandbox.md`.
- TypeScript: `pnpm install`, luego `pnpm build`, `pnpm test` (necesita Supabase arriba), `pnpm lint`, `pnpm format:check`. API compilada: `PORT=3001 node apps/api/dist/main.js`; `GET /health`, `/docs` y `/openapi.json`. Variables en `.env.example` (`DATABASE_URL`, `SUPABASE_JWT_SECRET`, `RATE_LIMIT_*`, `TRUST_PROXY`, `DOCS_ENABLED`). Claves de desarrollo del seed: `erp_dev_demo_saint_key` (org `demo-saint`) y `erp_dev_demo_mock_key` (org `demo-mock`).
- Go: `cd packages/erp-agent && go build ./... && go test ./... && go vet ./... && gofmt -l .`
- Validar el flujo de trabajo: `bash scripts/validate-workflow.sh`.

## Última actualización
2026-11-26. Fase 4 fusionada (PR #5, CI en verde); rama de la Fase 5 creada con el relevo escrito.
