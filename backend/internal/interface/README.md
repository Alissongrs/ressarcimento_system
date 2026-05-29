# internal/interface

Adapters que recebem requisições externas e delegam para usecases.

Subpastas:
- `http/` — handlers Gin (substituirão `backend/handlers/`)
- `middleware/` — middlewares HTTP (substituirão `backend/middleware/`)

Estrutura típica de handler:
```go
type LoginHandler struct {
    uc *auth.LoginUseCase
}

func (h *LoginHandler) Handle(c *gin.Context) {
    var in dto.LoginRequest
    if utils.BindAndValidate(c, &in) { return }

    out, err := h.uc.Execute(c.Request.Context(), in.ToInput())
    if err != nil { ... }

    c.JSON(200, dto.NewLoginResponse(out))
}
```

Regras:
- Handler é fino: parse input → chamar usecase → formatar response
- Tradução de erro de domínio para HTTP status code mora aqui
- Importa `internal/usecase/`, **nunca** `internal/infra/`
- DTOs (request/response) ficam aqui — não vazam para domain/usecase

Veja `REFACTOR_PLAN.md` na raiz.
