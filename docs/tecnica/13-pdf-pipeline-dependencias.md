# pdf_pipeline — o que é preciso para rodar (deploy / crontab)

> Levantado em 13/07/2026. Objetivo: rodar o `pdf_pipeline` programado (cron) no host Linux
> para que novas faturas passem pelo motor F01–F05 e alimentem a `FATURA_DADOS_EXTRAIDOS`.

## 1. Onde fica (canônico)
```
ressarcimento_system/ia/Copia/essencial/pdf_pipeline.py
```
É a versão **mais nova/canônica** (20/06). As cópias `ia/essencial/` (antiga) e `ia/auditor/`
NÃO devem ser usadas. **Rode sempre de dentro de `Copia/essencial/`** (o código usa caminhos
relativos à própria pasta: ex. `MAPA_DIR = <pasta>/map`).

## 2. Como executar
```bash
cd ressarcimento_system/ia/Copia/essencial
python pdf_pipeline.py --prod --workers 8        # processa faturas novas, grava na tabela PROD
```
Flags úteis:
- `--prod`      → grava em `FATURA_DADOS_EXTRAIDOS` (sem a flag grava na `_COPIA`, que é o default).
- `--revalidar` → reprocessa o texto já salvo (sem baixar PDF de novo).
- `--force`     → reprocessa mesmo já validado.
- `--workers N` → paralelismo (ProcessPool).
- `--vtal`      → troca a origem de download para o banco VTAL (empresa 2025).
- `--empresa N` → restringe a uma empresa.

Controle da tabela destino também por env: `FDE_TABLE=FATURA_DADOS_EXTRAIDOS` (equivale a `--prod`).

## 3. Módulos Python locais (na própria pasta `Copia/essencial/`)

**Obrigatórios (o motor não sobe sem eles):**
`extrator_v2.py`, `extrator_v3.py`, `validacoes_fatura.py`, `extrator_complementar.py`,
`validador_fatura.py`, `atualizar_colunas_db.py`, `detector_layout.py`,
`extrair_texto_bbox.py`, `parsers_layout.py`, `gd_extractor.py`, `coord_layer.py`,
`pdf_cache.py`, `enel_ce_parser.py`, `especialistas.py`, `aplicar_mapa_distribuidora.py`,
`extrator_cooperativa.py`.

**Opcionais — import GUARDADO (try/except); ausência só degrada, não quebra:**
- `camada_4_5_oficial.py` + `camada_3_extracao.py` + `completar_vision_5_4.py` → camada de **vision**
  (só usada se `USAR_VISION=1`). Essas puxam `llm_fallback.py` no topo → se for usar vision,
  `llm_fallback.py` TEM que estar junto (hoje ele está só em `ia/essencial/`, não em `Copia/essencial/`).
- `aho_scoring.py`, `distribuidora_router.py` → **não existem no repo hoje**; imports são guardados,
  o pipeline degrada para regex. Não bloqueiam.
- `template_extractor.py`, `tributos_por_dist.py`, `validador_art300.py` → guardados; existem em
  `ia/essencial/`. Para fidelidade total (tributos por dist / Art.300), copie-os para a pasta.

> **Resumo:** para o **motor F01–F05** (o que você quer no cron), basta a pasta `Copia/essencial/`
> como está. Para vision + tributos + art300 completos, copie também de `ia/essencial/`:
> `llm_fallback.py`, `template_extractor.py`, `tributos_por_dist.py`, `validador_art300.py`.

## 4. Pastas de dados (dentro de `Copia/essencial/` — necessárias)
- `map/`            → mapas de extração por distribuidora (**usado sempre**, via `MAPA_DIR`).
- `mapas_manuais/`  → gold-standards por distribuidora.
- `templates_bbox/` → templates posicionais.
- `data/`, `gd_view/` → dados auxiliares.

## 5. O que NÃO precisa copiar (só ocupa espaço)
- `_faturas_celesc*`, `_faturas_coelba`, `_faturas_enel_ce`, `_faturas_light` → **PDFs de amostra** (~125 MB).
- `__pycache__/` → cache do Python.

## 6. Pacotes pip
Núcleo (motor): 
```
PyMuPDF            # import fitz
mysql-connector-python
pdfplumber
requests
pytesseract
Pillow             # import PIL
```
Fallbacks/opcionais (import guardado — instale se quiser cobertura máxima):
`liteparse`, `markitdown`, `pymupdf4llm`, `pypdfium2`, `gmft`, `img2table`, `urllib3`.

## 7. Dependência de sistema — Tesseract OCR
```bash
sudo apt-get install -y tesseract-ocr tesseract-ocr-por
```

## 8. Configuração / variáveis de ambiente
- **Bancos são HARDCODED no `pdf_pipeline.py`** — não precisa `.env` para o motor:
  - origem sgeeasy: `179.127.27.122 / sgeeasy_clientes_novo`
  - origem VTAL (`--vtal`): `179.127.26.89 / quivere_vtal`
  - destino: `db-acesso-ressarcimento...rds.amazonaws.com / db_ressarcimento`
- `FDE_TABLE` → tabela destino (default `FATURA_DADOS_EXTRAIDOS_COPIA`; use `FATURA_DADOS_EXTRAIDOS` p/ PROD, ou a flag `--prod`).
- `OPENAI_API_KEY` → **não é necessária** para o motor. (No deploy, o `completar_vision_5_4.py`
  foi ajustado para apenas **avisar** no import, em vez de `sys.exit` — então o pipeline sobe sem chave.)
  Só defina a chave real se for ligar a vision (`USAR_VISION=1`).
- Tesseract: `TESSERACT_EXE`, `TESS_TESSDATA`, `TESS_LANG=por`.

> Validado: importando os 20 módulos-núcleo + `pdf_pipeline` a partir da pasta de deploy, todos sobem OK.

## 12. Pasta de deploy pronta
Montei tudo o necessário (só o que roda, sem PDFs de amostra) em:
```
Docker/ia/pdf_pipeline_deploy/
  essencial/            <- 33 .py + map/ mapas_manuais/ templates_bbox/ data/ gd_view/
  requirements.txt
  rodar.sh              <- roda as 40 empresas (--prod --workers 12); VTAL/2025 comentado à parte
```
Tamanho ~2,8 MB. Inclui os 4 módulos que faltavam na `Copia/essencial` (copiados de `ia/essencial`:
`llm_fallback`, `template_extractor`, `tributos_por_dist`, `validador_art300`).

## 13. Segundo job — materializar os apontamentos do sgeeasy (cron separado)
No deploy também vão:
- `essencial/atualizar_sgeeasy_apontamentos.py` → roda a query F01–F05 no sgeeasy e grava:
  1. `apontamentos_desvio_origem` (apontados + `uid`) — limpa e re-materializa;
  2. `Faturas_Registradas_Cache` (espelho local das UCs apontadas — backup + gráfico).
  Reaproveita as credenciais hardcoded do `pdf_pipeline`. Flags: `--dryrun`, `--sem-espelho`.
- `essencial/sgeeasy_apontamentos.sql` → a query embutida (idêntica ao endpoint do backend).
- `rodar_sgeeasy.sh` → wrapper pro cron.

**Ordem sugerida no cron:** primeiro `rodar.sh` (pipeline atualiza a FDE), depois `rodar_sgeeasy.sh`
(re-materializa os apontamentos sgeeasy). Ex.:
```cron
0 3 * * * /caminho/pdf_pipeline_deploy/rodar.sh          >> /var/log/pdf_pipeline.log 2>&1
0 5 * * * /caminho/pdf_pipeline_deploy/rodar_sgeeasy.sh  >> /var/log/sgeeasy_apont.log  2>&1
```

## 9. Ajustes obrigatórios para Linux (o código tem caminhos Windows cravados)
```bash
export TESSERACT_EXE=/usr/bin/tesseract
export TESS_TESSDATA=/usr/share/tesseract-ocr/4.00/tessdata   # onde está o por.traineddata
```
Atenção: há `IMG_DIR = Path("C:/paddleocr/tmp")` e default do Tesseract em `C:\...` no código —
no Linux isso cria pastas com nome literal `C:`. Ideal ajustar `IMG_DIR` e os defaults do Tesseract
para caminhos Linux (ou exportar as envs acima antes de rodar).

## 10. Exemplo de crontab (Linux)
```cron
# roda todo dia às 03:00, grava em PROD, log em arquivo
0 3 * * * cd /caminho/ressarcimento_system/ia/Copia/essencial && \
  TESSERACT_EXE=/usr/bin/tesseract TESS_TESSDATA=/usr/share/tesseract-ocr/4.00/tessdata \
  FDE_TABLE=FATURA_DADOS_EXTRAIDOS \
  /caminho/venv/bin/python pdf_pipeline.py --prod --workers 8 >> /var/log/pdf_pipeline.log 2>&1
```

## 11. Recomendação prática de deploy
Copiar a pasta inteira `Copia/essencial/` **exceto** `_faturas_*` e `__pycache__`; e, para cobertura
total, acrescentar de `ia/essencial/`: `llm_fallback.py`, `template_extractor.py`,
`tributos_por_dist.py`, `validador_art300.py`. Manter o `backend/.env` acessível na árvore.
