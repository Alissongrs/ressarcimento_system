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

## 13/11/2026 — motor inteiro no Git, senhas no `.env`, testes golden

- `pdf_pipeline.py`, `extrator_complementar.py` e `completar_vision_5_4.py` passaram a ler as conexões do
  `backend/.env` por `db_env.py` (`DB_APP_URL` destino, `DB_FATURAS`/`DB_FATURAS_URL` origem sgeeasy,
  `DB_VTAL` origem VTAL). Nenhuma senha no código; os três arquivos agora são versionados.
- `completar_vision_5_4.py` não encerra mais o processo no import quando falta `OPENAI_API_KEY`
  (a chave só é exigida ao chamar a vision).
- `extrair_fatura.py`: extração pura (PDF → campos) sem banco/OCR/SEFAZ/LLM — base dos testes golden.
- `tests/golden_test.py` + `tests/faturas/` + `tests/golden/`: cada fatura tem de dar os mesmos campos.
  Roda no CI (`extracao-golden`) com `requirements-golden.txt`. Para regravar: criar venv com esse
  requirements, `python tests/golden_test.py --atualizar`, conferir os valores e commitar.
- Scorer de UC determinístico (candidatos em ordem de posição no texto, não ordem de `set`).
