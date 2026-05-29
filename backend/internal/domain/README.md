# internal/domain

Entidades e regras de negócio puras. **Não importa nada do projeto** (exceto outros pacotes de domain) e nada de framework (Gin, GORM).

Cada subpasta = um agregado raiz (DDD). Ex: `usuario/`, `processo/`, `requisicao/`.

Conteúdo típico de cada agregado:
- `<x>.go` — struct + métodos invariantes
- `repository.go` — interface do repositório (implementada em `internal/infra/persistence/`)
- `errors.go` — erros de domínio

Regras:
- Sem dependência de banco, HTTP, JSON
- Validações de invariantes vão aqui (ex: `email não pode ser vazio`)
- Testes unitários sem mocks de framework

Veja `REFACTOR_PLAN.md` na raiz para o cronograma de migração.
