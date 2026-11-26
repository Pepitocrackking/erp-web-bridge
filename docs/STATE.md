# STATE

Memoria del proyecto entre sesiones. Lo actualiza la skill `guardar-estado` y lo lee `retomar`. Se importa desde `CLAUDE.md`, así que se carga solo tras un `/clear`.

## Posición
- **Fase actual:** 1, Sandbox de Saint en Docker
- **Rama:** `phase-1/saint-sandbox` (creada desde `main` tras el merge del PR #1; aún sin push)
- **Última tarea completada:** 1.6 (`docs/saint-sandbox.md`). Todas las tareas de la Fase 1 están hechas; falta ejecutar `phase-gate`.
- **Estado de la fase:** en curso. Siguiente: phase-gate (Gate 1)

## Fases cerradas
- **Fase 0** (PR #1, fusionado el 2026-11-26): repo, `CLAUDE.md`, ROADMAP, STATE, 4 skills, plantilla de PR y `scripts/validate-workflow.sh`.
  - Pendiente menor: el usuario confirma que `/retomar` aparece como skill en una sesión nueva (último criterio del Gate 0).

## Siguiente acción
Ejecutar la tarea **1.1**: `docker-compose.yml` en la raíz del repo con SQL Server 2022 y un `.env.example`.

Detalles técnicos para hacerlo bien a la primera:
- Imagen: `mcr.microsoft.com/mssql/server:2022-latest`. Variables: `ACCEPT_EULA=Y`, `MSSQL_SA_PASSWORD` (viene de `.env`, que está en `.gitignore`; solo se commitea `.env.example` con un valor de ejemplo que cumpla la política de contraseñas de SQL Server).
- Healthcheck: `/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -Q "SELECT 1"`. La imagen 2022 usa `mssql-tools18`, y `-C` confía en el certificado.
- Los scripts de `init/` no se ejecutan solos: usa un servicio auxiliar `saint-init` (misma imagen, `depends_on` con `condition: service_healthy`) que corra `sqlcmd` sobre `infra/saint-sandbox/init/*.sql` en orden, y que sea **idempotente** (`IF DB_ID(...) IS NULL`, `IF NOT EXISTS`, `MERGE` o `TRUNCATE` y recarga en el seed).
- Puerto sugerido: `14330:1433`, para no chocar con un SQL Server local. Volumen con nombre para los datos.
- Verificación de 1.1: `docker compose down -v && docker compose up -d` y comprobar que el contenedor llega a `healthy` (`docker compose ps`).
- Docker ya está instalado y corriendo en la máquina (Docker 29.9.3, Windows).

Después, en orden: 1.2 esquema, 1.3 seed determinista, 1.4 mapeo, 1.5 scripts `up`/`reset`/`mutate`, 1.6 documentación. Luego `phase-gate` con el Gate 1 (ver ROADMAP).

Notas de diseño del esquema (tarea 1.2), de mejor esfuerzo según el conocimiento público de Saint Enterprise, a validar con una base real:
- `SAPROD`: `CodProd`, `Descrip`, `CodInst` (categoría), `Costo`, `Precio1`, `Precio2`, `Precio3`, `Existen`, `Activo`.
- `SAEXIS`: `CodProd`, `CodUbic` (depósito), `Existen`.
- `SADEPO`: `CodUbic`, `Descrip`. `SAINSTA`: `CodInst`, `Descrip`.
- `SACLIE`: `CodClie`, `Descrip`, `ID3` (RIF), `LimiteCred`, `Saldo`, `Activo`.
- Todo cambio de nombres va en `mapping.saint.yaml`, no en el código del agente.

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
Todavía no hay nada que levantar. Se completa en la Fase 1.
Validar el flujo de trabajo: `bash scripts/validate-workflow.sh`.

## Última actualización
2026-11-26. Fase 0 fusionada; rama de la Fase 1 creada con el relevo escrito.
