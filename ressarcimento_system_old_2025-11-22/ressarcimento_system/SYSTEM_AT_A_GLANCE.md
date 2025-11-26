# SYSTEM-AT-A-GLANCE

Visão geral rápida do fluxo de ponta a ponta do sistema:

1. **Criação / atualização de Requisição e Processo**
   - Frontend (React) chama `/api/v1/requisicoes` e `/processos/:id/movimentar` com `FormData`.
   - Backend calcula se etapa/subetapa/relevância mudaram, atualiza `FT_PROCESSOS`, `FT_DEFERIMENTOS`, `FT_FLUXO_RESSARCIMENTO`, `FT_FATURAMENTO`, `valor_estimado` e sempre grava um registro em `FT_HISTORICO_MOVIMENTACOES` quando qualquer módulo muda (mesmo sem comentário).
   - Histórico visível no frontend via `/processos/:id/historico`.

2. **Kanban e Timeline**
   - `processos_repo.go` retorna dados agrupados por coluna (`DM_KANBAN_COLUNAS`, `DM_ETAPAS_PROCESSO`).
   - Frontend usa `kanban steps` e highlight no modal `DetalhesProcesso` para mostrar as etapas fixas com bolinhas conectadas.
   - Kanban rápido (GET `/api/v1/processos/kanban-fast`) fornece objetos com colunas/alertas/last move.

3. **OCR + Regras + IA**
   - Front `Ocr` page faz upload para `/api/v1/ocr/analyze` (form-data) com regras BANDEIRA/ICMS.
   - Backend repassa para `ocr_service` (FastAPI + Tesseract) se `OCR_BACKEND_URL` definido.
   - `/api/v1/ocr/chat` faz proxy para OpenAI com retries e fallback para `rulesService.interpretRule`.

4. **Jobs e SSE**
   - `gocron` agenda verificações de fluxo, prazos, envio de e-mails e processamento de resumos.
   - SSE (EventSource) em `/api/v1/alertas/stream` e `/events` mantém frontend atualizado.

5. **Dev/Deploy**
   - Compose: `db`, `ocr`, `backend`, `frontend` expostos em 3306, 8000, 8080 e 80.
   - Testes: `backend/handlers` contém alguns testes unitários; o frontend roda ESLint via `npm run lint`.
   - Variáveis: `JWT_SECRET`, `AUTO_ADVANCE_ENABLED`, `IMAP_ENABLE`, `CORS_ALLOW_ORIGINS`, `OCR_BACKEND_URL`, `SMTP_*`.
