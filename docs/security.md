# Revisión de seguridad

Revisión hecha en la tarea 8.5 (2026-11-26). Cubre claves y secretos, RLS y dependencias, más una revisión manual del agente, la API y la web. Para reportar una vulnerabilidad: [SECURITY.md](../SECURITY.md). Las salidas de los comandos están en [evidence/phase-8.md](evidence/phase-8.md).

## Qué protege cada capa

| Qué se protege | Cómo |
|---|---|
| Datos de una organización frente a otra | RLS en las 10 tablas; los usuarios consultan con su JWT y PostgreSQL decide. El lado del agente (que conecta como `postgres` y se salta RLS) filtra siempre por la organización de su `x-api-key`, con pruebas. |
| Clave del agente | Solo se guarda el hash SHA-256 (`api_key_hash`), que ni siquiera los usuarios autenticados pueden leer. Comparación en tiempo constante, un único mensaje de error, tope de longitud y rechazo de cabeceras repetidas. |
| Sesión de usuario | JWT de Supabase Auth verificado con `node:crypto`: el algoritmo (ES256 o HS256) lo fija la clave, nunca el token. |
| Contabilidad del cliente | El agente solo escribe borradores de pedido: lista blanca en el código, login SQL dedicado verificado en vivo y pruebas por huella de las tablas fiscales ([saint-sandbox.md](saint-sandbox.md)). |
| Secretos del agente | `agent.yaml` con permisos restringidos (SYSTEM, administradores y la cuenta del servicio), servicio como `LocalService`, nada de secretos en la línea de comandos, y pruebas de que ni la clave ni la contraseña de la DSN aparecen en logs ni errores. |
| Abuso | Rate limiting por IP y ruta, cuerpos con esquemas Zod estrictos (sin campos de más) y tope de 5 MB. |

## Hallazgos y qué se hizo

| # | Hallazgo | Gravedad | Resolución |
|---|---|---|---|
| 1 | **15 vulnerabilidades en la biblioteca estándar de Go 1.26.5** que el agente alcanza (`net/http`, `crypto/tls`, `crypto/x509`, `net/url`…), todas corregidas en 1.26.6 a 1.26.11. | Alta | `toolchain go1.26.11` en `go.mod`. govulncheck: 0 vulnerabilidades. |
| 2 | `golang.org/x/crypto` 0.55 con 3 avisos (el código no llamaba las funciones afectadas). | Media | Actualizado a 0.59 (y `x/sys` 0.50, `x/text` 0.44). Pruebas del agente en verde con `-race`. |
| 3 | La API no enviaba **cabeceras de seguridad** ni impedía que un proxy cacheara respuestas por usuario. | Media | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` y `Cache-Control: no-store` en todas las respuestas, también 401 y 404 (salvo `/docs`). 4 pruebas. |
| 4 | La web no enviaba cabeceras de endurecimiento y anunciaba `x-powered-by`. | Media | `nosniff`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `Referrer-Policy`, `Permissions-Policy`; sin `x-powered-by`. 13 pruebas E2E (con la PWA). |
| 5 | Imágenes Docker: 4 paquetes `libpam` con CVE-2025-6020 corregida en Debian pero no en la imagen base. | Alta | `apt-get upgrade` en la etapa final de ambas imágenes. |
| 6 | Imágenes Docker: el `npm` que trae `node:24-slim` incluye `brace-expansion` con 6 avisos altos. | Alta | La imagen final ya no lleva npm, npx ni corepack (solo ejecuta `node`). Trivy: 0 altas o críticas con corrección, en las dos imágenes. |
| 7 | Dos avisos moderados (`glob`, `minimatch`) en la cadena de jest. Solo desarrollo. | Baja | `overrides` en `pnpm-workspace.yaml`. `pnpm audit`: sin vulnerabilidades. Toda la suite sigue en verde. |
| 8 | gitleaks marcó 2 JWT en `.env.example` y `e2e/helpers.ts`. | Informativo | Es la clave **anónima pública** de la pila local de Supabase (`role=anon`, `iss=supabase-demo`). Excepción acotada a ese token exacto en `.gitleaks.toml`. No hay ningún JWT `service_role` en el historial. |
| 9 | La auditoría de RLS no encontró problemas, pero nada impedía que una migración futura los introdujera. | — | 5 guardas automáticas (`pnpm test:db`, 53 pruebas): toda tabla con RLS, `SECURITY DEFINER` con `search_path` fijo, `anon` sin privilegios, columnas secretas no legibles, vistas con `security_invoker`. Verificadas por mutación. |

Sin hallazgos: secretos en el historial (73 commits escaneados), políticas de `org_members` (solo un `owner` crea, modifica o quita owners; un admin no puede ascender a nadie a owner).

## Credenciales de desarrollo (públicas y documentadas)

Están en el repositorio a propósito para que el demo funcione con un solo comando. **No sirven contra nada real, y no deben existir en producción:**

| Credencial | Dónde | En producción |
|---|---|---|
| Claves de agente `erp_dev_demo_saint_key` y `erp_dev_demo_mock_key` | `supabase/seed.sql` | No aplicar el seed. Crear organizaciones nuevas con claves propias ([deploy.md](deploy.md)). |
| Usuarios `*@demo-saint.test` / `*@demo-mock.test`, contraseña `demo1234` | `supabase/seed.sql` | No aplicar el seed. |
| `Saint_Demo_2026!` (sa) y `Agent_Demo_2026!` (login `erp_agent`) | sandbox de Saint en Docker | Solo existen en el sandbox. En un ERP real, el DBA crea su propio login restringido. |
| Secreto JWT `super-secret-jwt-token-with-…` y clave anónima de la pila local | valores por defecto de `config.ts` y `.env.example` | Usar los del proyecto de Supabase en la nube. |
| `DEMO_MODE=true` | variable de la web | **Nunca.** Habilita el acceso demo y el simulador con las claves de desarrollo. El compose de producción lo deja en `false` y hay prueba de que `/login` no ofrece el botón. |

## Riesgos aceptados y pendientes

Se dicen en voz alta porque forman parte de la revisión:

1. **Contra una nube real no se ha probado.** El despliegue se verificó en local con contenedores reales; falta confirmar el certificado SSL del pooler de Supabase ([deploy.md](deploy.md), ⚠).
2. **La API conecta a la base como `postgres`** (se salta RLS) para la ingesta del agente; el aislamiento entre organizaciones depende del código (`org_id` siempre sale de la `x-api-key` y cada sentencia lo filtra) y está cubierto por pruebas. Mejora prevista: un rol dedicado con solo los permisos que la ingesta necesita.
3. **El rate limiting vive en memoria de cada instancia de la API.** Con varias instancias, el límite efectivo se multiplica. Con una sola instancia (el caso previsto) no hay problema; para escalar hace falta un almacén compartido.
4. **Falta una CSP completa.** Hoy solo se restringe quién puede enmarcar la app (`frame-ancestors`); una política con nonces para scripts y estilos queda en el backlog. Tampoco se ponen HSTS ni TLS: eso lo hace el proxy HTTPS de delante.
5. **`agent.yaml` guarda la clave y la DSN en texto,** protegido por permisos de archivo. Cifrarlo con DPAPI de Windows queda en el backlog.
6. **Revocar o rotar la clave de un agente es manual** (SQL sobre `api_key_hash`; el procedimiento está en [deploy.md](deploy.md)).
7. **Los nombres de columnas de Saint no se han validado contra una base real** (ver [saint-sandbox.md](saint-sandbox.md)); la garantía de «solo borradores» se prueba contra el sandbox y se comprueba en vivo contra el login real al arrancar.
8. **Los escáneres no coinciden entre sí:** `pnpm audit` no vio avisos que Trivy sí encontró en el `npm` de la imagen base. Por eso el CI combina varias herramientas y las imágenes se escanean con Trivy.

## Cómo repetir la revisión

```bash
# Secretos en TODO el historial (usa .gitleaks.toml)
docker run --rm -v "$PWD:/repo:ro" zricethezav/gitleaks:latest git /repo --redact

# Dependencias
pnpm audit --audit-level moderate
cd packages/erp-agent && go run golang.org/x/vuln/cmd/govulncheck@latest ./...

# Imágenes de producción (tras `docker compose -f docker-compose.prod.yml build`)
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest \
  image --severity HIGH,CRITICAL --ignore-unfixed erp-web-bridge-api:local

# RLS y guardas estructurales de la base (con `pnpm db:start`)
pnpm test:db
```

En el CI corren el escaneo de secretos, `pnpm audit` y `govulncheck` en cada pull request.
