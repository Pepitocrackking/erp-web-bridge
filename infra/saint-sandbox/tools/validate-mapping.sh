#!/usr/bin/env bash
# Comprueba que mapping.saint.yaml solo referencia tablas y columnas que existen en SAINT_DEMO,
# y que están todos los campos canónicos. Requiere el contenedor saint-sql en marcha.
# Uso: bash infra/saint-sandbox/tools/validate-mapping.sh
set -euo pipefail
cd "$(dirname "$0")/.."
MAP=mapping.saint.yaml

# Esquema real: lista "TABLA.COLUMNA"
actual=$(MSYS_NO_PATHCONV=1 docker exec saint-sql bash -c '/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -d SAINT_DEMO -h -1 -W -b -Q "SET NOCOUNT ON; SELECT TABLE_NAME+\".\"+COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS"' | tr -d '\r')

fail=0
check() { # $1 = TABLA.COLUMNA
  if grep -qx "$1" <<<"$actual"; then echo "ok   $1"; else echo "FALTA $1"; fail=1; fi
}

# Recorre secciones de primer nivel: cada `table:` fija la tabla, cada `column:` se valida contra ella.
section_table=""
while IFS= read -r line; do
  if [[ "$line" =~ ^[a-z_]+:\ *$ ]]; then section_table=""; fi
  if [[ "$line" =~ ^\ \ table:\ ([A-Z]+) ]]; then section_table="${BASH_REMATCH[1]}"; fi
  if [[ "$line" =~ column:\ ([A-Za-z0-9]+) ]] && [[ -n "$section_table" ]]; then check "${section_table}.${BASH_REMATCH[1]}"; fi
  if [[ "$line" =~ lookup:\ \{\ table:\ ([A-Z]+),\ key:\ ([A-Za-z0-9]+),\ label:\ ([A-Za-z0-9]+) ]]; then
    check "${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"; check "${BASH_REMATCH[1]}.${BASH_REMATCH[3]}"
  fi
  if [[ "$line" =~ ^\ \ \ \ list[0-9]:\ ([A-Za-z0-9]+) ]]; then check "SAPROD.${BASH_REMATCH[1]}"; fi
done < "$MAP"

for f in sku name category cost_usd price_usd stock active; do
  if grep -qE "^    $f:" "$MAP"; then echo "ok   campo canonico $f"; else echo "FALTA campo canonico $f"; fail=1; fi
done

[ "$fail" = 0 ] && echo "MAPEO VALIDO" || { echo "MAPEO INVALIDO"; exit 1; }
