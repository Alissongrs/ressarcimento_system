# worker/claro_fila

Fila dos lotes (zips) da Claro na VPS. O backend monta esta pasta em `/app/claro_fila`, baixa nela os zips do
portal PDP (pedidos pela extensão do SURE) e o `worker/job_claro.sh` processa: extração → Google Drive → links.

- `ultimo_inicial.txt` — último lote que o PC (C:\claro_bf\done) já tinha processado antes da migração para a VPS
  (05/11/2026). O botão só baixa lotes mais novos que ele (ou que o último em `done/`).
- O resto (zips, `ex/`, `done/`, `failed/`, `claro.log`, `worker_vivo`) é gerado e fica fora do Git.
