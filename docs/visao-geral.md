# Sistema de Ressarcimento — Visão Geral

## O que é

Sistema interno da **AM Energia** para gestão de processos de ressarcimento de energia elétrica.
Permite abrir, movimentar e acompanhar processos de cobrança indevida junto às concessionárias,
com suporte a análise de faturas, IA, OCR e alertas automáticos.

---

## Stack Tecnológica

| Camada | Tecnologia |
|--------|-----------|
| Frontend | React 18 + Vite + Tailwind CSS + Recharts |
| Backend | Go 1.22 + Gin + GORM |
| Banco principal | MySQL — Amazon RDS (`db_ressarcimento`) |
| Banco de faturas | MySQL — 179.127.27.122 (`sgeeasy_clientes_novo`) |
| IA / Chat | OpenAI API (GPT-4.1-mini) via Azure / direto |
| E-mail | Microsoft Graph API (Azure — `complaint@amee.com.br`) |
| Container | Docker + docker-compose |

---

## Estrutura de Pastas

```
ressarcimento_system/
├── backend/          → API Go (Gin)
│   ├── handlers/     → Controllers HTTP
│   ├── services/     → Lógica de negócio (e-mail, alertas, IA)
│   ├── routes/       → Registro de rotas
│   ├── database/     → Conexões DB + migrations
│   ├── middleware/   → Auth JWT, CORS, rate limit
│   ├── sse/          → Server-Sent Events (notificações real-time)
│   └── data/         → Prompts de IA, templates DOCX
├── frontend/         → React + Vite
│   ├── src/pages/    → Páginas da aplicação
│   ├── src/components/ → Componentes reutilizáveis
│   ├── src/services/ → Clientes de API
│   └── src/context/  → Auth, Theme
├── ia/               → Scripts Python (análise de faturas, OCR, batch)
├── scripts/          → Shell scripts (backup, utilitários)
└── docs/             → Esta documentação
```

---

## Variáveis de Ambiente (backend/.env)

| Variável | Descrição |
|----------|-----------|
| `DB_APP_DSN` | DSN MySQL do banco principal (RDS) |
| `DB_FATURAS_DSN` | DSN MySQL do banco de faturas |
| `JWT_SECRET` | Segredo para tokens JWT |
| `AZURE_CLIENT_ID` | ID do app Azure (e-mail) |
| `AZURE_CLIENT_SECRET` | Segredo Azure |
| `AZURE_TENANT_ID` | Tenant Azure |
| `OPENAI_API_KEY` | Chave OpenAI para IA/chat |
| `OPENAI_MODEL` | Modelo padrão (ex: gpt-4.1-mini) |

---

## Perfis de Usuário

| Perfil | Acesso |
|--------|--------|
| `admin` | Tudo |
| `gestor` | Tudo exceto configurações de sistema |
| `analista` | Processos + Kanban + AISURE |
| `solicitante` | Apenas os próprios processos |

---

## Build e Deploy

```bash
# Frontend
cd frontend
npx vite build          # gera dist/
docker-compose restart frontend

# Backend
docker-compose up --build -d backend

# Tudo junto
docker-compose up --build -d
```
