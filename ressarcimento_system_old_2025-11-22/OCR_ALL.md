# OCR_ALL

Servi?o FastAPI/Tesseract em `ocr_service/` exposto na porta 8000 (container `ocr`).
- Healthcheck: `GET http://localhost:8000/ping` (j? usado no compose).
- Backend usa `OCR_BACKEND_URL=http://ocr:8000` para `/api/v1/ocr/analyze` e `/api/v1/ocr/chat`.
- Requer pacotes tesseract/pt instalados na imagem (Dockerfile do servi?o).
