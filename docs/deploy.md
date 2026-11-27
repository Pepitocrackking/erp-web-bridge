# Despliegue a producción

La web y la API se despliegan como contenedores (`apps/web/Dockerfile` y `apps/api/Dockerfile`) y Supabase (PostgreSQL, Auth y Realtime) es un **proyecto en la nube**. El agente sigue corriendo dentro de la red del comercio y solo necesita llegar a la API por HTTPS.

```
comercio:  erp-agent ──HTTPS──▶  API (contenedor)  ──▶  Supabase (nube)  ◀── navegador ── Web (contenedor)
```

> **Qué está probado y qué no.** Las imágenes, el `docker-compose.prod.yml` y la configuración se probaron en local contra la pila de Supabase de desarrollo (ver «Verificación» al final). **No se ha desplegado en ninguna nube**: eso necesita un proyecto de Supabase y un destino con sus credenciales, que no estaban disponibles. Los pasos de esta guía para la nube son el procedimiento previsto; los puntos que podrían requerir un ajuste real están marcados con ⚠.

## 1. Proyecto de Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com) (región cercana a tus usuarios) y anota la **referencia** (`<ref>`).
2. Aplica las migraciones **sin** el seed (el seed crea usuarios demo con contraseña conocida y organizaciones de prueba: jamás en producción):

   ```bash
   pnpm exec supabase login
   pnpm exec supabase link --project-ref <ref>
   pnpm exec supabase db push        # aplica supabase/migrations/*.sql
   ```

   Las migraciones ya incluyen RLS, las funciones y la publicación de Realtime (`supabase_realtime`: `sync_logs`, `web_orders`, `exchange_rates`, `products`).
3. **Auth → URL Configuration:** `Site URL` = la URL pública de la web (p. ej. `https://catalogo.tudominio.com`) y esa misma en `Redirect URLs`. **Auth → Providers → Email:** decide si exiges confirmar el correo (requiere SMTP propio en producción) y si el registro está abierto (`enable_signup`).
4. Reúne los datos (Settings → API y Database):

   | Dato | Va en |
   |---|---|
   | URL del proyecto `https://<ref>.supabase.co` | `NEXT_PUBLIC_SUPABASE_URL` |
   | Clave **anon** (pública) | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
   | JWT Secret | `SUPABASE_JWT_SECRET` |
   | `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json` | `SUPABASE_JWKS_URL` |
   | `https://<ref>.supabase.co/auth/v1` | `SUPABASE_JWT_ISSUER` |
   | Cadena de conexión del *connection pooler* (con la contraseña de la base) | `DATABASE_URL` |

   **Nunca** pongas la clave `service_role` en la web ni en ningún `NEXT_PUBLIC_*`. La API conecta como `postgres` por `DATABASE_URL` y no la necesita.

   ⚠ Si la API falla al conectar con `SELF_SIGNED_CERT_IN_CHAIN`, descarga el certificado raíz de Supabase (Database → SSL) y pásalo al contenedor con `NODE_EXTRA_CA_CERTS=/ruta/al/certificado.crt` (monta el archivo como volumen de solo lectura). El pooler en modo *transaction* (puerto 6543) es compatible: la API ejecuta todo dentro de transacciones.

## 2. Configuración

```bash
cp .env.production.example .env.production      # completa con los datos de arriba
```

`.env.production` **no se versiona**. Valores a revisar: `TRUST_PROXY=1` si hay un balanceador o proxy delante (para que el rate limit use la IP real del cliente), `DOCS_ENABLED=false` si no quieres publicar `/docs`, y **`DEMO_MODE=false`** (con `true` se habilita el acceso demo con claves de desarrollo). Variables opcionales de aviso por webhook: [agent-alerts.md](agent-alerts.md).

## 3. Levantar API y web

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml ps        # api y web deben quedar «healthy»
curl http://localhost:3001/health                   # {"status":"ok"}
```

- Cada servicio recibe **solo** las variables que usa; la web llega a la API por la red interna del compose (`http://api:3001`), sin CORS.
- Los contenedores corren como usuario sin privilegios, sin capacidades de Linux (`cap_drop: ALL`) y la API con sistema de archivos de solo lectura.
- Las variables `NEXT_PUBLIC_*` se **incrustan al compilar la web**: una imagen por entorno; si las cambias, reconstruye (`--build`).
- Pon un proxy con HTTPS delante (Caddy, nginx, el balanceador de tu nube). Dos hostnames típicos: `catalogo.tudominio.com` → web (3100) y `api.tudominio.com` → API (3001). **La API debe ser accesible desde los agentes** de los comercios; la web solo desde los navegadores.

Otros destinos funcionan igual con las mismas imágenes (Fly.io, Railway, Render, Cloud Run, un VPS): `docker build -f apps/api/Dockerfile -t api .` y `docker build -f apps/web/Dockerfile -t web --build-arg NEXT_PUBLIC_SUPABASE_URL=... --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=... .` (el contexto de build es la raíz del repo).

## 4. Primer cliente

Las organizaciones se crean por SQL (SQL Editor de Supabase). La clave del agente se guarda **solo como hash SHA-256**; la clave en claro la ve únicamente quien la genera:

```bash
openssl rand -hex 32          # genera una clave larga; usa «erp_» + ese valor
```

```sql
insert into public.organizations (name, slug, erp_type, api_key_hash)
values ('Mi Cliente C.A.', 'mi-cliente', 'saint',
        encode(extensions.digest('erp_<la clave generada>', 'sha256'), 'hex'));
```

1. Crea el usuario administrador (Auth → Users → *Add user*) y hazlo dueño:

   ```sql
   insert into public.org_members (org_id, user_id, role)
   select o.id, '<uuid del usuario>', 'owner' from public.organizations o where o.slug = 'mi-cliente';
   ```
2. Entra al panel (`/admin`) y fija la **tasa de cambio** inicial.
3. En el equipo del ERP, instala el agente como servicio ([README del agente](../packages/erp-agent/README.md)): `api.url` = la URL pública de la API (https), `api.api_key` = la clave en claro, y el login restringido `erp_agent` para el ERP. En unos segundos el panel muestra «Conectado» y empieza la sincronización.
4. Los compradores se registran en `/registro`, piden acceso y tú lo apruebas en `/admin/solicitudes`.

## 5. Después del despliegue

- [ ] `curl https://api.tudominio.com/health` responde `{"status":"ok"}`.
- [ ] `/login` **no** muestra «Entrar como Administrador Demo».
- [ ] `https://api.tudominio.com/docs` responde 404 si pusiste `DOCS_ENABLED=false`.
- [ ] Un agente real aparece «Conectado» en el panel y la primera sincronización llena el catálogo.
- [ ] Rotación de claves: para cambiar la clave de un agente, actualiza `api_key_hash` con el hash de la nueva y cambia `api.api_key` en `agent.yaml`.
- [ ] Copias de seguridad de la base: activa las de Supabase (backups diarios; Point-in-Time Recovery en planes de pago).

## Verificación realizada en local

Todo lo anterior salvo los pasos de la nube se probó con contenedores reales contra la pila de desarrollo (`pnpm db:start`): construcción de las dos imágenes, `docker compose up`, estado *healthy*, usuario sin privilegios, sistema de archivos de solo lectura, la web sin `DEMO_MODE`, y la suite E2E de Playwright (acceso, catálogo, panel, alertas, carrito y pedidos) contra la API y la web **dentro de los contenedores**. Salidas completas en [evidence/phase-8.md](evidence/phase-8.md).
