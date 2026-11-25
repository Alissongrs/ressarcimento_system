# -*- coding: utf-8 -*-
"""Nota da camada de texto do PDF (24/11/2026).

Fatura escaneada às vezes chega com uma camada de texto INVISÍVEL feita pelo OCR de outra pessoa/sistema (Energisa MT
"SUA FATURA CHEGOU" 2021, DANF3E 2022): a imagem cobre a página toda e o texto fica por cima, invisível. O motor
tratava esse texto como camada digital e lia lixo (total 817,81 onde a fatura e o boleto dizem 882,66; leituras fora
de ordem). Aqui:

  • ocr_embutido(pdf)  — sinal estrutural: ≥90% dos caracteres invisíveis (modo de renderização 3) numa página com
                         imagem cobrindo ≥90% dela. PDF digital nunca tem isso.
  • nota(texto)        — fração das palavras (3+ letras) que existem no léxico das faturas digitais
                         (lexico_faturas.txt: palavras que aparecem em ≥8 de 3.000 faturas digitais).
                         Digitais ficam em 0,92–0,95; as camadas embutidas ruins, em 0,60–0,87.
  • avaliar(pdf)       — descartar = ocr_embutido e nota < SURE_NOTA_CAMADA (padrão 0,92): a fatura passa a ser
                         lida como escaneada (nosso OCR), como se não tivesse camada.

A nota NÃO compara camada × nosso OCR: o RapidOCR cola palavras ("GGFAGROLTDA") e perde no léxico mesmo lendo melhor
números e tabela. Ela só julga a camada embutida sozinha.
"""
from __future__ import annotations

import hashlib
import os
import re
import unicodedata

_DIR = os.path.dirname(os.path.abspath(__file__))
_LEX: set[str] | None = None
_CACHE: dict[str, dict] = {}
LIMIAR = float(os.getenv("SURE_NOTA_CAMADA", "0.92"))


def _lexico() -> set[str]:
    global _LEX
    if _LEX is None:
        try:
            with open(os.path.join(_DIR, "lexico_faturas.txt"), encoding="utf-8") as f:
                _LEX = set(f.read().split())
        except OSError:
            _LEX = set()
    return _LEX


def nota(texto: str | None) -> float | None:
    """Fração das palavras do texto que existem no léxico das faturas. None com menos de 30 palavras."""
    t = unicodedata.normalize("NFKD", texto or "").encode("ascii", "ignore").decode().lower()
    w = re.findall(r"[a-z]{3,}", t)
    lex = _lexico()
    if len(w) < 30 or not lex:
        return None
    return round(sum(x in lex for x in w) / len(w), 3)


def ocr_embutido(pdf_bytes: bytes, max_paginas: int = 2) -> bool:
    """Página com imagem cobrindo ≥90% e ≥90% dos caracteres invisíveis (texto de OCR por cima do scan)."""
    try:
        import fitz
        with fitz.open(stream=pdf_bytes, filetype="pdf") as d:
            for pg in list(d)[:max_paginas]:
                tr = pg.get_texttrace()
                n = sum(len(s["chars"]) for s in tr)
                if n < 200:
                    continue
                inv = sum(len(s["chars"]) for s in tr if s.get("type") == 3)
                if inv / n < 0.9:
                    continue
                area = pg.rect.width * pg.rect.height or 1
                for img in pg.get_images(full=True):
                    for r in pg.get_image_rects(img[0]):
                        if (r.width * r.height) / area >= 0.9:
                            return True
    except Exception:  # noqa: BLE001
        return False
    return False


def avaliar(pdf_bytes: bytes | None, max_paginas: int = 2) -> dict:
    """{'ocr_embutido', 'nota', 'descartar'}; descartar = camada de OCR embutida com nota abaixo do limiar."""
    if not pdf_bytes:
        return {"ocr_embutido": False, "nota": None, "descartar": False}
    k = hashlib.sha1(pdf_bytes).hexdigest()
    if k in _CACHE:
        return dict(_CACHE[k])
    out = {"ocr_embutido": ocr_embutido(pdf_bytes, max_paginas), "nota": None, "descartar": False}
    if out["ocr_embutido"] and os.getenv("SURE_NOTA_CAMADA_OFF", "") != "1":
        try:
            import fitz
            with fitz.open(stream=pdf_bytes, filetype="pdf") as d:
                out["nota"] = nota("\n".join(pg.get_text() for pg in list(d)[:max_paginas]))
        except Exception:  # noqa: BLE001
            pass
        out["descartar"] = out["nota"] is None or out["nota"] < LIMIAR
    if len(_CACHE) > 64:
        _CACHE.clear()
    _CACHE[k] = dict(out)
    return out
