# Tasa de cambio automática (BCV)

Cada organización puede activar en su panel («Tasa de cambio» → «Tasa automática (BCV)») la lectura automática de la tasa oficial. La tasa manual sigue existiendo y sigue funcionando igual.

## Cómo funciona

La API (no el agente) consulta las fuentes **una vez por vuelta** para todas las organizaciones a las que les toca y aplica el resultado a cada una.

1. **Fuente primaria:** la portada de `https://www.bcv.org.ve/` (bloque `id="dolar"`). Si el bloque falta o la cifra no tiene la forma esperada, la lectura falla en lugar de adivinar.
2. **Fuente secundaria:** una API pública con formato DolarAPI (`https://ve.dolarapi.com/v1/dolares/oficial`).
3. **Último recurso:** la tasa manual. Si ninguna fuente responde se **conserva la última tasa** y el panel muestra una alerta.

## Reglas por organización

| Estado (`rate_auto_status`) | Cuándo | Efecto |
|---|---|---|
| `ok` | Lectura válida y distinta de la vigente | Se registra con `source = 'bcv'` |
| `unchanged` | Lectura válida e igual a la vigente | No se escribe nada |
| `manual_priority` | Hay una tasa **manual de hoy** (hora de Caracas) y la organización pidió respetarla | No se aplica; mañana la automática vuelve |
| `source_failed` | Ninguna fuente respondió | Se conserva la tasa; alerta en el panel |
| `jump_rejected` | La lectura varía más de `BCV_MAX_JUMP_PERCENT` (25 % por defecto) frente a la vigente | No se aplica; alerta en el panel |

«Actualizar ahora» consulta en el momento y aplica el resultado aunque la tasa automática esté apagada. Con **Aceptar aunque cambie mucho** (`force`) el administrador acepta una lectura descartada por el umbral y pisa una tasa manual de hoy.

El intervalo de revisión es por organización (15 a 1440 minutos). Una organización a la que le toca se «reclama» con un `UPDATE` atómico, así que varias instancias de la API no duplican trabajo ni filas.

## Configuración (variables de la API)

| Variable | Por defecto | Qué hace |
|---|---|---|
| `BCV_URL` | `https://www.bcv.org.ve/` | Fuente primaria |
| `BCV_FALLBACK_URL` | `https://ve.dolarapi.com/v1/dolares/oficial` | Fuente secundaria; vacía = sin respaldo |
| `BCV_TIMEOUT_MS` | 10000 | Espera máxima por fuente |
| `BCV_MAX_JUMP_PERCENT` | 25 | Variación máxima aceptada |
| `BCV_CHECK_INTERVAL_SECONDS` | 60 | Cada cuánto la API busca organizaciones a las que les toca |
| `BCV_SCHEDULER` | true | `false` apaga la revisión periódica (el botón sigue funcionando) |

Las URL deben ser `https` (o `http` hacia localhost, para pruebas). Una URL mal escrita detiene el arranque.

## API

- `GET /v1/orgs/:orgId/exchange-rate/auto`: configuración y último resultado (cualquier miembro).
- `PUT /v1/orgs/:orgId/exchange-rate/auto`: `{ enabled, interval_minutes, respect_manual }` (owner/admin).
- `POST /v1/orgs/:orgId/exchange-rate/auto/refresh`: `{ force? }` (owner/admin).

## Riesgos conocidos

- **El HTML del BCV puede cambiar.** El scraper falla de forma explícita (`source_failed` o cae a la secundaria) y hay un extracto real como fixture (`apps/api/test/fixtures/bcv-rates-excerpt.html`). Si cambia, actualizar `parseBcvHtml` y el fixture.
- **bcv.org.ve envía una cadena de certificados incompleta** (entrega el intermedio equivocado): sin ayuda, Node falla con `UNABLE_TO_VERIFY_LEAF_SIGNATURE` aunque curl o el navegador funcionen (completan la cadena solos). La API añade el intermedio correcto («Sectigo Public Server Authentication CA OV R36», vence en 2036; `apps/api/src/exchange-rate/bcv-ca.ts`) **solo a la conexión con el BCV**. La verificación TLS **no** se desactiva (hay pruebas que lo demuestran). Si el BCV cambia de proveedor de certificados, la fuente primaria fallará con ese error y se usará la secundaria: actualizar `bcv-ca.ts`.
- La API pública de respaldo no es oficial: se usa solo cuando el BCV no responde.
