# Sandbox de Saint Enterprise

Un SQL Server 2022 en Docker con las tablas básicas de Saint Enterprise y datos ficticios de una distribuidora venezolana. Sirve para desarrollar y probar el `SaintAdapter` del agente sin un Saint real.

> **Advertencia: el esquema es de mejor esfuerzo.** Los nombres de tablas y columnas salen del conocimiento público de Saint Enterprise y **no se han validado contra una base real**. Varían entre versiones. Antes de desplegar en un cliente hay que comparar `infra/saint-sandbox/init/01-schema.sql` con su base y ajustar `infra/saint-sandbox/mapping.saint.yaml`. El código del agente no debe cambiar por esto.

## Requisitos
- Docker con Compose v2.
- Windows (Git Bash o PowerShell), Linux o macOS.

## Levantarlo

```bash
# Git Bash / Linux / macOS
bash scripts/saint-sandbox.sh up
```
```powershell
# PowerShell
powershell -File scripts\saint-sandbox.ps1 up
```

`up` crea `.env` desde `.env.example` si no existe, levanta SQL Server, espera a que esté `healthy` y ejecuta los scripts de `infra/saint-sandbox/init/` en orden. Es idempotente: repetirlo no duplica datos. La primera vez descarga la imagen (unos 1,5 GB).

Conexión desde el host:

| Dato | Valor |
|---|---|
| Servidor | `localhost,14330` (cambia con `MSSQL_HOST_PORT`) |
| Usuario | `sa` |
| Contraseña | `MSSQL_SA_PASSWORD` de tu `.env` |
| Base | `SAINT_DEMO` |
| Certificado | confiar en el certificado del servidor (`TrustServerCertificate=true`) |

## Comandos

| Comando | Qué hace |
|---|---|
| `up` | Levanta el sandbox y carga esquema y seed |
| `mutate` | Simula actividad del ERP: sube 10 % el precio 1 de `P00001` a `P00005`, descuenta 5 unidades en el depósito 001 de `P00006` a `P00010`, repone 100 en `P00011` y `P00012`, y sube 50 USD el saldo de `C00001`. Es acumulativo |
| `reset` | Vacía las tablas y recarga el seed original |
| `checksum` | Muestra filas y huella de cada tabla (útil para comprobar que `reset` restaura el estado) |
| `down` | Detiene los contenedores y conserva los datos. Para borrar todo: `docker compose down -v` |

## Tablas

Montos en USD. Todo el contenido es ficticio.

| Tabla | Contenido | Columnas principales | Filas |
|---|---|---|---|
| `SAINSTA` | Categorías ("instancias") | `CodInst`, `Descrip` | 10 |
| `SADEPO` | Depósitos | `CodUbic`, `Descrip` | 3 |
| `SAPROD` | Productos | `CodProd`, `Descrip`, `CodInst`, `Costo`, `Precio1..3`, `Existen`, `Activo` | 311 |
| `SAEXIS` | Existencia por depósito | `CodProd`, `CodUbic`, `Existen` | 933 |
| `SACLIE` | Clientes | `CodClie`, `Descrip`, `ID3` (RIF), `LimiteCred`, `Saldo`, `Activo` | 48 |

### Pedidos de la web (Fase 7)

Arrancan vacías (el seed no las llena); solo el agente escribe aquí, y siempre como **borrador**.

| Tabla | Contenido | Columnas principales |
|---|---|---|
| `SAPEDIDO` | Cabecera del borrador | `NumeroD` (PW0000001...), `NumeroWeb` (id del pedido web, **UNIQUE**), `CodClie`, `Estado` (`B` = borrador), `Monto` USD, `Tasa` Bs/USD, `Notas` |
| `SAITEMPED` | Renglones | `NumeroD`, `NroLinea`, `CodProd`, `Cantidad`, `Precio`, `TotalItem` |
| `SQ_SAPEDIDO_WEB` | Secuencia del correlativo | (un hueco en la numeración es normal: lo deja un intento revertido) |

El índice único de `NumeroWeb` es lo que impide que reintentar un pedido cree un segundo borrador. `scripts/saint-sandbox.sh reset` las vacía y reinicia la secuencia. Su mapeo está en la sección `order_draft` de `mapping.saint.yaml`.

Invariante: `SAPROD.Existen` es la suma de `SAEXIS.Existen` de ese producto. `mutate` y el seed lo respetan.

Algunos clientes quedan cerca o por encima de su límite de crédito, para probar la validación del carrito. Cerca del 5 % de los productos y algún cliente están inactivos.

## Datos de ejemplo

El seed lo genera `infra/saint-sandbox/tools/gen-seed.mjs` con una semilla fija: mismo resultado en cada ejecución. No edites `02-seed.sql` a mano; cambia el generador y vuelve a generarlo:

```bash
node infra/saint-sandbox/tools/gen-seed.mjs
bash scripts/saint-sandbox.sh reset
```

El seed solo carga las tablas que estén vacías, así que un `up` posterior a un `mutate` no pisa los cambios. Para volver al estado original usa `reset`.

## Mapeo a campos canónicos

`infra/saint-sandbox/mapping.saint.yaml` traduce las columnas de Saint a los campos del puente (`sku`, `name`, `category`, `cost_usd`, `price_usd`, `stock`, `active`, y los de cliente). Para comprobar que el mapeo coincide con la base real:

```bash
bash infra/saint-sandbox/tools/validate-mapping.sh
```

## Problemas frecuentes
- **El contenedor no llega a `healthy`:** la contraseña de `sa` no cumple la política de SQL Server (8 o más caracteres, con mayúsculas, minúsculas, números y símbolos), o falta memoria en Docker (SQL Server pide al menos 2 GB).
- **Puerto 14330 ocupado:** cambia `MSSQL_HOST_PORT` en `.env`.
- **Cambié la contraseña y no entra:** el volumen conserva la contraseña anterior. Ejecuta `docker compose down -v` y vuelve a levantar.
