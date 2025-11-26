# TESSERACT_ALL

- O Tesseract roda dentro do servi?o `ocr` (FastAPI) e ? consumido pelo backend via `OCR_BACKEND_URL`.
- Idiomas: pt (ajuste no Dockerfile do `ocr_service` se precisar de outros).
- Front usa `/api/v1/ocr/analyze` para OCR de arquivos e `/api/v1/ocr/chat` para chat assistido.
