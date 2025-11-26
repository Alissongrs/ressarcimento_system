# TESSERACT_ALL

Guia do Tesseract OCR e integrações usadas pelo serviço `ocr_service/`.

## Stack e Dependências
- SO: pacotes `tesseract-ocr`, `tesseract-ocr-por`, `tesseract-ocr-eng`, `poppler-utils`
- Python: `fastapi`, `uvicorn`, `pillow`, `pytesseract`, `pdf2image`, `pdfminer.six`, `python-multipart`

## Variáveis Úteis
- `TESSERACT_CMD`: caminho completo do binário do Tesseract (Windows/macOS)
- `POPPLER_PATH`: diretório do Poppler (Windows) para renderização de PDF → imagem
- `TZ`: `America/Sao_Paulo` para consistência de logs

## Compose Oficial
- Arquivo: `ressarcimento_system/docker-compose.yml`
- Serviço: `ocr` exposto em `8000:8000` com healthcheck (`GET /ping`)
- Backend: configure `OCR_BACKEND_URL=http://ocr:8000`

## Notas
- Este serviço é independente do Swagger do backend; remoções de Swagger não impactam o OCR.

## Endpoints do Serviço
- `GET /ping` → healthcheck `{ ok: true }`
- `POST /analyze` (multipart):
  - `files[]` (PDF/PNG/JPG)
  - `instruction` (texto opcional)
  - `lang` (default `por+eng`)
  - `max_pages` (default 3 para PDFs imagem)
  - `apply_rules_flag` (0/1) e `rules` (CSV) para aplicar regras locais

## Estratégia de Extração
1) PDF: tenta extração nativa (pdfminer)
2) Fallback: renderiza páginas (pdf2image) e OCR por página (pytesseract)
3) Imagens: OCR direto (pytesseract)

## Dicas de Operação
- Ajuste `max_pages` conforme desempenho e tamanho de PDFs
- Teste `lang` específicos para melhorar acurácia (`por`, `eng` ou combinação)
- Mantenha `tesseract-ocr-por` e `tesseract-ocr-eng` atualizados
