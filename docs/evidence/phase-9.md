# Evidencia: Fase 9 (Tasa BCV automática)

Rama `phase-9/bcv-rate`. Verificado el 2026-11-27 desde un estado limpio (`pnpm install --frozen-lockfile`, `pnpm db:reset`, `pnpm build`).

## Criterios del Gate 9

| Criterio | Comando | Resultado esperado | Resultado real | Veredicto |
|---|---|---|---|---|
| Con las fuentes simuladas: la tasa se actualiza, cae a la secundaria, cae a la manual y el panel lo refleja | `pnpm e2e` en `apps/web` (`e2e/rate-auto.spec.ts`, simulador `e2e/bcv-sim.mjs`) y `apps/api/test/rate-auto.int.spec.ts` | 7 E2E y 27 pruebas de integración en verde | E2E completa: **63 pasaron, 6 saltadas (las de siempre)**; 7 de ellas son de esta fase. Integración API: 281 pasaron | ✅ |
| Una lectura absurda (fuera de rango o salto > umbral) no se aplica | `rate-sources.spec.ts` (rango), `rate-auto.int.spec.ts` («una lectura con un salto brusco no se aplica», «el umbral es configurable») y E2E «un salto absurdo se descarta…» | Estado `jump_rejected`, tasa intacta, alerta en el panel; con `force` se aplica | Pasa: 40 → lectura 4000 descartada; 4150 descartada en la web y aceptada solo con «Aceptar aunque cambie mucho» | ✅ |
| Prueba real de red contra bcv.org.ve (informativa) | `node real_bcv.js` (usa `BcvSource` y `DolarApiSource` compilados contra internet) | Se documenta el resultado | **bcv.org.ve: 926,3592** (fecha valor 2026-11-27) y **DolarAPI: 926,3592**; la cadena usa el BCV (0 fallos) | ✅ |

### Hallazgo de la prueba real (corregido en esta fase)

Con la verificación TLS completa, Node **no podía** leer bcv.org.ve: `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. El servidor del BCV envía el certificado de `*.bcv.org.ve` con un intermedio equivocado (curl y los navegadores lo completan solos por AIA; Node no). Se añadió el intermedio correcto (Sectigo OV R36, huella SHA-256 `65:42:D1:76:…:E7:85:30`) **solo a la conexión con el BCV** (`bcv-ca.ts`); `openssl verify` confirma que con él la cadena valida. La verificación TLS **no** se desactivó: hay pruebas que demuestran que un certificado autofirmado se rechaza y que la CA extra solo vale para esa fuente.

## Verificación completa

| Comprobación | Resultado |
|---|---|
| `bash scripts/validate-workflow.sh` | RESULTADO: OK |
| `pnpm build` | 3 tareas correctas |
| `pnpm lint` / `pnpm format:check` | código 0 / código 0 |
| `pnpm test` | shared-types **111**, web **98**, API **281** (16 suites), todo en verde |
| `pnpm test:db` (RLS) | **57** pasaron, 0 fallos (4 nuevas: función `set_rate_auto_settings`, columnas sin escritura directa, lectura por organización) |
| `pnpm test:scripts` | 11 pasaron |
| `go build/vet/test ./...` en `packages/erp-agent` | todo ok; `gofmt -l` sin salida |
| `pnpm e2e` (`apps/web`) | **63 pasaron**, 6 saltadas |

## Qué se entregó

- `apps/api/src/exchange-rate/`: `rate-sources.ts` (parser del HTML real del BCV y de DolarAPI, TLS), `rate-lookup.ts` (cadena de fuentes y control de saltos), `rate-auto.service.ts` (revisión periódica, reclamo atómico, prioridad manual de hoy en hora de Caracas), endpoints `GET|PUT /v1/orgs/:orgId/exchange-rate/auto` y `POST .../auto/refresh`.
- Migración `20261127000100_rate_auto.sql`: columnas `rate_auto_*` y la función `set_rate_auto_settings` (solo owner/admin).
- Panel: sección «Tasa automática (BCV)», alertas `rate-auto-failed` y `rate-auto-jump`, y actualización en vivo al llegar la tasa.
- Documentación en `docs/bcv-rate.md`.
- Decisión: el intervalo de revisión es por organización en minutos (15 a 1440) en lugar de una «hora» fija.
