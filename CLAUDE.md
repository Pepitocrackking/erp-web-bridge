# erp-web-bridge

Puente ERP-a-Web y catálogo B2B multimoneda (USD/Bs). Proyecto de portafolio con vocación comercial: debe poder escalar y venderse a pymes y distribuidoras de Venezuela/LATAM.

Contexto completo del proyecto: @docs/manual-proyecto-1.md

## Estado actual (se carga solo en cada sesión)
@docs/STATE.md

El plan completo, con tareas y criterios de aceptación por fase, está en `docs/ROADMAP.md`. Léelo por fase, no entero: busca el encabezado `## Fase N` que indique STATE.md.

## Decisiones tomadas
- Agente local en **Go** (un único `.exe`, sin dependencias).
- **Saint Enterprise es el ERP principal.** Se prueba contra un sandbox en Docker con SQL Server 2022 que replica las tablas básicas de Saint (`SAPROD`, `SAEXIS`, `SACLIE`, `SADEPO`, `SAINSTA`). Los nombres de columnas son de mejor esfuerzo y se mantienen en un archivo de mapeo configurable, porque varían entre versiones de Saint y aún no se han validado contra una base real.
- **OdooAdapter** va en el backlog de la v1, no en el MVP. `MockAdapter` sí está en el MVP, para demos y tests.
- MVP: carrito estándar con **validación de límite de crédito**; tasa de cambio **manual** desde el panel (el scraper BCV es v1).
- Los pedidos web llegan al ERP solo como **borradores**. Nunca se escribe en tablas fiscales.

## Flujo de trabajo (obligatorio)
- **Una rama y un PR por fase:** `phase-N/<slug>`. Nunca se hace push directo a `main`.
- Las tareas se ejecutan una por una con la skill `next-task` y se marcan en `docs/ROADMAP.md`.
- **Nada se declara terminado ni se pushea sin pasar `phase-gate`:** verificación completa con datos reales y evidencia fresca (salida real de comandos), nunca "debería funcionar".
- `phase-gate` abre el PR y, **solo si todo el Gate pasó** (y el CI en verde, cuando exista), **hace el merge él mismo** con `gh pr merge --merge`. El usuario lo autorizó el 2026-11-26 y solo revisa el resumen de cada fase. Si algo falla, no hay push ni merge.
- Antes de que el usuario haga `/clear`, ejecutar `checkpoint`. Después de un `/clear`, ejecutar `resume`.

## Skills del proyecto (`.claude/skills/`)
| Skill | Cuándo |
|---|---|
| `next-task` | Avanzar a la siguiente tarea pendiente de la fase actual |
| `phase-gate` | Al terminar todas las tareas de una fase: verificar, pushear y abrir PR |
| `checkpoint` | Guardar el estado en `docs/STATE.md` antes de `/clear` |
| `resume` | Retomar tras `/clear` o en una sesión nueva |

## Convenciones
- Comunicación, documentación y commits en español; identificadores de código en inglés.
- Commits convencionales (`feat:`, `fix:`, `docs:`, `chore:`, `test:`), uno por tarea.
- Los commits se hacen con el correo `noreply` de GitHub de la cuenta Pepitocrackking, pasado con `git -c user.name=... -c user.email=...`. No se modifica la configuración global de git, porque el repo es público.
- Esquemas SQL y migraciones en `supabase/migrations/`; el sandbox de Saint en `infra/saint-sandbox/`.
- Nunca se commitean secretos. Solo `.env.example`.
- Plataforma de desarrollo: Windows. Los scripts deben funcionar en Git Bash y en PowerShell, o tener ambas variantes.
