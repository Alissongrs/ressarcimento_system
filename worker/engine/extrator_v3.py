"""extrator_v3.py — Cascata determinística:
    1. PyMuPDF com clip (regiões via bbox)
    2. pdfplumber com crop
    3. img2table (último recurso, OCR de região)

PRESERVA notação BR original — não converte string. Float só p/ auditoria.
"""
import os, re, json, sys, time
from typing import Optional


def localizar_anchor(texto: str, anchor: str) -> Optional[tuple]:
    """Retorna posição do anchor no texto (start, end). None se não encontrar."""
    m = re.search(re.escape(anchor), texto, re.I)
    return (m.start(), m.end()) if m else None


# ============================================================
# CAMADA 1 — PyMuPDF clip (regiões nativas)
# ============================================================
def pymupdf_blocks_com_bbox(pdf_path: str) -> list:
    """Retorna [(texto, x0, y0, x1, y1, pag)]. Rapido e nativo."""
    import fitz
    out = []
    try:
        doc = fitz.open(pdf_path)
        for p, page in enumerate(doc):
            for b in page.get_text("blocks") or []:
                if len(b) >= 5 and isinstance(b[4], str):
                    txt = b[4].strip()
                    if txt:
                        out.append({"texto": txt, "x0": b[0], "y0": b[1],
                                    "x1": b[2], "y1": b[3], "pag": p})
        doc.close()
    except Exception:
        pass
    return out


def pymupdf_clip_regiao(pdf_path: str, pag: int, x0: float, y0: float,
                        x1: float, y1: float) -> str:
    """Extrai texto de uma regiao especifica do PDF (clip via bbox)."""
    import fitz
    try:
        doc = fitz.open(pdf_path)
        if pag >= len(doc): return ""
        page = doc[pag]
        rect = fitz.Rect(x0, y0, x1, y1)
        txt = page.get_text("text", clip=rect)
        doc.close()
        return txt.strip()
    except Exception:
        return ""


# ============================================================
# CAMADA 2 — pdfplumber crop (regiões com tabela)
# ============================================================
def pdfplumber_crop_tabela(pdf_path: str, pag: int, bbox: tuple) -> list:
    """Extrai tabela de regiao especifica via pdfplumber.crop()."""
    try:
        import pdfplumber
        with pdfplumber.open(pdf_path) as pdf:
            if pag >= len(pdf.pages): return []
            page = pdf.pages[pag]
            cropped = page.crop(bbox)
            tabelas = cropped.extract_tables()
            return tabelas or []
    except Exception:
        return []


def pdfplumber_extrair_tabelas_pagina(pdf_path: str, pag: int) -> list:
    """Todas as tabelas de uma pagina."""
    try:
        import pdfplumber
        with pdfplumber.open(pdf_path) as pdf:
            if pag >= len(pdf.pages): return []
            return pdf.pages[pag].extract_tables() or []
    except Exception:
        return []


# ============================================================
# CAMADA 1b — PyMuPDF4LLM (markdown estruturado com tabelas)
# Fallback para faturas onde pdfplumber falha (fonts CID, layouts complexos)
# ============================================================
def pymupdf4llm_markdown(pdf_path: str) -> dict:
    """Converte PDF para markdown estruturado via pymupdf4llm.
    Mantém tabelas como tabelas markdown — útil quando plumber falha.
    """
    try:
        import pymupdf4llm
        md = pymupdf4llm.to_markdown(pdf_path)
        # Conta tabelas no markdown (padrão | col | col |)
        n_tabelas = len(re.findall(r"^\|[^\n]+\|$", md, re.MULTILINE))
        return {"markdown": md, "n_tabelas_md": n_tabelas, "chars": len(md)}
    except Exception as e:
        return {"erro": str(e)[:120]}


def extrair_cnpj_de_markdown(md_text: str) -> list:
    """Extrai TODOS os CNPJs do markdown (útil quando plumber não pegou)."""
    cnpjs = []
    for m in re.finditer(r"(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})", md_text):
        cnpjs.append(m.group(1))
    return list(set(cnpjs))


# ============================================================
# CAMADA 1c — PyMuPDF get_drawings() para detectar tabelas sem bordas
# ============================================================
def detectar_tabelas_via_drawings(pdf_path: str) -> list:
    """Usa get_drawings() para identificar regiões com linhas/retângulos.
    Returns: [{pag, bbox, n_linhas_horizontais, n_linhas_verticais}]
    Útil para identificar onde estão tabelas mesmo sem bordas claras.
    """
    try:
        import fitz
        doc = fitz.open(pdf_path)
        tabelas_detectadas = []
        for pag_idx, page in enumerate(doc):
            drawings = page.get_drawings() or []
            if not drawings: continue
            # Coleta linhas horizontais e verticais
            horiz = []; vert = []
            for d in drawings:
                items = d.get("items") or []
                for it in items:
                    if len(it) < 2: continue
                    op = it[0]
                    if op == "l":  # linha
                        pts = it[1:]
                        if len(pts) >= 2:
                            p1, p2 = pts[0], pts[1]
                            if abs(p1.y - p2.y) < 1.5:  # horizontal
                                horiz.append((min(p1.x, p2.x), p1.y, max(p1.x, p2.x), p1.y))
                            elif abs(p1.x - p2.x) < 1.5:  # vertical
                                vert.append((p1.x, min(p1.y, p2.y), p1.x, max(p1.y, p2.y)))
            # Tabela = pelo menos 3 horizontais + 2 verticais próximas
            if len(horiz) >= 3 and len(vert) >= 2:
                # Bbox que engloba todas
                all_x = [l[0] for l in horiz+vert] + [l[2] for l in horiz+vert]
                all_y = [l[1] for l in horiz+vert] + [l[3] for l in horiz+vert]
                tabelas_detectadas.append({
                    "pag": pag_idx,
                    "bbox": [min(all_x), min(all_y), max(all_x), max(all_y)],
                    "n_horizontais": len(horiz),
                    "n_verticais": len(vert),
                })
        doc.close()
        return tabelas_detectadas
    except Exception:
        return []


def extrair_tabela_via_drawings_bbox(pdf_path: str, pag: int, bbox: list) -> list:
    """Extrai tabela de bbox identificado por get_drawings() via pdfplumber.crop"""
    try:
        import pdfplumber
        with pdfplumber.open(pdf_path) as pdf:
            if pag >= len(pdf.pages): return []
            page = pdf.pages[pag]
            cropped = page.crop(bbox)
            return cropped.extract_tables() or []
    except Exception:
        return []


# ============================================================
# CAMADA 3 — img2table (OCR + estrutura de tabela)
# ============================================================
def img2table_extrair(pdf_path: str, paginas: list = None) -> dict:
    """Extrai tabelas via img2table (OCR-based). Retorna {pag: [DataFrames]}."""
    try:
        from img2table.document import PDF
        try:
            from img2table.ocr import TesseractOCR
            ocr = TesseractOCR(lang="por")
        except Exception:
            ocr = None
        doc = PDF(src=pdf_path, pages=paginas)
        tabs = doc.extract_tables(ocr=ocr, implicit_rows=True, borderless_tables=True)
        result = {}
        for pag, lista in tabs.items():
            result[pag] = []
            for t in lista:
                try:
                    df = t.df
                    if df is not None and not df.empty:
                        result[pag].append({
                            "shape": list(df.shape),
                            "headers": [str(c) for c in df.columns],
                            "rows": [[str(v) if v is not None else None for v in row]
                                     for row in df.values.tolist()],
                        })
                except Exception:
                    pass
        return result
    except Exception as e:
        return {"_erro": str(e)[:120]}


# ============================================================
# Anchors típicos de DANF3E para definir regiões
# ============================================================
ANCHORS_REGIAO = {
    "saldo_gd": ["ATEN", "Saldo Ac", "Saldo de cr", "Mensagem"],
    "historico_13m": ["Hist", "MÊS/ANO", "MES/ANO"],
    "itens_fatura": ["DESCRIÇÃO", "Item", "Valor (R$)", "Tarifa Unit"],
    "tributos": ["TRIBUTOS", "PIS/PASEP", "Base de Cálculo"],
    "indicadores": ["DIC", "FIC", "DMIC", "DICRI"],
    "leituras": ["Leitura Anterior", "Leitura Atual", "Constante"],
    "demanda": ["Demanda contratada", "Demanda Ponta"],
}


def detectar_regioes(pdf_path: str) -> dict:
    """Identifica bbox de cada regiao usando anchors do texto+coords."""
    blocos = pymupdf_blocks_com_bbox(pdf_path)
    regioes = {}
    for nome, anchors in ANCHORS_REGIAO.items():
        for b in blocos:
            for anc in anchors:
                if anc.lower() in b["texto"].lower():
                    regioes.setdefault(nome, []).append({
                        "pag": b["pag"],
                        "bbox": [b["x0"], b["y0"], b["x1"], b["y1"]],
                        "anchor": anc,
                        "texto_inicial": b["texto"][:100],
                    })
                    break
    return regioes


# ============================================================
# Pipeline em cascata: PyMuPDF clip → pdfplumber crop → img2table
# ============================================================
def cascata_extracao(pdf_path: str) -> dict:
    """Aplica cascata progressiva. Retorna texto/tabelas por região identificada."""
    out = {
        "regioes_detectadas": {},
        "saldo_gd_texto": None,
        "tabelas_pdfplumber": {},
        "tabelas_img2table": {},
        "tabelas_drawings": [],
        "pymupdf4llm": {},
        "cnpjs_extraidos_md": [],
        "timings_ms": {},
    }

    # Detectar regiões via blocks com bbox
    t0 = time.time()
    regioes = detectar_regioes(pdf_path)
    out["regioes_detectadas"] = {k: len(v) for k, v in regioes.items()}
    out["timings_ms"]["detect"] = int((time.time() - t0) * 1000)

    # Camada 1: PyMuPDF clip nas regiões saldo_gd e tributos
    t0 = time.time()
    for nome in ("saldo_gd", "tributos", "indicadores"):
        if nome in regioes:
            for r in regioes[nome][:1]:  # pega primeiro match
                # expande bbox para capturar contexto vizinho
                x0, y0, x1, y1 = r["bbox"]
                ctx = pymupdf_clip_regiao(pdf_path, r["pag"],
                                          x0-10, y0-10, x1+50, y1+200)
                out[f"{nome}_texto"] = ctx
                break
    out["timings_ms"]["pymupdf_clip"] = int((time.time() - t0) * 1000)

    # Camada 2: pdfplumber tabelas (na página)
    t0 = time.time()
    try:
        import pdfplumber
        with pdfplumber.open(pdf_path) as pdf:
            for pag_num in range(len(pdf.pages)):
                tabs = pdf.pages[pag_num].extract_tables() or []
                if tabs:
                    out["tabelas_pdfplumber"][pag_num] = [
                        {"shape": [len(t), len(t[0]) if t else 0],
                         "rows": t}
                        for t in tabs if t and len(t) > 1
                    ]
    except Exception:
        pass
    out["timings_ms"]["pdfplumber"] = int((time.time() - t0) * 1000)

    # CAMADA 1b — get_drawings() detecta tabelas via linhas visuais
    t0 = time.time()
    try:
        tab_draw = detectar_tabelas_via_drawings(pdf_path)
        if tab_draw:
            out["tabelas_drawings"] = tab_draw
            # Para cada tabela detectada, tenta extrair via pdfplumber.crop
            for td in tab_draw[:5]:
                conteudo = extrair_tabela_via_drawings_bbox(pdf_path, td["pag"], td["bbox"])
                if conteudo:
                    td["conteudo"] = conteudo
    except Exception:
        pass
    out["timings_ms"]["drawings"] = int((time.time() - t0) * 1000)

    # CAMADA 1c — PyMuPDF4LLM SEMPRE (extrai CNPJs e markdown estruturado adicional)
    t0 = time.time()
    md_out = pymupdf4llm_markdown(pdf_path)
    if "markdown" in md_out:
        out["pymupdf4llm"] = {
            "chars": md_out.get("chars"),
            "n_tabelas_md": md_out.get("n_tabelas_md"),
            "preview": (md_out.get("markdown") or "")[:500],
        }
        # CNPJs do markdown — fallback para texto plumber falho
        out["cnpjs_extraidos_md"] = extrair_cnpj_de_markdown(md_out.get("markdown", ""))
        # Guarda md completo para uso pelo extrator_v2 fallback
        out["_markdown_full"] = md_out.get("markdown", "")
    out["timings_ms"]["pymupdf4llm"] = int((time.time() - t0) * 1000)

    # Camada 3: img2table SÓ se pdfplumber + drawings falharam em achar tabela.
    # img2table usa TesseractOCR internamente ("Using Tesseract for OCR processing"),
    # que é lento, polui o stdout e trava com múltiplos workers. Com PDF_PIPELINE_NO_OCR=1
    # (flag --no-ocr do pdf_pipeline) essa camada é pulada — a fatura fica sem as tabelas
    # do img2table, mas plumber/bbox já cobrem faturas com text-layer nativo.
    _no_ocr = os.getenv("PDF_PIPELINE_NO_OCR", "") == "1"
    if not out["tabelas_pdfplumber"] and not out["tabelas_drawings"] and not _no_ocr:
        t0 = time.time()
        try:
            i2t = img2table_extrair(pdf_path)
            if "_erro" not in i2t:
                out["tabelas_img2table"] = i2t
        except Exception:
            pass
        out["timings_ms"]["img2table"] = int((time.time() - t0) * 1000)

    return out


# ============================================================
# Resumo (sem conversão de notação BR — mantém strings originais)
# ============================================================
def resumir(cascata_out: dict) -> dict:
    """Resumo legível, mantendo todas as strings no formato original."""
    n_tab_pdf = sum(len(v) for v in cascata_out.get("tabelas_pdfplumber", {}).values())
    n_tab_i2t = sum(len(v) for v in cascata_out.get("tabelas_img2table", {}).values())
    n_tab_draw = len(cascata_out.get("tabelas_drawings", []))
    cnpjs_md = cascata_out.get("cnpjs_extraidos_md", [])
    pmupdf4llm = cascata_out.get("pymupdf4llm", {})
    return {
        "regioes_detectadas": cascata_out.get("regioes_detectadas", {}),
        "saldo_gd_texto": (cascata_out.get("saldo_gd_texto") or "")[:300],
        "tributos_texto": (cascata_out.get("tributos_texto") or "")[:200],
        "n_tabelas_pdfplumber": n_tab_pdf,
        "n_tabelas_img2table": n_tab_i2t,
        "n_tabelas_drawings": n_tab_draw,
        "tabelas_drawings": cascata_out.get("tabelas_drawings", [])[:5],
        "n_tabelas_md": pmupdf4llm.get("n_tabelas_md", 0),
        "md_chars": pmupdf4llm.get("chars", 0),
        "cnpjs_extraidos_md": cnpjs_md,
        "timings_ms": cascata_out.get("timings_ms", {}),
    }


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding='utf-8') if sys.platform == 'win32' else None
    if len(sys.argv) > 1:
        pdf_path = sys.argv[1]
    else:
        print("Uso: python extrator_v3.py <pdf_path>"); sys.exit(1)
    out = cascata_extracao(pdf_path)
    print(json.dumps(resumir(out), ensure_ascii=False, indent=2, default=str))
