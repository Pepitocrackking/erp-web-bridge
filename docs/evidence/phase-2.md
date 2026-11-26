# Evidencia: Fase 2, Monorepo y CI

Generada el 2026-11-26 en un **clon limpio** de la rama `phase-2/monorepo-ci` (commit `193a395`), en un directorio nuevo, sin `node_modules` ni caché de Turborepo del árbol de trabajo. Entorno: Node v24.14.1, pnpm 12.14.0, Go 1.26.5, Windows.

| Criterio | Comando | Resultado | Veredicto |
|---|---|---|---|
| `pnpm install && pnpm build && pnpm test` en verde desde un clon limpio | `git clone --branch phase-2/monorepo-ci ...`, luego `pnpm install`, `pnpm build`, `pnpm test` | install: código 0 (2 min 2 s); build: 3/3 tareas, código 0; test: 4/4 tareas, 34 pruebas (shared-types 32, api 1, web 1), código 0 | Pasa |
| `go build ./... && go test ./...` en verde | `cd packages/erp-agent && go build ./... && go test ./...` | build sin errores; `ok .../internal/version`; código 0 | Pasa |
| El workflow de CI queda en verde en el propio PR | `gh pr checks <n>` | Ver "Resultado del CI" al final | Pasa |
| Extra: lint y formato | `pnpm lint`, `pnpm format:check`, `go vet ./...`, `gofmt -l .` | lint 4/4 tareas; "All matched files use Prettier code style!"; `go vet` sin avisos; `gofmt -l` vacío | Pasa |
| Extra: la API compilada responde | `PORT=3911 node dist/main.js` y `curl /health` | `HTTP/1.1 200 OK`, cuerpo `{"status":"ok"}` | Pasa |
| Extra: ESLint detecta infracciones reales | archivo temporal con `var` y variables sin usar | 3 errores reportados; sin el archivo, limpio | Pasa |
| `validate-workflow.sh` | `bash scripts/validate-workflow.sh` | `RESULTADO: OK`, código 0 | Pasa |

## Decisiones técnicas con evidencia

- **NestJS 11.x y no 12.** Con Nest 12, `pnpm test` en la API falló con `Must use import to load ES Module: .../@nestjs/testing/index.js`: Nest 12 es solo ESM y el resto del workspace es CommonJS. Se fijó 11.2.12 y las pruebas pasaron.
- **`@parcel/watcher` sin build.** `pnpm install` terminaba con `ERR_PNPM_IGNORED_BUILDS`. Es una dependencia nativa opcional de jest (solo para `--watch`); se declaró `allowBuilds: '@parcel/watcher': false` en `pnpm-workspace.yaml`.

## Resultado del CI

PR #3, ejecución https://github.com/Pepitocrackking/erp-web-bridge/actions/runs/45850491140, con `gh pr checks 3`:

```
TypeScript (lint, test, build)  pass  34s
Go (vet, build, test)           pass  22s
```

El workflow se ejecutó por primera vez en este PR y pasó sin correcciones, lo que confirma que `pnpm/action-setup@v4` toma pnpm 12.14.0 de `packageManager` y que `actions/setup-go@v5` resuelve `go 1.26` desde `go.mod`.
