# STATE

Memoria del proyecto entre sesiones. Lo actualiza la skill `guardar-estado` y lo lee `retomar`. Se importa desde `CLAUDE.md`, así que se carga solo tras un `/clear`.

## Posición
- **Fase actual:** 6, Web (catálogo, carrito y panel)
- **Rama:** `phase-6/web` (creada desde `main` tras el merge del PR #6; aún sin push)
- **Última tarea completada:** 6.1 (catálogo B2B con búsqueda, categorías y precios USD/Bs).
- **Estado de la fase:** en curso. Siguiente tarea: 6.2 (esfuerzo alto: autenticación y aprobación).

### Decisiones de la Fase 6 (tanda de dudas resuelta el 2026-11-26; no volver a preguntar)
- **6.2:** solicitud de acceso. El comprador se registra con Supabase Auth y deja una solicitud (`customer_access_requests`: org, email, RIF, estado pending/approved/rejected). Hasta que el admin la apruebe no ve nada por RLS; al aprobar se crea su `org_members` (rol `customer`) con el cliente que coincida por RIF/código. Migración nueva + pruebas de RLS.
- **E2E (Playwright):** solo en local; el CI no cambia. La evidencia va a `docs/evidence/phase-6.md`.
- **6.6:** el simulador envía por `POST /v1/sync/products` desde una acción de servidor de Next con la clave de agente de la organización demo (solo en el servidor).
- **6.5 y 6.7:** botón demo = acción de servidor que entra como `admin@demo-saint.test`, solo con `DEMO_MODE=true`. PWA = manifest + service worker propio (precaché del shell y stale-while-revalidate del catálogo), validada con Lighthouse. Componentes propios con Tailwind, sin librería de UI.

### Hecho en la 6.1 (para no rehacerlo)
- `packages/shared-types/src/money.ts`: `usdToBs` (BigInt, mitad hacia arriba, 2 decimales), `formatUsd`, `formatBs` (`$ 1.234,50`, `Bs. 1.234,50`). **Única fuente** de la conversión: reutilizar en 6.3/6.4/6.6.
- Migración `..0600_catalog.sql`: vista `catalog_categories` (`security_invoker`, solo activos) + 3 pruebas en `rls.test.mjs` (ahora 33).
- `apps/web`: `lib/supabase/{env,server}.ts`, `proxy.ts` (refresca sesión y manda a `/login` desde `/catalogo`), `lib/catalog.ts` (parseo de URL, filtro de búsqueda sanitizado, precio por rol, `fetchMembership/fetchCategories/fetchCatalog`), `/login` (acción `signIn`/`signOut`, solo inicio de sesión: **el registro llega en 6.2**), `/catalogo` (búsqueda GET, categorías, 24 por página), `ProductCard`.
- El comprador ve el precio de su lista (`product_prices` embebido; RLS ya filtra por su lista) y el personal el precio base. La organización activa es la primera membresía del usuario (selector de organización: backlog).
- Variables `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL` en `.env.example`; copiarlas a `apps/web/.env.local` (gitignored).
- Playwright 1.65 en `apps/web` (`pnpm --filter @erp-web-bridge/web e2e`, o `pnpm e2e` desde `apps/web`): compila y levanta la web en el puerto 3100; 12 pruebas en `e2e/catalog.spec.ts` + `e2e/helpers.ts` (usuarios del seed). Necesita Supabase **completo** arriba y el seed (`pnpm db:reset`).

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

## Siguiente acción
Ejecutar la tarea **6.2**, luego 6.3 a 6.7 en orden, y `phase-gate` con el Gate 6 (bloque `## Fase 6` del ROADMAP). **La tanda de dudas de la fase ya se hizo** (ver "Decisiones de la Fase 6"): no volver a preguntar. Lo de abajo es el contexto original de la fase; los puntos 1 a 4 de "puntos de diseño" ya están resueltos arriba.

**Esfuerzo sugerido:** medio para 6.1, 6.5 y 6.7; alto para 6.2 (autenticación y aprobación: toca seguridad y probablemente una migración), 6.3 (crédito y dinero) y 6.4 (Realtime); medio-alto para 6.6 (simulador que dispara una sincronización real). El Gate 6 pide Playwright: decidir al principio.

**Estado de `apps/web`:** solo el esqueleto de la Fase 2: Next.js 16 (App Router) + React 19 + Tailwind 4, `app/{layout,page,globals.css}` (una portada de dos líneas), jest + Testing Library (1 prueba), `pnpm lint` = `tsc --noEmit && eslint .`. **No hay** cliente de Supabase, ni Playwright, ni PWA, ni rutas. Paquete `@erp-web-bridge/web`; los contratos están en `@erp-web-bridge/shared-types` (Zod, CommonJS).

**Cómo debe leer datos la web (la API NO tiene endpoints de lectura de catálogo):**
- Lecturas (productos, categorías, clientes, pedidos, tasa, `sync_logs`): **Supabase directo con el JWT del usuario** (`@supabase/supabase-js` + `@supabase/ssr`, PostgREST), y es **RLS** quien decide qué ve cada uno. Políticas ya hechas (`..0200_rls.sql`): `products_select` (personal ve todo; un comprador solo `is_active`), `product_prices`/`price_lists` (el comprador solo su lista, `member_price_list_id`), `b2b_customers_select` (el comprador solo el suyo), `exchange_rates_select` (cualquier miembro), `organizations_select`. Hay que revisar qué más hace falta leer (p. ej. `web_orders`, `sync_logs`) y, si falta una política o un índice, añadir una **migración nueva** (nunca editar las existentes) con su prueba en `supabase/tests/rls.test.mjs`.
- Escrituras de negocio: **por la API NestJS** con `Authorization: Bearer <jwt>` (guard `JwtGuard`): `POST /v1/orgs/:orgId/orders` (crea el pedido; valida crédito; el cuerpo solo trae SKU y cantidad, el servidor fija precios, total y tasa; 422 `credit_limit_exceeded`), `POST /v1/orgs/:orgId/exchange-rate` (solo owner/admin; fija la tasa manual), `GET /v1/orgs/:orgId/exchange-rate` y `/history`. OpenAPI en `/docs` y `/openapi.json` de la API.
- **Supabase local completo** (`pnpm db:start`) incluye PostgREST (`http://127.0.0.1:54321`), GoTrue y Realtime; **el CI solo levanta base de datos y GoTrue** (sin PostgREST ni Realtime). Consecuencia: las pruebas E2E de Playwright del Gate 6 se corren **en local** (o hay que ampliar el `supabase start -x ...` del CI; decidir). Las claves `anon` y `service_role` salen de `pnpm db:status`; variables públicas `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY` y `NEXT_PUBLIC_API_URL` van en `.env.example` (nunca secretos reales).
- **Datos de prueba:** 2 organizaciones con usuarios (contraseña `demo1234`): `admin@demo-saint.test` (owner de demo-saint), `staff@demo-saint.test`, `cliente@demo-saint.test` (rol customer, cliente `C00001`), `admin@demo-mock.test` (owner de demo-mock). Claves de agente `erp_dev_demo_saint_key` y `erp_dev_demo_mock_key`. El seed tiene 45 productos en demo-saint; para tener un catálogo realista se puede correr el agente (`type: mock` con `products: 300`) contra una organización de prueba, o ingerir por `POST /v1/sync/products`.

**Puntos de diseño que el ROADMAP deja abiertos y que hay que decidir en la tanda de dudas (mi propuesta por defecto entre paréntesis):**
1. **6.2 "login con aprobación por el admin": el esquema NO tiene registro ni aprobación.** `org_members` solo admite `customer` atado a un `customer_id` existente, y los usuarios nacen por el seed. Hace falta un mecanismo: (propuesta: solicitud de acceso — tabla `customer_access_requests(org_id, email, tax_id, status pending|approved|rejected, ...)` creada por el comprador al registrarse con Supabase Auth; el admin la aprueba desde el panel, y la aprobación crea la fila de `org_members` con el `customer_id` que coincida por RIF/código; mientras esté pendiente el usuario existe en Auth pero no ve nada por RLS). Requiere migración + pruebas de RLS.
2. **6.5 "Entrar como Administrador Demo":** (propuesta: un botón que inicia sesión como `admin@demo-saint.test` con una acción de servidor de Next, solo habilitada si `DEMO_MODE=true`; en producción real debe estar apagada).
3. **6.6 Simulador de ERP:** (propuesta: una tabla editable en el panel admin con el inventario de una organización demo, cuyos cambios se envían por `POST /v1/sync/products` con la clave de agente de la organización guardada **solo en el servidor**; así se prueba la ruta real de ingesta sin el binario del agente. El `MockAdapter` del agente queda para demos con el binario.)
4. **6.7 PWA:** (propuesta: manifest + service worker propio y sencillo, sin librerías con peso: precaché del shell y caché "stale-while-revalidate" de las lecturas del catálogo; Lighthouse PWA para el Gate).
5. **Playwright** y Lighthouse como devDependencies en la raíz o en `apps/web`; navegadores de Playwright se descargan aparte (`pnpm exec playwright install chromium`); pnpm 12 puede pedir `approve-builds`.
6. **Moneda:** precios en USD en la base; Bs = USD × `exchange_rate_bs` de la organización (la tasa vigente), redondeado a 2 decimales. Hacer una utilidad única y probada (en `shared-types` si la usan API y web) y no repetir la fórmula.
7. **Estilo y UX:** español, Tailwind 4, accesible; sin librería de componentes pesada (propuesta: componentes propios mínimos).

**Lo que ya existe y no hay que rehacer:** validación de crédito y creación de pedidos (API), tasa de cambio manual (API), RLS por `org_id`, ingesta de catálogo, heartbeat y `sync_logs` (el panel de 6.4 los muestra), y el agente Go completo.

**Comandos de la fase:** `pnpm db:start` (Supabase local completo), `pnpm build`, `PORT=3001 node apps/api/dist/main.js`, `pnpm --filter @erp-web-bridge/web dev`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `bash scripts/validate-workflow.sh`.

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
2026-11-26. Fase 6 en curso: tarea 6.1 hecha (12 E2E, 19 pruebas de web, 97 de shared-types, 33 de RLS, 156 de la API en verde).
