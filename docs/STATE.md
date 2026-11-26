# STATE

Memoria del proyecto entre sesiones. Lo actualiza la skill `checkpoint` y lo lee `resume`. Se importa desde `CLAUDE.md`, así que se carga solo tras un `/clear`.

## Posición
- **Fase actual:** 0, Bootstrap y flujo de trabajo
- **Rama:** `phase-0/bootstrap`
- **Última tarea completada:** 0.6
- **Estado de la fase:** tareas y Gate verificados; PR abierto, esperando el merge del usuario

## Siguiente acción
1. El usuario revisa y hace merge del PR de `phase-0/bootstrap`.
2. Tras el merge: `git checkout main && git pull`, crear la rama `phase-1/saint-sandbox` y empezar la tarea 1.1 (docker-compose con SQL Server 2022). Verificación de esa tarea: el contenedor llega a `healthy`.
3. El usuario confirma que `/resume` aparece como skill en una sesión nueva (último criterio del Gate 0).

## Decisiones vigentes
- Agente en Go. Saint es el ERP principal, probado con un sandbox SQL Server 2022 en Docker.
- Odoo, el scraper BCV y los precios escalonados están en el backlog v1.
- Una rama y un PR por fase. El merge lo hace el usuario.
- Commits con el correo noreply de GitHub, pasado por `-c`, sin tocar la configuración global. Motivo: el repo es público y el correo global es personal.
- El nombre exacto de las columnas de Saint es de mejor esfuerzo; vive en `infra/saint-sandbox/mapping.saint.yaml` y debe validarse contra una base real.

## Bloqueos y preguntas abiertas
- Ninguno.

## Cómo levantar el proyecto
Todavía no hay nada que levantar. Se completa en la Fase 1.
Validar el flujo de trabajo: `bash scripts/validate-workflow.sh`.

## Última actualización
Fase 0 completa a falta del merge.
