# BACKEND_ALL

Backend Go/Gin que atende a API REST/SSE, com uploads servidos em /uploads e sem Swagger (rota e pasta removidas).

## Como subir
- Entrar em `ressarcimento_system/` e executar `docker compose up -d --build`.
- Healthcheck: `GET http://localhost:8080/api/v1/healthz`.
- Vari?veis: copie `backend/.env.example` para `backend/.env` (n?o versionar segredos).

## Banco de dados
- MySQL 8 sobe no servi?o `db` (porta 3306). ? preciso carregar o dump/schema da produ??o para criar tabelas como `FT_PROCESSOS`, `FT_REQUISICOES`, `DM_USUARIO`, etc. sem isso a API retorna 500.
- DSNs j? apontam para `db` via `DB_APP_URL` e `DB_CONSULTA_URL` no compose.

## Rotas principais
- P?blico: `/api/v1/login`, `/api/v1/register`, `/api/v1/uc/:numero`, `/api/v1/uc/:numero/faturas`, `/api/v1/faturas-uc`, `/api/v1/healthz`.
- Autenticado: `/api/v1/requisicoes`, `/api/v1/requisicoes/:id`, `/api/v1/requisicoes/:id/faturas`, `/api/v1/requisicoes/:id/anexos`, `/api/v1/processos/kanban(-fast)`, `/api/v1/processos/:id/historico`, `/api/v1/fluxo-ressarcimento/:id`, `/api/v1/faturamento/:id`, `/api/v1/tipos-irregularidade` etc.
- Admin/Gestor: planilha (bulk), editor completo (`/api/v1/admin/editor/*`), prazos, alarmes, regras, tags, IA (`/api/v1/perguntar-ia`), OCR (`/api/v1/ocr/analyze` e `/api/v1/ocr/chat`).
- SSE: `/api/v1/alertas/stream`, `/api/v1/events`, `/api/v1/processos/:id/events` (CORS liberado por env `CORS_ALLOW_ORIGINS`).

## Uploads
- Servidos pelo pr?prio backend em `/uploads/*` com volume `./backend/uploads:/app/uploads`.
- Nginx e Vite tamb?m proxyam `/uploads` para `backend:8080`/`localhost:8080`.

## Jobs e config
- `database.RunMigrations()` garante colunas b?sicas e seeds; n?o cria tabelas faltantes.
- Timezone `America/Sao_Paulo` em todos os servi?os; MySQL com `--default-time-zone=-03:00`.
- IMAP desabilitado por padr?o (`IMAP_ENABLE=0`).

## Build/Deploy
- Dockerfile multi-stage (Go 1.23-alpine) gera bin?rio `/app/server`.
- Compose sem chave `version` para evitar warning do Docker 26+.
