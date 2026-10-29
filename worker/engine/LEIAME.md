# engine/ — cópia do pdf_pipeline para a VPS

Atualizado em 20/10/2026 a partir de `ia/Copia/essencial`. O `job_pdf_pipeline.sh` usa esta
pasta automaticamente quando ela existe (senão cai em `ia/Copia/essencial` do repo).

Inclui as correções:
- total CEMIG = linha da bandeira (11/10)
- CIP/COSIP por linha (11/10)
- demanda faturada fora ponta Grupo A (15/10)
- links inválidos: 404/410/403/400/401 ou arquivo não-PDF vão para `FT_FATURA_LINK_INVALIDO`
  e o `--skip-processadas` pula enquanto o link na origem não mudar (20/10).
  `--retentar-links-invalidos` força nova tentativa.

O `.env` é achado subindo a árvore até `ressarcimento_system/backend/.env`.
Para atualizar de novo: copiar de `ia/Copia/essencial` os .py listados aqui e as pastas
`map/`, `mapas_manuais/`, `templates_bbox/`, `data/`.
