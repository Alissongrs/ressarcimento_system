#!/usr/bin/env bash
# Baixa o bundle de CA global do AWS RDS para habilitar TLS verificado.
# Execute uma vez antes do build: bash certs/download-rds-bundle.sh
set -euo pipefail
DEST="$(dirname "$0")/global-bundle.pem"
curl -fsSL "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem" -o "$DEST"
echo "Salvo em: $DEST"
