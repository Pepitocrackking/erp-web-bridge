#!/usr/bin/env bash
# Verificación del Gate 1 desde cero. Imprime comando, resultado esperado y real de cada criterio.
# Uso: bash infra/saint-sandbox/tools/gate.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
export MSYS_NO_PATHCONV=1
fail=0
q() { # consulta escalar o tabular
  docker exec saint-sql bash -c "/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P \"\$MSSQL_SA_PASSWORD\" -d SAINT_DEMO -h -1 -W -b -Q \"SET NOCOUNT ON; $1\"" | tr -d '\r'
}
verdict() { if [ "$1" = ok ]; then echo "  => PASA"; else echo "  => FALLA"; fail=1; fi; }

echo "### Criterio 1: desde cero queda healthy en menos de 90 s"
echo "\$ docker compose down -v && docker compose up -d saint-sql"
docker compose down -v >/dev/null 2>&1
start=$(date +%s)
docker compose up -d saint-sql >/dev/null 2>&1
status=""
for _ in $(seq 1 90); do
  status=$(docker inspect -f '{{.State.Health.Status}}' saint-sql 2>/dev/null || true)
  [ "$status" = healthy ] && break
  sleep 1
done
elapsed=$(( $(date +%s) - start ))
echo "  esperado: healthy en < 90 s | real: $status en ${elapsed} s"
[ "$status" = healthy ] && [ "$elapsed" -lt 90 ] && verdict ok || verdict bad
docker compose run --rm saint-init 2>&1 | grep -E "^\[saint-init\]|Msg"

echo; echo "### Criterio 2: conteos y consistencia"
prods=$(q "SELECT COUNT(*) FROM SAPROD"); cats=$(q "SELECT COUNT(DISTINCT CodInst) FROM SAPROD")
depos=$(q "SELECT COUNT(*) FROM SADEPO"); clis=$(q "SELECT COUNT(*) FROM SACLIE")
incons=$(q "SELECT COUNT(*) FROM SAPROD p WHERE p.Existen <> (SELECT COALESCE(SUM(e.Existen),0) FROM SAEXIS e WHERE e.CodProd=p.CodProd)")
orph=$(q "SELECT COUNT(*) FROM SAEXIS e WHERE NOT EXISTS (SELECT 1 FROM SAPROD p WHERE p.CodProd=e.CodProd)")
echo "  SAPROD=$prods (>=300) categorias=$cats (>=8) SADEPO=$depos (=3) SACLIE=$clis (>=40)"
echo "  productos con Existen != suma(SAEXIS)=$incons (esperado 0); SAEXIS huerfanas=$orph (esperado 0)"
[ "$prods" -ge 300 ] && [ "$cats" -ge 8 ] && [ "$depos" -eq 3 ] && [ "$clis" -ge 40 ] && [ "$incons" -eq 0 ] && [ "$orph" -eq 0 ] && verdict ok || verdict bad

echo; echo "### Criterio 3: mutate cambia lo esperado y reset restaura (checksum)"
bash scripts/saint-sandbox.sh checksum >/tmp/gate-base.txt 2>&1
before=$(q "SELECT CAST(SUM(Precio1) AS VARCHAR(40)) FROM SAPROD WHERE CodProd IN ('P00001','P00002','P00003','P00004','P00005')")
exis_before=$(q "SELECT CAST(SUM(Existen) AS VARCHAR(40)) FROM SAEXIS WHERE CodUbic='001' AND CodProd IN ('P00006','P00007','P00008','P00009','P00010','P00011','P00012')")
saldo_before=$(q "SELECT CAST(Saldo AS VARCHAR(40)) FROM SACLIE WHERE CodClie='C00001'")
bash scripts/saint-sandbox.sh mutate >/dev/null 2>&1
after=$(q "SELECT CAST(SUM(Precio1) AS VARCHAR(40)) FROM SAPROD WHERE CodProd IN ('P00001','P00002','P00003','P00004','P00005')")
exis_after=$(q "SELECT CAST(SUM(Existen) AS VARCHAR(40)) FROM SAEXIS WHERE CodUbic='001' AND CodProd IN ('P00006','P00007','P00008','P00009','P00010','P00011','P00012')")
saldo_after=$(q "SELECT CAST(Saldo AS VARCHAR(40)) FROM SACLIE WHERE CodClie='C00001'")
incons2=$(q "SELECT COUNT(*) FROM SAPROD p WHERE p.Existen <> (SELECT COALESCE(SUM(e.Existen),0) FROM SAEXIS e WHERE e.CodProd=p.CodProd)")
bash scripts/saint-sandbox.sh checksum >/tmp/gate-mut.txt 2>&1
changed=$(diff <(grep -E '^SA' /tmp/gate-base.txt) <(grep -E '^SA' /tmp/gate-mut.txt) | grep -c '^>')
echo "  Precio1 P00001-5: suma $before -> $after (esperado x1.10)"
echo "  Existen dep.001 P00006-12: suma $exis_before -> $exis_after"
echo "  Saldo C00001: $saldo_before -> $saldo_after (esperado +50)"
echo "  tablas con huella distinta tras mutate: $changed (esperado 3: SAPROD, SAEXIS, SACLIE); inconsistencias=$incons2"
p_ok=$(awk -v b="$before" -v a="$after" 'BEGIN{d=a-b*1.10; print (d<0.01 && d>-0.01)?1:0}')
s_ok=$(awk -v b="$saldo_before" -v a="$saldo_after" 'BEGIN{d=a-b-50; print (d<0.001 && d>-0.001)?1:0}')
[ "$p_ok" = 1 ] && [ "$s_ok" = 1 ] && [ "$exis_before" != "$exis_after" ] && [ "$changed" -eq 3 ] && [ "$incons2" -eq 0 ] && mut=ok || mut=bad
bash scripts/saint-sandbox.sh reset >/dev/null 2>&1
bash scripts/saint-sandbox.sh checksum >/tmp/gate-reset.txt 2>&1
echo "  huellas base vs reset:"; diff <(grep -E '^SA' /tmp/gate-base.txt) <(grep -E '^SA' /tmp/gate-reset.txt) && echo "  idénticas"
if [ "$mut" = ok ] && diff -q <(grep -E '^SA' /tmp/gate-base.txt) <(grep -E '^SA' /tmp/gate-reset.txt) >/dev/null; then verdict ok; else verdict bad; fi
grep -E '^SA' /tmp/gate-base.txt

echo; echo "### Criterio 4: re-ejecutar el init no duplica datos (idempotencia)"
docker compose run --rm saint-init >/dev/null 2>&1; docker compose run --rm saint-init >/dev/null 2>&1
bash scripts/saint-sandbox.sh checksum >/tmp/gate-idem.txt 2>&1
echo "  huellas tras 2 ejecuciones extra del init:"; grep -E '^SA' /tmp/gate-idem.txt
diff -q <(grep -E '^SA' /tmp/gate-base.txt) <(grep -E '^SA' /tmp/gate-idem.txt) >/dev/null && verdict ok || verdict bad

echo; echo "### Extra: mapeo contra la base real"
bash infra/saint-sandbox/tools/validate-mapping.sh | tail -1
[ "${PIPESTATUS[0]}" = 0 ] || fail=1

echo; [ "$fail" = 0 ] && echo "GATE 1: TODO PASA" || echo "GATE 1: HAY FALLAS"
exit "$fail"
