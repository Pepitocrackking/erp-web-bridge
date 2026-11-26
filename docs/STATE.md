# STATE

Memoria del proyecto entre sesiones. Lo actualiza la skill `guardar-estado` y lo lee `retomar`. Se importa desde `CLAUDE.md`, así que se carga solo tras un `/clear`.

## Posición
- **Fase actual:** 3, Base de datos y multi-tenant
- **Rama:** `phase-3/database` (creada desde `main` tras el merge del PR #3; aún sin push)
- **Última tarea completada:** ninguna de la Fase 3. La Fase 2 está completa y fusionada.
- **Estado de la fase:** por empezar. Siguiente tarea: 3.1

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

## Siguiente acción
Ejecutar la tarea **3.1**: Supabase local con el CLI y migraciones en `supabase/migrations/`. Después, en orden: 3.2 esquema, 3.3 RLS, 3.4 pruebas de RLS, 3.5 seed de dos organizaciones. Luego `phase-gate` con el Gate 3 (ver ROADMAP, bloque `## Fase 3`).

Detalles técnicos para hacerlo bien a la primera:
- **El CLI de Supabase no está instalado** (`which supabase` no lo encuentra). Opciones: añadirlo como devDependency de la raíz (`pnpm add -Dw supabase`; el binario se descarga en un postinstall, así que habrá que permitirlo en `allowBuilds` de `pnpm-workspace.yaml`) o `pnpm dlx supabase`. Preferible la devDependency, para que el clon limpio del Gate funcione igual. Comprobar que `supabase --version` corre en Windows.
- `supabase start` levanta una pila de contenedores (Postgres, Auth, REST, Realtime, Studio...) sobre Docker. Los puertos por defecto son 54321 a 54324; el sandbox de Saint usa el 14330, así que no chocan. `supabase db reset` aplica las migraciones y el seed desde cero: es la base del criterio "migraciones desde cero sin errores".
- Layout: `supabase/config.toml`, `supabase/migrations/<timestamp>_<nombre>.sql`, `supabase/seed.sql`. Las migraciones son SQL plano e idempotentes en lo posible; el seed debe poder re-aplicarse sin duplicar (usar `ON CONFLICT DO NOTHING` o claves fijas).
- Esquema base: manual, sección 5 (`organizations`, `products`, `b2b_customers`, `web_orders`, `sync_logs`). Correcciones de 3.2 que pide el ROADMAP: `org_members` con roles, `price_lists` y precios por lista (el mapeo de Saint ya expone `Precio1/2/3`), historial `exchange_rates`, imágenes y descripción de producto, y estados completos del pedido (el contrato Zod actual solo tiene `pending_sync | synced_to_erp | error`: ampliar el esquema SQL y mantener `shared-types` alineado, con sus pruebas).
- Alineación con `packages/shared-types`: los nombres de columna del SQL deben coincidir con los campos canónicos snake_case (`sku` mapea a `erp_sku` en la tabla; `customer_code` a `erp_customer_code`). Documentar esa correspondencia.
- RLS (3.3 y 3.4): todas las tablas con `org_id` llevan RLS activada y políticas por pertenencia (`org_members`). Las pruebas de 3.4 deben ser automáticas y correr contra la base local: crear dos tenants y un usuario en cada uno, y comprobar con roles `authenticated` reales (no con `service_role`, que se salta RLS) que A no lee ni escribe datos de B, incluidos `INSERT` con `org_id` ajeno y `UPDATE`/`DELETE` cruzados. Incluir casos negativos explícitos. Elegir el runner con criterio (pgTAP vía `supabase test db`, o un script con `pg`); el Gate exige que sean repetibles.
- El agente se autenticará por `x-api-key` contra `organizations.api_key_hash` (fase 4); no hace falta implementarlo aún, pero el hash debe poder guardarse y compararse.
- Para el Gate 3: `supabase db reset` (o `supabase stop --no-backup` y `start`) desde cero sin errores, pruebas de RLS en verde, y re-aplicar el seed dos veces sin cambiar los conteos.
- El CI actual (jobs `typescript` y `go`) no levanta Supabase. Si se quiere correr las pruebas de RLS en CI, añadir un job nuevo; no es obligatorio para el Gate 3.

## Hilo de contexto (por qué estamos haciendo esto)
- **Quién:** Orlando Guerra, ingeniero de sistemas full stack. Usa este proyecto como pieza central del portafolio de una agencia de software, y quiere que pueda escalar y venderse.
- **Qué se construye:** un agente local en Go que lee el ERP del comercio (Saint primero) y empuja los cambios por HTTPS a una API NestJS con Supabase, más un catálogo B2B con precios en USD y Bs y pedidos que vuelven al ERP como borradores.
- **Por qué Saint y no Odoo primero:** Saint es el ERP que domina el mercado objetivo (Venezuela). Como no hay un Saint real a mano, se prueba con un sandbox SQL Server en Docker. Odoo queda en el backlog v1.
- **Cómo se trabaja:** ciclo `next-task` por tarea, `phase-gate` al cerrar la fase, `guardar-estado` antes de `/clear`, `retomar` después. La memoria vive en este archivo y en `docs/ROADMAP.md`, no en la conversación.

## Acuerdos con el usuario
- Comunicación en español. Solo quiere ver un resumen al terminar cada fase; entre fases no hay que consultarle lo que ya está decidido.
- Dio permiso total para trabajar y **delegó el merge de los PR en `phase-gate`**. El merge solo ocurre si el Gate pasó entero.
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
- `pnpm-workspace.yaml` tiene `allowBuilds: '@parcel/watcher': false` (dependencia nativa opcional de jest, solo para `--watch`). pnpm 12 bloquea los scripts de build de las dependencias nuevas: si un `pnpm install` termina con `ERR_PNPM_IGNORED_BUILDS`, decidir con `pnpm approve-builds '<pkg>'` o `'!<pkg>'`.
- pnpm 12 aplica una política de edad mínima de releases: una versión recién publicada puede hacer fallar `pnpm install` ("lockfile contains entries that the active policies reject"). Si el lockfile es propio, `rm pnpm-lock.yaml && pnpm install`.
- En este shell los heredocs largos (`cat > f <<'EOF'` con muchos archivos en un solo comando) fallan con `unexpected EOF`: crear archivos con la herramienta Write. Un `python3 - <<...` vacío se cuelga: no usarlo.
- Prettier ignora md, docs, infra, scripts, `docker-compose.yml` y Go (`.prettierignore`); si no, reformatea archivos de otras fases.
- `pnpm install` desde un clon limpio tarda unos 2 minutos.

## Bloqueos y preguntas abiertas
- Ninguno.

## Cómo levantar el proyecto
- Sandbox de Saint: `bash scripts/saint-sandbox.sh up` (o `powershell -File scripts\saint-sandbox.ps1 up`); detalles en `docs/saint-sandbox.md`.
- TypeScript: `pnpm install`, luego `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check`. API compilada: `PORT=3001 node apps/api/dist/main.js` y `GET /health`.
- Go: `cd packages/erp-agent && go build ./... && go test ./... && go vet ./... && gofmt -l .`
- Validar el flujo de trabajo: `bash scripts/validate-workflow.sh`.

## Última actualización
2026-11-26. Fase 2 fusionada (PR #3, CI en verde); rama de la Fase 3 creada con el relevo escrito.
