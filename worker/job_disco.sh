#!/usr/bin/env bash
# job_disco.sh — espaço em disco da VPS no painel de saúde das rotinas (rotina "disco", de hora em hora).
# Em 19/11/2026 o disco chegou a 100% (cache de build e imagens antigas do Docker) e backup/OCR falharam calados.
# Uso acima do limite (SURE_DISCO_LIMITE, padrão 85 %) registra a execução como erro: o monitor do backend
# avisa a pessoa configurada e avisa de novo quando voltar ao normal. Só lê; não apaga nada.
. "$(dirname "$0")/rotina_lib.sh"
LIMITE="${SURE_DISCO_LIMITE:-85}"
read -r USO LIVRE TOTAL < <(df -P -h / | awk 'NR==2{gsub("%","",$5); print $5, $4, $2}')
DOCKER=""
command -v docker >/dev/null 2>&1 && DOCKER="$(docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null \
  | awk '/Images/{i=$2} /Build Cache/{c=$3} END{if(i!="") printf "; Docker: imagens %s, cache de build %s", i, c}')"
RESUMO="${USO}% usado, ${LIVRE} livres de ${TOTAL}${DOCKER}"
if [ -n "$USO" ] && [ "$USO" -ge "$LIMITE" ]; then
  rotina_registrar disco 1 "disco acima de ${LIMITE}%: ${RESUMO}. Limpar: docker builder prune -af"
  exit 1
fi
rotina_registrar disco 0 "$RESUMO"
