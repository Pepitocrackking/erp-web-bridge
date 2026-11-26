---
name: esfuerzo
description: Aconseja con qué nivel de esfuerzo de razonamiento (bajo, medio, alto, muy alto) y qué modelo (Sonnet 5 o Sonnet 5.5) conviene trabajar la siguiente tarea de erp-web-bridge. Úsala cuando el usuario pregunte "¿con qué esfuerzo?", "¿qué nivel de pensamiento?", "¿bajo o profundo?", "¿qué modelo uso?", o antes de arrancar una tarea o fase para ahorrar tiempo y costo sin perder calidad. Solo aconseja; no cambia nada.
---

# esfuerzo

Recomienda el nivel de razonamiento justo para la tarea que viene: **bajo cuando las instrucciones ya lo dicen todo, profundo cuando hay que decidir algo difícil de deshacer.** Más esfuerzo es más lento y más caro; menos esfuerzo en una tarea delicada produce errores caros. Esta skill solo recomienda: el usuario cambia el nivel (selector de modelo y esfuerzo de Claude Code, `/model`) y esta skill no lo cambia por su cuenta.

## Pasos

1. **Ubícate.** Lee `docs/STATE.md` (fase y siguiente tarea) y, en `docs/ROADMAP.md`, solo el bloque de la fase actual. Si el usuario nombra una tarea o fase concreta, usa esa.
2. **Clasifica cada tarea pendiente** con la escala de abajo. Si la tarea tiene varias partes de distinto peso, clasifica por la parte más delicada.
3. **Responde corto** (máximo 6 líneas, o una tabla si la fase tiene tareas de niveles distintos):
   - Tarea y nivel recomendado, con el motivo en una frase.
   - Modelo: ver "Modelo".
   - Cuándo cambiar de nivel: en qué tarea de la fase conviene subir o bajar, para que el usuario lo haga una vez y no a cada rato.
4. **No empieces a implementar** salvo que el usuario lo pida. Si ya pidió seguir, recomienda y pasa a `next-task`.

## Escala

| Nivel | Cuándo | Ejemplos en este proyecto |
|---|---|---|
| **Bajo** | La instrucción es exacta y hay un patrón que copiar. Sin decisiones de diseño. Un error se ve al instante. | Documentación, README, `STATE.md`, `guardar-estado`, `retomar`, configuración, renombrar, scripts de atajo, correr comandos del Gate y pegar la salida, componentes de UI con diseño ya definido. |
| **Medio** | Funcionalidad normal que sigue un patrón ya establecido en el repo, con pruebas. | Un endpoint más parecido a otro ya hecho, una pantalla CRUD, `MockAdapter`, logs y configuración del agente, integración de librerías con documentación clara (throttler, OpenAPI, PWA). |
| **Alto** | Hay que **decidir** o **no equivocarse**: seguridad, dinero, integridad de datos, concurrencia, idempotencia, diseño que otras fases heredarán, o depurar algo que no es obvio. | Autenticación y claves, RLS, límite de crédito, upsert masivo y reconciliación, delta sync por hash, interfaz `ERPAdapter`, cola y reintentos del agente, garantía de no escritura fiscal, revisión de seguridad. |
| **Muy alto** | Rara vez. Un fallo silencioso sería grave y el problema cruza varios componentes; o ya fallaste dos veces en nivel alto. | Pérdida de datos con cortes de red o de luz, condiciones de carrera entre agente y API, una auditoría de seguridad completa. |

**Subir o bajar sobre la marcha:**
- Baja un escalón si la tarea resultó más mecánica de lo previsto.
- **Sube un escalón si el primer intento falla** o si descubres que hay una decisión de diseño escondida (sobre todo si toca dinero, seguridad o datos). Fallar en bajo y reintentar en bajo es la forma más cara de ahorrar.
- La verificación de cierre (`phase-gate`) es mecánica pero crítica: nivel **medio**, y **alto** en cuanto algo falle y haya que diagnosticarlo.

## Modelo

- **Sonnet 5 con esfuerzo bajo o medio:** tareas de las filas "Bajo" y "Medio". Es lo más rápido y barato, y con instrucciones tan claras como las del ROADMAP rinde igual.
- **Sonnet 5.5 con esfuerzo alto o muy alto:** tareas de las filas "Alto" y "Muy alto", y cualquier diagnóstico de un fallo.
- Si ya estás en Sonnet 5.5, para tareas bajas basta con bajar el esfuerzo: no hace falta cambiar de modelo.

## Guía por fase (punto de partida; la clasificación de la tarea manda)

| Fase | Bajo | Medio | Alto |
|---|---|---|---|
| 4 API | | 4.3, 4.4, 4.5, 4.7 | 4.1 (auth), 4.2 (upsert y reconciliación), 4.6 (crédito e idempotencia) |
| 5 Agente Go | | 5.2, 5.7 | 5.1 (interfaz), 5.3 (Saint), 5.4 (hash y delta), 5.5, 5.6 (resiliencia: considerar muy alto) |
| 6 Web | 6.5 | 6.1, 6.4, 6.6, 6.7 | 6.2 (aprobación de clientes), 6.3 (límite de crédito) |
| 7 Pedidos al ERP | 7.4 | | 7.1, 7.2 (idempotencia), 7.3 (no escribir en tablas fiscales) |
| 8 Portafolio | 8.3 (README) | 8.1, 8.2, 8.4, 8.6 | 8.5 (seguridad) |
| Cierre de fase | `guardar-estado`, `retomar`, redactar el PR | `phase-gate` | diagnosticar un Gate que falla |

## Reglas

- Recomienda **un** nivel por tarea y di por qué; no des un abanico.
- No expliques la teoría del esfuerzo: el usuario quiere saber qué poner ahora.
- Si la tarea no está en la tabla, clasifícala con la escala, no con la intuición.
- No cambies `docs/ROADMAP.md` ni `docs/STATE.md` por esto.
