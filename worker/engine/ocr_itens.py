# -*- coding: utf-8 -*-
"""OCR posicionado de PDF só imagem com RapidOCR (modelos do PaddleOCR em ONNX, CPU, gratuito).

Renderiza cada página (zoom 3 ≈ 216 dpi), reconhece as caixas de texto e devolve linhas posicionadas em pontos
do PDF no mesmo formato que identificacao.itens_do_pdf usa ({text, x, y, w, h, page}). Caixas vizinhas na mesma
linha são juntadas quando o espaço entre elas é pequeno (menor que 1,5 altura), para rótulos de várias palavras
("Data de Emissão:") ficarem num item só, como no liteparse; colunas de tabela ficam separadas.

No pipeline (PDF_PIPELINE_NO_OCR != 1) é o OCR das faturas sem camada de texto: identificacao.itens_do_pdf pede as
linhas posicionadas (etapas 1 e 2) e pdf_pipeline.extrair_ocr pede o texto corrido (itens da fatura pelo extrator_v2).
O resultado da última fatura fica em cache (sha1 do PDF), porque as duas chamadas e a medição pedem o mesmo PDF.
Sem o pacote (rapidocr_onnxruntime) as duas caem no Tesseract, como antes.

Uso:  python ocr_itens.py fatura.pdf [--json saida.json] [--paginas 3] [--zoom 3]
      python ocr_itens.py --lote pasta_pdfs pasta_json          (um JSON por PDF, nome = <pdf>.itens.json)
Como módulo:  itens, pw, ph = ocr_itens.itens_rapidocr(pdf_bytes, max_paginas)  → lista de dicts
              texto = ocr_itens.texto_rapidocr(pdf_bytes, max_paginas)           → linhas (uma por linha visual)
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

_ENGINE = None
_CACHE: dict = {}  # sha1(pdf)[:16]:zoom → (itens, pw, ph, páginas lidas) da última fatura (uma entrada só)
MAX_PAGINAS = int(os.getenv("SURE_OCR_PAGINAS", "3"))


def disponivel() -> bool:
    """True se o pacote rapidocr_onnxruntime importa (não carrega os modelos)."""
    try:
        import rapidocr_onnxruntime  # noqa: F401
        return True
    except Exception:
        return False


def _motor():
    global _ENGINE
    if _ENGINE is None:
        from rapidocr_onnxruntime import RapidOCR
        _ENGINE = RapidOCR()
    return _ENGINE


def itens_rapidocr(pdf_bytes: bytes, max_paginas: int = 3, zoom: float = 3.0) -> tuple[list[dict], float, float]:
    """OCR de até max(max_paginas, MAX_PAGINAS) páginas, uma vez por PDF: a identificação pede 2 páginas, a medição e o
    texto corrido pedem 3 — o cache guarda o lote maior e devolve só as páginas pedidas."""
    import hashlib
    chave = hashlib.sha1(pdf_bytes).hexdigest()[:16] + f":{zoom:g}"
    pags = max(int(max_paginas), MAX_PAGINAS)
    ent = _CACHE.get(chave)
    if ent is None or ent[3] < pags:
        itens, pw, ph = _itens_rapidocr(pdf_bytes, pags, zoom)
        _CACHE.clear()
        ent = _CACHE[chave] = ([dict(i) for i in itens], pw, ph, pags)
    return [dict(i) for i in ent[0] if i["page"] < max_paginas], ent[1], ent[2]


def texto_rapidocr(pdf_bytes: bytes, max_paginas: int = 3) -> list[str]:
    """Texto corrido do OCR: uma string por linha visual (itens da mesma linha, em ordem de x, separados por
    dois espaços), página a página — o que o pdf_pipeline guarda em texto_ocr e o extrator_v2 lê."""
    itens, _, _ = itens_rapidocr(pdf_bytes, max_paginas)
    linhas: list[str] = []
    atual: list[dict] = []
    for it in sorted(itens, key=lambda i: (i["page"], i["y"], i["x"])):
        if atual and atual[0]["page"] == it["page"] and abs(atual[0]["y"] - it["y"]) <= max(atual[0]["h"], it["h"]) * 0.6:
            atual.append(it)
        else:
            if atual:
                linhas.append("  ".join(i["text"] for i in sorted(atual, key=lambda i: i["x"])))
            atual = [it]
    if atual:
        linhas.append("  ".join(i["text"] for i in sorted(atual, key=lambda i: i["x"])))
    return linhas


def _itens_rapidocr(pdf_bytes: bytes, max_paginas: int, zoom: float) -> tuple[list[dict], float, float]:
    import fitz
    import numpy as np
    d = fitz.open(stream=pdf_bytes, filetype="pdf")
    if d.is_encrypted and not d.authenticate(""):
        raise ValueError("PDF protegido por senha")
    motor = _motor()
    itens: list[dict] = []
    pw, ph = 0.0, 0.0
    for pi, pg in enumerate(d):
        if pi >= max_paginas:
            break
        if pi == 0:
            pw, ph = float(pg.rect.width), float(pg.rect.height)
        pix = pg.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        if pix.n == 4:
            img = img[:, :, :3]
        res, _ = motor(img)
        caixas = []
        for box, texto, score in (res or []):
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            x0, x1, y0, y1 = min(xs) / zoom, max(xs) / zoom, min(ys) / zoom, max(ys) / zoom
            t = (texto or "").strip()
            if t:
                caixas.append({"text": t, "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0, "score": float(score)})
        # junta caixas vizinhas na mesma linha (gap < 1,5 × altura) — rótulos de várias palavras
        caixas.sort(key=lambda c: (round(c["y"] / 3), c["x"]))
        for c in caixas:
            u = itens[-1] if itens and itens[-1]["page"] == pi else None
            if u and abs(u["y"] - c["y"]) <= max(u["h"], c["h"]) * 0.6 and 0 <= c["x"] - (u["x"] + u["w"]) < 1.5 * max(u["h"], c["h"]):
                u["text"] = u["text"] + " " + c["text"]
                u["w"] = (c["x"] + c["w"]) - u["x"]
                u["h"] = max(u["h"], c["h"])
                u["y"] = min(u["y"], c["y"])
            else:
                itens.append({"text": c["text"], "x": c["x"], "y": c["y"], "w": c["w"], "h": c["h"], "page": pi})
    return itens, pw, ph


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[0] == "--lote":
        origem, destino = Path(argv[1]), Path(argv[2])
        destino.mkdir(parents=True, exist_ok=True)
        import hashlib
        for p in sorted(origem.glob("*.pdf")):
            try:
                b = p.read_bytes()
                itens, pw, ph = itens_rapidocr(b, int(_arg(argv, "--paginas", 3)))
                conteudo = json.dumps({"pw": pw, "ph": ph, "itens": itens}, ensure_ascii=False)
                (destino / (p.name + ".itens.json")).write_text(conteudo, encoding="utf-8")
                # cópia pelo hash do PDF: identificacao.itens_do_pdf acha pelo conteúdo (SURE_ITENS_OCR_DIR)
                (destino / (hashlib.sha1(b).hexdigest()[:16] + ".itens.json")).write_text(conteudo, encoding="utf-8")
                print(f"{p.name}: {len(itens)} itens", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"{p.name}: ERRO {e}", flush=True)
        return 0
    pdf = Path(argv[0]).read_bytes()
    itens, pw, ph = itens_rapidocr(pdf, int(_arg(argv, "--paginas", 3)), float(_arg(argv, "--zoom", 3)))
    saida = _arg(argv, "--json")
    if saida:
        Path(saida).write_text(json.dumps({"pw": pw, "ph": ph, "itens": itens}, ensure_ascii=False), encoding="utf-8")
    for i in itens:
        print(f"p{i['page'] + 1} y={i['y']:6.1f} x={i['x']:6.1f} h={i['h']:4.1f} | {i['text'][:90]}")
    return 0


def _arg(argv, nome, default=None):
    return argv[argv.index(nome) + 1] if nome in argv and argv.index(nome) + 1 < len(argv) else default


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
