# Evidencia: Fase 0, Bootstrap y flujo de trabajo

| Criterio | Comando | Resultado | Veredicto |
|---|---|---|---|
| `validate-workflow.sh` termina con código 0 | `bash scripts/validate-workflow.sh; echo EXIT=$?` | 17 comprobaciones `ok`, `RESULTADO: OK`, `EXIT=0` | Pasa |
| Las 4 skills tienen frontmatter válido | mismo script | `next-task`, `phase-gate`, `checkpoint` y `resume`: `name` igual a la carpeta y `description` no vacía | Pasa |
| PR de `phase-0/bootstrap` abierto contra `main` | `gh pr create --base main` | Se comprueba después de abrir el PR | Ver el PR |
| `/resume` disponible en una sesión nueva tras el merge | Lo confirma el usuario | Pendiente: solo se puede comprobar después del merge | Pendiente |

## Salida del script de validación

```
ok:    existe CLAUDE.md
ok:    existe README.md
ok:    existe docs/ROADMAP.md
ok:    existe docs/STATE.md
ok:    existe docs/manual-proyecto-1.md
ok:    existe .github/pull_request_template.md
ok:    skill next-task válida
ok:    skill phase-gate válida
ok:    skill checkpoint válida
ok:    skill resume válida
ok:    ROADMAP: 9 fases, 9 gates, 53 tareas
ok:    STATE tiene '## Posición'
ok:    STATE tiene '## Siguiente acción'
ok:    STATE tiene '## Decisiones vigentes'
ok:    STATE tiene '## Bloqueos y preguntas abiertas'
ok:    STATE tiene '## Cómo levantar el proyecto'
ok:    .env no versionado
RESULTADO: OK
```

## Nota

El repo es público y los commits usan el correo `noreply` de GitHub de la cuenta, no el correo personal.
