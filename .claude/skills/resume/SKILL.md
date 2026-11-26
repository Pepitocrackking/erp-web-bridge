---
name: resume
description: Retoma el trabajo en erp-web-bridge tras un /clear o en una sesión nueva. Úsala cuando el usuario diga "continúa", "retoma", "¿dónde íbamos?" o empiece una sesión sin contexto. Reconstruye la posición desde docs/STATE.md, el ROADMAP y git, detecta incoherencias y propone la siguiente acción.
---

# resume

Reconstruye dónde está el proyecto leyendo el repo, no la memoria.

## Pasos

1. **Lee el estado.** `CLAUDE.md` ya importa `docs/STATE.md`; si no aparece en el contexto, léelo. Luego lee solo el bloque de la fase actual en `docs/ROADMAP.md`.
2. **Contrasta con la realidad**, con comandos reales:
   - `git branch --show-current`
   - `git status --short`
   - `git log --oneline -5`
   - `gh pr list --state open` para ver si hay un PR pendiente de merge.
   - Si la fase usa Docker: `docker ps` para saber qué contenedores están corriendo.
3. **Detecta incoherencias** y avísalas antes de seguir:
   - STATE dice una rama y estás en otra.
   - Hay cambios sin comitear que STATE no menciona.
   - El ROADMAP marca `[x]` en una tarea cuyo código no existe.
   - La fase anterior sigue con un PR abierto sin mergear.
4. **Resume en 5 líneas como máximo:** fase y rama, tareas hechas y pendientes, siguiente acción propuesta, bloqueos y cualquier incoherencia.
5. **Espera la confirmación del usuario** antes de implementar. Si el usuario ya pidió seguir ("continúa", "dale"), pasa directo a `next-task`. Si la fase está lista para cerrar, a `phase-gate`.

## Reglas

- No leas el ROADMAP completo ni los manuales salvo que haga falta: es justo el gasto de contexto que esta skill evita.
- Si STATE.md y el repo se contradicen, manda el repo. Corrige el STATE.md y dilo.
