# internal/usecase

Orquestra agregados de domínio para realizar uma operação de negócio.

Cada arquivo = um caso de uso. Ex: `auth/login.go`, `processo/aprovar.go`.

Estrutura típica:
```go
type LoginUseCase struct {
    repo  usuario.Repository    // interface de domain
    hash  PasswordHasher        // interface deste pacote
    jwt   TokenIssuer           // interface deste pacote
}

type LoginInput struct {
    Email    string
    Password string
}

type LoginOutput struct {
    Token  string
    UserID int64
}

func (u *LoginUseCase) Execute(ctx context.Context, in LoginInput) (*LoginOutput, error)
```

Regras:
- Importa `internal/domain/`, define interfaces para infra
- Não conhece HTTP, GORM ou Gin
- Toda lógica que manipula múltiplos agregados ou efeitos colaterais (envio de email, cache invalidation) vai aqui
- Testes com fakes simples das interfaces (não precisa de mock framework)

Veja `REFACTOR_PLAN.md` na raiz.
