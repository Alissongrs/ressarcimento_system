# SURE — Sistema Unificado de Ressarcimento

Sistema interno da AM Energia para o ressarcimento de energia e água: requisições, processos,
histórico, protocolos na ANEEL, prazos, deferimento, repasse, auditoria de faturas e relatórios.
Roda em `https://sure.app.br` (VPS Linux, Docker).

## Mapa das pastas

| Pasta | O que é | Vai para o Git? |
|---|---|---|
| `backend/` | API em Go (Gin + MySQL). Regra de negócio, rotas `/api/v1` e `/api/v2`, migrações aditivas no boot, agendador. | sim |
| `frontend/` | Interface em React + Vite + Tailwind. Telas em `src/pages/`, componentes em `src/components/`. | sim |
| `worker/` | Rotinas da VPS (cron): fila do chat (`claude -p`), executor de pedidos, extração de faturas, água, regras, ANEEL, backups. | sim |
| `extensao_aneel/` | Extensão do Chrome "SURE — ANEEL": consulta protocolos e preenche o Fale Conosco. O zip servido pelo site é gerado por `ferramentas/empacotar_extensao.py`. | sim |
| `docs/` | Documentação. Comece por `docs/tecnica/README.md`; a operação do dia a dia está em `docs/tecnica/12-runbook-operacao.md`. | sim |
| `docker/`, `docker-compose.yml`, `.github/` | Imagens, serviços (db, redis, backend, frontend) e o pipeline de CI/CD. | sim |
| `ferramentas/` | Utilitários de desenvolvimento (empacotar a extensão, correções de usinas). | sim |
| `ops/` | Operação fora do código: scripts pontuais, backups de correções, planilhas, binários. Veja `ops/README.md`. | **não** (só o README e o manifesto) |
| `ia/`, `ocr_service/`, `scripts/` | Subprojetos antigos de extração/OCR que rodam fora do deploy. | não |

Regra da casa: `backend/`, `frontend/` e `worker/` só têm código. Script que roda uma vez, backup
e planilha vão para `ops/`.

## Rodar local

Pré-requisitos: Go 1.22+, Node 20+, Python 3.11+, acesso ao banco (`backend/.env`, nunca versionado).

```powershell
# backend (porta 8080) — quem sobe é a pessoa, não o deploy
cd backend
go run .

# frontend (porta 5173, com proxy /api → 8080)
cd frontend
npm install
npm run dev
```

Testes e checagens que o CI também roda:

```powershell
cd backend;  go vet ./... ; go test ./... ; python scripts/gen_swagger_rotas.py
cd frontend; npm run lint ; npx vite build
```

## Deploy

O deploy é por GitHub Actions, na branch `dev`, com aprovação manual no job **Deploy VPS**:

```powershell
.\deploy.ps1      # commit + push, dispara o workflow, acompanha e pergunta "s" para aprovar
```

Passos completos, rollback, segredos e chave SSH: `docs/tecnica/11-github-cicd-deploy.md`.
Mudança de banco entra como linha em `backend/database/migrations_additive.go` (só aditivo) e
aplica sozinha no boot.

## Onde cada coisa é explicada

- Arquitetura, autenticação, modelo de dados, fluxo do processo: `docs/tecnica/00` a `04`.
- Motor de regras de faturas e pipeline de extração: `docs/tecnica/05` e `06`.
- Operação, cron, integrações (Graph, Drive, WhatsApp, ANEEL): `docs/tecnica/08` e `10`.
- O que fazer quando algo falha: `docs/tecnica/12-runbook-operacao.md`.
