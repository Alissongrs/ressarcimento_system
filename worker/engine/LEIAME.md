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

## 16/11/2026 — identificação por quadro (etapa 1 da captura de alto nível)

- `identificacao.py` + `distribuidoras.json`: distribuidora pelo CNPJ/chave NF3e (catálogo por raiz), UC, mês,
  vencimento, total, NF, emissão, dias e classificação lidos pelos quadros (rótulo em texto + fonte grande do
  cabeçalho). Ligado em `_rodar_pipeline_v3` (passo 2.65); `PDF_PIPELINE_IDENT=0` desliga.
- Régua: `tests/gabarito_visual.json` (48 faturas conferidas na imagem), `tests/conferir_identificacao.py`
  (módulo) e `tests/conferir_gabarito.py` (pipeline inteiro, a partir da saída de `extrair_fatura.py`).

## 16/11/2026 — medição por molde (etapa 2 da captura de alto nível)

- `medicao.py`: tabela de medição lida pelas linhas posicionadas e validada pela física ((atual − anterior) × K =
  consumo). Moldes `enel`, `cemig_a`, `cemig_b`, `elektro`, `generico`. Ligado em `_rodar_pipeline_v3` (passo 2.66);
  as colunas vêm de `_medicao['aplicar']` em `atualizar_colunas_db._coleta_campos`; `PDF_PIPELINE_MEDICAO=0` desliga.
- `python medicao.py fatura.pdf` mostra os registros e o que fechou; `tests/conferir_medicao.py` mede o módulo
  sozinho contra `tests/gabarito_visual.json`.

## 16/11/2026 — leitura visual na VPS (etapa 3 da captura de alto nível)

- `leitura_visual.py`: faturas sem texto ou reprovadas → PNG → `claude -p` (Read) → JSON → mesmas contas do motor →
  `FT_LEITURA_VISUAL`; só grava colunas vazias e só com `SURE_VISUAL_GRAVAR=1`. Cron `worker/job_leitura_visual.sh`
  04:30, teto 300/noite. `python leitura_visual.py ler fatura.pdf` testa local; `fila` mostra o estoque; `desfazer <id>`.
- `leitura_visual.py tem-texto-ids` / `tem-texto-marcar` + `worker/job_reprocessar_tem_texto.sh` (cron 10:30): faturas com
  texto que a base não guardou voltam ao pdf_pipeline com `--force` (ids da origem via uid), com backup.

## 17/11/2026 — OCR gratuito das faturas sem texto (no lugar da leitura visual automática)

- `ocr_itens.py`: RapidOCR (`rapidocr_onnxruntime`, CPU) → linhas posicionadas (`itens_rapidocr`) e texto corrido
  (`texto_rapidocr`), com cache da última fatura. `identificacao.itens_do_pdf` e `pdf_pipeline.extrair_ocr` usam
  quando `PDF_PIPELINE_NO_OCR` ≠ 1; sem o pacote, Tesseract. `python ocr_itens.py fatura.pdf` mostra as linhas.
- `medicao.aplicar_medicao`: no modo OCR só grava consumo confirmado pelos itens da fatura (posto a posto) e nunca a
  demanda contratada.
- `ocr_fila.py ids | marcar | resumo` + `worker/job_ocr_sem_texto.sh` (cron 20:00, 200/rodada): fila `FT_OCR_SEM_TEXTO`,
  ids da origem via uid, `pdf_pipeline --prod --force --id-file` com OCR ligado, backup antes.
- Cron da leitura visual (04:30) desligado; `leitura_visual.py rodar --teto N` continua como reserva manual.
