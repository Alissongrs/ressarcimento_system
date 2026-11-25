# -*- coding: utf-8 -*-
"""Códigos impressos lidos da IMAGEM da fatura (24/11/2026): código de barras do boleto (ITF, 44 dígitos), QR da
SEFAZ (chave de acesso) e QR PIX (valor). Não dependem da camada de texto nem do OCR: num scan ruim o OCR troca
dígitos, o leitor de código de barras não — e cada código traz o próprio dígito verificador/CRC.

zxing-cpp (Apache 2.0). Sem o pacote instalado, ler() devolve [] e o pipeline segue como antes.
"""
from __future__ import annotations

import hashlib

import boleto

_CACHE: dict[str, list] = {}


def ler(pdf_bytes: bytes | None, max_paginas: int = 2) -> list[tuple[str, str, int]]:
    """[(formato, texto, página)] de todos os códigos das primeiras páginas (cinza, zoom 2; zoom 3 se nada)."""
    if not pdf_bytes:
        return []
    k = hashlib.sha1(pdf_bytes).hexdigest()
    if k in _CACHE:
        return list(_CACHE[k])
    out: list[tuple[str, str, int]] = []
    try:
        import fitz
        import numpy as np
        import zxingcpp
        with fitz.open(stream=pdf_bytes, filetype="pdf") as d:
            for pg in list(d)[:max_paginas]:
                for z in (2, 3):
                    pix = pg.get_pixmap(matrix=fitz.Matrix(z, z), colorspace=fitz.csGRAY)
                    img = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w)
                    rs = zxingcpp.read_barcodes(img)
                    if rs:
                        out += [(str(r.format).split(".")[-1].replace(" ", ""), r.text, pg.number) for r in rs]
                        break
    except Exception:  # noqa: BLE001  (sem zxing-cpp, PDF quebrado)
        out = []
    if len(_CACHE) > 64:
        _CACHE.clear()
    _CACHE[k] = list(out)
    return out


def valores(cods: list[tuple[str, str, int]], vencimento=None, estrito: bool = True) -> set[float]:
    """Valores conferidos: barras (DV + fator = vencimento; estrito=False dispensa o fator) e PIX (CRC)."""
    vals: set[float] = set()
    for fmt, txt, _ in cods:
        v = boleto.valor_barras(txt, vencimento, estrito) if fmt == "ITF" else boleto.valor_pix(txt) if fmt == "QRCode" else None
        if v is not None and v > 0:
            vals.add(round(v, 2))
    return vals


def chave(cods: list[tuple[str, str, int]]) -> str | None:
    """Chave de acesso do QR da SEFAZ, com DV conferido; None se nenhuma ou mais de uma diferente."""
    ch = {c for fmt, txt, _ in cods if fmt == "QRCode" for c in [boleto.chave_nf3e(txt)] if c}
    return ch.pop() if len(ch) == 1 else None
