#!/usr/bin/env bash
# Valida la estructura del flujo de trabajo: skills, ROADMAP, STATE y archivos clave.
set -u

cd "$(dirname "$0")/.."
fail=0
err() { echo "FALLA: $*"; fail=1; }
ok()  { echo "ok:    $*"; }

for f in CLAUDE.md README.md docs/ROADMAP.md docs/STATE.md docs/manual-proyecto-1.md .github/pull_request_template.md; do
  [ -f "$f" ] && ok "existe $f" || err "falta $f"
done

for s in next-task phase-gate checkpoint resume; do
  f=".claude/skills/$s/SKILL.md"
  if [ ! -f "$f" ]; then err "falta $f"; continue; fi
  [ "$(sed -n '1p' "$f" | tr -d '\r')" = "---" ] || err "$f: no empieza con frontmatter ---"
  name=$(sed -n '2,10p' "$f" | tr -d '\r' | grep -m1 '^name:' | sed 's/^name:[[:space:]]*//')
  desc=$(sed -n '2,10p' "$f" | tr -d '\r' | grep -m1 '^description:' | sed 's/^description:[[:space:]]*//')
  [ "$name" = "$s" ] || err "$f: name='$name' no coincide con la carpeta '$s'"
  [ -n "$desc" ] || err "$f: description vacía"
  [ "$name" = "$s" ] && [ -n "$desc" ] && ok "skill $s válida"
done

phases=$(grep -c '^## Fase [0-9]*:' docs/ROADMAP.md)
gates=$(grep -c '^### Gate [0-9]*$' docs/ROADMAP.md)
[ "$phases" -ge 1 ] || err "ROADMAP sin fases"
[ "$phases" -eq "$gates" ] || err "ROADMAP: $phases fases pero $gates gates"
tasks=$(grep -cE '^- \[( |x)\] \*\*[0-9]+\.[0-9]+\*\*' docs/ROADMAP.md)
[ "$tasks" -ge 1 ] || err "ROADMAP sin tareas con el formato esperado"
ok "ROADMAP: $phases fases, $gates gates, $tasks tareas"

for h in "## Posición" "## Siguiente acción" "## Decisiones vigentes" "## Bloqueos y preguntas abiertas" "## Cómo levantar el proyecto"; do
  grep -qF "$h" docs/STATE.md && ok "STATE tiene '$h'" || err "STATE sin sección '$h'"
done

if git ls-files --error-unmatch .env >/dev/null 2>&1; then err ".env está versionado"; else ok ".env no versionado"; fi

if [ "$fail" -eq 0 ]; then echo "RESULTADO: OK"; else echo "RESULTADO: FALLÓ"; fi
exit "$fail"
