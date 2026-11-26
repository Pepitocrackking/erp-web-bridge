# Evidencia: Fase 1, Sandbox de Saint en Docker

Generada con `bash infra/saint-sandbox/tools/gate.sh` (parte de `docker compose down -v`, es decir, desde cero) y `bash scripts/validate-workflow.sh`. La variante PowerShell de los scripts (`saint-sandbox.ps1`: `checksum`, `mutate`, `reset`) también se ejecutó y restauró la misma huella.

| Criterio | Comando | Resultado | Veredicto |
|---|---|---|---|
| Desde cero el contenedor queda `healthy` en menos de 90 s | `docker compose down -v && docker compose up -d saint-sql` | `healthy` en 10 s (imagen ya descargada) | Pasa |
| >= 300 filas en `SAPROD`, 3 en `SADEPO`, >= 40 en `SACLIE`, `SAEXIS` consistente | consultas `COUNT(*)` y comparación `SAPROD.Existen` contra `SUM(SAEXIS.Existen)` | 311, 3, 48; 10 categorías; 0 inconsistencias; 0 filas huérfanas | Pasa |
| `mutate` cambia las filas esperadas y `reset` restaura (checksum) | `saint-sandbox.sh mutate`, `checksum`, `reset`, `checksum` | Precio1 de P00001-5: 7.69 a 8.459 (+10 %); saldo C00001: 3920.00 a 3970.00; cambian las huellas de `SAPROD`, `SAEXIS` y `SACLIE`; tras `reset` las 5 huellas son idénticas a las iniciales | Pasa |
| Repetir el init no duplica datos | dos ejecuciones extra de `saint-init` y `checksum` | Mismas filas y huellas que antes | Pasa |
| Extra: el mapeo solo referencia columnas reales | `bash infra/saint-sandbox/tools/validate-mapping.sh` | `MAPEO VALIDO` (prueba negativa con una columna inventada: `MAPEO INVALIDO`, código 1) | Pasa |
| `validate-workflow.sh` | `bash scripts/validate-workflow.sh` | `RESULTADO: OK`, código 0 | Pasa |

## Salida completa del Gate

```
### Criterio 1: desde cero queda healthy en menos de 90 s
$ docker compose down -v && docker compose up -d saint-sql
  esperado: healthy en < 90 s | real: healthy en 10 s
  => PASA
[saint-init] /init/01-schema.sql
[saint-init] /init/02-seed.sql
[saint-init] listo

### Criterio 2: conteos y consistencia
  SAPROD=311 (>=300) categorias=10 (>=8) SADEPO=3 (=3) SACLIE=48 (>=40)
  productos con Existen != suma(SAEXIS)=0 (esperado 0); SAEXIS huerfanas=0 (esperado 0)
  => PASA

### Criterio 3: mutate cambia lo esperado y reset restaura (checksum)
  Precio1 P00001-5: suma 7.6900 -> 8.4590 (esperado x1.10)
  Existen dep.001 P00006-12: suma 1341.000 -> 1521.000
  Saldo C00001: 3920.00 -> 3970.00 (esperado +50)
  tablas con huella distinta tras mutate: 3 (esperado 3: SAPROD, SAEXIS, SACLIE); inconsistencias=0
  huellas base vs reset:
  idénticas
  => PASA
SAINSTA          10   599024718
SADEPO            3  1209615905
SAPROD          311   901296529
SAEXIS          933   904265489
SACLIE           48 -1146525682

### Criterio 4: re-ejecutar el init no duplica datos (idempotencia)
  huellas tras 2 ejecuciones extra del init:
SAINSTA          10   599024718
SADEPO            3  1209615905
SAPROD          311   901296529
SAEXIS          933   904265489
SACLIE           48 -1146525682
  => PASA

### Extra: mapeo contra la base real
MAPEO VALIDO

GATE 1: TODO PASA
```

Nota: no hay CI todavía (llega en la Fase 2); el Gate se verificó en local.
