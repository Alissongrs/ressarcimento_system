# BACKEND_ALL

Resumo do backend (Go/Gin) e integrações para operar e evoluir a API.

## Compose Oficial
- Arquivo: `ressarcimento_system/docker-compose.yml`
- Subir/atualizar: `docker compose up -d --build` (rodar dentro de `ressarcimento_system/`)
- Healthcheck: `GET http://localhost:8080/api/v1/healthz`
- Variáveis: use `backend/.env` a partir de `backend/.env.example` (não versionar segredos)

## Novidades
- Faturas selecionadas na criação de requisição:
  - Nova tabela: `FT_REQUISICOES_FATURAS` (vínculo id_requisicao → faturas escolhidas).
  - Endpoint de leitura: `GET /api/v1/requisicoes/:id/faturas` → `{ faturas: [...] }`.
  - Criação aceita `faturas` (JSON no multipart) com campos: `link`, `mes_ref`, `dt_vencimento`, `valor_total`.
- Swagger removido: rota `/swagger` e arquivos estáticos foram excluídos.

## Como Rodar Local
- Requisitos: Docker, Docker Compose
- Configurar `backend/.env` copiando de `backend/.env.example`
- Executar: `docker compose up -d --build`
- Ver logs/migrations: `docker compose logs -f backend`

## Estrutura
- Go 1.23 (multi‑stage + Alpine). `main.go` carrega `.env`, fixa timezone `America/Sao_Paulo` (requer `tzdata` no container), inicializa DB, agenda tarefas (`gocron`), monta `routes` e expõe `:8080`.
- DB: `database.InitDBs()` abre `DB_App` e opcional `DB_Consulta`. `docker/mysql/init/01-init.sql` cria `consultadb` quando necessário.
- Router: `routes/routes.go` define CORS, estáticos `/uploads` e `/swagger`, SSE público, grupo `/api/v1` com JWT e middlewares (`AuthMiddleware`, `AuthOrQueryToken`, `GestorMiddleware`, `RateLimit`).
- Router: `routes/routes.go` define CORS, estático `/uploads`, SSE público, grupo `/api/v1` com JWT e middlewares (`AuthMiddleware`, `AuthOrQueryToken`, `GestorMiddleware`, `RateLimit`).

## Migrações e seed
- `database/migrations.go` garante colunas/índices mínimos, tabelas (FEEDBACKS, prazos, alarmes), seed de canais e seed das etapas do Kanban.
- Coluna de descrição das etapas: padronizada como `etapa_descricao`. A migração cria a coluna se faltar e o seed usa `INSERT ... ON DUPLICATE` sobre ela. Isso evita erros 500 em ambientes que tinham `descricao`/mojibake.

## Handlers principais
- Processos: movimentação atualiza etapa/subetapa/relevância, grava deferimento/fluxo/faturamento/valor estimado/suspensão e registra histórico quando módulos mudam.
- Histórico: `/processos/:id/historico` agrega canais. Comentários são normalizados para corrigir mojibake (ex.: “CriaÃÃo da requisiÃÃo” → “Criação da requisição”).
- OCR: `/ocr/analyze` (OCR interno via `OCR_BACKEND_URL`) e `/ocr/chat` (proxy OpenAI com gate de concorrência e retry/backoff).
- Admin: planilha (bulk mover/comentário), prazos, alarmes, editor completo (processo + módulos).

## Novidades recentes
- “Aplicar em massa” (Admin Planilha): UI aplica Etapa/Subetapa/Comentário a todos os resultados filtrados, com filtro opcional por coluna do Kanban. Usa `POST /api/v1/admin/planilha/bulk-mover`.
- Links de anexos: frontend monta URL absoluta `.../uploads/<arquivo>`; backend expõe `/uploads` como estático.
- Editor: avisos em modal central com botão “Ok” (substitui toast no rodapé).

## Jobs
- IMAP (`IMAP_ENABLE=1`), verificação de pendências, e‑mails diários/semanais, prazos e resumos periódicos. Roda no fuso `America/Sao_Paulo`.

## Deploy e timezone
- Compose oficial: `ressarcimento_system/docker-compose.yml`
- Timezone: `TZ=America/Sao_Paulo` nos serviços e `--default-time-zone=-03:00` no MySQL.
- Variáveis: `DB_APP_URL`, `DB_CONSULTA_URL`, `JWT_SECRET`, `CORS_ALLOW_ORIGINS`, `OCR_BACKEND_URL`, `UPLOAD_DIR`, `SMTP_*`, `AUTO_ADVANCE_ENABLED`, `IMAP_ENABLE`.

## Uploads
- Volume: `./backend/uploads:/app/uploads`. A URL pública é `/uploads/<arquivo>` servida pelo backend/Nginx.

## Segurança/Segredos
- Não comitar `.env`. Use `backend/.env.example` como base e armazene segredos fora do VCS.
- Rotacione chaves/senhas ao migrar de ambientes que expuseram segredos.

## Observabilidade Rápida
- Health: `GET /api/v1/healthz`
- SSE: `/api/v1/alertas/stream`, `/api/v1/events`
