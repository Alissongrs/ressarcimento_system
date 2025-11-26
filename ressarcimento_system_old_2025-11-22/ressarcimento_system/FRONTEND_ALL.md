# FRONTEND_ALL

SPA React (Vite) em `frontend/`, com proxy para backend local e uploads.

## Dev
- `cd frontend && npm install && npm run dev` (porta 5173). Proxy de `/api`, `/api/v1` e `/uploads` para `http://localhost:8080`.
- Use `VITE_API_BASE_URL` vazio/local para n?o apontar para sure.app.br.

## Build/Prod
- Container `frontend` no compose serve build est?tico via Nginx (`frontend/nginx.conf`): `/api/*` e `/uploads/*` v?o para `backend:8080`.

## P?ginas recentes
- Admin Editor: datas em formato `dd/mm/aaaa` (com hora opcional), carregando valores j? existentes e normalizando antes do POST.
- Detalhes da Requisi??o: mostra faturas selecionadas e anexos usando URL absoluta gerada por `makeUploadHref` (usa origem atual + `/uploads`).
- Requisi??o: formul?rio envia anexos via multipart e aceita sele??o de faturas no envio.

## Estilos/aliases
- Aliases em `vite.config.js` (+dedupe React), Tailwind + PostCSS, cache Vite em `node_modules/.vite_theme_fix`.
