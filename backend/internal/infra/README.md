# internal/infra

Implementações concretas das interfaces declaradas em `internal/domain/` e `internal/usecase/`.

Subpastas:
- `persistence/` — repositórios GORM (implementam `domain.<x>.Repository`)
- `http/` — clientes HTTP externos (Ollama, OCR service, llama-agent)
- `scheduler/` — gocron / robfig/cron
- `email/` — gomail
- `auth/` — bcrypt hasher, JWT issuer (implementam interfaces de `usecase/auth`)

Regras:
- Pode importar `internal/domain/`, `internal/usecase/`
- **NUNCA** é importado por `domain` ou `usecase`
- Wire-up acontece em `cmd/api/main.go` e `cmd/worker/main.go`
- Testes de integração que precisam de DB real moram aqui

Veja `REFACTOR_PLAN.md` na raiz.
