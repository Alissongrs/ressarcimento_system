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
- Encaminhamento `tem_texto` → pipeline determinístico (17/11): `worker/job_reprocessar_tem_texto.sh` (cron 10:30, até
  `SURE_REPROC_LIMITE`=300 por rodada, mesmo lock do pdf_pipeline, backup antes). `leitura_visual.py tem-texto-ids` mapeia
  FATURA_DADOS_EXTRAIDOS.uid → Faturas_Registradas_Cache.id (banco de origem, DB_FATURAS) e o job roda
  `pdf_pipeline.py --prod --force --no-ocr --id-file` (o `--revalidar` NÃO serve: usa o texto já salvo, que essas não
  têm); depois `tem-texto-marcar` → status `reprocessada`. Validado em dry-run com 2 faturas Claro/Piratininga.
- Correção da etapa 1 achada nesse teste: o liteparse parte a UC da CPFL em dois itens ("1.081" + ".866.036-84") e
  o cabeçalho pegava o Nº do medidor como UC; `_cabecalho` agora junta pedaços com gap < 3 px (gabarito: codigo_uc 45
  certo / 0 errado; golden B3_18650495 regravado — a UC inventada virou vazio).

### OCR gratuito das faturas sem texto — `worker/engine/ocr_itens.py` + `ocr_fila.py` (17/11/2026)
- Por que: a leitura visual por `claude -p` consome o limite de 5 h da assinatura (61 faturas esgotaram a janela);
  o cron dela (04:30) foi DESLIGADO e ela ficou como reserva manual (`leitura_visual.py rodar --teto N`). O caminho
  gratuito para PDF-imagem é o OCR local do próprio pipeline.
- Motor: **RapidOCR** (`rapidocr_onnxruntime`, modelos do PaddleOCR em ONNX, CPU, sem GPU, sem limite; ~40 s por
  fatura). Lê a fonte pequena da tabela de medição que o Tesseract não lê. `ocr_itens.itens_rapidocr(pdf)` devolve as
  linhas posicionadas (mesmo formato do liteparse) e `texto_rapidocr(pdf)` o texto corrido (uma string por linha
  visual); a última fatura fica em cache pelo sha1, porque três pontos pedem o mesmo PDF. Sem o pacote (ou
  `SURE_OCR_MOTOR=tesseract`) tudo cai no Tesseract de sempre.
- Onde entra (só quando `PDF_PIPELINE_NO_OCR` ≠ 1): `identificacao.itens_do_pdf` (quando o liteparse/PyMuPDF trazem
  menos de 15 itens na 1ª página → `ULTIMA_FONTE="ocr"`, que afrouxa a tolerância de linha da medição para 3,5 pt) e
  `pdf_pipeline.extrair_ocr` (texto_ocr → itens da fatura pelo extrator_v2). `SURE_OCR_PAGINAS` (default 3).
- **Trava do modo OCR** (`medicao.aplicar_medicao`): a física não pega posto trocado (CPFL: ponta lida como fora ponta,
  tudo fechando) nem dígito errado que ainda feche; por isso, com `fonte="ocr"`, cada posto com consumo tem de bater
  com um item kWh da fatura, senão a medição NÃO é gravada (fica vazia, obs "OCR: consumo não confirmado pelos itens")
  e a demanda contratada (sem conferência nenhuma) nunca é gravada. Medidor e constante (física) gravam normalmente.
- Fila própria `FT_OCR_SEM_TEXTO` (criada por `ocr_fila.py` se não existir): quase todas as faturas sem texto já têm
  um `texto_ocr` antigo do Tesseract, então olhar `ocr_gerado_em` não serve. `ocr_fila.py ids` escolhe
  FATURA_DADOS_EXTRAIDOS com texto_plumber < 200 chars, gate fora de aprovado/revisao, link http, não visitada e não
  `tem_texto` (essas vão pelo job 9), mapeia uid → id da origem e grava status `fila`; `marcar` fecha com o
  gate/medidor/kWh de depois; `resumo` mostra o estoque (≈1.180 com link em 17/11: Claro 474, 359 204, 183 102…).
- Job `worker/job_ocr_sem_texto.sh` (cron 20:00, `SURE_OCR_LIMITE`=200/rodada ≈ 2 h 30, mesmo lock do pdf_pipeline,
  backup antes): instala o `rapidocr_onnxruntime` uma vez (pip --user, opencv headless + `--no-deps`), roda
  `pdf_pipeline.py --prod --force --id-file` SEM `--no-ocr` e marca a fila. Log em `worker/ocr_sem_texto.log` e no
  painel de rotinas (`ocr_sem_texto`).
- Medido nas 7 escaneadas reais (`tests/gabarito_escaneadas.json`, módulo): medidor 7/7, constante 6/6, leituras e
  consumo certos em 4/7 (Enel CE, Brasília, Equatorial MA, Coelba), 2 ilegíveis (vazio), 1 posto trocado (CPFL —
  barrado pela trava). Tesseract no mesmo lote: medição 2/7.

### Tributos por molde — `worker/engine/tributos.py` (etapa 2b, 17/11/2026)
- Toda distribuidora imprime o quadro de tributos do mesmo jeito: rótulo (ICMS, PIS/PASEP, COFINS) e, à direita,
  base, alíquota e valor — às vezes dentro de uma linha que também carrega colunas dos itens (Coelba, Energisa,
  CPFL, EDP, Enel). O molde acha o rótulo nas linhas posicionadas, toma os números à direita (até o próximo rótulo,
  ou na linha vizinha quando o rótulo fecha a linha) e só aceita o trio que fecha **base × alíquota = valor**
  (R$ 0,02 ou 0,5 %). Isento ("0,00 0,00") grava 0. OCR sem vírgula ("067", "8523") entra pela tentativa /100.
- Regras aprendidas no gabarito: rótulo precedido de "sem", "com", "isento", "cob.", "subvenção" é descrição de
  item, não tributo (Light "Demanda sem ICMS", CPFL "TUSD Com ICMS"); rótulo numa linha de cabeçalho ("(R$)",
  "Alíquota", "Base") é título de coluna e não puxa a linha vizinha; várias linhas por item + total → vale o
  total (base igual à soma das outras), só linhas por item (CPFL livre, créditos "20,77-") → soma; base não
  impressa ao lado (Light B "PASEP 1,25 1,15", CEMIG GD "COFINS 4,6445% 204,63") fecha quando a base implícita
  bate com a do outro tributo — PIS e COFINS têm a mesma base.
- Ligado em `_rodar_pipeline_v3` (passo 2.67); colunas `icms_valor/icms_base_calculo/icms_aliquota`,
  `pis_valor/pis_aliquota`, `cofins_valor/cofins_aliquota` vêm de `_tributos['aplicar']` em
  `atualizar_colunas_db._coleta_campos`, por cima do extrator antigo; `PDF_PIPELINE_TRIBUTOS=0` desliga.
  `python tributos.py fatura.pdf` mostra o que fechou.
- Medido (módulo, gabarito de 48 com texto): ICMS 36 certo / 0 errado / 8 vazio; PIS 43 / 0 / 2; COFINS 43 / 0 / 2.
  Vazios: Light A (só o valor impresso, sem base), ICMS por coluna de item sem linha de total (Elektro, CEMIG GD,
  Energisa GD, CPFL livre). Nas 7 escaneadas (OCR): ICMS 6/7, PIS 6/6, COFINS 5/6, nenhum errado — antes, pelo
  extrator antigo sobre o texto do OCR, 1/7, 2/7 e 2/7.
- Modo OCR (`_fonte_itens="ocr"`, marcado por `medicao.aplicar_medicao`): `atualizar_colunas_db` deixa vazias
  as colunas de consumo, leituras, demandas e tributos que não vieram de um molde com conferência
  (`OCR_SO_COM_CONFERENCIA`); o extrator antigo gravava kWh e tributo errados a partir do texto do OCR. Demanda
  faturada no modo OCR só por item da fatura (sem item, vazio).

### O extrator grava o impresso; a regra julga (17/11/2026)
- Princípio acertado com o usuário: usar a conta da fatura (física, base × alíquota) como PORTA de gravação escondia
  o erro da concessionária — o apontamento que o sistema existe para achar. Agora a conta só **escolhe entre
  leituras** (qual número é a base, qual linha é o total) e nunca decide se grava:
  - `tributos.py`: trio na posição do rótulo que não fecha é gravado igual, com `fecha=False` (texto exato) — a F39
    aponta. No OCR continua exigindo fechar (dúvida é de leitura, não da concessionária).
  - `medicao.py`: com texto exato e molde estrutural (enel/cemig/elektro), leituras, constante e consumo impressos
    entram mesmo quando (atual − anterior) × K ≠ consumo — a F01 aponta. Sem valores calculados: demanda faturada só
    de item impresso ou da linha "Demanda Faturada-kW" da tabela (nada de max(medida, contratada)); consumo não é mais
    multiplicado pela perda escrita no texto — a perda impressa (linha ou texto) vai para
    `perda_transformacao_percentual`; a inferida pelos itens fica só em observação.
- Goldens regravados: além das colunas de tributo, A_18649884 (Amazonas) passou a trazer o consumo medido 10.956 +
  perda 2,5 % em vez do faturado calculado 11.229,9; demanda faturada calculada saiu de 3 goldens (A_18651768,
  ML_18640885) e a impressa entrou (ML_18651965: 60,98 da linha "Demanda Faturada").

### Confiança por fontes — `worker/engine/confirmacao.py` (17/11/2026, sem fila humana)
- Em vez de pessoa, redundância: cada campo guarda quantas fontes independentes dizem o mesmo número.
  `extrator` (toda coluna preenchida), `fisica` (conta da fatura fechou), `itens` (consumo bate com item kWh),
  `historico` (consumo do mês na tabela de 13 meses), `dv` (dígito verificador da chave NF3e e do CNPJ), `origem`
  (sgeeasy `Faturas_Registradas_Cache`, mesma fatura pelo UID: leituras, constante, medidor, consumo, contratada,
  tributos, total, emissão, vencimento, dias, UC, chave, modalidade) e `anterior` (fatura anterior da UC na FDE:
  leitura anterior de hoje = leitura atual de lá; medidor, K, contratada, modalidade, UC iguais; pelo prefixo do uid
  e, se o prefixo mudou entre meses, por empresa + dígitos da UC).
- Fonte que diz outro valor fica em `divergente` — nada é sobrescrito. Passo 2.68 do pipeline (`cur` + linha da
  origem, que o SELECT da origem passou a trazer; `--revalidar`/sem linha busca pelo UID); `extrair_fatura.py --uid`
  liga as fontes de banco só leitura; goldens/CI só fontes internas. Coluna `confianca_json` (migração aditiva
  `{"n":{coluna: fontes}, "div":{coluna: {fonte: valor}}}`; gravação tolera a coluna ainda não existir).
- Motor (Go): `uFat.conf`, `confirmado(f, campos…)` e `nivelConf` — numa base extraída o achado volta a ser ERRO
  quando os campos que o sustentam têm ≥ 2 fontes; F39 deixou de pular o trio "colunas trocadas" quando ele está
  confirmado. Medido: Equatorial (OCR) 17 campos com 2–3 fontes e 0 divergentes; Light/CEMIG (texto) 21–22; Copel
  acusou consumo ponta 67 ≠ 265 da origem e kWh total 67 ≠ 4.673 — erro de extração que antes passaria calado.
- Índice recomendado (o usuário cria à mão): `(cod_empresa, codigo_uc, mes_referencia)` na FDE, para a busca da
  fatura anterior por UC.

### Segunda leitura do OCR por recorte — `worker/engine/ocr_reforco.py` (17/11/2026)
- Só no modo OCR, quando a medição ou um tributo não fechou: recorta o quadro pelas âncoras que a 1ª leitura achou
  (cabeçalho "Leitura/Anterior/Atual/Const"; rótulos ICMS/PIS/COFINS), renderiza só ali em zoom 6
  (`ocr_itens.itens_recorte`) e lê de novo; o campo entra se a releitura fecha a conta. Passo 2.675;
  `PDF_PIPELINE_REFORCO=0` desliga. `python ocr_reforco.py fatura.pdf` mostra antes/depois.

### Modelo pago só na confiança baixa — `leitura_visual.py --fila confianca --motor openai` (17/11/2026)
- Teste em 3 escaneadas difíceis (relatórios `tests/CONFERENCIA_VISUAL_2026-11-17_openai_{nano,mini}_3escaneadas.md`):
  **gpt-5.4-nano inventa números que fecham na própria conta** (CPFL: ICMS 2.031,79 sobre base 11.287,69 × 18 %,
  real 2.791,94 sobre 15.510,79; tributos 0 certo / 2 errado) — descartado. **gpt-5.4-mini**: ICMS 3/3, emissão 3/3,
  medição inteira da Energisa (fora ponta 32.947,6 que o OCR não lê, confirmado pela origem); errou PIS/COFINS da CPFL
  (alíquota no lugar do valor) e um dígito do medidor da Enel SP. 6.000–6.800 tokens de entrada e 1.300–1.900 de saída
  por fatura de 3 páginas; US$ 0,75/M entrada e 4,50/M saída → ≈ US$ 0,013 por fatura (Batch: metade).
- Desenho (pedido do usuário: não substitui o sistema, só pega confiança baixa): `candidatas_confianca` escolhe faturas
  cujo `confianca_json` tem campo-chave (consumo, leituras, K, tributos, total, contratada) com n < 2, divergente ou
  ausente. O modelo lê a fatura inteira (mesmo prompt e validação da leitura visual; motor `chamar_openai`, chat
  completions com imagens em base64, resposta JSON) e vira a fonte "llm" em `integrar_confianca`: valor igual ao da
  base → n + 1; vazio na base → preenche só se a origem sgeeasy diz o mesmo ou, para leituras/constante/consumo, se a
  leitura fechou na física E bate com item kWh; diferente → divergência "llm". Nunca grava sozinho.
- `worker/job_llm_confianca.sh` (cron 11, de hora em hora às :15): `SURE_LLM_POR_HORA`=20 chamadas (era 10 até 20/11/2026), descontando as da
  última hora (FT_LEITURA_VISUAL, modelo `openai:gpt-5.4-mini`); tokens em `validacao_json.tokens`;
  `SURE_VISUAL_GRAVAR=0` só registra. Rotina `llm_confianca` no painel. Chave `OPENAI_API_KEY` do backend/.env.
- Custo: 1.000 faturas ≈ US$ 13–17 (1.000–1.300 chamadas com 2ª leitura); as 8.720 que não fecharam na base ≈ US$ 115
  (36 dias a 10/h); base inteira (190 k) ≈ US$ 2.470 — não compensa, as com texto já fecham sem modelo.

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
