---
name: phase-gate
description: Compuerta de calidad al cerrar una fase de erp-web-bridge. Úsala cuando todas las tareas de la fase estén marcadas, o cuando el usuario pida "verificar la fase", "cerrar la fase" o "hacer push". Verifica al 100% con datos reales y evidencia fresca cada criterio del Gate. Solo si todo pasa, hace push de la rama, abre el PR, lo fusiona y deja el relevo escrito para la fase siguiente. Si algo falla, no hace push ni merge.
---

# phase-gate

Nada sale de la rama sin pasar esta compuerta. La regla de hierro:

> **Ninguna afirmación de "funciona" sin la salida de un comando ejecutado en este mismo turno que la respalde.**

## Precondiciones

- Estás en la rama `phase-N/<slug>`, no en `main`.
- Todas las tareas `N.M` de la fase están `[x]`. Si falta alguna, vuelve a `next-task`.
- `git status` está limpio, o lo pendiente pertenece a esta fase y se va a comitear.

## Pasos

1. **Lee el Gate.** En `docs/ROADMAP.md`, el bloque `### Gate N` de la fase. Cada línea es un criterio que debes comprobar por separado.
2. **Parte de un estado limpio.** Reconstruye lo que haga falta desde cero: `docker compose down -v` y luego `up`, instalación limpia de dependencias, base de datos recreada. Un entorno "que ya estaba andando" no demuestra nada.
3. **Ejecuta la verificación completa**, con datos reales del sandbox o del seed, no con datos de prueba triviales:
   - Siempre: `bash scripts/validate-workflow.sh`, build, lint y todos los tests que existan en la fase.
   - Según la fase: el escenario E2E del Gate (sandbox, agente, API, base de datos, web).
4. **Comprueba cada criterio del Gate uno por uno.** Para cada uno anota: el comando, el resultado esperado y el resultado real. Lee la salida completa y el código de salida, no solo la última línea.
5. **Guarda la evidencia** en `docs/evidence/phase-N.md`: tabla de criterio, comando, resultado y veredicto. Es lo que verá quien revise el PR.
6. **Decide.**
   - **Algún criterio falla o no se pudo comprobar:** no hagas push. Corrige y repite desde el paso 2, o anótalo en "Bloqueos" de `docs/STATE.md` y avisa al usuario. Un criterio que no pudiste comprobar cuenta como fallido.
   - **Todos pasan:** continúa.
7. **Marca el Gate** (`- [x]` en cada criterio), actualiza `docs/STATE.md` (fase completada y siguiente fase) y comitea la evidencia con la identidad noreply:
   `git -c user.name="Orlando Guerra" -c user.email="361565448+Pepitocrackking@users.noreply.github.com" commit ...`
8. **Push y PR.** `git push -u origin <rama>` y luego `gh pr create --base main` con el título `Fase N: <nombre>`. El cuerpo sigue `.github/pull_request_template.md`: resumen, tabla de evidencia y qué viene después. Termina el cuerpo con la línea de atribución indicada por el entorno.
9. **Merge.** El usuario delegó el merge en esta skill (2026-11-26). Con el Gate completo en verde, y el CI en verde si ya existe (`gh pr checks <n>`), ejecuta `gh pr merge <n> --merge`. No uses `--admin` ni saltes checks fallidos. Si el CI falla, vuelve al paso 6.

## Después del merge

1. `git checkout main && git pull`, y comprueba con `git log` que el merge está.
2. Crea la rama de la siguiente fase (`phase-N+1/<slug>`).
3. **Escribe el relevo en `docs/STATE.md`** para la fase siguiente: la tarea `N+1.1` con archivos, comandos y detalles técnicos que vayas a necesitar, más el hilo de contexto. Comitea en la rama nueva (sin push).
4. Entrega al usuario **un resumen corto de la fase** (qué se hizo, evidencia clave, enlace al PR) y dile que ya puede escribir `/clear` y luego `/retomar`. Ese es el único momento en que se le pide algo.

## Señales de alarma: si piensas esto, detente

| Pensamiento | Realidad |
|---|---|
| "Debería funcionar" | Ejecútalo y míralo. |
| "Los tests pasaron hace un rato" | Fue antes de tus últimos cambios. Vuelve a correrlos. |
| "Solo falta un detalle menor, hago push igual" | El Gate es todo o nada. |
| "No tengo Docker o la red ahora, lo marco como pasado" | No comprobado equivale a fallido. |
| "El mock devuelve lo correcto" | El Gate pide datos reales del sandbox. |
| "Lo arreglo en la próxima fase" | Se arregla ahora o se anota como bloqueo con el usuario. |

## Notas de plataforma

El desarrollo es en Windows. Usa Git Bash para los scripts `.sh` y PowerShell para los `.ps1`. Si un comando de verificación solo existe en una variante, ejecuta la que corresponda.
