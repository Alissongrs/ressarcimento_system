#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dossie_fatura_png.py — páginas da fatura em PNG, com MARCA-TEXTO nos valores citados no apontamento.
Usado pelo dossiê dos apontamentos de energia (backend/handlers/dossie_energia.go).

Uso:  python dossie_fatura_png.py <fatura.pdf> <pasta_saida> <termos.json> [max_paginas=4] [dpi=110]
      termos.json = ["1.234", "89,88", "15/03/2026", ...]
Saída (stdout, JSON): {"paginas": ["<pasta>/p1.png", ...], "achados": {"89,88": [1], ...}, "total_paginas": N}
Não acessa rede nem banco. PDF só com senha de permissão (comum nas distribuidoras) abre com senha vazia.
"""
import json
import os
import sys

import fitz  # PyMuPDF


def main():
    pdf, saida, termos_json = sys.argv[1], sys.argv[2], sys.argv[3]
    max_pag = int(sys.argv[4]) if len(sys.argv) > 4 else 4
    dpi = int(sys.argv[5]) if len(sys.argv) > 5 else 110
    with open(termos_json, encoding="utf-8") as f:
        termos = [t for t in json.load(f) if isinstance(t, str) and len(t.strip()) >= 3]
    doc = fitz.open(pdf)
    if doc.needs_pass:
        doc.authenticate("")
    os.makedirs(saida, exist_ok=True)
    achados, paginas = {}, []
    for i, page in enumerate(doc):
        if i >= max_pag:
            break
        for t in termos:
            try:
                rects = page.search_for(t)
            except Exception:  # noqa: BLE001 — termo esquisito não derruba o dossiê
                rects = []
            for r in rects[:6]:
                a = page.add_highlight_annot(r)
                a.set_colors(stroke=(1, 0.85, 0))
                a.update()
            if rects:
                achados.setdefault(t, []).append(i + 1)
        pix = page.get_pixmap(dpi=dpi, annots=True)
        caminho = os.path.join(saida, f"p{i + 1}.png")
        pix.save(caminho)
        paginas.append(caminho)
    print(json.dumps({"paginas": paginas, "achados": achados, "total_paginas": doc.page_count}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"erro": str(e)[:300]}, ensure_ascii=False))
        sys.exit(1)
