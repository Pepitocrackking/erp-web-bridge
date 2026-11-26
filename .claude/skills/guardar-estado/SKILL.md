---
name: guardar-estado
description: Guarda el estado del proyecto erp-web-bridge en docs/STATE.md para que el usuario pueda hacer /clear sin perder contexto. Úsala cuando el usuario diga "guardar estado", "checkpoint", "voy a limpiar el contexto", "voy a hacer clear" o cuando la conversación sea muy larga. No hace push.
---

# guardar-estado

Convierte lo que sabes en este momento en texto que sobrevive a un `/clear`. Después de esto, la sesión siguiente debe poder continuar sin preguntar nada.

## Pasos

1. **Revisa el estado real**, sin fiarte de la memoria:
   - `git branch --show-current`
   - `git status --short`
   - `git log --oneline -5`
   - En `docs/ROADMAP.md`, qué tareas de la fase actual están `[x]` y cuáles no.
2. **Reescribe `docs/STATE.md`** completo, con las secciones que ya tiene:
   - **Posición:** fase, rama, última tarea completada y estado de la fase.
   - **Siguiente acción:** concreta y ejecutable. Nombra la tarea (`N.M`), los archivos que tocarás y el comando de verificación. No vale "seguir con la fase".
   - **Decisiones vigentes:** solo las que no están ya en el código ni en `CLAUDE.md`, con su porqué.
   - **Bloqueos y preguntas abiertas:** lo que esté esperando al usuario.
   - **Cómo levantar el proyecto:** los comandos exactos que funcionan hoy.
   - **Última actualización:** fecha y una frase.
3. **Trabajo a medias.** Si hay cambios sin comitear de una tarea no terminada, descríbelos en "Siguiente acción" (qué falta y en qué archivos) y haz un commit `wip:` en la rama de la fase para que no se pierdan. Una tarea a medias **nunca** se marca `[x]`.
4. **Comitea** el STATE.md (`docs(state): checkpoint`) con la identidad noreply:
   `git -c user.name="Orlando Guerra" -c user.email="361565448+Pepitocrackking@users.noreply.github.com" commit ...`
5. **No hagas push.** El push solo ocurre en `phase-gate`, después de verificar.
6. **Confirma** al usuario en pocas líneas: dónde quedó, cuál es la siguiente acción y que ya puede escribir `/clear`. Recuérdale que después use `retomar`.

## Comprobación final

Antes de decir que está listo, relee `docs/STATE.md` y confirma que un lector que no conoce esta conversación sabría exactamente qué hacer. Si "Siguiente acción" es vaga, reescríbela.
