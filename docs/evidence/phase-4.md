# Evidencia: Fase 4, API (NestJS)

Generada el 2026-11-26 en un **clon limpio** de la rama `phase-4/api` (commit `8023325`), en un directorio nuevo, con `pnpm install --frozen-lockfile` desde cero (30 s, código 0). Antes se ejecutó `supabase stop --no-backup` (0 contenedores y 0 volúmenes de Supabase después) y se arrancó la pila **con exactamente la orden que usa el CI** (`supabase start -x ...`, solo base de datos y GoTrue): arrancó en 21 s con código 0, 0 líneas de error en el log, aplicó las 6 migraciones y el seed. Entorno: Node v24.14.1, pnpm 12.14.0, Supabase CLI 3.4.0, Postgres 17, Go 1.26.5, Windows.

| Criterio | Comando | Resultado | Veredicto |
|---|---|---|---|
| Pruebas de integración contra un Postgres real (no mocks) en verde | `pnpm exec turbo run test --force` (sin caché) y `pnpm test:db` | `test exit=0`. API: 11 suites, **156 pruebas, 0 fallos** (135 de integración HTTP + base real, 1 de `/health`, 20 unitarias de JWT y configuración); shared-types 90; web 1. `test:db` (RLS): 30 de 30. Las pruebas crean sus propios tenants y los borran: tras correrlas la base conserva solo el seed (2 organizaciones, 4 usuarios, 45 productos) | Pasa |
| Ingesta de 5.000 productos medida y registrada | prueba `rendimiento` de `apps/api/test/sync-products.int.spec.ts` (5 lotes de 1000 por HTTP real contra Postgres) | `INGESTA 5000 productos (5 lotes de 1000): alta 399 ms, reenvío sin cambios 249 ms` en el clon limpio. Otras corridas durante el desarrollo: 459/222 ms, 392/215 ms. Las 5.000 filas quedan en la base (`toHaveLength(5000)`) y el reenvío informa `unchanged: 1000` por lote | Pasa |
| Una API key de la organización A no puede escribir en la B | 4 pruebas de la API nombradas abajo (más las 30 de RLS) | las 4 pasan; el filtro de los criterios 3 y 4 juntos dio `10 passed, 0 failed` (incluye idempotencia y concurrencia) | Pasa |
| Confirmar dos veces el mismo pedido no lo duplica | 2 pruebas principales y 3 de apoyo, nombradas abajo | las 5 pasan | Pasa |
| Extra: formato, lint, build | `pnpm format:check`, `pnpm lint`, `pnpm build` | los tres con código 0 (lint 4/4, build 3/3, "All matched files use Prettier code style!") | Pasa |
| Extra: Go | `go build ./... && go test ./... && go vet ./... && gofmt -l .` | `ok .../internal/version`; `go vet` limpio; `gofmt -l` vacío | Pasa |
| Extra: flujo de trabajo | `bash scripts/validate-workflow.sh` | `RESULTADO: OK` | Pasa |
| Extra: API compilada, en marcha | `node apps/api/dist/main.js` y `curl` | `/health` 200; `/openapi.json`: OpenAPI 3.0.0 con 9 rutas y 2 esquemas de seguridad; `/docs` 200; sin clave 401; un lote real con `erp_dev_demo_saint_key` insertó 1 producto; con `RATE_LIMIT_SYNC=3` la cuarta petición dio 429 | Pasa |

## Pruebas que respaldan los criterios 3 y 4 (todas pasan)

Aislamiento entre organizaciones:
- `POST /v1/sync/products` · aislamiento entre organizaciones · *una API key de A no escribe en B: ni con los mismos SKU ni con un org_id en el cuerpo*. B manda `S1`/`S2`; A manda el mismo SKU con otros datos, un `org_id` de B en el cuerpo (400), y en la URL y en la cabecera `x-org-id` (se ignoran): las filas de B quedan idénticas y solo A tiene su `S1`.
- `POST /v1/sync/products` · *una reconciliación completa de A no desactiva productos de B*.
- `POST /v1/sync/customers` · *una API key de A no escribe clientes en B*.
- `pedidos` · *la clave de A no confirma pedidos de B: 404 y B queda intacto*.
- Las pruebas de RLS (`pnpm test:db`) cubren el otro lado: lo que ve y escribe un usuario autenticado.

Confirmación idempotente de pedidos:
- *confirmar dos veces el mismo pedido no lo duplica ni cambia nada*: la segunda respuesta es idéntica salvo `duplicate: true`, hay una sola fila de pedido, `synced_at` no cambia y `sync_logs` tiene una sola fila de `orders`.
- *confirmaciones simultáneas del mismo pedido: una sola lo cambia*: 8 rondas de 20 peticiones concurrentes; exactamente una con `duplicate: false` por pedido, un único `synced_at`, 8 filas de bitácora en total.
- Además: otra referencia sobre un pedido ya confirmado da 409 sin cambiarlo; una misma referencia del ERP no puede asignarse a dos pedidos de la organización (índice único); un pedido anulado, rechazado o con error no se puede confirmar.

## Las pruebas detectan fallos reales (mutaciones comprobadas durante el desarrollo)

| Se rompió a propósito | Qué pasó |
|---|---|
| Quitar `org_id = $1` de la desactivación de la reconciliación | falló la prueba de aislamiento |
| Quitar el bloqueo asesor por cliente al crear pedidos | falló: se aceptaron 7 pedidos de 300 con un límite de 1.000 (debían ser 3) |
| Quitar `FOR UPDATE` de la confirmación | con 6 peticiones **no** fallaba (prueba poco sensible); se reforzó a 8 rondas de 20 y entonces falla (8 cambios en vez de 1) |
| Activar `trust proxy` | falló la prueba de que `X-Forwarded-For` no esquiva el rate limit |

## Qué entrega la fase

- **Autenticación:** `x-api-key` (SHA-256 contra `organizations.api_key_hash`, organizaciones activas, mensaje único de error) y JWT HS256 verificado con `node:crypto` (algoritmo fijado, `exp`/`sub`/`role=authenticated` obligatorios).
- **Sincronización del agente:** `POST /v1/sync/products` y `/customers` (upsert masivo en una sentencia, solo toca lo que cambió, idempotente por `batch_id`, reconciliación completa en varios lotes con `reconciliation_id`/`final_batch`/`total_records`), `sync_logs` de éxitos y errores, `POST /v1/agent/heartbeat`.
- **Tasa de cambio manual:** `POST/GET /v1/orgs/:orgId/exchange-rate` e historial paginado, con RLS como único juez de permisos.
- **Pedidos:** creación por el comprador con precios y total calculados por el servidor, validación de límite de crédito con bloqueo por cliente, `GET /v1/orders/pending` y `POST /v1/orders/:id/confirm` idempotente.
- **Endurecimiento y documentación:** rate limiting por IP y ruta (429 con `Retry-After`), entrada estricta en todos los endpoints, cuerpo máximo de 5 MB, OpenAPI 3 en `/openapi.json` y Swagger UI en `/docs`, generados de los mismos esquemas Zod.
- **Migraciones nuevas:** `20261126000300_sync_reconciliation.sql`, `20261126000400_agent_heartbeat.sql`, `20261126000500_orders.sql`.
- **CI:** el job `typescript` levanta Supabase local (base de datos y GoTrue) antes de `pnpm test:db` y `pnpm test`.

## Decisiones técnicas y límites conocidos

- **Reconciliación en varios lotes:** un lote perdido no puede desactivar medio catálogo, porque el último lote solo desactiva si lo recibido cuadra con `total_records` (si no, 409 y se revierte todo).
- **Crédito:** la exposición es deuda del ERP + pedidos `pending_sync` y `synced_to_erp` + pedido nuevo. Los `synced_to_erp` cuentan porque un borrador del ERP aún no es deuda; los aprobados se asumen ya reflejados en `current_debt_usd` tras la siguiente sincronización de clientes.
- **JWT en producción:** hoy HS256 con el secreto local; en producción Supabase firma con claves asimétricas y habrá que pasar a JWKS.
- **Fuera de alcance (backlog):** validar stock; clave de idempotencia al crear pedidos (hoy un reintento crea otro, aunque el crédito lo limita); endpoint para que el agente marque un pedido como `error`/`rejected`/`approved`; pedidos creados por el personal a nombre de un cliente.
- **Versiones fijadas por compatibilidad con CommonJS/Nest 11:** `@nestjs/swagger` 11.x (la 12 exige Nest 12), `@apidevtools/swagger-parser` 10 (la 13 es solo ESM y rompe jest), `jose` descartado por la misma razón.

## Resultado del CI (PR #5)

Run `45883528253` (commit `614a5a7`): **Go** y **TypeScript** en verde (2 min 38 s el segundo). El paso nuevo `supabase start -x ...` levantó la base y GoTrue en el runner ("Started supabase local development setup") y, con ella, el CI ejecutó `pnpm test:db` (30 de 30) y `pnpm test` (API 156 de 156 en 11 suites, shared-types 90, web 1). La ingesta de 5.000 productos midió en el runner: `alta 317 ms, reenvío sin cambios 207 ms`. Es decir, las pruebas de integración contra Postgres real corren en CI y no solo en local.
