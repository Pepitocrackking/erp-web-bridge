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
