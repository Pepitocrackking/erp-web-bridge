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
