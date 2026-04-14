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
    python pdf_pipeline.py --empresa 14 --limite 20
    python pdf_pipeline.py --empresa 14 --force
    python pdf_pipeline.py --empresa 14 --dryrun
    python pdf_pipeline.py --empresa 14 --extrator plumber   # só plumber
    python pdf_pipeline.py --empresa 14 --extrator markdown  # só markdown
    python pdf_pipeline.py --empresa 14 --extrator ocr       # só OCR
"""

import argparse
import io
import logging
import re
import sys
import time
from pathlib import Path

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

# PaddleOCR é lento para importar — carrega só quando necessário
_ocr_instance = None

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

def _get_ocr():
    global _ocr_instance
    if _ocr_instance is None:
        from paddleocr import PaddleOCR
        logging.getLogger().setLevel(logging.INFO)
        log.info("Carregando PaddleOCR...")
        _ocr_instance = PaddleOCR(
            use_angle_cls = True,
            lang          = "pt",
            det_model_dir = OCR_DET,
            rec_model_dir = OCR_REC,
            cls_model_dir = OCR_CLS,
            show_log      = False,
        )
        logging.getLogger().setLevel(logging.INFO)
        log.info("PaddleOCR pronto.")
    return _ocr_instance

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
        kwh_fponta   = None,
        leit_ant_p   = None,
        leit_atu_p   = None,
        leit_ant_fp  = None,
        leit_atu_fp  = None,
        constante_p  = None,
        dt_leit_ant  = None,
        dt_leit_atu  = None,
        dt_proxima   = None,
        dt_emissao   = None,
        vencimento   = None,
        total_rs     = None,
        rs_consumo   = None,
        cip          = None,
        tarifa_kwh   = None,
        preco_unit_c_trib = None,   # preço unitário com tributos
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
    """PaddleOCR: converte páginas em imagem e extrai texto + campos."""
    import os
    ocr    = _get_ocr()
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

    # Consumo
    if campos.get("kwh_total") and _vazio(row.get("KWH_Ponta")) and _vazio(row.get("KWH_FPonta")):
        sets.append("`KWH_FPonta` = %s")
        vals.append(campos["kwh_total"])

    # Leituras
    add("Leitura_Anterior_KWH_P",  campos.get("leit_ant_p"))
    add("Leitura_Atual_KWH_P",     campos.get("leit_atu_p"))
    add("Leitura_Anterior_KWH_FP", campos.get("leit_ant_fp"))
    add("Leitura_Atual_KWH_FP",    campos.get("leit_atu_fp"))
    add("Constante_KWH_P",         campos.get("constante_p"))
    add("Constante_KWH_FP",        campos.get("constante_p"))

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
    add("CIP",                               campos.get("cip"))
    add("Tarifa_Cheia_KWH_FPonta_SImpostos", campos.get("tarifa_kwh"))

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
        cur.execute(
            f"UPDATE Faturas_Registradas_Cache SET {', '.join(sets)} WHERE id = %s",
            vals + [fid])
        conn.commit()
        nomes = [s.split("=")[0].strip().replace("`", "") for s in sets]
        log.info(f"    Campos preenchidos ({len(nomes)}): {nomes}")
    else:
        log.info("    Sem campos novos para preencher.")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main(cod_empresa: int, force: bool, limite: int | None,
         dryrun: bool, extrator: str):

    log.info("=" * 60)
    log.info(f"pdf_pipeline.py  empresa={cod_empresa}  extrator={extrator}"
             f"  force={force}  limite={limite or 'sem limite'}  dryrun={dryrun}")

    rodar_plumber   = extrator in ("all", "plumber")
    rodar_markdown  = extrator in ("all", "markdown")
    rodar_ocr       = extrator in ("all", "ocr")

    conn = mysql.connector.connect(**DB)
    cur  = conn.cursor(dictionary=True)

    # Filtra faturas que precisam de ao menos um extrator
    filtros = [f"Cod_Empresa = {cod_empresa}", "Link IS NOT NULL", "TRIM(Link) != ''"]
    if not force:
        sub = []
        if rodar_plumber:  sub.append("texto_plumber IS NULL")
        if rodar_markdown: sub.append("texto_markitdown IS NULL")
        if rodar_ocr:      sub.append("texto_ocr IS NULL")
        if sub:
            filtros.append("(" + " OR ".join(sub) + ")")

    where   = " AND ".join(filtros)
    lim_sql = f"LIMIT {limite}" if limite else ""

    cur.execute(f"""
        SELECT id, UC, Mes_Ref, Link,
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
        ORDER BY id DESC
        {lim_sql}
    """)
    faturas = cur.fetchall()
    log.info(f"Faturas para processar: {len(faturas)}")

    if not faturas:
        log.info("Nada a processar.")
        cur.close(); conn.close(); return

    ok = erro = 0

    for i, row in enumerate(faturas, 1):
        fid  = row["id"]
        uc   = row["UC"]
        mes  = row["Mes_Ref"]
        link = str(row["Link"]).strip()

        log.info(f"\n[{i}/{len(faturas)}] id={fid}  UC={uc}  ref={mes}")

        # ── Download PDF ──────────────────────────────────────────────────────
        pdf_bytes = baixar_pdf(link)
        if not pdf_bytes:
            erro += 1
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
        if texto_plumber:
            cur.execute(
                "UPDATE Faturas_Registradas_Cache "
                "SET texto_plumber=%%s, plumber_gerado_em=NOW() WHERE id=%%s %s"
                % ("" if force else "AND texto_plumber IS NULL"),
                (texto_plumber, fid))
            conn.commit()

        if texto_markitdown:
            cur.execute(
                "UPDATE Faturas_Registradas_Cache "
                "SET texto_markitdown=%%s, markitdown_gerado_em=NOW() WHERE id=%%s %s"
                % ("" if force else "AND texto_markitdown IS NULL"),
                (texto_markitdown, fid))
            conn.commit()

        if texto_ocr:
            cur.execute(
                "UPDATE Faturas_Registradas_Cache "
                "SET texto_ocr=%%s, ocr_gerado_em=NOW() WHERE id=%%s %s"
                % ("" if force else "AND texto_ocr IS NULL"),
                (texto_ocr, fid))
            conn.commit()

        # ── Merge e grava campos: plumber > ocr > markdown ───────────────────
        campos_final = _merge_campos(campos_plumber, campos_ocr, campos_markdown)
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
    p.add_argument("--empresa",  type=int, required=True,
                   help="Cod_Empresa a processar (ex: 14)")
    p.add_argument("--limite",   type=int, default=None,
                   help="Máximo de faturas")
    p.add_argument("--force",    action="store_true",
                   help="Reprocessa mesmo com dados existentes")
    p.add_argument("--dryrun",   action="store_true",
                   help="Mostra resultados sem gravar")
    p.add_argument("--extrator", default="all",
                   choices=["all", "plumber", "markdown", "ocr"],
                   help="Qual extrator rodar (padrão: all)")
    args = p.parse_args()

    main(cod_empresa=args.empresa, force=args.force, limite=args.limite,
         dryrun=args.dryrun, extrator=args.extrator)
