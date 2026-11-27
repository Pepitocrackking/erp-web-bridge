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
