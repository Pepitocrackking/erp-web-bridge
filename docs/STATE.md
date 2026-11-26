# STATE

Memoria del proyecto entre sesiones. Lo actualiza la skill `guardar-estado` y lo lee `retomar`. Se importa desde `CLAUDE.md`, así que se carga solo tras un `/clear`.

## Posición
- **Fase actual:** 2, Monorepo y CI
- **Rama:** `phase-2/monorepo-ci` (creada desde `main` tras el merge del PR #2; aún sin push)
- **Última tarea completada:** 2.4 (workflow de CI, validado solo en sintaxis). Antes, 2.3 (contratos Zod), 2.2 (módulo Go base) y 2.1 (workspace pnpm + Turborepo). La Fase 1 está completa y fusionada.
- **Estado de la fase:** en curso. Siguiente tarea: 2.5

## Fases cerradas
- **Fase 0** (PR #1, fusionado el 2026-11-26): repo, `CLAUDE.md`, ROADMAP, STATE, 4 skills, plantilla de PR y `scripts/validate-workflow.sh`.
  - Pendiente menor: el usuario confirma que `/retomar` aparece como skill en una sesión nueva (último criterio del Gate 0).
- **Fase 1** (PR #2, fusionado el 2026-11-26): sandbox de Saint en Docker. Evidencia en `docs/evidence/phase-1.md`.
  - `docker-compose.yml` (servicios `saint-sql` y `saint-init`), `.env.example`, `infra/saint-sandbox/` (init SQL idempotente, seed generado por `tools/gen-seed.mjs`, `mapping.saint.yaml`, `tools/` con reset/mutate/checksum/validate-mapping/gate), `scripts/saint-sandbox.sh` y `.ps1`, `docs/saint-sandbox.md`.
  - Datos: 311 productos, 10 categorías, 3 depósitos (001, 002, 003), 48 clientes (algunos cerca o por encima de su límite de crédito). Códigos `P00001...` y `C00001...`.
  - Cómo levantarlo: `bash scripts/saint-sandbox.sh up` (ver "Cómo levantar el proyecto").

## Siguiente acción
Ejecutar la tarea **2.5**: ESLint y Prettier (TS), `go vet` y `gofmt` (Go); conectar `pnpm lint` (hoy solo `tsc --noEmit` por paquete) y `pnpm format`, y añadir la comprobación de formato (`prettier --check`, `gofmt -l`) al CI en `.github/workflows/ci.yml`. Luego `phase-gate` con el Gate 2.

Hecho en 2.4: `.github/workflows/ci.yml` con dos jobs (`typescript`: install --frozen-lockfile, lint, test, build; `go`: vet, build, test en `packages/erp-agent`), en `pull_request` y push a `main`. Sintaxis validada en local; **su verde real solo se comprueba en el PR** (`gh pr checks`). Pendiente de verificar allí: que `pnpm/action-setup@v4` lea `packageManager` (pnpm 12.14.0) y que `actions/setup-go` resuelva `go 1.26`.

Hecho en 2.3: contratos Zod en `packages/shared-types/src/contracts.ts` (`productSchema`, `productRecordSchema` con `sync_hash`, `customerSchema`, `orderSchema`, `syncBatchSchema` discriminado por `kind` products/customers, máx. 1000 registros). Esquemas estrictos, snake_case canónico, 32 pruebas. `healthSchema` se conserva (lo usa `/health`).

Hecho en 2.2: módulo Go `github.com/Pepitocrackking/erp-web-bridge/packages/erp-agent` (go 1.26), fuera de pnpm.

Hecho en 2.1 (decisiones que condicionan lo siguiente):
- La API usa **NestJS 11.x** (CommonJS), no 12: Nest 12 es solo ESM y rompe jest/ts-jest y el consumo de `shared-types` (CJS). No subir a 12 sin migrar todo a ESM.
- Cada paquete tiene `build`, `test` (jest + ts-jest) y `lint` (por ahora `tsc --noEmit`; ESLint/Prettier llegan en 2.5).
- `pnpm-workspace.yaml` tiene `allowBuilds: '@parcel/watcher': false` (dependencia nativa opcional de jest, solo para `--watch`); sin eso `pnpm install` falla con `ERR_PNPM_IGNORED_BUILDS`.
- pnpm 12 aplica una política de edad mínima de releases: una versión recién publicada puede hacer fallar `pnpm install`; en ese caso, regenerar el lockfile.
- Los comandos con heredocs largos fallan en este shell: crear archivos con Write.

Detalles técnicos (originales de la fase):
- Entorno: Node v24.14.1, pnpm 12.14.0, Go 1.26.5, Docker 29.9.3, Windows. Fija `packageManager` y `engines` en el `package.json` raíz.
- Scripts raíz: `build`, `test`, `lint`, `format`, delegados a `turbo run`. Cada paquete debe tener `build` y `test` reales, porque el Gate 2 exige `pnpm install && pnpm build && pnpm test` en verde desde un clon limpio.
- Estructura (manual, sección 4): `apps/web` (Next.js App Router, TypeScript, Tailwind), `apps/api` (NestJS), `packages/shared-types` (Zod), `packages/erp-agent` (Go, tarea 2.2, fuera de pnpm).
- En 2.1 basta un esqueleto que compile: no implementes lógica de negocio. Un `GET /health` en la API y una página mínima en la web sirven de humo.
- `.gitignore` ya cubre `node_modules/`, `dist/`, `.next/`, `.turbo/`. Commitea el `pnpm-lock.yaml`.
- Para el Gate 2 clona el repo en un directorio nuevo y ejecuta ahí los comandos, no en el árbol de trabajo.
- La tarea 2.4 (CI) se verifica de verdad solo en el PR: el workflow debe quedar en verde en GitHub antes del merge. `phase-gate` espera `gh pr checks` en verde.
- Lint y formato (2.5): ESLint y Prettier para TypeScript; `go vet` y `gofmt` para Go (`golangci-lint` es opcional).

Después, en orden: 2.2 módulo Go, 2.3 contratos Zod (producto, cliente, pedido, lote de sincronización, alineados con el modelo del manual y los campos canónicos de `mapping.saint.yaml`), 2.4 GitHub Actions, 2.5 lint y formato. Luego `phase-gate` con el Gate 2 (ver ROADMAP).

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

## Bloqueos y preguntas abiertas
- Ninguno.

## Cómo levantar el proyecto
Sandbox de Saint: `bash scripts/saint-sandbox.sh up` (o `powershell -File scripts\saint-sandbox.ps1 up`); detalles en `docs/saint-sandbox.md`. Lo demás se completa en las fases siguientes.
Validar el flujo de trabajo: `bash scripts/validate-workflow.sh`.

## Última actualización
2026-11-26. Fase 1 fusionada (PR #2); rama de la Fase 2 creada con el relevo escrito.
