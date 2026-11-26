#!/usr/bin/env bash
# Control del sandbox de Saint (SQL Server en Docker).
# Uso: bash scripts/saint-sandbox.sh {up|reset|mutate|checksum|down}
#   up        levanta SQL Server y carga esquema y seed (idempotente)
#   reset     vacía las tablas y recarga el seed original
#   mutate    cambia precios, stock y un saldo para simular actividad del ERP
#   checksum  muestra filas y huella de cada tabla
#   down      detiene los contenedores y conserva los datos (usa `down -v` a mano para borrarlos)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$ROOT/infra/saint-sandbox/tools"
cd "$ROOT"
export MSYS_NO_PATHCONV=1

sql_file() { # $1 = archivo .sql
  docker exec -i saint-sql bash -c '/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -b' < "$1"
}

wait_ready() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' saint-sql 2>/dev/null || true)" = healthy ] && return 0
    sleep 2
  done
  echo "saint-sql no llegó a healthy" >&2; return 1
}

run_init() { docker compose run --rm saint-init; }

case "${1:-}" in
  up)
    [ -f .env ] || { cp .env.example .env; echo "Creado .env desde .env.example"; }
    docker compose up -d saint-sql
    wait_ready
    run_init
    echo "Sandbox listo en localhost:${MSSQL_HOST_PORT:-14330} (base SAINT_DEMO)"
    ;;
  reset)
    wait_ready
    sql_file "$TOOLS/reset.sql"
    run_init
    echo "Sandbox restaurado al seed original"
    ;;
  mutate)
    wait_ready
    sql_file "$TOOLS/mutate.sql"
    echo "Mutaciones aplicadas"
    ;;
  checksum)
    wait_ready
    sql_file "$TOOLS/checksum.sql"
    ;;
  down)
    docker compose down
    ;;
  *)
    echo "Uso: $0 {up|reset|mutate|checksum|down}" >&2; exit 2
    ;;
esac
