# OTHERS_ALL

- Compose unificado em `docker-compose.yml` (db + backend + frontend + ocr), sem campo `version`.
- Diret?rio `docker/mysql/init/` recebe seeds/dumps opcionais para popular o banco ao subir.
- Uploads persistem em `backend/uploads/` via volume compartilhado.
- Swagger removido (pasta `backend/swagger` exclu?da e sem rota). Caso precise, gerar novamente fora do deploy.
