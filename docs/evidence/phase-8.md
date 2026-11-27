# Evidencia de la Fase 8: Endurecimiento y portafolio

Salidas reales de comandos, tomadas el 2026-11-26. Se va completando tarea a tarea y el Gate 8 la cierra.

## 8.1 Instalador del agente como servicio de Windows

**Qué se hizo**

- `erp-agent service install|uninstall|start|stop|status` (paquete `internal/winsvc`, etiqueta `windows`; en otros sistemas responde que solo existe en Windows y el binario compila igual).
- El mismo `.exe` detecta que lo arrancó el Service Control Manager y corre sin consola (`golang.org/x/sys/windows/svc`).
- `log.file`, `log.max_size_mb`, `log.max_backups`: log a archivo con rotación por tamaño (`internal/logfile`); como servicio, si no hay `log.file`, escribe `erp-agent.log` junto a la base local. Hitos y fallos también al Visor de eventos (origen `ErpAgent`).
- Cuenta `LocalService` (se rechaza `LocalSystem`), arranque automático retrasado, recuperación: reinicio a 5 s, 15 s y 60 s, también ante salidas con error, contador reiniciado tras 1 día.
- Secretos fuera de la línea de comandos: el servicio se lanza con `-config <ruta> -service-name <nombre>`; `agent.yaml` queda con ACL restringida (SYSTEM y administradores control total, LocalService lectura).
- `service install` valida el `agent.yaml` antes de tocar el sistema y revierte si algo falla a medias.
- El servicio se declara «en marcha» solo cuando el agente ya está armado (`agent.Options.Ready`): una configuración mala hace fallar `service start`.

**Pruebas automáticas (sin privilegios)**

```
$ cd packages/erp-agent && go test -race -count=1 ./...
ok  .../cmd/erp-agent        ok  .../internal/agent      ok  .../internal/api
ok  .../internal/batch       ok  .../internal/config     ok  .../internal/delta
ok  .../internal/erp         ok  .../internal/erp/mock   ok  .../internal/erp/saint
ok  .../internal/logfile     ok  .../internal/orders     ok  .../internal/sender
ok  .../internal/store       ok  .../internal/sync       ok  .../internal/version
ok  .../internal/winsvc
$ gofmt -l .            (sin salida)
$ go vet ./... && GOOS=linux go vet ./...    (sin salida)
```

`internal/winsvc` prueba el manejador del SCM con canales simulados: arranque y parada limpia, `Shutdown`, `Interrogate`, fallo antes de estar listo (nunca reporta `Running`), caída inesperada y salida limpia sin petición (ambas terminan con error de servicio 1 para que el SCM reinicie), y parada que no termina a tiempo (error 2).

**Prueba real del servicio** (`scripts/test-windows-service.ps1`, PowerShell como administrador, API real en `:3001`, Supabase local, ERP simulado; ejecutada con elevación UAC):

```
OK     una configuración inválida no instala nada
OK     service install crea el servicio
OK     instalar dos veces falla con un mensaje claro
OK     arranque automático
OK     corre como LocalService, no como SYSTEM
OK     la línea de comandos no contiene secretos
OK     recuperación: 3 reinicios automáticos a 5 s, 15 s y 60 s
OK     el contador de fallos se reinicia tras un día
OK     la recuperación aplica también a salidas con error
OK     agent.yaml no es legible por usuarios comunes (Todos / Usuarios)
OK     agent.yaml es legible por la cuenta del servicio (LocalService)
OK     solo SYSTEM, Administradores y LocalService tienen acceso
OK     service start deja el servicio en marcha
OK     el servicio tiene proceso
OK     escribe el log en archivo (ciclo terminado)
OK     el servicio llega a la API (latido reciente de demo-mock)
OK     tras matar el proceso, el SCM lo reinicia solo (PID nuevo)
OK     service stop lo detiene
OK     la parada fue limpia (el log lo dice)
OK     service status informa 'stopped'
OK     service uninstall elimina el servicio
OK     desinstalar no borra la configuración ni los datos
OK     status de un servicio inexistente falla con mensaje

TODO OK        EXIT=0
```

Después de la corrida: `sc query ErpAgentTest` → `ERROR 1060` (no existe) y no queda `C:\ProgramData\ErpAgentTest`.

La primera corrida dio 3 FALLO que eran del script, no del agente (Windows en español: `sc` imprime `REINICIAR`/`VERDADERO` y `icacls` `SERVICIO LOCAL`); el script ahora compara números y SID, no palabras traducidas.

## 8.2 Alertas de «agente sin conexión»

**Qué se hizo** (detalle y formato de los mensajes en `docs/agent-alerts.md`)

- **Panel (siempre activo):** banner rojo «El agente local no responde» (hace cuánto, catálogo posiblemente desactualizado, pedidos esperando y un desplegable «Qué hacer» con `erp-agent service status|start` y el log), **contador en la cabecera** que lleva al detalle, el número entre paréntesis en el **título de la pestaña**, aviso informativo si el agente nunca se conectó y advertencia por pedidos con error. Todo en vivo, sin recargar. La cabecera pasó al componente cliente (`app/admin/dashboard.tsx`) para que el contador se actualice.
- **Webhook opcional (API):** `AgentAlertsService` (`NOTIFY_WEBHOOK_URL`, `NOTIFY_WEBHOOK_SECRET`, `NOTIFY_OFFLINE_AFTER_SECONDS`, `NOTIFY_CHECK_INTERVAL_SECONDS`). Un aviso por caída y otro por recuperación, con memoria en la base (`organizations.agent_offline_notified_at`, migración `..1000`), firma HMAC-SHA256, reintento si el destino falla, solo organizaciones activas que alguna vez se conectaron. Una URL inválida detiene el arranque.

**Un fallo real que encontró la prueba:** deshacer la reclamación tras un webhook caído comparaba un `Date` de JavaScript (milisegundos) con un `timestamptz` de Postgres (microsegundos) y nunca coincidía: la caída no se reintentaba jamás. Se corrigió devolviendo la marca como texto y comparando con `::timestamptz`.

**Pruebas**

```
$ pnpm test
shared-types: Tests 102 passed      web: Tests 87 passed (+10: panelAlerts, alertSummary)
api: Test Suites 13 passed, Tests 205 passed (+23: 11 de integración del webhook, 12 de configuración)
$ pnpm test:db      → pass 48, fail 0
$ pnpm lint && pnpm format:check   → sin errores
$ pnpm db:reset     → «Applying migration 20261126001000_agent_alerts.sql»
$ pnpm exec playwright test   (apps/web, pila completa)   → 50 passed (2.9m)
```

Las 11 de integración usan un servidor HTTP real como receptor: caída una sola vez, ventana configurable, organización desactivada, recuperación y nueva caída, destino que responde 500 (se reintenta), conexión rechazada, firma con y sin secreto, tres instancias a la vez sin duplicar y temporizador solo con webhook.

Las 3 E2E nuevas (`e2e/agent-alerts.spec.ts`, organización propia): agente que nunca se conectó; caída detectada **en vivo** (banner con `role="alert"`, contador «1 alerta», título `(1) Panel · ERP Web Bridge`, «Qué hacer», enlace `#alertas`) y recuperación sin recargar tras un latido real de la API; panel abierto con el agente ya caído.

**Demostración con el proceso real** (API compilada con `NOTIFY_*`, receptor HTTP que verifica la firma):

```
Aviso de agente sin conexión activo: webhook en localhost:9100, ventana 180s, revisión cada 3s
{"evento":"agent.offline","firma_valida":true,"org":"live-alerts","offline_for_seconds":720,"message":"El agente local de «Demo Alertas Vivo» no da señales desde hace 12 min. ..."}
$ curl -X POST /v1/agent/heartbeat -H "x-api-key: ..."          (el agente vuelve)
{"evento":"agent.online","firma_valida":true,"org":"live-alerts","message":"El agente local de «Demo Alertas Vivo» volvió a conectarse."}
10 s después: 3 líneas en total (sin repeticiones). Tras reiniciar la API: 3 líneas (no reenvía lo ya avisado).
```

(La primera línea recibida fue de `demo-mock`, que tenía un latido viejo de la prueba del servicio: comportamiento correcto. Después se limpió el estado de prueba.)

## 8.3 README final con diagrama de arquitectura, capturas y guion de demo

**Qué se hizo**

- `README.md` reescrito: qué es y para quién, **diagrama de arquitectura** y **diagrama de secuencia del pedido** (Mermaid), decisiones de diseño, qué incluye cada pieza, **guion de demo de 5 minutos** (siete pasos con los textos reales de la interfaz), cómo probarlo en local, tabla de calidad, estructura del repo y backlog v1.
- **6 capturas** reales en `docs/screenshots/` (login demo, catálogo del comprador en USD y Bs, carrito con crédito, panel con el agente «Conectado», simulador de ERP y la alerta de agente sin conexión), generadas con Playwright por `apps/web/e2e/screenshots.spec.ts` (solo corre con `SCREENSHOTS=1`; no forma parte de la suite normal). Tras `pnpm db:reset`, para que no salgan datos de otras pruebas; las imágenes `example.com` del seed se sustituyen por un marcador neutro; el latido y la alerta se simulan con datos reales y se restauran al terminar.

**Comprobaciones**

```
$ SCREENSHOTS=1 pnpm exec playwright test e2e/screenshots.spec.ts
  6 passed (29.2s)
$ node check-mermaid.cjs README.md        (Mermaid 11 real en Chromium)
bloques mermaid encontrados: 2
bloque 1: {"ok":true,"size":108354}
bloque 2: {"ok":true,"size":29327}
$ (enlaces e imágenes locales del README)  → todos existen
```

Las cifras de la tabla de calidad (102 / 205 / 87 / 48 / 50) son las de las corridas de la 8.2. El arranque del README usa los pasos manuales; la 8.6 los reemplaza por el comando único `demo`.

## 8.4 Despliegue de web y API, con Supabase en la nube

**Alcance (decidido al inicio de la fase):** listo y probado en local; **no se desplegó nada en ninguna nube** porque no hay proyecto de Supabase ni destino con credenciales. Lo que sí se entrega es reproducible y verificado con contenedores reales.

**Qué se hizo**

- `apps/api/Dockerfile` y `apps/web/Dockerfile` (multi-etapa, contexto = raíz del repo, `pnpm install --frozen-lockfile`, `pnpm deploy --prod` para la API y Next `standalone` para la web, usuario `node`, `HEALTHCHECK`). `NEXT_OUTPUT=standalone` solo lo define el build de Docker: `next.config.mjs` no cambia el desarrollo, las E2E ni `next start`.
- `docker-compose.prod.yml`: API + web, Supabase externo; cada servicio recibe **solo** las variables que usa (la web nunca ve `DATABASE_URL` ni el secreto JWT); `cap_drop: ALL`, `no-new-privileges`, API con sistema de archivos de solo lectura; la web llega a la API por la red interna (`http://api:3001`, sin CORS); variables obligatorias con mensaje claro (`${VAR:?}`).
- `.env.production.example` (plantilla; `.gitignore` ahora deja versionar solo ese ejemplo), `.dockerignore` (sin secretos, `.env*`, pruebas, docs ni el agente en la imagen).
- `docs/deploy.md`: proyecto de Supabase (`supabase link` + `db push` **sin seed**), Auth, tabla de qué dato va a qué variable, levantar el compose, crear el primer cliente (organización con la clave guardada solo como hash SHA-256, usuario dueño), lista de comprobación posterior y los puntos que no se pudieron probar contra la nube (⚠ certificado SSL del pooler).
- `playwright.config.ts`: opción `E2E_HOST_RESOLVER_RULES` (solo por variable de entorno) para que el navegador del anfitrión resuelva `host.docker.internal` al probar las imágenes.

**Verificación con contenedores reales contra la pila local de Supabase**

```
$ docker compose -f docker-compose.prod.yml --env-file prod-test.env build      → api y web: Built
$ docker compose ... up -d ; ps
api  erp-web-bridge-api:test  Up 14 seconds (healthy)   0.0.0.0:3001->3001/tcp
web  erp-web-bridge-web:test  Up 8 seconds (healthy)    0.0.0.0:3100->3100/tcp
imágenes: api 396 MB, web 395 MB
$ curl localhost:3001/health                      {"status":"ok"}
$ curl -o /dev/null -w %{http_code} localhost:3001/docs      404   (DOCS_ENABLED=false)
$ docker exec ...-api-1 id / ...-web-1 id          uid=1000(node) gid=1000(node)
$ docker exec ...-api-1 touch /app/x               Read-only file system
$ env de la web: DEMO_MODE=false, API_URL=http://api:3001   (sin DATABASE_URL ni SUPABASE_JWT_SECRET)
$ curl localhost:3100/login | grep -c "Administrador Demo"    0   (sin modo demo)
$ docker compose -f docker-compose.prod.yml config    (sin variables)
error ... required variable DATABASE_URL is missing a value: Falta DATABASE_URL (cadena de conexión de Postgres)
```

**Suite E2E completa de Playwright contra la API y la web DENTRO de los contenedores** (los puertos 3001 y 3100 los escuchaba `com.docker.backend.exe`, no node; web con `DEMO_MODE=true` solo para esta corrida, porque las E2E usan el acceso demo y el simulador):

```
$ E2E_HOST_RESOLVER_RULES="MAP host.docker.internal 127.0.0.1" pnpm exec playwright test
  6 skipped        (las capturas del README, que solo corren con SCREENSHOTS=1)
  50 passed (2.7m)
```

Incluye acceso y aprobación, catálogo, carrito y crédito, panel **en vivo** (Realtime), alertas de agente, simulador, PWA y el Gate 7 (el agente Go real contra el sandbox de Saint, hablando con la API del contenedor).

**Una primera corrida dio 14 fallos, y no eran de las imágenes:** el panel se quedaba en «Conectando…» porque el navegador del anfitrión no resuelve `host.docker.internal` (`curl` da error 6; el websocket a `127.0.0.1` sí abre) y la web del contenedor había sido compilada con esa URL de Supabase. En un despliegue real la URL de Supabase es pública y sirve para ambos lados. Con la opción de Playwright anterior pasan los 50.

## 8.5 Revisión de seguridad y LICENSE

Informe completo, con tabla de hallazgos, credenciales de desarrollo y riesgos aceptados: [docs/security.md](../security.md). Aquí, las salidas.

**Secretos en el historial (gitleaks, todo el historial y el árbol de trabajo)**

```
$ docker run --rm -v <repo>:/repo:ro zricethezav/gitleaks:latest git /repo --redact -v
RuleID: jwt   File: apps/web/e2e/helpers.ts   |   RuleID: jwt   File: .env.example
INF 73 commits scanned.   WRN leaks found: 2
```

Los dos son el mismo token: decodificado, `{"iss":"supabase-demo","role":"anon","exp":1983812996}`, la clave **anónima pública** de la pila local de Supabase (firmada con el secreto de demostración, también público). No hay ningún JWT `service_role` en el historial (`git log -S'c2VydmljZV9yb2xl'` vacío). Se registró una excepción acotada a ese token exacto (`.gitleaks.toml`):

```
$ gitleaks git /repo --config /repo/.gitleaks.toml --redact
INF 73 commits scanned.   INF no leaks found
$ gitleaks git /repo --config ... --pre-commit --staged      (lo que se comitea)
INF no leaks found
```

Control positivo (el escáner sí detecta): un archivo temporal con una clave AWS de ejemplo y una `sk_live_…` → `leaks found: 1`. El escaneo del árbol de trabajo completo (`gitleaks dir`) marca 11 coincidencias, todas en artefactos locales **ignorados por git** (`apps/web/.next/**` y `supabase/.temp/start-secrets/**`, generados por Next y por la CLI de Supabase): `git check-ignore` lo confirma y `git ls-files` en esas rutas está vacío.

**Dependencias**

```
$ cd packages/erp-agent && govulncheck ./...        (Go 1.26.5)
Your code is affected by 15 vulnerabilities from the Go standard library.
  (net/http, crypto/tls, crypto/x509, net/url, encoding/asn1, net/textproto…; corregidas en 1.26.6 a 1.26.11)
$ (go.mod: toolchain go1.26.11; go get golang.org/x/crypto@latest)
$ govulncheck ./...
No vulnerabilities found.
$ go test -race -count=1 ./...   → 16 paquetes ok

$ pnpm audit --audit-level low
2 vulnerabilities found   Severity: 2 moderate   (glob, minimatch; cadena de jest, solo desarrollo)
$ (overrides en pnpm-workspace.yaml; pnpm install)
$ pnpm audit --audit-level low
No known vulnerabilities found
$ pnpm lint · pnpm test · pnpm test:db   → todo en verde tras el cambio
```

**Imágenes Docker (Trivy, severidad HIGH y CRITICAL con corrección disponible)**

```
primer escaneo:   debian 12.15 → 4 (libpam, CVE-2025-6020)
tras apt upgrade: debian 0, pero node-pkg → 6 HIGH (brace-expansion 5.0.9, dentro de /usr/local/lib/node_modules/npm
                  de la imagen base, no de la aplicación)
tras quitar npm/npx/corepack de la imagen final:
  erp-web-bridge-api:test (debian 12.15)  0 vulnerabilidades, sin hallazgos en librerías
  erp-web-bridge-web:test (debian 12.15)  0 vulnerabilidades, sin hallazgos en librerías
compose up → api y web healthy; imágenes de ~400 MB
```

**RLS (auditoría sobre la base real y guardas automáticas)**

```
tablas de public sin RLS: 0 (10 de 10 con RLS)          SECURITY DEFINER sin search_path: 0 (11 de 11 con search_path="")
anon: privilegios sobre tablas/columnas: 0; funciones ejecutables: 0
authenticated: api_key_hash y agent_offline_notified_at no legibles; solo puede UPDATE (name) en organizations
vistas de public: 1, con security_invoker=true
org_members: solo un owner crea, modifica o quita owners; un admin no puede ascender a owner

$ pnpm test:db     → tests 53, pass 53, fail 0   (48 de antes + 5 guardas estructurales)
mutación (tabla sin RLS + función SECURITY DEFINER sin search_path + GRANT a anon):
                   → pass 50, fail 3  (las 3 guardas los detectan)    tras limpiar: pass 53, fail 0
```

**Cabeceras de seguridad** — API (`apps/api/src/setup.ts`, `test/security-headers.int.spec.ts`, 4 pruebas: `/health`, un 401, un 404 y `/docs`) y web (`next.config.mjs`, `e2e/security.spec.ts`, 6 pruebas):

```
$ curl -sI localhost:3001/health   (contenedor)         $ curl -sI localhost:3100/login   (contenedor)
X-Content-Type-Options: nosniff                         X-Content-Type-Options: nosniff
X-Frame-Options: DENY                                   X-Frame-Options: DENY
Referrer-Policy: no-referrer                            Content-Security-Policy: frame-ancestors 'none'
Cache-Control: no-store                                 Referrer-Policy: strict-origin-when-cross-origin
                                                        Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
$ playwright test e2e/security.spec.ts e2e/pwa.spec.ts  → 13 passed (la PWA y el service worker siguen funcionando)
```

**Secretos en logs del agente** (`internal/agent`): con una DSN de contraseña reconocible y log en `debug`, ni la conexión rechazada ni la DSN mal formada filtran la contraseña ni la clave de API, y una corrida completa tampoco filtra la clave. Las pruebas pasan.

**LICENSE y política:** `LICENSE` (MIT, © 2026 Orlando Guerra), `"license": "MIT"` en los `package.json`, `SECURITY.md` y el aviso privado de vulnerabilidades activado en GitHub (`gh api repos/.../private-vulnerability-reporting` → `{"enabled":true}`). CI: nuevos jobs `secrets` (gitleaks sobre todo el historial) y `dependencies` (`pnpm audit` y `govulncheck`).

**Incidencia durante la propia tarea:** el escaneo de lo que iba a comitearse dio 3 hallazgos y mi comando encadenado con `;` comiteó igualmente (el commit era local, sin subir). Eran los tres valores falsos de la prueba «los secretos no aparecen en los logs» (`API-KEY-SECRETA-…`, `S3cr3tPASSw0rd-…`). Se marcaron con `// gitleaks:allow` en esas líneas exactas (en lugar de una excepción más amplia), se encadenó el escaneo con `&&` para que bloquee el commit y se hizo `amend` del commit local. Resultado final: `74 commits scanned. no leaks found`.

## 8.6 Comando único `demo`

**Qué se hizo:** `pnpm demo` (`scripts/demo.mjs`, solo módulos integrados de Node, igual en Windows, macOS y Linux; funciona antes de `pnpm install`), `pnpm demo:stop`, `pnpm demo status|check` y las banderas `--reset`, `--no-agent` y `--no-check`. Nueve pasos: requisitos; `pnpm install --frozen-lockfile`; `.env` y `apps/web/.env.local` (solo las `NEXT_PUBLIC_*`); Supabase completo (detecta y reinicia la pila parcial que deja el CI con `-x`); sandbox de Saint; `pnpm build` y compilación del agente; API y web en modo demo; **agente real** contra el sandbox (login restringido `erp_agent`, ciclos de 10 s); y una **verificación del flujo completo** que no simula nada. El estado (PIDs, logs, configuración del agente) vive en `.demo/` (ignorado por git). El README tiene ahora `pnpm demo` en lugar de los pasos manuales (que quedan en un desplegable).

**Pruebas de las funciones puras** (`pnpm test:scripts`, también en el CI): argumentos, filtrado de `NEXT_PUBLIC_*` (la web no recibe `DATABASE_URL`), versión de Node, YAML del agente (barras normales, login `erp_agent` y nunca `sa`; además se cargó con el cargador **real** del agente, config estricta: `ok: erp=saint sync=10s reconcile=0s`) y estado de la pila de Supabase.

```
$ pnpm test:scripts   → tests 11, pass 11, fail 0
```

**Desde un clon limpio** (clon nuevo en una carpeta sin `node_modules`, `.env` ni `.demo`, tras `supabase stop --no-backup` y `docker compose down -v`, es decir, sin volúmenes de Supabase ni de Saint):

```
$ git clone ... && cd erp-clean2 && pnpm demo          (3 min 40 s, salida 0)
[1/9] Comprobando requisitos     ✔ Node v24.14.1 ✔ pnpm ✔ Docker ✔ Go
[3/9] Archivos de entorno        ✔ .env creado ✔ apps/web/.env.local creado
[4/9] Supabase local             ✔ Supabase responde en http://127.0.0.1:54321
[7/9] API y web                  ✔ API en http://localhost:3001 ✔ web en http://localhost:3100 (modo demo)
[8/9] Agente local               ✔ agente en marcha (log: .demo\logs\agent.log)
[9/9] Verificación
  ✔ API: /health ok
  ✔ web: /login responde y ofrece «Entrar como Administrador Demo»
  ✔ Supabase Auth: inicia sesión el comprador y el administrador del demo
  ✔ agente conectado (último latido 2026-11-27T03:19:17Z) y sincronizado
  ✔ catálogo: 297 productos activos en la nube = 297 activos en SAPROD (Saint)
  ✔ pedido 0bb7c828 creado por el comprador: pending_sync
  ✔ el pedido pasó a «Enviado al ERP» con la referencia PW0000002
  ✔ SAPEDIDO: existe exactamente 1 borrador de ese pedido (Estado = 'B')
  ✔ tablas fiscales (SAFACT, SAITEMFAC, SAACXC) intactas: 9 filas, como en el seed
Flujo completo verificado: pedido web → agente real → borrador en Saint → panel.
```

(La referencia es `PW0000002` porque el agente ya había llevado al ERP, como `PW0000001`, el pedido pendiente que trae el seed.)

**Re-ejecución, estado y parada**

```
$ pnpm demo --no-check   (con todo ya levantado)  → «la pila ya estaba en marcha», api/web/agent en marcha después
$ pnpm demo status       → api en marcha (PID…), web en marcha, agent en marcha, supabase complete, saint-sql en marcha
$ pnpm demo check        → los 9 ✔ de arriba (incluido PW0000002)
$ pnpm demo:stop         → detenido api/web/agent; saint-sql y Supabase detenidos
$ pnpm demo status       → todo detenido; puertos 3001/3100/54321/14330 sin escuchar; 0 contenedores
```

**Dos defectos que salieron al probarlo, ya corregidos:** (1) la verificación comparaba contra «~311» productos y el sandbox tiene 311 pero **297 activos**; ahora compara contra `SELECT COUNT(*) FROM SAPROD WHERE Activo = 1` en el propio sandbox; (2) una prueba mía tenía las rutas de Windows con barras simples y fallaba (`String.raw`). Además, la primera ejecución en segundo plano dejó los procesos muertos: se comprobó que no era el script (un hijo desacoplado sobrevive entre llamadas, también lanzado desde `pnpm run`, y una ejecución en primer plano deja API, web y agente vivos); el entorno de esta sesión limpia lo que deja un trabajo en segundo plano al terminar.

**Nota para las E2E:** tras un demo la organización `demo-saint` tiene los datos del sandbox de Saint (311 productos y 48 clientes del agente), no los del seed; `pnpm db:reset` antes de `pnpm e2e`.
