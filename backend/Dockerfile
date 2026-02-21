# Multi-stage build otimizado para o backend Go

# ====== Stage 1: Build ======
FROM golang:1.24-alpine AS builder

# Instala dependências de build
RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /app

# Cache de dependências (só redownload se go.mod/go.sum mudarem)
COPY go.mod go.sum ./
RUN go mod download && go mod verify

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

# ====== Stage 2: Runtime ======
FROM alpine:3.19

# Instala apenas certificados e timezone data
RUN apk add --no-cache ca-certificates tzdata && \
    update-ca-certificates

# Cria usuário não-root para segurança
RUN addgroup -g 1000 app && \
    adduser -D -u 1000 -G app app

WORKDIR /app

# Copia binary do stage de build
COPY --from=builder --chown=app:app /app/backend /app/backend

# Cria diretórios necessários
RUN mkdir -p /app/uploads && chown -R app:app /app

# Usa usuário não-root
USER app

EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/api/v1/healthz || exit 1

CMD ["/app/backend"]
