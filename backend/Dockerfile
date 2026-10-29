# Multi-stage build otimizado para o backend Go

# ====== Stage 1: Build ======
FROM golang:1.26-alpine AS builder

# Instala dependências de build
RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /app

# Cache de dependências (só redownload se go.mod/go.sum mudarem)
# Usa `go mod tidy` para resolver automaticamente novos deps + atualizar go.sum.
COPY go.mod go.sum ./
RUN go mod tidy && go mod download

# Copia código fonte
COPY . .

# Gera Swagger (swag) no build
RUN go install github.com/swaggo/swag/cmd/swag@latest && \
    /go/bin/swag init -g main.go -o docs

# Build otimizado (binary menor e mais rápido)
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s -X main.Version=$(git describe --tags --always --dirty 2>/dev/null || echo 'dev')" \
    -trimpath \
    -o backend \
    .

# Binários da automação da Auditoria (rodados pelo cron via docker compose exec):
#   inconclusivos = motor F01-F05 gera a fila; auditados = rebuild do snapshot da página.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o auditados     ./cmd/auditados && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o inconclusivos ./cmd/inconclusivos && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o executor_solicitacoes ./cmd/executor_solicitacoes

# ====== Stage 2: Runtime ======
# python:3.11-slim (debian/glibc) em vez de alpine: o pipeline de extração
# (ia/OCR_prod) roda embutido via os/exec e suas deps (PyMuPDF/opencv/numpy) só
# têm wheels manylinux (glibc), NÃO musl. O binário Go é estático (CGO_ENABLED=0),
# então roda liso no debian slim.
FROM python:3.11-slim

# System deps: certs, tz, wget (healthcheck) + libs de runtime do opencv (libgl1,
# libglib2.0-0). tesseract é opcional (só p/ faturas escaneadas — ative com o ARG).
ARG INSTALL_TESSERACT=0
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates tzdata wget libgl1 libglib2.0-0 libgomp1 ffmpeg && \
    if [ "$INSTALL_TESSERACT" = "1" ]; then \
      apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-por tesseract-ocr-eng ; \
    fi && \
    rm -rf /var/lib/apt/lists/*

# Cria usuário não-root para segurança
RUN groupadd -g 1000 app && \
    useradd -u 1000 -g app -m -s /usr/sbin/nologin app

WORKDIR /app

# Copia binary do stage de build
COPY --from=builder --chown=app:app /app/backend /app/backend

# Binários da automação da Auditoria (cron)
COPY --from=builder --chown=app:app /app/auditados     /app/auditados
COPY --from=builder --chown=app:app /app/inconclusivos /app/inconclusivos
COPY --from=builder --chown=app:app /app/executor_solicitacoes /app/executor_solicitacoes

# Copia bundle de CA do RDS (se presente em certs/global-bundle.pem)
COPY --from=builder --chown=app:app /app/certs /app/certs

# Prompts da IA (prompt_confirmar_v19.txt, prompt_tese.txt, etc). Sem isso,
# /faturas/:id/analisar-v19 retorna "prompt v19 indisponível".
COPY --from=builder --chown=app:app /app/data /app/data

# ---- pipeline de extração/auditoria (ia/OCR_prod) ----
# OCR_prod = pacote autocontido do "cérebro" (20 módulos + map/ + mapas_manuais/ +
# templates_bbox/). Como ia/ NÃO está no git, sincronize p/ o build context ANTES:
#   cp -r ../ia/OCR_prod ./backend/ocr_prod     (ou script de build)
COPY --chown=app:app ocr_prod /app/ocr_prod
RUN pip install --no-cache-dir -U pip && \
    pip install --no-cache-dir --only-binary=:all: PyMuPDF==1.27.2.3 && \
    pip install --no-cache-dir -r /app/ocr_prod/requirements.txt && \
    pip install --no-cache-dir "edge-tts>=7,<8"
# edge-tts = voz neural feminina do chat (POST /api/v1/voz/falar)

# Handler Go lê PYTHON_PATH + FASE1_PIPELINE_PATH; SKIP_SEFAZ=1 no lote;
# PROMPT_CONFIRMAR_PATH aponta pro prompt já copiado em /app/data.
ENV PYTHON_PATH=/usr/local/bin/python \
    FASE1_PIPELINE_PATH=/app/ocr_prod/_fase1_pipeline.py \
    FASE1_LLM=1 \
    SKIP_SEFAZ=1 \
    PROMPT_CONFIRMAR_PATH=/app/data/prompt_confirmar.txt \
    OCR_LOTE_JOBS_DIR=/app/jobs_ocr_lote

# Cria diretórios necessários
# whatsapp_sessao: sessão do WhatsApp da empresa (volume próprio; NÃO fica em uploads, que é público)
RUN mkdir -p /app/uploads /app/jobs_ocr_lote /app/whatsapp_sessao && chown -R app:app /app && chmod 700 /app/whatsapp_sessao

# Usa usuário não-root
USER app

EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/api/v1/healthz || exit 1

CMD ["/app/backend"]
