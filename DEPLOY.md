# Deploy/Operação

Este projeto roda com `docker-compose` integrando MySQL, Backend (Go), Frontend (Nginx) e OCR (FastAPI/Tesseract).

## Pré‑requisitos
- Docker e Docker Compose
- Preencher `backend/.env` a partir de `backend/.env.example` (não versionar `.env`)
- Volumes: `db_data` (MySQL) e `backend/uploads` (anexos)

## Passos (produção/staging)
1) Configurar variáveis de ambiente
   - Copie `ressarcimento_system/backend/.env.example` para `ressarcimento_system/backend/.env`
   - Defina: `JWT_SECRET`, `DB_APP_URL`, `DB_CONSULTA_URL`, SMTP/IMAP (se usados), `OPENAI_API_KEY` (se usar OCR/Chat), `CORS_ALLOW_ORIGINS`, `OCR_BACKEND_URL`
2) Subir serviços
   - Na pasta `ressarcimento_system/`: `docker compose up -d --build`
3) Healthchecks/validações
   - Backend: `GET http://localhost:8080/api/v1/healthz`
   - OCR: `GET http://localhost:8000/ping`
   - Frontend: `http://localhost`
4) Logs úteis
   - `docker compose logs -f backend`
   - `docker compose logs -f ocr`
   - `docker compose logs -f frontend`

## Timezone/Consistência
- MySQL inicia com `--default-time-zone=-03:00`
- Containers configurados com `TZ=America/Sao_Paulo`

## Persistência
- Anexos: mapeados em `./backend/uploads:/app/uploads`
- Banco: volume `db_data`

## Segurança
- Não versionar `.env` (use `.env.example`)
- Rotacione chaves/senhas quando for remover segredos de repositórios antigos

