# -*- coding: utf-8 -*-
"""Identificação da fatura por quadro (etapa 1 da captura de alto nível).

A fatura é um formulário: os dados de identificação ficam em quadros. Três sinais dão o valor certo:
  1. o RÓTULO em texto ("Código da Instalação", "DATA DE EMISSÃO", "Nº de dias"...), quando existe na
     camada de texto — o valor é lido na mesma linha, logo abaixo (mesma coluna) ou à direita;
  2. a FONTE GRANDE do cabeçalho: UC, mês de referência, vencimento e total a pagar vêm em destaque em
     quase todos os layouts, e os rótulos desses quadros coloridos muitas vezes são desenho, não texto
     (nenhuma biblioteca os lê). O valor é reconhecido pela forma (MM/AAAA, data, R$, identificador)
     entre as linhas de fonte grande do topo da página 1;
  3. a CHAVE DE ACESSO da NF3e (44 dígitos): os dígitos 7 a 20 são o CNPJ da emissora — identifica a
     distribuidora mesmo quando o cabeçalho inteiro é imagem (Light, Neoenergia Brasília).
A distribuidora vem do catálogo `distribuidoras.json` (raiz do CNPJ → nome canônico, UF, família de
layout); sem CNPJ legível, do nome do grupo no texto mais a UF do endereço.

Uso:
    from identificacao import identificar
    ident = identificar(pdf_bytes)          # campos + origem de cada um em _origem
    python identificacao.py fatura.pdf
"""
from __future__ import annotations

import collections
import io
import json
import os
import re
import statistics
import sys
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path

AQUI = Path(__file__).resolve().parent

# ─── catálogo de distribuidoras ───────────────────────────────────────────────
_CATALOGO: dict | None = None


def catalogo() -> dict:
    global _CATALOGO
    if _CATALOGO is None:
        with io.open(AQUI / "distribuidoras.json", encoding="utf-8") as f:
            d = json.load(f)
        _CATALOGO = {k: v for k, v in d.items() if not k.startswith("_")}
    return _CATALOGO


# ─── utilidades de texto ──────────────────────────────────────────────────────
def normalizar(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s).strip().lower()


MESES = {"jan": 1, "fev": 2, "mar": 3, "abr": 4, "mai": 5, "jun": 6, "jul": 7, "ago": 8, "set": 9, "out": 10, "nov": 11, "dez": 12,
         "janeiro": 1, "fevereiro": 2, "marco": 3, "abril": 4, "maio": 5, "junho": 6, "julho": 7, "agosto": 8,
         "setembro": 9, "outubro": 10, "novembro": 11, "dezembro": 12}
UFS = "AC|AL|AM|AP|BA|CE|DF|ES|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO"

RE_CNPJ = re.compile(r"(?<!\d)0?(\d{2})[.\s]?(\d{3})[.\s]?(\d{3})\s?/\s?(\d{4})\s?-?\s?(\d{2})(?!\d)")
RE_CHAVE = re.compile(r"(?<!\d)(\d{44})(?!\d)")
RE_DATA = re.compile(r"(?<!\d)(\d{2})[/.](\d{2})[/.](\d{4})(?!\d)")
RE_DATA_CURTA = re.compile(r"(?<![\d/])(\d{2})/(\d{2})(?:/(\d{2,4}))?(?![\d/])")
RE_MESANO_NUM = re.compile(r"(?<![\d/.])(\d{2})\s*/\s*(\d{4})(?![\d/])")
RE_MESANO_NOME = re.compile(r"\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\s*/?\s*(\d{4})\b")
RE_DINHEIRO = re.compile(r"(?<![\d,])(\d{1,3}(?:\.\d{3})*,\d{2})(?![\d])")
RE_ID = re.compile(r"(?<![\d.\-/])([A-Z]{0,2}\d[\d.\-/ ]{3,24}\d)(?![\d.\-/])")
RE_ID_PURO = re.compile(r"^[A-Z]{0,2}\d[\d.\-/]{4,24}\d(?:\s*/\s*\d[\d.\-/]{4,24}\d)?$")
RE_INT = re.compile(r"(?<!\d)(\d{1,3})(?!\d)")


@dataclass
class Item:
    text: str
    norm: str
    x: float
    y: float
    w: float
    h: float
    page: int


def _itens_liteparse(pdf_bytes: bytes, max_paginas: int):
    import liteparse
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            f.write(pdf_bytes)
            tmp = f.name
        res = liteparse.LiteParse(quiet=True, ocr_enabled=False).parse(tmp)
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except Exception:
                pass
    itens, pw, ph = [], 0.0, 0.0
    for pi, pg in enumerate(res.pages or []):
        if pi >= max_paginas:
            break
        if pi == 0:
            pw, ph = float(getattr(pg, "width", 0) or 0), float(getattr(pg, "height", 0) or 0)
        for t in pg.text_items or []:
            txt = (t.text or "").strip()
            if txt:
                itens.append(Item(txt, normalizar(txt), float(t.x), float(t.y), float(t.width), float(t.height), pi))
    return itens, pw, ph


def _itens_fitz(pdf_bytes: bytes, max_paginas: int):
    import fitz
    d = fitz.open(stream=pdf_bytes, filetype="pdf")
    itens, pw, ph = [], 0.0, 0.0
    for pi, pg in enumerate(d):
        if pi >= max_paginas:
            break
        if pi == 0:
            pw, ph = float(pg.rect.width), float(pg.rect.height)
        for b in pg.get_text("dict").get("blocks", []):
            for l in b.get("lines", []):
                txt = "".join(s.get("text", "") for s in l.get("spans", [])).strip()
                if not txt:
                    continue
                x0, y0, x1, y1 = l["bbox"]
                itens.append(Item(txt, normalizar(txt), float(x0), float(y0), float(x1 - x0), float(y1 - y0), pi))
    return itens, pw, ph


OCR_ZOOM = float(os.getenv("TESS_ZOOM", "3"))
ULTIMA_FONTE = "texto"  # "ocr" quando itens_do_pdf caiu no OCR (medicao.py afrouxa a tolerância de linha)  # 3x ≈ 216 dpi, igual ao OCR do pdf_pipeline


def _itens_ocr(pdf_bytes: bytes, max_paginas: int) -> tuple[list[Item], float, float]:
    """PDF só imagem: linhas posicionadas pelo Tesseract (image_to_data agrupado por linha), em pontos do PDF.
    Gratuito e local — é o caminho das escaneadas quando a leitura por imagem (claude -p) não cabe."""
    import fitz
    import pytesseract
    from PIL import Image
    tessdata = os.getenv("TESS_TESSDATA", r"C:\paddleocr\tessdata")
    if tessdata and Path(tessdata).is_dir() and not os.getenv("TESSDATA_PREFIX"):
        os.environ["TESSDATA_PREFIX"] = tessdata
    exe = os.getenv("TESSERACT_EXE", r"C:\Program Files\Tesseract-OCR\tesseract.exe")
    if exe and Path(exe).is_file():
        pytesseract.pytesseract.tesseract_cmd = exe
    d = fitz.open(stream=pdf_bytes, filetype="pdf")
    if d.is_encrypted and not d.authenticate(""):
        raise ValueError("PDF protegido")
    itens, pw, ph = [], 0.0, 0.0
    for pi, pg in enumerate(d):
        if pi >= max_paginas:
            break
        if pi == 0:
            pw, ph = float(pg.rect.width), float(pg.rect.height)
        pix = pg.get_pixmap(matrix=fitz.Matrix(OCR_ZOOM, OCR_ZOOM))
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        try:
            dados = pytesseract.image_to_data(img, lang=os.getenv("TESS_LANG", "por"), config=os.getenv("TESS_PSM_CFG", "--oem 1 --psm 3"),
                                              output_type=pytesseract.Output.DICT)
        except pytesseract.TesseractError:
            dados = pytesseract.image_to_data(img, lang="eng", config=os.getenv("TESS_PSM_CFG", "--oem 1 --psm 3"), output_type=pytesseract.Output.DICT)
        linhas: dict[tuple, list] = collections.defaultdict(list)
        for k in range(len(dados["text"])):
            t = (dados["text"][k] or "").strip()
            if not t or int(dados["conf"][k]) < 0:
                continue
            chave = (dados["block_num"][k], dados["par_num"][k], dados["line_num"][k])
            linhas[chave].append((dados["left"][k], dados["top"][k], dados["width"][k], dados["height"][k], t))
        for _, pal in linhas.items():
            pal.sort(key=lambda w: w[0])
            # quebra a linha do Tesseract onde o espaço entre palavras é grande (colunas de tabela viram itens separados)
            seg: list = []
            for w in pal:
                if seg and w[0] - (seg[-1][0] + seg[-1][2]) > 2.5 * max(seg[-1][3], 1):
                    itens.append(_item_de_palavras(seg, pi))
                    seg = []
                seg.append(w)
            if seg:
                itens.append(_item_de_palavras(seg, pi))
    return itens, pw, ph


def _item_de_palavras(pal: list, pagina: int) -> Item:
    x0 = min(w[0] for w in pal) / OCR_ZOOM
    y0 = min(w[1] for w in pal) / OCR_ZOOM
    x1 = max(w[0] + w[2] for w in pal) / OCR_ZOOM
    h = max(w[3] for w in pal) / OCR_ZOOM
    txt = " ".join(w[4] for w in pal)
    return Item(txt, normalizar(txt), x0, y0, x1 - x0, h, pagina)


def _itens_rapidocr(pdf_bytes: bytes, max_paginas: int) -> tuple[list[Item], float, float]:
    """PDF só imagem: linhas posicionadas pelo RapidOCR (ocr_itens.py — modelos do PaddleOCR em CPU, gratuito).
    Lê a fonte pequena da tabela de medição que o Tesseract não lê; o resultado fica em cache para a medição e o
    texto corrido (pdf_pipeline.extrair_ocr) não refazerem o OCR da mesma fatura."""
    import ocr_itens
    bruto, pw, ph = ocr_itens.itens_rapidocr(pdf_bytes, max_paginas)
    itens = [Item(i["text"], normalizar(i["text"]), float(i["x"]), float(i["y"]), float(i["w"]), float(i["h"]), int(i["page"]))
             for i in bruto if (i.get("text") or "").strip()]
    return itens, pw, ph


def itens_do_pdf(pdf_bytes: bytes, max_paginas: int = 2) -> tuple[list[Item], float, float]:
    """Linhas posicionadas: liteparse; se vier pouco (PDF estranho), PyMuPDF; se continuar sem texto (PDF só imagem)
    e o OCR não estiver desligado (PDF_PIPELINE_NO_OCR=1), RapidOCR (ou Tesseract, se o pacote não estiver instalado;
    SURE_OCR_MOTOR=tesseract força o Tesseract)."""
    global ULTIMA_FONTE
    ULTIMA_FONTE = "texto"
    try:
        itens, pw, ph = _itens_liteparse(pdf_bytes, max_paginas)
    except Exception:
        itens, pw, ph = [], 0.0, 0.0
    if len([i for i in itens if i.page == 0]) < 40:
        try:
            itens2, pw2, ph2 = _itens_fitz(pdf_bytes, max_paginas)
            if len(itens2) > len(itens):
                itens, pw, ph = itens2, pw2, ph2
        except Exception:
            pass
    if len([i for i in itens if i.page == 0]) < 15 and os.getenv("PDF_PIPELINE_NO_OCR", "") != "1":
        itens3, pw3, ph3 = [], 0.0, 0.0
        if os.getenv("SURE_OCR_MOTOR", "rapidocr") != "tesseract":
            try:
                itens3, pw3, ph3 = _itens_rapidocr(pdf_bytes, max_paginas)
            except Exception:
                itens3 = []
        if not itens3:
            try:
                itens3, pw3, ph3 = _itens_ocr(pdf_bytes, max_paginas)
            except Exception:
                itens3 = []
        if len(itens3) > len(itens):
            itens, pw, ph = itens3, pw3, ph3
            ULTIMA_FONTE = "ocr"
    itens.sort(key=lambda i: (i.page, round(i.y / 2), i.x))
    return itens, pw, ph


# ─── parsers de valor ─────────────────────────────────────────────────────────
def parse_uc(s: str) -> str | None:
    """Primeiro identificador plausível (5 a 15 dígitos, com pontos/traços/barras) que não é data, CEP, CNPJ, valor ou página."""
    for m in RE_ID.finditer(s):
        tok = m.group(1).strip().rstrip("/-. ")
        if " " in tok:
            tok = tok.split(" ")[0].rstrip("/-. ")
        dig = re.sub(r"\D", "", tok)
        if not (5 <= len(dig) <= 15):
            continue
        if RE_DATA.search(tok) or re.fullmatch(r"\d{2}/\d{4}", tok) or RE_DINHEIRO.search(tok) or RE_CNPJ.search(tok):
            continue
        if re.fullmatch(r"\d{1,2}/\d{1,2}", tok) or re.fullmatch(r"\d{5}-\d{3}", tok):
            continue
        return tok
    return None


def parse_mesano(s: str) -> str | None:
    n = normalizar(s)
    if RE_DATA.search(n):
        n = RE_DATA.sub(" ", n)
    m = RE_MESANO_NUM.search(n)
    if m and 1 <= int(m.group(1)) <= 12 and 2000 <= int(m.group(2)) <= 2099:
        return f"{m.group(2)}-{int(m.group(1)):02d}-01"
    m = RE_MESANO_NOME.search(n)
    if m:
        mes = MESES.get(m.group(1)) or MESES.get(m.group(1)[:3])
        if mes and 2000 <= int(m.group(2)) <= 2099:
            return f"{m.group(2)}-{mes:02d}-01"
    return None


def parse_data(s: str) -> str | None:
    m = RE_DATA.search(s)
    if m and 1 <= int(m.group(2)) <= 12 and 1 <= int(m.group(1)) <= 31 and 2000 <= int(m.group(3)) <= 2099:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    return None


def parse_dinheiro(s: str) -> float | None:
    ms = RE_DINHEIRO.findall(s)
    if not ms:
        return None
    return float(ms[-1].replace(".", "").replace(",", "."))


def parse_int(s: str) -> int | None:
    if re.search(r"\d{1,2}[/.]\d{1,2}[/.]\d{2}", s or ""):  # data inteira ("31/05/2026") não é contagem de dias
        return None
    m = RE_INT.search(s)
    return int(m.group(1)) if m else None


def parse_nf(s: str) -> str | None:
    m = re.search(r"(\d[\d.]{3,}\d)", s)
    if not m:
        return None
    dig = re.sub(r"\D", "", m.group(1))
    return dig if 4 <= len(dig) <= 12 else None


PARSER = {"uc": parse_uc, "cliente": parse_uc, "mes": parse_mesano, "vencimento": parse_data, "emissao": parse_data,
          "nf": parse_nf, "total": parse_dinheiro, "dias": parse_int, "leit_ant": parse_data, "leit_atu": parse_data}

# ─── rótulos (texto normalizado; ordem = prioridade) ──────────────────────────
ROTULOS = {
    "uc": [
        r"\bn[o.º]*\s*da\s+unidade\s+consumidora\b", r"\bnumero\s+da\s+uc\b", r"\bn[o.º]*\s*da\s+uc\b",
        r"^unidade\s+consumidora\b", r"\bcodigo\s+da\s+instalacao\b", r"\bnumero\s+da\s+instalacao\b",
        r"\bn[o.º]*\s*da\s+instalacao\b", r"\binstalacao\s*/\s*unid", r"\binstalacao\s*:", r"^instalacao$",
        r"\bseu\s+codigo\b", r"\bcodigo\s+unico\b", r"^uc$", r"^uc\s*[:/]",
    ],
    "cliente": [r"\bcodigo\s+do\s+cliente\b", r"\bn[o.º]*\s*do\s+cliente\b", r"\bconta\s+contrato\b", r"\bparceiro\s+de\s+negocio\b", r"\bcod\.?\s*cliente\b"],
    "mes": [r"\breferente\s+a\b", r"\bref\.?\s*:?\s*mes\s*/\s*ano\b", r"\bconta\s+mes\b", r"\bconta\s+do\s+mes\b",
            r"\bmes\s*/\s*ano\b", r"\bmes\s+faturado\b", r"\bmes\s+de\s+referencia\b", r"\bcompetencia\b", r"^referencia$"],
    "vencimento": [r"\bdata\s+de\s+vencimento\b", r"\bvencimento\b"],
    "emissao": [r"\bdata\s+(de\s+)?emiss[aã]o\b", r"\bemiss[aã]o\s*:", r"^emiss[aã]o\b"],
    "nf": [r"\bnota\s+fiscal\s*(n[o.º]*|numero)", r"\bn[o.º]*\s*da\s+nota\s+fiscal\b", r"\bnota\s+fiscal/conta[^0-9]*n[o.º]*", r"^nota\s+fiscal$"],
    "total": [r"\btotal\s+a\s+pagar\b", r"\bvalor\s+total\s+a\s+pagar\b", r"\bvalor\s+a\s+pagar\b", r"\bvalor\s+da\s+conta\b", r"\bvalor\s+cobrado\b", r"^total\s*\(r\$\)"],
    "dias": [r"\bn[o.º]*\s*de\s+dias\b", r"\bn[o.º]*\s*dias\b", r"\bdias\s+do\s+periodo\b", r"^dias$"],
    "leit_ant": [r"\bleitura\s+anterior\b"],
    "leit_atu": [r"\bleitura\s+atual\b"],
}
_ROTULOS_RE = {k: [re.compile(p) for p in v] for k, v in ROTULOS.items()}
_IGNORAR = re.compile(r"fatura do mes|arrecadad|historico|demonstrativ|saldo|conforme ren|aneel|\bcep\b")
_IGNORAR_TIPO = {"mes": re.compile(r"proxima leitura|leitura proximo|consumo faturado"), "dias": re.compile(r"proxima leitura|leitura proximo")}
SO_PAGINA_1 = {"uc", "cliente", "mes", "vencimento", "total", "dias", "leit_ant", "leit_atu"}


def _tokens_com_x(it: Item) -> list[tuple[str, float]]:
    """Pedaços da linha com x aproximado pela posição do caractere (linhas de tabela vêm juntas no liteparse)."""
    out = []
    n = max(len(it.text), 1)
    for m in re.finditer(r"[^\s|]+(?: [^\s|]+)*", it.text):
        out.append((m.group(0), it.x + it.w * m.start() / n))
    return out


def _por_rotulo(itens: list[Item], tipo: str, modos=("mesma linha", "abaixo", "direita")):
    """Acha o rótulo e lê o valor: na própria linha, na linha logo abaixo (mesma coluna) ou à direita."""
    universo = [i for i in itens if i.page == 0] if tipo in SO_PAGINA_1 else itens
    for rx in _ROTULOS_RE[tipo]:
        for it in universo:
            m = rx.search(it.norm)
            if not m or _IGNORAR.search(it.norm) or (tipo in _IGNORAR_TIPO and _IGNORAR_TIPO[tipo].search(it.norm)):
                continue
            n = max(len(it.norm), 1)
            x_rot = it.x + it.w * m.start() / n
            if it.norm.rstrip().endswith(":") and modos == ("mesma linha", "abaixo", "direita"):
                modos = ("mesma linha", "direita", "abaixo")  # "Data de Emissão:" → valor ao lado, não embaixo
            if "mesma linha" in modos:
                resto = it.text[int(len(it.text) * m.end() / n):]
                v = PARSER[tipo](resto)
                if v is not None:
                    return v, f"rotulo:{it.text[:40]}|mesma linha"
            for modo in [m_ for m_ in modos if m_ != "mesma linha"]:
              if modo == "abaixo":
                cand = []
                for o in universo:
                    if o.page != it.page or o is it:
                        continue
                    dy = o.y - it.y
                    if dy <= it.h * 0.5 or dy > it.h * 4.5 + 12:
                        continue
                    if o.x > it.x + it.w + 24 or o.x + o.w < it.x - 24:
                        continue
                    cand.append((dy, o))
                # a linha logo abaixo inteira (itens com dy até ~0,8 altura do mais próximo), e nela o token mais perto
                # da coluna do rótulo. Antes valia o 1º item da lista: no OCR as caixas da mesma linha variam 1-2 px e
                # "Leitura atual | anterior | Nº de dias" pegava a data anterior para os três (CPFL Paulista 553359).
                validos = []
                for dy, o in cand:
                    for tok, tx in _tokens_com_x(o):
                        v = PARSER[tipo](tok)
                        if v is not None:
                            validos.append((dy, abs(tx - x_rot), v))
                if validos:
                    dy0 = min(c[0] for c in validos)
                    faixa = [c for c in validos if c[0] <= dy0 + max(it.h * 0.8, 4)]
                    return min(faixa, key=lambda c: c[1])[2], f"rotulo:{it.text[:40]}|abaixo"
              elif modo == "direita":
                for o in universo:
                    if o.page != it.page or o is it or abs(o.y - it.y) > it.h * 0.7:
                        continue
                    if o.x < it.x + it.w or o.x - (it.x + it.w) > 160:
                        continue
                    v = PARSER[tipo](o.text)
                    if v is not None:
                        return v, f"rotulo:{it.text[:40]}|direita"
    return None


# ─── cabeçalho em fonte grande ────────────────────────────────────────────────
def _linhas_grandes(itens: list[Item], ph: float) -> list[tuple[float, float, str, list[Item]]]:
    """Linhas (agrupadas por y) feitas só dos itens de fonte grande do topo da página 1: (y, h, texto, itens)."""
    p1 = [i for i in itens if i.page == 0]
    if len(p1) < 10:
        return []
    med = statistics.median(i.h for i in p1)
    topo = sorted([i for i in p1 if i.y < ph * 0.45 and i.h >= 1.25 * med], key=lambda i: (i.y, i.x))
    linhas: list[list[Item]] = []
    for it in topo:
        if linhas and abs(linhas[-1][0].y - it.y) < max(it.h, linhas[-1][0].h) * 0.6:
            linhas[-1].append(it)
        else:
            linhas.append([it])
    out = []
    for grupo in linhas:
        grupo.sort(key=lambda g: g.x)
        texto, fim = "", None
        for g in grupo:  # pedaços colados (ex.: "R$11" + ".108,09") viram um só
            if fim is not None and g.x - fim > 3:
                texto += " | "
            texto += g.text
            fim = g.x + g.w
        out.append((grupo[0].y, max(g.h for g in grupo), texto, grupo))
    return out


def _cabecalho(itens: list[Item], ph: float) -> dict:
    """UC, mês, vencimento e total pelos valores em destaque no topo da página 1."""
    out: dict = {}
    ucs: list[tuple[float, float, str]] = []  # (h, y, valor)
    y_mes = y_total = None
    datas_soltas: list[tuple[float, str]] = []  # (y, data) de linhas que são só uma data
    for y, h, texto, grupo in _linhas_grandes(itens, ph):
        ntexto = normalizar(texto)
        if re.search(r"pagina|p[aá]g\.|\bvia\b|cep", ntexto):
            continue
        pedacos = [p.strip() for p in texto.split("|") if p.strip()]
        dinheiro = [(i, parse_dinheiro(p)) for i, p in enumerate(pedacos) if parse_dinheiro(p) is not None and ("r$" in normalizar(p) or parse_dinheiro(p) >= 1.0)]
        datas = [(i, parse_data(p)) for i, p in enumerate(pedacos) if parse_data(p) and "emiss" not in normalizar(p)]
        datas_puras = [(i, v) for i, v in datas if RE_DATA.fullmatch(pedacos[i].strip())]
        mes = next((parse_mesano(p) for p in pedacos if parse_mesano(p) and not RE_DATA.search(p)), None)
        if mes and "mes" not in out:
            out["mes"] = (mes, f"destaque:{texto[:40]}")
            y_mes = y
        if len(pedacos) == 1 and RE_DATA.fullmatch(pedacos[0].strip()):
            datas_soltas.append((y, parse_data(pedacos[0])))
        if dinheiro and "total" not in out:
            i_din, v = dinheiro[0]
            out["total"] = (v, f"destaque:{texto[:40]}")
            y_total = y
            antes = [d for d in datas if d[0] < i_din]
            if antes and "vencimento" not in out:  # vencimento = a data imediatamente antes do valor
                out["vencimento"] = (antes[-1][1], f"destaque:{texto[:40]}")
        elif mes and len(datas_puras) == 1 and "vencimento" not in out:
            out["vencimento"] = (datas_puras[0][1], f"destaque:{texto[:40]}")
        # identificadores "puros" (o item é só o número). O liteparse parte números grandes em dois itens
        # ("1.081" + ".866.036-84", CPFL): junta o pedaço que começa com ./,/- ao anterior quando o gap é mínimo
        juntos: list[tuple[str, float, float]] = []  # (texto, h, y)
        x_fim_ant = None
        for g in sorted(grupo, key=lambda i: i.x):
            t = g.text.strip()
            if juntos and t[:1] in ".,-" and re.search(r"\d$", juntos[-1][0]) and x_fim_ant is not None and g.x - x_fim_ant < 3:
                juntos[-1] = (juntos[-1][0] + t, max(juntos[-1][1], g.h), juntos[-1][2])
            else:
                juntos.append((t, g.h, g.y))
            x_fim_ant = g.x + g.w
        for t, gh, gy in juntos:
            v_uc = parse_uc(t) if RE_ID_PURO.match(t) else None
            if v_uc and 6 <= len(re.sub(r"\D", "", v_uc)) <= 15 and not RE_DATA.search(t) and not re.fullmatch(r"\d{2}/\d{4}", t):
                ucs.append((gh, gy, v_uc))
    if "vencimento" not in out and y_mes is not None and y_total is not None:  # quadros empilhados: mês, vencimento, total
        lo, hi = min(y_mes, y_total), max(y_mes, y_total)
        entre = [d for yy, d in datas_soltas if lo < yy < hi]
        if len(entre) == 1:
            out["vencimento"] = (entre[0], "destaque:entre mês e total")
    if ucs:
        hmax = max(u[0] for u in ucs)
        maiores = [u for u in ucs if u[0] >= hmax * 0.9]
        maiores.sort(key=lambda u: u[1])
        out["uc"] = (maiores[-1][2], "destaque:maior fonte")
        out["_uc_candidatos"] = [u[2] for u in sorted(ucs, key=lambda u: u[1])]
    return out


RE_DIAS_GRUDADO = re.compile(r"^n\W{0,2}\s*(?:de\s*)?dias\s*:?\s*(\d{2})$")


def _dias_por_leituras(itens: list[Item]) -> tuple[int, str] | None:
    """Linha das datas de leitura (anterior, atual, próxima) com um inteiro 15-45 entre elas = nº de dias."""
    for i in itens:  # OCR junta rótulo e número numa caixa só: "N°DEDIAS30" (Coelba escaneada)
        g = RE_DIAS_GRUDADO.match(normalizar(i.text)) if i.page == 0 else None
        if g and 15 <= int(g.group(1)) <= 45:
            return int(g.group(1)), "rótulo grudado no número"
    linhas = collections.defaultdict(list)
    for i in itens:
        if i.page == 0:
            linhas[round(i.y / 3)].append(i)
    for _, grupo in sorted(linhas.items()):
        texto = " ".join(g.text for g in sorted(grupo, key=lambda g: g.x))
        if re.search(r"\d{7,}", texto):
            continue
        datas = RE_DATA_CURTA.findall(texto)
        if not (2 <= len(datas) <= 4):
            continue
        sem = RE_DATA_CURTA.sub(" ", texto)
        ints = [int(x) for x in re.findall(r"(?<![\w.,/:\-])(\d{2})(?![\w.,/%:\-])", sem)]
        ints = [x for x in ints if 15 <= x <= 45]
        if len(ints) == 1:
            return ints[0], "linha das leituras"
    return None


def _dias_por_periodo(itens: list[Item]) -> tuple[int, str] | None:
    """Linha com 'leitura' ou 'período' e duas datas completas: dias = diferença (15 a 45)."""
    import datetime as _dt
    linhas = collections.defaultdict(list)
    for i in itens:
        if i.page == 0:
            linhas[round(i.y / 3)].append(i)
    for _, grupo in sorted(linhas.items()):
        texto = " ".join(g.text for g in sorted(grupo, key=lambda g: g.x))
        if not re.search(r"leitura|periodo", normalizar(texto)):
            continue
        # a data da PRÓXIMA leitura não é do período faturado (Coelba OCR: 'atual 30/04 + próxima 31/05' dava 31)
        texto = re.sub(r"(?i)pr[oó]xima\s*leitura\W*\d{2}[/.]\d{2}[/.]\d{4}", " ", texto)
        ds = [parse_data(m.group(0)) for m in RE_DATA.finditer(texto)]
        ds = [d for d in ds if d]
        if len(ds) >= 2:
            try:
                dd = (_dt.date.fromisoformat(ds[1]) - _dt.date.fromisoformat(ds[0])).days
                if 15 <= dd <= 45:
                    return dd, "diferença das datas de leitura"
            except Exception:
                pass
    return None


# ─── distribuidora e tipo de documento ────────────────────────────────────────
def _montar(raiz: str, cnpj: str | None, origem: str) -> dict:
    c = catalogo()[raiz]
    return {"nome": c["nome"], "sigla": c["sigla"], "uf": c["uf"], "grupo": c["grupo"], "mapa": c.get("mapa"),
            "cnpj": cnpj, "raiz": raiz, "origem": origem}


def distribuidora_de(itens: list[Item], texto_total: str) -> dict:
    cat = catalogo()
    for it in itens:  # 1) CNPJ completo, do topo para baixo
        for m in RE_CNPJ.finditer(it.text):
            raiz = "".join(m.group(i) for i in (1, 2, 3))
            if raiz in cat:
                return _montar(raiz, f"{m.group(1)}.{m.group(2)}.{m.group(3)}/{m.group(4)}-{m.group(5)}", "cnpj")
    # 2) chave de acesso da NF3e: dígitos 7-20 = CNPJ da emissora
    colado = re.sub(r"(?<=\d)[ .\-](?=\d)", "", texto_total)
    for m in RE_CHAVE.finditer(colado):
        ch = m.group(1)
        raiz = ch[6:14]
        if raiz in cat:
            cnpj = f"{ch[6:8]}.{ch[8:11]}.{ch[11:14]}/{ch[14:18]}-{ch[18:20]}"
            return _montar(raiz, cnpj, "chave nf3e")
    n = normalizar(texto_total)
    for raiz, c in cat.items():  # 3) nome completo/alias no texto
        for a in c.get("aliases") or []:
            if len(a) > 6 and normalizar(a) in n:
                return _montar(raiz, None, f"alias:{a}")
    grupos = collections.defaultdict(list)  # 4) nome do grupo + UF do texto
    for raiz, c in cat.items():
        grupos[normalizar(c["grupo"])].append(raiz)
    ufs = collections.Counter(re.findall(rf"\b({UFS})\b", texto_total))
    for g, raizes in grupos.items():
        if not re.search(rf"\b{re.escape(g)}" + (r"\b" if len(g) < 4 else ""), n):
            continue
        if len(raizes) == 1:
            return _montar(raizes[0], None, f"grupo:{g}")
        for uf, _ in ufs.most_common():
            for r in raizes:
                if cat[r]["uf"] == uf:
                    return _montar(r, None, f"grupo:{g}+uf:{uf}")
        return {"nome": cat[raizes[0]]["grupo"], "sigla": None, "uf": None, "grupo": cat[raizes[0]]["grupo"],
                "mapa": cat[raizes[0]].get("mapa"), "cnpj": None, "raiz": None, "origem": f"grupo:{g} (empresa incerta)"}
    return {}


def classificacao_de(texto: str) -> dict:
    n = normalizar(texto)
    n = re.sub(r"bandeira[^.|\n]{0,60}|band\.? ?tarif[^.|\n]{0,40}", " ", n)
    out: dict = {}
    m = re.search(r"(?:grupo|subgrupo|classific|tarif|modalidade)[^\n]{0,80}?(?<![a-z0-9])(a3a|a4|a3|a2|a1|as|b1|b2|b3|b4)(?![0-9a-z])", n)
    if not m:
        m = re.search(r"(?<![a-z0-9])(a3a|a4|b3|b2|b1|b4)(?![0-9a-z])", n[:3000])
    if m:
        out["subgrupo"] = m.group(1).upper()
        out["grupo"] = out["subgrupo"][0]
    else:
        mt = re.search(r"tens[a]o nominal[^0-9]{0,25}(\d{2,5})", n)
        if re.search(r"baixa tens[a]o", n) or (mt and int(mt.group(1)) < 2300):
            out["grupo"] = "B"
        elif mt and int(mt.group(1)) >= 2300:
            out["grupo"] = "A"
        elif re.search(r"demanda (contratada|ativa|faturada)|d\. ctda|hora ponta|fora ponta", n):
            out["grupo"] = "A"
    m = re.search(r"(?:modalidade|tarif|horo|ths|classific|grupo)[^\n]{0,60}?\b(verde|azul|convencional|branca)\b", n[:5000])
    if not m:
        m = re.search(r"_(vd|az)\b", n[:5000])
        if m:
            out["modalidade"] = {"vd": "Verde", "az": "Azul"}[m.group(1)]
    else:
        out["modalidade"] = m.group(1).capitalize()
    if out.get("grupo") == "B":
        out["modalidade"] = "Branca" if re.search(r"(?:modalidade|tarif)[^\n]{0,40}?\bbranca\b", n[:5000]) else "Convencional"
    elif "modalidade" not in out:
        m = re.search(r"\b(convencional|azul|branca|verde)\b", n[:4000])
        if m:
            out["modalidade"] = m.group(1).capitalize()
    out["mercado_livre"] = bool(re.search(r"\blivre\b|\bacl\b|energia adquirida|comercializad", n[:6000]))
    out["geracao_distribuida"] = bool(re.search(r"scee|compensa|injetad|geracao distribu|micro ?gera|minigera", n))
    return out


# ─── entrada principal ────────────────────────────────────────────────────────
def identificar(pdf_bytes: bytes) -> dict:
    """Campos de identificação lidos pelos quadros, com a origem de cada um em `_origem`."""
    itens, pw, ph = itens_do_pdf(pdf_bytes)
    texto = "\n".join(i.text for i in itens)
    out: dict = {"_origem": {}}
    if len([i for i in itens if i.page == 0]) < 5:
        out["tipo_documento"] = "sem_texto"
        return out
    dist = distribuidora_de(itens, texto)
    if dist:
        out["distribuidora"] = dist["nome"]
        out["distribuidora_sigla"] = dist["sigla"]
        out["distribuidora_uf"] = dist["uf"]
        out["distribuidora_grupo"] = dist["grupo"]
        out["distribuidora_cnpj"] = dist["cnpj"]
        out["mapa_sugerido"] = dist.get("mapa")
        out["_origem"]["distribuidora"] = dist["origem"]
    n = normalizar(texto)
    eh_fatura = bool(dist) or bool(re.search(r"danf3e|danfe|nota fiscal|conta de energia|unidade consumidora", n))
    out["tipo_documento"] = "fatura" if eh_fatura else "outro"

    cab = _cabecalho(itens, ph)
    # UC: rótulo na mesma linha (preciso) > destaque do cabeçalho > rótulo abaixo/direita
    r = _por_rotulo(itens, "uc", modos=("mesma linha",))
    if r is None and "uc" in cab:
        r = cab["uc"]
    if r is None:
        r = _por_rotulo(itens, "uc", modos=("abaixo", "direita"))
    if r is not None:
        out["uc"], out["_origem"]["uc"] = r
    if cab.get("_uc_candidatos"):
        out["uc_candidatos"] = cab["_uc_candidatos"]
    for campo in ("cliente", "emissao", "nf", "leit_ant", "leit_atu"):
        r = _por_rotulo(itens, campo)
        if r is not None:
            out[campo], out["_origem"][campo] = r
    for campo in ("mes", "vencimento", "total"):  # destaque do cabeçalho > rótulo
        if campo in cab:
            out[campo], out["_origem"][campo] = cab[campo]
        else:
            r = _por_rotulo(itens, campo)
            if r is not None:
                out[campo], out["_origem"][campo] = r
    d = _dias_por_leituras(itens)
    if d is None:
        d = _por_rotulo(itens, "dias")
    if d is None:
        d = _dias_por_periodo(itens)
    if d is None and out.get("leit_ant") and out.get("leit_atu"):
        try:
            import datetime as _dt
            dd = (_dt.date.fromisoformat(out["leit_atu"]) - _dt.date.fromisoformat(out["leit_ant"])).days
            if 0 < dd < 70:
                d = (dd, "calculado:leituras")
        except Exception:
            pass
    if d is not None:
        out["dias"], out["_origem"]["dias"] = d
    if out.get("cliente") and out.get("uc") and re.sub(r"\D", "", str(out["cliente"])) == re.sub(r"\D", "", str(out["uc"])):
        out.pop("cliente")
    out["classificacao"] = classificacao_de(texto)
    return out


# ─── integração com o pdf_pipeline ────────────────────────────────────────────
def _br(iso: str | None) -> str | None:
    """'AAAA-MM-DD' → 'DD/MM/AAAA'."""
    if not iso or len(iso) < 10:
        return None
    return f"{iso[8:10]}/{iso[5:7]}/{iso[0:4]}"


def aplicar_identificacao(v2_out: dict, pdf_bytes: bytes) -> dict:
    """Lê a identificação pelos quadros e sobrescreve, no v2_out do extrator, os campos que achou.
    Guarda tudo em v2_out['_identificacao'] (valores + origem) para rastreio. Nunca levanta exceção."""
    try:
        ident = identificar(pdf_bytes)
    except Exception as e:  # pragma: no cover
        v2_out["_identificacao"] = {"erro": str(e)[:200]}
        return v2_out
    v2_out["_identificacao"] = ident
    v2_out["_tipo_documento"] = ident.get("tipo_documento")
    if ident.get("distribuidora"):
        d = v2_out.setdefault("distribuidora", {})
        d["razao_social"] = ident["distribuidora"]
        if ident.get("distribuidora_cnpj"):
            d["cnpj_emissor"] = ident["distribuidora_cnpj"]
        if ident.get("distribuidora_uf"):
            d["uf_emissor"] = ident["distribuidora_uf"]
    if ident.get("uc"):
        ii = v2_out.setdefault("identificadores_instalacao", {})
        ii["uc_codigo"] = ident["uc"]
        ii["codigo_instalacao"] = ident["uc"]
        if ident.get("cliente"):
            ii["codigo_cliente"] = ident["cliente"]
    vv = v2_out.setdefault("vencimento_valor", {})
    if ident.get("mes"):
        vv["mes_ref"] = f"{ident['mes'][5:7]}/{ident['mes'][0:4]}"
    if ident.get("vencimento"):
        vv["data_vencimento"] = _br(ident["vencimento"])
    if ident.get("total") is not None:
        vv["valor_total"] = ident["total"]
    nf = v2_out.setdefault("nota_fiscal", {})
    if ident.get("nf"):
        nf["numero_nf"] = ident["nf"]
    if ident.get("emissao"):
        nf["data_emissao"] = _br(ident["emissao"])
    if ident.get("dias"):
        v2_out.setdefault("periodo_leitura", {})["dias_consumo"] = ident["dias"]
    cl = ident.get("classificacao") or {}
    lt = v2_out.setdefault("ligacao_tecnica", {})
    if cl.get("subgrupo"):
        lt["subgrupo"] = cl["subgrupo"]
    elif cl.get("grupo") and not lt.get("subgrupo"):
        lt["subgrupo"] = cl["grupo"]
    if cl.get("modalidade"):
        lt["modalidade_tarifaria"] = cl["modalidade"]
    return v2_out


def _principal(argv):
    for a in argv:
        r = identificar(Path(a).read_bytes())
        print(Path(a).name)
        for k, v in r.items():
            if k != "_origem":
                print(f"  {k} = {v}")
        for k, v in r["_origem"].items():
            print(f"    ({k} <- {v})")


if __name__ == "__main__":
    _principal(sys.argv[1:])
