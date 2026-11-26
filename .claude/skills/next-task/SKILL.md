---
name: next-task
description: Avanza el proyecto erp-web-bridge una tarea a la vez. Úsala cuando el usuario diga "siguiente tarea", "continúa", "avanza" o "sigue con la fase". Lee docs/STATE.md y docs/ROADMAP.md, toma la primera tarea sin marcar de la fase actual, la implementa con pruebas, verifica su criterio y la marca. No hace push; al terminar todas las tareas de la fase entrega el control a phase-gate.
---

# next-task

Ejecuta **una** tarea del ROADMAP, la verifica y la marca. El checklist del repo es la memoria: no dependas de lo que "recuerdas" de la conversación.

## Pasos

1. **Ubícate.** Lee `docs/STATE.md`. Luego lee en `docs/ROADMAP.md` solo el bloque de la fase actual (desde `## Fase N` hasta el siguiente `## Fase`). No leas el archivo entero.
   **Si es la primera tarea de la fase:** analiza el bloque entero de la fase y reúne TODAS las dudas y decisiones abiertas (herramientas a instalar, alternativas, ambigüedades de criterios). Hazlas juntas, en una sola tanda con AskUserQuestion, antes de escribir código. Si no hay dudas reales, no preguntes nada. Con las respuestas, la fase corre sola hasta el Gate: no vuelvas a preguntar.
2. **Comprueba la rama.** `git branch --show-current` debe ser la rama de la fase (`phase-N/<slug>`). Si no existe, créala desde `main` actualizado. Si la fase anterior sigue sin mergear, pregunta al usuario antes de ramificar. Nunca trabajes en `main`.
3. **Elige la tarea.** La primera `- [ ] **N.M**` de la fase. Reformula en una frase qué debe quedar funcionando y cómo se comprueba. Si el criterio es ambiguo, pregunta antes de escribir código.
   **Esfuerzo sugerido:** clasifica la tarea con la escala de la skill `esfuerzo` (`.claude/skills/esfuerzo/SKILL.md`) y escribe UNA línea, por ejemplo `Esfuerzo sugerido: alto (Sonnet 5.5), porque toca autenticación.` Si el nivel es distinto del de la tarea anterior, añade en la misma línea desde qué tarea conviene volver a cambiarlo. Es solo informativo: no esperes respuesta ni pares, y no cambies de nivel por tu cuenta.
4. **Implementa en pequeño.** Una tarea, un alcance. No agregues funcionalidades que no estén en el ROADMAP. Para lógica pura (hashes, conversión de moneda, diffs, validaciones), escribe primero la prueba y verifica que falla por la razón correcta.
5. **Verifica la tarea.** Ejecuta el comando que la demuestra (tests, build, consulta a la base, petición real) y lee la salida completa. Sin salida fresca que lo respalde, la tarea no está hecha.
6. **Marca y comitea.** Cambia `- [ ]` por `- [x]` solo si el paso 5 pasó. Un commit por tarea, convencional, con la identidad noreply:
   `git -c user.name="Orlando Guerra" -c user.email="361565448+Pepitocrackking@users.noreply.github.com" commit ...`
   Termina el mensaje con la línea `Co-Authored-By` indicada por el entorno.
7. **Actualiza STATE.md** (última tarea completada y siguiente acción) y súmalo al mismo commit.
8. **Decide cómo seguir.**
   - Si quedan tareas pendientes en la fase: continúa con la siguiente sin preguntar (el usuario resuelve todas las dudas al inicio de la fase).
   - Si todas las tareas de la fase están marcadas: **invoca `phase-gate`**. No hagas push por tu cuenta.

## Reglas

- Si una tarea te bloquea, no la saltes en silencio: anótalo en "Bloqueos" de `docs/STATE.md`, avisa al usuario y propón opciones.
- Si descubres que una tarea del ROADMAP está mal planteada, propón el cambio al usuario. No lo cambies por tu cuenta.
- Nunca marques `[x]` por "debería funcionar", por un test anterior o por una verificación parcial.
- Si el contexto de la conversación ya es largo, sugiere ejecutar `guardar-estado` y que el usuario haga `/clear`.
