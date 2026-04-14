"""
pipeline_full.py
----------------
Pipeline unificado: Extração de texto (PDF → plumber/markdown/OCR)
                    + Análise IA (F01–F05) em sequência por empresa.

Fluxo por fatura:
  1. Download PDF
  2. Extração de texto: pdfplumber → markitdown → OCR (fallback)
  3. Análise IA com visão + texto (OpenAI gpt-4.1-mini / gpt-5.4-mini)
  4. Conferência motor de regras (limiares do motor_regras_f01_f05.sql)
  5. Salva resultado em Faturas_Registradas_Cache + fichas_anomalias_cache

Fila de empresas:
  - Busca todas as empresas com faturas pendentes de análise IA
  - Ordena por quantidade de pendentes (DESC) — mais atrasadas primeiro
  - Processa 400 faturas por empresa, mais recentes primeiro
  - Retomável: DB é o estado; interrupção é sempre segura

Uso:
    python pipeline_full.py --loop              # cicla todas as empresas até zerar
    python pipeline_full.py --empresa 14        # só uma empresa
    python pipeline_full.py --empresa 14 --limite 50
    python pipeline_full.py --empresa 14 --force
    python pipeline_full.py --empresa 14 --dryrun
    python pipeline_full.py --empresa 14 --batch   # OpenAI Batch API (50% mais barato)
"""

import argparse
import base64
import io
import json
import logging
import re
import sys
import tempfile
import time
from pathlib import Path

# ─── Logging ─────────────────────────────────────────────────────────────────

logging.getLogger().handlers.clear()
logging.basicConfig(
    level    = logging.INFO,
    format   = "%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt  = "%Y-%m-%d %H:%M:%S",
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("C:/paddleocr/pipeline_full.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

for _noisy in ("ppocr", "paddle", "paddleocr", "pdfminer", "markitdown"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

# ─── Imports pesados ─────────────────────────────────────────────────────────

import fitz                        # PyMuPDF
import mysql.connector
import pdfplumber
import requests
from markitdown import MarkItDown

try:
    import pypdfium2 as pdfium
    HAS_PDFIUM = True
except ImportError:
    HAS_PDFIUM = False
    log.warning("pypdfium2 não instalado — análise sem imagens. pip install pypdfium2")

_ocr_instance = None

# ─── Configuração ────────────────────────────────────────────────────────────

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

OPENAI_API_KEY    = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL      = "gpt-4.1-mini"   # sobrescrito por --modelo em runtime
OPENAI_MODEL_MINI = "gpt-4.1-mini"   # usado no modo --batch; também sobrescrito
OPENAI_BASE_URL   = "https://api.openai.com"

# Atalhos para --modelo (pode passar o ID completo também)
MODELOS_DISPONIVEIS = {
    "mini":   "gpt-4.1-mini",
    "full":   "gpt-4.1",
    "nano":   "gpt-4.1-nano",
    "o4":     "o4-mini",
    "5.4":    "gpt-4.5",
    "5.4m":   "gpt-4.5-mini",
}
OPENAI_TIMEOUT    = 300

BATCH_POR_EMPRESA = 400    # faturas por empresa por ciclo
MAX_PAGINAS_PDF   = 4
ESCALA_PDF        = 2.0
PAUSA_ENTRE_IA    = 1.5    # segundos entre chamadas individuais

OCR_DET  = "C:/paddleocr/det/en_PP-OCRv3_det_infer"
OCR_REC  = "C:/paddleocr/rec/latin_PP-OCRv3_rec_infer"
OCR_CLS  = "C:/paddleocr/cls/ch_ppocr_mobile_v2.0_cls_infer"
IMG_DIR  = Path("C:/paddleocr/tmp")
IMG_DIR.mkdir(parents=True, exist_ok=True)

PROMPT_PATHS = [
    Path(__file__).parent.parent / "backend" / "data" / "prompt_confirmar.txt",
    Path("data") / "prompt_confirmar.txt",
]

# Limiares do motor_regras_f01_f05.sql
_MR = dict(
    desvio_pico    = 2.0,
    desvio_alto    = 1.0,
    desvio_baixo   = -1.0,
    media_minima   = 50,
    min_historico  = 9,
    tolerancia_f01 = 0.01,
    prev_fixos_f03 = 4,
)

MESES_PT = {
    "JAN":1,"FEV":2,"MAR":3,"ABR":4,"MAI":5,"JUN":6,
    "JUL":7,"AGO":8,"SET":9,"OUT":10,"NOV":11,"DEZ":12,
}

# ─── Banco ───────────────────────────────────────────────────────────────────

def _conectar():
    conn = mysql.connector.connect(**DB)
    cur  = conn.cursor(dictionary=True)
    return cur, conn

def _reconectar(cur, conn):
    try:
        cur.close()
    except Exception:
        pass
    try:
        conn.close()
    except Exception:
        pass
    return _conectar()

def _safe_exec(cur, conn, sql, params=()):
    """Executa SQL com reconexão automática em caso de falha."""
    for tentativa in range(2):
        try:
            cur.execute(sql, params)
            conn.commit()
            return cur, conn
        except Exception as e:
            if tentativa == 0:
                log.warning(f"    → BD caiu, reconectando... ({e})")
                cur, conn = _reconectar(cur, conn)
            else:
                log.error(f"    → Falha persistente no BD: {e}")
    return cur, conn

# ─── PaddleOCR ───────────────────────────────────────────────────────────────

def _get_ocr():
    global _ocr_instance
    if _ocr_instance is None:
        from paddleocr import PaddleOCR
        log.info("Carregando PaddleOCR...")
        _ocr_instance = PaddleOCR(
            use_angle_cls = True,
            lang          = "pt",
            det_model_dir = OCR_DET,
            rec_model_dir = OCR_REC,
            cls_model_dir = OCR_CLS,
            show_log      = False,
        )
        log.info("PaddleOCR pronto.")
    return _ocr_instance

# ─── Prompt ──────────────────────────────────────────────────────────────────

_prompt_cache: str | None = None

def carregar_prompt() -> str:
    global _prompt_cache
    if _prompt_cache:
        return _prompt_cache
    for p in PROMPT_PATHS:
        if p.exists():
            log.info(f"Prompt: {p}")
            _prompt_cache = p.read_text(encoding="utf-8")
            return _prompt_cache
    raise FileNotFoundError(f"prompt_confirmar.txt não encontrado em: {PROMPT_PATHS}")

# ─── Helpers gerais ───────────────────────────────────────────────────────────

def _sanitize(text: str) -> str:
    if not isinstance(text, str):
        return str(text) if text is not None else ""
    return text.encode("utf-8", errors="ignore").decode("utf-8")

def _num(s) -> float | None:
    if not s:
        return None
    s = str(s).replace(".", "").replace(",", ".").strip()
    try:
        return float(s)
    except ValueError:
        return None

def _dt(s) -> str | None:
    from datetime import date
    try:
        d, mo, y = str(s).strip().split("/")
        return date(int(y), int(mo), int(d)).strftime("%Y-%m-%d")
    except Exception:
        return None

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
        kwh_total=None, kwh_fponta=None,
        leit_ant_p=None, leit_atu_p=None,
        leit_ant_fp=None, leit_atu_fp=None,
        constante_p=None, dt_leit_ant=None,
        dt_leit_atu=None, dt_proxima=None,
        dt_emissao=None, vencimento=None,
        total_rs=None, rs_consumo=None,
        cip=None, tarifa_kwh=None,
        preco_unit_c_trib=None,
        icms_base=None, icms_aliq=None, icms_valor=None,
        pis_base=None, pis_aliq=None, pis_valor=None,
        cofins_aliq=None, cofins_valor=None,
        kwh_injet=None, historico=[],
    )

# ─── Parser regex (plumber / OCR) ────────────────────────────────────────────

def parse_regex(linhas: list[str]) -> dict:
    dados = _campos_vazios()
    texto = "\n".join(linhas)
    SEP   = r"[\s_]+"

    totais = [_num(v) for v in re.findall(r"R\$\s*([\d\.]+,\d{2})", texto) if _num(v)]
    if totais:
        dados["total_rs"] = max(totais)

    for pat in [
        r"VENC\w*\s+(\d{2}/\d{2}/\d{4})",
        r"VENC\w*[\s\S]{0,30}?(\d{2}/\d{2}/\d{4})",
        r"PAGAR\s+(?:PREFERENCIALMENTE\s+\S+\s+)?(\d{2}/\d{2}/\d{4})",
    ]:
        m = re.search(pat, texto, re.IGNORECASE)
        if m:
            dados["vencimento"] = m.group(1)
            break

    for pat in [
        r"(?:EMISS[AÃ]O|EMITIDA" + SEP + r"EM)\s*[:\-]?\s*(\d{2}/\d{2}/\d{4})",
        r"DATA" + SEP + r"(?:DE" + SEP + r")?EMISS[AÃ]O\s*[:\-]?\s*(\d{2}/\d{2}/\d{4})",
    ]:
        m = re.search(pat, texto, re.IGNORECASE)
        if m:
            dados["dt_emissao"] = m.group(1)
            break

    for pat in [
        r"(?:CONSUMO" + SEP + r")?(?:KWH|KW\.?H)\s*F" + SEP + r"PONTA\s*[:\-]?\s*([\d\.]+,\d{2})",
        r"(?:ENERGIA" + SEP + r")?(?:ELET[R.]?[RICA]*" + SEP + r")?(?:FORA" + SEP + r"PONTA)\s*[:\-]?\s*([\d\.]+,?\d*)\s*KWH",
    ]:
        m = re.search(pat, texto, re.IGNORECASE)
        if m:
            v = _num(m.group(1))
            if v and v > 0:
                dados["kwh_fponta"] = v
                if not dados["kwh_total"]:
                    dados["kwh_total"] = v
                break

    for pat in [
        r"TARIFA\s*(?:DE\s*)?(?:ENERGIA\s*)?(?:F" + SEP + r"PONTA\s*)?(?:SEM\s*IMPOSTOS|S/IMP)?\s*R\$\s*([\d\.]+,\d+)",
        r"PRECO\s*UNIT[A.]?\s*(?:C[/.]?\s*TRIB)?\s*(?:R\$\s*)?([\d\.]+,\d+)",
    ]:
        m = re.search(pat, texto, re.IGNORECASE)
        if m:
            v = _num(m.group(1))
            if v and 0.001 < v < 5.0:
                dados["tarifa_kwh"] = v
                dados["preco_unit_c_trib"] = v
                break

    m = re.search(r"CIP\s*(?:MUNICIPIO|MUNICIPAL)?\s*[:\-]?\s*R?\$?\s*([\d\.]+,\d{2})", texto, re.IGNORECASE)
    if m:
        dados["cip"] = _num(m.group(1))

    for pat in [
        r"BASE\s*(?:DE\s*)?CALC(?:ULO)?\s*ICMS\s*[:\-]?\s*([\d\.]+,\d{2})",
        r"BC\s*ICMS\s*[:\-]?\s*([\d\.]+,\d{2})",
    ]:
        m = re.search(pat, texto, re.IGNORECASE)
        if m:
            dados["icms_base"] = _num(m.group(1))
            break

    m = re.search(r"ALIQ(?:UOTA)?\s*ICMS\s*[:\-]?\s*([\d,\.]+)\s*%", texto, re.IGNORECASE)
    if m:
        dados["icms_aliq"] = _num(m.group(1))

    m = re.search(r"ICMS\s*[:\-]?\s*R?\$?\s*([\d\.]+,\d{2})", texto, re.IGNORECASE)
    if m:
        dados["icms_valor"] = _num(m.group(1))

    m = re.search(r"PIS\s*[:\-]?\s*R?\$?\s*([\d\.]+,\d{2})", texto, re.IGNORECASE)
    if m:
        dados["pis_valor"] = _num(m.group(1))

    m = re.search(r"COFINS\s*[:\-]?\s*R?\$?\s*([\d\.]+,\d{2})", texto, re.IGNORECASE)
    if m:
        dados["cofins_valor"] = _num(m.group(1))

    # Leituras
    for pat in [
        r"LEITURA\s*ANTERIOR\s*(?:P|PONTA)?\s*[:\-]?\s*([\d\.]+)",
        r"LEIT\s*ANT[E.]?\s*(?:P)?\s*[:\-]?\s*([\d\.]+)",
    ]:
        m = re.search(pat, texto, re.IGNORECASE)
        if m:
            dados["leit_ant_p"] = _num(m.group(1))
            break

    for pat in [
        r"LEITURA\s*ATUAL\s*(?:P|PONTA)?\s*[:\-]?\s*([\d\.]+)",
        r"LEIT\s*ATU[A.]?\s*(?:P)?\s*[:\-]?\s*([\d\.]+)",
    ]:
        m = re.search(pat, texto, re.IGNORECASE)
        if m:
            dados["leit_atu_p"] = _num(m.group(1))
            break

    for pat in [
        r"LEITURA\s*ANTERIOR\s*(?:FP|F\.?PONTA)\s*[:\-]?\s*([\d\.]+)",
        r"LEIT\s*ANT[E.]?\s*(?:FP)\s*[:\-]?\s*([\d\.]+)",
    ]:
        m = re.search(pat, texto, re.IGNORECASE)
        if m:
            dados["leit_ant_fp"] = _num(m.group(1))
            break

    for pat in [
        r"LEITURA\s*ATUAL\s*(?:FP|F\.?PONTA)\s*[:\-]?\s*([\d\.]+)",
        r"LEIT\s*ATU[A.]?\s*(?:FP)\s*[:\-]?\s*([\d\.]+)",
    ]:
        m = re.search(pat, texto, re.IGNORECASE)
        if m:
            dados["leit_atu_fp"] = _num(m.group(1))
            break

    m = re.search(r"CONSTANTE\s*[:\-]?\s*([\d\.]+,?\d*)", texto, re.IGNORECASE)
    if m:
        dados["constante_p"] = _num(m.group(1))

    m = re.search(r"INJET\w*\s*([\d\.]+,\d{2})\s*KWH", texto, re.IGNORECASE)
    if m:
        dados["kwh_injet"] = _num(m.group(1))

    historico = []
    for m in re.finditer(
        r"(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)[/.\s-]?(\d{2,4})"
        r"[\s\S]{0,60}?([\d\.]+,\d{2})\s*KWH",
        texto, re.IGNORECASE
    ):
        mes_str  = m.group(1).upper()
        ano_str  = m.group(2)
        kwh_str  = m.group(3)
        kwh_val  = _num(kwh_str)
        mes_num  = MESES_PT.get(mes_str)
        if mes_num and kwh_val and kwh_val > 0:
            ano = int(ano_str) if len(ano_str) == 4 else 2000 + int(ano_str)
            historico.append({"mes": f"{ano:04d}-{mes_num:02d}", "kwh": kwh_val})
    if historico:
        dados["historico"] = historico

    return dados


def _merge_campos(*fontes) -> dict:
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


# ─── Extratores de texto ─────────────────────────────────────────────────────

def extrair_plumber(pdf_bytes: bytes) -> tuple[str, dict]:
    linhas = []
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                txt = page.extract_text() or ""
                linhas.extend(txt.splitlines())
                # Tabelas
                for table in (page.extract_tables() or []):
                    for row in (table or []):
                        linhas.extend(str(c) for c in (row or []) if c)
    except Exception as e:
        log.warning(f"    [plumber] {e}")
        return "", _campos_vazios()
    if not linhas:
        return "", _campos_vazios()
    texto  = "\n".join(linhas)
    campos = parse_regex(linhas)
    return texto, campos


def extrair_markdown(pdf_bytes: bytes) -> str:
    try:
        md = MarkItDown()
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name
        result = md.convert(tmp_path)
        Path(tmp_path).unlink(missing_ok=True)
        texto = (result.text_content or "").strip()
        if len(texto.encode("utf-8")) > 10 * 1024 * 1024:
            log.warning("    [markdown] > 10MB — descartado")
            return ""
        return texto
    except Exception as e:
        log.warning(f"    [markdown] {e}")
        return ""


def extrair_ocr(pdf_bytes: bytes, fatura_id: int) -> tuple[str, dict]:
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
        log.warning(f"    [ocr] {e}")
        return "", _campos_vazios()
    finally:
        for _f in [tmp, *IMG_DIR.glob(f"{prefix}_p*.png")]:
            for _attempt in range(3):
                try:
                    _f.unlink(missing_ok=True)
                    break
                except PermissionError:
                    time.sleep(0.3)
    if not linhas:
        return "", _campos_vazios()
    texto  = "\n".join(linhas)
    campos = parse_regex(linhas)
    return texto, campos


def pdf_bytes_para_imagens(pdf_bytes: bytes) -> list[dict]:
    if not HAS_PDFIUM or not pdf_bytes:
        return []
    try:
        pdf     = pdfium.PdfDocument(pdf_bytes)
        imagens = []
        for i in range(min(len(pdf), MAX_PAGINAS_PDF)):
            page   = pdf[i]
            bitmap = page.render(scale=ESCALA_PDF)
            pil_img = bitmap.to_pil()
            buf    = io.BytesIO()
            pil_img.save(buf, format="PNG")
            b64    = base64.b64encode(buf.getvalue()).decode()
            imagens.append({"base64": b64, "mime": "image/png", "pagina": i + 1})
        return imagens
    except Exception as e:
        log.warning(f"    [pdf→img] {e}")
        return []


def baixar_pdf(url: str) -> bytes | None:
    try:
        r = requests.get(url.strip(), timeout=30, stream=True)
        r.raise_for_status()
        return r.content
    except Exception as e:
        log.warning(f"    [download] {e}")
        return None


# ─── Gravar campos extraídos no banco ────────────────────────────────────────

def gravar_campos_extraidos(cur, conn, fid: int, campos: dict, row: dict):
    sets, vals = [], []

    def add(col_db, val_ocr, converter=None):
        if val_ocr is None:
            return
        if _vazio(row.get(col_db)):
            v = converter(val_ocr) if converter else val_ocr
            if v is not None:
                sets.append(f"`{col_db}` = %s")
                vals.append(v)

    if campos.get("kwh_total") and _vazio(row.get("KWH_Ponta")) and _vazio(row.get("KWH_FPonta")):
        sets.append("`KWH_FPonta` = %s")
        vals.append(campos["kwh_total"])

    add("Leitura_Anterior_KWH_P",  campos.get("leit_ant_p"))
    add("Leitura_Atual_KWH_P",     campos.get("leit_atu_p"))
    add("Leitura_Anterior_KWH_FP", campos.get("leit_ant_fp"))
    add("Leitura_Atual_KWH_FP",    campos.get("leit_atu_fp"))
    add("Constante_KWH_P",         campos.get("constante_p"))
    add("Constante_KWH_FP",        campos.get("constante_p"))
    add("Dt_Leitura_Anterior",     campos.get("dt_leit_ant"),   converter=_dt)
    add("Dt_Leitura_Atual",        campos.get("dt_leit_atu"),   converter=_dt)
    add("DATA_PROXIMA_LEITURA",    campos.get("dt_proxima"),    converter=_dt)
    add("Dt_Emissao_NF",           campos.get("dt_emissao"),    converter=_dt)
    add("Dt_Venc_NF",              campos.get("vencimento"),    converter=_dt)
    add("RS_Total_Fatura",         campos.get("total_rs"))
    add("RS_KWH_FPonta",           campos.get("rs_consumo"))
    add("CIP",                     campos.get("cip"))
    add("Tarifa_Cheia_KWH_FPonta_SImpostos", campos.get("tarifa_kwh"))
    add("Base_de_Calculo_ICMS",    campos.get("icms_base"))
    add("Aliquota_ICMS",           campos.get("icms_aliq"))
    add("ICMS_RS",                 campos.get("icms_valor"))
    add("Base_de_Calculo_PIS_COFINS", campos.get("pis_base"))
    add("Aliquota_PIS",            campos.get("pis_aliq"))
    add("PIS_RS",                  campos.get("pis_valor"))
    add("Aliquota_COFINS",         campos.get("cofins_aliq"))
    add("COFINS_RS",               campos.get("cofins_valor"))
    if campos.get("kwh_injet") and _vazio(row.get("KWH_FPonta_Injet")):
        sets.append("`KWH_FPonta_Injet` = %s"); vals.append(campos["kwh_injet"])
        sets.append("`KWH_Total_Injet`  = %s"); vals.append(campos["kwh_injet"])

    if sets:
        cur, conn = _safe_exec(
            cur, conn,
            f"UPDATE Faturas_Registradas_Cache SET {', '.join(sets)} WHERE id = %s",
            vals + [fid]
        )
    return cur, conn


# ─── Histórico banco (para contexto IA) ─────────────────────────────────────

def buscar_historico(cur, uc: str, mes_ref_prefix: str):
    cur.execute("""
        SELECT Mes_Ref,
               COALESCE(KWH_Ponta, 0)     AS kwh_ponta,
               COALESCE(KWH_FPonta, 0)    AS kwh_fp,
               COALESCE(KWH_Reservado, 0) AS kwh_reservado,
               COALESCE(KWH_Total, 0)     AS kwh_total,
               COALESCE(RS_Total_Fatura,0) AS rs_total,
               COALESCE(Tarifa_Cheia_KWH_Ponta_SImpostos, 0)    AS tarifa_ponta,
               COALESCE(Tarifa_Cheia_KWH_FPonta_SImpostos, 0)   AS tarifa_fp,
               COALESCE(Tarifa_Cheia_KWH_Reservado_SImpostos,0) AS tarifa_reservado
        FROM Faturas_Registradas_Cache
        WHERE UC = %s AND KWH_Total > 0
        ORDER BY Mes_Ref DESC LIMIT 48
    """, (uc,))
    all_rows = cur.fetchall()

    historico, post_all = [], []
    for r in all_rows:
        mes = str(r["Mes_Ref"])[:7]
        r["_mes"] = mes
        if mes_ref_prefix and mes > mes_ref_prefix:
            post_all.append(r)
        elif not mes_ref_prefix or mes < mes_ref_prefix:
            if len(historico) < 24:
                historico.append(r)

    post_all.reverse()
    n_post     = 12 if not historico else 3
    posteriores = post_all[:n_post]
    return historico, posteriores


def _fmt_hist(rows) -> str:
    lines = ["{"]
    for r in rows:
        lines.append(
            f'  {{"mes":"{r["_mes"]}",'
            f'"kwh_ponta":{r["kwh_ponta"]:.1f},'
            f'"kwh_fp":{r["kwh_fp"]:.1f},'
            f'"kwh_reservado":{r["kwh_reservado"]:.1f},'
            f'"kwh_total":{r["kwh_total"]:.1f},'
            f'"rs_total":{r["rs_total"]:.2f},'
            f'"tarifa_ponta":{r["tarifa_ponta"]:.6f},'
            f'"tarifa_fp":{r["tarifa_fp"]:.6f},'
            f'"tarifa_reservado":{r["tarifa_reservado"]:.6f}}},'
        )
    lines.append("}")
    return "\n".join(lines)


def _fmt_post(rows) -> str:
    lines = ["{"]
    for r in rows:
        lines.append(
            f'  {{"mes":"{r["_mes"]}",'
            f'"kwh_ponta":{r["kwh_ponta"]:.1f},'
            f'"kwh_fp":{r["kwh_fp"]:.1f},'
            f'"kwh_reservado":{r["kwh_reservado"]:.1f},'
            f'"kwh_total":{r["kwh_total"]:.1f}}},'
        )
    lines.append("}")
    return "\n".join(lines)


# ─── Monta contexto para IA ──────────────────────────────────────────────────

def _campos_banco_dict(fatura: dict) -> dict:
    return {
        "KWH_Ponta":               fatura.get("KWH_Ponta"),
        "KWH_FPonta":              fatura.get("KWH_FPonta"),
        "KWH_Reservado":           fatura.get("KWH_Reservado"),
        "KWH_Total":               fatura.get("KWH_Total"),
        "Leitura_Anterior_KWH_P":  fatura.get("Leitura_Anterior_KWH_P"),
        "Leitura_Atual_KWH_P":     fatura.get("Leitura_Atual_KWH_P"),
        "Leitura_Anterior_KWH_FP": fatura.get("Leitura_Anterior_KWH_FP"),
        "Leitura_Atual_KWH_FP":    fatura.get("Leitura_Atual_KWH_FP"),
        "Constante_KWH_P":         fatura.get("Constante_KWH_P"),
        "Constante_KWH_FP":        fatura.get("Constante_KWH_FP"),
        "Base_de_Calculo_ICMS":    fatura.get("Base_de_Calculo_ICMS"),
        "Aliquota_ICMS":           fatura.get("Aliquota_ICMS"),
        "ICMS_RS":                 fatura.get("ICMS_RS"),
        "CIP":                     fatura.get("CIP"),
        "Vencimento":              str(fatura.get("Dt_Venc_NF") or ""),
    }


def montar_contexto(fatura: dict, historico: list, posteriores: list,
                    direto: bool = False) -> str:
    ctx = []
    mes_ref_str = str(fatura["Mes_Ref"])[:7]

    ctx.append("=== DADOS DA FATURA ===")
    ctx.append(f'UC: {fatura["UC"]}')
    ctx.append(f'Mês de Referência: {fatura["Mes_Ref"]}')
    ctx.append(f'Concessionária: {fatura.get("Concessionaria", "")}')
    ctx.append(f'Tensão: {fatura.get("Tp_Tensao") or "não informado"}')
    ctx.append(f'Medidor: {fatura.get("NroMedidor") or "não informado"}')
    ctx.append(f'Cliente: {fatura.get("RAZAO_SOCIAL") or "não informado"}')
    ctx.append(f'Valor Total Fatura: R$ {float(fatura.get("RS_Total_Fatura") or 0):.2f}')

    if direto:
        # ── ANÁLISE EM DUAS FASES ──────────────────────────────────────────────
        ctx.append("\n" + "=" * 60)
        ctx.append("ANÁLISE EM DUAS FASES — SIGA ESTA ORDEM OBRIGATORIAMENTE")
        ctx.append("=" * 60)
        ctx.append(
            "\nFASE 1 — ANÁLISE EXCLUSIVA DO PDF\n"
            "  • Leia os textos e imagens da fatura abaixo.\n"
            "  • Extraia todos os campos: leituras, constante, kWh, histórico, preços, tributos.\n"
            "  • Aplique F01 a F05 considerando APENAS o que está no PDF/imagens.\n"
            "  • Registre no bloco ---FASE 1--- os valores extraídos e fichas suspeitas.\n"
            "\nFASE 2 — CONFRONTO COM O BANCO DE DADOS\n"
            "  • Compare os valores extraídos na FASE 1 com os dados do banco (seção BANCO abaixo).\n"
            "  • Identifique CONVERGÊNCIAS (PDF = banco) e DIVERGÊNCIAS (PDF ≠ banco).\n"
            "  • Uma divergência pode indicar dado incorreto no banco, erro na fatura ou anomalia real.\n"
            "  • Atualize o diagnóstico se a comparação mudar ou confirmar alguma ficha.\n"
            "  • Registre no bloco ---FASE 2--- as divergências e o impacto no diagnóstico.\n"
            "\nSAÍDA FINAL — use o formato padrão da SAÍDA após os dois blocos acima.\n"
        )
        ctx.append("=" * 60)

        ctx.append("\n>>> FASE 1 — FONTES DO PDF <<<\n")
        plumber = str(fatura.get("texto_plumber") or "").strip()
        if plumber and not plumber.startswith("[ERRO_"):
            ctx.append("=== TEXTO PLUMBER (extração direta do PDF — maior precisão) ===")
            ctx.append(plumber)
            ctx.append("=== FIM DO PLUMBER ===")

        ocr = str(fatura.get("texto_ocr") or "").strip()
        if ocr and not ocr.startswith("[ERRO_"):
            ctx.append("\n=== TEXTO OCR (leitura visual) ===")
            ctx.append(ocr)
            ctx.append("=== FIM DO OCR ===")

        md = str(fatura.get("texto_markitdown") or "").strip()
        if md and not md.startswith("[ERRO_"):
            ctx.append("\n=== TEXTO MARKITDOWN (estrutura da fatura) ===")
            ctx.append(md)
            ctx.append("=== FIM DO MARKITDOWN ===")

        ctx.append("\n>>> FASE 2 — DADOS DO BANCO (comparar com o que extraiu acima) <<<\n")
        preenchidos = {k: v for k, v in _campos_banco_dict(fatura).items()
                       if v not in (None, 0, "", "None")}
        if preenchidos:
            ctx.append("=== BANCO — CAMPOS DESTA FATURA ===")
            ctx.append("⚠️ Valores registrados no sistema — podem divergir do PDF.")
            for k, v in preenchidos.items():
                ctx.append(f"  {k}: {v}")
            ctx.append("=== FIM BANCO CAMPOS ===")
        else:
            ctx.append("=== BANCO — CAMPOS DESTA FATURA: nenhum campo preenchido ===")

        ctx.append(
            "\n=== FORMATO DA RESPOSTA — OBRIGATÓRIO ===\n"
            "Responda nesta ordem:\n"
            "\n---FASE 1 — DIAGNÓSTICO PRELIMINAR (PDF)---\n"
            "Valores extraídos do PDF:\n"
            "  KWH_Ponta: | KWH_FPonta: | KWH_Total:\n"
            "  Leit_Ant_P: | Leit_Atu_P: | Constante_P:\n"
            "  Leit_Ant_FP: | Leit_Atu_FP: | Constante_FP:\n"
            "  Preço_kWh: | CIP: | ICMS%:\n"
            "Fichas suspeitas: [F01/F02/F03/F04/F05 com justificativa breve ou 'nenhuma']\n"
            "Diagnóstico provisório: [1 frase]\n"
            "\n---FASE 2 — CONFRONTO COM BANCO---\n"
            "  [✓ campo: PDF=X, Banco=X — convergência]\n"
            "  [✗ campo: PDF=X, Banco=Y — DIVERGÊNCIA — impacto: ...]\n"
            "Impacto no diagnóstico: [mantido | atualizado | nova ficha detectada]\n"
            "\n[Seguir com o formato padrão da SAÍDA a partir daqui]\n"
        )

    else:
        # ── Modo padrão: textos sem instrução de duas fases ────────────────────
        ctx.append("MODO AUTÔNOMO: aplique F01 a F05 com base nos textos e imagens abaixo.")

        plumber = str(fatura.get("texto_plumber") or "").strip()
        if plumber and not plumber.startswith("[ERRO_"):
            ctx.append("\n=== TEXTO PLUMBER (extração direta do PDF — maior precisão) ===")
            ctx.append(plumber)
            ctx.append("=== FIM DO PLUMBER ===")

        ocr = str(fatura.get("texto_ocr") or "").strip()
        if ocr and not ocr.startswith("[ERRO_"):
            ctx.append("\n=== TEXTO OCR (leitura visual) ===")
            ctx.append(ocr)
            ctx.append("=== FIM DO OCR ===")

        md = str(fatura.get("texto_markitdown") or "").strip()
        if md and not md.startswith("[ERRO_"):
            ctx.append("\n=== TEXTO MARKITDOWN ===")
            ctx.append(md)
            ctx.append("=== FIM DO MARKITDOWN ===")

        preenchidos = {k: v for k, v in _campos_banco_dict(fatura).items()
                       if v not in (None, 0, "", "None")}
        if preenchidos:
            ctx.append("\n=== BANCO — CAMPOS DESTA FATURA (podem divergir do PDF) ===")
            for k, v in preenchidos.items():
                ctx.append(f"  {k}: {v}")
            ctx.append("=== FIM BANCO CAMPOS ===")

    ctx.append(f"\n=== HISTÓRICO_BANCO — UC {fatura['UC']} ===")
    ctx.append(f"Mês da fatura analisada: {mes_ref_str}")
    if historico:
        ctx.append(f"Meses ANTERIORES: {len(historico)}")
        ctx.append("historico_anterior_json=\n" + _fmt_hist(historico))
    else:
        ctx.append("⚠️ Nenhum mês anterior com consumo > 0.")
    if posteriores:
        ctx.append(f"\nMeses POSTERIORES: {len(posteriores)}")
        ctx.append("meses_posteriores_json=\n" + _fmt_post(posteriores))

    return "\n".join(ctx)


# ─── Chamada IA ───────────────────────────────────────────────────────────────

def chamar_ia(system_prompt: str, contexto: str, imagens: list[dict]) -> str:
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type":  "application/json",
    }
    content = [{"type": "text", "text": _sanitize(contexto)}]
    for img in imagens:
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:{img['mime']};base64,{img['base64']}", "detail": "high"},
        })
    body = {
        "model":      OPENAI_MODEL,   # definido em main() via --modelo
        "max_tokens": 4096,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": content},
        ],
    }
    r = requests.post(f"{OPENAI_BASE_URL}/v1/chat/completions",
                      headers=headers, json=body, timeout=OPENAI_TIMEOUT)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


# ─── Motor de regras (conferência pós-IA) ────────────────────────────────────

def _check_motor_regras(fichas_ia: str, historico: list, ficha: dict) -> dict:
    fichas_set = {c.upper() for c in re.findall(r"F0[1-5]", fichas_ia or "", re.IGNORECASE)}
    checks     = []
    override   = None

    if "F02" in fichas_set:
        validos   = [r for r in historico if float(r.get("kwh_total") or 0) > _MR["media_minima"]]
        n_val     = len(validos)
        kwh_atual = float(ficha.get("KWH_Total") or 0)
        if kwh_atual == 0:
            kwh_atual = (float(ficha.get("KWH_Ponta")     or 0) +
                         float(ficha.get("KWH_FPonta")    or 0) +
                         float(ficha.get("KWH_Reservado") or 0))
        if n_val >= _MR["min_historico"] and kwh_atual > 0:
            media   = sum(float(r["kwh_total"]) for r in validos) / n_val
            dif_pct = (kwh_atual - media) / media if media > 0 else 0
            if   dif_pct >= _MR["desvio_pico"]:  status_mr, label = "PASS", "PICO_OUTLIER"
            elif dif_pct >= _MR["desvio_alto"]:  status_mr, label = "PASS", "DESVIO_ALTO"
            elif dif_pct <= _MR["desvio_baixo"]: status_mr, label = "PASS", "MUITO_BAIXO"
            elif dif_pct < _MR["desvio_baixo"] / 2.0:
                status_mr, label = "WARN", "DESVIO_BAIXO (limítrofe)"
                override = override or "INCONCLUSIVO"
            else:
                status_mr, label = "FAIL", "NORMAL"
                override = "INCONCLUSIVO"
            checks.append({
                "ficha": "F02", "status": status_mr,
                "motivo": (f"motor→{label} | dif={dif_pct*100:+.1f}% | "
                           f"media={media:.0f} kWh ({n_val}m) | atual={kwh_atual:.0f} kWh"),
            })
        elif n_val > 0:
            checks.append({"ficha": "F02", "status": "WARN",
                           "motivo": f"Base pequena: {n_val}m (mín {_MR['min_historico']})"})
        else:
            checks.append({"ficha": "F02", "status": "WARN",
                           "motivo": "Sem histórico no banco"})

    if "F01" in fichas_set:
        la_p  = float(ficha.get("Leitura_Anterior_KWH_P")  or 0)
        lc_p  = float(ficha.get("Leitura_Atual_KWH_P")     or 0)
        la_fp = float(ficha.get("Leitura_Anterior_KWH_FP") or 0)
        lc_fp = float(ficha.get("Leitura_Atual_KWH_FP")    or 0)
        kwh_p = float(ficha.get("KWH_Ponta")               or 0)
        kwh_fp= float(ficha.get("KWH_FPonta")              or 0)
        cp    = float(ficha.get("Constante_KWH_P")         or 0) or 1.0
        cfp   = float(ficha.get("Constante_KWH_FP")        or 0) or 1.0
        if la_p == 0 and lc_p == 0 and la_fp == 0 and lc_fp == 0:
            checks.append({"ficha": "F01", "status": "WARN",
                           "motivo": "Leituras ausentes no banco — F01 só validável via PDF"})
        else:
            flag_p = flag_fp = False
            if (la_p > 0 or lc_p > 0) and kwh_p > 0 and kwh_p not in (30, 50, 100):
                calc = (lc_p - la_p) * cp
                if (abs(kwh_p - round(calc,      6)) > _MR["tolerancia_f01"] and
                    abs(kwh_p - round(calc*1.025, 6)) > _MR["tolerancia_f01"]):
                    flag_p = True
            if (la_fp > 0 or lc_fp > 0) and kwh_fp > 0 and kwh_fp not in (30, 50, 100):
                calc = (lc_fp - la_fp) * cfp
                if (abs(kwh_fp - round(calc,      6)) > _MR["tolerancia_f01"] and
                    abs(kwh_fp - round(calc*1.025, 6)) > _MR["tolerancia_f01"]):
                    flag_fp = True
            if flag_p or flag_fp:
                segs = " | ".join(filter(None, ["P" if flag_p else None, "FP" if flag_fp else None]))
                checks.append({"ficha": "F01", "status": "PASS",
                               "motivo": f"Divergência confirmada: posto(s) {segs}"})
            else:
                checks.append({"ficha": "F01", "status": "FAIL",
                               "motivo": f"Motor NÃO detectaria F01 — divergência ≤ {_MR['tolerancia_f01']} kWh"})
                override = "INCONCLUSIVO"

    if "F03" in fichas_set:
        grupo   = "B" if "BT" in (ficha.get("Tp_Tensao") or "").upper() else "A"
        recentes = historico[:5]
        fixos = sum(
            1 for r in recentes
            if (grupo == "B" and float(r.get("kwh_total") or 0) in (30, 50, 100))
            or (grupo == "A" and float(r.get("kwh_total") or 0) == 0)
        )
        if fixos >= _MR["prev_fixos_f03"]:
            checks.append({"ficha": "F03", "status": "PASS",
                           "motivo": f"{fixos} meses fixos no banco — padrão F03"})
        elif fixos > 0:
            checks.append({"ficha": "F03", "status": "WARN",
                           "motivo": f"Apenas {fixos} meses fixos (min {_MR['prev_fixos_f03']})"})
        else:
            checks.append({"ficha": "F03", "status": "WARN",
                           "motivo": "Nenhum mês fixo no banco — F03 baseado na fatura"})

    for fx in ("F04", "F05"):
        if fx in fichas_set:
            checks.append({"ficha": fx, "status": "WARN",
                           "motivo": f"{fx}: requer comparação manual de medidor/leitura"})

    passou = all(c["status"] != "FAIL" for c in checks)
    return {"passou": passou, "checks": checks,
            "override_status": override if not passou else None}


def _logar_check(mr: dict, fid: int):
    status_geral = "✅ OK" if mr["passou"] else "⚠️  DIVERGÊNCIA"
    log.info(f"    [motor_regras] {status_geral} | id={fid}")
    for c in mr["checks"]:
        ico = {"PASS": "✓", "WARN": "~", "FAIL": "✗"}.get(c["status"], "?")
        log.info(f"      {ico} {c['ficha']} [{c['status']}]: {c['motivo']}")
    if mr.get("override_status"):
        log.warning(f"    → ia_status → {mr['override_status']} (motor_regras não confirma)")


# ─── Parser de resposta IA ────────────────────────────────────────────────────

def parsear_resposta(texto: str) -> dict:
    ia_status = "INCONCLUSIVO"
    if re.search(r"Anomalia\s+Confirmada|✓\s*Anomalia", texto, re.IGNORECASE):
        ia_status = "CONFIRMADO"
    elif re.search(r"Anomalia\s+Não\s+Confirmada|Não\s+Confirmada|✗", texto, re.IGNORECASE):
        ia_status = "FALSO_POSITIVO"

    m = re.search(r"Fichas\s+Confirmadas\s*:\s*\d+\s*\(([^)]*)\)", texto, re.IGNORECASE)
    if m:
        codes = re.findall(r"F0[1-5]", m.group(1), re.IGNORECASE)
        ia_fichas = " | ".join(sorted(set(c.upper() for c in codes)))
    else:
        codes = re.findall(r"F0[1-5](?=\s*(?:confirmad|✓|constat|detectad))", texto, re.IGNORECASE)
        ia_fichas = " | ".join(sorted(set(c.upper() for c in codes)))

    valor = None
    for pat in [
        r"Valor\s+Total\s+Ressarcimento\s*[:\-=]\s*R\$\s*([\d.,]+)",
        r"valor_ressarcimento_total\s*[=:]\s*R?\$?\s*([\d.,]+)",
        r"Total\s+estimado\s*[:\-=]\s*R\$\s*([\d.,]+)",
        r"valor_ressarcimento_estimado\s*[=:]\s*R?\$?\s*([\d.,]+)",
        r"Ressarcimento\s+estimado\s*[:\-=]\s*R\$\s*([\d.,]+)",
        r"Valor\s+a\s+ressarcir\s*[:\-=]\s*R\$\s*([\d.,]+)",
        r"ressarcimento\s*[:\-=]\s*R\$\s*([\d.,]+)",
    ]:
        m = re.search(pat, texto, re.IGNORECASE)
        if m:
            try:
                v = float(m.group(1).replace(".", "").replace(",", "."))
                if v > 0:
                    valor = v
            except ValueError:
                pass
            if valor:
                break

    # Anti-falso-positivo F02: consumo abaixo da média sem valor monetário não é cobrança indevida
    if ia_status == "CONFIRMADO" and (valor is None or valor == 0):
        fichas_set = {c.upper() for c in re.findall(r"F0[1-5]", ia_fichas, re.IGNORECASE)}
        if fichas_set == {"F02"} or not fichas_set:
            ia_status = "INCONCLUSIVO"

    return {
        "ia_status":                    ia_status,
        "ia_fichas_confirmadas":        ia_fichas,
        "resultado_ia":                 texto,
        "valor_ressarcimento_estimado": valor,
    }


# ─── Persistência IA ─────────────────────────────────────────────────────────

def _flags_fichas(fichas_str: str) -> dict:
    s = (fichas_str or "").upper()
    return {f"flag_f0{i}": (1 if f"F0{i}" in s else 0) for i in range(1, 6)}


def _gravar_ficha_cache(cur, conn, fatura: dict, dados: dict):
    fid       = fatura["id"]
    fichas_ia = dados.get("ia_fichas_confirmadas") or ""
    flags     = _flags_fichas(fichas_ia)
    qtd       = sum(flags.values())
    valor     = dados.get("valor_ressarcimento_estimado")
    resultado = (dados.get("resultado_ia") or "")[:65000]
    ia_status = dados.get("ia_status") or "INCONCLUSIVO"
    cur, conn = _safe_exec(cur, conn, """
        INSERT INTO fichas_anomalias_cache
            (id, UC, Cod_Empresa, Concessionaria, Mes_Ref, Tp_Tensao, NroMedidor,
             RAZAO_SOCIAL, Link, RS_Total_Fatura,
             flag_f01, flag_f02, flag_f03, flag_f04, flag_f05,
             qtd_regras, fichas_aplicadas, ia_fichas_confirmadas,
             ia_status, resultado_ia, valor_ressarcimento_estimado,
             resultado_salvo_em)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
        ON DUPLICATE KEY UPDATE
            ia_status                    = VALUES(ia_status),
            resultado_ia                 = VALUES(resultado_ia),
            ia_fichas_confirmadas        = VALUES(ia_fichas_confirmadas),
            flag_f01=VALUES(flag_f01), flag_f02=VALUES(flag_f02),
            flag_f03=VALUES(flag_f03), flag_f04=VALUES(flag_f04),
            flag_f05=VALUES(flag_f05), qtd_regras=VALUES(qtd_regras),
            valor_ressarcimento_estimado = VALUES(valor_ressarcimento_estimado),
            resultado_salvo_em           = NOW()
    """, (
        fid, fatura.get("UC"), fatura.get("Cod_Empresa"), fatura.get("Concessionaria"),
        fatura.get("Mes_Ref"), fatura.get("Tp_Tensao"), fatura.get("NroMedidor"),
        fatura.get("RAZAO_SOCIAL"), fatura.get("Link"), fatura.get("RS_Total_Fatura"),
        flags["flag_f01"], flags["flag_f02"], flags["flag_f03"],
        flags["flag_f04"], flags["flag_f05"],
        qtd, fichas_ia, fichas_ia,
        ia_status, resultado, valor,
    ))
    log.info(f"    → fichas_anomalias_cache: {ia_status} | fichas={fichas_ia or '—'} | valor={valor}")
    return cur, conn


def _salvar_analise_fatura(cur, conn, fid: int, resultado_ia: str, ia_status: str):
    anomalia   = 1 if ia_status in ("CONFIRMADO", "INCONCLUSIVO") else 0
    texto_safe = _sanitize(resultado_ia or "")[:65000]
    cur, conn = _safe_exec(cur, conn, """
        UPDATE Faturas_Registradas_Cache
           SET analise_IA          = %s,
               anomalia_encontrada = %s,
               ia_analisado_em     = NOW()
         WHERE id = %s
    """, (texto_safe, anomalia, fid))
    return cur, conn


# ─── Batch API (OpenAI) ───────────────────────────────────────────────────────

def analisar_em_batch(faturas: list, prompt: str, cur, conn, direto: bool = False):
    log.info(f"Preparando Batch API: {len(faturas)} faturas | direto={direto}")
    headers = {"Authorization": f"Bearer {OPENAI_API_KEY}"}

    requests_jsonl = []
    fatura_map: dict = {}
    for fatura in faturas:
        fid = fatura["id"]
        uc  = fatura["UC"]
        mes = str(fatura["Mes_Ref"])[:7]
        historico, posteriores = buscar_historico(cur, uc, mes)
        contexto = montar_contexto(fatura, historico, posteriores, direto=direto)
        fatura["_historico"] = historico
        custom_id = f"fatura-{fid}"
        fatura_map[custom_id] = fatura
        requests_jsonl.append(json.dumps({
            "custom_id": custom_id,
            "method": "POST",
            "url": "/v1/chat/completions",
            "body": {
                "model": OPENAI_MODEL_MINI,
                "max_completion_tokens": 2048,
                "messages": [
                    {"role": "system", "content": _sanitize(prompt)},
                    {"role": "user",   "content": _sanitize(contexto)},
                ],
            },
        }, ensure_ascii=False))

    jsonl_bytes = "\n".join(requests_jsonl).encode("utf-8", errors="ignore")
    log.info(f"JSONL: {len(jsonl_bytes)//1024} KB")

    upload = requests.post(f"{OPENAI_BASE_URL}/v1/files", headers=headers,
                           files={"file": ("batch.jsonl", jsonl_bytes, "application/jsonl"),
                                  "purpose": (None, "batch")}, timeout=120)
    upload.raise_for_status()
    file_id = upload.json()["id"]

    batch = requests.post(f"{OPENAI_BASE_URL}/v1/batches",
                          headers={**headers, "Content-Type": "application/json"},
                          json={"input_file_id": file_id, "endpoint": "/v1/chat/completions",
                                "completion_window": "24h"}, timeout=60)
    batch.raise_for_status()
    batch_id = batch.json()["id"]
    log.info(f"Batch criado: {batch_id}")

    output_file_id = None
    while True:
        st = requests.get(f"{OPENAI_BASE_URL}/v1/batches/{batch_id}",
                          headers=headers, timeout=30)
        st.raise_for_status()
        data   = st.json()
        status = data["status"]
        counts = data.get("request_counts", {})
        log.info(f"  status={status} | {counts.get('completed',0)}/{counts.get('total', len(faturas))}")
        if status == "completed":
            output_file_id = data.get("output_file_id")
            break
        elif status in ("failed", "expired", "cancelled"):
            raise RuntimeError(f"Batch encerrado: {status}")
        time.sleep(30)

    if not output_file_id:
        raise RuntimeError("Batch sem output_file_id")

    out = requests.get(f"{OPENAI_BASE_URL}/v1/files/{output_file_id}/content",
                       headers=headers, timeout=120)
    out.raise_for_status()

    ok = erro = 0
    for line in out.text.strip().split("\n"):
        if not line.strip():
            continue
        try:
            result = json.loads(line)
        except json.JSONDecodeError:
            continue
        custom_id = result.get("custom_id", "")
        fatura    = fatura_map.get(custom_id)
        if not fatura:
            continue
        fid = fatura["id"]
        if result.get("error"):
            log.warning(f"  {custom_id}: {result['error']}")
            erro += 1
            continue
        try:
            content = result["response"]["body"]["choices"][0]["message"]["content"]
        except (KeyError, IndexError) as e:
            log.warning(f"  {custom_id}: resposta malformada — {e}")
            erro += 1
            continue
        dados = parsear_resposta(content)
        if dados["ia_fichas_confirmadas"]:
            hist = fatura.get("_historico") or []
            mr   = _check_motor_regras(dados["ia_fichas_confirmadas"], hist, fatura)
            _logar_check(mr, fid)
            if mr.get("override_status") and dados["ia_status"] == "CONFIRMADO":
                dados["ia_status"] = mr["override_status"]
        cur, conn = _salvar_analise_fatura(cur, conn, fid, content, dados["ia_status"])
        cur, conn = _gravar_ficha_cache(cur, conn, fatura, dados)
        ok += 1

    log.info(f"Batch finalizado: {ok} ok | {erro} erros")
    return cur, conn


# ─── Fila de empresas ─────────────────────────────────────────────────────────

def get_empresas_queue(cur) -> list[int]:
    """
    Retorna lista de Cod_Empresa com faturas ainda não analisadas pela IA,
    ordenada por quantidade de pendentes (DESC).
    """
    cur.execute("""
        SELECT Cod_Empresa,
               COUNT(*) AS total,
               SUM(CASE WHEN analise_IA IS NULL THEN 1 ELSE 0 END) AS pendentes
        FROM Faturas_Registradas_Cache
        WHERE Link IS NOT NULL
          AND TRIM(Link) != ''
          AND Cod_Empresa IS NOT NULL
        GROUP BY Cod_Empresa
        HAVING pendentes > 0
        ORDER BY pendentes DESC
    """)
    rows = cur.fetchall()
    log.info(f"Fila: {len(rows)} empresa(s) com faturas pendentes")
    for r in rows:
        log.info(f"  empresa={r['Cod_Empresa']:>4}  pendentes={r['pendentes']:>5}/{r['total']}")
    return [r["Cod_Empresa"] for r in rows]


# ─── Processamento por empresa ───────────────────────────────────────────────

def processar_empresa(cod_empresa: int, cur, conn, *,
                      limite: int = BATCH_POR_EMPRESA,
                      force: bool = False,
                      dryrun: bool = False,
                      batch_mode: bool = False,
                      direto: bool = False) -> tuple:
    """
    Processa até `limite` faturas de uma empresa.
    Para cada fatura:
      1. Extrai texto (se ausente): plumber → markdown → OCR fallback
      2. Analisa com IA
      3. Salva resultados
    Retorna (cur, conn) possivelmente reconectados.

    --direto: análise em duas fases (FASE 1: só PDF, FASE 2: confronto com banco).
    """
    log.info("─" * 60)
    log.info(f"Empresa {cod_empresa} | limite={limite} | force={force} | batch={batch_mode} | direto={direto}")

    # Busca faturas: sem analise_IA, mais recentes primeiro
    filtro_ia   = "" if force else "AND frc.analise_IA IS NULL"
    filtro_txt  = "" if force else "AND frc.texto_plumber IS NOT NULL"  # só analisa se já tem texto

    # Primeira passada: faturas que já têm texto extraído mas não têm análise IA
    cur.execute(f"""
        SELECT frc.id, frc.UC, frc.Cod_Empresa, frc.Concessionaria, frc.Mes_Ref,
               frc.Tp_Tensao, frc.NroMedidor, frc.RAZAO_SOCIAL, frc.RS_Total_Fatura,
               frc.Link,
               frc.texto_plumber, frc.texto_markitdown, frc.texto_ocr,
               frc.KWH_Ponta, frc.KWH_FPonta, frc.KWH_Reservado, frc.KWH_Total,
               frc.Leitura_Anterior_KWH_P, frc.Leitura_Atual_KWH_P,
               frc.Leitura_Anterior_KWH_FP, frc.Leitura_Atual_KWH_FP,
               frc.Constante_KWH_P, frc.Constante_KWH_FP,
               frc.Base_de_Calculo_ICMS, frc.Aliquota_ICMS, frc.ICMS_RS,
               frc.CIP, frc.Dt_Venc_NF
        FROM Faturas_Registradas_Cache frc
        WHERE frc.Cod_Empresa = %s
          AND frc.Link IS NOT NULL AND TRIM(frc.Link) != ''
          {filtro_ia}
        ORDER BY frc.Mes_Ref DESC
        LIMIT %s
    """, (cod_empresa, limite))
    faturas = cur.fetchall()
    log.info(f"  {len(faturas)} faturas selecionadas")

    if not faturas:
        log.info("  Nada a processar.")
        return cur, conn

    if dryrun:
        log.info(f"  [DRYRUN] Simulando {len(faturas)} faturas — nada gravado.")
        for f in faturas[:5]:
            log.info(f"    id={f['id']} UC={f['UC']} mes={str(f['Mes_Ref'])[:7]}")
        return cur, conn

    prompt = carregar_prompt()

    # ── Modo Batch API ──────────────────────────────────────────────────────────
    if batch_mode:
        # Extração obrigatória dos 3 métodos para todas as faturas antes do batch
        log.info(f"  Extraindo textos de {len(faturas)} faturas (plumber + OCR + markitdown)...")
        for f in faturas:
            fid  = f["id"]
            link = str(f.get("Link") or "").strip()
            if not link:
                continue
            pdf_bytes = baixar_pdf(link)
            if not pdf_bytes:
                continue

            # 1. Plumber
            if not (f.get("texto_plumber") or "").strip():
                texto_p, campos_p = extrair_plumber(pdf_bytes)
                if texto_p:
                    cur, conn = _safe_exec(cur, conn,
                        "UPDATE Faturas_Registradas_Cache "
                        "SET texto_plumber=%s, plumber_gerado_em=NOW() WHERE id=%s AND texto_plumber IS NULL",
                        (texto_p, fid))
                    f["texto_plumber"] = texto_p
                    cur, conn = gravar_campos_extraidos(cur, conn, fid, campos_p, f)

            # 2. OCR
            if not (f.get("texto_ocr") or "").strip():
                texto_o, campos_o = extrair_ocr(pdf_bytes, fid)
                if texto_o:
                    cur, conn = _safe_exec(cur, conn,
                        "UPDATE Faturas_Registradas_Cache "
                        "SET texto_ocr=%s, ocr_gerado_em=NOW() WHERE id=%s AND texto_ocr IS NULL",
                        (texto_o, fid))
                    f["texto_ocr"] = texto_o
                    cur, conn = gravar_campos_extraidos(cur, conn, fid, campos_o, f)

            # 3. Markitdown
            if not (f.get("texto_markitdown") or "").strip():
                texto_md = extrair_markdown(pdf_bytes)
                if texto_md:
                    cur, conn = _safe_exec(cur, conn,
                        "UPDATE Faturas_Registradas_Cache "
                        "SET texto_markitdown=%s, markitdown_gerado_em=NOW() WHERE id=%s AND texto_markitdown IS NULL",
                        (texto_md, fid))
                    f["texto_markitdown"] = texto_md

        cur, conn = analisar_em_batch(faturas, prompt, cur, conn, direto=direto)
        return cur, conn

    # ── Modo individual ─────────────────────────────────────────────────────────
    ok = erro = sem_link = 0

    for i, fatura in enumerate(faturas, 1):
        fid  = fatura["id"]
        uc   = fatura["UC"]
        mes  = str(fatura["Mes_Ref"])[:7]
        link = str(fatura.get("Link") or "").strip()
        log.info(f"  [{i}/{len(faturas)}] id={fid} UC={uc} mes={mes}")

        if not link:
            log.warning("    Sem Link — pulando")
            sem_link += 1
            continue

        pdf_bytes = baixar_pdf(link)
        if not pdf_bytes:
            erro += 1
            continue

        # 1. Extrair texto (se ausente)
        texto_p   = (fatura.get("texto_plumber")    or "").strip()
        texto_o   = (fatura.get("texto_ocr")         or "").strip()
        texto_md  = (fatura.get("texto_markitdown")  or "").strip()

        if not texto_p:
            log.info("    [plumber] extraindo...")
            texto_p, campos_p = extrair_plumber(pdf_bytes)
            if texto_p:
                cur, conn = _safe_exec(cur, conn,
                    "UPDATE Faturas_Registradas_Cache "
                    "SET texto_plumber=%s, plumber_gerado_em=NOW() WHERE id=%s AND texto_plumber IS NULL",
                    (texto_p, fid))
                fatura["texto_plumber"] = texto_p
                cur, conn = gravar_campos_extraidos(cur, conn, fid, campos_p, fatura)
                log.info(f"    [plumber] {len(texto_p)} chars")
            else:
                log.warning("    [plumber] vazio — PDF escaneado")

        if not texto_p and not texto_o:
            log.info("    [ocr] extraindo (fallback)...")
            texto_o, campos_o = extrair_ocr(pdf_bytes, fid)
            if texto_o:
                cur, conn = _safe_exec(cur, conn,
                    "UPDATE Faturas_Registradas_Cache "
                    "SET texto_ocr=%s, ocr_gerado_em=NOW() WHERE id=%s AND texto_ocr IS NULL",
                    (texto_o, fid))
                fatura["texto_ocr"] = texto_o
                cur, conn = gravar_campos_extraidos(cur, conn, fid, campos_o, fatura)
                log.info(f"    [ocr] {len(texto_o)} chars")
            else:
                log.warning("    [ocr] vazio — pulando fatura")
                erro += 1
                continue

        if not texto_md:
            log.info("    [markdown] extraindo...")
            texto_md = extrair_markdown(pdf_bytes)
            if texto_md:
                cur, conn = _safe_exec(cur, conn,
                    "UPDATE Faturas_Registradas_Cache "
                    "SET texto_markitdown=%s, markitdown_gerado_em=NOW() WHERE id=%s AND texto_markitdown IS NULL",
                    (texto_md, fid))
                fatura["texto_markitdown"] = texto_md

        # 2. Busca histórico e monta contexto
        historico, posteriores = buscar_historico(cur, uc, mes)
        contexto = montar_contexto(fatura, historico, posteriores, direto=direto)

        # 3. Converte PDF em imagens (visão IA)
        imagens = pdf_bytes_para_imagens(pdf_bytes)
        if not imagens:
            log.warning("    Sem imagens — só texto")

        # 4. Chama IA
        try:
            log.info(f"    [IA] enviando ({len(imagens)} img)...")
            resposta = chamar_ia(prompt, contexto, imagens)
        except Exception as e:
            log.error(f"    [IA] erro: {e}")
            erro += 1
            time.sleep(PAUSA_ENTRE_IA)
            continue

        # 5. Parseia + motor de regras
        dados = parsear_resposta(resposta)
        if dados["ia_fichas_confirmadas"]:
            mr = _check_motor_regras(dados["ia_fichas_confirmadas"], historico, fatura)
            _logar_check(mr, fid)
            if mr.get("override_status") and dados["ia_status"] == "CONFIRMADO":
                dados["ia_status"] = mr["override_status"]
        else:
            mr = {"passou": True, "checks": []}

        print(f"\n{'═'*60}")
        print(f"ID: {fid} | UC: {uc} | Mês: {mes}")
        _val = f"R$ {dados['valor_ressarcimento_estimado']:.2f}" if dados['valor_ressarcimento_estimado'] else '—'
        print(f"IA: {dados['ia_status']} | Fichas: {dados['ia_fichas_confirmadas'] or '—'} | Valor: {_val}")
        if mr["checks"]:
            print(f"[motor_regras] {'✅' if mr['passou'] else '⚠️'}: " +
                  " | ".join(f"{c['ficha']}={c['status']}" for c in mr["checks"]))
        print("═" * 60)

        # 6. Salva
        cur, conn = _salvar_analise_fatura(cur, conn, fid, resposta, dados["ia_status"])
        cur, conn = _gravar_ficha_cache(cur, conn, fatura, dados)

        ok += 1
        time.sleep(PAUSA_ENTRE_IA)

    log.info(f"  Empresa {cod_empresa}: {ok} ok | {erro} erros | {sem_link} sem link")
    return cur, conn


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(
        description="Pipeline unificado: extração PDF + análise IA (F01–F05)"
    )
    p.add_argument("--empresa",  type=int, default=None,
                   help="Processar só esta empresa. Omitir para processar todas.")
    p.add_argument("--loop",     action="store_true",
                   help="Ciclica por todas as empresas até zerar os pendentes.")
    p.add_argument("--limite",   type=int, default=BATCH_POR_EMPRESA,
                   help=f"Faturas por empresa por ciclo (padrão: {BATCH_POR_EMPRESA})")
    p.add_argument("--force",    action="store_true",
                   help="Reprocessa mesmo com dados existentes.")
    p.add_argument("--dryrun",   action="store_true",
                   help="Mostra o que seria feito sem gravar nada.")
    p.add_argument("--batch",    action="store_true",
                   help="Usa OpenAI Batch API (50%% mais barato, sem imagens).")
    p.add_argument("--direto",   action="store_true",
                   help="Análise em duas fases: FASE 1 extrai do PDF, FASE 2 confronta com banco. "
                        "Equivalente ao --direto do analisar_batch.py.")
    p.add_argument("--modelo",   type=str, default=None,
                   metavar="MODELO",
                   help=(
                       "Modelo OpenAI. Atalhos: "
                       + ", ".join(f"{k}={v}" for k, v in MODELOS_DISPONIVEIS.items())
                       + ". Ou qualquer ID direto (ex: gpt-4.5, o3). "
                       "Padrão: gpt-4.1-mini"
                   ))
    args = p.parse_args()

    # Resolve modelo (atalho ou ID direto)
    global OPENAI_MODEL, OPENAI_MODEL_MINI
    if args.modelo:
        modelo_id = MODELOS_DISPONIVEIS.get(args.modelo, args.modelo)
        OPENAI_MODEL      = modelo_id
        OPENAI_MODEL_MINI = modelo_id
        log.info(f"Modelo selecionado: {modelo_id}")

    cur, conn = _conectar()

    if args.empresa:
        # ── Modo empresa única ────────────────────────────────────────────────
        log.info(f"Processando empresa {args.empresa}")
        cur, conn = processar_empresa(
            args.empresa, cur, conn,
            limite     = args.limite,
            force      = args.force,
            dryrun     = args.dryrun,
            batch_mode = args.batch,
            direto     = args.direto,
        )
    else:
        # ── Modo fila: todas as empresas ──────────────────────────────────────
        ciclo = 0
        while True:
            ciclo += 1
            log.info(f"\n{'='*60}")
            log.info(f"CICLO {ciclo}")
            log.info(f"{'='*60}")

            fila = get_empresas_queue(cur)
            if not fila:
                log.info("✅ Nenhuma fatura pendente. Processamento concluído.")
                break

            for cod in fila:
                try:
                    cur, conn = processar_empresa(
                        cod, cur, conn,
                        limite     = args.limite,
                        force      = args.force,
                        dryrun     = args.dryrun,
                        batch_mode = args.batch,
                        direto     = args.direto,
                    )
                except KeyboardInterrupt:
                    log.info("\nInterrompido pelo usuário.")
                    cur.close(); conn.close()
                    return
                except Exception as e:
                    log.error(f"Erro na empresa {cod}: {e}")
                    # Reconecta e continua na próxima empresa
                    try:
                        cur, conn = _reconectar(cur, conn)
                    except Exception:
                        pass

            if not args.loop:
                log.info("Primeiro ciclo concluído. Use --loop para continuar.")
                break

            # Breve pausa entre ciclos para não sobrecarregar a API
            log.info("Aguardando 10s antes do próximo ciclo...")
            time.sleep(10)

    cur.close()
    conn.close()
    log.info("Pipeline finalizado.")


if __name__ == "__main__":
    main()
