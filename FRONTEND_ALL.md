# FRONTEND_ALL

Resumo do frontend (Vite + React) e fluxos importantes.

## Compose Oficial
- Arquivo: `ressarcimento_system/docker-compose.yml`
- Subir/atualizar (na pasta `ressarcimento_system/`): `docker compose up -d --build`
- Frontend servido por Nginx em `http://localhost`

## Como Rodar Local (sem Docker)
- Requisitos: Node 20
- Instalar deps: `npm install` em `ressarcimento_system/frontend/`
- Rodar dev: `npm run dev` (proxy local não é necessário se usar Docker para o backend)

## Stack
- React 18 + Vite 7, Tailwind/PostCSS, ESLint (desabilitado no prebuild de Docker para não bloquear a imagem).
- `apiClient.js`: baseURL vazia e interceptor que força prefixo `/api/v1` para rotas relativas e injeta JWT. Em produção, Nginx faz proxy `/api` → backend.
- Theming via `data-theme` e variáveis CSS; `ThemeSwitcher` e persistência em `localStorage`.
- SSE para alertas via `alertaService`/`sseClient`.

## Rotas/Componentes
- Requisições (lista): cards com busca/agrupamento; modal mostra anexos e faturas. Ajustado para construir URLs absolutas de anexos (`toHref`) sob `/uploads/...`.
- Detalhes da Requisição: aprovar/rejeitar, classificar irregularidade, anexar arquivos; histórico com correção de mojibake nos comentários.
- Processos: detalhe/kanban, timeline com etapas fixas e sub‑etapas.
- Admin Planilha: substituição de comentários e nova seção “Aplicar em massa” (Etapa/Subetapa/Comentário) sobre os resultados filtrados, com filtro opcional por coluna do Kanban.
- Admin Editor: aviso em modal central com botão “Ok”.

## Faturas selecionadas
- Criação (Chat): envia faturas selecionadas junto com o formulário (`faturas` no FormData), para persistência pelo backend.
- Detalhes da Requisição: exibe seção “Faturas selecionadas” (dados vindos de `GET /api/v1/requisicoes/:id/faturas`) além das faturas sugeridas por UC/meses.

## Proxy/Nginx
- Frontend Nginx proxy:
  - `/api/` → `http://backend:8080/api/`
  - `/api/v1/` → `http://backend:8080/api/v1/`
  - `/uploads/` → `http://backend:8080/uploads/`
  - SPA fallback para `index.html`.

## Build/Deploy
- Em Docker, o build pula lint (`prebuild` ajustado) — use `npm run lint` no desenvolvimento.
- Variáveis de origem da API: `VITE_API_BASE_URL` (opcional). O `apiClient` funciona sem baseURL por trás do Nginx.

## SSE/Atualizações
- Stream de alertas via EventSource: `/api/v1/alertas/stream` e `/api/v1/events`
- O `apiClient.js` injeta JWT e normaliza URLs para `/api/v1/*`
