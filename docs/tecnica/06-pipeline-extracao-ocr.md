# 06 — Pipeline de Extração e OCR

Transforma **PDFs de faturas** em dados estruturados em `FATURA_DADOS_EXTRAIDOS`. Dois
subsistemas distintos:

- **(A) Pipeline em lote** — `backend/ocr_prod/pdf_pipeline.py` (~4.400 linhas). É o
  "happy path" que **preenche a FDE**.
- **(B) Serviço HTTP de OCR** — `ocr_service/app.py` (FastAPI). API on-demand usada pelo
  front (auditar uma fatura avulsa); **não** é o escritor em lote.

> ⚠️ `ia/` é cópia sandbox (backups/logs/venv). A autoritativa é `backend/ocr_prod/`.

## (A) Pipeline em lote — `pdf_pipeline.py`

### Fonte e destino
- **Origem dos PDFs:** links lidos direto de `sgeeasy_clientes_novo.Faturas_Registradas_Cache`
  (`DB_ORIGEM`, `179.127.27.122`). `--vtal` troca para `quivere_vtal` (empresa 2025).
- **Destino:** `FATURA_DADOS_EXTRAIDOS`. **Default = `FATURA_DADOS_EXTRAIDOS_COPIA`**
  (sandbox seguro); **`--prod`** aponta para a tabela real.

### Estágios por fatura
1. `baixar_pdf(url)` — baixa os bytes.
2. **Três extratores de texto em paralelo**, cada um grava sua coluna:
   - `extrair_plumber()` — pdfplumber → `texto_plumber`
   - `extrair_markdown()` — **liteparse** (primário, expõe spans x/y p/ a camada de
     coordenadas); markitdown só como fallback → `texto_markdown`
   - `extrair_ocr()` — **Tesseract** via PyMuPDF render → `texto_ocr`
3. Merge dos campos com prioridade **plumber > ocr > markdown** (`_merge_campos`).
4. **`_rodar_pipeline_v3()`** — núcleo de extração+validação: extrator_v2 → complementos
   → camada de coordenadas → preenchimento por LLM → gate do validador. Grava
   `extracao_raw_json` + colunas canônicas.
5. Persiste textos (`_gravar_textos_fde`) e campos (`gravar_dados_extraidos`); espelha
   campos da origem (`_gravar_mirror_origem`).

### OCR
- **Pipeline em lote: só Tesseract** (CPU). Substituiu PaddleOCR/CUDA. Render ~216 DPI;
  `TESSDATA_PREFIX` para modelos de idioma. `--no-ocr` desliga Tesseract + fallback.
- **Serviço HTTP:** Tesseract base + **PaddleOCR** opcional como fallback (`lang="pt"`,
  CPU). PDFs → imagens via poppler.

### LLM de extração
- **Lote:** OpenAI chat, `OPENAI_MODEL` default **`gpt-4.1-mini`** (fallback
  `gpt-4o-mini` em HTTP 400). Entry `extrair_via_gpt()`. O LLM é **aditivo/gated —
  nunca sobrescreve regex bom**.
  - `--llm-normaliza`: quando o score < mínimo (default 95), chama gpt-4o-mini no texto
    cacheado para preencher itens/tributos com gate Σitens≈total, e revalida.
  - **Tier vision (experimental):** `camada_4_5_oficial.py` — crop de bbox → PNG →
    gpt-5.4 + vision, N=2 self-consistency. ~$0,04/fatura. **Não** é o run diário padrão.
- **Serviço HTTP:** `ocr_service/llm_client.py` usa LLM **local** (Ollama `llama3.1:8b`)
  ou OpenAI.
- **Coerência:** `ocr_service/desvio_media.py` — desvio de consumo por UC com baseline
  móvel e MAD robusto (servido em `/ocr/desvio-media`). É detecção de desvio-média,
  distinta do validador de qualidade.

### Validador / gate de qualidade — `backend/ocr_prod/validador_fatura.py`
`validar_fatura_completa()` → `{score 0-100, gate: aprovado/revisao/reprovado, checks,
campos_faltantes}`. Checks ponderados (obrigatórios, soma_itens, tributos, histórico,
GD consistente, leitura, SEFAZ). Grava a coluna `validador_gate`.

### Parsers por distribuidora / layout
- **Detecção:** `detector_layout.py` casa assinaturas em `ia/mapas_manuais/MAPA_*.json`;
  grava `layout_template_id`.
- **Extratores determinísticos (R$0, ~100–300ms):** `extrator_v2.py` (TEXT→REGEX via
  `map/*.json` por distribuidora →TABLES →GD →audit), `extrator_v3.py` (cascata
  PyMuPDF→pdfplumber→img2table), `parsers_layout.py` (roteia por âncoras; valida medição
  só quando `(atu−ant)×K == consumo`), `extrator_complementar.py` (cliente, mês_ref,
  itens, tributos, histórico 13m), `gd_extractor.py` (GD/SCEE), `coord_layer.py`
  (reconstrução de tabelas colunares via spans do liteparse). Templates bbox por layout
  em `templates_bbox/*.json`.
- **SEFAZ (2ª fonte):** `consultar_nf3e_sefaz.py` — handler por UF (2 primeiros dígitos
  da chave de 44 díg.), cache SQLite permanente ("Modo C": 1ª chamada na rede, resto
  offline).

### Flags / modos (argparse)
| Flag | Efeito |
|------|--------|
| `--empresa N…` / `--id N…` / `--id-file` | escopo |
| `--prod` | escreve em `FATURA_DADOS_EXTRAIDOS` (senão `_COPIA`) |
| `--vtal` | troca origem para VTAL (empresa 2025) |
| `--no-ocr` | desliga Tesseract + fallback markitdown |
| `--revalidar` | re-roda **só** o estágio v3 sobre texto **já no banco** (sem baixar PDF) — aplica correções de código a faturas já extraídas; força `SKIP_SEFAZ=1` |
| `--auto-audit` (`--auto-audit-min-score` 95) | marca `auditado=1` quando gate=aprovado e score ≥ min (reversível via log) |
| `--llm-normaliza` | preenchimento por gpt-4o-mini para itens de baixo score |
| `--skip-processadas`, `--force`, `--dryrun`, `--workers N`, `--ordem`, `--extrator` | operação |
| `SKIP_SEFAZ` (env) | desliga chamadas SEFAZ síncronas → ~100× mais rápido |

### Gravação / idempotência
- Escrita = **`INSERT … ON DUPLICATE KEY UPDATE`**.
- **Dedup = `uid`** (único na FDE), vindo do `UID` da linha de origem (**não** recomputado
  pelo pipeline). Sem uid → linha ignorada. `fid` (id da origem) **não** é a chave.

## (B) Serviço HTTP de OCR — `ocr_service/app.py` (FastAPI)

Endpoints: `GET /ping`; `POST /ocr/upload`, `/ocr/analyze`, `/analyze`, `/ocr/quick`,
`/ocr/interpret`, `/ocr/interpret_json`, `/ocr/explain`, `/ocr/desvio-media`. Fazem
render → OCR → (interpretação LLM opcional) e devolvem JSON. É o backend das telas de
auditoria avulsa / OCR em lote do front.

> O serviço HTTP (Ollama/OpenAI local) e o pipeline em lote (OpenAI) são **subsistemas
> separados** que compartilham blocos de OCR.

## Pipeline Claro (separado)
`ocr_service/faturas_claro.py` — extrator em massa de faturas Claro (~695k), destino
`FATURA_CLARO_DADOS_EXTRAIDOS`, dedup por SHA. É um pipeline **à parte** do fluxo FDE
(mais uma ferramenta one-off/bulk). Front correspondente: `ConsultaClaro.jsx`.
