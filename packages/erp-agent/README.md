# erp-agent

Agente local en Go (un único `.exe`, sin dependencias). Fuera del workspace pnpm.

Estructura:

- `cmd/erp-agent/`: punto de entrada.
- `internal/`: lógica privada del agente (adapters, sync, cola local), se añade por fases.

```
go build ./... && go test ./...
go run ./cmd/erp-agent
```
