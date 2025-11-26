# OCR_ALL

Resumo do serviço de OCR (`ocr_service/`) e como integrá-lo.

## Compose Oficial
- Arquivo: `ressarcimento_system/docker-compose.yml`
- Serviço: `ocr` exposto em `8000:8000`
- Healthcheck: `GET http://localhost:8000/ping`

## Dicas Windows/macOS
- `TESSERACT_CMD`: caminho completo para o executável do Tesseract (Windows/macOS)
- `POPPLER_PATH`: diretório bin do Poppler (Windows) para pdf2image

## Stack
- FastAPI + Uvicorn
- Tesseract OCR (pacotes `tesseract-ocr`, `tesseract-ocr-por`, `tesseract-ocr-eng`)
- pdf2image (requer `poppler-utils`)
- pillow, pytesseract, python-multipart

## Endpoints
- `GET /ping` → `{ ok: true }` (health)
- `POST /analyze` (multipart)
  - Campos: `files[]` (imagens/PDFs), `instruction` (opcional), `lang` (default `por+eng`), `max_pages` (default 3, para PDFs imagem), `apply_rules_flag` (0/1), `rules` (CSV).
  - Retorno: `{ results: [ { file_name, raw_text, pages_used, instruction, rule_results? } ] }`.
  - PDF: tenta extração “nativa”; se vazio, renderiza páginas iniciais e faz OCR por página até `max_pages`.

## Variáveis
- `TESSERACT_CMD` (caminho do executável no Windows/Linux)
- `POPPLER_PATH` (diretório bin do Poppler no Windows)
- `PORT` (porta do Uvicorn; default 5002 no modo standalone — em Docker, usa 8000)

## CORS
- Em desenvolvimento o CORS é liberado para `*`. Restrinja em produção se necessário.

## Docker
- Compose oficial: serviço `ocr` exposto em `8000`; `OCR_BACKEND_URL=http://ocr:8000` no backend.
- Certifique `tzdata` e timezone (`TZ=America/Sao_Paulo`) se precisar consistência de horários em logs.

## Notas
- Sem alterações recentes de rota. Integração segue via backend (proxy/forward) e não depende do Swagger.

## Endpoints
- `GET /ping` → `{ ok: true }`
- `POST /analyze` (multipart): `files[]`, `instruction`, `lang` (default `por+eng`), `max_pages` (default 3), `apply_rules_flag` (0/1), `rules` (CSV)
