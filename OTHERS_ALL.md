# OTHERS_ALL

Documentação transversal (infra, compose, conexões) que liga frontend e backend.

## Compose/Infra
- Compose oficial: `ressarcimento_system/docker-compose.yml` (executar dentro deste diretório).
- Serviços: `db` (MySQL 8), `ocr` (FastAPI/Tesseract), `backend` (Go), `frontend` (Nginx).
- Healthchecks: `db` (mysqladmin ping), `backend` (`/api/v1/healthz`), `ocr` (`/ping`).
- Timezone: `TZ=America/Sao_Paulo` nos containers e `--default-time-zone=-03:00` no MySQL.
- Volumes: `db_data:/var/lib/mysql` e `./backend/uploads:/app/uploads` para persistir anexos.
- Alpine: instale `tzdata` nos Dockerfiles quando preciso.

## Estrutura do Monorepo
- `backend/` (Go + Gin)
- `frontend/` (Vite + React + Nginx)
- `ocr_service/` (FastAPI + Tesseract)
- `docker/` (init de MySQL)

## Banco
- Tabelas: `FT_PROCESSOS`, `FT_REQUISICOES`, `FT_HISTORICO_MOVIMENTACOES`, `FT_DEFERIMENTOS`, `FT_FLUXO_RESSARCIMENTO`, `FT_FATURAMENTO`, `DM_*` (etapas, kanban, prazos, canais, tags).
- Seed de etapas: coluna usada é `etapa_descricao` (migração cria quando faltante) para evitar erros 500 em ambientes com schemas divergentes.
- Faturas selecionadas: `FT_REQUISICOES_FATURAS` vincula as faturas escolhidas na criação da requisição (`id_requisicao` → itens com `link`, `mes_ref`, `dt_vencimento`, `valor_total`).

## Conexões & Tokens
- JWT (HS256). Middlewares aceitam `Authorization: Bearer` e `?token=` (útil para SSE/EventSource).
- SSE: `/api/v1/alertas/stream`, `/api/v1/events`, `/api/v1/processos/:id/events`.

## OCR
- Serviço interno em `ocr_service` acessado por `OCR_BACKEND_URL` no backend.
- Endpoints: `/ping` e `/analyze` (multipart; PDF com extração nativa e fallback OCR; imagens PNG/JPG; aplica regras quando solicitado).

## Dicas de deploy
- Subir serviços: `docker compose up -d --build` dentro de `ressarcimento_system/`.
- Logs: `docker compose logs -f backend` (migrations/seed), `docker compose logs -f ocr` (OCR) e `docker compose logs -f frontend` (proxy).
- Se anexos abrirem sem barras (ex. `http:host:8080uploads...`), a UI monta `.../uploads/<arquivo>` automaticamente; confira `VITE_API_BASE_URL` apenas se usar domínio externo.
- Segredos: não versionar `.env` (use `backend/.env.example` como base e mantenha `.env` fora do VCS).
- Swagger: removido do backend; documentação via arquivos internos deste monorepo.

## Operação Segura
- Backups: volume `db_data` (MySQL) e pasta `backend/uploads`
- CORS: ajustar `CORS_ALLOW_ORIGINS` conforme domínios reais
