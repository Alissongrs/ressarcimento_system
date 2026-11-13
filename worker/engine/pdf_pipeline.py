"""
pdf_pipeline.py
---------------
Pipeline unificado: PDF → pdfplumber + markitdown + Tesseract OCR → FATURA_DADOS_EXTRAIDOS

ORIGEM dos links: sgeeasy_clientes_novo.Faturas_Registradas_Cache (179.127.27.122).
Lê DIRETO da origem — sync_faturas.py NÃO é mais usado.
DESTINO de gravação: db_ressarcimento.FATURA_DADOS_EXTRAIDOS.

Cada extrator salva em FATURA_DADOS_EXTRAIDOS sua propria coluna:
  texto_plumber   / plumber_gerado_em
  texto_markdown  / markdown_gerado_em   (gerado via biblioteca markitdown)
  texto_ocr       / ocr_gerado_em

O merge dos campos parseados tem prioridade: plumber > ocr > markdown.

Uso:
    python pdf_pipeline.py --empresa 14
    python pdf_pipeline.py --empresa 4 14 32       # múltiplas empresas
    python pdf_pipeline.py --empresa 14 --limite 20
    python pdf_pipeline.py --empresa 14 --force
    python pdf_pipeline.py --empresa 14 --dryrun
    python pdf_pipeline.py --empresa 14 --extrator plumber   # só plumber
    python pdf_pipeline.py --empresa 14 --extrator markdown  # só markdown
    python pdf_pipeline.py --empresa 14 --extrator ocr       # só OCR
    python pdf_pipeline.py --id 167770               # fatura específica
    python pdf_pipeline.py --id 167770 328211        # múltiplos ids
    python pdf_pipeline.py --id 167770 --force       # reprocessa
    python pdf_pipeline.py --empresa 14 --ASC        # processa mais antigos primeiro
"""

import argparse
import io
import logging
import os
TBL_FDE = os.environ.get("FDE_TABLE", "FATURA_DADOS_EXTRAIDOS_COPIA")  # CÓPIA: grava na tabela COPIA por padrão

import re
import sys
import time
from pathlib import Path

# Carrega variáveis do .env do backend (OPENAI_API_KEY, OPENAI_MODEL, etc.)
# Busca backend/.env subindo a árvore (funciona de ia/ ou de ia/Copia/essencial/).
_env_path = None
for _p in Path(__file__).resolve().parents:
    if (_p / "backend" / ".env").exists():
        _env_path = _p / "backend" / ".env"; break
if _env_path is None:
    _env_path = Path(__file__).resolve().parent.parent / "backend" / ".env"
if _env_path.exists():
    for _line in _env_path.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _, _v = _line.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

# OCR via Tesseract (CPU-only, estável). Substituiu o PaddleOCR/CUDA.
# O binário fica fora do PATH no Windows — aponta explicitamente se existir.
_TESS_EXE = os.getenv("TESSERACT_EXE", r"C:\Program Files\Tesseract-OCR\tesseract.exe")

# ─── Logging (antes de imports pesados) ──────────────────────────────────────
# Pasta de trabalho: C:/paddleocr no Windows (compat.); na VPS (Linux) fica ao lado do script.
# Pode ser trocada por PDF_PIPELINE_DIR.
_WORK_DIR = Path(os.getenv("PDF_PIPELINE_DIR") or ("C:/paddleocr" if os.name == "nt" else os.path.join(os.path.dirname(os.path.abspath(__file__)), "_work")))
_WORK_DIR.mkdir(parents=True, exist_ok=True)
_LOG_FILE = str(_WORK_DIR / "pdf_pipeline.log")

logging.getLogger().handlers.clear()
logging.basicConfig(
    level   = logging.INFO,
    format  = "%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt = "%Y-%m-%d %H:%M:%S",
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(_LOG_FILE, encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

for _noisy in ("ppocr", "paddle", "paddleocr", "pdfminer", "markitdown"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

# ─── Imports pesados ──────────────────────────────────────────────────────────

import fitz                        # PyMuPDF (OCR)
import mysql.connector
import pdfplumber
import requests
# NOTE: markitdown import movido pra dentro de extrair_markdown() porque o
# `from markitdown import MarkItDown` no top-level estava demorando ~20min
# em alguns ambientes (tentando inicializar deps de áudio/Azure).
# Lazy import: só carrega quando extrair_markdown() é chamado.
MarkItDown = None  # placeholder; populado em _carrega_markitdown()


def _carrega_markitdown():
    global MarkItDown
    if MarkItDown is None:
        try:
            from markitdown import MarkItDown as _MI
            MarkItDown = _MI
        except Exception as _e:
            # markitdown é só FALLBACK (liteparse é o primário). Se a instalação
            # estiver quebrada (ex.: openpyxl/OneDrive placeholder), não derruba o
            # run — segue com liteparse. Marca como False p/ não reimportar.
            log.warning(f"    [markitdown] indisponível ({_e}); seguindo só com liteparse")
            MarkItDown = False
    return MarkItDown or None

# Camada 4.5 — extracao em CASCATA: texto primeiro (barato), vision so se falhar
try:
    from camada_4_5_oficial import (
        extrair_itens_cascata as _extrair_itens_cascata_v45,
        gravar_itens_cobrados as _gravar_itens_cobrados_v45,
        gravar_metadados_fatura as _gravar_metadados_fatura_v45,
    )
    _CAMADA_45_DISPONIVEL = True
except Exception as _e:
    _CAMADA_45_DISPONIVEL = False

# NO_OCR: desliga TODO uso de OCR (Tesseract) — tanto o estágio [ocr] próprio
# quanto o fallback markitdown (que dispara OCR interno via docling e polui o
# stdout com "Document parser messages / Using Tesseract"). Ligado por --no-ocr
# ou env PDF_PIPELINE_NO_OCR=1. Setado como global à prova de workers (igual --prod).
# Útil pra lotes 100% text-layer (evita travar/poluir com paralelismo). NÃO use em
# lotes com faturas escaneadas — elas dependem do OCR pra ter qualquer texto.
NO_OCR = os.getenv("PDF_PIPELINE_NO_OCR", "") == "1"

# Parâmetros do Tesseract (motor de OCR — CPU-only).
#   TESS_ZOOM   : fator de render do PyMuPDF (3x ≈ 216 DPI; Tesseract gosta de DPI alto).
#   TESS_LANG   : idioma do traineddata (por = português).
#   TESS_CONFIG : flags do tesseract (psm 3 = segmentação automática de página).
TESS_ZOOM     = float(os.getenv("TESS_ZOOM", "3"))
TESS_LANG     = os.getenv("TESS_LANG", "por")
TESS_TESSDATA = os.getenv("TESS_TESSDATA", r"C:\paddleocr\tessdata")
TESS_CONFIG   = os.getenv("TESS_CONFIG", "--oem 1 --psm 3")
# O 'por.traineddata' não cabe no tessdata oficial (Program Files, sem permissão de
# escrita), então fica numa pasta local. O Tesseract acha os modelos via a env
# TESSDATA_PREFIX (passar --tessdata-dir no config falha: o pytesseract não trata
# aspas em paths, e o caminho chegaria com as aspas literais).
if TESS_TESSDATA and Path(TESS_TESSDATA).is_dir():
    os.environ["TESSDATA_PREFIX"] = TESS_TESSDATA

# Palavras que NUNCA são número de medidor (mesma lista de pipeline.py).
# Evita que termos como "Analógico", "Grandezas", "MEDIÇÃO" etc, capturados
# pelos regex de extração, sejam gravados como número de série do medidor.
_MEDIDOR_BLOCKLIST_PDF = frozenset({
    "grandezas", "grandeza", "medição", "medicao", "leitura", "anterior",
    "atual", "consumo", "constante", "ponta", "fora", "conjunto",
    "único", "unico", "postos", "tarifários", "tarifarios", "kwh",
    "enrg", "atv", "medidor", "n/a", "na", "n.a.",
    "analógico", "analogico", "digital", "eletrônico", "eletronico",
    "convencional", "inteligente",
    "sociedade", "secretaria", "faturamento", "cliente", "reservado",
    "empresa", "unidade", "consumidor", "endereço", "endereco",
})

logging.getLogger().setLevel(logging.INFO)

# ─── Conexões ────────────────────────────────────────────────────────────────
#
# Lê direto da origem (sgeeasy_clientes_novo) sem passar por sync_faturas.
# Garante que TODAS as faturas registradas no sgeeasy sejam vistas pelo pipeline,
# sem depender de um cursor incremental que pode ficar atrasado.

from db_env import conexao as _conexao_env  # lê backend/.env (sem senha no código)
DB        = _conexao_env("DB_APP_URL", connection_timeout=60)                    # destino: db_ressarcimento
DB_ORIGEM = _conexao_env("DB_FATURAS", "DB_FATURAS_URL", connection_timeout=60)  # origem: sgeeasy_clientes_novo
DB_VTAL   = _conexao_env("DB_VTAL", connection_timeout=60)                       # origem alternativa (--vtal): quivere_vtal

# ─── Tesseract OCR ────────────────────────────────────────────────────────────

IMG_DIR  = _WORK_DIR / "tmp"   # pasta de trabalho/tmp
IMG_DIR.mkdir(parents=True, exist_ok=True)

import threading as _threading

# Aponta o pytesseract pro binário do Tesseract (fora do PATH no Windows).
try:
    import pytesseract as _pytess
    if _TESS_EXE and Path(_TESS_EXE).is_file():
        _pytess.pytesseract.tesseract_cmd = _TESS_EXE
except Exception:
    pass

# Sinalizado por Ctrl+C (SIGINT). Workers checam no início e abortam cedo; o loop
# principal cancela os futures pendentes. Sem isso, o ThreadPoolExecutor.__exit__
# fazia shutdown(wait=True) e o processo só saía após o batch inteiro terminar.
# (Tesseract é thread-safe — cada chamada é um subprocess — então não há mais
#  lock de inferência: o OCR pode rodar em paralelo de verdade.)
_stop_event = _threading.Event()

# ─── Meses PT ────────────────────────────────────────────────────────────────

MESES_PT = {
    "JAN":1,"FEV":2,"MAR":3,"ABR":4,"MAI":5,"JUN":6,
    "JUL":7,"AGO":8,"SET":9,"OUT":10,"NOV":11,"DEZ":12,
}

# ─── Helpers ─────────────────────────────────────────────────────────────────

def _num(s) -> float | None:
    if not s:
        return None
    s = str(s).replace(".", "").replace(",", ".").strip()
    try:
        return float(s)
    except ValueError:
        return None

def _data_br(s: str):
    from datetime import date
    try:
        d, mo, y = str(s).strip().split("/")
        return date(int(y), int(mo), int(d))
    except Exception:
        return None

def _dt(s) -> str | None:
    """'DD/MM/YYYY' → 'YYYY-MM-DD' para MySQL."""
    d = _data_br(s) if s else None
    return d.strftime("%Y-%m-%d") if d else None

def _vazio(v) -> bool:
    if v is None:
        return True
    if isinstance(v, (int, float)) and v == 0:
        return True
    if isinstance(v, str) and v.strip() in ("", "0"):
        return True
    return False

def _campos_vazios() -> dict:
    return dict(
        # ── Identificação ─────────────────────────────────────────────────────
        numero_fatura        = None,
        numero_instalacao    = None,
        nome_cliente         = None,
        cpf_cnpj             = None,
        classe_consumidor    = None,
        subgrupo_tarifario   = None,
        modalidade_tarifaria = None,
        distribuidora        = None,
        grupo_tarifario      = None,
        tensao_fornecimento  = None,
        numero_medidor       = None,
        tipo_medicao         = None,

        # ── Período ───────────────────────────────────────────────────────────
        dt_leit_ant  = None,
        dt_leit_atu  = None,
        dt_proxima   = None,
        dt_emissao   = None,
        vencimento   = None,
        dias         = None,
        mes_ref      = None,

        # ── Leituras ativas ───────────────────────────────────────────────────
        leit_ant_p   = None,
        leit_atu_p   = None,
        leit_ant_fp  = None,
        leit_atu_fp  = None,

        # ── Leituras reativas ─────────────────────────────────────────────────
        leit_ant_reativa = None,
        leit_atu_reativa = None,

        # ── Leituras demanda ──────────────────────────────────────────────────
        leit_demanda_p  = None,
        leit_demanda_fp = None,

        # ── Constantes e relações ─────────────────────────────────────────────
        constante_p  = None,
        constante_fp = None,
        constante_k  = None,   # constante geral / multiplicador do medidor
        rtp          = None,   # relação de transformação de potencial

        # ── Consumo ───────────────────────────────────────────────────────────
        kwh_total    = None,
        kwh_fponta   = None,
        kwh_ponta    = None,
        kwh_reativo  = None,   # kVArh reativo total
        kwh_reativo_exc = None,  # kVArh reativo excedente
        kvar_reativo_exc = None, # kVAr demanda reativa excedente

        # ── Demanda ───────────────────────────────────────────────────────────
        demanda_fat_p  = None,  # demanda faturada ponta (kW)
        demanda_fat_fp = None,  # demanda faturada fora ponta (kW)
        demanda_cont_p  = None, # demanda contratada ponta (kW)
        demanda_cont_fp = None, # demanda contratada fora ponta (kW)

        # ── Fatores ───────────────────────────────────────────────────────────
        fator_carga   = None,
        fator_potencia = None,

        # ── Tarifas unitárias ─────────────────────────────────────────────────
        tarifa_te    = None,   # tarifa TE (R$/kWh sem ICMS)
        tarifa_tusd  = None,   # tarifa TUSD (R$/kWh sem ICMS)
        tarifa_kwh   = None,   # tarifa geral (fallback)
        tarifa_ponta = None,
        tarifa_demanda = None,
        preco_unit_c_trib = None,

        # ── Bandeira tarifária ────────────────────────────────────────────────
        tipo_bandeira  = None,   # VERDE / AMARELA / VERMELHA_P1 / VERMELHA_P2
        valor_bandeira = None,

        # ── Valores financeiros ───────────────────────────────────────────────
        total_rs       = None,
        rs_consumo     = None,
        rs_ponta       = None,
        valor_demanda  = None,
        valor_reativo  = None,
        valor_reativo_exc = None,
        valor_demanda_reativa_exc = None,
        cip            = None,
        valor_encargos = None,
        valor_outros   = None,

        # ── Encargos setoriais ────────────────────────────────────────────────
        valor_cde     = None,
        valor_proinfa = None,
        valor_ess     = None,

        # ── Tributos ──────────────────────────────────────────────────────────
        icms_base    = None,
        icms_aliq    = None,
        icms_valor   = None,
        pis_base     = None,
        pis_aliq     = None,
        pis_valor    = None,
        cofins_aliq  = None,
        cofins_valor = None,

        # ── Indicadores ──────────────────────────────────────────────────────
        ind_tarifa_social  = None,
        ind_cliente_rural  = None,
        ind_beneficio_fiscal = None,
        ind_mercado_livre  = None,
        ind_gd             = None,
        ind_leitura_real   = None,
        ind_leitura_estim  = None,
        ind_troca_medidor  = None,
        ind_revisao_fat    = None,
        ind_impede_leitura = None,

        # ── Geração distribuída ───────────────────────────────────────────────
        kwh_injet      = None,
        kwh_compensado = None,
        saldo_credito  = None,

        # ── Perda de transformação ────────────────────────────────────────────
        perda_transf_pct = None,

        # ── Histórico ─────────────────────────────────────────────────────────
        historico         = [],
        historico_demanda = [],
    )

# ─── Override determinístico da tarifa NEOENERGIA NF3e (Coelba/Celpe/Cosern) ──
# A extração genérica/LLM pegava PIS/COFINS como tarifa (ex.: tarifa_te=6,52=alíq
# COFINS%, tarifa_tusd=97,88=valor PIS R$). Neste layout o preço unit vem logo
# após a linha "Consumo-TUSD"/"Consumo-TE" (nº com ≥5 casas decimais).
# ASSINATURA DO LAYOUT = presença dos DOIS rótulos hifenizados (o cabeçalho
# "Coelba" costuma ser imagem, então NÃO dá pra detectar pelo nome). Só aplica
# quando acha ambos e o valor é plausível — não afeta outras distribuidoras.
_COELBA_PRECO5 = re.compile(r'^\s*(\d[\d.]*,\d{5,})\s*$')
def _coelba_tarifa_override(linhas: list[str]) -> dict:
    def preco_apos(rotulo_regex):
        for i, l in enumerate(linhas):
            if re.search(rotulo_regex, l, re.I):
                for j in range(i + 1, min(i + 8, len(linhas))):
                    m = _COELBA_PRECO5.match(linhas[j])
                    if m:
                        return _num(m.group(1))
        return None
    te = preco_apos(r'Consumo\s*[-–]?\s*TE\b')
    tusd = preco_apos(r'Consumo\s*[-–]?\s*TUSD\b')
    out = {}
    # exige AMBOS os rótulos (assinatura Neoenergia NF3e) + valor plausível
    if te is not None and tusd is not None:
        if 0 < te < 3:
            out["tarifa_te"] = te
        if 0 < tusd < 3:
            out["tarifa_tusd"] = tusd
    return out

def _coelba_tarifa_fitz(pdf_bytes) -> dict:
    """Extrai tarifa TE/TUSD da Coelba direto do PDF via fitz (PyMuPDF).
    NECESSÁRIO porque o texto_plumber PERDE a tabela de itens da Coelba — o fitz a
    captura. Usa o mesmo parser _coelba_tarifa_override sobre o texto do fitz.
    Só roda no caminho COM download (pdf_bytes disponível)."""
    if not pdf_bytes:
        return {}
    try:
        import fitz as _fitz
    except Exception:
        return {}
    linhas = []
    try:
        d = _fitz.open(stream=pdf_bytes, filetype="pdf")
        for pg in d[: min(2, d.page_count)]:
            linhas += pg.get_text("text").split("\n")
        d.close()
    except Exception:
        return {}
    return _coelba_tarifa_override(linhas)

# ─── Override tarifa Grupo B por COORDENADAS (fitz) — genérico ────────────────
# Cobre CPFL Santa Cruz/Piratininga (rótulo "Consumo Uso Sistema [KWh]-TUSD" /
# "Consumo - TE") além da Neoenergia. Corrige o bug em que a extração genérica pegava
# um VALOR de tributo (ex.: tarifa_te=11,44 = COFINS R$, tarifa_tusd=7,8) como tarifa.
# Lê a linha "Consumo...TUSD"/"Consumo...TE" e pega o PREÇO com tributos (≥4 casas),
# ignorando bandeira/adicional/vermelha/escassez/compensação/ANEEL/reativo/demanda.
# Coordenado (words agrupados por y) porque o plumber embaralha as colunas destes layouts.
# Só valores plausíveis de Grupo B (0<val<0.95) — o chamador ainda restringe a subgrupo B.
_BT_PRECO = re.compile(r'^\d[\d.]*,\d{4,}$')
_BT_BAD = re.compile(r'band|vermelh|amarel|verde|escass|hidric|adic|comp|aneel|ufer|reativ|demanda|patam|subven|ilumin', re.I)
def _tarifa_bt_fitz(pdf_bytes) -> dict:
    if not pdf_bytes:
        return {}
    try:
        import fitz as _fitz
    except Exception:
        return {}
    def _brf(s):
        try:
            return float(s.replace('.', '').replace(',', '.'))
        except Exception:
            return None
    te = tusd = None
    try:
        d = _fitz.open(stream=pdf_bytes, filetype="pdf")
        for pg in d[: min(2, d.page_count)]:
            rows = {}
            for x0, y0, x1, y1, w, *_ in pg.get_text("words"):
                rows.setdefault(round(y0 / 3), []).append((x0, w))
            for k in sorted(rows):
                row = [t[1] for t in sorted(rows[k])]
                line = " ".join(row)
                if not re.search(r'consumo|uso sistema', line, re.I):
                    continue
                precos = [_brf(t) for t in row if _BT_PRECO.match(t)]
                precos = [x for x in precos if x is not None and 0 < x < 0.95]
                if not precos:
                    continue
                val = precos[0]
                if re.search(r'TUSD', line, re.I) and not _BT_BAD.search(line.replace('TUSD', '')):
                    if tusd is None:
                        tusd = val
                elif re.search(r'\bTE\b', line, re.I) and 'TUSD' not in line.upper() and not _BT_BAD.search(line.replace(' TE', '')):
                    if te is None:
                        te = val
        d.close()
    except Exception:
        return {}
    out = {}
    if te is not None:
        out["tarifa_te"] = te
    if tusd is not None:
        out["tarifa_tusd"] = tusd
    return out

# ─── Parser por regex (funciona em texto limpo do plumber ou texto OCR) ──────

def parse_regex(linhas: list[str]) -> dict:
    """
    Parser compartilhado — aplica regex sobre o texto.
    Funciona melhor com texto limpo (plumber) mas também roda sobre OCR.
    """
    dados = _campos_vazios()
    texto = "\n".join(linhas)
    SEP   = r"[\s_]+"

    # ── Total a pagar — tentativas específicas primeiro; max() é último recurso ─
    # Prioridade 1: linha "TOTAL A PAGAR" ou "VALOR A PAGAR" na mesma linha
    for _pat_total in [
        r"TOTAL\s+A\s+PAGAR[^\n\d]*([\d\.]+,\d{2})",
        r"(?<!no\s)VALOR\s+A\s+PAGAR[^\n\d]*([\d\.]+,\d{2})",  # não casa "Incluído no valor a pagar" (bandeira CEMIG)
        r"VALOR\s+DO\s+DOCUMENTO[^\n\d]*([\d\.]+,\d{2})",
        r"Subtotal\s+Faturamento\s+([\d\.]+,\d{2})",
    ]:
        _m = re.search(_pat_total, texto, re.IGNORECASE)
        if _m:
            dados["total_rs"] = _num(_m.group(1))
            break
    # Prioridade 2: formato boleto (ENEL SP e similares) — "<COD_BARRAS> DD MMM YYYY VALOR"
    # O valor total aparece após a data de vencimento no header/rodapé do boleto, sem R$
    # Ex: "63022460 23 JAN 2020 4.973,08" ou "63022460 10070713 23 JAN 2020 4.973,08 ..."
    if not dados["total_rs"]:
        _meses_pt = r"(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)"
        _m = re.search(
            r"\d{5,}[\s\d]*\b(\d{2})\s+" + _meses_pt + r"\s+(\d{4})\s+([\d\.]+,\d{2})\b",
            texto, re.IGNORECASE)
        if _m:
            dados["total_rs"] = _num(_m.group(3))

    # max() como último recurso — só se nenhum padrão específico achou
    if not dados["total_rs"]:
        _totais = [_num(v) for v in re.findall(r"R\$\s*([\d\.]+,\d{2})", texto) if _num(v)]
        if _totais:
            dados["total_rs"] = max(_totais)

    # ── Vencimento ────────────────────────────────────────────────────────────
    for pat in [
        r"VENC\w*\s+(\d{2}/\d{2}/\d{4})",
        r"VENC\w*[\s\S]{0,30}?(\d{2}/\d{2}/\d{4})",
        r"PAGAR\s+(?:PREFERENCIALMENTE\s+\S+\s+)?(\d{2}/\d{2}/\d{4})",
    ]:
        m = re.search(pat, texto, re.IGNORECASE)
        if m:
            dados["vencimento"] = m.group(1)
            break

    # ── Data de emissão ───────────────────────────────────────────────────────
    m = re.search(r"DATA DE EMISS[AÃ]O\s*[:\-]?\s*(\d{2}/\d{2}/\d{4})", texto, re.IGNORECASE)
    if m:
        dados["dt_emissao"] = m.group(1)

    # ── Mês de referência ─────────────────────────────────────────────────────
    # Enel SP: "04/2026" standalone; genérico: "MÊS/ANO DE REFERÊNCIA: 04/2026"
    for _pat_mes in [
        r"(?:M[EÊ]S|REFER[EÊ]NCIA)[^\n:]{0,30}?:\s*(\d{2}/\d{4})",
        r"REFER[EÊ]NCIA[^\n:]{0,30}?(\d{2}/\d{4})",
        r"(?<!\d)(\d{2}/\d{4})(?!\d)",  # standalone MM/AAAA (último recurso)
    ]:
        _m = re.search(_pat_mes, texto, re.IGNORECASE)
        if _m:
            dados["mes_ref"] = _m.group(1)
            break

    # ── Datas de leitura + dias ───────────────────────────────────────────────
    m = re.search(
        r"\b(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{1,3})\s+(\d{2}/\d{2}/\d{4})\b",
        texto)
    if m:
        dados["dt_leit_ant"] = m.group(1)
        dados["dt_leit_atu"] = m.group(2)
        dados["dias"]        = int(m.group(3))
        dados["dt_proxima"]  = m.group(4)
    else:
        m = re.search(r"\b(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{1,3})\b", texto)
        if m:
            dados["dt_leit_ant"] = m.group(1)
            dados["dt_leit_atu"] = m.group(2)
            dados["dias"]        = int(m.group(3))

    if not dados["dt_leit_ant"]:
        m = re.search(r"Leitura Anterior\s*[:\-]?\s*(\d{2}/\d{2}/\d{4})", texto, re.IGNORECASE)
        if m:
            dados["dt_leit_ant"] = m.group(1)
    if not dados["dt_leit_atu"]:
        m = re.search(r"Leitura Atual\s*[:\-]?\s*(\d{2}/\d{2}/\d{4})", texto, re.IGNORECASE)
        if m:
            dados["dt_leit_atu"] = m.group(1)

    # ── Consumo kWh + RS + tarifa + preço unit ────────────────────────────────
    # Linha típica: "Consumo em kWh  KWH  4.018,00  1,132600  4.550,82  ...  0,882910"
    # plumber: linha intacta; OCR: pode quebrar
    m = re.search(
        r"Consumo em kWh[\s\S]{0,40}?KWH\s+([\d\.]+,\d+)"   # kwh
        r"\s+([\d,\.]{6,})"                                   # preco_unit_c_trib
        r"[\s\S]{0,80}?([\d\.]+,\d{2})"                       # rs_consumo
        r"[\s\S]{0,60}?(0,\d{5,6})\b",                        # tarifa_sem_imp
        texto, re.IGNORECASE)
    if m:
        dados["kwh_total"]         = _num(m.group(1))
        dados["preco_unit_c_trib"] = _num(m.group(2))
        dados["rs_consumo"]        = _num(m.group(3))
        dados["tarifa_kwh"]        = _num(m.group(4))
    else:
        m = re.search(
            r"Consumo em kWh[\s\S]{0,40}?KWH\s+([\d\.]+,\d+)"
            r"\s+([\d,\.]{6,})\s+([\d\.]+,\d{2})",
            texto, re.IGNORECASE)
        if m:
            dados["kwh_total"]         = _num(m.group(1))
            dados["preco_unit_c_trib"] = _num(m.group(2))
            dados["rs_consumo"]        = _num(m.group(3))

    # fallback tarifa: "0,XXXXXX" próximo à linha de consumo
    if not dados["tarifa_kwh"]:
        idx = texto.lower().find("consumo em kwh")
        if idx >= 0:
            m = re.search(r"\b(0,\d{5,6})\b", texto[idx:idx+400])
            if m:
                dados["tarifa_kwh"] = _num(m.group(1))

    # ── CIP ───────────────────────────────────────────────────────────────────
    m = re.search(
        r"Contrib\w*\s+de\s+[Il]lum\w*\s+Pub\w*\s+([\d\.]+,\d{2})",
        texto, re.IGNORECASE)
    if not m:
        m = re.search(r"\bCIP\b[\s:=]+([\d\.]+,\d{2})", texto, re.IGNORECASE)
    if m:
        dados["cip"] = _num(m.group(1))

    # ── ICMS / PIS / COFINS ───────────────────────────────────────────────────
    m = re.search(
        r"\bICMS\b" + SEP + r"([\d\.]+,\d+)" + SEP + r"([\d,\.]+)" + SEP + r"([\d\.]+,\d{2})",
        texto, re.IGNORECASE)
    if m:
        dados["icms_base"]  = _num(m.group(1))
        dados["icms_aliq"]  = _num(m.group(2))
        dados["icms_valor"] = _num(m.group(3))

    m = re.search(
        r"\bPIS(?:/PASEP)?\b" + SEP + r"([\d\.]+,\d+)" + SEP + r"([\d,\.]+)" + SEP + r"([\d\.]+,\d{2})",
        texto, re.IGNORECASE)
    if m:
        dados["pis_base"]  = _num(m.group(1))
        dados["pis_aliq"]  = _num(m.group(2))
        dados["pis_valor"] = _num(m.group(3))

    m = re.search(
        r"\bCOFINS\b" + SEP + r"([\d\.]+,\d+)" + SEP + r"([\d,\.]+)" + SEP + r"([\d\.]+,\d{2})",
        texto, re.IGNORECASE)
    if m:
        dados["cofins_aliq"]  = _num(m.group(2))
        dados["cofins_valor"] = _num(m.group(3))

    # ── Modalidade tarifária — define se duplica leituras ponta→fora-ponta ──
    # Convencional/Branca/Bifásico/Monofásico: 1 leitura única (NÃO duplicar).
    # THS Verde/Azul: ponta + fora-ponta separadas (duplicar é correto pra
    # fallback quando o regex pega só ponta).
    eh_convencional = bool(re.search(
        r"\b(Convencional|Branca|Bif[áa]sico|Monof[áa]sico)\b",
        texto, re.IGNORECASE,
    )) and not re.search(r"\bTHS[\s_]?(Verde|Azul)\b|\bTarifa\s+Hor[áa]ria\b",
                         texto, re.IGNORECASE)

    def _duplicar_para_fp():
        """Copia leitura_p para leitura_fp APENAS se a fatura tem segmentos
        separados (THS). Em Convencional, deixa NULL para o motor F05 não
        somar a leitura única duas vezes."""
        if not eh_convencional:
            dados["leit_ant_fp"] = dados["leit_ant_p"]
            dados["leit_atu_fp"] = dados["leit_atu_p"]

    # ── Leituras do medidor ───────────────────────────────────────────────────
    # "Energia ativa em kWh  Ponta  6508  6606  40  4018"
    m = re.search(
        r"Energia ativa em kWh\s*\n?\s*Pont[a]?\s+([\d\.]+)\s+([\d\.]+)\s+(\d+)\s+([\d\.]+)",
        texto, re.IGNORECASE | re.MULTILINE)
    if m:
        dados["leit_ant_p"]  = _num(m.group(1))
        dados["leit_atu_p"]  = _num(m.group(2))
        dados["constante_p"] = _num(m.group(3))
        if not dados["kwh_total"]:
            dados["kwh_total"] = _num(m.group(4))
        _duplicar_para_fp()

    if dados["leit_ant_p"] is None:
        m = re.search(
            r"Energia ativa em kWh\s*\n?\s*Pont[a]?\s+([\d\.]+)\s+([\d\.]+)\s+([\d\.]+)",
            texto, re.IGNORECASE | re.MULTILINE)
        if m:
            dados["leit_ant_p"]  = _num(m.group(1))
            dados["leit_atu_p"]  = _num(m.group(2))
            _duplicar_para_fp()
            if not dados["kwh_total"]:
                dados["kwh_total"] = _num(m.group(3))

    if dados["leit_ant_p"] is None:
        m = re.search(r"Ponta\s+(\d{4,6})\s+(\d{4,6})\s+(\d{3,5})\b", texto, re.IGNORECASE)
        if m:
            dados["leit_ant_p"]  = float(m.group(1))
            dados["leit_atu_p"]  = float(m.group(2))
            _duplicar_para_fp()
            if not dados["kwh_total"]:
                dados["kwh_total"] = float(m.group(3))

    # ── Energia injetada (soma dos itens) ──────────────────────────────────────
    injet = sum(
        _num(v) or 0
        for v in re.findall(
            r"Energia Atv Injetada.*?KWH\s+([\d\.]+,\d+)", texto, re.IGNORECASE)
    )
    if injet > 0:
        dados["kwh_injet"] = injet

    # ── Histórico (últimos 13 meses) ──────────────────────────────────────────
    hist = []
    for m in re.finditer(
        r"\b([A-Z]{3})/(\d{2})\s+([\d\.]+,\d+|[\d]{3,})\b", texto, re.IGNORECASE
    ):
        mes_str = m.group(1).upper()
        ano_2d  = int(m.group(2))
        if mes_str not in MESES_PT:
            continue
        kwh = _num(m.group(3))
        if kwh and kwh > 0:
            hist.append({"mes": MESES_PT[mes_str], "ano": 2000 + ano_2d, "kwh": kwh})

    seen = {}
    for h in hist:
        k = (h["mes"], h["ano"])
        if k not in seen or h["kwh"] > seen[k]["kwh"]:
            seen[k] = h
    dados["historico"] = sorted(seen.values(), key=lambda x: (x["ano"], x["mes"]))

    # ── CPFL Piratininga / layouts alternativos ───────────────────────────────
    # KWH via linha TUSD: "Consumo Uso Sistema [KWh]-TUSD JAN/21 13.800,000 kWh ..."
    if not dados["kwh_total"]:
        m = re.search(
            r"Consumo Uso Sistema\s*\[KWh\][-–]TUSD\s+\w+/\d+\s+([\d\.]+,\d+)\s*kWh",
            texto, re.IGNORECASE)
        if m:
            dados["kwh_total"] = _num(m.group(1))

    # Tarifa sem tributos da seção TARIFA ANEEL: "Consumo kWh  0,27175000  0,26180000"
    if not dados["tarifa_kwh"]:
        m = re.search(r"Consumo\s+kWh\s+(0,\d{5,8})\s+(0,\d{5,8})", texto, re.IGNORECASE)
        if m:
            dados["tarifa_kwh"] = _num(m.group(1))

    # Total Consolidado → icms_valor, icms_base, pis_valor, cofins_valor
    # "Total Consolidado  10.328,67  10.295,06  1.853,12  10.295,06  88,53  408,71"
    #  col: total_fatura  valor_op  icms_valor  base_pis  pis  cofins
    if not dados["icms_valor"]:
        m = re.search(
            r"Total\s+Consolidado\s+"
            r"([\d\.]+,\d{2})\s+([\d\.]+,\d{2})\s+([\d\.]+,\d{2})\s+"
            r"([\d\.]+,\d{2})\s+([\d\.]+,\d{2})\s+([\d\.]+,\d{2})",
            texto, re.IGNORECASE)
        if m:
            if not dados["total_rs"]:
                dados["total_rs"]     = _num(m.group(1))
            dados["icms_valor"]   = _num(m.group(3))
            dados["icms_base"]    = _num(m.group(4))
            dados["pis_valor"]    = _num(m.group(5))
            dados["cofins_valor"] = _num(m.group(6))

    # Alíquotas PIS e COFINS no cabeçalho da tabela: "PIS 0,86%"  "COFINS 3,97%"
    if not dados["pis_aliq"]:
        m = re.search(r"\bPIS(?:/PASEP)?\b\s+([\d,]+)%", texto, re.IGNORECASE)
        if m:
            dados["pis_aliq"] = _num(m.group(1))
    if not dados["cofins_aliq"]:
        m = re.search(r"\bCOFINS\b\s+([\d,]+)%", texto, re.IGNORECASE)
        if m:
            dados["cofins_aliq"] = _num(m.group(1))

    # ICMS alíquota (coluna "Aliq. ICMS" + valor numérico nas linhas)
    if not dados["icms_aliq"]:
        m = re.search(r"Aliq\w*\.?\s+ICMS\b[\s\S]{0,300}?\b(\d{1,2},\d{2})\b", texto, re.IGNORECASE)
        if m:
            dados["icms_aliq"] = _num(m.group(1))

    # Leituras via linha do medidor: "<medidor> Ativa <leit_atu> <leit_ant> <fator> <consumo> <dt_proxima>"
    # "401121763 Ativa 16702 16587 120,00 13.800 09/02/2021"
    if not dados["leit_ant_p"]:
        m = re.search(
            r"\d{6,}\s+Ativa\s+([\d\.]+)\s+([\d\.]+)\s+([\d,\.]+)\s+([\d\.]+)\s+(\d{2}/\d{2}/\d{4})",
            texto, re.IGNORECASE)
        if m:
            dados["leit_atu_p"]  = _num(m.group(1))
            dados["leit_ant_p"]  = _num(m.group(2))
            dados["constante_p"] = _num(m.group(3))
            if not dados["kwh_total"]:
                dados["kwh_total"] = _num(m.group(4))
            dados["dt_proxima"]  = m.group(5)
            # Fix D: só duplica P→FP em fatura THS (não convencional Grupo B)
            if not eh_convencional:
                dados["leit_atu_fp"] = dados["leit_atu_p"]
                dados["leit_ant_fp"] = dados["leit_ant_p"]

    # Datas de leitura atual e anterior no cabeçalho da tabela de medição
    # "Leitura  12/01/2021  14/12/2020  Fator  Consumo..."
    if not dados["dt_leit_atu"]:
        m = re.search(
            r"\bLeitura\b[\s\S]{0,30}?(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})",
            texto, re.IGNORECASE)
        if m:
            dados["dt_leit_atu"] = m.group(1)
            dados["dt_leit_ant"] = m.group(2)

    # CIP CPFL: "Contrib. Custeio IP-CIP Municipal JAN/21 33,61"
    if not dados["cip"]:
        m = re.search(
            r"Contrib\w*\.\s+Custeio\s+IP-CIP\s+\w+\s+\w+/\d+\s+([\d\.]+,\d{2})",
            texto, re.IGNORECASE)
        if m:
            dados["cip"] = _num(m.group(1))

    # rs_consumo CPFL = soma TUSD + TE (ignora bandeiras)
    # Linha: "Consumo Uso Sistema [KWh]-TUSD  ...  4.859,60  4.859,60  18,00  ..."
    # Linha: "Consumo - TE  ...  4.681,66  4.681,66  18,00  ..."
    if not dados["rs_consumo"]:
        tusd = te = None
        m = re.search(
            r"Consumo Uso Sistema\s*\[KWh\][-–]TUSD[\s\S]{0,100}?"
            r"\b([\d\.]{4,},\d{2})\s+[\d\.]+,\d{2}\s+\d+,",
            texto, re.IGNORECASE)
        if m:
            tusd = _num(m.group(1))
        m = re.search(
            r"Consumo\s*-\s*TE[\s\S]{0,100}?"
            r"\b([\d\.]{4,},\d{2})\s+[\d\.]+,\d{2}\s+\d+,",
            texto, re.IGNORECASE)
        if m:
            te = _num(m.group(1))
        if tusd and te:
            dados["rs_consumo"] = round(tusd + te, 2)

    # Histórico CPFL: "2021 JAN lllllll 13800 29"
    if not dados["historico"]:
        hist_cpfl = []
        for m in re.finditer(
            r"\b(\d{4})\s+([A-Z]{3})\s+l+\s+(\d{3,})\s+\d+\b",
            texto, re.IGNORECASE
        ):
            mes_str = m.group(2).upper()
            if mes_str not in MESES_PT:
                continue
            kwh_v = _num(m.group(3))
            if kwh_v and kwh_v > 0:
                hist_cpfl.append({"mes": MESES_PT[mes_str], "ano": int(m.group(1)), "kwh": kwh_v})
        if hist_cpfl:
            seen_cpfl = {}
            for h in hist_cpfl:
                k = (h["mes"], h["ano"])
                if k not in seen_cpfl or h["kwh"] > seen_cpfl[k]["kwh"]:
                    seen_cpfl[k] = h
            dados["historico"] = sorted(seen_cpfl.values(), key=lambda x: (x["ano"], x["mes"]))

    # ── Neoenergia / layouts com itens separados por Ponta e Fora Ponta ─────────
    #
    # Seção pode aparecer como:
    #   "Itens da Fatura", "Itens Faturados", "Discriminação da Fatura",
    #   "Descrição do Consumo", "Demonstrativo de Consumo", "Serviços e Encargos"
    #
    # Linha típica (Itens da Fatura):
    #   "Consumo Fora Ponta TE  KWH  17.965,657  0,389825  7.003,47  ...  0,301230"
    #    desc                   un   qty          preco      valor         tarifa_sem_icms(última col)
    #
    # Linha típica (Demonstrativo de Consumo):
    #   "Consumo Ativo Fora de Ponta  32.013,00  35.636,00  4,00000  8,00-  14.484,00"
    #    desc                          leit_ant    leit_atu   const   ajuste  kwh

    # ── KWH Fora Ponta (TE ou TUSD — mesma quantidade) ──────────────────────────
    # Aceita: "Consumo Fora Ponta TE", "Consumo Fora de Ponta TE",
    #         "Consumo FP TE", "Energia Ativa FP TE", etc.
    _FP = r"Consumo\s+(?:Ativo\s+)?(?:Fora\s+(?:de\s+)?Ponta|F\.?\s*P\.?)\s+TE"
    _PT = r"Consumo\s+(?:Ativo\s+)?(?:(?:Na\s+)?Ponta|P\.?\s*T\.?)\s+TE"

    if not dados["kwh_fponta"]:
        # Formato "Itens da Fatura": desc + KWH + qty + preco + valor + ...
        m = re.search(
            _FP + r"\s+KWH\s+([\d\.]+,\d+)"        # qty = kwh_fponta
                  r"\s+([\d,\.]+)"                   # preco_unit_c_trib
                  r"\s+([\d\.]+,\d{2})",             # valor_rs (FP TE)
            texto, re.IGNORECASE)
        if m:
            dados["kwh_fponta"]        = _num(m.group(1))
            dados["preco_unit_c_trib"] = dados["preco_unit_c_trib"] or _num(m.group(2))
            dados["rs_consumo"]        = dados["rs_consumo"] or _num(m.group(3))

    # ── KWH Ponta TE ─────────────────────────────────────────────────────────────
    if not dados["kwh_ponta"]:
        m = re.search(
            _PT + r"\s+KWH\s+([\d\.]+,\d+)"
                  r"\s+([\d,\.]+)"
                  r"\s+([\d\.]+,\d{2})",
            texto, re.IGNORECASE)
        if m:
            dados["kwh_ponta"] = _num(m.group(1))
            dados["rs_ponta"]  = dados["rs_ponta"] or _num(m.group(3))

    # ── RS Fora Ponta TUSD (soma ao rs_consumo FP TE já capturado) ───────────────
    # "Consumo Fora Ponta TUSD  KWH  17.965,657  0,153507  2.765,50  ..."
    _FP_USD = r"Consumo\s+(?:Ativo\s+)?(?:Fora\s+(?:de\s+)?Ponta|F\.?\s*P\.?)\s+TUSD"
    m = re.search(
        _FP_USD + r"\s+KWH\s+[\d\.]+,\d+"    # qty (já temos)
                  r"\s+[\d,\.]+"              # preco
                  r"\s+([\d\.]+,\d{2})",      # valor_rs TUSD
        texto, re.IGNORECASE)
    if m:
        rs_tusd = _num(m.group(1))
        if rs_tusd:
            dados["rs_consumo"] = round((dados["rs_consumo"] or 0) + rs_tusd, 2)

    # ── RS Ponta TUSD (soma ao rs_ponta) ─────────────────────────────────────────
    _PT_USD = r"Consumo\s+(?:Ativo\s+)?(?:(?:Na\s+)?Ponta|P\.?\s*T\.?)\s+TUSD"
    m = re.search(
        _PT_USD + r"\s+KWH\s+[\d\.]+,\d+"
                  r"\s+[\d,\.]+"
                  r"\s+([\d\.]+,\d{2})",
        texto, re.IGNORECASE)
    if m:
        rs_tusd_p = _num(m.group(1))
        if rs_tusd_p:
            dados["rs_ponta"] = round((dados["rs_ponta"] or 0) + rs_tusd_p, 2)

    # ── Tarifa sem ICMS (última coluna das linhas FP TE e Ponta TE) ──────────────
    # Formato: linha termina com "  0,301230" ou "  0,144583"
    if not dados["tarifa_kwh"]:
        m = re.search(
            _FP + r"[\s\S]{0,200}?\b(0,\d{4,8})\s*(?:\n|$)",
            texto, re.IGNORECASE | re.MULTILINE)
        if m:
            dados["tarifa_kwh"] = _num(m.group(1))
    if not dados["tarifa_ponta"]:
        m = re.search(
            _PT + r"[\s\S]{0,200}?\b(0,\d{4,8})\s*(?:\n|$)",
            texto, re.IGNORECASE | re.MULTILINE)
        if m:
            dados["tarifa_ponta"] = _num(m.group(1))

    # ── ICMS alíquota N/R (coluna "Alíquota ICMS N/R" — ex: 11,00) ──────────────
    if not dados["icms_aliq"]:
        m = re.search(r"Aliq\w*\.?\s+ICMS\s+N[/\\]?R[\s\S]{0,300}?\b(\d{1,2},\d{2})\b",
                      texto, re.IGNORECASE)
        if m:
            dados["icms_aliq"] = _num(m.group(1))

    # ── Demonstrativo de Consumo: leituras Fora Ponta (linha separada de Ponta) ──
    # "Consumo Ativo Fora de Ponta  32.013,00  35.636,00  4,00000  8,00-  14.484,00"
    if not dados["leit_ant_fp"]:
        m = re.search(
            r"Consumo Ativo Fora de Ponta\s+"
            r"([\d\.]+,\d+)\s+"    # leit_ant_fp
            r"([\d\.]+,\d+)\s+"    # leit_atu_fp
            r"([\d,\.]+)\s+"       # constante_fp
            r"[\d,\.\-]+\s+"       # ajuste (ignora)
            r"([\d\.]+,\d+)",      # kwh_fponta
            texto, re.IGNORECASE)
        if m:
            dados["leit_ant_fp"]  = _num(m.group(1))
            dados["leit_atu_fp"]  = _num(m.group(2))
            dados["constante_fp"] = _num(m.group(3))
            if not dados["kwh_fponta"]:
                dados["kwh_fponta"] = _num(m.group(4))

    # "Consumo Ativo Na Ponta  384.033,00  428.681,00  0,04000  0,00  1.785,92"
    if not dados["leit_ant_p"]:
        m = re.search(
            r"Consumo Ativo Na Ponta\s+"
            r"([\d\.]+,\d+)\s+"
            r"([\d\.]+,\d+)\s+"
            r"([\d,\.]+)\s+"
            r"[\d,\.\-]+\s+"
            r"([\d\.]+,\d+)",
            texto, re.IGNORECASE)
        if m:
            dados["leit_ant_p"]  = _num(m.group(1))
            dados["leit_atu_p"]  = _num(m.group(2))
            dados["constante_p"] = _num(m.group(3))
            if not dados["kwh_ponta"]:
                dados["kwh_ponta"] = _num(m.group(4))

    # ── CIP COSIP (Neoenergia e outros) ─────────────────────────────────────────
    # "COSIP Municipal Chapecó  288,15"  /  "ICS COSIP Municipal  288,15"
    # "COSIP - SÃO PAULO - MUNICIPAL  1.190,02"
    if not dados["cip"]:
        m = re.search(r"COSIP\b[\s\S]{0,60}?([\d\.]+,\d{2})", texto, re.IGNORECASE)
        if m:
            dados["cip"] = _num(m.group(1))

    # ── Total da fatura (seção SUBTOTAL/TOTAL no final da tabela de itens) ───────
    if not dados["total_rs"]:
        m = re.search(r"(?:^|\n)\s*TOTAL\s+([\d\.]+,\d{2})\s*(?:\n|$)",
                      texto, re.IGNORECASE | re.MULTILINE)
        if m:
            dados["total_rs"] = _num(m.group(1))

    # ── Enel SP / Neoenergia SP: "Descrição de Faturamento" com código CCI ───────
    #
    # Colunas: CCI | DESCRIÇÃO | QTD kWh | TARIFA C/ICMS | BASE ICMS | ALIQ ICMS | ICMS | VALOR
    #
    # 0605  USO SIST. DISTR. (TUSD)          13.530,300  0,48296   6.534,63  18%  1.176,23  6.534,63
    # 0601  ENERGIA (TE)                     13.530,300  0,31763   4.297,69  18%    773,58  4.297,69
    # 0601  CONS.ATIVO-RES.414-ART.113- TE   37.378,800  0,31763  11.872,79  18%  2.137,10 11.872,79
    # 0605  CONS.ATIVO-RES414-ART113- TUSD   37.378,800  0,48296  18.052,59  18%  3.249,46 18.052,59
    # 0699  PIS/PASEP (1,05%)                              454,70  18%   81,84   454,70
    # 0699  COFINS (4,84%)                               2.096,09  18%  377,30 2.096,09
    # 0807  COSIP - SÃO PAULO - MUNICIPAL                                        1.190,02
    #
    # Tarifas aplicadas (sem impostos):
    # CONVENCIONAL   0,39603 (TUSD)   0,26046 (TE)

    # KWH: "USO SIST. DISTR. (TUSD)" ou "ENERGIA (TE)" — mesma qtd na tarifa convencional
    if not dados["kwh_fponta"]:
        m = re.search(
            r"USO\s+SIST\.?\s*DISTR\.?\s*\(TUSD\)\s+([\d\.]+,\d+)\s+([\d,\.]+)"
            r"\s+([\d\.]+,\d{2})",
            texto, re.IGNORECASE)
        if m:
            dados["kwh_fponta"]        = _num(m.group(1))
            dados["preco_unit_c_trib"] = dados["preco_unit_c_trib"] or _num(m.group(2))

    if not dados["kwh_fponta"]:
        m = re.search(
            r"ENERGIA\s*\(TE\)\s+([\d\.]+,\d+)\s+([\d,\.]+)\s+([\d\.]+,\d{2})",
            texto, re.IGNORECASE)
        if m:
            dados["kwh_fponta"] = _num(m.group(1))

    # ICMS alíquota: "18%" na coluna ALIQ ICMS — aparece logo após o valor BASE
    if not dados["icms_aliq"]:
        m = re.search(
            r"(?:TUSD|TE\b)[\s\S]{0,60}?(\d{1,2})%\s+[\d\.]+,\d{2}\s+[\d\.]+,\d{2}",
            texto, re.IGNORECASE)
        if m:
            dados["icms_aliq"] = _num(m.group(1))

    # PIS/PASEP: "PIS/PASEP (1,05%)  454,70  18%  81,84  454,70"
    if not dados["pis_aliq"]:
        m = re.search(
            r"PIS[/\s]PASEP\s*\(([\d,]+)%\)[\s\S]{0,80}?([\d\.]+,\d{2})\s*(?:\n|$)",
            texto, re.IGNORECASE | re.MULTILINE)
        if m:
            dados["pis_aliq"]  = _num(m.group(1))
            dados["pis_valor"] = dados["pis_valor"] or _num(m.group(2))

    # COFINS: "COFINS (4,84%)  2.096,09  18%  377,30  2.096,09"
    if not dados["cofins_aliq"]:
        m = re.search(
            r"COFINS\s*\(([\d,]+)%\)[\s\S]{0,80}?([\d\.]+,\d{2})\s*(?:\n|$)",
            texto, re.IGNORECASE | re.MULTILINE)
        if m:
            dados["cofins_aliq"]  = _num(m.group(1))
            dados["cofins_valor"] = dados["cofins_valor"] or _num(m.group(2))

    # Tarifas sem impostos: "0,39603 (TUSD)  0,26046 (TE)"
    if not dados["tarifa_tusd"]:
        m = re.search(r"(0,\d{4,6})\s*\(TUSD\)", texto, re.IGNORECASE)
        if m:
            dados["tarifa_tusd"] = _num(m.group(1))
            dados["tarifa_kwh"]  = dados["tarifa_kwh"] or dados["tarifa_tusd"]
    if not dados["tarifa_te"]:
        m = re.search(r"(0,\d{4,6})\s*\(TE\)", texto, re.IGNORECASE)
        if m:
            dados["tarifa_te"]    = _num(m.group(1))
            dados["tarifa_ponta"] = dados["tarifa_ponta"] or dados["tarifa_te"]

    # rs_consumo: TUSD + TE (últimas colunas VALOR)
    if not dados["rs_consumo"]:
        tusd_rs = te_rs = None
        m = re.search(
            r"USO\s+SIST\.?\s*DISTR\.?\s*\(TUSD\)[\s\S]{0,100}?"
            r"([\d\.]+,\d{2})\s*(?:\n|$)",
            texto, re.IGNORECASE | re.MULTILINE)
        if m:
            tusd_rs = _num(m.group(1))
        m = re.search(
            r"ENERGIA\s*\(TE\)[\s\S]{0,100}?([\d\.]+,\d{2})\s*(?:\n|$)",
            texto, re.IGNORECASE | re.MULTILINE)
        if m:
            te_rs = _num(m.group(1))
        if tusd_rs and te_rs:
            dados["rs_consumo"] = round(tusd_rs + te_rs, 2)
        elif tusd_rs or te_rs:
            dados["rs_consumo"] = tusd_rs or te_rs

    # ── Número da fatura / NF ──────────────────────────────────────────────────
    if not dados["numero_fatura"]:
        for pat in [
            r"(?:N[º°\.]\s*(?:da\s+)?(?:Fatura|NF|Nota\s*Fiscal))[:\s]+(\S+)",
            r"(?:Fatura|Nota\s*Fiscal)\s*[nN][º°]?\s*[:\-]?\s*(\S+)",
            r"NÚMERO\s+DA\s+FATURA[:\s]+(\S+)",
        ]:
            m = re.search(pat, texto, re.IGNORECASE)
            if m:
                dados["numero_fatura"] = m.group(1).strip(".:,")
                break

    # ── Número de instalação ───────────────────────────────────────────────────
    if not dados["numero_instalacao"]:
        for pat in [
            r"(?:N[º°\.]\s*(?:da\s+)?Instala[çc][ãa]o|Instala[çc][ãa]o\s*[nN][º°]?)[:\s]+(\S+)",
            r"CÓDIGO\s+DA\s+INSTALA[ÇC][ÃA]O[:\s]+(\S+)",
            r"Instala[çc][ãa]o[:\s]+(\d{5,})",
        ]:
            m = re.search(pat, texto, re.IGNORECASE)
            if m:
                dados["numero_instalacao"] = m.group(1).strip(".:,")
                break

    # ── Nome do cliente ────────────────────────────────────────────────────────
    # Fix E: validação SEMÂNTICA — rejeita qualquer string com palavra-lixo de label.
    # Mesma lógica do _eh_razao_valida em atualizar_colunas_db.py.
    _NOME_LIXO_PALAVRAS = {"ENDERECO", "ENDEREÇO", "ENDEREGO", "ENDERESO",
                            "UNIDADE", "CONSUMIDORA", "DOMICILIO", "DOMICÍLIO",
                            "INSTALACAO", "INSTALAÇÃO", "CODIGO", "CÓDIGO",
                            "RUA", "AVENIDA", "AV.", "ESTRADA", "RODOVIA", "TRAVESSA",
                            "CEP", "BAIRRO", "QUADRA", "LOTE", "FAZENDA", "SITIO", "KM",
                            "REFERENCIA", "REFERÊNCIA", "NOME DO CLIENTE",
                            "RAZÃO SOCIAL", "RAZAO SOCIAL"}

    def _nome_eh_valido(s):
        if not s or len(s.strip()) < 4: return False
        up = s.upper().strip()
        if re.search(r"\d", up): return False
        return not any(lx in up for lx in _NOME_LIXO_PALAVRAS)

    if not dados["nome_cliente"]:
        for pat in [
            r"PAGADOR[:\s]+([A-ZÀ-Ú][A-ZÀ-Ú\s\.]{4,80})(?:\s*[-–]|CNPJ|CPF|\n)",
            r"(?:Cliente|Nome)[:\s]+([A-ZÀ-Ú][A-ZÀ-Ú\s]{4,60}?)(?:\n|CPF|CNPJ|UC|$)",
            r"CONSUMIDOR[:\s]+([A-ZÀ-Ú][A-ZÀ-Ú\s]{4,60})(?:\n|$)",
        ]:
            m = re.search(pat, texto, re.IGNORECASE | re.MULTILINE)
            if m:
                nome_cand = m.group(1).strip()
                if _nome_eh_valido(nome_cand):
                    dados["nome_cliente"] = nome_cand
                    break

    # ── CPF / CNPJ ────────────────────────────────────────────────────────────
    # Busca somente após label "CPF/CNPJ:" para evitar capturar o CNPJ da distribuidora
    if not dados["cpf_cnpj"]:
        m = re.search(r"CPF[/\s]CNPJ[:\s]+(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})\b", texto, re.IGNORECASE)
        if not m:
            m = re.search(r"CPF[/\s]CNPJ[:\s]+(\d{3}\.\d{3}\.\d{3}-\d{2})\b", texto, re.IGNORECASE)
        if m:
            dados["cpf_cnpj"] = m.group(1)

    # ── Classe e subgrupo tarifário ────────────────────────────────────────────
    # Enel SP / Eletropaulo: "B - B3 - CONVENCIONAL - Comercial - Comercial"
    #   ou "A - A4 - VERDE - Comercial"
    _cls_m = re.search(
        r"\b([AB])\s*[-–]\s*(A\d[a-z]?|B\d)\s*[-–]\s*"
        r"(CONVENCIONAL|VERDE|AZUL|HOR[ÁA]RIOSAZONAL[\s\w]*|HOR[ÁA]RIO[\s\w]*|TRIFÁSICO\s+\w+|MONOFÁSICO\s+\w+)"
        r"\s*[-–]\s*([A-ZÀ-Úa-zà-ú][A-ZÀ-Úa-zà-ú\s/]+?)(?:\s*[-–]|\n|$)",
        texto, re.IGNORECASE)
    if _cls_m:
        dados["grupo_tarifario"]     = dados["grupo_tarifario"]     or _cls_m.group(1).upper()
        dados["subgrupo_tarifario"]  = dados["subgrupo_tarifario"]  or _cls_m.group(2).upper()
        dados["modalidade_tarifaria"]= dados["modalidade_tarifaria"]or _cls_m.group(3).strip().upper()
        dados["classe_consumidor"]   = dados["classe_consumidor"]   or _cls_m.group(4).strip()

    if not dados["classe_consumidor"]:
        m = re.search(
            r"(?:Classe|Categoria)[:\s]+([A-ZÀ-Ú][A-ZÀ-Ú\s/]{2,40})(?:\n|Subgrupo|Modal)",
            texto, re.IGNORECASE | re.MULTILINE)
        if m:
            dados["classe_consumidor"] = m.group(1).strip()

    if not dados["subgrupo_tarifario"]:
        m = re.search(r"(?:Subgrupo|Sub-grupo)[:\s]+([AB][1-4](?:\.\d)?)\b",
                      texto, re.IGNORECASE)
        if m:
            dados["subgrupo_tarifario"] = m.group(1).upper()

    if not dados["grupo_tarifario"]:
        m = re.search(r"(?:Grupo\s+Tarifário|Grupo)[:\s]+([AB]\d)\b",
                      texto, re.IGNORECASE)
        if m:
            dados["grupo_tarifario"] = m.group(1).upper()

    # ── Modalidade tarifária ───────────────────────────────────────────────────
    if not dados["modalidade_tarifaria"]:
        m = re.search(
            r"(?:Modalidade|Tarifa\s+Modalidade)[:\s]+((?:VERDE|AZUL|HOR[ÁA]RIA|CONV\w*|BINÔMIA)[^\n]*)",
            texto, re.IGNORECASE)
        if m:
            dados["modalidade_tarifaria"] = m.group(1).strip()[:50]
    # Enel ACL: "Trifásico Verde" / "Trifásico Azul" standalone
    if not dados["modalidade_tarifaria"]:
        m = re.search(r"\b(Trifásico|Monofásico|Bifásico)\s+(Verde|Azul|Convencional)\b",
                      texto, re.IGNORECASE)
        if m:
            dados["modalidade_tarifaria"] = m.group(2).strip().upper()

    # ── Tensão de fornecimento ─────────────────────────────────────────────────
    if not dados["tensao_fornecimento"]:
        # Tensão numérica: "13,8kV", "127/220V"
        m = re.search(r"(?:Tens[ãa]o|Nível\s+de\s+Tens[ãa]o)[:\s]+([\d,/]+\s*k?[Vv])\b",
                      texto, re.IGNORECASE)
        if m:
            dados["tensao_fornecimento"] = m.group(1).strip()
    if not dados["tensao_fornecimento"]:
        # Enel SP: "TIPO DE FORNECIMENTO\nMonofásico" ou "Monofásico" na linha de classificação
        m = re.search(r"TIPO\s+DE\s+FORNECIMENTO[:\s]*(Monofásico|Bifásico|Trifásico)\b",
                      texto, re.IGNORECASE)
        if not m:
            m = re.search(r"^(Monofásico|Bifásico|Trifásico)\s*$",
                          texto, re.IGNORECASE | re.MULTILINE)
        if m:
            dados["tensao_fornecimento"] = m.group(1).strip()

    # ── Número do medidor ─────────────────────────────────────────────────────
    # Enel SP BT: pdfplumber extrai o layout de 2 colunas como texto fragmentado.
    # O medidor aparece como número isolado ANTES do histórico mensal:
    #   "12437633 nov/19 2558 30"  → captura o número antes de "mmm/aa"
    # O label "Nº do medidor" fica na coluna oposta e NÃO aparece adjacente no texto.
    if not dados["numero_medidor"]:
        for pat in [
            # Enel SP BT: número seguido direto de mês/ano do histórico (sem label)
            r"^(\d{7,9})\s+(?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/\d{2}\b",
            r"N[º°\.]\s*do\s+[Mm]edidor[\s\n]+([\d]{5,})",
            r"N[º°]\s*medidor[:\s]+([\d]{5,})",
            r"MEDIDOR\s+N[º°]\s*([\d]{5,})",
            r"(?:N[º°\.]\s*do\s+(?:Medidor|Med\.?)|Medidor\s*N[º°]?)[:\s]+([\d\w]{5,})",
            r"MEDIDOR[:\s]+([\d]{5,})",
            r"^([A-Z0-9]{6,})\s+ENRG\s+ATV",
        ]:
            m = re.search(pat, texto, re.IGNORECASE | re.MULTILINE)
            if m:
                val = m.group(1).strip(".:,")
                # Aceita só puramente numérico (5+ dig) ou alfanumérico maiúsculo (6+).
                # Rejeita palavras descritivas via blocklist compartilhada.
                if (re.match(r"^\d{5,}$", val) or re.match(r"^[A-Z0-9]{6,}$", val)) \
                        and val.lower() not in _MEDIDOR_BLOCKLIST_PDF:
                    dados["numero_medidor"] = val
                    break

    # ── Leituras Enel SP BT: seção "Dados de Medição" ────────────────────────
    # pdfplumber extrai as duas colunas intercaladas — os labels "Leitura anterior"
    # e "Leitura atual" NÃO aparecem junto dos valores no texto extraído.
    # O que aparece é: "DD MMM VALOR_GRANDE" onde VALOR_GRANDE usa ponto como milhar.
    # Exemplo real: "06 FEV 49.318.053" e "05 MAR 8.225.804"
    # A primeira ocorrência é leit_ant; a segunda é leit_atu.
    _meses_pt = r"(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)"
    _leit_grande = r"([\d]{1,2}(?:\.[\d]{3})+)"   # ex: 49.318.053 ou 8.225.804
    if not dados["leit_ant_p"]:
        _leituras = re.findall(
            r"\b\d{2}\s+" + _meses_pt + r"\s+" + _leit_grande,
            texto, re.IGNORECASE)
        if len(_leituras) >= 1:
            dados["leit_ant_p"]  = _num(_leituras[0])
            if not eh_convencional:  # Fix D
                dados["leit_ant_fp"] = dados["leit_ant_p"]
        if len(_leituras) >= 2:
            dados["leit_atu_p"]  = _num(_leituras[1])
            if not eh_convencional:  # Fix D
                dados["leit_atu_fp"] = dados["leit_atu_p"]

    # ── Constante K e relações RTC/RTP ────────────────────────────────────────
    if not dados["constante_k"]:
        for pat in [
            r"\bK\s*=\s*([\d,\.]+)",
            r"Constante[:\s]+([\d,\.]+)",
            r"K\s*:\s*([\d,\.]+)",
        ]:
            m = re.search(pat, texto, re.IGNORECASE)
            if m:
                dados["constante_k"] = _num(m.group(1))
                break

    if not dados["rtp"]:
        m = re.search(r"\bRTP\b[:\s]+([\d,\.]+)", texto, re.IGNORECASE)
        if m:
            dados["rtp"] = _num(m.group(1))

    # "Fator de Multiplicação" / "FM" — mesma grandeza física que constante_k.
    if not dados["constante_k"]:
        m = re.search(r"(?:Fator\s+de\s+Multiplica[çc][ãa]o|FM)[:\s]+([\d,\.]+)",
                      texto, re.IGNORECASE)
        if m:
            dados["constante_k"] = _num(m.group(1))

    # ── Consumo reativo (kVArh) ────────────────────────────────────────────────
    if not dados["kwh_reativo"]:
        m = re.search(
            r"(?:Energia\s+Reativa|Reativa\s+Total|Indutiva)[:\s]+(?:KVArh|kVArh)?\s*([\d\.]+,\d+)",
            texto, re.IGNORECASE)
        if m:
            dados["kwh_reativo"] = _num(m.group(1))

    if not dados["kwh_reativo_exc"]:
        m = re.search(
            r"(?:Reativa\s+Excedente|Excedente\s+Reativa)[:\s]+(?:KVArh|kVArh)?\s*([\d\.]+,\d+)",
            texto, re.IGNORECASE)
        if m:
            dados["kwh_reativo_exc"] = _num(m.group(1))

    # ── Demanda faturada ponta e fora ponta ───────────────────────────────────
    if not dados["demanda_fat_p"]:
        for pat in [
            r"Demanda\s+(?:Faturada\s+)?(?:na\s+)?Ponta\s+KW\s+([\d\.]+,\d+)",
            r"Demanda\s+(?:Medida\s+)?(?:na\s+)?Ponta[:\s]+([\d\.]+,\d+)\s*kW",
        ]:
            m = re.search(pat, texto, re.IGNORECASE)
            if m:
                dados["demanda_fat_p"] = _num(m.group(1))
                break

    if not dados["demanda_fat_fp"]:
        for pat in [
            r"Demanda\s+(?:Faturada\s+)?Fora\s+(?:de\s+)?Ponta\s+KW\s+([\d\.]+,\d+)",
            r"Demanda\s+(?:Medida\s+)?Fora\s+(?:de\s+)?Ponta[:\s]+([\d\.]+,\d+)\s*kW",
        ]:
            m = re.search(pat, texto, re.IGNORECASE)
            if m:
                dados["demanda_fat_fp"] = _num(m.group(1))
                break
    if not dados["demanda_fat_fp"]:
        try:
            from extrator_complementar import extrair_demanda_faturada_fp
            dados["demanda_fat_fp"] = extrair_demanda_faturada_fp(texto)
        except Exception:
            pass

    # ── Demanda contratada ────────────────────────────────────────────────────
    if not dados["demanda_cont_p"]:
        m = re.search(
            r"Demanda\s+Contratada\s+(?:na\s+)?Ponta[:\s]+([\d\.]+,\d+)\s*k?W",
            texto, re.IGNORECASE)
        if m:
            dados["demanda_cont_p"] = _num(m.group(1))

    if not dados["demanda_cont_fp"]:
        m = re.search(
            r"Demanda\s+Contratada\s+Fora\s+(?:de\s+)?Ponta[:\s]+([\d\.]+,\d+)\s*k?W",
            texto, re.IGNORECASE)
        if m:
            dados["demanda_cont_fp"] = _num(m.group(1))

    # ── Enel ACL (alta tensão): demanda única e leituras do medidor ───────────
    # "DEMANDA ÚNICA C/ DESCONTO 5.199,6 7,91811 41.171,00 18% 7.410,78 41.171,00 6,40942"
    # "DMCR PONTA 4.545 4.528 4.754,4"  (demanda medida)
    if not dados["demanda_fat_p"]:
        m = re.search(
            r"(?:DEMANDA\s+[ÚU]NICA|0602\s+DEMANDA)[^\n]*([\d\.]+,\d+)\s+[\d,\.]+\s+([\d\.]+,\d{2})",
            texto, re.IGNORECASE)
        if m:
            dados["demanda_fat_p"]  = _num(m.group(1))
            dados["valor_demanda"]  = dados["valor_demanda"] or _num(m.group(2))

    # "CONSUMO PONTA AM 2.158.293 2.432.736 288.165,2"  → leit_ant  leit_atu  kwh
    if dados["leit_ant_p"] is None:
        m = re.search(
            r"CONSUMO\s+PONTA\s+AM\s+([\d\.]+)\s+([\d\.]+)\s+([\d\.]+,\d+)",
            texto, re.IGNORECASE)
        if m:
            dados["leit_ant_p"] = _num(m.group(1))
            dados["leit_atu_p"] = _num(m.group(2))
            if not dados["kwh_ponta"]:
                dados["kwh_ponta"] = _num(m.group(3))

    # "CONSUMO FORA PONTA INDUTIVO AM 16.660.691 18.616.985 2.054.108,7"
    if dados["leit_ant_fp"] is None:
        m = re.search(
            r"CONSUMO\s+FORA\s+PONTA\s+INDUTIVO\s+AM\s+([\d\.]+)\s+([\d\.]+)\s+([\d\.]+,\d+)",
            texto, re.IGNORECASE)
        if m:
            dados["leit_ant_fp"] = _num(m.group(1))
            dados["leit_atu_fp"] = _num(m.group(2))
            if not dados["kwh_fponta"]:
                dados["kwh_fponta"] = _num(m.group(3))

    # "CONST. ATIVO 1,05000" ou "CONST. POTENCIA 4,20000"
    if not dados["constante_k"]:
        m = re.search(r"CONST\.\s+ATIVO\s+([\d,\.]+)", texto, re.IGNORECASE)
        if m:
            dados["constante_k"] = _num(m.group(1))

    # ── Fator de potência ──────────────────────────────────────────────────────
    if not dados["fator_potencia"]:
        for pat in [
            r"(?:Fator\s+de\s+Pot[êe]ncia|FP\b)[:\s]+(0,\d+)",
            r"\bFP[:\s=]+(0,\d+)",
        ]:
            m = re.search(pat, texto, re.IGNORECASE)
            if m:
                dados["fator_potencia"] = _num(m.group(1))
                break

    # ── Tarifa TE e TUSD — Enel SP / Eletropaulo (número no final da linha) ──────
    # "USO SIST. DISTR. (TUSD) KWH 378,000 0,48238 182,34 8,47 182,34 18% 32,82 0,37317"
    # "ENERGIA (TE)              KWH 378,000 0,34005 128,54 5,97 128,54 18% 23,13 0,26307"
    # A tarifa sem ICMS é o último valor da linha (0,\d{4,6}). Usamos [^\n]* greedy para pegar o último.
    if not dados["tarifa_tusd"]:
        m = re.search(
            r"USO\s+SIST\.?\s*DISTR\.?\s*\(TUSD\)[^\n]*(0,\d{4,6})\s*(?:\n|$)",
            texto, re.IGNORECASE | re.MULTILINE)
        if m:
            dados["tarifa_tusd"] = _num(m.group(1))
            dados["tarifa_kwh"]  = dados["tarifa_kwh"] or dados["tarifa_tusd"]
    if not dados["tarifa_te"]:
        m = re.search(
            r"ENERGIA\s*\(TE\)[^\n]*(0,\d{4,6})\s*(?:\n|$)",
            texto, re.IGNORECASE | re.MULTILINE)
        if m:
            dados["tarifa_te"] = _num(m.group(1))

    # ── Valor energia ativa — Subtotal Faturamento (Enel SP) ──────────────────
    # "Subtotal Faturamento 310,88 0,00 0,00 0,00" → primeiro valor = TUSD+TE
    if not dados["rs_consumo"]:
        m = re.search(r"Subtotal\s+Faturamento\s+([\d\.]+,\d{2})", texto, re.IGNORECASE)
        if m:
            dados["rs_consumo"] = _num(m.group(1))

    # ── Bandeira tarifária ────────────────────────────────────────────────────
    if not dados["tipo_bandeira"]:
        # Enel SP: "Bandeira(s) tarifária(s) aplicada(s) no mês: VERDE"
        m = re.search(
            r"Bandeira(?:s)?\s+tarif[^\n:]*:\s*(VERDE|AMARELA|VERMELHA\s*(?:P[12]|PATAM[AÃ]R\s*[12])?|ESCASSEZ[^\n]*)",
            texto, re.IGNORECASE)
        if not m:
            m = re.search(
                r"Bandeira\s+(VERDE|AMARELA|VERMELHA\s*(?:P[12]|PATAM[AÃ]R\s*[12])?)",
                texto, re.IGNORECASE)
        if m:
            dados["tipo_bandeira"] = m.group(1).strip().upper()

    if not dados["valor_bandeira"]:
        # Verde = sem cobrança
        if dados["tipo_bandeira"] and dados["tipo_bandeira"].upper() == "VERDE":
            dados["valor_bandeira"] = 0.0
        else:
            m = re.search(
                r"(?:Bandeira|Encargo\s+de\s+Bandeira)[^\n]*([\d\.]+,\d{2})",
                texto, re.IGNORECASE)
            if m:
                dados["valor_bandeira"] = _num(m.group(1))

    # ── Energia injetada / compensada (GD) ────────────────────────────────────
    if not dados["kwh_compensado"]:
        m = re.search(
            r"(?:Energia\s+Compensada|Compensa[çc][ãa]o\s+GD)[:\s]+(?:KWH|kWh)?\s*([\d\.]+,\d+)",
            texto, re.IGNORECASE)
        if m:
            dados["kwh_compensado"] = _num(m.group(1))

    if not dados["saldo_credito"]:
        m = re.search(
            r"(?:Saldo|Cr[eé]dito)[:\s]+(?:KWH|kWh)?\s*([\d\.]+,\d+)\s*(?:kWh|$)",
            texto, re.IGNORECASE)
        if m:
            dados["saldo_credito"] = _num(m.group(1))

    # ── Perda de transformação ────────────────────────────────────────────────
    if not dados["perda_transf_pct"]:
        m = re.search(
            r"(?:Perda\s+de\s+Transforma[çc][ãa]o|Fator\s+de\s+Perda)[:\s]+([\d,\.]+)\s*%",
            texto, re.IGNORECASE)
        if m:
            dados["perda_transf_pct"] = _num(m.group(1))

    # ── Encargos setoriais ────────────────────────────────────────────────────
    if not dados["valor_proinfa"]:
        m = re.search(r"\bPROINFA\b[^\n]*([\d\.]+,\d{2})", texto, re.IGNORECASE)
        if m:
            dados["valor_proinfa"] = _num(m.group(1))

    if not dados["valor_cde"]:
        m = re.search(r"\bCDE\b[^\n]*([\d\.]+,\d{2})", texto, re.IGNORECASE)
        if m:
            dados["valor_cde"] = _num(m.group(1))

    if not dados["valor_ess"]:
        m = re.search(r"\bESS\b[^\n]*([\d\.]+,\d{2})", texto, re.IGNORECASE)
        if m:
            dados["valor_ess"] = _num(m.group(1))

    # ── Indicadores (flags) ───────────────────────────────────────────────────
    dados["ind_tarifa_social"]  = 1 if re.search(
        r"Baixa\s+Renda|Tarifa\s+Social|TSEE", texto, re.IGNORECASE) else None
    dados["ind_cliente_rural"]  = 1 if re.search(
        r"\bRural\b|\bIrrigante\b", texto, re.IGNORECASE) else None
    dados["ind_mercado_livre"]  = 1 if re.search(
        r"\bACL\b|Mercado\s+Livre|Livre\b", texto, re.IGNORECASE) else None
    dados["ind_gd"]             = 1 if re.search(
        r"Gera[çc][ãa]o\s+Distribu[íi]da|GD\b|Microgeradora|Minigeradora",
        texto, re.IGNORECASE) else None
    dados["ind_troca_medidor"]  = 1 if re.search(
        r"Troca\s+(?:de\s+)?Medidor|Substitui[çc][ãa]o\s+de\s+Medidor",
        texto, re.IGNORECASE) else None
    dados["ind_impede_leitura"] = 1 if re.search(
        r"Impedimento\s+(?:de\s+)?Leitura|N[ãa]o\s+Lido|Leitura\s+Impedida",
        texto, re.IGNORECASE) else None
    dados["ind_leitura_estim"]  = 1 if re.search(
        r"Estimativa|Estimado|Consumo\s+Estimado", texto, re.IGNORECASE) else None
    dados["ind_leitura_real"]   = 1 if not dados["ind_leitura_estim"] else None

    # ── Histórico demanda (12 meses) ──────────────────────────────────────────
    if not dados["historico_demanda"]:
        hist_d = []
        for m in re.finditer(
            r"\b([A-Z]{3})/(\d{2})\s+([\d\.]+,\d+|[\d]{2,})\s*kW\b",
            texto, re.IGNORECASE
        ):
            mes_str = m.group(1).upper()
            if mes_str not in MESES_PT:
                continue
            kw = _num(m.group(3))
            if kw and kw > 0:
                hist_d.append({"mes": MESES_PT[mes_str], "ano": 2000 + int(m.group(2)), "kw": kw})
        if hist_d:
            seen_d = {}
            for h in hist_d:
                k = (h["mes"], h["ano"])
                if k not in seen_d:
                    seen_d[k] = h
            dados["historico_demanda"] = sorted(seen_d.values(), key=lambda x: (x["ano"], x["mes"]))

    # COELBA: sobrescreve tarifa TE/TUSD pelo preço da linha Consumo-TE/TUSD (por último = vence LLM/regex)
    dados.update(_coelba_tarifa_override(linhas))

    return dados


# ─── Parser via tabelas do pdfplumber (extra: itens estruturados) ─────────────

def parse_plumber_tables(pdf_bytes: bytes) -> dict:
    """
    Extrai campos diretamente das tabelas do PDF via pdfplumber.

    Energisa MT — estrutura conhecida:
      Tabela boleto  : vencimento, data emissão, valor total
      Tabela ICMS    : PIS/COFINS/ICMS base/aliq/valor (às vezes fragmentada)
      Texto pág 2    : "KWH Ponta {ATUAL} {ANTERIOR} {CONST} ... {CONSUMO}"
                       (ordem atual→anterior, diferente do markdown)
    """
    dados = _campos_vazios()

    # Acumula o texto completo de todas as páginas para regex posterior
    todas_linhas = []

    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:

            # ── Guarda referência para tabelas de tributos (fragmentadas) ─────
            pis_nums    = []
            cofins_nums = []
            icms_nums   = []

            for page in pdf.pages:
                # Texto limpo da página
                txt = page.extract_text() or ""
                todas_linhas.extend(txt.splitlines())

                for table in page.extract_tables():
                    if not table:
                        continue
                    for row in table:
                        # Normaliza células: \n → espaço, strip
                        row = [re.sub(r"\s+", " ", str(c or "")).strip() for c in row]
                        joined = " | ".join(row)

                        # ── Consumo kWh (itens da fatura) ────────────────────
                        if re.search(r"Consumo em kWh", joined, re.IGNORECASE):
                            nums = [c for c in row if re.match(r"^[\d\.]+,\d+$", c)]
                            if len(nums) >= 2:
                                dados["kwh_total"]         = _num(nums[0])
                                dados["preco_unit_c_trib"] = _num(nums[1])
                            if len(nums) >= 3:
                                dados["rs_consumo"] = _num(nums[2])
                            for c in row:
                                if re.match(r"^0,\d{5,6}$", c):
                                    dados["tarifa_kwh"] = _num(c)
                                    break

                        # ── Energia injetada ──────────────────────────────────
                        elif re.search(r"Energia Atv Injetada|Injetada", joined, re.IGNORECASE):
                            nums = [_num(c) for c in row
                                    if re.match(r"^[\d\.]+,\d+$", c) and _num(c) and _num(c) > 0]
                            if nums:
                                dados["kwh_injet"] = (dados["kwh_injet"] or 0) + nums[0]

                        # ── Tributos: coleta por nome de linha ────────────────
                        # A tabela pode estar fragmentada (headers numa, dados noutra)
                        elif re.match(r"^PIS$", row[0], re.IGNORECASE):
                            n = [_num(c) for c in row[1:]
                                 if c and re.match(r"^[\d,\.]+$", c) and _num(c)]
                            pis_nums = [x for x in n if x is not None]

                        elif re.match(r"^COFINS$", row[0], re.IGNORECASE):
                            n = [_num(c) for c in row[1:]
                                 if c and re.match(r"^[\d,\.]+$", c) and _num(c)]
                            cofins_nums = [x for x in n if x is not None]

                        elif re.match(r"^ICMS$", row[0], re.IGNORECASE):
                            n = [_num(c) for c in row[1:]
                                 if c and re.match(r"^[\d,\.]+$", c) and _num(c)]
                            icms_nums = [x for x in n if x is not None]

                        # ── CIP ───────────────────────────────────────────────
                        elif re.search(r"[Il]lum\w*\s*P[uú]b|CIP", joined, re.IGNORECASE):
                            nums = [_num(c) for c in row
                                    if re.match(r"^[\d\.]+,\d{2}$", c) and _num(c) and _num(c) > 5]
                            if nums:
                                dados["cip"] = nums[0]

                        # ── Boleto: vencimento + emissão + valor ──────────────
                        elif re.search(r"VENCIMENTO", joined, re.IGNORECASE):
                            for cell in row:
                                cell = cell.replace("VENCIMENTO", "").strip()
                                m = re.search(r"(\d{2}/\d{2}/\d{4})", cell)
                                if m:
                                    dados["vencimento"] = m.group(1)
                                    break

                        elif re.search(r"DATA DO DOCUMENTO", joined, re.IGNORECASE):
                            for cell in row:
                                m = re.search(r"(\d{2}/\d{2}/\d{4})", cell)
                                if m and not dados["dt_emissao"]:
                                    dados["dt_emissao"] = m.group(1)
                            # Valor do documento
                            for cell in row:
                                m = re.search(r"VALOR DO DOCUMENTO[\s\S]*?([\d\.]+,\d{2})", cell)
                                if m and not dados["total_rs"]:
                                    dados["total_rs"] = _num(m.group(1))

            # ── Aplica tributos coletados ─────────────────────────────────────
            if len(pis_nums) >= 3:
                dados["pis_base"]  = pis_nums[0]
                dados["pis_aliq"]  = pis_nums[1]
                dados["pis_valor"] = pis_nums[2]
            if len(cofins_nums) >= 3:
                dados["cofins_aliq"]  = cofins_nums[1]
                dados["cofins_valor"] = cofins_nums[2]
            if len(icms_nums) >= 3:
                dados["icms_base"]  = icms_nums[0]
                dados["icms_aliq"]  = icms_nums[1]
                dados["icms_valor"] = icms_nums[2]

    except Exception as e:
        log.warning(f"    parse_plumber_tables: {e}")

    # ── Regex no texto limpo do plumber ───────────────────────────────────────
    # Página 2 Energisa MT: "KWH Ponta {ATUAL} {ANTERIOR} {CONST} ... {CONSUMO}"
    texto_completo = "\n".join(todas_linhas)

    # Detecta fatura Convencional/Grupo B (Fix D — local nesta função)
    _eh_conv_local = bool(re.search(
        r"\b(Convencional|Branca|Bif[áa]sico|Monof[áa]sico|/\s*B[1-4]\b)\b",
        texto_completo, re.IGNORECASE,
    )) and not re.search(r"\bTHS[\s_]?(Verde|Azul)\b|\bTarifa\s+Hor[áa]ria\b",
                         texto_completo, re.IGNORECASE)

    if dados["leit_ant_p"] is None:
        # Na tabela de detalhes o pdfplumber traz: atual primeiro, depois anterior
        # "KWH Ponta 6.606,00 6.508,00 40,00 2,50 0,00 0,00 4.018,00 4.018,00"
        m = re.search(
            r"KWH\s+Ponta\s+([\d\.]+,\d+)\s+([\d\.]+,\d+)\s+([\d,\.]+)([\d\s,\.]*)",
            texto_completo, re.IGNORECASE)
        if m:
            dados["leit_atu_p"]  = _num(m.group(1))
            dados["leit_ant_p"]  = _num(m.group(2))
            dados["constante_p"] = _num(m.group(3))
            if not _eh_conv_local:  # Fix D: só duplica em THS
                dados["leit_atu_fp"] = dados["leit_atu_p"]
                dados["leit_ant_fp"] = dados["leit_ant_p"]
            # kwh_total = último par de valores iguais (consumo_medido = consumo_faturado)
            if not dados["kwh_total"] or dados["kwh_total"] == 0:
                todos = [_num(n) for n in re.findall(r"[\d\.]+,\d+", m.group(4))]
                todos = [n for n in todos if n is not None]
                # busca último par repetido
                for idx in range(len(todos) - 1, 0, -1):
                    if todos[idx] == todos[idx - 1] and todos[idx] > 0:
                        dados["kwh_total"] = todos[idx]
                        break
                else:
                    # sem par — pega último valor positivo
                    pos = [n for n in todos if n and n > 0]
                    if pos:
                        dados["kwh_total"] = pos[-1]

    # ── rs_consumo / tarifa — via regex nos itens da fatura ──────────────────
    # "Consumo em kWh KWH 4.018,00 1,132600 4.550,82 ... 0,882910"
    if dados["rs_consumo"] is None:
        m = re.search(
            r"Consumo em kWh[\s\S]{0,40}?KWH\s+[\d\.]+,\d+"          # kwh (já temos)
            r"\s+([\d,\.]{6,})\s+([\d\.]+,\d{2})[\s\S]{0,100}?(0,\d{5,6})\b",
            texto_completo, re.IGNORECASE)
        if m:
            dados["preco_unit_c_trib"] = _num(m.group(1))
            dados["rs_consumo"]        = _num(m.group(2))
            dados["tarifa_kwh"]        = _num(m.group(3))

    # Datas de leitura: "24/04/2023  24/05/2023  30  23/06/2023"
    if dados["dt_leit_ant"] is None:
        m = re.search(
            r"\b(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{1,3})\s+(\d{2}/\d{2}/\d{4})\b",
            texto_completo)
        if m:
            dados["dt_leit_ant"] = m.group(1)
            dados["dt_leit_atu"] = m.group(2)
            dados["dias"]        = int(m.group(3))
            dados["dt_proxima"]  = m.group(4)

    # CIP fallback no texto
    if dados["cip"] is None:
        m = re.search(
            r"Contrib\w*\s+de\s+[Il]lum\w*\s+Pub\w*\s+([\d\.]+,\d{2})",
            texto_completo, re.IGNORECASE)
        if m:
            dados["cip"] = _num(m.group(1))

    # ICMS/PIS/COFINS fallback no texto
    SEP = r"[\s_]+"
    if dados["icms_base"] is None:
        m = re.search(
            r"\bICMS\b" + SEP + r"([\d\.]+,\d+)" + SEP + r"([\d,\.]+)" + SEP + r"([\d\.]+,\d{2})",
            texto_completo, re.IGNORECASE)
        if m:
            dados["icms_base"]  = _num(m.group(1))
            dados["icms_aliq"]  = _num(m.group(2))
            dados["icms_valor"] = _num(m.group(3))

    if dados["pis_base"] is None:
        m = re.search(
            r"\bPIS(?:/PASEP)?\b" + SEP + r"([\d\.]+,\d+)" + SEP + r"([\d,\.]+)" + SEP + r"([\d\.]+,\d{2})",
            texto_completo, re.IGNORECASE)
        if m:
            dados["pis_base"]  = _num(m.group(1))
            dados["pis_aliq"]  = _num(m.group(2))
            dados["pis_valor"] = _num(m.group(3))

    if dados["cofins_aliq"] is None:
        m = re.search(
            r"\bCOFINS\b" + SEP + r"([\d\.]+,\d+)" + SEP + r"([\d,\.]+)" + SEP + r"([\d\.]+,\d{2})",
            texto_completo, re.IGNORECASE)
        if m:
            dados["cofins_aliq"]  = _num(m.group(2))
            dados["cofins_valor"] = _num(m.group(3))

    # Histórico
    hist = []
    for m in re.finditer(
        r"\b([A-Z]{3})/(\d{2})\s+([\d\.]+,\d+|[\d]{3,})\b",
        texto_completo, re.IGNORECASE
    ):
        mes_str = m.group(1).upper()
        if mes_str not in MESES_PT:
            continue
        kwh = _num(m.group(3))
        if kwh and kwh > 0:
            hist.append({"mes": MESES_PT[mes_str], "ano": 2000 + int(m.group(2)), "kwh": kwh})
    if hist:
        seen = {}
        for h in hist:
            k = (h["mes"], h["ano"])
            if k not in seen or h["kwh"] > seen[k]["kwh"]:
                seen[k] = h
        dados["historico"] = sorted(seen.values(), key=lambda x: (x["ano"], x["mes"]))

    return dados


def _merge_campos(*fontes: dict) -> dict:
    """
    Mescla N dicts de campos em ordem de prioridade (primeiro ganha).
    Prioridade: plumber > ocr > markdown > banco existente
    """
    result = _campos_vazios()
    for fonte in fontes:
        if not fonte:
            continue
        for k, v in fonte.items():
            if k == "historico":
                if not result.get("historico") and v:
                    result["historico"] = v
            elif result.get(k) is None and v is not None:
                result[k] = v
    return result


# ─── Extratores ──────────────────────────────────────────────────────────────

def extrair_plumber(pdf_bytes: bytes) -> tuple[str, dict]:
    """
    pdfplumber: texto limpo + campos via tabelas + regex.
    Retorna (texto_plumber, campos).
    """
    linhas = []
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                txt = page.extract_text() or ""
                linhas.extend(txt.splitlines())
    except Exception as e:
        log.warning(f"    pdfplumber texto: {e}")
        return "", _campos_vazios()

    if not linhas:
        return "", _campos_vazios()

    texto = "\n".join(linhas)

    # 1. Campos via tabelas (mais precisos)
    campos_tabelas = parse_plumber_tables(pdf_bytes)
    # 2. Campos via regex no texto limpo
    campos_regex   = parse_regex(linhas)
    # 3. Merge: tabelas têm prioridade, regex preenche o resto
    campos = _merge_campos(campos_tabelas, campos_regex)

    return texto, campos


def extrair_markdown(pdf_bytes: bytes) -> str:
    """liteparse → texto do slot markdown (SUBSTITUIU markitdown). liteparse dá texto
    comparável ao markitdown (validado: ~mesma len/keywords/números) E expõe spans x/y
    (text_items) p/ o futuro coord layer — o markitdown não dá coordenadas. OCR DESLIGADO
    aqui (o pipeline tem estágio OCR Tesseract próprio; o tessdata do liteparse aponta
    pra outro path e quebraria em escaneada). Fatura escaneada → liteparse devolve vazio
    → cai no fallback markitdown → e o OCR do pipeline cobre depois.
    Fallback: markitdown (se liteparse falhar ou vier vazio)."""
    import tempfile
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name
        texto = ""
        try:
            import liteparse
            res = liteparse.LiteParse(quiet=True, ocr_enabled=False).parse(tmp_path)
            texto = (res.text or "").strip()
        except Exception as e_lp:
            log.warning(f"    liteparse: {e_lp} — fallback markitdown")
        if not texto and not NO_OCR:  # liteparse falhou/vazio (ex.: escaneada) → markitdown
            # markitdown.convert dispara OCR interno (docling/Tesseract) → "Document
            # parser messages". Com --no-ocr, pula: o slot markdown fica vazio (plumber
            # já cobre o texto em faturas nativas).
            cls = _carrega_markitdown()
            if cls is not None:
                texto = (cls().convert(tmp_path).text_content or "").strip()
        if len(texto.encode("utf-8")) > 10 * 1024 * 1024:
            log.warning("    Markdown > 10MB — descartado")
            return ""
        return texto
    except Exception as e:
        log.warning(f"    extrair_markdown: {e}")
        return ""
    finally:
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)


def _executar_ocr(pdf_bytes: bytes, fatura_id: int, lang: str | None = None) -> tuple[list[str], Exception | None]:
    """Roda OCR (Tesseract) num PDF: renderiza cada página com PyMuPDF e reconhece
    via pytesseract direto da imagem em memória (sem I/O de disco).
    Retorna (linhas, exception)."""
    import pytesseract
    from PIL import Image
    lang   = lang or TESS_LANG
    linhas = []
    exc    = None
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            for page in doc:
                pix = page.get_pixmap(matrix=fitz.Matrix(TESS_ZOOM, TESS_ZOOM))
                img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                txt = pytesseract.image_to_string(img, lang=lang, config=TESS_CONFIG)
                linhas.extend(l for l in txt.splitlines() if l.strip())
        finally:
            doc.close()
    except Exception as e:
        exc = e
    return linhas, exc


def extrair_ocr(pdf_bytes: bytes, fatura_id: int) -> tuple[str, dict]:
    """Tesseract OCR: converte cada página do PDF em imagem (PyMuPDF) e reconhece o texto.
    CPU-only, estável e thread-safe (cada chamada é um subprocess do binário tesseract).
    Fallback de idioma: se o traineddata 'por' não estiver instalado, tenta 'eng'.
    """
    pdf_kb = len(pdf_bytes) / 1024
    log.info(f"  [ocr] Tesseract (PDF {pdf_kb:.0f}KB, lang={TESS_LANG}, zoom={TESS_ZOOM:g})...")
    linhas, exc = _executar_ocr(pdf_bytes, fatura_id)

    # traineddata 'por' pode não estar instalado → tenta 'eng'
    if exc is not None and "por" in (TESS_LANG or ""):
        log.warning(f"    OCR: falha com lang='{TESS_LANG}' ({exc}); tentando 'eng'.")
        linhas, exc = _executar_ocr(pdf_bytes, fatura_id, lang="eng")

    if exc is not None:
        log.warning(f"    OCR (tesseract): {exc}")
        return "", _campos_vazios()
    if not linhas:
        return "", _campos_vazios()

    texto  = "\n".join(linhas)
    campos = parse_regex(linhas)
    return texto, campos


# ─── Download PDF ─────────────────────────────────────────────────────────────

# Links inválidos (20/10/2026): ~2.790 faturas davam 404/arquivo-não-PDF em TODA rodada.
# baixar_pdf anota em _dl_info.motivo SÓ erro definitivo (HTTP 400/401/403/404/410 ou
# conteúdo que não é PDF); timeout / 5xx / conexão ficam None e são tentados de novo.
# A falha definitiva vai para FT_FATURA_LINK_INVALIDO e o --skip-processadas pula a fatura
# enquanto o link na origem for o MESMO (link corrigido na origem → volta a ser tentada).
# --retentar-links-invalidos ignora a tabela.
_dl_info = _threading.local()
_HTTP_DEFINITIVO = (400, 401, 403, 404, 410)


def _tbl_link_inv() -> str:
    return "FT_FATURA_LINK_INVALIDO" if TBL_FDE == "FATURA_DADOS_EXTRAIDOS" else "FT_FATURA_LINK_INVALIDO_COPIA"


def _garantir_tbl_link_invalido(cur):
    cur.execute(f"""CREATE TABLE IF NOT EXISTS {_tbl_link_inv()} (
        uid         VARCHAR(128) NOT NULL,
        link        VARCHAR(1024) NULL,
        motivo      VARCHAR(40)  NULL,
        tentativas  INT          NOT NULL DEFAULT 1,
        primeira_em DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ultima_em   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (uid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")


def _marcar_link_invalido(cur, conn, uid, link, motivo):
    try:
        _garantir_tbl_link_invalido(cur)
        cur.execute(f"""INSERT INTO {_tbl_link_inv()} (uid, link, motivo) VALUES (%s, %s, %s)
            ON DUPLICATE KEY UPDATE link=VALUES(link), motivo=VALUES(motivo),
                                    tentativas=tentativas+1, ultima_em=NOW()""",
                    (str(uid), (link or "").strip()[:1024], motivo))
        conn.commit()
        log.info(f"  [link-invalido] marcado ({motivo}) — próximas rodadas pulam enquanto o link não mudar")
    except Exception as e:
        log.warning(f"  [link-invalido] falha ao marcar: {e}")


def baixar_pdf(url: str) -> bytes | None:
    _dl_info.motivo = None
    try:
        r = requests.get(url.strip(), timeout=30, stream=True)
        r.raise_for_status()
        content = r.content
        ctype = (r.headers.get("content-type") or "").lower()
        # Portal de seleção VTAL: o link retorna HTML com '1ª/2ª Fatura' (data-src de PDFs no
        # GCS) em vez do PDF. Segue o PDF exibido por padrão (<object data=>) ou o 1º data-src
        # (= 1ª Fatura) e baixa o PDF real. (~751 faturas VTAL caíam nisso → gate null.)
        head = content[:512].lstrip().lower()
        if ("text/html" in ctype or head.startswith(b"<!doctype") or head.startswith(b"<html")) \
           and b"%PDF-" not in content[:1024]:
            html = content.decode("iso-8859-1", "replace")
            # links '<div data-src='...pdf'>1ª/2ª Fatura</div>'. A **1ª Fatura é a NF3e de
            # ENERGIA** (a conta real, extrai bem); a 2ª é a NF-e da COMERCIALIZADORA (Auren/BTG,
            # ACL) que o validador de fatura de energia reprova. Seguir a 1ª. Fallback: <object
            # data=> (exibe a 1ª), 1º data-src; se só houver 1, usa o único.
            pares = re.findall(r"data-src=['\"](https?://[^'\"]+\.pdf[^'\"]*)['\"][^>]*>\s*([^<]*)", html, re.I)
            pdf_url = None
            for u1, lab in pares:
                if re.search(r"1.{0,4}Fatura", lab, re.I):   # rótulo '1ª Fatura' (NF3e energia)
                    pdf_url = u1; break
            if not pdf_url:
                mo = re.search(r"<object[^>]+data=['\"](https?://[^'\"]+\.pdf[^'\"]*)['\"]", html, re.I)
                pdf_url = mo.group(1) if mo else (pares[0][0] if pares else None)
            if pdf_url:
                log.info(f"    [portal] seguindo 1ª Fatura (NF3e energia) → {pdf_url[:80]}")
                r2 = requests.get(pdf_url, timeout=30)
                r2.raise_for_status()
                return r2.content
            log.warning("    [portal] HTML sem data-src de PDF reconhecível")
            return content
        return content
    except Exception as e:
        resp = getattr(e, "response", None)
        if isinstance(e, requests.HTTPError) and resp is not None and resp.status_code in _HTTP_DEFINITIVO:
            _dl_info.motivo = f"http_{resp.status_code}"
        log.warning(f"    Download falhou: {e}")
        return None


# ─── Gravar em FATURA_DADOS_EXTRAIDOS ────────────────────────────────────────

def gravar_dados_extraidos(cur, conn, fatura_id: int, campos: dict,
                           fonte: str = "regex",
                           uid: str | None = None,
                           link: str | None = None,
                           cod_empresa: int | None = None,
                           uc: str | None = None) -> bool:
    """
    INSERT ... ON DUPLICATE KEY UPDATE em FATURA_DADOS_EXTRAIDOS.
    Grava apenas campos não-None de `campos`. Retorna True se gravou.
    """
    import json as _json

    mapa = {
        # identificação
        "numero_fatura"         : "numero_fatura",
        "numero_instalacao"     : "numero_instalacao",
        "nome_cliente"          : "nome_cliente",
        "cpf_cnpj"              : "cpf_cnpj",
        "classe_consumidor"     : "classe_consumidor",
        "subgrupo_tarifario"    : "subgrupo_tarifario",
        "modalidade_tarifaria"  : "modalidade_tarifaria",
        "distribuidora"         : "distribuidora",
        "grupo_tarifario"       : "grupo_tarifario",
        "tensao_fornecimento"   : "tensao_fornecimento",
        "numero_medidor"        : "numero_medidor",
        "tipo_medicao"          : "tipo_medicao",
        # período
        "mes_ref"               : "mes_referencia",
        "dias"                  : "dias_faturados",
        # leituras ativas
        "leit_ant_p"            : "leit_ant_ativa_ponta",
        "leit_atu_p"            : "leit_atu_ativa_ponta",
        "leit_ant_fp"           : "leit_ant_ativa_fponta",
        "leit_atu_fp"           : "leit_atu_ativa_fponta",
        # leituras reativas
        "leit_ant_reativa"      : "leit_ant_reativa",
        "leit_atu_reativa"      : "leit_atu_reativa",
        # leituras demanda
        "leit_demanda_p"        : "leit_demanda_ponta",
        "leit_demanda_fp"       : "leit_demanda_fponta",
        # constantes
        "constante_p"           : "constante_k",
        "constante_k"           : "constante_k",
        "rtp"                   : "rtp_relacao_transformacao_potencial",
        # consumo
        "kwh_ponta"             : "consumo_ativo_ponta_kwh",
        "kwh_fponta"            : "consumo_ativo_fponta_kwh",
        "kwh_reativo"           : "consumo_reativo_kvarh",
        "kwh_reativo_exc"       : "consumo_reativo_excedente_kvarh",
        "kvar_reativo_exc"      : "demanda_reativa_excedente_kvar",
        # demanda
        "demanda_fat_p"         : "demanda_faturada_ponta_kw",
        "demanda_fat_fp"        : "demanda_faturada_fponta_kw",
        "demanda_cont_p"        : "demanda_contratada_ponta_kw",
        "demanda_cont_fp"       : "demanda_contratada_fponta_kw",
        # fatores
        "fator_carga"           : "fator_carga",
        "fator_potencia"        : "fator_potencia",
        # tarifas
        "tarifa_te"             : "tarifa_te",
        "tarifa_tusd"           : "tarifa_tusd",
        "tarifa_demanda"        : "tarifa_demanda",
        # bandeira
        "tipo_bandeira"         : "tipo_bandeira_tarifaria",
        "valor_bandeira"        : "valor_bandeira",
        # financeiro
        "total_rs"              : "valor_total_fatura",
        "rs_consumo"            : "valor_energia_ativa",
        "rs_ponta"              : "valor_energia_ativa",
        "valor_demanda"         : "valor_demanda",
        "valor_reativo_exc"     : "valor_energia_reativa_excedente",
        "valor_demanda_reativa_exc": "valor_demanda_reativa_excedente",
        "cip"                   : "valor_cip_cosip",
        "valor_encargos"        : "valor_encargos",
        "valor_outros"          : "valor_outros_itens",
        "valor_cde"             : "valor_cde",
        "valor_proinfa"         : "valor_proinfa",
        "valor_ess"             : "valor_ess",
        # tributos
        "icms_base"             : "icms_base_calculo",
        "icms_aliq"             : "icms_aliquota",
        "icms_valor"            : "icms_valor",
        "pis_aliq"              : "pis_aliquota",
        "pis_valor"             : "pis_valor",
        "cofins_aliq"           : "cofins_aliquota",
        "cofins_valor"          : "cofins_valor",
        # indicadores
        "ind_tarifa_social"     : "indicador_tarifa_social",
        "ind_cliente_rural"     : "indicador_cliente_rural",
        "ind_mercado_livre"     : "indicador_mercado_livre",
        "ind_gd"                : "indicador_geracao_distribuida",
        "ind_leitura_real"      : "indicador_leitura_real",
        "ind_leitura_estim"     : "indicador_leitura_estimativa",
        "ind_troca_medidor"     : "indicacao_troca_medidor",
        "ind_impede_leitura"    : "indicacao_impedimento_leitura",
        # GD
        "kwh_injet"             : "energia_injetada_kwh",
        "kwh_compensado"        : "energia_compensada_kwh",
        "saldo_credito"         : "saldo_credito_energia",
        # perda
        "perda_transf_pct"      : "perda_transformacao_percentual",
    }

    # uid é obrigatório — é a chave única da tabela
    if not uid:
        log.warning(f"  [dados_extraidos] fatura {fatura_id} sem uid, ignorando gravação")
        return False

    cols  = ["uid", "fonte_extracao"]
    vals  = [uid, fonte]
    upd   = ["fonte_extracao = VALUES(fonte_extracao)",
             "atualizado_em = CURRENT_TIMESTAMP"]
    seen  = {"uid"}

    for campo_py, col_db in mapa.items():
        v = campos.get(campo_py)
        if v is None:
            continue
        if col_db in seen:
            continue
        cols.append(col_db)
        vals.append(v)
        upd.append(f"`{col_db}` = VALUES(`{col_db}`)")
        seen.add(col_db)

    # Datas como string DD/MM/YYYY → YYYY-MM-DD
    for campo_py, col_db in [
        ("dt_leit_ant", "data_leitura_anterior"),
        ("dt_leit_atu", "data_leitura_atual"),
    ]:
        v = campos.get(campo_py)
        if v:
            d = _dt(v)
            if d:
                cols.append(col_db)
                vals.append(d)
                upd.append(f"`{col_db}` = VALUES(`{col_db}`)")

    # Histórico como JSON
    for campo_py, col_db in [
        ("historico",         "historico_consumo_12_meses"),
        ("historico_demanda", "historico_demanda_12_meses"),
    ]:
        v = campos.get(campo_py)
        if v:
            cols.append(col_db)
            vals.append(_json.dumps(v, ensure_ascii=False))
            upd.append(f"`{col_db}` = VALUES(`{col_db}`)")

    # link_fatura, cod_empresa e codigo_uc — da fonte
    if link:
        cols.append("link_fatura"); vals.append(link)
        upd.append("`link_fatura` = VALUES(`link_fatura`)")
    if cod_empresa is not None:
        cols.append("cod_empresa"); vals.append(cod_empresa)
        upd.append("`cod_empresa` = VALUES(`cod_empresa`)")
    # UC da fonte sempre prevalece sobre o que o OCR extraiu
    if uc and "codigo_uc" not in seen:
        cols.append("codigo_uc"); vals.append(uc)
        upd.append("`codigo_uc` = VALUES(`codigo_uc`)")

    if len(cols) <= 2:
        return False

    placeholders = ", ".join(["%s"] * len(cols))
    col_names    = ", ".join(f"`{c}`" for c in cols)
    upd_clause   = ", ".join(upd)

    try:
        cur.execute(
            f"INSERT INTO {TBL_FDE} ({col_names}) "
            f"VALUES ({placeholders}) "
            f"ON DUPLICATE KEY UPDATE {upd_clause}",
            vals,
        )
        conn.commit()
        return True
    except Exception as e:
        log.warning(f"    [dados_extraidos] fatura {fatura_id}: {e}")
        return False


# ─── Espelho da ORIGEM (sgeeasy) → FDE ───────────────────────────────────────
def _gravar_mirror_origem(cur, conn, uid, row):
    """Espelha campos da Faturas_Registradas_Cache (origem) na FDE, por uid.
    - Cadastrais (mercado, tensão, ligação, NF, UCs, datas, razão): origem VENCE (SET).
    - Medição/demanda/reativo/GD: COALESCE — o extrator validado vence; origem preenche o gap.
    Resolve os campos que vinham vazios no relatório (mercado, tp_tensao_origem,
    tipo_ligacao, numero_nf, kwh_total, rs por posto, demanda, injeção, etc.)."""
    if not uid or not row:
        return
    CAP = 1_000_000_000  # teto de sanidade kWh (leitura concatenada vira lixo)
    def _n(v):
        try:
            f = float(v)
            return None if (f != f or f > CAP) else f
        except (TypeError, ValueError):
            return None
    def _s(v):
        v = (str(v).strip() if v is not None else "")
        # limpa artefato da origem: `00002167569 / 'X / "X no início (nunca é legítimo)
        v = v.lstrip("`'\" ").strip()
        return v or None
    import json as _json
    ufer = sum(x for x in (_n(row.get("UFER_Ponta")), _n(row.get("UFER_FPonta")), _n(row.get("UFER_Reservado"))) if x) or None

    # lê os valores ATUAIS (do extrator) p/ VALIDAR contra a origem
    rc = conn.cursor(dictionary=True)
    try:
        rc.execute(f"SELECT consumo_ativo_ponta_kwh ap, consumo_ativo_fponta_kwh afp, "
                   f"consumo_ativo_reservado_kwh ar, valor_total_fatura vt FROM {TBL_FDE} WHERE uid=%s", (uid,))
        a = rc.fetchone() or {}
    finally:
        rc.close()

    flags = []
    def valida(campo, ext, orig):
        """Valida SEM confiar na origem (origem é mal-tratada). O extrator (leitura
        do PDF) é a referência; a origem NUNCA sobrescreve. Regras:
          - batem (±5%)            → confirmado (ok).
          - extrator vazio/0       → preenche da origem, mas marca NAO_VALIDADO (candidato).
          - divergem               → MANTÉM extrator, marca DIVERGE_revisar (pendente).
        A resolução real (qual está certo) é por PROVA — fórmula leitura×K / SEFAZ —
        ou revisão humana; nunca por 'a origem disse'."""
        ext = _n(ext)
        if ext is None or ext == 0:
            if orig is None:
                return ("keep", None)
            flags.append({"campo": campo, "origem": orig, "extrator": ext, "status": "ORIGEM_NAO_VALIDADO"})
            return ("set", orig)                       # preenche gap (candidato, não confirmado)
        if orig is None:
            return ("keep", None)                      # extrator tem, origem não → mantém extrator
        if abs(ext - orig) <= max(0.5, 0.05 * abs(orig)):
            return ("keep", None)                      # batem → confirmado
        flags.append({"campo": campo, "origem": orig, "extrator": ext, "status": "DIVERGE_revisar"})
        return ("keep", None)                          # diverge → MANTÉM extrator, só sinaliza

    # campos cadastrais: origem VENCE (set direto)
    sets, vals = [], []
    cad = [
        ("mercado", _s(row.get("Mercado"))), ("tp_tensao_origem", _s(row.get("Tp_Tensao"))),
        ("tipo_ligacao", _s(row.get("Classe_Tarifaria"))),
        ("ucs_anteriores", _s(row.get("UCs_Anteriores"))), ("razao_social", _s(row.get("RAZAO_SOCIAL"))),
        ("empresa_nome", _s(row.get("Empresa"))), ("data_proxima_leitura", row.get("DATA_PROXIMA_LEITURA")),
        ("rs_kwh_ponta", _n(row.get("RS_KWH_Ponta"))), ("rs_kwh_fponta", _n(row.get("RS_KWH_FPonta"))),
        ("rs_kwh_reservado", _n(row.get("RS_KWH_Reservado"))), ("kwh_total", _n(row.get("KWH_Total"))),
        ("rs_kwh_total", _n(row.get("RS_KWH_Total"))),
    ]
    for col, val in cad:
        if val is not None:
            sets.append(f"`{col}` = %s"); vals.append(val)
    # cadastrais que o extrator pode ter — COALESCE
    for col, val in [("cpf_cnpj", _s(row.get("CNPJ_Fatura"))), ("distribuidora", _s(row.get("Concessionaria"))),
                     # numero_nf: o PDF (extrator) tem os zeros à esquerda; origem (NroNF) os perde.
                     # COALESCE → extrator vence; origem só preenche se vazio.
                     ("numero_nf", _s(row.get("NroNF"))),
                     ("cnpj_distribuidora_filial", _s(row.get("CNPJ_Concessionaria"))),
                     ("numero_medidor", _s(row.get("NroMedidor"))),
                     ("data_leitura_anterior", row.get("Dt_Leitura_Anterior")),
                     ("data_leitura_atual", row.get("Dt_Leitura_Atual")), ("dias_faturados", _n(row.get("Qtd_Dias"))),
                     ("demanda_contratada_ponta_kw", _n(row.get("KW_Contratada_Ponta"))),
                     ("demanda_contratada_fponta_kw", _n(row.get("KW_Contratada_FPonta"))),
                     # demanda_faturada NÃO vem mais da origem (KW_Registrada vem errado/arredondado);
                     # agora é a demanda MEDIDA do PDF (itens_fatura), populada no atualizar_colunas.
                     ("consumo_reativo_excedente_kvarh", ufer),
                     ("energia_injetada_kwh", _n(row.get("KWH_Total_Injet")))]:
        if val is not None:
            sets.append(f"`{col}` = COALESCE(`{col}`, %s)"); vals.append(val)
    # MEDIÇÃO VALIDADA (extrator × origem)
    for col, ext, orig in [
        ("consumo_ativo_ponta_kwh", a.get("ap"), _n(row.get("KWH_Ponta"))),
        ("consumo_ativo_fponta_kwh", a.get("afp"), _n(row.get("KWH_FPonta"))),
        ("consumo_ativo_reservado_kwh", a.get("ar"), _n(row.get("KWH_Reservado"))),
        ("valor_total_fatura", a.get("vt"), _n(row.get("RS_Total_Fatura"))),
    ]:
        acao, novo = valida(col, ext, orig)
        if acao == "set":
            sets.append(f"`{col}` = %s"); vals.append(novo)

    sets.append("revisar_campos = %s"); vals.append(_json.dumps({"flags": flags}, ensure_ascii=False, default=str))
    sets.append("revisao_status = %s")
    vals.append("pendente" if any(("DIVERGE" in f["status"] or "NAO_VALIDADO" in f["status"]) for f in flags) else "ok")
    try:
        cur.execute(f"UPDATE {TBL_FDE} SET {', '.join(sets)} WHERE uid=%s", (*vals, uid))
        conn.commit()
    except Exception as e:
        log.warning(f"  [mirror/validador origem] uid={uid}: {e}")


# ─── Gravar textos brutos em FATURA_DADOS_EXTRAIDOS ──────────────────────────

def _gravar_textos_fde(cur, conn, uid: str,
                        texto_plumber: str = None,
                        texto_markdown: str = None,
                        texto_ocr: str = None,
                        texto_bbox: str = None):
    """Salva os textos brutos em FATURA_DADOS_EXTRAIDOS via INSERT ... ON DUPLICATE KEY UPDATE.
    Funciona mesmo quando ainda nao existe linha em FDE para esse uid."""
    if not uid:
        return
    cols         = ["uid"]
    placeholders = ["%s"]
    vals         = [uid]
    upd          = []

    if texto_plumber:
        cols.append("texto_plumber");      placeholders.append("%s");    vals.append(texto_plumber)
        cols.append("plumber_gerado_em");  placeholders.append("NOW()")
        upd.append("texto_plumber = VALUES(texto_plumber)")
        upd.append("plumber_gerado_em = NOW()")
    if texto_markdown:
        cols.append("texto_markdown");      placeholders.append("%s");    vals.append(texto_markdown)
        cols.append("markdown_gerado_em");  placeholders.append("NOW()")
        upd.append("texto_markdown = VALUES(texto_markdown)")
        upd.append("markdown_gerado_em = NOW()")
    if texto_ocr:
        cols.append("texto_ocr");      placeholders.append("%s");    vals.append(texto_ocr)
        cols.append("ocr_gerado_em");  placeholders.append("NOW()")
        upd.append("texto_ocr = VALUES(texto_ocr)")
        upd.append("ocr_gerado_em = NOW()")
    if texto_bbox:
        cols.append("texto_bbox");      placeholders.append("%s");    vals.append(texto_bbox)
        cols.append("texto_bbox_gerado_em");  placeholders.append("NOW()")
        upd.append("texto_bbox = VALUES(texto_bbox)")
        upd.append("texto_bbox_gerado_em = NOW()")

    if not upd:
        return
    try:
        sql = (
            f"INSERT INTO {TBL_FDE} "
            f"({', '.join(f'`{c}`' for c in cols)}) "
            f"VALUES ({', '.join(placeholders)}) "
            f"ON DUPLICATE KEY UPDATE {', '.join(upd)}"
        )
        cur.execute(sql, vals)
        conn.commit()
    except Exception as e:
        log.warning(f"    [textos_fde] uid={uid}: {e}")


# ─── Gravar campos no banco ───────────────────────────────────────────────────

def gravar_campos(cur, conn, fid: int, campos: dict, row: dict):
    """Grava campos extraídos em FATURA_DADOS_EXTRAIDOS.
    Não escreve mais em Faturas_Registradas_Cache (essa tabela é apenas fonte do Link)."""
    # Usa mes_ref da fonte se não foi extraído do PDF
    if not campos.get("mes_ref") and row.get("Mes_Ref"):
        campos["mes_ref"] = str(row["Mes_Ref"]).strip()

    gravou = gravar_dados_extraidos(
        cur, conn, fid, campos, fonte="regex",
        uid=str(row.get("UID") or "").strip() or None,
        link=str(row.get("Link") or "").strip() or None,
        cod_empresa=row.get("Cod_Empresa"),
        uc=str(row.get("UC") or "").strip() or None,
    )
    if gravou:
        nao_nulos = [k for k, v in campos.items() if v is not None and v != [] and v != {}]
        log.info(f"    Campos gravados em FDE ({len(nao_nulos)}): {nao_nulos[:15]}{'...' if len(nao_nulos) > 15 else ''}")
    else:
        log.info("    Sem campos novos para gravar em FDE.")


# ─── Fallback GPT: extrai campos quando os parsers falham ────────────────────

_OPENAI_KEY   = os.getenv("OPENAI_API_KEY", "")
# Default trocado de gpt-4o-mini → gpt-4.1-mini (2026-05): melhor extração de
# leituras/constantes em layouts variados de fatura, mesmo custo aproximado.
_OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")

_GPT_SYSTEM = """Você é um extrator de dados de faturas de energia elétrica brasileiras.
Receberá o texto de uma fatura e deverá retornar SOMENTE um JSON válido com os campos abaixo.
Use null para campos não encontrados. Números: float com ponto decimal. Datas: "DD/MM/YYYY".
Indicadores booleanos: 1 (verdadeiro) ou null (não detectado).

⚠ PRIORIDADE MÁXIMA — campos de MEDIÇÃO (essenciais para auditoria F01/F02):
  • leit_ant_p, leit_atu_p (leituras anterior/atual do posto PONTA do medidor)
  • leit_ant_fp, leit_atu_fp (leituras anterior/atual do posto FORA PONTA)
  • constante_p, constante_fp, constante_k (multiplicadores do medidor)
  • kwh_ponta, kwh_fponta (consumo por posto)

Esses campos aparecem no QUADRO DE MEDIÇÃO da fatura, em formatos variados por
distribuidora. Procure linhas com:
  • "LEITURA ANTERIOR / LEITURA ATUAL / CONSUMO" (tabela do medidor)
  • "PONTA ... FORA PONTA ... CONSTANTE"
  • "CONST. ATIVO N,NNNNN" ou "CONST. POTENCIA N,NNNNN" (Enel SP)
  • "K = N,NN" ou "Constante: N,NN"
  • Padrão numérico: leit_ant_grande seguido de leit_atu_grande seguido de kwh

NÃO confundir LEITURAS (números grandes do medidor, 4-9 dígitos) com CONSUMO
(kWh consumidos, normalmente menores). NUNCA inventar valores — se não encontrar,
retornar null.

⛔ REGRAS ANTI-CONFUSÃO CRÍTICAS (NÃO REPETIR ERROS OBSERVADOS):

(A) total_rs vs kwh_* — UNIDADES DIFERENTES, NUNCA SÃO IGUAIS:
  • total_rs = VALOR EM REAIS (R$), normalmente entre R$ 100 e R$ 1.000.000
  • kwh_ponta / kwh_fponta = CONSUMO em kWh, normalmente entre 100 e 500.000 kWh
  • Se você for retornar kwh_ponta = 703607.46 E total_rs = 703607.46, está ERRADO.
    Esse é o valor R$ — em ENEL SP A4 grandes, o R$ aparece em "TOTAL A PAGAR" e o
    kWh aparece em "CONSUMO MEDIDO" ou "CONSUMO FATURADO". São tabelas DIFERENTES.
  • Validação: se kwh > total_rs/2 É SUSPEITO. Releia o texto.

(B) kwh_ponta vs kwh_fponta — POSTOS SEGREGADOS:
  • Em Grupo A4 (Verde/Azul), há SEMPRE dois postos: Ponta (P) e Fora Ponta (FP).
  • Devolva kwh_ponta E kwh_fponta SEPARADAMENTE, NÃO soma.
  • Se a fatura tem múltiplas linhas FP (cap + indu em ENEL SP), some SOMENTE
    as FP entre si pra kwh_fponta. Não misture com kwh_ponta.
  • Se kwh_total > 1.000.000 com cliente típico (varejo/hospital), provável
    erro: você somou os postos. Releia.

(C) icms_valor vs total_rs — TRIBUTO vs VALOR FATURA:
  • icms_valor = só o ICMS calculado (R$), aliq ~17-25% × base
  • total_rs = valor TOTAL da fatura (inclui ICMS, energia, encargos)
  • Eles NUNCA são iguais. Se você devolver icms_valor = total_rs, ERRADO.

(D) Validação cruzada antes de devolver:
  • icms_valor / total_rs deveria ser entre 0.10 e 0.30 (10-30%)
  • kwh_ponta + kwh_fponta deveria ser proporcional a total_rs/tarifa
  • Se não bate ordem de grandeza → marque o campo como null em vez de chutar.

(E) INDICADORES BOOLEANOS (8 campos com prefixo "ind_"):
  Esses campos NUNCA devem ficar null. SEMPRE devolva 0 ou 1.
  • ind_tarifa_social, ind_cliente_rural, ind_mercado_livre, ind_gd,
    ind_leitura_real, ind_leitura_estim, ind_troca_medidor, ind_impede_leitura
  Default = 0 (false). Use 1 SÓ quando houver evidência explícita na fatura.
    - ind_cliente_rural = 1 se classe "RURAL" ou subgrupo B2/B5 aparece
    - ind_mercado_livre = 1 se aparecer "TUSD Livre", "Cliente Livre" ou "ACL"
    - ind_gd = 1 se houver linhas SCEE/GD/Compensada/Injetada
    - ind_leitura_real = 1 se "Origem da Leitura: Lida/Real"
    - ind_leitura_estim = 1 se "Origem: Estimativa/Calculada/Média"
    - ind_troca_medidor = 1 se "troca de medidor" no histórico ou aviso
    - ind_impede_leitura = 1 se "impedimento de leitura" aparece

(F3) classe_consumidor — LISTA FECHADA OBRIGATÓRIA:
  Devolva EXATAMENTE um dos 8 valores ANEEL (todo MAIÚSCULO, sem acento):
    "COMERCIAL", "RESIDENCIAL", "INDUSTRIAL", "RURAL",
    "PODER PUBLICO", "ILUMINACAO PUBLICA", "SERVICO PUBLICO", "CONSUMO PROPRIO"
  ⚠️ NUNCA concatene texto adjacente da fatura. NUNCA inclua:
    - "Subclasse", "OUTROS SERVICOS E OUTRAS ATIVIDADES" (isso é SUBCLASSE, não CLASSE)
    - "Data de emissao", "Tipo de Fornecimento", "Modalidade Tarifaria"
    - "C Reservado ao Fisco" (rótulo de tabela)
    - Códigos "03-COMERCIAL" (sem o "03-")
    - Variantes "COMERC.", "COMERCIO", "COMÉRCIO" → normalize para "COMERCIAL"
  Padrões de detecção:
    - "Servico publico" / "Poder publico" / "Iluminacao publica" → seus respectivos
    - "Comercial", "Comércio", "Serviços e outras atividades" → COMERCIAL
    - "Residencial" → RESIDENCIAL
    - "Industrial" → INDUSTRIAL
    - "Rural" / subgrupo B2/B5 → RURAL

(F2) TARIFA TE vs TUSD — colunas distintas:
  tarifa_te = R$/kWh da ENERGIA (TE / Energia ACL / Componente Encargo)
  tarifa_tusd = R$/kWh da DISTRIBUIÇÃO (TUSD / Uso Sist Distr / Componente Fio)
  Ambas LÍQUIDAS (sem tributos). NUNCA tarifa_te = tarifa_tusd.
  Em B convencional: pode haver linhas "(0D) Consumo TE" e "(0E) Consumo TUSD" —
  extrair tarifa de CADA.
  NUNCA deixar tarifa_te = tarifa_tusd se as duas tarifas existirem.
  Se só uma das duas aparece, deixar a outra null (não chutar).

(F) codigo_uc vs numero_instalacao:
  codigo_uc = ID curto da UC (7-10 dígitos, labels "UC:", "Unidade Consumidora").
  numero_instalacao = ID longo (11-13 dígitos, labels "Nº Instalação", "Conta-Contrato").
  Se só houver UM identificador, preencher AMBOS com o mesmo valor.

{
  "numero_fatura": null,
  "numero_instalacao": null,
  "codigo_uc": null,
  "nome_cliente": null,
  "cpf_cnpj": null,
  "classe_consumidor": null,
  "subgrupo_tarifario": null,
  "modalidade_tarifaria": null,
  "distribuidora": null,
  "grupo_tarifario": null,
  "tensao_fornecimento": null,
  "numero_medidor": null,
  "tipo_medicao": null,

  "dt_leit_ant": null,
  "dt_leit_atu": null,
  "dt_proxima": null,
  "dt_emissao": null,
  "vencimento": null,
  "dias": null,
  "mes_ref": null,

  "leit_ant_p": null,
  "leit_atu_p": null,
  "leit_ant_fp": null,
  "leit_atu_fp": null,
  "leit_ant_reativa": null,
  "leit_atu_reativa": null,
  "leit_demanda_p": null,
  "leit_demanda_fp": null,

  "constante_p": null,
  "constante_fp": null,
  "constante_k": null,
  "rtp": null,

  "kwh_total": null,
  "kwh_fponta": null,
  "kwh_ponta": null,
  "kwh_reativo": null,
  "kwh_reativo_exc": null,
  "kvar_reativo_exc": null,

  "demanda_fat_p": null,
  "demanda_fat_fp": null,
  "demanda_cont_p": null,
  "demanda_cont_fp": null,

  "fator_carga": null,
  "fator_potencia": null,

  "tarifa_te": null,
  "tarifa_tusd": null,
  "tarifa_kwh": null,
  "tarifa_ponta": null,
  "tarifa_demanda": null,
  "preco_unit_c_trib": null,

  "tipo_bandeira": null,
  "valor_bandeira": null,

  "total_rs": null,
  "rs_consumo": null,
  "rs_ponta": null,
  "valor_demanda": null,
  "valor_reativo": null,
  "valor_reativo_exc": null,
  "valor_demanda_reativa_exc": null,
  "cip": null,
  "valor_encargos": null,
  "valor_outros": null,
  "valor_cde": null,
  "valor_proinfa": null,
  "valor_ess": null,

  "icms_base": null,
  "icms_aliq": null,
  "icms_valor": null,
  "pis_base": null,
  "pis_aliq": null,
  "pis_valor": null,
  "cofins_aliq": null,
  "cofins_valor": null,

  "ind_tarifa_social": 0,
  "ind_cliente_rural": 0,
  "ind_mercado_livre": 0,
  "ind_gd": 0,
  "ind_leitura_real": 0,
  "ind_leitura_estim": 0,
  "ind_troca_medidor": 0,
  "ind_impede_leitura": 0,

  "kwh_injet": null,
  "kwh_compensado": null,
  "saldo_credito": null,
  "perda_transf_pct": null,

  "historico": [],
  "historico_demanda": [],

  "composicao_base_icms": null,
  "composicao_base_pis_cofins": null,
  "observacoes_fatura": null,
  "informacoes_operacionais": null,
  "itens_cobrados": []
}

Para "historico": lista de {"mes": <int 1-12>, "ano": <int>, "kwh": <float>}.
Para "historico_demanda": lista de {"mes": <int>, "ano": <int>, "kw": <float>}.

═══════════════════════════════════════════════════════════════════════════
⚠ CAMPO MAIS IMPORTANTE: "itens_cobrados" (lista detalhada da fatura)
═══════════════════════════════════════════════════════════════════════════
Procure no PDF a seção "FATURAMENTO" / "DESCRIÇÃO" / "DETALHAMENTO" / "ITENS
COBRADOS" / "DEMONSTRATIVO" — a TABELA principal onde cada linha é um item
cobrado/abatido. Liste TODOS os itens. Cada um vira UM objeto na lista:

  {
    "codigo": "0806",                  // código contábil/item (Enel SP: 0101..0999, outros: pode ser ID interno)
    "descricao": "PARC.ART.323 PC 5/18", // texto literal como aparece na fatura
    "qtd": 1551,                       // quantidade (kWh, kW, kVArh, ou null)
    "unidade": "kWh",                  // "kWh" | "kW" | "kVArh" | "MWh" | "UN" | null
    "tarifa": 1.0,                     // preço unitário R$ por unidade (null se não aplicável)
    "valor_rs": 1551.94,               // valor TOTAL do item em R$ (positivo ou negativo)
    "icms_aliq": 0.18,                 // alíquota ICMS aplicada nesse item (0..1) ou null
    "categoria": "parcelamento_art323", // VEJA TABELA DE CATEGORIAS ABAIXO
    // Campos opcionais (preencher só quando aplicável):
    "parcela_x": 5,                    // X em PC.X/Y (só categoria parcelamento_*)
    "parcela_y": 18,                   // Y em PC.X/Y
    "mes_origem": "01/2025"            // mês origem do refaturamento (se for parcelamento_art113)
  }

CATEGORIAS válidas (escolha UMA por item):
  • "energia_ativa"          — consumo TE, TUSD, ponta, fora ponta (cods 0101-0299 Enel)
  • "demanda_kw"             — demanda faturada, contratada, ultrapassagem (cods 0601-0699)
  • "reativo"                — kVArh, demanda reativa excedente
  • "parcelamento_art323"    — PC.X/Y formato "PC.5/22", código 0806 Enel SP, REN 1000/414,
                              refaturamento ANEEL Art.323. EXIGE: descrição com "ART.323" OU
                              "PARC.ART.323" OU "PC.X/Y" onde X e Y são parcelas.
                              ❌ NÃO confundir com "APCEI XX/2025" (Apuração APCEI =
                                 perda/compensação técnica de ENERGISA, NÃO é parcelamento)
                              ❌ NÃO confundir com "PC 0X/Y" em CREDITO/DEBITO TUSD APCEI
  • "parcelamento_art113"    — refaturamento Art.113, consumo acumulado, faturamento a menor
  • "encargo_parcelamento"   — MULTA/JUROS/ATUALIZAÇÃO MONETÁRIA sobre PC.X/Y (cods 0804/0805).
                              EXIGE: ser um encargo aplicado SOBRE uma parcela Art.323 existente
                              ❌ NÃO usar para créditos APCEI da ENERGISA
  • "compensacao_devolucao"  — DEVOLUÇÃO REAL: códigos como "DEVOL.PGTO DUPLICIDADE",
                              "Restituição de Pagamento", "Devolução" puro. Indica que a
                              distribuidora ESTÁ DEVOLVENDO um pagamento. Sinal forte.
  • "compensacao_gd"         — Energia compensada/injetada por Geração Distribuída
                              (códigos com "GD", "SCEE", "Injetada", "Compensada por UC")
                              É LEGÍTIMA, não indica erro de fatura.
  • "compensacao_subvencao"  — "Crédito Subvenção Tarifária", "Crédito ACR", desconto comercial
  • "compensacao_apcei"      — APCEI da ENERGISA (Apuração e Compensação de Perdas):
                              "CREDITO TUSD KW-APCEI", "DEBITO TUSD KWH PONTA-APCEI", etc.
  • "compensacao_dic"        — Compensação por DIC/FIC/DICRI (qualidade de fornecimento)
  • "bandeira"               — bandeira tarifária verde/amarela/vermelha
  • "iluminacao_publica"     — CIP, COSIP, contribuição municipal
  • "encargo_setorial"       — CDE, PROINFA, ESS, EER, encargos federais
  • "tributo"                — ICMS, PIS, COFINS quando aparecem como linhas separadas
  • "desconto"               — descontos comerciais não-subvenção
  • "ajuste"                 — ajuste de leitura, correção retroativa
  • "outro"                  — qualquer outra coisa não classificável

🎯 REGRA CRÍTICA: "parcelamento_art323" SÓ se a descrição tiver "ART.323", "PARC.ART",
"REN 1000", "REN 414", ou formato "PC.X/Y" onde Y é um inteiro entre 2 e 60 (número de
parcelas do refaturamento). Códigos com "APCEI", "Crédito TUSD", "Subvenção" são compensação
técnica/comercial, NUNCA Art.323.

═══════════════════════════════════════════════════════════════════════════
🗺️  MAPA DE LOCALIZAÇÃO POR LAYOUT — onde achar os itens em cada distribuidora
═══════════════════════════════════════════════════════════════════════════

▸ ENEL SP / ENEL RIO / ENEL CE — ELEKTRO
  Tabela começa após cabeçalho: "Itens de Fatura Unid. Quant. Preço unit..."
  Formato típico: "CONSUMO ATIVO PONTA TUSD KWH 940,249 0,62112 584,01 ..."
  Tem "Subtotal Faturamento" e "Subtotal Outros" — Outros NEG = compensação ativa.
  Códigos contábeis 4 dígitos (0101, 0102, 0601, 0806, 0999...).
  Art.323 aparece literalmente: "PARC.ART.323 PC X/Y" ou "PC.X/Y-FATURA-MM/AAAA-ART.323 REN 1000"
  Compensação: linhas com valor negativo no bloco "Outros" ou "BENEFÍCIO TARIFÁRIO LÍQUIDO"

▸ LIGHT
  Tabela começa após: "Itens de fatura Unid. Quant. Preço unit..."
  Formato típico: "Componente Fio kW HFP kW 80 39,48 3.158,58 ..."
  Subtotais "Desconto Comp. Fio HFP" e "Desconto Comp. Encargo HP" → categoria "desconto"
  "Contrib Ilum Pública Municipal" → categoria "iluminacao_publica"
  "PIS/COFINS da subvenção/descon" e "ICMS da subvenção/desconto" → categoria "tributo"
  Não usa códigos contábeis numéricos; use a descrição literal.

▸ CPFL PAULISTA / PIRATININGA / SANTA CRUZ
  Tabela "Detalhamento da Fatura" ou "ITENS DE FATURAMENTO"
  Itens "ENERGIA TE", "ENERGIA TUSD", "Demanda TUSD", "DEMANDA TE"
  "Devolução" = categoria "compensacao_devolucao" (sinal forte de erro corrigido)
  "Crédito Subvenção Tarifaria - TUSD" = categoria "compensacao_subvencao"

▸ CEMIG
  Tabela "FATURAMENTO" com colunas Quant/Tarifa/Valor
  Identifica subgrupo no início: "A4 / Verde"
  Itens: "Consumo TE Ponta", "Consumo TUSD F Ponta", "Demanda TUSD Faturada"
  Histórico em tabela separada (até 13 meses)

▸ ENERGISA (MS / MT / PB / SE / MR)
  Tabela após "Itens da Fatura Unid. Quant. com tributos Valor..."
  ⚠️ APCEI é COMPENSAÇÃO TÉCNICA, NUNCA Art.323!
     Linhas como "CREDITO TUSD KW-APCEI 09/2025" ou "DEBITO TUSD KWH PONTA-APCEI 07/2025"
     → categoria "compensacao_apcei"
     → "09/2025" NÃO é PC.9/2025, é o mês de competência!
  Art.323 real na ENERGISA aparece como "Parcela Art. 321/323 0002 / 0002" ou similar com
  texto "Art" explícito + dois números separados por "/" (X/Y).

▸ NEOENERGIA (COELBA / CELPE / COSERN / CEB)
  Tabela "Faturamento" / "Itens de Fatura"
  Itens com colunas Quant/Preço/Valor
  Compensação por DIC: "Comp.DIC Mês MM/AA" = categoria "compensacao_dic"
  Energia compensada GD em UCs separadas: categoria "compensacao_gd"

▸ EQUATORIAL (PA / MA / AL / GO / PI / RS)
  Tabela "Itens da Fatura"
  Energia GD: "Energia Inj. oUC/mUC MM/YYYY oPT/mPT (kWh)" = "compensacao_gd"
  "Consumo Compensado (kWh)" = "compensacao_gd"
  "INJEÇÃO SCEE - UC XXXX - GD I" = "compensacao_gd"

▸ EDP SP / EDP ES
  Tabela "Demonstrativo da Fatura"
  "Dedução de Energia ACL" = "compensacao" (mercado livre, não erro)
  "Crédito Subvenção Tarifária" = "compensacao_subvencao"

▸ CELESC
  Tabela "Detalhamento da Fatura"
  Itens "Consumo Ponta/Fora Ponta", "Demanda Faturada P/FP"
  Geralmente Grupo A (industrial/comercial)

▸ RGE / COPEL
  Tabela "Itens de Fatura"
  Art.323 RGE: "Parcela Art. 321/323 0002 / 0002"

🎯 DICA FINAL — para classificar item em "parcelamento_art323", APLIQUE OS 3 TESTES:
  1. Descrição contém "ART.323" OU "Art. 321/323" OU "PARC.ART" OU "REN 1000" OU "REN 414"?
  2. OU descrição tem formato "PC.X/Y" + texto "FATURA-MM/AAAA"?
  3. OU descrição tem "Parcela X/Y" + "Art"?
  Se NENHUM dos 3 → não é parcelamento_art323, mesmo que tenha "X/Y" ou "MM/AAAA" na descrição.

═══════════════════════════════════════════════════════════════════════════
🌞 GD/SCEE e ARMADILHAS DE UNIDADE
═══════════════════════════════════════════════════════════════════════════

Sufixos no rótulo de injeção indicam ORIGEM do crédito:
  mPT (mesma UC, mesmo posto) / oPT (mesma UC, outro posto) /
  oUC (outra UC do titular) / mUC / uG (usina geradora)
→ categoria item: "compensacao_gd"; modalidade no observacoes_fatura.

ARMADILHAS DE UNIDADE:
  • LIGHT A4: "Energia Reativa kWh HFP" — é kVArh, ignorar "kWh"
  • CPFL: "Saldo em Energia" impresso "kW" — é kWh
  • LIGHT 2025: consumo em "MW" → multiplicar por 1.000
  • NEOENERGIA A: reativo SEPARADO por posto ("Na Ponta"/"Fora de Ponta") — somar

Liste TODOS os itens — não omita nada da seção FATURAMENTO. Use exatamente o
valor "valor_rs" como aparece (com sinal: negativo se for crédito/devolução).

═══════════════════════════════════════════════════════════════════════════
COMPOSIÇÃO DAS BASES E OBSERVAÇÕES (campos descritivos)
═══════════════════════════════════════════════════════════════════════════

▸ "composicao_base_icms" — texto descritivo de quais itens compõem a base ICMS
    Ex: "TE + TUSD + Bandeira Vermelha + Encargos"

▸ "composicao_base_pis_cofins" — idem para PIS/COFINS

▸ "observacoes_fatura" — concatenação das mensagens/avisos no rodapé da fatura
    Ex: "Próxima leitura: 15/03/2026. Bandeira VERDE."

▸ "informacoes_operacionais" — eventos operacionais detectados
    Ex: "FATURAMENTO POR MÉDIA - mês com leitura impedida"
    Ex: "TROCA DE MEDIDOR em 12/02/2026"
    Ex: "FATURAMENTO COMPLEMENTAR Art.113 referente 01/2024 a 12/2024"

═══════════════════════════════════════════════════════════════════════════
⚠ DEFINIÇÕES IMPORTANTES (não confundir os campos abaixo):
═══════════════════════════════════════════════════════════════════════════

▸ "distribuidora" — nome comercial CURTO da concessionária. NÃO use razão social.
    ✅ Bom: "ENEL SP", "LIGHT", "CEMIG", "CPFL PAULISTA", "ELEKTRO", "CELESC",
            "NEOENERGIA COELBA", "EQUATORIAL PA", "EDP SP", "ENERGISA MS"
    ❌ Ruim: "ELEKTRO REDES S.A.", "ENEL DISTRIBUIDORA SÃO PAULO LTDA",
            "Companhia Energética de Minas Gerais"

▸ "grupo_tarifario" — APENAS "A" ou "B". Nada mais.
    Regra: Subgrupo A1/A2/A3/A4/AS → grupo "A". Subgrupo B1/B2/B3/B4 → grupo "B".
    ❌ Ruim: "TRIFASICO" (isso é tensão_fornecimento), "ATEND. ESPECIAL".

▸ "subgrupo_tarifario" — uma das siglas: "A1","A2","A3","A3a","A4","AS","B1","B2","B3","B4a","B4b".
    Não confundir com modalidade.

▸ "modalidade_tarifaria" — uma das opções:
    "CONVENCIONAL", "BRANCA", "VERDE", "AZUL", "HORÁRIA VERDE", "HORÁRIA AZUL"
    Procure por "MODALIDADE" no texto. Se ver "HORO-SAZONAL VERDE" → "HORÁRIA VERDE".

▸ "tensao_fornecimento" — em formato curto: "MONOFASICO", "BIFASICO", "TRIFASICO",
    "13,8 KV", "23 KV", "69 KV", etc. NÃO use isso em grupo_tarifario.

▸ "cpf_cnpj" — apenas dígitos do CNPJ/CPF. Remova máscara/asteriscos.
    Se aparecer "***********84/0001-30" → ignore parte mascarada e retorne null
    OU extraia só dígitos visíveis (mas se >50% mascarado, null).

▸ "tarifa_te" e "tarifa_tusd" — preço unitário SEM TRIBUTOS, em R$/kWh com 4-6 decimais.
    No bloco de FATURAMENTO da fatura, procure linhas como:
       "ENERGIA TE  ... TARIFA 0,34005 ..."  → tarifa_te = 0.34005
       "TUSD       ... TARIFA 0,48238 ..."  → tarifa_tusd = 0.48238
    Pode aparecer como "TARIFA UNIT" + "(C/TRIB)" ou "(S/TRIB)". Use S/TRIB.

▸ "tarifa_demanda" — preço unitário da demanda em R$/kW (geralmente 5-50).
    "DEMANDA  TARIFA 7,91811" → tarifa_demanda = 7.91811

▸ "tipo_bandeira" — apenas uma palavra: "VERDE", "AMARELA", "VERMELHA", "VERMELHA P1", "VERMELHA P2".
    Se a fatura não mencionar bandeira, retorne null (não invente "VERDE").

═══════════════════════════════════════════════════════════════════════════
EXEMPLO DE EXTRAÇÃO BEM-SUCEDIDA (parcial — só campos críticos):
═══════════════════════════════════════════════════════════════════════════
Trecho da fatura ELEKTRO Verde:
  "ELEKTRO ATENDIMENTO COMERCIAL  - CNPJ 47.866.934/0001-74"
  "Classe: COMERCIAL  Subgrupo: A4  Modalidade: HORÁRIA VERDE"
  "Tensão: 13,8 kV  Medidor: RM0519494  Demanda Contratada: 130 kW"
  "FATURAMENTO:"
  "0102 CONS PONTA TUSD  647 kWh  TARIFA 0,48238  ...  R$ 312,10"
  "0103 CONS PONTA TE    647 kWh  TARIFA 0,34005  ...  R$ 220,01"
  "0202 CONS FORA P TUSD 6121 kWh TARIFA 0,16834  ...  R$ 1.030,38"

JSON esperado (parcial):
{
  "distribuidora": "ELEKTRO",
  "classe_consumidor": "COMERCIAL",
  "subgrupo_tarifario": "A4",
  "modalidade_tarifaria": "HORÁRIA VERDE",
  "grupo_tarifario": "A",
  "tensao_fornecimento": "13,8 kV",
  "numero_medidor": "RM0519494",
  "demanda_cont_p": 130.0,
  "kwh_ponta": 647.0,
  "kwh_fponta": 6121.0,
  "tarifa_te": 0.34005,
  "tarifa_tusd": 0.48238
}

Retorne APENAS o JSON, sem explicações, sem markdown, começando com '{'.
"""

def _campos_reconhecidos(campos: dict) -> bool:
    """Retorna True se ao menos 2 campos críticos foram extraídos.

    Critério v2 (2026-05): além dos campos básicos (kwh_total, total_rs, ...),
    exige também presença de campos de MEDIÇÃO (leituras P/FP, constantes,
    consumo por posto). Sem esses, o motor SQL não consegue detectar F01/F02.
    """
    # Bloco 1 — campos financeiros básicos (extraídos por regex bem)
    basicos = ["kwh_total", "total_rs", "icms_valor", "tarifa_kwh", "rs_consumo"]
    # Bloco 2 — campos de medição (frequentemente NULL nas distribuidoras top)
    medicao = ["leit_atu_p", "leit_atu_fp", "constante_p", "constante_k",
               "kwh_ponta", "kwh_fponta"]
    n_basicos = sum(1 for c in basicos if campos.get(c) is not None)
    n_medicao = sum(1 for c in medicao if campos.get(c) is not None)
    # Reconhecido só se cobre ambos blocos: 2+ básicos E 2+ medição.
    # Quando faltar medição, dispara GPT-fallback (extrai leituras/constantes).
    return n_basicos >= 2 and n_medicao >= 2


def extrair_via_gpt(texto: str) -> dict:
    """
    Usa GPT-4o-mini para extrair campos quando os parsers regex falham.
    Retorna dict com os mesmos campos de _campos_vazios().
    """
    if not _OPENAI_KEY:
        log.warning("  [gpt-fallback] OPENAI_API_KEY não definida — pulando")
        return _campos_vazios()
    if not texto or len(texto.strip()) < 100:
        log.warning("  [gpt-fallback] texto muito curto — pulando")
        return _campos_vazios()

    # Limita a ~12.000 chars para economizar tokens (faturas cabem folgado)
    texto_input = texto[:12000]

    try:
        import urllib.request
        import urllib.error
        import json as _json

        def _chamar_api(model: str) -> dict:
            payload = _json.dumps({
                "model": model,
                "messages": [
                    {"role": "system", "content": _GPT_SYSTEM},
                    {"role": "user",   "content": texto_input},
                ],
                "temperature": 0,
                "max_tokens": 5000,
            }).encode()
            req = urllib.request.Request(
                "https://api.openai.com/v1/chat/completions",
                data=payload,
                headers={
                    "Authorization": f"Bearer {_OPENAI_KEY}",
                    "Content-Type":  "application/json",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    return _json.loads(resp.read())
            except urllib.error.HTTPError as http_err:
                detalhe = http_err.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"HTTP {http_err.code} — {detalhe}") from http_err

        # Tenta com o modelo configurado; em caso de 400 (modelo inválido) usa fallback
        _FALLBACK_MODEL = "gpt-4o-mini"
        try:
            body = _chamar_api(_OPENAI_MODEL)
        except RuntimeError as api_err:
            if "400" in str(api_err) and _OPENAI_MODEL != _FALLBACK_MODEL:
                log.warning(f"  [gpt-fallback] modelo '{_OPENAI_MODEL}' rejeitado — tentando {_FALLBACK_MODEL}")
                body = _chamar_api(_FALLBACK_MODEL)
            else:
                raise

        raw = body["choices"][0]["message"]["content"].strip()
        # Remove possível bloco markdown ```json ... ```
        if raw.startswith("```"):
            raw = re.sub(r"^```[a-z]*\n?", "", raw)
            raw = re.sub(r"\n?```$",       "", raw)

        gpt_data = _json.loads(raw)
        campos   = _campos_vazios()

        def _set(key, converter=None):
            v = gpt_data.get(key)
            if v is not None:
                campos[key] = converter(v) if converter else v

        for k in ["kwh_total", "kwh_fponta", "leit_ant_p", "leit_atu_p", "constante_p",
                   "total_rs", "rs_consumo", "cip", "tarifa_kwh", "preco_unit_c_trib",
                   "icms_base", "icms_aliq", "icms_valor",
                   "pis_base", "pis_aliq", "pis_valor",
                   "cofins_aliq", "cofins_valor", "kwh_injet"]:
            _set(k)

        for k in ["dt_leit_ant", "dt_leit_atu", "dt_proxima", "dt_emissao", "vencimento"]:
            _set(k)  # mantém string DD/MM/YYYY — gravar_campos converte

        hist = gpt_data.get("historico") or []
        if isinstance(hist, list) and hist:
            campos["historico"] = [
                h for h in hist
                if isinstance(h, dict)
                and h.get("mes") and h.get("ano") and h.get("kwh")
            ]

        return campos

    except Exception as e:
        log.warning(f"  [gpt-fallback] erro: {e}")
        return _campos_vazios()


# ─── CAMADA v3 (regex determinístico + cascata bbox + validações) ───────────

def _num_coord_pipeline(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace("R$", "").replace(" ", "")
    neg = s.startswith("-") or s.endswith("-")
    s = s.strip("-")
    try:
        n = float(s.replace(".", "").replace(",", "."))
        return -n if neg else n
    except Exception:
        return None


def _valor_total_ref_v2(v2_out: dict):
    if not isinstance(v2_out, dict):
        return None
    candidatos = [
        ((v2_out.get("vencimento_valor") or {}).get("valor_total")),
        ((v2_out.get("referencia_vencimento_valor") or {}).get("valor_total_a_pagar")),
        ((v2_out.get("totais") or {}).get("valor_total_a_pagar")),
        v2_out.get("valor_total_fatura"),
    ]
    for c in candidatos:
        n = _num_coord_pipeline(c)
        if n is not None and n > 0:
            return n
    return None


def _normalizar_itens_coord(itens_coord):
    out = []
    for it in itens_coord or []:
        if not isinstance(it, dict):
            continue
        desc = str(it.get("descricao") or "").strip()
        valor = _num_coord_pipeline(it.get("valor"))
        if not desc or valor is None:
            continue
        qtd = _num_coord_pipeline(it.get("qtd"))
        tarifa = _num_coord_pipeline(it.get("tarifa"))
        out.append({
            "descricao": desc,
            "unidade": it.get("unidade"),
            "quantidade_numerica": qtd,
            "tarifa_unit_numerica": tarifa,
            "tarifa_unit_aneel_numerica": tarifa,
            "valor_brl_numerico": valor,
            "_extrator": "coord",
        })
    return out


def _aplicar_itens_coord(v2_out: dict, tmp_pdf: str, qtd_sefaz_hint=None) -> dict:
    """COORD LAYER (liteparse) — reconstrói itens de tabela COLUNAR por coordenadas.
    ADITIVO e GATED: só preenche quando os itens estão VAZIOS (o texto linear não pegou)
    E a soma dos itens fecha com o total (auto-validação no coord_layer, usando o total
    que o parser/regex entregou como âncora). Nunca sobrescreve item já extraído. Precisa
    do PDF (coords) — não roda em --revalidar. Substitui o parser_coordenadas (morto)."""
    if not isinstance(v2_out, dict) or not tmp_pdf:
        return {"usou": False, "motivo": "sem_v2_ou_pdf"}
    atuais = v2_out.get("itens_fatura") or []
    try:
        from coord_layer import extrair_itens_coord as _coord_lp
        vt_ref = _valor_total_ref_v2(v2_out)
    except Exception as e:
        return {"usou": False, "motivo": f"setup:{e}"}
    if not vt_ref or vt_ref <= 0:
        return {"usou": False, "motivo": "sem_total_ref", "n_atual": len(atuais)}
    # Se os itens ATUAIS já fecham com o total, estão completos → mantém (coord não mexe).
    soma_atual = round(sum((i.get("valor_brl_numerico") or 0) for i in atuais), 2)
    if atuais and abs(soma_atual - vt_ref) <= max(0.50, vt_ref * 0.01):
        return {"usou": False, "motivo": "atuais_fecham", "n_atual": len(atuais), "soma_atual": soma_atual}
    # Vazio OU incompleto (não fecha) → tenta coord, que TAMBÉM se auto-valida (Σ≈total).
    try:
        with open(tmp_pdf, "rb") as f:
            pdf_b = f.read()
        res = _coord_lp(pdf_b, vt_ref)
    except Exception as e:
        return {"usou": False, "motivo": f"coord:{e}", "n_atual": len(atuais)}
    if not res or not res.get("validado"):
        return {"usou": False, "motivo": "coord_nao_valida", "n_atual": len(atuais),
                "soma_coord": (res or {}).get("soma"), "vt_ref": vt_ref}
    itens = [{"descricao": it["descricao"], "valor_brl_numerico": it["valor_brl"],
              "_extrator": "coord_liteparse"} for it in res["itens"]]
    v2_out["itens_fatura"] = itens
    v2_out["_itens_fonte"] = "coord_liteparse"
    v2_out["_itens_coord_debug"] = {"n_anterior": len(atuais), "n_coord": len(itens),
                                    "soma": res["soma"], "total": res["total"]}
    return {"usou": True, "motivo": "coord_validado", "n_anterior": len(atuais),
            "n_coord": len(itens), "soma": res["soma"]}


def _aplicar_campos_coord(v2_out: dict, tmp_pdf: str) -> dict:
    """COORD CAMPOS (liteparse) — preenche TRIBUTOS (ICMS/PIS/COFINS) por COORDENADA
    quando o texto/regex não pegou. ADITIVO e fill-if-empty: só preenche tributo VAZIO,
    nunca sobrescreve. O gate de plausibilidade (ICMS≤total, PIS/COFINS pequenos+distintos)
    está dentro do coord_layer → não injeta dado absurdo. Precisa do PDF (não roda em
    --revalidar). Validado ENEL SP: ICMS ~93%, PIS/COFINS parcial+seguro."""
    if not isinstance(v2_out, dict) or not tmp_pdf:
        return {"usou": False, "motivo": "sem_v2_ou_pdf"}
    tpd = v2_out.get("tributos_por_dist") or {}
    falta = lambda k: not ((tpd.get(k) or {}).get("valor_string"))
    if not (falta("icms") or falta("pis") or falta("cofins")):
        return {"usou": False, "motivo": "tributos_ja_completos"}
    try:
        from coord_layer import extrair_campos_coord
        with open(tmp_pdf, "rb") as f:
            pdf_b = f.read()
        vt = _valor_total_ref_v2(v2_out)
        res = extrair_campos_coord(pdf_b, vt)
    except Exception as e:
        return {"usou": False, "motivo": f"coord:{e}"}
    if not res or not res.get("_validado"):
        return {"usou": False, "motivo": "coord_nao_valida"}
    tpd = v2_out.setdefault("tributos_por_dist", {})
    preench = []
    for k in ("icms", "pis", "cofins"):
        v = res.get(k)
        if v is not None and falta(k):
            tpd[k] = {"valor_string": f"{v:.2f}".replace(".", ","), "_fonte": "coord_campos_liteparse"}
            preench.append(k)
    return {"usou": bool(preench), "motivo": "preenche_" + "+".join(preench) if preench else "nada_a_preencher",
            "campos": preench}


# ─── LLM-NORMALIZA (Milestone 3) — gap-fill via 4o-mini sobre TEXTO em cache ────────
# Análogo aos gap-fillers coord (_aplicar_itens_coord / _aplicar_campos_coord), mas usa um
# LLM barato (4o-mini) em vez das coordenadas do PDF — logo RODA em --revalidar (só texto,
# sem download). Objetivo: completar os ITENS (p/ o check soma_itens FECHAR) e os TRIBUTOS
# vazios das faturas que travam em score ~85 (aprovadas pela trava de tributos, mas soma_itens
# FAIL). O gate de segurança é o MESMO do coord: itens do LLM só entram se Σ≈total (o total
# vem do regex, confiável) — assim, mesmo que o modelo alucine, dado que não reconcilia é
# DESCARTADO. Protege o ressarcimento: quem libera auditado=1 continua sendo o validador
# determinístico, não o modelo.
_LLM_NORMALIZA_SYSTEM = """Você é um auditor de faturas de energia elétrica brasileiras. Extraia do texto os ITENS COBRADOS e os TRIBUTOS. Devolva APENAS JSON.

REGRAS CRÍTICAS (siga à risca):
- kWh NÃO é R$. Quantidade (kWh/kW) é uma coluna; o VALOR é a coluna em R$ da linha. Nunca troque uma pela outra.
- TUSD e TE são itens SEPARADOS — não some nem funda. "Consumo TUSD" ≠ "Consumo TE".
- ICMS, PIS e COFINS são TRIBUTOS (vão em "tributos"), NÃO itens de consumo. O valor de um tributo NUNCA é o total da fatura.
- Leitura do medidor ≠ consumo. Não confunda leitura anterior/atual com kWh consumido.
- Créditos / energia injetada / devoluções têm valor NEGATIVO.
- Campo ausente no texto = null. NÃO invente, NÃO chute, NÃO calcule o que não está escrito.

- Período de leitura: use as DATAS da leitura anterior/atual (não confunda com valores de registrador do medidor) e o nº de DIAS faturados.
- Indicadores de qualidade (DIC/FIC/DICRI em horas/vezes; tensão em Volts) só se impressos na fatura; senão null.

Formato (número decimal com ponto; datas DD/MM/AAAA; null se ausente):
{
  "itens_cobrados": [
    {"descricao": "texto da linha", "quantidade": 123.45, "unidade": "kWh", "tarifa": 0.12345, "valor": 123.45}
  ],
  "total_distribuidora": 1234.56,
  "tributos": {"icms_valor": 12.34, "pis_valor": 1.23, "cofins_valor": 5.67},
  "periodo_leitura": {"leitura_anterior": "01/03/2022", "leitura_atual": "31/03/2022", "dias_consumo": 30},
  "indicadores": {"dic": 1.23, "fic": 2.0, "dicri": 0.0, "tensao_contratada": 127, "limite_adequado_min": 116}
}
"itens_cobrados" deve conter TODAS as linhas de cobrança (consumo, TUSD, TE, bandeira, CIP/COSIP, multas, créditos), de modo que a soma dos "valor" reproduza o total. Retorne SÓ o JSON, começando com '{'."""


def _dias_consistentes(la, lb, dd) -> bool:
    """Gate de segurança do período de leitura: as DUAS datas + o nº de dias têm que ser
    internamente coerentes (diff das datas ≈ dias, ±3) e o período plausível (15-45 dias).
    Se as datas não parseiam ou não batem, DESCARTA (retorna False) — não inventa período."""
    try:
        import datetime as _dt
        def _p(s):
            s = str(s).strip()
            for fmt in ("%d/%m/%Y", "%d/%m/%y", "%Y-%m-%d"):
                try:
                    return _dt.datetime.strptime(s, fmt).date()
                except Exception:
                    pass
            return None
        da, db = _p(la), _p(lb)
        n = int(float(str(dd).replace(",", ".")))
        if not da or not db or db <= da:
            return False
        diff = (db - da).days
        return (15 <= n <= 45) and (abs(diff - n) <= 3)
    except Exception:
        return False


def _llm_json_call(system: str, user: str, model: str, max_tokens: int = 6000):
    """POST OpenAI chat/completions (temperatura 0) → dict JSON ou None. Reusa o padrão do
    extrair_via_gpt (urllib + strip de ```json). Erros viram None (nunca levanta)."""
    if not _OPENAI_KEY or not user or len(user.strip()) < 100:
        return None
    try:
        import urllib.request, urllib.error
        import json as _json
        payload = _json.dumps({
            "model": model,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user[:14000]}],
            "temperature": 0,
            "max_tokens": max_tokens,
        }).encode()
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions", data=payload,
            headers={"Authorization": f"Bearer {_OPENAI_KEY}", "Content-Type": "application/json"},
            method="POST")
        with urllib.request.urlopen(req, timeout=90) as resp:
            body = _json.loads(resp.read())
        raw = body["choices"][0]["message"]["content"].strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```[a-z]*\n?", "", raw)
            raw = re.sub(r"\n?```$", "", raw)
        return _json.loads(raw)
    except Exception as e:
        log.warning(f"  [llm-normaliza] erro API: {e}")
        return None


def _parse_itens_llm(data: dict) -> list:
    """Extrai itens_cobrados do JSON do LLM → lista no formato itens_fatura. Reusável entre
    tentativas do retry direcionado."""
    novos = []
    for it in (data.get("itens_cobrados") or []):
        if not isinstance(it, dict):
            continue
        desc = (it.get("descricao") or "").strip()
        val = _num_coord_pipeline(it.get("valor"))
        if not desc or val is None:
            continue
        novos.append({
            "descricao": desc,
            "unidade": it.get("unidade"),
            "quantidade_numerica": _num_coord_pipeline(it.get("quantidade")),
            "tarifa_unit_numerica": _num_coord_pipeline(it.get("tarifa")),
            "tarifa_unit_aneel_numerica": _num_coord_pipeline(it.get("tarifa")),
            "valor_brl_numerico": val,
            "_extrator": "llm_normaliza",
        })
    return novos


def normalizar_via_llm(v2_out: dict, texto: str) -> dict:
    """GAP-FILL via LLM (4o-mini) sobre o TEXTO em cache — NÃO precisa do PDF (roda em
    --revalidar). ADITIVO e gated, nunca sobrescreve regex bom:
      - ITENS: só SUBSTITUI quando os atuais NÃO fecham com o total E os do LLM FECHAM
        (Σ≈total, tolerância = max(R$0,50, 1%%)). É o MESMO gate do coord_layer — itens que
        não reconciliam com o total (regex, confiável) são DESCARTADOS.
      - TRIBUTOS: preenche icms/pis/cofins VAZIOS só se plausível (icms/total 0.05-0.35;
        pis/cofins >0 e < 10%% do total).
    Não persiste — devolve dict de debug; o commit único do bloco v3 grava depois."""
    dbg = {"usou": False, "motivo": None, "itens": None, "tributos": []}
    if not isinstance(v2_out, dict) or not _OPENAI_KEY:
        dbg["motivo"] = "sem_v2_ou_key"
        return dbg
    vt_ref = _valor_total_ref_v2(v2_out)
    atuais = v2_out.get("itens_fatura") or []
    tpd = v2_out.setdefault("tributos_por_dist", {})
    falta_trib = lambda k: not ((tpd.get(k) or {}).get("valor_string"))
    tol = max(0.50, (vt_ref or 0) * 0.01)
    soma_atual = round(sum((i.get("valor_brl_numerico") or 0) for i in atuais), 2)
    itens_fecham = bool(vt_ref and atuais and abs(soma_atual - vt_ref) <= tol)
    dbg["ctx"] = {"vt_ref": vt_ref, "n_atuais": len(atuais), "soma_atual": soma_atual, "fecham": itens_fecham}
    # Se os itens já fecham E não falta tributo → nada a fazer (não gasta LLM).
    if itens_fecham and not (falta_trib("icms") or falta_trib("pis") or falta_trib("cofins")):
        dbg["motivo"] = "nada_a_preencher"
        return dbg

    model = os.getenv("PDF_PIPELINE_LLM_NORMALIZA_MODEL", "gpt-4o-mini")
    data = _llm_json_call(_LLM_NORMALIZA_SYSTEM, texto or "", model)
    if not isinstance(data, dict):
        dbg["motivo"] = "llm_sem_resposta"
        return dbg

    # --- TOTAL corroborado: sem total extraído, mas os itens do REGEX já somam algo e o LLM
    # (fonte independente) confirma esse mesmo valor → grava valor_total = SOMA DOS ITENS DO
    # REGEX (nunca o número do LLM; ele só corrobora). Destrava o soma_itens SKIP-0 ("valor_total
    # ausente") sem inventar total. valor_total NÃO é input do ressarcimento (usa vea/rs_kwh_total). ---
    if (vt_ref is None or vt_ref <= 0) and atuais and soma_atual > 0:
        _llm_total = _num_coord_pipeline(data.get("total_distribuidora"))
        if _llm_total and abs(_llm_total - soma_atual) <= max(0.50, soma_atual * 0.01):
            vv = v2_out.setdefault("vencimento_valor", {})
            if not vv.get("valor_total"):
                vv["valor_total"] = round(soma_atual, 2)
            vt_ref = soma_atual
            itens_fecham = True
            tol = max(0.50, vt_ref * 0.01)
            dbg["total_corroborado"] = {"llm_total": _llm_total, "soma_regex": soma_atual}
            dbg["usou"] = True

    # --- ITENS: gate Σ≈total; só mexe se os atuais NÃO fecham ---
    # MONEY-SAFE: substituir itens_fatura RE-AGREGA kwh_total/consumo no atualizar_colunas_db
    # (input do ressarcimento via motor). Por isso este ramo é OPT-IN explícito
    # (PDF_PIPELINE_LLM_NORMALIZA_ITENS=1) e fica DESLIGADO por padrão. O gap-fill padrão
    # (total corroborado + tributos + leitura + indicadores) NÃO toca consumo → dinheiro intacto.
    if (os.getenv("PDF_PIPELINE_LLM_NORMALIZA_ITENS") == "1"
            and vt_ref and vt_ref > 0 and not itens_fecham):
        # RETRY DIRECIONADO: em vez de descartar quando Σitens≠total, remando de volta ao LLM
        # com o erro EXPLÍCITO ("somou X, o total é Y, diferença Z; procure item faltante/valor
        # trocado/duplicado") — retry alvo funciona melhor que reprocessar do zero. O gate de
        # aceitação NÃO muda (Σ≈total dentro da tolerância), então continua money-safe: uma
        # tentativa que não reconcilia é rejeitada igual. max = PDF_PIPELINE_LLM_NORMALIZA_RETRY (2).
        max_retry = int(os.getenv("PDF_PIPELINE_LLM_NORMALIZA_RETRY", "2"))
        novos = _parse_itens_llm(data)
        soma_llm = round(sum(i["valor_brl_numerico"] for i in novos), 2)
        hist = [{"n": len(novos), "soma": soma_llm, "tentativa": 0}]
        tentativa = 0
        while novos and abs(soma_llm - vt_ref) > tol and tentativa < max_retry:
            tentativa += 1
            diff = round(soma_llm - vt_ref, 2)
            correcao = (
                f"\n\n[CORRECAO — tentativa {tentativa}] Sua lista anterior de itens somou "
                f"R$ {soma_llm:.2f}, mas o TOTAL da fatura e R$ {vt_ref:.2f} (diferenca R$ {diff:.2f}). "
                f"Revise a lista COMPLETA: procure item faltante, valor com milhar/decimal trocado "
                f"(notacao BR: 1.234,56), item duplicado ou sinal invertido. Devolva os itens que "
                f"SOMAM exatamente o total.")
            data_r = _llm_json_call(_LLM_NORMALIZA_SYSTEM, (texto or "") + correcao, model)
            if not isinstance(data_r, dict):
                break
            novos = _parse_itens_llm(data_r)
            soma_llm = round(sum(i["valor_brl_numerico"] for i in novos), 2)
            hist.append({"n": len(novos), "soma": soma_llm, "tentativa": tentativa})
        if novos and abs(soma_llm - vt_ref) <= tol:
            v2_out["itens_fatura"] = novos
            v2_out["_itens_fonte"] = "llm_normaliza"
            dbg["usou"] = True
            dbg["itens"] = {"n_anterior": len(atuais), "n_llm": len(novos), "soma_llm": soma_llm,
                            "total": vt_ref, "aceito": True, "tentativas": tentativa, "hist": hist}
        else:
            dbg["itens"] = {"n_llm": len(novos), "soma_llm": soma_llm, "total": vt_ref,
                            "aceito": False, "tentativas": tentativa, "hist": hist}

    # --- TRIBUTOS: fill-if-empty + plausível ---
    trib = data.get("tributos") or {}
    for k, key_llm in (("icms", "icms_valor"), ("pis", "pis_valor"), ("cofins", "cofins_valor")):
        if not falta_trib(k):
            continue
        v = _num_coord_pipeline(trib.get(key_llm))
        if v is None or v <= 0:
            continue
        ok = True
        if vt_ref and vt_ref > 0:
            r = v / vt_ref
            ok = (0.05 <= r <= 0.35) if k == "icms" else (r < 0.10)
        if ok:
            tpd[k] = {"valor_string": f"{v:.2f}".replace(".", ","), "_fonte": "llm_normaliza"}
            dbg["tributos"].append(k)
            dbg["usou"] = True

    # --- PERÍODO DE LEITURA (datas): fill-if-empty + gate de consistência de datas ---
    # NÃO toca no dinheiro (período ≠ consumo); só completa metadado que o validador pontua.
    pl_llm = data.get("periodo_leitura") or {}
    pl_cur = v2_out.get("periodo_leitura") or {}
    _campos_pl = ("leitura_anterior", "leitura_atual", "dias_consumo")
    if not all(pl_cur.get(k) for k in _campos_pl):
        la, lb, dd = pl_llm.get("leitura_anterior"), pl_llm.get("leitura_atual"), pl_llm.get("dias_consumo")
        if _dias_consistentes(la, lb, dd):
            tgt = v2_out.setdefault("periodo_leitura", {})
            for k, v in (("leitura_anterior", la), ("leitura_atual", lb), ("dias_consumo", dd)):
                if not tgt.get(k) and v is not None:
                    tgt[k] = v
            v2_out["_leitura_fonte"] = "llm_normaliza"
            dbg["leitura"] = {"la": la, "lb": lb, "dias": dd, "aceito": True}
            dbg["usou"] = True
        else:
            dbg["leitura"] = {"la": la, "lb": lb, "dias": dd, "aceito": False}

    # --- INDICADORES (DIC/FIC/DICRI/tensão): fill-if-empty + plausibilidade ---
    # Também metadado (não alimenta ressarcimento). Preenche em indicadores_qualidade.
    ind_llm = data.get("indicadores") or {}
    ind_cur = v2_out.get("indicadores_qualidade") or v2_out.get("indicadores") or {}
    _grupos = (("regex_dic", "dic_apurado", "dic"), ("regex_fic", "fic_apurado", "fic"),
               ("dicri", "regex_dicri"), ("tensao_contratada_v", "tensao_contratada"),
               ("limite_adequado_min_v",))
    _preench_cur = sum(1 for g in _grupos if any(ind_cur.get(k) for k in g))
    if _preench_cur < 4:
        novo = {}
        for src, dst in (("dic", "dic_apurado"), ("fic", "fic_apurado"), ("dicri", "dicri")):
            vv = _num_coord_pipeline(ind_llm.get(src))
            if vv is not None and 0 <= vv < 1000:
                novo[dst] = vv
        tv = _num_coord_pipeline(ind_llm.get("tensao_contratada"))
        if tv is not None and 100 <= tv <= 800:
            novo["tensao_contratada_v"] = tv
        lv = _num_coord_pipeline(ind_llm.get("limite_adequado_min"))
        if lv is not None and 90 <= lv <= 800:
            novo["limite_adequado_min_v"] = lv
        if novo:
            tgt = v2_out.setdefault("indicadores_qualidade", {})
            for k, v in novo.items():
                if not tgt.get(k):
                    tgt[k] = v
            dbg["indicadores"] = list(novo.keys())
            dbg["usou"] = True

    dbg["motivo"] = "preencheu" if dbg["usou"] else "nada_aplicavel"
    return dbg


def _rodar_pipeline_v3(cur, conn, fid, pdf_bytes, texto_plumber, texto_markdown, texto_ocr, uid: str = None, force: bool = False, texto_bbox: str = None, dryrun: bool = False):
    """Executa pipeline determinístico unificado (3 extratores + camadas auxiliares).

    Args:
        fid: ID da origem (Faturas_Registradas_Cache.id) — usado apenas em logs
        uid: UID da fatura (chave de junção com FATURA_DADOS_EXTRAIDOS.uid)

    Camadas executadas DENTRO de extrair_tudo() do FaturaExtractorV2:
      1. Regex mapa-específico (ia/map/*.json)
      2. Regex genérico (_extrair_subgrupo_generico)
      3. Aho-Corasick scoring (ia/aho_scoring.py) — 110+ keywords/URLs
      4. Templates bbox por dist (ia/templates_bbox/*.json) — 29 templates ativos
      5. Tributos por dist (ia/tributos_por_dist.py):
         - regex específico (PIS/COFINS/ICMS por padrão de dist)
         - soma agregada dos itens (colunas pis_cofins/icms já capturadas no regex)
         - extração TOTAL linha (CEMIG/Energisa formato)
      6. CNPJ via chave NF3e (dígitos 7-20) — fallback quando texto tem CNPJ mascarado
      7. Auditoria GD Python pura

    Camadas executadas FORA do extrator_v2:
      A. extrator_v3.cascata_extracao — pdfplumber tables + img2table + drawings + pymupdf4llm
      B. validacoes_fatura — chave NF3e mod 11, CNPJ duplo (CPF fallback), demandas, tributos transpostos

    Persiste em extracao_raw_json.regex_v3 com sub-chaves: v2, cascata, validacoes, ts.
    """
    import json as _json
    import tempfile as _tempfile
    try:
        from extrator_v2 import FaturaExtractorV2
        from extrator_v3 import cascata_extracao, resumir
        from validacoes_fatura import (
            validar_chave_nfe, extrair_cnpj_duplo,
            extrair_demandas, extrair_tributos,
        )
    except Exception as e:
        log.warning(f"  [v3] imports falharam: {e}")
        return

    # Texto unificado (4 extratores): plumber + markdown + ocr + bbox-ordenado
    # bbox-ordenado é crítico pra DANF3E que pdfplumber lê coluna-a-coluna (Via Varejo)
    texto_v2 = (
        (texto_plumber or "") + "\n\n"
        + (texto_markdown or "") + "\n\n"
        + (texto_ocr or "") + "\n\n"
        + (texto_bbox or "")
    )
    if len(texto_v2.strip()) < 100:
        return

    # Salva PDF em tmp UMA vez — usado por extrator_v2 (templates_bbox) e extrator_v3 (cascata)
    tmp_pdf = None
    if pdf_bytes:
        tmp_pdf = _tempfile.NamedTemporaryFile(suffix=".pdf", delete=False).name
        try:
            with open(tmp_pdf, "wb") as f: f.write(pdf_bytes)
        except Exception as e:
            log.warning(f"  [v3] erro salvando tmp pdf: {e}")
            tmp_pdf = None

    # 1) extrator_v2 — passa pdf_path (templates_bbox precisa) + texto_md_fallback (mUC, CNPJ chave NFe)
    t_etapa = time.time()
    try:
        v2 = FaturaExtractorV2(
            fatura_id=fid,
            texto=texto_v2[:80000],
            conn=conn,
            texto_md_fallback=(texto_markdown or ""),
        )
        if tmp_pdf:
            v2.pdf_path = tmp_pdf
        v2_out = v2.extrair_tudo()
        log.info(f"  [v3.1 extrator_v2] mapa={v2_out.get('_mapa_usado','?')} itens={len(v2_out.get('itens_fatura') or [])} ({time.time()-t_etapa:.1f}s)")
    except Exception as e:
        log.warning(f"  [v3.1 extrator_v2] erro: {e}")
        v2_out = {}

    # 2) extrator_v3 cascata bbox sobre o PDF (tabelas adicionais)
    cascata_out = {}
    if tmp_pdf:
        t_etapa = time.time()
        try:
            cascata_out = resumir(cascata_extracao(tmp_pdf))
            regs = (cascata_out.get("regioes_detectadas") if isinstance(cascata_out, dict) else None) or {}
            log.info(f"  [v3.2 cascata bbox] {regs} ({time.time()-t_etapa:.1f}s)")
        except Exception as e:
            log.warning(f"  [v3.2 cascata bbox] erro: {e}")

    # 2.5) Re-aplica complementar COM cascata + pdf_path (hidratação boleto + histórico bbox)
    if isinstance(v2_out, dict):
        t_etapa = time.time()
        try:
            from extrator_complementar import aplicar_complementos
            aplicar_complementos(v2_out, texto_v2 or "", cascata=cascata_out, pdf_path=tmp_pdf, uid=uid)
            sefaz_info = v2_out.get("_sefaz_nf3e") or {}
            sefaz_status = "skip"
            if sefaz_info:
                if sefaz_info.get("_erro"):
                    sefaz_status = f"erro:{(sefaz_info.get('_erro') or '')[:40]}"
                else:
                    sefaz_status = f"ok valor={sefaz_info.get('valor_total','?')} qtd_itens={sefaz_info.get('qtd_itens','?')}"
            log.info(f"  [v3.3 complementos] itens={len(v2_out.get('itens_fatura') or [])} sefaz={sefaz_status} ({time.time()-t_etapa:.1f}s)")
        except Exception as e:
            log.warning(f"  [v3.3 complementos] erro: {e}")

    # 2.6) Itens por COORDENADAS (fonte adicional; nao sobrescreve item bom)
    if isinstance(v2_out, dict) and tmp_pdf:
        t_etapa = time.time()
        try:
            qtd_sefaz_hint = None
            if uid and cur is not None:
                try:
                    cur.execute(f"SELECT qtd_itens_sefaz FROM {TBL_FDE} WHERE uid=%s LIMIT 1", (uid,))
                    r_qtd = cur.fetchone()
                    if isinstance(r_qtd, dict):
                        qtd_sefaz_hint = r_qtd.get("qtd_itens_sefaz")
                    elif r_qtd:
                        qtd_sefaz_hint = r_qtd[0]
                except Exception:
                    qtd_sefaz_hint = None
            coord_info = _aplicar_itens_coord(v2_out, tmp_pdf, qtd_sefaz_hint=qtd_sefaz_hint)
            if coord_info.get("usou"):
                log.info(
                    f"  [v3.35 coord_itens] usou coord "
                    f"itens={coord_info.get('n_atual')}->{coord_info.get('n_coord')} "
                    f"sefaz={coord_info.get('qtd_sefaz') or '-'} "
                    f"motivo={coord_info.get('motivo')} ({time.time()-t_etapa:.1f}s)"
                )
            else:
                log.info(
                    f"  [v3.35 coord_itens] mantem atual "
                    f"itens={coord_info.get('n_atual', len(v2_out.get('itens_fatura') or []))} "
                    f"coord={coord_info.get('n_coord', 0)} "
                    f"sefaz={coord_info.get('qtd_sefaz') or '-'} "
                    f"motivo={coord_info.get('motivo')} ({time.time()-t_etapa:.1f}s)"
                )
        except Exception as e:
            log.warning(f"  [v3.35 coord_itens] erro: {e}")

        # v3.36 — coord CAMPOS: preenche tributos vazios por coordenada (fill-if-empty,
        # gate de plausibilidade no coord_layer). Só no caminho com PDF.
        try:
            cinfo = _aplicar_campos_coord(v2_out, tmp_pdf)
            if cinfo.get("usou"):
                log.info(f"  [v3.36 coord_campos] preencheu {cinfo.get('campos')}")
        except Exception as e:
            log.warning(f"  [v3.36 coord_campos] erro: {e}")

    # 2.7) Validador determinístico — score + gate (aprovado/revisao/reprovado/scaneada)
    # Anexa em v2_out["_qualidade"] pra atualizar_colunas_individuais ler o score.
    qualidade = {}
    if isinstance(v2_out, dict):
        t_etapa = time.time()
        try:
            from validador_fatura import validar_fatura_completa
            qualidade = validar_fatura_completa(v2_out)
            v2_out["_qualidade"] = qualidade
            # Status de cada check (compacto)
            checks_str = " ".join(f"{c['nome'][:8]}:{c['status'][:1]}" for c in (qualidade.get("checks") or []))
            log.info(f"  [v3.4 validador] gate={qualidade.get('gate','-')} score={qualidade.get('score','-')} | {checks_str} ({time.time()-t_etapa:.1f}s)")
            if os.getenv("PDF_PIPELINE_DEBUG_CHECKS") == "1":
                import json as _jd
                log.info("  [DEBUG checks] " + _jd.dumps(
                    [{"n": c.get("nome"), "s": c.get("status"), "sc": c.get("score"),
                      "mx": c.get("peso_max"), "obs": c.get("_obs")} for c in (qualidade.get("checks") or [])],
                    ensure_ascii=False))
        except Exception as e:
            log.warning(f"  [v3.4 validador] erro: {e}")

    # 3b) LLM-NORMALIZA (opcional; env PDF_PIPELINE_LLM_NORMALIZA=1) — Milestone 3.
    # Só dispara quando a fatura NÃO chega ao score de auto-audit (score < min): chama o
    # 4o-mini no TEXTO em cache p/ completar ITENS (soma_itens fechar) e TRIBUTOS vazios,
    # com gate Σitens≈total (nunca sobrescreve regex). Re-valida → score sobe → o auto-audit
    # (4.8) pega. Custa LLM só nas que precisam. Roda antes da derivação do gate (4.6).
    if os.getenv("PDF_PIPELINE_LLM_NORMALIZA") == "1" and isinstance(v2_out, dict) and _OPENAI_KEY:
        try:
            _min_ln = float(os.getenv("PDF_PIPELINE_LLM_NORMALIZA_MIN_SCORE", "95") or 95)
        except Exception:
            _min_ln = 95.0
        try:
            _sc_antes = float((qualidade or {}).get("score") or 0)
        except Exception:
            _sc_antes = 0.0
        if _sc_antes < _min_ln:
            t_ln = time.time()
            try:
                _dbg_ln = normalizar_via_llm(v2_out, texto_v2)
            except Exception as e_ln:
                _dbg_ln = {"usou": False, "motivo": f"erro:{e_ln}"}
            if _dbg_ln.get("usou"):
                try:
                    from validador_fatura import validar_fatura_completa as _vfc_ln
                    qualidade = _vfc_ln(v2_out)
                    v2_out["_qualidade"] = qualidade
                    v2_out["_llm_normaliza"] = _dbg_ln
                except Exception as e_rv:
                    log.warning(f"  [v3.4b LLM-NORMALIZA] re-valida erro: {e_rv}")
                log.info(
                    f"  [v3.4b LLM-NORMALIZA] score {_sc_antes:.0f}->{(qualidade or {}).get('score','-')} "
                    f"gate={(qualidade or {}).get('gate','-')} itens={_dbg_ln.get('itens')} "
                    f"tributos={_dbg_ln.get('tributos')} leitura={_dbg_ln.get('leitura')} "
                    f"indicadores={_dbg_ln.get('indicadores')} ({time.time()-t_ln:.1f}s)")
            else:
                log.info(f"  [v3.4b LLM-NORMALIZA] sem alteração ({_dbg_ln.get('motivo')}) "
                         f"ctx={_dbg_ln.get('ctx')} itens={_dbg_ln.get('itens')} leitura={_dbg_ln.get('leitura')} "
                         f"({time.time()-t_ln:.1f}s)")

    # 3) validações sobre texto (chave NF3e + cnpj_duplo + demandas + tributos transpostos)
    validacoes = {}
    t_etapa = time.time()
    try:
        chave = ((v2_out.get("nota_fiscal") or {}).get("chave_acesso") or "")
        if not chave:
            chave = v2_out.get("_cnpj_chave_nfe", "")  # fallback: chave já extraída pelo v2
        if chave:
            validacoes["chave_nfe"] = validar_chave_nfe(chave)
        validacoes["cnpj_duplo"] = extrair_cnpj_duplo(texto_v2)
        validacoes["demandas"] = extrair_demandas(texto_v2)
        validacoes["tributos"] = extrair_tributos(texto_v2)
        log.info(f"  [v3.5 validacoes_texto] chave={'sim' if validacoes.get('chave_nfe') else '-'} cnpj_duplo={'sim' if validacoes.get('cnpj_duplo') else '-'} ({time.time()-t_etapa:.1f}s)")
    except Exception as e:
        log.warning(f"  [v3.5 validacoes_texto] erro: {e}")

    # Cleanup tmp
    if tmp_pdf:
        try: os.remove(tmp_pdf)
        except: pass

    # 4) Persiste em extracao_raw_json.regex_v3 (compatível retroativamente)
    payload = {
        "v2": v2_out,
        "cascata": cascata_out,
        "validacoes": validacoes,
        "ts": time.time(),
    }
    if dryrun:
        log.info(
            f"  [v3.6 DRYRUN] sem UPDATE raw_json/colunas "
            f"itens={len(v2_out.get('itens_fatura') or []) if isinstance(v2_out, dict) else 0} "
            f"fonte={(v2_out.get('_itens_fonte') if isinstance(v2_out, dict) else None) or 'pipeline'}"
        )
        return payload
    try:
        # RECONEXÃO PRÉ-SAVE: a extração acima leva 100-270s e o RDS derruba a conexão
        # ociosa nesse intervalo (Errno 10054). Sem isto, os writes/commit abaixo batem numa
        # conexão morta e a fatura se PERDE (~43% de perda observada com 8 workers). Reconecta
        # em cima da MESMA conn (ping reconnect, in-place → helpers que recebem `conn` seguem
        # válidos) e refaz o cursor local. Janela conn→commit passa de ~270s para ~1s.
        try:
            conn.ping(reconnect=True, attempts=3, delay=2)
            cur = conn.cursor(dictionary=True)
        except Exception as _rc:
            log.warning(f"  [v3] reconnect pré-save falhou: {_rc}")
        # IMPORTANTE: `fid` é ID da ORIGEM. FDE usa `uid` como chave de junção.
        if not uid:
            log.warning(f"  [v3] sem UID — não consigo persistir (fid origem={fid})")
            return
        cur.execute(f"SELECT extracao_raw_json FROM {TBL_FDE} WHERE uid=%s LIMIT 1", (uid,))
        r = cur.fetchone()
        if isinstance(r, dict):
            raw = r.get("extracao_raw_json")
        elif r is not None:
            raw = r[0]
        else:
            raw = None
        raw = raw or "{}"
        try: raw_dict = _json.loads(raw) if isinstance(raw, str) else (raw or {})
        except: raw_dict = {}
        if not isinstance(raw_dict, dict): raw_dict = {}
        raw_dict["regex_v3"] = payload
        cur.execute(
            f"UPDATE {TBL_FDE} SET extracao_raw_json=%s WHERE uid=%s",
            (_json.dumps(raw_dict, ensure_ascii=False, default=str), uid),
        )
        # Sincroniza colunas tradicionais que ficaram com lixo (parser antigo) usando dados do JSON novo
        try:
            cli = (v2_out.get("cliente") or {}) if isinstance(v2_out, dict) else {}
            vv  = (v2_out.get("vencimento_valor") or {}) if isinstance(v2_out, dict) else {}
            razao_social = cli.get("razao_social")
            mes_ref_json = vv.get("mes_ref")
            # Só corrige nome_cliente quando atual está com lixo conhecido OU é null
            if razao_social:
                cur.execute(
                    f"UPDATE {TBL_FDE} SET nome_cliente=%s WHERE uid=%s AND ("
                    "nome_cliente IS NULL OR "
                    "UPPER(nome_cliente) IN ('RURAL','MENINO DE DEUS','URBANA','COMERCIAL','RESIDENCIAL','AGROPECUARIA') OR "
                    "LOWER(nome_cliente) LIKE '%%ficou sem%%' OR "
                    "LOWER(nome_cliente) LIKE '%%domic%%'"
                    ")",
                    (razao_social, uid),
                )
            # mes_referencia: só sobrescreve se o JSON tem valor e o atual está vazio
            if mes_ref_json and re.match(r"\d{2}/\d{4}", mes_ref_json):
                cur.execute(
                    f"UPDATE {TBL_FDE} SET mes_referencia=%s WHERE uid=%s AND (mes_referencia IS NULL OR mes_referencia = '')",
                    (mes_ref_json, uid),
                )
            # #119: NÃO commita aqui — consolida 1 commit/fatura no fim do bloco v3.
        except Exception as e_sync:
            log.warning(f"  [v3 sync col] erro: {e_sync}")

        log.info(f"  [v3.6 grava raw_json] {len(_json.dumps(raw_dict, default=str))/1024:.1f} KB")

        # 4.5) Popula 30+ colunas individuais SQL (codigo_uc, cpf_cnpj, pis_valor,
        # icms_valor, historico_consumo_json, extracao_score_confianca etc.) a
        # partir de v2_out. sobrescrever=force: --force reprocessa colunas existentes.
        # Anexa texto plumber em v2_out pra fallback do nome_cliente (Fix H).
        if isinstance(v2_out, dict):
            v2_out["_texto_plumber"] = texto_plumber or ""
        # COELBA/Neoenergia NF3e: o texto_plumber PERDE a tabela de itens (a tarifa vinha do
        # LLM, que confunde com PIS/COFINS). O fitz captura as linhas Consumo-TE/Consumo-TUSD;
        # lê o preço e sobrescreve _tarifas_derivadas (que vira tarifa_te/tarifa_tusd no banco).
        # Só dispara no layout Coelba (exige ambos os rótulos) e no caminho COM download (pdf_bytes).
        if pdf_bytes and isinstance(v2_out, dict):
            try:
                _cb = _coelba_tarifa_fitz(pdf_bytes)
                if _cb:
                    v2_out.setdefault("_tarifas_derivadas", {}).update(_cb)
                    log.info(f"  [v3 coelba_fitz] tarifa sobrescrita via fitz: {_cb}")
            except Exception as _e:
                log.warning(f"  [v3 coelba_fitz] erro: {_e}")
            # Grupo B: extrator coordenado genérico cobre CPFL Santa Cruz/Piratininga (e reforça
            # Neoenergia). Corrige o bug tarifa_tusd>1 (valor de tributo lido como tarifa) na RAIZ.
            # Restrito a subgrupo B pra não confundir com a tarifa de ponta do Grupo A.
            try:
                if (v2_out.get("subgrupo_tarifario") or "").upper().startswith("B"):
                    _bt = _tarifa_bt_fitz(pdf_bytes)
                    if _bt:
                        v2_out.setdefault("_tarifas_derivadas", {}).update(_bt)
                        log.info(f"  [v3 tarifa_bt_fitz] tarifa B sobrescrita via fitz: {_bt}")
            except Exception as _e:
                log.warning(f"  [v3 tarifa_bt_fitz] erro: {_e}")
        t_etapa = time.time()
        colunas_atualizadas = 0
        try:
            from atualizar_colunas_db import atualizar_colunas_individuais
            cur.execute(f"SELECT id FROM {TBL_FDE} WHERE uid=%s LIMIT 1", (uid,))
            r_id = cur.fetchone()
            if r_id:
                fde_id = r_id.get("id") if isinstance(r_id, dict) else r_id[0]
                # sobrescrever=True por default: v3 (extrator novo + agregados) sempre vence
                # o regex v1 do passo 6, que grava lixo em algumas faturas legado.
                ret_cols = atualizar_colunas_individuais(conn, fde_id, v2_out, sobrescrever=True, commit=False)
                colunas_atualizadas = ret_cols.get("qtd", 0)
            log.info(f"  [v3.7 colunas_sql] {colunas_atualizadas} colunas atualizadas (sobrescrever={force}) ({time.time()-t_etapa:.1f}s)")
        except Exception as e_cols:
            log.warning(f"  [v3.7 colunas_sql] erro: {e_cols}")

        # 4.6) Grava validador_gate (aprovado/revisao/reprovado/scaneada) — sempre sobrescreve
        gate = qualidade.get("gate") if isinstance(qualidade, dict) else None
        # PROPAGAÇÃO#5 (automática): se ICMS+PIS+COFINS extraídos, o gate é aprovado —
        # alinha o pipeline aos reprocessar_*.py / atualizar_colunas_db (validador é conservador).
        # Preserva 'scaneada' (caso especial fora dos 3 gates normais).
        if gate != "scaneada":
            try:
                _tpd = (v2_out.get("tributos_por_dist") or {})
                _tagg = (v2_out.get("tributos_agregados_itens") or {})
                def _pf(s):
                    try:
                        s = str(s).strip().rstrip("-")
                        return float(s.replace(".", "").replace(",", ".")) if "," in s else float(s)
                    except Exception:
                        return None
                _icms = _pf((_tpd.get("icms") or {}).get("valor_string"))
                _pis = _pf((_tpd.get("pis") or {}).get("valor_string"))
                _cof = _pf((_tpd.get("cofins") or {}).get("valor_string"))
                # combo PIS+COFINS (ex.: Copel — pdfplumber intercala as colunas → só vem
                # o combinado na linha TOTAL). Preenche QUALQUER um que falte (não exige os
                # dois None): Copel às vezes deixa um pis solto/lixo no tpd mas o cofins None,
                # e aí o combo não disparava → não flippava. O split real (17.9/82.1) é feito
                # depois em atualizar_colunas_db; aqui é só sinal de presença p/ a trava A.
                _combo = (_tagg.get("pis_cofins_liquido") or _tagg.get("pis_cofins_agregado") or {}).get("valor_numerico")
                if _combo is not None:
                    if _pis is None: _pis = _combo
                    if _cof is None: _cof = _combo
                if _icms is not None and _pis is not None and _cof is not None:
                    # TRAVA (opção A): promove a aprovado quando tem i+p+c E valor_total.
                    # NÃO exige o check 'obrigatorios' inteiro — ele exige codigo_instalacao,
                    # que vem da ORIGEM (sgeeasy), não do PDF; exigir derrubava ~3,5k faturas
                    # boas (tributo correto) por falso-fail. valor_total é o sinal real de
                    # fatura completa; sem ele (lixo/quebrada) → não promove.
                    _vv = (v2_out.get("vencimento_valor") or {})
                    _tem_total = bool(_vv.get("valor_total") or _vv.get("valor_a_pagar") or v2_out.get("valor_total"))
                    if not _tem_total and uid:
                        # Fallback: algumas dists DERIVAM o total (não imprimem literal no
                        # texto) — ex. Celesc = subtotal + CIP. O valor já consolidado fica
                        # em valor_total_fatura (o v3.7 preserva no reprocessamento). Usar o
                        # dado JÁ EXISTENTE e validado (não inventa nada) como sinal de
                        # fatura fiscalmente completa p/ a trava A.
                        try:
                            cur.execute(f"SELECT valor_total_fatura vt FROM {TBL_FDE} WHERE uid=%s", (uid,))
                            _rt = cur.fetchone()
                            _vt = (_rt.get("vt") if isinstance(_rt, dict) else (_rt[0] if _rt else None)) if _rt else None
                            if _vt and float(_vt) > 0:
                                _tem_total = True
                        except Exception:
                            pass
                    # #117 GUARD (veracidade) — REFINADO. Bloquear todo soma_itens=FAIL era
                    # cego: 35% dos aprovados dão FAIL, mas a maioria é ACL/mercado-livre
                    # (itens parciais por design; com SKIP_SEFAZ o cross-check que tornaria
                    # PASS está off) ou divergência LEVE (5-20%, item faltando). Garbage real
                    # = divergência SEVERA (>30%) E SEM marcador ACL/livre/GD/dedução. Só esse
                    # caso não promove (itens claramente quebrados). ACL e leve seguem aprovado
                    # — os tributos+total carregam a fatura.
                    _soma_hard = False
                    try:
                        _csi = next((c for c in ((qualidade or {}).get("checks") or [])
                                     if c.get("nome") == "soma_itens" and c.get("status") == "FAIL"), None)
                        if _csi:
                            _df = _csi.get("diff"); _tf = _csi.get("total_fatura")
                            _pct = (_df / _tf) if (_df and _tf) else 0
                            _acl = bool(re.search(r"ACL|ENERGIA\s+INJ|MUC|OUC|SCEE|MERCADO\s+LIVRE|"
                                                  r"\bLIVRE\b|BENEF|DESC\s+ENERG|DEDU[CÇ][AÃ]O",
                                                  texto_v2 or "", re.I))
                            _soma_hard = (_pct > 0.30) and not _acl
                    except Exception:
                        _soma_hard = False
                    if _tem_total and not _soma_hard:
                        gate = "aprovado"
            except Exception:
                pass
        if gate:
            try:
                cur.execute(
                    f"UPDATE {TBL_FDE} SET validador_gate=%s WHERE uid=%s",
                    (gate, uid),
                )
                log.info(f"  [v3.8 grava gate] {gate}")
            except Exception as e_gate:
                log.warning(f"  [v3.8 grava gate] erro: {e_gate}")

        # 4.8) AUTO-AUDIT (opcional; gated por env PDF_PIPELINE_AUTO_AUDIT=1) — Milestone 2.
        # Marca auditado=1 AUTOMÁTICO quando o validador determinístico aprovou com score alto
        # (soma_itens/tributos fecham). Replica o critério manual (extração confiável = gold).
        # Modelo da vision não importa aqui: o GATE determinístico é quem libera (protege o
        # ressarcimento). Reversível: registra em AUDITADOS_AUTO_LOG (dá pra desmarcar em lote).
        # Não commita — entra no commit único do bloco v3.
        if gate == "aprovado" and os.getenv("PDF_PIPELINE_AUTO_AUDIT") == "1" and uid:
            try:
                _min = float(os.getenv("PDF_PIPELINE_AUTO_AUDIT_MIN_SCORE", "95") or 95)
            except Exception:
                _min = 90.0
            try:
                _score = float((qualidade or {}).get("score") or 0)
            except Exception:
                _score = 0.0
            if _score >= _min:
                try:
                    cur.execute(
                        "CREATE TABLE IF NOT EXISTS AUDITADOS_AUTO_LOG ("
                        "uid VARCHAR(64) PRIMARY KEY, gate VARCHAR(16), score DECIMAL(5,1), criado_em DATETIME)"
                    )
                    cur.execute(
                        f"UPDATE {TBL_FDE} SET auditado=1 WHERE uid=%s AND COALESCE(auditado,0)<>1",
                        (uid,),
                    )
                    if cur.rowcount:
                        cur.execute(
                            "INSERT INTO AUDITADOS_AUTO_LOG (uid, gate, score, criado_em) VALUES (%s,%s,%s,NOW()) "
                            "ON DUPLICATE KEY UPDATE gate=VALUES(gate), score=VALUES(score), criado_em=NOW()",
                            (uid, gate, _score),
                        )
                        log.info(f"  [v3.8 AUTO-AUDIT] auditado=1 (gate={gate} score={_score:.1f} >= {_min:.0f})")
                except Exception as e_aa:
                    log.warning(f"  [v3.8 AUTO-AUDIT] erro: {e_aa}")

        # 4.7) Detecta template do layout (ia/mapas_manuais/*.json + catálogo built-in)
        # e grava em layout_template_id — permite filtrar faturas por layout desconhecido.
        layout_template_id = None
        t_etapa = time.time()
        try:
            from detector_layout import detectar_layout
            layout_template_id = detectar_layout(
                texto_v2 or "",
                mapa_pipeline=v2_out.get("_mapa_usado") if isinstance(v2_out, dict) else None,
            )
            cur.execute(
                f"UPDATE {TBL_FDE} SET layout_template_id=%s WHERE uid=%s",
                (layout_template_id, uid),
            )
            log.info(f"  [v3.9 detector_layout] {layout_template_id} ({time.time()-t_etapa:.1f}s)")
        except Exception as e_layout:
            log.warning(f"  [v3.9 detector_layout] erro: {e_layout}")

        # #119: 1 COMMIT por fatura (consolida raw_json + nome/mes + colunas + gate + layout).
        # Antes eram ~3-5 commits/fatura = round-trips RDS (o gargalo da escrita). Agora tudo
        # numa transação só → menos latência. Se qualquer etapa falhou, o conjunto reverte junto.
        conn.commit()
        log.info(f"  [v3] FINAL | mapa={v2_out.get('_mapa_usado')} cols={colunas_atualizadas} gate={gate or '-'} score={qualidade.get('score', '-') if isinstance(qualidade, dict) else '-'} layout={layout_template_id or '-'}")
    except Exception as e:
        log.warning(f"  [v3] SQL save erro: {e}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main(cod_empresas: list[int], force: bool, limite: int | None,
         dryrun: bool, extrator: str, ordem: str = "DESC",
         ids: list[int] | None = None,
         com_itens: bool = False,
         skip_processadas: bool = False,
         workers: int = 1):

    log.info("=" * 60)
    if ids:
        log.info(f"pdf_pipeline.py  id(s)={ids}  extrator={extrator}  force={force}  dryrun={dryrun}  skip_processadas={skip_processadas}")
    else:
        empresas_str = ", ".join(str(e) for e in cod_empresas)
        log.info(f"pdf_pipeline.py  empresa(s)={empresas_str}  extrator={extrator}"
                 f"  ordem={ordem}  force={force}  limite={limite or 'sem limite'}  dryrun={dryrun}"
                 f"  skip_processadas={skip_processadas}")

    rodar_plumber   = extrator in ("all", "plumber")
    rodar_markdown  = extrator in ("all", "markdown")
    rodar_ocr       = extrator in ("all", "ocr")
    # OCR é caro (~20-80s/GPU) e só agrega em PDF escaneado. No modo "all" ele agora
    # entra apenas como FALLBACK: roda só se plumber+markdown+bbox vierem pobres
    # (nenhum atingiu OCR_GATE_MIN_CHARS). Com --extrator ocr o usuário força sempre.
    ocr_explicito   = (extrator == "ocr")
    OCR_GATE_MIN_CHARS = int(os.getenv("OCR_GATE_MIN_CHARS", "800"))

    # 2 conexões: destino (DB) onde gravamos, origem (DB_ORIGEM) onde lemos
    # as faturas registradas direto do sgeeasy. Não dependemos mais do
    # sync_faturas — eliminado o gargalo do cursor incremental.
    conn = mysql.connector.connect(**DB)
    cur  = conn.cursor(dictionary=True)
    conn_orig = mysql.connector.connect(**DB_ORIGEM)
    cur_orig  = conn_orig.cursor(dictionary=True)

    # Pré-busca UIDs já processados (skip_processadas) — usado pra filtrar o loop
    uids_processadas = set()
    if skip_processadas:
        if cod_empresas:
            placeholders = ",".join(["%s"] * len(cod_empresas))
            cur.execute(
                f"SELECT uid FROM {TBL_FDE} WHERE cod_empresa IN ({placeholders}) "
                f"AND validador_gate IS NOT NULL AND uid IS NOT NULL",
                cod_empresas
            )
        else:
            cur.execute(f"SELECT uid FROM {TBL_FDE} WHERE validador_gate IS NOT NULL AND uid IS NOT NULL")
        uids_processadas = {r["uid"] for r in cur.fetchall() if r.get("uid")}
        log.info(f"[skip-processadas] {len(uids_processadas)} faturas já têm validador_gate — serão puladas")
    links_invalidos = {}
    if skip_processadas and os.environ.get("PDF_PIPELINE_RETENTAR_INVALIDOS") != "1":
        try:
            _garantir_tbl_link_invalido(cur)
            cur.execute(f"SELECT uid, link FROM {_tbl_link_inv()}")
            links_invalidos = {str(r["uid"]): (r["link"] or "").strip() for r in cur.fetchall()}
        except Exception as e:
            log.warning(f"[link-invalido] não li a tabela ({e}) — nenhuma fatura pulada por link")

    if ids:
        lista_ids = ", ".join(str(i) for i in ids)
        filtros = [f"frc.id IN ({lista_ids})", "frc.Link IS NOT NULL", "TRIM(frc.Link) != ''"]
    else:
        if len(cod_empresas) == 1:
            filtro_empresa = f"frc.Cod_Empresa = {cod_empresas[0]}"
        else:
            lista = ", ".join(str(e) for e in cod_empresas)
            filtro_empresa = f"frc.Cod_Empresa IN ({lista})"
        filtros = [filtro_empresa, "frc.Link IS NOT NULL", "TRIM(frc.Link) != ''"]

    where   = " AND ".join(filtros)
    lim_sql = f"LIMIT {limite}" if (limite and not ids) else ""

    # Lê direto da origem (sgeeasy_clientes_novo). Não precisa de COLLATE
    # porque é uma conexão única na origem.
    cur_orig.execute(f"""
        SELECT frc.id, frc.UID, frc.Cod_Empresa, frc.UC, frc.Mes_Ref, frc.Link,
               frc.CNPJ_Fatura, frc.Concessionaria, frc.CNPJ_Concessionaria, frc.Tp_Tensao,
               frc.Classe_Tarifaria, frc.Mercado, frc.NroMedidor, frc.NroNF,
               frc.Dt_Leitura_Anterior, frc.Dt_Leitura_Atual, frc.Qtd_Dias, frc.DATA_PROXIMA_LEITURA,
               frc.KWH_Ponta, frc.RS_KWH_Ponta, frc.KWH_FPonta, frc.RS_KWH_FPonta,
               frc.KWH_Reservado, frc.RS_KWH_Reservado, frc.KWH_Total, frc.RS_KWH_Total, frc.RS_Total_Fatura,
               frc.KW_Contratada_Ponta, frc.KW_Contratada_FPonta, frc.KW_Registrada_Ponta, frc.KW_Registrada_FPonta,
               frc.UFER_Ponta, frc.UFER_FPonta, frc.UFER_Reservado, frc.KWH_Total_Injet,
               frc.UCs_Anteriores, frc.RAZAO_SOCIAL, frc.Empresa
        FROM Faturas_Registradas_Cache frc
        WHERE {where}
        ORDER BY frc.id {ordem}
        {lim_sql}
    """)
    todas_origem = cur_orig.fetchall()
    log.info(f"Faturas na origem ({DB_ORIGEM.get('database','?')}): {len(todas_origem)}")

    # Se não force, descobrimos quais UIDs já foram processados no destino
    # e filtramos fora aqui mesmo (em Python). Bem mais simples que JOIN.
    if not force and todas_origem:
        uids = [r["UID"] for r in todas_origem if r.get("UID")]
        if uids:
            placeholders = ", ".join(["%s"] * len(uids))
            cur.execute(f"""
                SELECT uid, plumber_gerado_em, markdown_gerado_em, ocr_gerado_em, validador_gate
                FROM FATURA_DADOS_EXTRAIDOS
                WHERE uid IN ({placeholders})
            """, uids)
            ja_processadas = {r["uid"]: r for r in cur.fetchall()}
        else:
            ja_processadas = {}

        def _precisa_rodar(uid):
            r = ja_processadas.get(uid)
            if not r:
                return True
            if rodar_plumber and not r["plumber_gerado_em"]:
                return True
            if rodar_markdown and not r["markdown_gerado_em"]:
                return True
            if rodar_ocr and not r["ocr_gerado_em"]:
                return True
            # v3 não rodou — texto extraído mas validador_gate NULL (queda no meio)
            if not r.get("validador_gate"):
                return True
            return False

        faturas = [r for r in todas_origem if _precisa_rodar(r.get("UID"))]
        # Anota o estado do FDE (compatibilidade com código abaixo que usa _fde_*)
        for f in faturas:
            r = ja_processadas.get(f["UID"]) or {}
            f["_fde_plumber"]  = r.get("plumber_gerado_em")
            f["_fde_markdown"] = r.get("markdown_gerado_em")
            f["_fde_ocr"]      = r.get("ocr_gerado_em")
    else:
        faturas = list(todas_origem)
        for f in faturas:
            f["_fde_plumber"]  = None
            f["_fde_markdown"] = None
            f["_fde_ocr"]      = None

    # --skip-processadas: remove faturas que já têm validador_gate preenchido
    if skip_processadas and uids_processadas:
        antes = len(faturas)
        faturas = [f for f in faturas if (f.get("UID") or "").strip() not in uids_processadas]
        log.info(f"[skip-processadas] {antes - len(faturas)} faturas puladas (já processadas), {len(faturas)} restantes")
    if links_invalidos:
        antes = len(faturas)
        faturas = [f for f in faturas
                   if links_invalidos.get(str((f.get("UID") or "")).strip()) != str(f.get("Link") or "").strip()]
        log.info(f"[link-invalido] {antes - len(faturas)} faturas puladas (link já falhou e não mudou na origem), {len(faturas)} restantes")

    cur_orig.close()
    conn_orig.close()
    log.info(f"Faturas para processar: {len(faturas)}")

    if not faturas:
        log.info("Nada a processar.")
        cur.close(); conn.close(); return

    # Otimização #2: warmup do markitdown — paga inicialização lenta (~20min na 1ª
    # vez, instantâneo se já cacheado) ANTES do loop. Sem isso, a 1ª fatura paga
    # o custo sozinha e atrasa o batch (e com paralelismo os outros workers ficam esperando).
    if extrator in ("all", "markdown") and not NO_OCR:
        # Com --no-ocr o fallback markitdown nunca roda → não precisa aquecer a lib.
        log.info("[warmup] Aquecendo markitdown...")
        t_warm = time.time()
        try:
            _carrega_markitdown()
            log.info(f"[warmup] markitdown pronto ({time.time()-t_warm:.1f}s)")
        except Exception as e:
            log.warning(f"[warmup] markitdown erro: {e}")

    # Fecha conexão principal — cada worker terá sua própria.
    cur.close(); conn.close()

    ok = erro = 0
    import threading
    from concurrent.futures import ThreadPoolExecutor, as_completed
    _lock = threading.Lock()
    _contador = {"ok": 0, "erro": 0, "feitas": 0}
    n_total = len(faturas)

    def _processar_uma_fatura(row, i):
        """Processa 1 fatura. Cada worker tem sua própria conexão MySQL.

        Retorna dict {ok: bool, fid: int, erro: str}.
        """
        # Aborta cedo se Ctrl+C foi pressionado (futures pendentes não iniciam trabalho).
        if _stop_event.is_set():
            return {"ok": False, "fid": row.get("id"), "erro": "abortado (Ctrl+C)"}
        # Conexão dedicada do worker
        worker_conn = mysql.connector.connect(**DB)
        worker_cur = worker_conn.cursor(dictionary=True)

        def _garantir_conexao_local():
            nonlocal worker_conn, worker_cur
            try:
                worker_conn.ping(reconnect=True, attempts=3, delay=2)
            except Exception:
                try: worker_cur.close()
                except: pass
                try: worker_conn.close()
                except: pass
                worker_conn = mysql.connector.connect(**DB)
                worker_cur = worker_conn.cursor(dictionary=True)

        try:
            fid       = row["id"]
            uid_neg   = (row.get("UID") or "").strip() if isinstance(row.get("UID"), str) else row.get("UID")
            if uid_neg in ("", "0"):
                uid_neg = None
            uc        = row["UC"]
            mes       = row["Mes_Ref"]
            link      = str(row["Link"]).strip()

            with _lock:
                _contador["feitas"] += 1
                progresso = _contador["feitas"]
            log.info(f"\n[{progresso}/{n_total}] id={fid}  UC={uc}  ref={mes}")

            # ── Download PDF ──────────────────────────────────────────────────────
            pdf_bytes = baixar_pdf(link)
            if pdf_bytes and b"%PDF-" not in pdf_bytes[:1024]:
                log.warning("    Download falhou: conteúdo não é PDF")
                _dl_info.motivo = "nao_e_pdf"
                pdf_bytes = None
            if not pdf_bytes:
                # Marca como tentado-e-falhou em FATURA_DADOS_EXTRAIDOS.
                if uid_neg:
                    try:
                        _garantir_conexao_local()
                        worker_cur.execute(f"""
                            INSERT INTO {TBL_FDE}
                                (uid, texto_plumber, texto_markdown, texto_ocr,
                                 plumber_gerado_em, markdown_gerado_em, ocr_gerado_em)
                            VALUES (%s, '', '', '', NOW(), NOW(), NOW())
                            ON DUPLICATE KEY UPDATE
                                texto_plumber      = COALESCE(NULLIF(texto_plumber, ''),       ''),
                                texto_markdown     = COALESCE(NULLIF(texto_markdown, ''),      ''),
                                texto_ocr          = COALESCE(NULLIF(texto_ocr, ''),           ''),
                                plumber_gerado_em  = COALESCE(plumber_gerado_em,  NOW()),
                                markdown_gerado_em = COALESCE(markdown_gerado_em, NOW()),
                                ocr_gerado_em      = COALESCE(ocr_gerado_em,      NOW())
                        """, (uid_neg,))
                        worker_conn.commit()
                        log.info("  [download] falhou — marcada como nao-processavel em FDE")
                    except Exception as e:
                        log.warning(f"  [download] falha ao marcar em FDE: {e}")
                else:
                    log.warning("  [download] falhou e sem UID — nada a marcar")
                if uid_neg and getattr(_dl_info, "motivo", None):
                    _garantir_conexao_local()
                    _marcar_link_invalido(worker_cur, worker_conn, uid_neg, link, _dl_info.motivo)
                return {"ok": False, "fid": fid, "erro": "download_falhou"}
            log.info(f"  PDF: {len(pdf_bytes)/1024:.1f} KB")

            campos_plumber  = _campos_vazios()
            campos_ocr      = _campos_vazios()
            campos_markdown = _campos_vazios()
            texto_plumber   = ""
            texto_markitdown  = ""
            texto_ocr       = ""
            plumber_ok      = False

            # ── 1. pdfplumber ─────────────────────────────────────────────────────
            if rodar_plumber and (force or _vazio(row.get("_fde_plumber"))):
                log.info("  [plumber] extraindo...")
                t0 = time.time()
                texto_plumber, campos_plumber = extrair_plumber(pdf_bytes)
                dt = time.time() - t0
                if texto_plumber:
                    plumber_ok = True
                    log.info(f"  [plumber] {len(texto_plumber)} chars | {dt:.1f}s")
                else:
                    log.warning("  [plumber] retornou vazio — PDF pode ser escaneado")

            # ── 2. markitdown ─────────────────────────────────────────────────────
            if rodar_markdown and (force or _vazio(row.get("_fde_markdown"))):
                log.info("  [markdown] extraindo...")
                t0 = time.time()
                texto_markitdown = extrair_markdown(pdf_bytes)
                dt = time.time() - t0
                if texto_markitdown:
                    log.info(f"  [markdown] {len(texto_markitdown)} chars | {dt:.1f}s")
                    campos_markdown = parse_regex(texto_markitdown.splitlines())
                else:
                    log.warning("  [markdown] retornou vazio")

            # ── 3. PyMuPDF bbox-ordenado (linha-real) ─────────────────────────────
            # Reorganiza spans por (y, x) — resolve DANF3E onde plumber lê coluna-a-coluna.
            # Crítico pra Via Varejo Light/Enel SP onde itens ficam quebrados em 5+ linhas.
            # Roda ANTES do OCR porque entra no gate que decide se o OCR é necessário.
            texto_bbox = ""
            try:
                from extrair_texto_bbox import extrair_texto_bbox_ordenado
                t0 = time.time()
                texto_bbox = extrair_texto_bbox_ordenado(pdf_bytes) or ""
                dt = time.time() - t0
                if texto_bbox:
                    log.info(f"  [bbox] {len(texto_bbox)} chars | {dt:.1f}s")
            except Exception as _e_bbox:
                log.warning(f"  [bbox] excecao: {_e_bbox}")

            # ── 4. Tesseract OCR (fallback condicional — só pra PDF escaneado) ────
            # As 3 fontes acima (plumber/markdown/bbox) leem a CAMADA DE TEXTO do PDF:
            # exatas e instantâneas. Se a melhor delas já tem conteúdo suficiente, o PDF
            # é nativo e o OCR (lento, aproximado) é desnecessário. Só quando TODAS vêm
            # pobres (PDF escaneado) o OCR entra como única fonte possível.
            melhor_texto_layer = max(len(texto_plumber or ""),
                                     len(texto_markitdown or ""),
                                     len(texto_bbox or ""))
            fontes_pobres = melhor_texto_layer < OCR_GATE_MIN_CHARS

            if NO_OCR:
                # --no-ocr: Tesseract totalmente desligado (estágio [ocr] nunca roda).
                precisa_ocr = False
            elif ocr_explicito:
                # --extrator ocr: usuário forçou OCR explicitamente.
                precisa_ocr = (force or _vazio(row.get("_fde_ocr")))
            elif rodar_ocr:
                # modo "all": OCR só como fallback quando as 3 fontes vieram pobres.
                precisa_ocr = fontes_pobres and (force or _vazio(row.get("_fde_ocr")))
            else:
                # --extrator plumber/markdown: nunca roda OCR.
                precisa_ocr = False

            if precisa_ocr:
                motivo = "forçado" if ocr_explicito else f"fallback: melhor fonte {melhor_texto_layer} < {OCR_GATE_MIN_CHARS} chars"
                log.info(f"  [ocr] extraindo... ({motivo})")
                t0 = time.time()
                texto_ocr, campos_ocr = extrair_ocr(pdf_bytes, fid)
                dt = time.time() - t0
                if texto_ocr:
                    log.info(f"  [ocr] {len(texto_ocr)} chars | {dt:.1f}s")
                else:
                    log.warning("  [ocr] retornou vazio")
                    return {"ok": False, "fid": fid, "erro": "ocr_vazio"}
            elif rodar_ocr and not ocr_explicito:
                log.info(f"  [ocr] pulado — text-layer OK ({melhor_texto_layer} >= {OCR_GATE_MIN_CHARS} chars)")

            if dryrun:
                if link:
                    try:
                        payload_v3 = _rodar_pipeline_v3(
                            worker_cur, worker_conn, fid, pdf_bytes,
                            texto_plumber, texto_markitdown, texto_ocr,
                            uid=uid_neg, force=force,
                            texto_bbox=texto_bbox or None,
                            dryrun=True,
                        )
                        v2_dbg = (payload_v3 or {}).get("v2") if isinstance(payload_v3, dict) else {}
                        log.info(
                            f"  [DRYRUN v3] itens={len((v2_dbg or {}).get('itens_fatura') or [])} "
                            f"fonte={(v2_dbg or {}).get('_itens_fonte') or 'pipeline'}"
                        )
                    except Exception as _e_v3:
                        log.warning(f"  [DRYRUN v3] excecao: {_e_v3}")
                log.info("  [DRYRUN] Não gravando.")
                return {"ok": True, "fid": fid, "erro": None}

            # ── Grava textos brutos em FATURA_DADOS_EXTRAIDOS ────────────────────
            _garantir_conexao_local()

            campos_final = _merge_campos(campos_plumber, campos_ocr, campos_markdown)
            gravar_campos(worker_cur, worker_conn, fid, campos_final, row)

            if not dryrun:
                _gravar_textos_fde(worker_cur, worker_conn,
                                   uid=str(row.get("UID") or "").strip() or None,
                                   texto_plumber=texto_plumber or None,
                                   texto_markdown=texto_markitdown or None,
                                   texto_ocr=texto_ocr or None,
                                   texto_bbox=texto_bbox or None)

            # === CAMADA v3 DETERMINÍSTICA ===
            if not dryrun and link:
                try:
                    _rodar_pipeline_v3(worker_cur, worker_conn, fid, pdf_bytes,
                                       texto_plumber, texto_markitdown, texto_ocr,
                                       uid=uid_neg, force=force,
                                       texto_bbox=texto_bbox or None,
                                       dryrun=False)
                except Exception as _e_v3:
                    log.warning(f"  [v3] excecao: {_e_v3}")

            # === PARSERS POR LAYOUT (auto-validados) ===========================
            # Corrige leitura/K/consumo a partir do BLOCO TÉCNICO da fatura,
            # gravando SÓ quando (leit_atu-leit_ant)*K == consumo (à prova de erro).
            # Resolve o bug de gravar a linha "Energia Elétrica" (líquido pós-GD)
            # como consumo. Layouts são adicionados em parsers_layout.py.
            if not dryrun and uid_neg:
                try:
                    from parsers_layout import aplicar_parsers
                    _txt = (texto_plumber or "") + "\n" + (texto_markitdown or "") + "\n" + (texto_bbox or "")
                    _pl = aplicar_parsers(_txt)
                    if _pl.get("_medicao_validada"):
                        _cols = {k: v for k, v in _pl.items() if not k.startswith("_")}
                        if _cols:
                            _sets = ", ".join(f"{k}=%s" for k in _cols)
                            worker_cur.execute(
                                f"UPDATE {TBL_FDE} SET {_sets} WHERE uid=%s",
                                (*_cols.values(), uid_neg))
                            worker_conn.commit()
                            log.info(f"  [parser:{_pl['_layout']}] medição OK → {list(_cols)}")
                except Exception as _e_pl:
                    log.warning(f"  [parser_layout] excecao: {_e_pl}")

            # === ESPELHO DA ORIGEM (sgeeasy) — preenche cadastrais + gaps ======
            # Roda DEPOIS do extrator: cadastrais (mercado, tensão, ligação, NF,
            # UCs, razão) a origem vence; medição/demanda/reativo/GD a origem só
            # preenche o que o extrator deixou vazio (COALESCE). Cura os campos
            # que vinham — no relatório.
            if not dryrun:
                _gravar_mirror_origem(worker_cur, worker_conn,
                                      str(row.get("UID") or "").strip() or None, row)

            # === ESPECIALISTA GD → extracao_gd_raw (JSON) ======================
            # PROJEÇÃO do extracao_raw_json que o extrator_v3 JÁ extraiu (geracao_distribuida,
            # gd_scee, itens_fatura[eh_credito_gd], historico_13m_consumo). SEM regex novo.
            # Medição vem das colunas validadas (parsers_layout).
            if not dryrun:
                    try:
                        from gd_extractor import extrair_gd_raw_do_json
                        import json as _jgd
                        _uid_gd = str(row.get("UID") or "").strip()
                        if _uid_gd:
                            worker_cur.execute(
                                f"SELECT extracao_raw_json, numero_medidor, constante_k, "
                                f"leit_ant_ativa_ponta, leit_ant_ativa_fponta, leit_atu_ativa_ponta, "
                                f"leit_atu_ativa_fponta, consumo_ativo_ponta_kwh, consumo_ativo_fponta_kwh, "
                                f"tipo_medicao FROM {TBL_FDE} WHERE uid=%s", (_uid_gd,))
                            _rg = worker_cur.fetchone()  # dictionary cursor → acesso por chave
                            _raw = _rg.get("extracao_raw_json") if _rg else None
                            _gd = extrair_gd_raw_do_json(_raw) if _raw else None
                            if _gd is not None:
                                _med_cols = {}
                                _med_map = [
                                    ("numero_medidor", _rg.get("numero_medidor")), ("constante", _rg.get("constante_k")),
                                    ("leitura_anterior_ponta", _rg.get("leit_ant_ativa_ponta")), ("leitura_anterior_fponta", _rg.get("leit_ant_ativa_fponta")),
                                    ("leitura_atual_ponta", _rg.get("leit_atu_ativa_ponta")), ("leitura_atual_fponta", _rg.get("leit_atu_ativa_fponta")),
                                    ("consumo_ponta_kwh", _rg.get("consumo_ativo_ponta_kwh")), ("consumo_fponta_kwh", _rg.get("consumo_ativo_fponta_kwh")),
                                    ("tipo_medicao", _rg.get("tipo_medicao")),
                                ]
                                for _k, _v in _med_map:
                                    if _v is None:
                                        continue
                                    if _k == "numero_medidor":
                                        _v = str(_v).lstrip("`").strip()
                                    _med_cols[_k] = _v
                                if _med_cols and not _gd.get("medicao"):
                                    _med_cols["_fonte"] = "colunas_validadas"
                                    _gd["medicao"] = _med_cols
                                worker_cur.execute(
                                    f"UPDATE {TBL_FDE} SET extracao_gd_raw=%s WHERE uid=%s",
                                    (_jgd.dumps(_gd, ensure_ascii=False, default=str), _uid_gd))
                                worker_conn.commit()
                                log.info(f"  [gd_raw<-raw_json] {list(_gd)}")
                    except Exception as _e_gd:
                        log.warning(f"  [gd_extractor] excecao: {_e_gd}")

            # === CAMADA 4.5 (opcional) ===
            if com_itens and _CAMADA_45_DISPONIVEL and not dryrun and link:
                try:
                    res_itens = _extrair_itens_cascata_v45(
                        fid, link,
                        valor_total_fatura=campos_final.get("total_rs"),
                        grupo_tarifario=campos_final.get("grupo_tarifario") or campos_final.get("grupo"),
                        modalidade_tarifaria=campos_final.get("modalidade_tarifaria") or campos_final.get("modalidade"),
                    )
                    if not res_itens.get("erro"):
                        itens = res_itens.get("itens", [])
                        metadados = res_itens.get("metadados", {}) or {}
                        if itens:
                            inseridos = _gravar_itens_cobrados_v45(worker_cur, worker_conn, fid, itens, origem="pdf_pipeline")
                            if metadados:
                                _gravar_metadados_fatura_v45(worker_cur, worker_conn, fid, metadados)
                            log.info(f"  [itens v45] {inseridos} itens (conf={res_itens.get('confianca', 0):.2f})")
                except Exception as _e_itens:
                    log.warning(f"  [itens v45] excecao: {_e_itens}")

            return {"ok": True, "fid": fid, "erro": None}
        except Exception as e:
            log.warning(f"  [worker] excecao na fatura {row.get('id')}: {e}")
            return {"ok": False, "fid": row.get("id"), "erro": str(e)[:100]}
        finally:
            try: worker_cur.close()
            except: pass
            try: worker_conn.close()
            except: pass

    # Ctrl+C: 1ª vez = parada graciosa (termina as faturas em andamento, não inicia novas);
    # 2ª vez = aborta imediato. Sem isto, o KeyboardInterrupt era engolido pelo
    # shutdown(wait=True) e o batch inteiro precisava terminar antes de sair.
    import signal as _signal
    _sigint_anterior = _signal.getsignal(_signal.SIGINT)

    def _on_sigint(signum, frame):
        if _stop_event.is_set():
            log.warning("\n[Ctrl+C] 2x — abortando imediatamente.")
            _signal.signal(_signal.SIGINT, _sigint_anterior)  # próximo Ctrl+C mata de vez
            raise KeyboardInterrupt
        _stop_event.set()
        log.warning("\n[Ctrl+C] parada solicitada — terminando faturas em andamento e cancelando o resto. "
                    "(Ctrl+C de novo p/ abortar já)")

    _signal.signal(_signal.SIGINT, _on_sigint)

    # Loop principal — paralelizado com ThreadPoolExecutor (Otimização #1)
    interrompido = False
    try:
        # cancel_futures=True (Py3.9+) descarta as tarefas que ainda não começaram no shutdown.
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="fat") as executor:
            futures = [executor.submit(_processar_uma_fatura, row, i) for i, row in enumerate(faturas, 1)]
            try:
                for fut in as_completed(futures):
                    try:
                        res = fut.result()
                        with _lock:
                            if res.get("ok"): _contador["ok"] += 1
                            else: _contador["erro"] += 1
                    except Exception as e:
                        log.error(f"[worker] future erro: {e}")
                        with _lock:
                            _contador["erro"] += 1
                    if _stop_event.is_set():
                        interrompido = True
                        for f in futures:
                            f.cancel()  # cancela os que ainda não rodaram
                        break
            except KeyboardInterrupt:
                interrompido = True
                _stop_event.set()
                for f in futures:
                    f.cancel()
    finally:
        _signal.signal(_signal.SIGINT, _sigint_anterior)  # restaura handler original

    if interrompido:
        log.warning(f"\nINTERROMPIDO: {_contador['ok']} ok | {_contador['erro']} erros | de {len(faturas)} total")
    else:
        log.info(f"\nConcluído: {_contador['ok']} ok | {_contador['erro']} erros | {len(faturas)} total")
    log.info("=" * 60)


def _revalidar_chunk(alvos, dryrun, wid, total):
    """Processa uma fatia de faturas (id,uid) com conexão própria (thread-safe).
    Backup por worker pra não corromper o jsonl com escrita concorrente."""
    import json as _json
    # Rollout NÃO faz consulta SEFAZ síncrona (rede + retry-sleep 6s/fatura = gargalo).
    # Enriquecimento SEFAZ é batch separado não-bloqueante. ~100× mais rápido sem isso.
    os.environ["SKIP_SEFAZ"] = "1"
    conn = mysql.connector.connect(**DB)
    cur = conn.cursor(dictionary=True)
    _tbl_tag = TBL_FDE.replace("FATURA_DADOS_EXTRAIDOS", "FDE")
    bk = open(f"_backup_revalidar_{_tbl_tag}_w{wid}.jsonl", "a", encoding="utf-8")
    ok = err = 0
    for i, a in enumerate(alvos, 1):
        try:
            conn.ping(reconnect=True, attempts=3, delay=2)
            cur.execute(f"SELECT uid, validador_gate, icms_valor, pis_valor, cofins_valor, valor_total_fatura, "
                        f"texto_plumber, texto_markdown, texto_ocr, texto_bbox "
                        f"FROM {TBL_FDE} WHERE id=%s", (a["id"],))
            r = cur.fetchone()
            if not r:
                continue
            # backup do estado ANTERIOR (gate + tributos + total) p/ rollback/auditoria — crítico em PROD
            bk.write(_json.dumps({"id": a["id"], "uid": r["uid"], "gate_old": r["validador_gate"],
                                  "icms_old": r.get("icms_valor"), "pis_old": r.get("pis_valor"),
                                  "cof_old": r.get("cofins_valor"), "total_old": r.get("valor_total_fatura")},
                                 default=str) + "\n"); bk.flush()
            _rodar_pipeline_v3(cur, conn, fid=a["id"], pdf_bytes=None,
                               texto_plumber=r["texto_plumber"], texto_markdown=r.get("texto_markdown"),
                               texto_ocr=r.get("texto_ocr"), uid=r["uid"], force=True,
                               texto_bbox=r.get("texto_bbox"), dryrun=dryrun)
            ok += 1
            if i % 25 == 0:
                conn.commit()
                log.info(f"  [revalidar w{wid}] {i}/{len(alvos)} (ok={ok}) | total~{total}")
        except Exception as e:
            err += 1
            log.warning(f"  [revalidar w{wid}] erro id={a['id']}: {e}")
    conn.commit(); bk.close(); conn.close()
    return (ok, err)


def revalidar_lote(cod_empresas=None, limite=None, dryrun=False, somente_nao_aprovadas=True, workers=1, dist=None, ids=None):
    """--revalidar: re-roda SÓ o estágio v3 (extrator_v2 + aplicar_complementos +
    atualizar_colunas + gate) usando o TEXTO JÁ SALVO no banco (texto_plumber/markdown/
    ocr/bbox) — SEM baixar PDF. Aplica os fixes do código atual (gate PROPAGAÇÃO#5 +
    parsers novos). Mesma lógica do pipeline, só pula download. Grava na TBL_FDE (COPIA
    default; PROD via env FDE_TABLE). Backup por worker em _backup_revalidar_<TBL>_w*.jsonl.
    --workers paraleliza; --dist 'CEMIG%' filtra 1 distribuidora por vez (rollout dist-a-dist)."""
    conn = mysql.connector.connect(**DB)
    cur = conn.cursor(dictionary=True)
    where = ["LENGTH(COALESCE(texto_plumber,''))>=100"]
    if ids:
        where.append("id IN (%s)" % ",".join(str(int(x)) for x in ids))
    if cod_empresas:
        where.append("cod_empresa IN (%s)" % ",".join(str(int(e)) for e in cod_empresas))
    if dist:
        where.append("distribuidora LIKE '" + str(dist).replace("'", "''") + "'")
    if somente_nao_aprovadas:
        where.append("(validador_gate IS NULL OR validador_gate <> 'aprovado')")
    sql = f"SELECT id, uid FROM {TBL_FDE} WHERE " + " AND ".join(where)
    if limite:
        sql += f" LIMIT {int(limite)}"
    cur.execute(sql)
    alvos = cur.fetchall()
    n = len(alvos)
    workers = max(1, int(workers))
    log.info(f"[revalidar] {n} faturas (texto em cache, SEM download) | TBL={TBL_FDE} | dist={dist or 'todas'} | workers={workers} | dryrun={dryrun}")
    if workers == 1:
        ok, err = _revalidar_chunk(alvos, dryrun, 0, n)
    else:
        # ProcessPoolExecutor (NÃO Thread): extrator_v2 é CPU-bound (~15s de regex);
        # threads serializam no GIL → "8 workers" não acelerava. Processos = paralelismo
        # real. _revalidar_chunk abre conexão própria e busca o texto por id (alvos só
        # tem id/uid → leve de picklar pros processos filhos).
        from concurrent.futures import ProcessPoolExecutor
        chunks = [alvos[w::workers] for w in range(workers)]  # round-robin
        ok = err = 0
        with ProcessPoolExecutor(max_workers=workers) as ex:
            futs = [ex.submit(_revalidar_chunk, ch, dryrun, w, n) for w, ch in enumerate(chunks)]
            for fu in futs:
                o, e = fu.result(); ok += o; err += e
    # placar final: escopo pelo MESMO filtro do run (empresa + dist) p/ evitar full-scan de 85k
    # (que dava ReadTimeout quando rodava com --dist e WHERE vazio). Reconecta (conn ficou idle
    # durante o ProcessPool) e NUNCA deixa o resumo derrubar o run — os dados já foram gravados.
    _w = []
    if cod_empresas:
        _w.append("cod_empresa IN (%s)" % ",".join(str(int(e)) for e in cod_empresas))
    if dist:
        _w.append("distribuidora LIKE '" + str(dist).replace("'", "''") + "'")
    emp = (" WHERE " + " AND ".join(_w)) if _w else ""
    # IMPORTANTE: usa uma conexão NOVA p/ o placar. A conn do processo pai abriu no início
    # do run e, sob REPEATABLE READ, mantém um snapshot CONGELADO que NÃO enxerga os commits
    # dos workers (processos filhos) → o placar saía com os números ANTIGOS (susto, mas dados
    # gravados ok). Conexão nova = snapshot fresco. Nunca derruba o resumo.
    try:
        conn.close()
    except Exception:
        pass
    try:
        _c2 = mysql.connector.connect(**DB)
        _cur2 = _c2.cursor(dictionary=True)
        _cur2.execute(f"SELECT validador_gate g, COUNT(*) n FROM {TBL_FDE}{emp} GROUP BY validador_gate")
        placar = {x["g"]: x["n"] for x in _cur2.fetchall()}
        log.info(f"[revalidar] FIM: ok={ok} erro={err} | placar{emp or ' (geral)'}: {placar}")
        _c2.close()
    except Exception as e:
        log.info(f"[revalidar] FIM: ok={ok} erro={err} | placar indisponível ({str(e)[:80]}) — dados GRAVADOS ok")


# ─── Entry point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Pipeline PDF unificado (plumber + markdown + OCR)")
    p.add_argument("--empresa",  type=int, nargs="+", default=None,
                   help="Cod_Empresa(s) a processar (ex: 14  ou  4 14 32)")
    p.add_argument("--id",       type=int, nargs="+", default=None,
                   help="ID(s) específico(s) de fatura (ex: 167770  ou  167770 328211)")
    p.add_argument("--limite",   type=int, default=None,
                   help="Máximo de faturas")
    p.add_argument("--force",    action="store_true",
                   help="Reprocessa mesmo com dados existentes")
    p.add_argument("--dryrun",   action="store_true",
                   help="Mostra resultados sem gravar")
    p.add_argument("--extrator", default="all",
                   choices=["all", "plumber", "markdown", "ocr"],
                   help="Qual extrator rodar (padrão: all)")
    p.add_argument("--ordem",    default="DESC",
                   choices=["ASC", "DESC"],
                   help="Ordem de processamento por id: DESC=mais novo primeiro (padrão), ASC=mais antigo primeiro")
    p.add_argument("--ASC",     action="store_true",
                   help="Atalho para --ordem ASC (processa mais antigos primeiro)")
    p.add_argument("--no-gpu",   action="store_true",
                   help="[obsoleto] OCR agora é Tesseract (sempre CPU). Mantido como no-op por compatibilidade.")
    p.add_argument("--com-itens", action="store_true",
                   help="Extrai itens cobrados via vision (camada 4.5 — nano 2x + 5.4 fallback). "
                        "Custo: ~$0.005-0.010/fatura. Grava na coluna itens_cobrados JSON.")
    p.add_argument("--skip-processadas", action="store_true",
                   help="Pula faturas que já têm validador_gate preenchido no banco. "
                        "Útil pra retomar quando o processo cai no meio.")
    p.add_argument("--retentar-links-invalidos", dest="retentar_links_invalidos", action="store_true",
                   help="Tenta de novo as faturas cujo link já deu 404/arquivo-não-PDF (ignora FT_FATURA_LINK_INVALIDO).")
    p.add_argument("--workers", type=int, default=1,
                   help="Número de threads paralelas (default 1=sequencial). "
                        "Recomendado: 8 CPU / 4 com GPU. Cada worker tem sua própria conexão MySQL.")
    p.add_argument("--id-file", dest="id_file", default=None,
                   help="Arquivo com ids da ORIGEM (frc.id), 1 por linha — evita estourar "
                        "a linha de comando em lotes grandes. Combina com/substitui --id.")
    p.add_argument("--revalidar", action="store_true",
                   help="Re-roda SÓ o estágio v3 (extrator+complementos+gate) usando o TEXTO "
                        "JÁ SALVO no banco — SEM baixar PDF. Aplica os fixes do código atual em "
                        "faturas já extraídas. Escopo por --empresa (senão todas). Por padrão só "
                        "as não-aprovadas; combine com --force pra revalidar TODAS.")
    p.add_argument("--dist", type=str, default=None,
                   help="Filtra revalidar por distribuidora (LIKE), p/ rollout dist-a-dist. "
                        "Ex: --dist 'CEMIG%%' ou --dist 'Light%%'.")
    p.add_argument("--prod", action="store_true",
                   help="Grava na tabela de PRODUÇÃO (FATURA_DADOS_EXTRAIDOS) em vez da COPIA. "
                        "Equivale a FDE_TABLE=FATURA_DADOS_EXTRAIDOS, mas explícito e à prova de "
                        "env não-propagado (seta env+global ANTES de spawnar os workers).")
    p.add_argument("--vtal", action="store_true",
                   help="Lê as faturas da ORIGEM alternativa VTAL (quivere_vtal @179.127.26.89) "
                        "em vez do sgeeasy. Mesma tabela Faturas_Registradas_Cache. Se --empresa "
                        "não for passado, assume Cod_Empresa=2025. Destino (PROD/COPIA) inalterado.")
    p.add_argument("--no-ocr", dest="no_ocr", action="store_true",
                   help="Desliga TODO OCR Tesseract: estágio [ocr] próprio + fallback markitdown "
                        "(que dispara OCR interno e polui/trava com múltiplos workers). Use em "
                        "lotes 100%% text-layer nativo. NÃO use em faturas escaneadas (perdem texto).")
    p.add_argument("--auto-audit", dest="auto_audit", action="store_true",
                   help="MILESTONE 2: marca auditado=1 AUTOMÁTICO quando o validador aprova com "
                        "score alto (>= --auto-audit-min-score). Reversível via AUDITADOS_AUTO_LOG. "
                        "Sem esta flag, nada é auto-auditado.")
    p.add_argument("--auto-audit-min-score", dest="auto_audit_min_score", type=float, default=95.0,
                   help="Score mínimo (0-100) do validador p/ auto-auditar (default 95 — só validador COMPLETO; "
                        "85 seria só a trava de tributos, confiança menor).")
    p.add_argument("--llm-normaliza", dest="llm_normaliza", action="store_true",
                   help="MILESTONE 3: quando a fatura não chega ao score de auto-audit, chama o 4o-mini "
                        "no TEXTO em cache p/ completar ITENS (soma_itens fechar) e TRIBUTOS vazios, com "
                        "gate Σitens≈total (nunca sobrescreve regex; item que não reconcilia é descartado). "
                        "Re-valida → sobe o score → --auto-audit pega. Custa LLM só nas que precisam.")
    p.add_argument("--llm-normaliza-min-score", dest="llm_normaliza_min_score", type=float, default=95.0,
                   help="Só normaliza faturas com score ABAIXO deste (default 95 = as que não auto-auditariam).")
    p.add_argument("--llm-normaliza-model", dest="llm_normaliza_model", type=str, default=None,
                   help="Modelo p/ a normalização (default gpt-4o-mini; env PDF_PIPELINE_LLM_NORMALIZA_MODEL).")
    args = p.parse_args()

    # --vtal: troca o banco de ORIGEM (de onde baixamos) p/ o VTAL. Destino não muda.
    # Override do global ANTES de qualquer connect. Download usa threads (compartilham o
    # global), então basta reatribuir aqui. Default empresa=2025 se não especificado.
    if getattr(args, "vtal", False):
        globals()["DB_ORIGEM"] = DB_VTAL
        if not args.empresa:
            args.empresa = [2025]
        log.info(f"[--vtal] origem=VTAL (quivere_vtal @179.127.26.89) | empresa(s)={args.empresa}")

    # --prod: aponta PROD de forma explícita e robusta. Seta o env (pros workers do
    # ProcessPoolExecutor, que RE-IMPORTAM o módulo e leem TBL_FDE de os.environ no import)
    # E o global do parent (caminho workers=1 + placar final). Tem que rodar ANTES de
    # qualquer connect/pool. Default continua COPIA (sandbox seguro).
    if getattr(args, "prod", False):
        os.environ["FDE_TABLE"] = "FATURA_DADOS_EXTRAIDOS"
        globals()["TBL_FDE"] = "FATURA_DADOS_EXTRAIDOS"
        log.info("[--prod] gravando em PRODUÇÃO: TBL_FDE=FATURA_DADOS_EXTRAIDOS")

    # --no-ocr: desliga Tesseract (estágio [ocr] + fallback markitdown). Env pros
    # workers do ProcessPool (re-importam o módulo e leem NO_OCR no import) + global
    # do parent. Mesmo padrão à prova de env-não-propagado do --prod.
    if getattr(args, "no_ocr", False):
        os.environ["PDF_PIPELINE_NO_OCR"] = "1"
        globals()["NO_OCR"] = True
        log.info("[--no-ocr] OCR Tesseract DESLIGADO (estágio [ocr] + fallback markitdown)")

    # --auto-audit: env pros workers do ProcessPool (re-importam o módulo e leem no import).
    # Mesmo padrão à prova de env-não-propagado do --prod/--no-ocr.
    if getattr(args, "auto_audit", False):
        os.environ["PDF_PIPELINE_AUTO_AUDIT"] = "1"
        os.environ["PDF_PIPELINE_AUTO_AUDIT_MIN_SCORE"] = str(getattr(args, "auto_audit_min_score", 90.0))
        log.info(f"[--auto-audit] auto-auditando quando gate=aprovado E score>={getattr(args,'auto_audit_min_score',90.0)}")

    # --llm-normaliza: env pros workers do ProcessPool (re-importam o módulo e leem no import;
    # o modelo é lido em RUNTIME dentro de normalizar_via_llm, então vale p/ parent e workers).
    if getattr(args, "llm_normaliza", False):
        os.environ["PDF_PIPELINE_LLM_NORMALIZA"] = "1"
        os.environ["PDF_PIPELINE_LLM_NORMALIZA_MIN_SCORE"] = str(getattr(args, "llm_normaliza_min_score", 95.0))
        if getattr(args, "llm_normaliza_model", None):
            os.environ["PDF_PIPELINE_LLM_NORMALIZA_MODEL"] = args.llm_normaliza_model
        log.info(f"[--llm-normaliza] 4o-mini gap-fill quando score<{getattr(args,'llm_normaliza_min_score',95.0)} "
                 f"(modelo={os.environ.get('PDF_PIPELINE_LLM_NORMALIZA_MODEL','gpt-4o-mini')})")

    # --revalidar: caminho dedicado (não usa origem/download). Reaproveita o texto em cache.
    if args.revalidar:
        # Escopo por LISTA DE IDS (ex.: fila de Inconclusivos gerada pelo cmd/inconclusivos):
        # --id 123 456 ou --id-file inconc.txt. Quando há ids, o gate NÃO filtra (a lista É o escopo).
        _rids = list(args.id) if args.id else []
        if args.id_file:
            try:
                with open(args.id_file, encoding="utf-8") as _f:
                    _rids += [int(x.strip()) for x in _f if x.strip().isdigit()]
            except Exception as _e:
                log.warning(f"[revalidar] falha lendo --id-file {args.id_file}: {_e}")
        revalidar_lote(cod_empresas=args.empresa or None, limite=args.limite,
                       dryrun=args.dryrun,
                       somente_nao_aprovadas=((not args.force) and not _rids),
                       workers=max(1, args.workers), dist=args.dist, ids=(_rids or None))
        sys.exit(0)
    if args.ASC:
        args.ordem = "ASC"
    if args.no_gpu:
        log.info("[--no-gpu] OCR é Tesseract (CPU) — flag ignorada.")

    # --id-file: lê ids da origem de um arquivo (1 por linha) e mescla com --id
    if args.id_file:
        _ids_arq = []
        with open(args.id_file, encoding="utf-8") as _f:
            for _ln in _f:
                _ln = _ln.strip()
                if _ln and _ln.lstrip("-").isdigit():
                    _ids_arq.append(int(_ln))
        args.id = sorted(set((args.id or []) + _ids_arq))
        log.info(f"[--id-file] {len(_ids_arq)} ids lidos de {args.id_file}")

    if not args.empresa and not args.id:
        p.error("Informe --empresa, --id ou --id-file")

    if getattr(args, "retentar_links_invalidos", False):
        os.environ["PDF_PIPELINE_RETENTAR_INVALIDOS"] = "1"
    main(cod_empresas=args.empresa or [], force=args.force, limite=args.limite,
         dryrun=args.dryrun, extrator=args.extrator, ordem=args.ordem, ids=args.id,
         com_itens=args.com_itens, skip_processadas=args.skip_processadas,
         workers=max(1, args.workers))
