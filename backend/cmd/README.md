# cmd/

Entrypoints de cada binário compilável.

Subpastas:
- `api/` — HTTP API server (substituirá `backend/main.go`)
- `worker/` — scheduler (gocron) — extraído do `main.go` atual

## Build

```bash
# API server
go build -o bin/api ./cmd/api

# Worker (scheduler)
go build -o bin/worker ./cmd/worker
```

## Docker

O Dockerfile suportará multi-target:
```dockerfile
ARG CMD=api  # ou worker
RUN go build -o /app/bin ./cmd/${CMD}
```

E `docker-compose.yml`:
```yaml
backend:
  build:
    args:
      CMD: api
backend-worker:
  build:
    args:
      CMD: worker
```

Durante a Fase 1 da migração (ver `REFACTOR_PLAN.md`), o `main.go` da raiz do `backend/` continua funcionando. `cmd/api/main.go` apenas chama o legado. Após Fase 6, o `main.go` antigo é removido.
