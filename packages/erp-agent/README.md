# erp-agent

Agente local en Go (un único `.exe`, sin CGO ni dependencias externas). Fuera del workspace pnpm.

Lee el ERP del comercio (Saint primero) y empuja **solo los cambios** por HTTPS a la API. Nunca abre puertos: todas las conexiones son salientes.

## Cómo funciona

```
ERP (Saint / mock) ──► Syncer ──► cola SQLite (outbox) ──► Sender ──HTTPS──► API
                         │                                    │
                         └── huellas SHA-256 (delta) ◄────────┘ (se guardan al confirmar)
```

- **Delta sync:** el hash de cada producto es SHA-256 de `sku \x1f precio \x1f stock \x1f nombre` (importes con 2 decimales; forma canónica documentada en `internal/delta`). Solo se envía lo que cambió respecto a las huellas guardadas.
- **Reconciliación completa** periódica (`sync.reconcile_interval`): envía todo el inventario en lotes de 1000; el último desactiva en la nube lo que ya no existe en el ERP. Si el ERP devuelve 0 registros habiendo enviado antes, **no** reconcilia (protege el catálogo).
- **Tolerancia a cortes de red y de luz:** cada lote se guarda en SQLite con su `batch_id` antes de enviarse y solo sale de la cola cuando la API responde 200. Un reenvío tras un corte usa el mismo `batch_id` y la API lo reconoce como duplicado. Reintentos con backoff exponencial (1 s → 5 min, con jitter) y respeto de `Retry-After` (429).
- **Pedidos hacia el ERP (Fase 7):** en cada ciclo el agente pide a la API los pedidos `pending_sync` (`GET /v1/orders/pending`, los más antiguos primero) y los deja en el ERP como **borradores**, de uno en uno. Solo escribe en las dos tablas de `order_draft` del mapeo; es idempotente por el id del pedido web. Se desactiva con `orders.enabled: false`.

## Uso

```
cp agent.example.yaml agent.yaml   # y editar
go run ./cmd/erp-agent -config agent.yaml            # corre hasta Ctrl+C
go run ./cmd/erp-agent -config agent.yaml -once      # un ciclo, vacía la cola y sale
go run ./cmd/erp-agent -config agent.yaml -reconcile # fuerza una reconciliación completa al arrancar
go run ./cmd/erp-agent -version
```

Compilar el `.exe`: `CGO_ENABLED=0 go build -o erp-agent.exe ./cmd/erp-agent`.

Los logs salen por stderr, en JSON por defecto (`log.format: text` para leerlos a ojo). El heartbeat informa a la API la versión, la profundidad de la cola y el último error.

## Desarrollo

```
go build ./... && go test ./... && go vet ./... && gofmt -l .
```

Prueba contra el sandbox real de Saint (se omite si no hay variable):

```
SAINT_TEST_DSN='sqlserver://sa:<MSSQL_SA_PASSWORD codificada>@localhost:14330?database=SAINT_DEMO&encrypt=disable' \
  go test -count=1 -v ./internal/erp/saint/
```

## Estructura

| Paquete | Responsabilidad |
|---|---|
| `cmd/erp-agent` | punto de entrada y flags |
| `internal/erp`, `erp/mock`, `erp/saint` | modelo canónico, interfaz `Adapter` y sus implementaciones |
| `internal/delta` | hash, huellas y diff |
| `internal/batch` | construcción de lotes (delta y reconciliación) con la forma exacta del contrato |
| `internal/sync` | ciclo de sincronización (decide delta o reconciliación) |
| `internal/store` | SQLite: huellas, metadatos y cola (`outbox`) |
| `internal/api` | cliente HTTPS y clasificación de errores |
| `internal/sender` | vacía la cola con reintentos y backoff |
| `internal/config` | carga y validación del YAML |
| `internal/agent` | une todo: bucle de sync, sender y heartbeat |
