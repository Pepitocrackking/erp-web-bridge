# Evidencia: Fase 3, Base de datos y multi-tenant

Generada el 2026-11-26 en un **clon limpio** de la rama `phase-3/database` (commit `adcf5ba`), en un directorio nuevo y con `pnpm install --frozen-lockfile` desde cero. Antes se ejecutó `supabase stop --no-backup` (sin volúmenes de datos: 0) y se arrancó la pila de nuevo desde el clon, de modo que la base se construyó desde cero con el CLI del propio clon. Entorno: Node v24.14.1, pnpm 12.14.0, Supabase CLI 3.4.0, Postgres 17, Go 1.26.5, Windows.

| Criterio | Comando | Resultado | Veredicto |
|---|---|---|---|
| Las migraciones se aplican desde cero sin errores | `supabase stop --no-backup`, `supabase start` y luego `pnpm exec supabase db reset` | `reset exit=0`; 0 líneas con "error" o "fail" en el log; aplicó `20261126000000_base.sql`, `20261126000100_schema.sql`, `20261126000200_rls.sql` y `seed.sql`; "Finished supabase db reset" | Pasa |
| Las pruebas de RLS pasan, incluidos los casos negativos | `pnpm test:db` | `exit=0`; tests 30, pass 30, fail 0, skipped 0. Con el seed ya cargado y re-aplicado, otra vez 30/30 | Pasa |
| Re-aplicar el seed no duplica datos | `psql -v ON_ERROR_STOP=1 < supabase/seed.sql` dos veces y diff de conteos de 11 tablas | ambas con código 0; `diff` vacío ("CONTEOS IGUALES"); 45 productos y 45 pares `(org_id, erp_sku)` distintos | Pasa |
| Extra: build, test, lint, formato | `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` | 3/3, 4/4 (shared-types 38, api 1, web 1), 4/4, "All matched files use Prettier code style!"; todos con código 0 | Pasa |
| Extra: Go | `go build ./... && go test ./... && go vet ./... && gofmt -l .` | `ok .../internal/version`; `go vet` limpio; `gofmt -l` vacío | Pasa |
| Extra: flujo de trabajo | `bash scripts/validate-workflow.sh` | `RESULTADO: OK` | Pasa |

## Conteos tras `db reset` (iguales tras re-aplicar el seed dos veces)

| Tabla | Filas | Tabla | Filas |
|---|---|---|---|
| organizations | 2 | exchange_rates | 3 |
| org_members | 4 | web_orders | 2 |
| price_lists | 4 | sync_logs | 3 |
| products | 45 | auth.users | 4 |
| product_prices | 60 | auth.identities | 4 |
| b2b_customers | 7 | | |

## Comprobaciones adicionales (durante el desarrollo)

- **Las pruebas de RLS detectan regresiones.** Con `ALTER TABLE products DISABLE ROW LEVEL SECURITY` fallaron 8 de las 30 (`pass 22`, `fail 8`); al reactivarla, 30/30. No son pruebas vacuas.
- **Roles reales.** Las pruebas usan los roles Postgres `authenticated` y `anon` con claims en `request.jwt.claims` (lo que hace PostgREST); `service_role` solo aparece como control positivo.
- **Extremo a extremo por HTTP** (GoTrue + PostgREST, con la base sembrada). Login con `cliente@demo-saint.test` y consultas con su JWT: 27 productos (los 27 activos de 30), 1 cliente (`C00001`), 1 pedido y 1 organización. Con `admin@demo-mock.test`: 15 productos de B, 2 clientes de B, 0 pedidos y solo `demo-mock`. `select api_key_hash` devuelve `42501`, y `anon` sobre `products` devuelve `42501`.
- **Integridad entre tenants en el motor.** Un pedido de A apuntando a un cliente de B falla con violación de clave foránea compuesta; un estado de pedido inválido falla con `web_orders_status_check`; registrar una tasa actualiza `organizations.exchange_rate_bs`.

## Decisiones técnicas

- **Claves foráneas compuestas `(org_id, id)`.** Impiden que una fila de un tenant apunte a una de otro aunque se escriba con `service_role`; complementan a RLS.
- **`api_key_hash` único y sin lectura por usuarios.** Es SHA-256 hex de una clave de alta entropía, así que la API puede buscar por hash directamente (Fase 4). El permiso es por columna: `select *` sobre `organizations` falla para usuarios y hay que listar columnas.
- **Los pedidos los crea solo la API** (`service_role`), que valida el límite de crédito. Un usuario solo puede anular pedidos `pending_sync` o `error`.
- **Permisos explícitos.** Se revocan los permisos por defecto de Supabase sobre las tablas y funciones nuevas de `public`; cada migración concede lo que necesita.
- **Funciones auxiliares de RLS en el esquema `private`** (no expuesto por PostgREST), `SECURITY DEFINER` con `search_path` vacío.
- **Sin `FORCE ROW LEVEL SECURITY`**: las funciones auxiliares deben leer `org_members` saltándose RLS para no recursar.
- **`ORDER_STATUSES` de `shared-types` ampliado** a los 6 estados del CHECK (`pending_sync`, `synced_to_erp`, `approved`, `rejected`, `cancelled`, `error`), con prueba por cada uno.
- **El CI actual no levanta Supabase**, así que `pnpm test:db` corre en local. Se puede añadir un job en una fase posterior.

## Resultado del CI

PR #4, ejecución https://github.com/Pepitocrackking/erp-web-bridge/actions/runs/45876950464, con `gh pr checks 4`:

```
Go (vet, build, test)           pass  13s
TypeScript (lint, test, build)  pass  41s
```

El CI no levanta Supabase: las pruebas de RLS (`pnpm test:db`) se verificaron en local, en el clon limpio descrito arriba.
