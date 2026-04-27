"""
pdf_pipeline.py
---------------
Pipeline unificado: PDF → pdfplumber + markitdown + PaddleOCR → banco

Cada extrator salva sua própria coluna:
  texto_plumber     / plumber_gerado_em
  texto_markitdown    / markitdown_gerado_em
  texto_ocr         / ocr_gerado_em

O merge preenche campos vazios no banco com prioridade: plumber > ocr > banco.

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
"""

import argparse
import io
import logging
import os
import re
import sys
import time
from pathlib import Path

# Carrega variáveis do .env do backend (OPENAI_API_KEY, OPENAI_MODEL, etc.)
_env_path = Path(__file__).resolve().parent.parent / "backend" / ".env"
if _env_path.exists():
    for _line in _env_path.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _, _v = _line.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

# Adiciona DLLs CUDA/cuDNN/cuBLAS ao PATH (Windows) para PaddleOCR encontrar
try:
    import nvidia
    _nvidia_root = Path(nvidia.__file__).parent
    for _sub in ("cudnn", "cublas", "cuda_nvrtc", "cuda_runtime"):
        _bin = _nvidia_root / _sub / "bin"
        if _bin.is_dir():
            os.environ["PATH"] = str(_bin) + os.pathsep + os.environ.get("PATH", "")
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(str(_bin))
except Exception:
    pass

# ─── Logging (antes de imports pesados) ──────────────────────────────────────

logging.getLogger().handlers.clear()
logging.basicConfig(
    level   = logging.INFO,
    format  = "%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt = "%Y-%m-%d %H:%M:%S",
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("C:/paddleocr/pdf_pipeline.log", encoding="utf-8"),
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
from markitdown import MarkItDown

# PaddleOCR é lento para importar — carrega só quando necessário.
# Modo hibrido: PDFs <= OCR_GPU_LIMIT_KB usam GPU (rapida em pequenos),
# PDFs maiores usam CPU (estavel em grandes, evita estouro de VRAM).
_ocr_gpu          = None
_ocr_cpu          = None
_USE_GPU          = os.getenv("OCR_USE_GPU", "1") not in ("0", "false", "False", "")
OCR_GPU_LIMIT_KB  = int(os.getenv("OCR_GPU_LIMIT_KB", "1000"))  # 1 MB

logging.getLogger().setLevel(logging.INFO)

# ─── Conexão ────────────────────────────────────────────────────────────────

DB = dict(
    host               = "db-acesso-ressarcimento.cvicxzrqb58o.us-east-2.rds.amazonaws.com",
    port               = 3306,
    user               = "super_user_ressarcimento",
    password           = "qZ8YbD3GxK9uN4RmV2sAeT7LwBjCp5X0",
    database           = "db_ressarcimento",
    charset            = "utf8mb4",
    connection_timeout = 60,
    use_pure           = True,
    ssl_disabled       = True,
)

# ─── PaddleOCR ───────────────────────────────────────────────────────────────

OCR_DET = "C:/paddleocr/det/en_PP-OCRv3_det_infer"
OCR_REC = "C:/paddleocr/rec/latin_PP-OCRv3_rec_infer"
OCR_CLS = "C:/paddleocr/cls/ch_ppocr_mobile_v2.0_cls_infer"
IMG_DIR  = Path("C:/paddleocr/tmp")
IMG_DIR.mkdir(parents=True, exist_ok=True)

def _carrega_ocr(use_gpu: bool):
    """Carrega instancia PaddleOCR (GPU ou CPU). Cacheia por device."""
    from paddleocr import PaddleOCR
    logging.getLogger().setLevel(logging.INFO)
    log.info(f"Carregando PaddleOCR ({'GPU' if use_gpu else 'CPU'})...")
    inst = PaddleOCR(
        use_angle_cls = True,
        lang          = "pt",
        det_model_dir = OCR_DET,
        rec_model_dir = OCR_REC,
        cls_model_dir = OCR_CLS,
        show_log      = False,
        use_gpu       = use_gpu,
    )
    logging.getLogger().setLevel(logging.INFO)
    log.info(f"PaddleOCR ({'GPU' if use_gpu else 'CPU'}) pronto.")
    return inst


def _get_ocr(pdf_size_bytes: int = 0):
    """
    Retorna instancia PaddleOCR ideal pelo tamanho do PDF:
      - PDFs <= OCR_GPU_LIMIT_KB ou _USE_GPU=False  -> retorna instancia CPU
      - PDFs >  OCR_GPU_LIMIT_KB e _USE_GPU=True    -> retorna instancia GPU
    Espera, e o contrario:
      - Pequenos -> GPU (rapida)
      - Grandes  -> CPU (estavel, sem estouro de VRAM)
    """
    global _ocr_gpu, _ocr_cpu

    if not _USE_GPU:
        # --no-gpu / OCR_USE_GPU=0 desliga totalmente a GPU
        if _ocr_cpu is None:
            _ocr_cpu = _carrega_ocr(use_gpu=False)
        return _ocr_cpu, "CPU"

    # Roteamento: pequenos -> GPU, grandes -> CPU
    pdf_kb = pdf_size_bytes / 1024 if pdf_size_bytes else 0
    if pdf_kb > 0 and pdf_kb > OCR_GPU_LIMIT_KB:
        if _ocr_cpu is None:
            _ocr_cpu = _carrega_ocr(use_gpu=False)
        return _ocr_cpu, "CPU"
    else:
        if _ocr_gpu is None:
            _ocr_gpu = _carrega_ocr(use_gpu=True)
        return _ocr_gpu, "GPU"

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
        kwh_total    = None,
        kwh_fponta   = None,   # KWH Fora Ponta (separado do ponta)
        kwh_ponta    = None,   # KWH Ponta
        leit_ant_p   = None,
        leit_atu_p   = None,
        leit_ant_fp  = None,
        leit_atu_fp  = None,
        constante_p  = None,
        constante_fp = None,   # constante do medidor Fora Ponta (pode diferir)
        dt_leit_ant  = None,
        dt_leit_atu  = None,
        dt_proxima   = None,
        dt_emissao   = None,
        vencimento   = None,
        total_rs     = None,
        rs_consumo   = None,
        rs_ponta     = None,   # RS consumo Ponta (TE + TUSD)
        cip          = None,
        tarifa_kwh   = None,
        tarifa_ponta = None,   # tarifa sem ICMS Ponta TE
        preco_unit_c_trib = None,
        icms_base    = None,
        icms_aliq    = None,
        icms_valor   = None,
        pis_base     = None,
        pis_aliq     = None,
        pis_valor    = None,
        cofins_aliq  = None,
        cofins_valor = None,
        kwh_injet    = None,
        historico    = [],
    )

# ─── Parser por regex (funciona em texto limpo do plumber ou texto OCR) ──────

def parse_regex(linhas: list[str]) -> dict:
    """
    Parser compartilhado — aplica regex sobre o texto.
    Funciona melhor com texto limpo (plumber) mas também roda sobre OCR.
    """
    dados = _campos_vazios()
    texto = "\n".join(linhas)
    SEP   = r"[\s_]+"

    # ── Total a pagar ─────────────────────────────────────────────────────────
    totais = [_num(v) for v in re.findall(r"R\$\s*([\d\.]+,\d{2})", texto) if _num(v)]
    if totais:
        dados["total_rs"] = max(totais)

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
        r"\bPIS\b" + SEP + r"([\d\.]+,\d+)" + SEP + r"([\d,\.]+)" + SEP + r"([\d\.]+,\d{2})",
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
        dados["leit_ant_fp"] = dados["leit_ant_p"]
        dados["leit_atu_fp"] = dados["leit_atu_p"]

    if dados["leit_ant_p"] is None:
        m = re.search(
            r"Energia ativa em kWh\s*\n?\s*Pont[a]?\s+([\d\.]+)\s+([\d\.]+)\s+([\d\.]+)",
            texto, re.IGNORECASE | re.MULTILINE)
        if m:
            dados["leit_ant_p"]  = _num(m.group(1))
            dados["leit_atu_p"]  = _num(m.group(2))
            dados["leit_ant_fp"] = dados["leit_ant_p"]
            dados["leit_atu_fp"] = dados["leit_atu_p"]
            if not dados["kwh_total"]:
                dados["kwh_total"] = _num(m.group(3))

    if dados["leit_ant_p"] is None:
        m = re.search(r"Ponta\s+(\d{4,6})\s+(\d{4,6})\s+(\d{3,5})\b", texto, re.IGNORECASE)
        if m:
            dados["leit_ant_p"]  = float(m.group(1))
            dados["leit_atu_p"]  = float(m.group(2))
            dados["leit_ant_fp"] = dados["leit_ant_p"]
            dados["leit_atu_fp"] = dados["leit_atu_p"]
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
        m = re.search(r"\bPIS\b\s+([\d,]+)%", texto, re.IGNORECASE)
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
    # Usa TUSD como tarifa_kwh (FP) e TE como tarifa_ponta (referência)
    if not dados["tarifa_kwh"]:
        m = re.search(r"(0,\d{4,6})\s*\(TUSD\)", texto, re.IGNORECASE)
        if m:
            dados["tarifa_kwh"] = _num(m.group(1))
    if not dados["tarifa_ponta"]:
        m = re.search(r"(0,\d{4,6})\s*\(TE\)", texto, re.IGNORECASE)
        if m:
            dados["tarifa_ponta"] = _num(m.group(1))

    # rs_consumo: TUSD + TE (últimas colunas VALOR)
    # Pega o valor da coluna VALOR das linhas TUSD e TE (última coluna = VALOR)
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
            r"\bPIS\b" + SEP + r"([\d\.]+,\d+)" + SEP + r"([\d,\.]+)" + SEP + r"([\d\.]+,\d{2})",
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
    """markitdown: converte PDF em Markdown estruturado."""
    import tempfile
    try:
        md = MarkItDown()
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name
        result = md.convert(tmp_path)
        Path(tmp_path).unlink(missing_ok=True)
        texto = (result.text_content or "").strip()
        if len(texto.encode("utf-8")) > 10 * 1024 * 1024:
            log.warning("    Markdown > 10MB — descartado")
            return ""
        return texto
    except Exception as e:
        log.warning(f"    markitdown: {e}")
        return ""


def extrair_ocr(pdf_bytes: bytes, fatura_id: int) -> tuple[str, dict]:
    """PaddleOCR: converte páginas em imagem e extrai texto + campos.
    Roteia automaticamente: PDFs pequenos -> GPU, grandes -> CPU.
    """
    import os
    pdf_kb = len(pdf_bytes) / 1024
    if not _USE_GPU:
        modo_decidido = "CPU (forcado --no-gpu)"
    elif pdf_kb > OCR_GPU_LIMIT_KB:
        modo_decidido = f"CPU (PDF {pdf_kb:.0f}KB > {OCR_GPU_LIMIT_KB}KB)"
    else:
        modo_decidido = f"GPU (PDF {pdf_kb:.0f}KB <= {OCR_GPU_LIMIT_KB}KB)"
    log.info(f"  [ocr] roteando para {modo_decidido}...")
    ocr, modo = _get_ocr(len(pdf_bytes))
    pid    = os.getpid()
    prefix = f"fatura_{fatura_id}_{pid}"
    tmp    = IMG_DIR / f"{prefix}.pdf"
    linhas = []
    try:
        tmp.write_bytes(pdf_bytes)
        doc = fitz.open(str(tmp))
        for i, page in enumerate(doc):
            pix      = page.get_pixmap(matrix=fitz.Matrix(2, 2))
            img_path = str(IMG_DIR / f"{prefix}_p{i}.png")
            pix.save(img_path)
            result   = ocr.ocr(img_path, cls=True)
            if result and result[0]:
                linhas.extend(line[1][0] for line in result[0])
        doc.close()
    except Exception as e:
        log.warning(f"    OCR: {e}")
        return "", _campos_vazios()
    finally:
        # No Windows o PaddleOCR pode manter o handle aberto brevemente
        # — tenta remover; se falhar (WinError 32), ignora silenciosamente
        import time as _time
        for _f in [tmp, *IMG_DIR.glob(f"{prefix}_p*.png")]:
            for _attempt in range(3):
                try:
                    _f.unlink(missing_ok=True)
                    break
                except PermissionError:
                    _time.sleep(0.3)

    if not linhas:
        return "", _campos_vazios()

    texto  = "\n".join(linhas)
    campos = parse_regex(linhas)
    return texto, campos


# ─── Download PDF ─────────────────────────────────────────────────────────────

def baixar_pdf(url: str) -> bytes | None:
    try:
        r = requests.get(url.strip(), timeout=30, stream=True)
        r.raise_for_status()
        return r.content
    except Exception as e:
        log.warning(f"    Download falhou: {e}")
        return None


# ─── Gravar campos no banco ───────────────────────────────────────────────────

def gravar_campos(cur, conn, fid: int, campos: dict, row: dict):
    """Preenche campos vazios no banco com dados extraídos."""
    sets, vals = [], []

    def add(col_db, val_ocr, val_db=None, converter=None):
        if val_ocr is None:
            return
        if val_db is None:
            val_db = row.get(col_db)
        if _vazio(val_db):
            v = converter(val_ocr) if converter else val_ocr
            if v is not None:
                sets.append(f"`{col_db}` = %s")
                vals.append(v)

    # Consumo KWH
    # Se temos ponta e fponta separados, grava cada um no campo correto
    if campos.get("kwh_fponta") and _vazio(row.get("KWH_FPonta")):
        sets.append("`KWH_FPonta` = %s"); vals.append(campos["kwh_fponta"])
    if campos.get("kwh_ponta") and _vazio(row.get("KWH_Ponta")):
        sets.append("`KWH_Ponta` = %s"); vals.append(campos["kwh_ponta"])
    # Fallback: kwh_total → KWH_FPonta quando ambos ainda vazios
    if campos.get("kwh_total") and _vazio(row.get("KWH_Ponta")) and _vazio(row.get("KWH_FPonta")):
        sets.append("`KWH_FPonta` = %s"); vals.append(campos["kwh_total"])

    # Leituras
    add("Leitura_Anterior_KWH_P",  campos.get("leit_ant_p"))
    add("Leitura_Atual_KWH_P",     campos.get("leit_atu_p"))
    add("Leitura_Anterior_KWH_FP", campos.get("leit_ant_fp"))
    add("Leitura_Atual_KWH_FP",    campos.get("leit_atu_fp"))
    add("Constante_KWH_P",         campos.get("constante_p"))
    # Constante FP: usa constante_fp se disponível, senão cai no constante_p
    add("Constante_KWH_FP",        campos.get("constante_fp") or campos.get("constante_p"))

    # Dias / Datas
    add("Qtd_Dias",              campos.get("dias"))
    add("Dt_Leitura_Anterior",   campos.get("dt_leit_ant"), converter=_dt)
    add("Dt_Leitura_Atual",      campos.get("dt_leit_atu"), converter=_dt)
    add("DATA_PROXIMA_LEITURA",  campos.get("dt_proxima"),  converter=_dt)
    add("Dt_Emissao_NF",         campos.get("dt_emissao"),  converter=_dt)
    add("Dt_Venc_NF",            campos.get("vencimento"),  converter=_dt)

    # Financeiro
    add("RS_Total_Fatura",                   campos.get("total_rs"))
    add("RS_KWH_FPonta",                     campos.get("rs_consumo"))
    add("RS_KWH_Ponta",                      campos.get("rs_ponta"))
    add("CIP",                               campos.get("cip"))
    add("Tarifa_Cheia_KWH_FPonta_SImpostos", campos.get("tarifa_kwh"))
    add("Tarifa_Cheia_KWH_Ponta_SImpostos",  campos.get("tarifa_ponta"))

    # Tributos
    add("Base_de_Calculo_ICMS",        campos.get("icms_base"))
    add("Aliquota_ICMS",               campos.get("icms_aliq"))
    add("ICMS_RS",                     campos.get("icms_valor"))
    add("Base_de_Calculo_PIS_COFINS",  campos.get("pis_base"))
    add("Aliquota_PIS",                campos.get("pis_aliq"))
    add("PIS_RS",                      campos.get("pis_valor"))
    add("Aliquota_COFINS",             campos.get("cofins_aliq"))
    add("COFINS_RS",                   campos.get("cofins_valor"))

    # Injeção
    if campos.get("kwh_injet") and _vazio(row.get("KWH_FPonta_Injet")):
        sets.append("`KWH_FPonta_Injet` = %s"); vals.append(campos["kwh_injet"])
        sets.append("`KWH_Total_Injet`  = %s"); vals.append(campos["kwh_injet"])

    if sets:
        # Usa chave de negocio (UID, Mes_Ref, Cod_Empresa) se disponivel,
        # senao cai no id como fallback. Mes_Ref usa <=> (null-safe equal).
        uid_neg = row.get("UID")
        cod_emp = row.get("Cod_Empresa")
        if uid_neg and uid_neg not in ("", "0") and cod_emp is not None:
            cur.execute(
                f"UPDATE Faturas_Registradas_Cache SET {', '.join(sets)} "
                f"WHERE UID = %s AND Mes_Ref <=> %s AND Cod_Empresa = %s",
                vals + [uid_neg, row.get("Mes_Ref"), cod_emp])
        else:
            cur.execute(
                f"UPDATE Faturas_Registradas_Cache SET {', '.join(sets)} WHERE id = %s",
                vals + [fid])
        conn.commit()
        nomes = [s.split("=")[0].strip().replace("`", "") for s in sets]
        log.info(f"    Campos preenchidos ({len(nomes)}): {nomes}")
    else:
        log.info("    Sem campos novos para preencher.")


# ─── Fallback GPT: extrai campos quando os parsers falham ────────────────────

_OPENAI_KEY   = os.getenv("OPENAI_API_KEY", "")
_OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

_GPT_SYSTEM = """Você é um extrator de dados de faturas de energia elétrica brasileiras.
Receberá o texto de uma fatura e deverá retornar SOMENTE um JSON válido com os campos abaixo.
Use null para campos não encontrados. Números devem ser float (ponto decimal). Datas: "DD/MM/YYYY".

{
  "kwh_total": null,
  "kwh_fponta": null,
  "leit_ant_p": null,
  "leit_atu_p": null,
  "constante_p": null,
  "dt_leit_ant": null,
  "dt_leit_atu": null,
  "dt_proxima": null,
  "dt_emissao": null,
  "vencimento": null,
  "total_rs": null,
  "rs_consumo": null,
  "cip": null,
  "tarifa_kwh": null,
  "preco_unit_c_trib": null,
  "icms_base": null,
  "icms_aliq": null,
  "icms_valor": null,
  "pis_base": null,
  "pis_aliq": null,
  "pis_valor": null,
  "cofins_aliq": null,
  "cofins_valor": null,
  "kwh_injet": null,
  "historico": []
}

Para "historico": lista de {"mes": <int 1-12>, "ano": <int>, "kwh": <float>}.
Retorne APENAS o JSON, sem explicações.
"""

def _campos_reconhecidos(campos: dict) -> bool:
    """Retorna True se ao menos 2 campos críticos foram extraídos."""
    criticos = ["kwh_total", "total_rs", "icms_valor", "tarifa_kwh", "rs_consumo"]
    encontrados = sum(1 for c in criticos if campos.get(c) is not None)
    return encontrados >= 2


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
                "max_tokens": 800,
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


# ─── Main ─────────────────────────────────────────────────────────────────────

def main(cod_empresas: list[int], force: bool, limite: int | None,
         dryrun: bool, extrator: str, ordem: str = "DESC",
         ids: list[int] | None = None):

    log.info("=" * 60)
    if ids:
        log.info(f"pdf_pipeline.py  id(s)={ids}  extrator={extrator}  force={force}  dryrun={dryrun}")
    else:
        empresas_str = ", ".join(str(e) for e in cod_empresas)
        log.info(f"pdf_pipeline.py  empresa(s)={empresas_str}  extrator={extrator}"
                 f"  ordem={ordem}  force={force}  limite={limite or 'sem limite'}  dryrun={dryrun}")

    rodar_plumber   = extrator in ("all", "plumber")
    rodar_markdown  = extrator in ("all", "markdown")
    rodar_ocr       = extrator in ("all", "ocr")

    conn = mysql.connector.connect(**DB)
    cur  = conn.cursor(dictionary=True)

    if ids:
        lista_ids = ", ".join(str(i) for i in ids)
        filtros = [f"id IN ({lista_ids})", "Link IS NOT NULL", "TRIM(Link) != ''"]
    else:
        if len(cod_empresas) == 1:
            filtro_empresa = f"Cod_Empresa = {cod_empresas[0]}"
        else:
            lista = ", ".join(str(e) for e in cod_empresas)
            filtro_empresa = f"Cod_Empresa IN ({lista})"
        filtros = [filtro_empresa, "Link IS NOT NULL", "TRIM(Link) != ''"]

    if not force:
        # Filtra apenas faturas que NUNCA tiveram nenhum extrator rodado.
        # Isso evita loop infinito em PDFs escaneados (plumber/markdown sempre
        # retornam vazio, mas o OCR ja rodou — nao precisa repetir).
        sub = []
        if rodar_plumber:  sub.append("texto_plumber IS NULL")
        if rodar_markdown: sub.append("texto_markitdown IS NULL")
        if rodar_ocr:      sub.append("texto_ocr IS NULL")
        if sub:
            filtros.append("(" + " AND ".join(sub) + ")")

    where   = " AND ".join(filtros)
    lim_sql = f"LIMIT {limite}" if (limite and not ids) else ""

    cur.execute(f"""
        SELECT id, UID, Cod_Empresa, UC, Mes_Ref, Link,
               KWH_Ponta, KWH_FPonta, KWH_Total,
               Leitura_Anterior_KWH_P, Leitura_Atual_KWH_P,
               Leitura_Anterior_KWH_FP, Leitura_Atual_KWH_FP,
               Constante_KWH_P, Constante_KWH_FP,
               Qtd_Dias, RS_Total_Fatura,
               Dt_Leitura_Anterior, Dt_Leitura_Atual, DATA_PROXIMA_LEITURA,
               Dt_Emissao_NF, Dt_Venc_NF,
               CIP, Tarifa_Cheia_KWH_FPonta_SImpostos,
               Base_de_Calculo_ICMS, Aliquota_ICMS, ICMS_RS,
               Aliquota_PIS, PIS_RS, Aliquota_COFINS, COFINS_RS,
               KWH_FPonta_Injet, RS_KWH_FPonta,
               Base_de_Calculo_PIS_COFINS,
               texto_plumber, texto_markitdown, texto_ocr
        FROM Faturas_Registradas_Cache
        WHERE {where}
        ORDER BY id {ordem}
        {lim_sql}
    """)
    faturas = cur.fetchall()
    log.info(f"Faturas para processar: {len(faturas)}")

    if not faturas:
        log.info("Nada a processar.")
        cur.close(); conn.close(); return

    ok = erro = 0

    def _garantir_conexao():
        nonlocal conn, cur
        try:
            conn.ping(reconnect=True, attempts=3, delay=2)
        except Exception:
            log.warning("  Reabrindo conexão MySQL...")
            try: cur.close()
            except: pass
            try: conn.close()
            except: pass
            conn = mysql.connector.connect(**DB)
            cur  = conn.cursor(dictionary=True)

    for i, row in enumerate(faturas, 1):
        fid       = row["id"]
        uid_neg   = row.get("UID")
        cod_emp   = row.get("Cod_Empresa")
        uc        = row["UC"]
        mes       = row["Mes_Ref"]
        link      = str(row["Link"]).strip()

        # Chave de negocio: UID + Mes_Ref + Cod_Empresa.
        # Se UID for valido, usamos a chave de negocio nos UPDATEs (defesa
        # contra id local mudar). Se UID for lixo, cai no id como fallback.
        usar_chave = bool(uid_neg) and uid_neg not in ("", "0") and cod_emp is not None

        log.info(f"\n[{i}/{len(faturas)}] id={fid}  UC={uc}  ref={mes}")

        # ── Download PDF ──────────────────────────────────────────────────────
        pdf_bytes = baixar_pdf(link)
        if not pdf_bytes:
            erro += 1
            # Marca como tentado-e-falhou para nao re-processar todo run.
            # Grava string vazia ('') nos campos de texto: o filtro IS NULL
            # nao vai mais pegar essa linha. Mantem flexibilidade pra
            # --force reprocessar se um dia o PDF voltar.
            if usar_chave:
                where_marca  = "UID = %s AND Mes_Ref <=> %s AND Cod_Empresa = %s"
                params_marca = (uid_neg, mes, cod_emp)
            else:
                where_marca  = "id = %s"
                params_marca = (fid,)
            try:
                _garantir_conexao()
                cur.execute(
                    f"UPDATE Faturas_Registradas_Cache "
                    f"SET texto_plumber    = COALESCE(texto_plumber,    ''), "
                    f"    texto_markitdown = COALESCE(texto_markitdown, ''), "
                    f"    texto_ocr        = COALESCE(texto_ocr,        ''), "
                    f"    ocr_gerado_em    = COALESCE(ocr_gerado_em,    NOW()) "
                    f"WHERE {where_marca}",
                    params_marca)
                conn.commit()
                log.info("  [download] falhou — marcada como nao-processavel")
            except Exception as e:
                log.warning(f"  [download] falha ao marcar como nao-processavel: {e}")
            continue
        log.info(f"  PDF: {len(pdf_bytes)/1024:.1f} KB")

        campos_plumber  = _campos_vazios()
        campos_ocr      = _campos_vazios()
        campos_markdown = _campos_vazios()
        texto_plumber   = ""
        texto_markitdown  = ""
        texto_ocr       = ""
        plumber_ok      = False

        # ── 1. pdfplumber ─────────────────────────────────────────────────────
        if rodar_plumber and (force or _vazio(row.get("texto_plumber"))):
            log.info("  [plumber] extraindo...")
            t0 = time.time()
            texto_plumber, campos_plumber = extrair_plumber(pdf_bytes)
            dt = time.time() - t0
            if texto_plumber:
                plumber_ok = True
                log.info(f"  [plumber] {len(texto_plumber)} chars | {dt:.1f}s")
                log.info(
                    f"    kwh={campos_plumber['kwh_total']} | "
                    f"tarifa={campos_plumber['tarifa_kwh']} | "
                    f"rs={campos_plumber['rs_consumo']} | "
                    f"cip={campos_plumber['cip']} | "
                    f"venc={campos_plumber['vencimento']} | "
                    f"icms={campos_plumber['icms_valor']} | "
                    f"hist={len(campos_plumber['historico'])}m"
                )
            else:
                log.warning("  [plumber] retornou vazio — PDF pode ser escaneado")

        # ── 2. markitdown ─────────────────────────────────────────────────────
        if rodar_markdown and (force or _vazio(row.get("texto_markitdown"))):
            log.info("  [markdown] extraindo...")
            t0 = time.time()
            texto_markitdown = extrair_markdown(pdf_bytes)
            dt = time.time() - t0
            if texto_markitdown:
                log.info(f"  [markdown] {len(texto_markitdown)} chars | {dt:.1f}s")
                # Extrai campos do texto markdown (texto limpo, boa qualidade)
                campos_markdown = parse_regex(texto_markitdown.splitlines())
                log.info(
                    f"    kwh={campos_markdown['kwh_total']} | "
                    f"tarifa={campos_markdown['tarifa_kwh']} | "
                    f"venc={campos_markdown['vencimento']} | "
                    f"hist={len(campos_markdown['historico'])}m"
                )
            else:
                log.warning("  [markdown] retornou vazio")

        # ── 3. PaddleOCR (fallback ou explícito) ──────────────────────────────
        precisa_ocr = (
            rodar_ocr and (force or _vazio(row.get("texto_ocr")))
        ) or (
            rodar_plumber and not plumber_ok  # fallback automático
        )
        if precisa_ocr:
            log.info("  [ocr] extraindo...")
            t0 = time.time()
            texto_ocr, campos_ocr = extrair_ocr(pdf_bytes, fid)
            dt = time.time() - t0
            if texto_ocr:
                log.info(f"  [ocr] {len(texto_ocr)} chars | {dt:.1f}s")
            else:
                log.warning("  [ocr] retornou vazio")
                erro += 1
                continue

        if dryrun:
            log.info("  [DRYRUN] Não gravando.")
            ok += 1
            continue

        # ── Grava textos ──────────────────────────────────────────────────────
        _garantir_conexao()  # reconecta se caiu durante OCR/markdown lentos

        # Se UID + Cod_Empresa estiverem validos, usa chave de negocio no WHERE
        # (defesa contra id local trocar). Senao, cai no id.
        # Mes_Ref usa <=> (null-safe equal) porque pode ser NULL.
        if usar_chave:
            chave_where  = "UID = %s AND Mes_Ref <=> %s AND Cod_Empresa = %s"
            chave_params = (uid_neg, mes, cod_emp)
        else:
            chave_where  = "id = %s"
            chave_params = (fid,)

        if texto_plumber:
            cur.execute(
                f"UPDATE Faturas_Registradas_Cache "
                f"SET texto_plumber=%s, plumber_gerado_em=NOW() "
                f"WHERE {chave_where} "
                + ("" if force else "AND texto_plumber IS NULL"),
                (texto_plumber,) + chave_params)
            conn.commit()

        if texto_markitdown:
            cur.execute(
                f"UPDATE Faturas_Registradas_Cache "
                f"SET texto_markitdown=%s, markitdown_gerado_em=NOW() "
                f"WHERE {chave_where} "
                + ("" if force else "AND texto_markitdown IS NULL"),
                (texto_markitdown,) + chave_params)
            conn.commit()

        if texto_ocr:
            cur.execute(
                f"UPDATE Faturas_Registradas_Cache "
                f"SET texto_ocr=%s, ocr_gerado_em=NOW() "
                f"WHERE {chave_where} "
                + ("" if force else "AND texto_ocr IS NULL"),
                (texto_ocr,) + chave_params)
            conn.commit()

        # ── Merge e grava campos: plumber > ocr > markdown ───────────────────
        campos_final = _merge_campos(campos_plumber, campos_ocr, campos_markdown)

        # ── GPT fallback: layout não reconhecido pelos parsers ────────────────
        if not _campos_reconhecidos(campos_final):
            texto_melhor = texto_plumber or texto_markitdown or texto_ocr
            if texto_melhor:
                log.info("  [gpt-fallback] layout não reconhecido — enviando para GPT...")
                t0 = time.time()
                campos_gpt = extrair_via_gpt(texto_melhor)
                dt = time.time() - t0
                if _campos_reconhecidos(campos_gpt):
                    log.info(
                        f"  [gpt-fallback] OK ({dt:.1f}s) | "
                        f"kwh={campos_gpt['kwh_total']} | "
                        f"rs={campos_gpt['total_rs']} | "
                        f"icms={campos_gpt['icms_valor']} | "
                        f"hist={len(campos_gpt['historico'])}m"
                    )
                    campos_final = _merge_campos(campos_final, campos_gpt)
                else:
                    log.warning(f"  [gpt-fallback] GPT também não reconheceu o layout ({dt:.1f}s)")

        gravar_campos(cur, conn, fid, campos_final, row)

        ok += 1
        time.sleep(0.2)

    log.info(f"\nConcluído: {ok} ok | {erro} erros | {len(faturas)} total")
    log.info("=" * 60)
    cur.close()
    conn.close()


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
    p.add_argument("--no-gpu",   action="store_true",
                   help="Forçar OCR em CPU (útil para rodar uma 2ª instância em paralelo com a GPU)")
    args = p.parse_args()
    if args.no_gpu:
        _USE_GPU = False

    if not args.empresa and not args.id:
        p.error("Informe --empresa ou --id")

    main(cod_empresas=args.empresa or [], force=args.force, limite=args.limite,
         dryrun=args.dryrun, extrator=args.extrator, ordem=args.ordem, ids=args.id)
