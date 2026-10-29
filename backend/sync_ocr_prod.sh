#!/usr/bin/env bash
# Sincroniza o pacote do pipeline (ia/OCR_prod) para o build context do backend
# (backend/ocr_prod), pois ia/ NÃO está no git e o Docker só enxerga o context.
# Rode ANTES de `docker compose build backend`.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"          # .../ressarcimento_system/backend
SRC="$HERE/../ia/OCR_prod"
DST="$HERE/ocr_prod"
if [ ! -f "$SRC/_fase1_pipeline.py" ]; then
  echo "ERRO: não achei $SRC/_fase1_pipeline.py — gere ia/OCR_prod primeiro." >&2
  exit 1
fi
rm -rf "$DST"
cp -r "$SRC" "$DST"
# remove caches/saídas locais que não devem ir pra imagem
# (dirs de saída _fase1*, __pycache__, caches sefaz) — SEM tocar em _fase1_pipeline.py
rm -rf "$DST/__pycache__" "$DST"/_fase1 "$DST"/_fase1_coord "$DST"/_fase1_llm 2>/dev/null || true
rm -f "$DST"/_cache_sefaz.db "$DST"/*.pyc 2>/dev/null || true
test -f "$DST/_fase1_pipeline.py" || { echo "ERRO: _fase1_pipeline.py sumiu do destino!" >&2; exit 1; }
echo "OK: sincronizado $(ls -1 "$DST"/*.py | wc -l) módulos + dados para $DST"
