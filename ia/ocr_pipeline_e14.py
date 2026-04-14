"""
ocr_pipeline_e14.py
-------------------
Pipeline: PDF → PaddleOCR → Parser (regex + heurística) → DataFrame → SQL

Empresa 14 = ENERGISA MATO GROSSO
Fluxo:
  1. Busca faturas em Faturas_Registradas_Cache (Cod_Empresa=14, Link IS NOT NULL)
  2. Baixa o PDF via Link
  3. Converte cada página em imagem (PyMuPDF)
  4. PaddleOCR extrai texto
  5. Parser específico da Energisa MT extrai campos estruturados
  6. Salva texto_ocr + campos extraídos no banco

Uso:
    python ocr_pipeline_e14.py                        # processa onde texto_ocr IS NULL
    python ocr_pipeline_e14.py --force                # reprocessa mesmo com ocr
    python ocr_pipeline_e14.py --limite 10            # max N faturas
    python ocr_pipeline_e14.py --dryrun               # mostra dados mas não grava
"""

import argparse
import logging
import re
import sys
import time
from pathlib import Path

# ─── Logging (ANTES de importar paddleocr para não perder basicConfig) ──────

# Garante que o root logger não tenha handlers que bloqueiem basicConfig
root = logging.getLogger()
root.handlers.clear()

logging.basicConfig(
    level   = logging.INFO,
    format  = "%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt = "%Y-%m-%d %H:%M:%S",
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("C:/paddleocr/ocr_pipeline_e14.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# Silencia loggers verbosos do paddle/ppocr
for _noisy in ("ppocr", "paddle", "paddleocr"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

# ─── Imports pesados (após logger configurado) ───────────────────────────────

import fitz          # PyMuPDF
import mysql.connector
import requests
from paddleocr import PaddleOCR

# paddleocr altera o nível do root logger para WARNING — força de volta para INFO
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

# ─── PaddleOCR (modelos em caminho sem caracteres especiais) ─────────────────

OCR_DET = "C:/paddleocr/det/en_PP-OCRv3_det_infer"
OCR_REC = "C:/paddleocr/rec/latin_PP-OCRv3_rec_infer"
OCR_CLS = "C:/paddleocr/cls/ch_ppocr_mobile_v2.0_cls_infer"
IMG_DIR  = Path("C:/paddleocr/tmp")
IMG_DIR.mkdir(parents=True, exist_ok=True)

# Meses em português para parsing do histórico
MESES_PT = {
    "JAN":1,"FEV":2,"MAR":3,"ABR":4,"MAI":5,"JUN":6,
    "JUL":7,"AGO":8,"SET":9,"OUT":10,"NOV":11,"DEZ":12,
}

# ─── Parser Energisa MT ─────────────────────────────────────────────────────

def _num(s: str) -> float | None:
    """Converte string brasileira '1.516,00' em float."""
    if not s:
        return None
    s = s.replace(".", "").replace(",", ".").strip()
    try:
        return float(s)
    except ValueError:
        return None


def _data_br(s: str):
    """Converte 'DD/MM/YYYY' em objeto date, ou None."""
    from datetime import date
    try:
        d, mo, y = s.strip().split("/")
        return date(int(y), int(mo), int(d))
    except Exception:
        return None


def parse_energisa_mt(linhas: list[str]) -> dict:
    """
    Extrai campos estruturados das linhas OCR de uma fatura Energisa MT.

    Campos extraídos:
      Consumo    : kwh_total, kwh_ponta, kwh_fponta
      Leituras   : leit_ant_p, leit_atu_p, leit_ant_fp, leit_atu_fp, constante_p
      Datas      : dt_leit_ant, dt_leit_atu, dt_proxima, dt_emissao, vencimento
      Financeiro : total_rs, rs_consumo, cip
      Tarifas    : tarifa_kwh
      Tributos   : icms_base, icms_aliq, icms_valor, pis_base, pis_aliq, pis_valor,
                   cofins_aliq, cofins_valor
      Injeção    : kwh_injet
      Histórico  : historico (lista {mes, ano, kwh})
    """
    dados = dict(
        # consumo
        kwh_total    = None,
        kwh_ponta    = None,
        kwh_fponta   = None,
        # leituras
        leit_ant_p   = None,
        leit_atu_p   = None,
        leit_ant_fp  = None,
        leit_atu_fp  = None,
        constante_p  = None,
        # datas
        dt_leit_ant  = None,   # Dt_Leitura_Anterior
        dt_leit_atu  = None,   # Dt_Leitura_Atual
        dt_proxima   = None,   # DATA_PROXIMA_LEITURA
        dt_emissao   = None,   # Dt_Emissao_NF
        vencimento   = None,   # Dt_Venc_NF
        # financeiro
        total_rs     = None,
        rs_consumo   = None,   # RS_KWH_FPonta
        cip          = None,
        # tarifa
        tarifa_kwh   = None,   # Tarifa_Cheia_KWH_FPonta_SImpostos
        # tributos
        icms_base    = None,
        icms_aliq    = None,
        icms_valor   = None,
        pis_base     = None,
        pis_aliq     = None,
        pis_valor    = None,
        cofins_aliq  = None,
        cofins_valor = None,
        # injeção
        kwh_injet    = None,   # KWH_FPonta_Injet (soma de todos os meses injetados)
        # histórico
        historico    = [],
    )

    texto = "\n".join(linhas)

    # ── Total a pagar ────────────────────────────────────────────────────────
    # "R$ 249,23" — pega a maior ocorrência (evita pegar valores parciais)
    totais = [_num(v) for v in re.findall(r"R\$\s*([\d\.]+,\d{2})", texto) if _num(v)]
    if totais:
        dados["total_rs"] = max(totais)

    # ── Vencimento ───────────────────────────────────────────────────────────
    # O OCR às vezes coloca "VENCIMENTO" e a data em linhas separadas
    for pat in [
        r"VENC\w*\s+(\d{2}/\d{2}/\d{4})",                                 # mesma linha
        r"VENC\w*[\s\S]{0,30}?(\d{2}/\d{2}/\d{4})",                       # até 30 chars
        r"PAGAR\s+(?:PREFERENCIALMENTE\s+\S+\s+)?(\d{2}/\d{2}/\d{4})",    # boleto
    ]:
        m = re.search(pat, texto, re.IGNORECASE)
        if m:
            dados["vencimento"] = m.group(1)
            break

    # ── Data de emissão ──────────────────────────────────────────────────────
    # "DATA DE EMISSAO:26/05/2023"
    m = re.search(r"DATA DE EMISS[AÃ]O\s*[:\-]?\s*(\d{2}/\d{2}/\d{4})", texto, re.IGNORECASE)
    if m:
        dados["dt_emissao"] = m.group(1)

    # ── Datas de leitura e dias ───────────────────────────────────────────────
    # Cabeçalho: "24/04/2023  24/05/2023  30  23/06/2023"
    m = re.search(
        r"\b(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{1,3})\s+(\d{2}/\d{2}/\d{4})\b",
        texto)
    if m:
        dados["dt_leit_ant"] = m.group(1)
        dados["dt_leit_atu"] = m.group(2)
        dados["dias"]        = int(m.group(3))
        dados["dt_proxima"]  = m.group(4)
    else:
        # fallback: cabeçalho sem data próxima
        m = re.search(r"\b(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{1,3})\b", texto)
        if m:
            dados["dt_leit_ant"] = m.group(1)
            dados["dt_leit_atu"] = m.group(2)
            dados["dias"]        = int(m.group(3))

    # "Leitura Anterior: 24/04/2023"  /  "Leitura Atual: 24/05/2023"
    if not dados["dt_leit_ant"]:
        m = re.search(r"Leitura Anterior\s*[:\-]?\s*(\d{2}/\d{2}/\d{4})", texto, re.IGNORECASE)
        if m:
            dados["dt_leit_ant"] = m.group(1)
    if not dados["dt_leit_atu"]:
        m = re.search(r"Leitura Atual\s*[:\-]?\s*(\d{2}/\d{2}/\d{4})", texto, re.IGNORECASE)
        if m:
            dados["dt_leit_atu"] = m.group(1)

    # ── Consumo kWh faturado ─────────────────────────────────────────────────
    # Linha típica: "Consumo em kWh  KWH  4.018,00  1,132600  4.550,82  ...  0,882910"
    # O OCR pode quebrar em múltiplas linhas — usa DOTALL com limite de 200 chars
    m = re.search(
        r"Consumo em kWh[\s\S]{0,30}?KWH\s+([\d\.]+,\d+)[\s\S]{0,80}?([\d\.]+,\d{2})[\s\S]{0,60}?(0,\d{5,6})\b",
        texto, re.IGNORECASE)
    if m:
        dados["kwh_total"]  = _num(m.group(1))
        dados["rs_consumo"] = _num(m.group(2))
        dados["tarifa_kwh"] = _num(m.group(3))
    else:
        # sem tarifa — pega só kwh e rs
        m = re.search(
            r"Consumo em kWh[\s\S]{0,30}?KWH\s+([\d\.]+,\d+)[\s\S]{0,80}?([\d\.]+,\d{2})",
            texto, re.IGNORECASE)
        if m:
            dados["kwh_total"]  = _num(m.group(1))
            dados["rs_consumo"] = _num(m.group(2))

    # ── Tarifa unitária (fallback) ────────────────────────────────────────────
    if not dados["tarifa_kwh"]:
        m = re.search(r"Tarifa\s+Unit(?:ária)?\s*\(?R\$\)?\s*(0,\d{5,6})", texto, re.IGNORECASE)
        if m:
            dados["tarifa_kwh"] = _num(m.group(1))
    # último fallback: primeira ocorrência de "0,XXXXXX" após "Consumo"
    if not dados["tarifa_kwh"]:
        idx = texto.lower().find("consumo em kwh")
        if idx >= 0:
            m = re.search(r"\b(0,\d{5,6})\b", texto[idx:idx+300])
            if m:
                dados["tarifa_kwh"] = _num(m.group(1))

    # ── CIP (Contribuição de Iluminação Pública) ──────────────────────────────
    # "Contrib de Ilum Pub  135,96"  (OCR pode escrever "llum" em vez de "Ilum")
    m = re.search(
        r"Contrib\w*\s+de\s+[Il]lum\w*\s+Pub\w*\s+([\d\.]+,\d{2})",
        texto, re.IGNORECASE)
    if not m:
        m = re.search(r"\bCIP\b[\s:=]+([\d\.]+,\d{2})", texto, re.IGNORECASE)
    if m:
        dados["cip"] = _num(m.group(1))

    # ── ICMS / PIS / COFINS ───────────────────────────────────────────────────
    # OCR pode usar "_" como separador em vez de espaço: "94,03_1,0845  1,01"
    SEP = r"[\s_]+"

    # "ICMS  113,26  17,00  19,24"  →  base  aliq  valor
    m = re.search(
        r"\bICMS\b" + SEP + r"([\d\.]+,\d+)" + SEP + r"([\d,\.]+)" + SEP + r"([\d\.]+,\d{2})",
        texto, re.IGNORECASE)
    if m:
        dados["icms_base"]  = _num(m.group(1))
        dados["icms_aliq"]  = _num(m.group(2))
        dados["icms_valor"] = _num(m.group(3))

    # "PIS  94,03  1,0845  1,01"  →  base  aliq  valor
    m = re.search(
        r"\bPIS\b" + SEP + r"([\d\.]+,\d+)" + SEP + r"([\d,\.]+)" + SEP + r"([\d\.]+,\d{2})",
        texto, re.IGNORECASE)
    if m:
        dados["pis_base"]  = _num(m.group(1))
        dados["pis_aliq"]  = _num(m.group(2))
        dados["pis_valor"] = _num(m.group(3))

    # "COFINS  94,03  4,9955  4,71"  →  base  aliq  valor
    m = re.search(
        r"\bCOFINS\b" + SEP + r"([\d\.]+,\d+)" + SEP + r"([\d,\.]+)" + SEP + r"([\d\.]+,\d{2})",
        texto, re.IGNORECASE)
    if m:
        dados["cofins_aliq"]  = _num(m.group(2))
        dados["cofins_valor"] = _num(m.group(3))

    # ── Leituras do medidor ──────────────────────────────────────────────────
    # Tabela do medidor (verso): "Energia ativa em kWh  Ponta  6508  6606  40  4018"
    #   → ant  atu  constante  consumo
    m = re.search(
        r"Energia ativa em kWh\s*\n?\s*Pont[a]?\s+([\d\.]+)\s+([\d\.]+)\s+(\d+)\s+([\d\.]+)",
        texto, re.IGNORECASE | re.MULTILINE)
    if m:
        dados["leit_ant_p"]  = _num(m.group(1))
        dados["leit_atu_p"]  = _num(m.group(2))
        dados["constante_p"] = _num(m.group(3))
        if not dados["kwh_total"]:
            dados["kwh_total"] = _num(m.group(4))
        dados["leit_ant_fp"] = dados["leit_ant_p"]  # BT: FP = P
        dados["leit_atu_fp"] = dados["leit_atu_p"]

    # fallback sem constante — 3 grupos: ant  atu  consumo
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

    # fallback: "Ponta  6508  6606  1516"  (4-6 dígitos)
    if dados["leit_ant_p"] is None:
        m = re.search(r"Ponta\s+(\d{4,6})\s+(\d{4,6})\s+(\d{3,5})\b", texto, re.IGNORECASE)
        if m:
            dados["leit_ant_p"] = float(m.group(1))
            dados["leit_atu_p"] = float(m.group(2))
            dados["leit_ant_fp"] = dados["leit_ant_p"]
            dados["leit_atu_fp"] = dados["leit_atu_p"]
            if not dados["kwh_total"]:
                dados["kwh_total"] = float(m.group(3))

    # ── Energia injetada (soma dos itens de crédito) ──────────────────────────
    # "Energia Atv Injetada mUC 5/2022 mPT  KWH  263,00"
    injet_total = sum(
        _num(v) or 0
        for v in re.findall(
            r"Energia Atv Injetada.*?KWH\s+([\d\.]+,\d+)", texto, re.IGNORECASE)
    )
    if injet_total > 0:
        dados["kwh_injet"] = injet_total

    # ── Histórico (últimos 13 meses) ─────────────────────────────────────────
    hist = []
    for m in re.finditer(
        r"\b([A-Z]{3})/(\d{2})\s+([\d\.]+,\d+|[\d]{3,})\b",
        texto, re.IGNORECASE
    ):
        mes_str = m.group(1).upper()
        ano_2d  = int(m.group(2))
        kwh_str = m.group(3)
        if mes_str not in MESES_PT:
            continue
        ano = 2000 + ano_2d
        kwh = _num(kwh_str)
        if kwh and kwh > 0:
            hist.append({"mes": MESES_PT[mes_str], "ano": ano, "kwh": kwh})

    seen = {}
    for h in hist:
        k = (h["mes"], h["ano"])
        if k not in seen or h["kwh"] > seen[k]["kwh"]:
            seen[k] = h
    dados["historico"] = sorted(seen.values(), key=lambda x: (x["ano"], x["mes"]))

    return dados


# ─── OCR de PDF ────────────────────────────────────────────────────────────

def ocr_pdf(pdf_bytes: bytes, ocr: PaddleOCR, fatura_id: int) -> str | None:
    """Converte PDF em imagens e aplica OCR. Retorna texto concatenado."""
    import os
    pid      = os.getpid()
    prefix   = f"fatura_{fatura_id}_{pid}"
    tmp_path = IMG_DIR / f"{prefix}.pdf"
    try:
        tmp_path.write_bytes(pdf_bytes)
        doc = fitz.open(str(tmp_path))
        all_lines = []
        for i, page in enumerate(doc):
            mat = fitz.Matrix(2, 2)
            pix = page.get_pixmap(matrix=mat)
            img_path = str(IMG_DIR / f"{prefix}_p{i}.png")
            pix.save(img_path)
            result = ocr.ocr(img_path, cls=True)
            if result and result[0]:
                all_lines.extend(line[1][0] for line in result[0])
        doc.close()
        return "\n".join(all_lines) if all_lines else None
    except Exception as e:
        log.warning(f"    Erro OCR: {e}")
        return None
    finally:
        tmp_path.unlink(missing_ok=True)
        for p in IMG_DIR.glob(f"{prefix}_p*.png"):
            p.unlink(missing_ok=True)


# ─── Main ────────────────────────────────────────────────────────────────────

def main(force: bool, limite: int | None, dryrun: bool):
    log.info("=" * 60)
    log.info("Iniciando ocr_pipeline_e14.py — Energisa MT (empresa 14)")

    # ── Inicializa OCR ───────────────────────────────────────────────────────
    log.info("Carregando PaddleOCR...")
    ocr = PaddleOCR(
        use_angle_cls = True,
        lang          = "pt",
        det_model_dir = OCR_DET,
        rec_model_dir = OCR_REC,
        cls_model_dir = OCR_CLS,
        show_log      = False,
    )
    log.info("PaddleOCR pronto.")

    # ── Conexão BD ───────────────────────────────────────────────────────────
    conn = mysql.connector.connect(**DB)
    cur  = conn.cursor(dictionary=True)

    # ── Monta query ──────────────────────────────────────────────────────────
    filtros = [
        "Cod_Empresa = 14",
        "Link IS NOT NULL",
        "TRIM(Link) != ''",
    ]
    if not force:
        filtros.append("texto_ocr IS NULL")

    where   = " AND ".join(filtros)
    lim_sql = f"LIMIT {limite}" if limite else ""
    query   = f"""
        SELECT id, UC, Mes_Ref, Link,
               KWH_Ponta, KWH_FPonta, KWH_Total,
               Leitura_Anterior_KWH_P, Leitura_Atual_KWH_P,
               Leitura_Anterior_KWH_FP, Leitura_Atual_KWH_FP,
               Constante_KWH_P, Constante_KWH_FP,
               Qtd_Dias, RS_Total_Fatura, Media_Consumo,
               Dt_Leitura_Anterior, Dt_Leitura_Atual, DATA_PROXIMA_LEITURA,
               Dt_Emissao_NF, Dt_Venc_NF,
               CIP, Tarifa_Cheia_KWH_FPonta_SImpostos,
               Base_de_Calculo_ICMS, Aliquota_ICMS, ICMS_RS,
               Aliquota_PIS, PIS_RS,
               Aliquota_COFINS, COFINS_RS,
               KWH_FPonta_Injet, RS_KWH_FPonta,
               Base_de_Calculo_PIS_COFINS
        FROM Faturas_Registradas_Cache
        WHERE {where}
        ORDER BY id DESC
        {lim_sql}
    """
    cur.execute(query)
    faturas = cur.fetchall()
    log.info(f"Faturas para processar: {len(faturas)}")

    if not faturas:
        log.info("Nada a processar.")
        cur.close(); conn.close(); return

    # ── Processa ─────────────────────────────────────────────────────────────
    ok = erro = 0
    for i, row in enumerate(faturas, 1):
        fid  = row["id"]
        uc   = row["UC"]
        mes  = row["Mes_Ref"]
        link = str(row["Link"]).strip()

        log.info(f"\n[{i}/{len(faturas)}] id={fid}  UC={uc}  ref={mes}")
        log.info(f"  Link: {link[:80]}")

        # 1. Download PDF
        try:
            r = requests.get(link, timeout=30, stream=True)
            r.raise_for_status()
            pdf_bytes = r.content
            log.info(f"  PDF: {len(pdf_bytes)/1024:.1f} KB")
        except Exception as e:
            log.warning(f"  Download falhou: {e}")
            erro += 1
            continue

        # 2. OCR
        texto_ocr = ocr_pdf(pdf_bytes, ocr, fid)
        if not texto_ocr:
            log.warning("  OCR retornou vazio.")
            erro += 1
            continue
        log.info(f"  OCR: {len(texto_ocr)} chars")

        # 3. Parser
        linhas = texto_ocr.splitlines()
        dados  = parse_energisa_mt(linhas)

        log.info(
            f"  Parser → kwh={dados['kwh_total']} | rs={dados['total_rs']} | "
            f"ant={dados['leit_ant_p']} | atu={dados['leit_atu_p']} | "
            f"dias={dados['dias']} | cte={dados['constante_p']} | "
            f"tarifa={dados['tarifa_kwh']} | cip={dados['cip']} | "
            f"injet={dados['kwh_injet']} | venc={dados['vencimento']} | "
            f"emis={dados['dt_emissao']} | "
            f"ICMS={dados['icms_base']}/{dados['icms_aliq']}%={dados['icms_valor']} | "
            f"PIS={dados['pis_aliq']}%={dados['pis_valor']} | "
            f"COFINS={dados['cofins_aliq']}%={dados['cofins_valor']}"
        )
        log.info(f"  Histórico extraído: {len(dados['historico'])} meses")
        for h in dados["historico"]:
            log.info(f"    {h['mes']:02d}/{h['ano']}: {h['kwh']:.0f} kWh")

        if dryrun:
            log.info("  [DRYRUN] Não gravando.")
            ok += 1
            continue

        # 4. Grava texto_ocr
        update_sql = """
            UPDATE Faturas_Registradas_Cache
            SET texto_ocr      = %s,
                ocr_gerado_em  = NOW()
            WHERE id = %s AND (texto_ocr IS NULL OR %s)
        """
        cur.execute(update_sql, (texto_ocr, fid, force))
        conn.commit()

        # 5. Preenche campos vazios com dados do OCR (não sobrescreve se já tem)
        # Cada entrada: (coluna_db, valor_ocr, valor_db_atual)
        from datetime import date as _date

        def _vazio(v):
            """True se o valor do DB está vazio/zero/None."""
            if v is None:
                return True
            if isinstance(v, (int, float)) and v == 0:
                return True
            if isinstance(v, str) and v.strip() == "":
                return True
            return False

        def _dt(s):
            """'DD/MM/YYYY' → 'YYYY-MM-DD' para MySQL, ou None."""
            d = _data_br(s) if s else None
            return d.strftime("%Y-%m-%d") if d else None

        campos_vazios = []
        vals          = []

        # Consumo kWh — Energisa MT BT grava tudo em KWH_FPonta
        if dados["kwh_total"] and _vazio(row["KWH_Ponta"]) and _vazio(row["KWH_FPonta"]):
            campos_vazios.append("`KWH_FPonta` = %s")
            vals.append(dados["kwh_total"])

        # Leituras
        if dados["leit_ant_p"] and _vazio(row["Leitura_Anterior_KWH_P"]):
            campos_vazios.append("`Leitura_Anterior_KWH_P` = %s")
            vals.append(dados["leit_ant_p"])
        if dados["leit_atu_p"] and _vazio(row["Leitura_Atual_KWH_P"]):
            campos_vazios.append("`Leitura_Atual_KWH_P` = %s")
            vals.append(dados["leit_atu_p"])
        if dados["leit_ant_fp"] and _vazio(row["Leitura_Anterior_KWH_FP"]):
            campos_vazios.append("`Leitura_Anterior_KWH_FP` = %s")
            vals.append(dados["leit_ant_fp"])
        if dados["leit_atu_fp"] and _vazio(row["Leitura_Atual_KWH_FP"]):
            campos_vazios.append("`Leitura_Atual_KWH_FP` = %s")
            vals.append(dados["leit_atu_fp"])
        if dados["constante_p"] and _vazio(row["Constante_KWH_P"]):
            campos_vazios.append("`Constante_KWH_P` = %s")
            campos_vazios.append("`Constante_KWH_FP` = %s")
            vals.extend([dados["constante_p"], dados["constante_p"]])

        # Dias / Datas
        if dados["dias"] and _vazio(row["Qtd_Dias"]):
            campos_vazios.append("`Qtd_Dias` = %s")
            vals.append(dados["dias"])
        if dados["dt_leit_ant"] and _vazio(row["Dt_Leitura_Anterior"]):
            campos_vazios.append("`Dt_Leitura_Anterior` = %s")
            vals.append(_dt(dados["dt_leit_ant"]))
        if dados["dt_leit_atu"] and _vazio(row["Dt_Leitura_Atual"]):
            campos_vazios.append("`Dt_Leitura_Atual` = %s")
            vals.append(_dt(dados["dt_leit_atu"]))
        if dados["dt_proxima"] and _vazio(row["DATA_PROXIMA_LEITURA"]):
            campos_vazios.append("`DATA_PROXIMA_LEITURA` = %s")
            vals.append(_dt(dados["dt_proxima"]))
        if dados["dt_emissao"] and _vazio(row["Dt_Emissao_NF"]):
            campos_vazios.append("`Dt_Emissao_NF` = %s")
            vals.append(_dt(dados["dt_emissao"]))
        if dados["vencimento"] and _vazio(row["Dt_Venc_NF"]):
            campos_vazios.append("`Dt_Venc_NF` = %s")
            vals.append(_dt(dados["vencimento"]))

        # Financeiro
        if dados["total_rs"] and _vazio(row["RS_Total_Fatura"]):
            campos_vazios.append("`RS_Total_Fatura` = %s")
            vals.append(dados["total_rs"])
        if dados["rs_consumo"] and _vazio(row["RS_KWH_FPonta"]):
            campos_vazios.append("`RS_KWH_FPonta` = %s")
            vals.append(dados["rs_consumo"])
        if dados["cip"] and _vazio(row["CIP"]):
            campos_vazios.append("`CIP` = %s")
            vals.append(dados["cip"])

        # Tarifa
        if dados["tarifa_kwh"] and _vazio(row["Tarifa_Cheia_KWH_FPonta_SImpostos"]):
            campos_vazios.append("`Tarifa_Cheia_KWH_FPonta_SImpostos` = %s")
            vals.append(dados["tarifa_kwh"])

        # Tributos
        if dados["icms_base"] and _vazio(row["Base_de_Calculo_ICMS"]):
            campos_vazios.append("`Base_de_Calculo_ICMS` = %s")
            vals.append(dados["icms_base"])
        if dados["icms_aliq"] and _vazio(row["Aliquota_ICMS"]):
            campos_vazios.append("`Aliquota_ICMS` = %s")
            vals.append(dados["icms_aliq"])
        if dados["icms_valor"] and _vazio(row["ICMS_RS"]):
            campos_vazios.append("`ICMS_RS` = %s")
            vals.append(dados["icms_valor"])
        if dados["pis_base"] and _vazio(row["Base_de_Calculo_PIS_COFINS"]):
            campos_vazios.append("`Base_de_Calculo_PIS_COFINS` = %s")
            vals.append(dados["pis_base"])
        if dados["pis_aliq"] and _vazio(row["Aliquota_PIS"]):
            campos_vazios.append("`Aliquota_PIS` = %s")
            vals.append(dados["pis_aliq"])
        if dados["pis_valor"] and _vazio(row["PIS_RS"]):
            campos_vazios.append("`PIS_RS` = %s")
            vals.append(dados["pis_valor"])
        if dados["cofins_aliq"] and _vazio(row["Aliquota_COFINS"]):
            campos_vazios.append("`Aliquota_COFINS` = %s")
            vals.append(dados["cofins_aliq"])
        if dados["cofins_valor"] and _vazio(row["COFINS_RS"]):
            campos_vazios.append("`COFINS_RS` = %s")
            vals.append(dados["cofins_valor"])

        # Injeção
        if dados["kwh_injet"] and _vazio(row["KWH_FPonta_Injet"]):
            campos_vazios.append("`KWH_FPonta_Injet` = %s")
            campos_vazios.append("`KWH_Total_Injet` = %s")
            vals.extend([dados["kwh_injet"], dados["kwh_injet"]])

        if campos_vazios:
            upd = f"UPDATE Faturas_Registradas_Cache SET {', '.join(campos_vazios)} WHERE id = %s"
            vals.append(fid)
            cur.execute(upd, vals)
            conn.commit()
            nomes = [c.split("=")[0].strip().replace("`", "") for c in campos_vazios]
            log.info(f"  Campos preenchidos ({len(nomes)}): {nomes}")
        else:
            log.info("  Sem campos novos para preencher.")

        ok += 1
        time.sleep(0.3)

    log.info(f"\nConcluído: {ok} ok | {erro} erros | {len(faturas)} total")
    log.info("=" * 60)
    cur.close()
    conn.close()


# ─── Entry point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Pipeline OCR — Energisa MT (empresa 14)")
    parser.add_argument("--force",  action="store_true",
                        help="Reprocessa mesmo com texto_ocr preenchido")
    parser.add_argument("--limite", type=int, default=None,
                        help="Máximo de faturas a processar")
    parser.add_argument("--dryrun", action="store_true",
                        help="Mostra dados na tela sem gravar no banco")
    args = parser.parse_args()

    main(force=args.force, limite=args.limite, dryrun=args.dryrun)
