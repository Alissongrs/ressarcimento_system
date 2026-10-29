# 00 — Visão Geral

## O que é

O **SURE** é o sistema interno da **AM Energia** para gestão de **ressarcimento** —
recuperar junto às concessionárias valores cobrados indevidamente de clientes
(energia elétrica e, mais recentemente, água). O sistema:

1. **Extrai** dados de PDFs de faturas e os padroniza num banco único.
2. **Audita** essas faturas com um "motor de desvio" que aponta possíveis erros
   (fichas F01–F05 para energia, FA02 para água).
3. Transforma apontamentos em **requisições** e, depois de aprovadas, em
   **processos** formais acompanhados num Kanban até o ressarcimento ao cliente.
4. Oferece **relatórios**, **assistente de chat** e **ingestão de e-mails** das
   concessionárias.

## Stack tecnológica

| Camada | Tecnologia |
|--------|-----------|
| Frontend | React 18 + Vite, react-router, react-query, axios, recharts, @dnd-kit, ReactQuill |
| Backend | Go 1.24 + Gin + GORM (e `database/sql` cru) |
| Banco da aplicação | MySQL 8 — Amazon RDS (`db_ressarcimento`) |
| Banco origem de faturas | MySQL — `179.127.27.122` (`sgeeasy_clientes_novo`) |
| Extração/OCR | Python 3.11 — pdfplumber, liteparse, Tesseract, PyMuPDF |
| IA (extração em lote) | OpenAI (`gpt-4.1-mini`), tier vision experimental (gpt-5.4) |
| IA (serviço OCR on-demand) | Local (Ollama `llama3.1:8b`) ou OpenAI |
| Worker de chat | Claude Code headless (`claude -p`) na VPS |
| E-mail | Microsoft Graph API (Azure/Entra) |
| Cache/rate-limit | Redis 7 |
| Container / deploy | Docker + docker-compose; VPS Linux com cron |

## Estrutura de pastas (alto nível)

```
ressarcimento_system/
├── backend/              → API Go (Gin)
│   ├── main.go           → entrypoint, boot, scheduler
│   ├── routes/           → árvore de rotas + middleware global
│   ├── handlers/         → ~119 controllers HTTP (v1)
│   │   └── v2/           → "Controle de Processos v2" (writes transacionais)
│   ├── middleware/       → auth JWT, roles, CORS, rate-limit, gzip
│   ├── auth/             → JWT, link mágico
│   ├── database/         → conexões (sql + GORM), migrations aditivas
│   ├── services/         → e-mail (Graph), alertas, score, IA
│   ├── procedit/         → interpretação de pedidos em linguagem natural → ação
│   ├── repositories/     → acesso a dados (dashboard, histórico)
│   ├── sse/              → Server-Sent Events (push em tempo real)
│   ├── ocr_prod/         → pipeline de extração (pdf_pipeline.py) empacotado
│   ├── ocr_service/      → serviço HTTP de OCR (FastAPI)
│   ├── cmd/              → binários utilitários (auditados, relatorio_auditoria…)
│   └── migrations/       → baseline (golang-migrate, rodado manualmente)
├── frontend/             → React + Vite
│   └── src/{pages,components,services,context,hooks}
├── ocr_service/          → cópia do serviço OCR (FastAPI)
├── ia/                   → sandbox/cópia de trabalho dos scripts de extração
├── worker/               → jobs de VPS (cron): worker claude -p, água, pdf, backups
├── docker/               → init do MySQL, configs
├── docs/                 → documentação (este conjunto em docs/tecnica/)
└── docker-compose.yml
```

> ⚠️ **Três cópias quase-espelho** do pipeline de extração existem: `ia/` (sandbox,
> com backups/logs/venv), `backend/ocr_prod/` (**autoritativa**) e
> `backend/ocr_service/pdf_pipeline_deploy/essencial/`. Ao mexer no pipeline, use
> `backend/ocr_prod/` como fonte da verdade.

## Ambientes

- **Desenvolvimento (local):** o backend roda na máquina do time (porta 8080); o
  front via Vite. O banco pode ser o RDS (leitura) ou um MySQL local (compose).
- **Produção:** VPS Linux `~179.127.26.37`, Docker + docker-compose; agendamento
  por **cron do host** (`worker/crontab.sure`), não Task Scheduler. O RDS
  (`db_ressarcimento`) é compartilhado entre local e prod.

> Ver detalhes de deploy em [08 — Ops, infra e workers](08-ops-infra-workers.md).

## Perfis de usuário

Três papéis (ver [02 — Autenticação e perfis](02-autenticacao-e-perfis.md)):

| Perfil | Acesso |
|--------|--------|
| `solicitante` | Padrão / menos privilégio. Só o **Assistente** + abrir requisições e consultar. **Não altera** banco/processos. |
| `gestor` | Todo o fluxo de trabalho: requisições, processos, auditoria, e-mail, regras. |
| `admin` | Tudo, incluindo histórico global, métricas e edição do informativo. |

## Fluxo macro (visão de 10 mil pés)

```
   Fatura PDF (origem sgeeasy)
        │  pipeline de extração (Python + OCR + IA)
        ▼
   FATURA_DADOS_EXTRAIDOS  ──►  Motor de desvio (F01–F05 / FA02)
        │                              │ aponta erros
        │                              ▼
        │                       Auditoria (front)
        │                              │ gestor cria
        ▼                              ▼
   Relatórios            FT_REQUISICOES ──aprovar──► FT_PROCESSOS
                                                │  Kanban + movimentações
                                                ▼
                                   Deferimento → Repasse → Encerramento
                                                │
                                                ▼
                                   Ressarcimento ao cliente
```
