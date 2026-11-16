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

### Identificação por quadro — `worker/engine/identificacao.py` (etapa 1, 16/11/2026)
- Roda dentro de `_rodar_pipeline_v3` (passo 2.65, antes do validador) e sobrescreve no `v2_out` os campos de
  identificação: distribuidora (+CNPJ, UF), UC/instalação, código do cliente, mês de referência, vencimento,
  total a pagar, nº da NF, emissão, dias faturados, grupo/subgrupo/modalidade. `PDF_PIPELINE_IDENT=0` desliga.
  Tudo que leu fica em `v2_out['_identificacao']` com a origem de cada valor.
- Três sinais, nesta ordem: rótulo em texto na mesma linha ("INSTALAÇÃO: 3920909", "DATA DE EMISSÃO:"), fonte
  grande no topo da página 1 (os quadros coloridos de UC, mês, vencimento e total têm rótulo desenhado, que
  nenhuma biblioteca lê, mas o valor em destaque é reconhecível pela forma), rótulo com valor abaixo/à direita.
  Dias = inteiro na linha das datas de leitura, ou diferença entre elas.
- Distribuidora pelo catálogo `distribuidoras.json` (raiz do CNPJ → nome canônico, UF, grupo, família de mapa):
  CNPJ completo do cabeçalho; senão dígitos 7-20 da chave de acesso NF3e (cabeçalho em imagem: Light, Brasília);
  senão alias/grupo + UF do endereço. Nunca mais a raiz usada para escolher o mapa (CPFL Paulista não é
  "Santa Cruz"). Raízes de cliente (33.041.260 Via Varejo) não entram no catálogo.
- Medido no gabarito visual (45 faturas com texto): distribuidora 45/45, UC 45/46, mês 45/45, vencimento 46/46,
  total 45/46, emissão 45/45, dias 41/41, grupo 44/44, modalidade 43/43. PDFs só imagem ficam `sem_texto`.
  `tests/conferir_identificacao.py` mede o módulo sozinho; `tests/conferir_gabarito.py` mede o pipeline inteiro.

### Medição por molde — `worker/engine/medicao.py` (etapa 2, 16/11/2026)
- Roda em `_rodar_pipeline_v3` (passo 2.66, depois da identificação) e lê a TABELA DE MEDIÇÃO da fatura
  pelas linhas posicionadas: medidor, grandeza, posto, leitura anterior, leitura atual, constante, consumo.
  Cada registro é validado pela física — energia: (atual − anterior) × K = consumo; demanda: atual × K (Enel SP)
  ou (atual − anterior) × K (Enel Rio). Só quando TODOS os registros de energia ativa fecham a medição é
  `validado` e sobrescreve as colunas (`_medicao['aplicar']`, lido em `atualizar_colunas_db._coleta_campos`):
  numero_medidor, constante_k, leit_ant/atu_ativa_ponta/fponta, consumo_ativo_ponta/fponta_kwh, kwh_total
  (= ponta + fora ponta + reservado), demanda_faturada/contratada_fponta_kw, medicao_grandezas_json (todos os
  registros, com `ok`/`calc`/`regra`). `PDF_PIPELINE_MEDICAO=0` desliga.
- Moldes: `enel` (cabeçalho "Medidor | Grandezas | Postos | Leitura Anterior | Leitura Atual | Const. | Consumo":
  Enel SP/Rio/Ceará, Light, Neoenergia, Equatorial), `cemig_a` (pág. "Demonstrativo de grandezas faturadas":
  leituras por segmento HFP/HP/HR, constantes, tabelas Energia/Demanda com Registrado/Contratado/Faturado),
  `cemig_b` ("Tipo de Medição | Medição | …"), `elektro` (medidor + constante numa linha, "CONSUMO ant atu" noutra,
  consumo no item CONSUMO TE/TUSD) e `generico` (qualquer linha "[medidor] grandeza/posto n1 n2 n3 [n4]" em que a
  física fecha: CPFL/RGE, Copel, Energisa PB/MT, Equatorial Goiás, EDP, Celesc, Amazonas — este com atual antes
  da anterior). Linhas de itens (mês na descrição, R$, %, mais de 6 números) e histórico não entram.
- Perda de transformação: linha "PERDA DE TRANSF.- 2,5%" (Enel ML), razão constante embutida na coluna (Enel
  Rio: inferida), itens kWh com a mesma razão 1,005–1,10 sobre o medido (CPFL, EDP ML) ou percentual escrito no
  texto ("Perdas: 2.5", "PERDAS DE TRANSFORMAÇÃO / RAMAL: 2,50 %"). O consumo das colunas é o FATURADO
  (medido × fator); o medido fica em `_medicao['consumo_medido']`. Leituras iguais com consumo impresso e
  confirmado pelos itens (Coelba ML) valem pelos itens (`validado_por = 'itens'`).
- Demanda faturada: item de demanda da fatura (um só, ou o mais perto da medida); sem item, cativo = maior entre
  medida e contratada, mercado livre = medida; sem medida não se chuta. Contratada pelo rótulo
  ("Demanda - KW", "DEMANDA FORA PONTA - KW", "Demanda Contratada Única (kW):", "D. Ctda F.Pta:").
- Medido no gabarito visual de 48 faturas, pipeline inteiro (`tests/CONFERENCIA_VISUAL_2026-11-16_etapa2.md`):
  medidor 42/42, constante 39/39, leituras 39/40, consumo ponta 17/17, fora ponta 43/44, kWh total 43/48,
  demanda contratada 13/17, demanda faturada 12/16 (antes da etapa: leituras 0/40, constante 0/39, medidor
  11/42, fora ponta 15/44). Faltam só PDFs-imagem, o rateio de condomínio e as notas ACL de 6 páginas.
  `tests/conferir_medicao.py` mede o módulo sozinho.

### Leitura visual na VPS — `worker/engine/leitura_visual.py` (etapa 3, 16/11/2026)
- Para o que o motor determinístico não fecha (PDF só imagem — ~5.600 na base — ou gate `reprovado`, ~4.400):
  o cron `worker/job_leitura_visual.sh` (todo dia 04:30, teto `SURE_VISUAL_TETO`=300 faturas, tempo máximo
  `SURE_VISUAL_MAX_MIN`=300 min) baixa o PDF pelo `link_fatura`, renderiza até 3 páginas em PNG (150 dpi) e faz
  UMA chamada `claude -p --allowedTools Read` por fatura (assinatura do Claude Code da VPS, sem API paga) pedindo
  um JSON fixo: identificação, medição (registros da tabela de medição), demandas, itens, tributos, tipo de documento.
- O JSON passa pelas contas da fatura antes de virar coluna: medição = `medicao.validar` ((atual − anterior) × K =
  consumo, por registro); financeiro = soma dos itens = total a pagar; tributos = ICMS base × alíquota; identificação =
  mês válido, vencimento ≥ emissão, UC presente, distribuidora pelo CNPJ/alias do catálogo. Cada bloco só grava se fecha.
  Rateio, nota de comercializadora etc. saem como `outro` e nada é gravado.
- Cada tentativa fica em `FT_LEITURA_VISUAL` (id_fatura, tentativas, status ok/parcial/falhou/erro/outro/humano,
  resposta_json, validacao_json, colunas_json, antes_json, gravado). Duas falhas → `humano` (fila de revisão).
  Gravação em FATURA_DADOS_EXTRAIDOS DESLIGADA por padrão (`SURE_VISUAL_GRAVAR=0`): a rotina lê, valida e registra;
  com `=1` preenche SÓ colunas vazias (fonte_extracao='visual', extracao_modelo_revisor='claude-visual') e guarda os
  valores anteriores — `python leitura_visual.py desfazer <id>` volta. `fila` conta candidatas; `ler x.pdf` testa local.
- 2ª tentativa dirigida: quem não fechou tudo na 1ª é relido em 220 dpi com o pedido apontando os blocos e os motivos que
  não bateram (soma dos itens, ICMS base × alíquota, dígitos da medição). Regras herdadas do molde de texto: demanda
  faturada = item de demanda (um só, ou o mais perto da medida), leituras iguais com consumo confirmado item a item
  valem pelos itens (Coelba livre), perda de transformação só nos itens (razão constante 1,005–1,10 → faturado = item).
- Disjuntor: `SURE_VISUAL_MAX_ERROS_SEGUIDOS` (5) erros seguidos do `claude -p` (limite de uso, sessão) param a noite com
  rc 1 no painel de rotinas. Divergências: valor lido e validado ≠ valor já gravado fica em validacao_json.divergencias
  (nada é sobrescrito) — matéria-prima da etapa 4.
- Medido no gabarito visual (11 documentos de 9 layouts, assinatura local, com a 2ª leitura): NENHUM valor errado;
  distribuidora, UC, grupo, modalidade, dias, constante, medidor, ICMS, demanda contratada e faturada 100 %; consumo
  ponta 100 %, fora ponta 89 %; leituras 88 %; total 82 %; PIS/COFINS 89 % — o resto fica vazio (PDF-imagem sem medição
  conferível, Amazonas com itens incompletos); o rateio sai como `outro`. Relatório:
  tests/CONFERENCIA_VISUAL_2026-11-16_etapa3_leitura_visual.md. Uma chamada leva 40 a 90 s; 300 faturas ≈ 5 h.
- Limites medidos (16/11, antes do 1º deploy): (1) repetibilidade — 3 faturas lidas 3× cada: 76/76 campos idênticos, 17–35 s
  por leitura; (2) escaneadas reais — 7 PDFs só imagem baixados da base (Energisa S/SE, Enel SP, Equatorial MA amassada,
  Brasília, Enel CE, CPFL borrada, Coelba Azul), verdade conferida na imagem em `tests/gabarito_escaneadas.json`:
  identificação, medidor, leituras, constante, consumo, tributos e demandas 100 %, total 6/7 (Brasília com total zero por
  devolução); relatório `tests/CONFERENCIA_VISUAL_2026-11-16_escaneadas.md`. Achados: "sem texto" na base NÃO é PDF-imagem
  para as faturas da Claro (o caminho da Claro não guarda texto_plumber; o PDF tem 3–9 mil caracteres) — a rotina agora mede
  a camada de texto depois de baixar e marca `tem_texto` sem gastar chamada; PDFs protegidos por senha (Elektro) viram
  `erro` sem ir para a fila humana; "Consumo Reativo" era classificado como energia ativa e dobrava o consumo da Coelba
  Azul (corrigido em medicao.classificar_grandeza, goldens inalterados); medição que fecha na física mas não bate com
  nenhum item kWh da fatura não é gravada.

### Testes golden (CI) — `worker/engine/tests/`
- `worker/engine/extrair_fatura.py` → `extrair_campos(pdf_bytes)`: o mesmo caminho do `pdf_pipeline.py` para
  uma fatura com camada de texto (plumber → liteparse → bbox → extrator_v2 → cascata → complementos →
  coordenadas → validador → colunas SQL de `atualizar_colunas_db._coleta_campos`), **parando antes de gravar**.
  Sem banco, sem OCR (`PDF_PIPELINE_NO_OCR=1`), sem SEFAZ (`SKIP_SEFAZ=1`), sem LLM, sem enriquecimento
  pela origem (precisa de uid). Serve também para conferir uma fatura na mão: `python extrair_fatura.py x.pdf`.
- `tests/faturas/*.pdf` + `tests/golden/*.json`: fatura → campos esperados (mapa, layout, gate, score, nº de
  itens e todas as colunas). `python tests/golden_test.py` compara (números com tolerância de 0,005; sentinela
  `__SET_NULL__` = vazio) e sai com 1 se algo mudou; `--atualizar` regrava; `--so NOME.pdf` filtra.
- O golden é gerado no ambiente de `requirements-golden.txt` (versões fixas, sem Tesseract/img2table/gmft);
  gere e confira **nesse** ambiente, senão o CI vai divergir. O job `extracao-golden` do CI trava o deploy.
- Determinismo: o scorer de UC (`extrair_identificadores_scoring`) passou a percorrer os candidatos em
  ordem de posição no texto; antes era ordem de `set` (hash), e em empate a UC mudava a cada processo.

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
