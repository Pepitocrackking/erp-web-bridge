# Supabase local

Base de datos de la nube (PostgreSQL + Auth + Realtime) levantada en local con el CLI de Supabase sobre Docker. El CLI es una devDependency de la raíz (`supabase`), así que un clon limpio solo necesita `pnpm install`.

## Comandos (desde la raíz)

| Comando           | Qué hace                                                                |
| ----------------- | ----------------------------------------------------------------------- |
| `pnpm db:start`   | Levanta la pila (la primera vez descarga imágenes: unos 4 minutos).     |
| `pnpm db:reset`   | Recrea la base, aplica `supabase/migrations/*` y luego `supabase/seed.sql`. |
| `pnpm db:status`  | Muestra URLs y claves locales.                                          |
| `pnpm db:stop`    | Detiene los contenedores.                                               |

## Puertos

- API: 54321, Postgres: 54322, Studio: 54323, Mailpit: 54324.
- El sandbox de Saint usa el 14330: no hay choque.
- Conexión directa: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.

## Layout

- `supabase/config.jsonc`: configuración del CLI (formato nuevo `.jsonc`).
- `supabase/migrations/<timestamp>_<nombre>.sql`: esquema y RLS, SQL plano.
- `supabase/seed.sql`: datos de desarrollo, re-aplicables sin duplicar.

## Pruebas de RLS

`pnpm test:db` (con la pila levantada) ejecuta `supabase/tests/rls.test.mjs` con `node:test` y `pg`. Crea dos organizaciones con usuarios de cada rol (owner, admin, staff, customer) dentro de una transacción que siempre se revierte, así que se puede repetir sin ensuciar la base. Las consultas corren con el rol Postgres `authenticated` (o `anon`) y los claims JWT en `request.jwt.claims`, igual que PostgREST; nunca con `service_role`, que se salta RLS. Variable opcional: `SUPABASE_DB_URL`.

Cubre lecturas y escrituras cruzadas entre tenants, `anon`, límites por rol, escalada en `org_members`, claves foráneas compuestas, `api_key_hash` ilegible y tasa de cambio inmutable.

## Notas del esquema

- `select *` sobre `organizations` falla para usuarios: `api_key_hash` no es legible (permiso por columna). Hay que listar columnas.
- Los pedidos (`web_orders`) los crea solo la API con `service_role`, tras validar el límite de crédito. Los usuarios solo pueden anular pedidos pendientes o con error.
- Las tablas nuevas en `public` no se exponen por defecto a `anon`/`authenticated`: cada migración debe conceder lo que necesite y activar RLS.
