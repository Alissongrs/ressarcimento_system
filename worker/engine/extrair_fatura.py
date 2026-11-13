# -*- coding: utf-8 -*-
"""Extração PURA de uma fatura: bytes do PDF → campos. Sem banco, sem OCR, sem SEFAZ, sem LLM.

Percorre o MESMO caminho do pdf_pipeline.py para uma fatura com camada de texto
(pdfplumber → liteparse → bbox ordenado → extrator_v2 → cascata → complementos → coordenadas
→ validador → colunas SQL), parando antes de gravar. Serve para:
  - os testes golden do CI (tests/golden_test.py): a mesma fatura tem de dar os mesmos campos;
  - conferir uma fatura na mão:  python extrair_fatura.py fatura.pdf  [--json]

O que fica de fora de propósito (e por isso o resultado pode diferir do banco em alguns campos):
  OCR Tesseract (fatura escaneada → texto vazio), consulta SEFAZ (SKIP_SEFAZ=1), enriquecimento
  pela origem sgeeasy (precisa do uid), LLM-normaliza/auto-audit e a promoção do gate que só
  acontece ao gravar. Faturas Grupo B/A nativas (a maioria) passam inteiras.
"""
from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
if str(AQUI) not in sys.path:
    sys.path.insert(0, str(AQUI))

# Tem de vir ANTES de importar o pdf_pipeline (ele lê estas variáveis ao carregar).
os.environ.setdefault("SKIP_SEFAZ", "1")
os.environ.setdefault("PDF_PIPELINE_NO_OCR", "1")
os.environ.setdefault("PDF_PIPELINE_DIR", str(AQUI / "_work"))


def extrair_campos(pdf_bytes: bytes, nome: str = "") -> dict:
    """Retorna {arquivo, mapa, layout, gate, score, n_itens, colunas{...}, texto{...}}.

    `colunas` são as mesmas colunas SQL que o pipeline grava em FATURA_DADOS_EXTRAIDOS
    (montadas por atualizar_colunas_db._coleta_campos, sem tocar no banco).
    """
    import pdf_pipeline as pp  # noqa: E402  (carrega mapas/regex; não conecta em nada)
    from atualizar_colunas_db import _coleta_campos
    from detector_layout import detectar_layout
    from extrair_texto_bbox import extrair_texto_bbox_ordenado

    texto_plumber, _campos_regex = pp.extrair_plumber(pdf_bytes)
    texto_md = pp.extrair_markdown(pdf_bytes)
    try:
        texto_bbox = extrair_texto_bbox_ordenado(pdf_bytes) or ""
    except Exception:
        texto_bbox = ""

    payload = pp._rodar_pipeline_v3(
        None, None, 0, pdf_bytes, texto_plumber, texto_md, "",
        uid=None, force=False, texto_bbox=texto_bbox or None, dryrun=True,
    ) or {}
    v2 = payload.get("v2") if isinstance(payload, dict) else None
    if not isinstance(v2, dict):
        v2 = {}

    # Os mesmos ajustes que o caminho gravado aplica antes de montar as colunas (v3.7).
    v2["_texto_plumber"] = texto_plumber or ""
    try:
        cb = pp._coelba_tarifa_fitz(pdf_bytes)
        if cb:
            v2.setdefault("_tarifas_derivadas", {}).update(cb)
    except Exception:
        pass
    try:
        if (v2.get("subgrupo_tarifario") or "").upper().startswith("B"):
            bt = pp._tarifa_bt_fitz(pdf_bytes)
            if bt:
                v2.setdefault("_tarifas_derivadas", {}).update(bt)
    except Exception:
        pass

    try:
        colunas = _coleta_campos(v2) or {}
    except Exception as e:  # nunca derruba: o teste mostra o erro como campo
        colunas = {"_erro_colunas": str(e)[:200]}

    qualidade = v2.get("_qualidade") or {}
    texto_v2 = "\n\n".join([texto_plumber or "", texto_md or "", "", texto_bbox or ""])
    try:
        layout = detectar_layout(texto_v2, mapa_pipeline=v2.get("_mapa_usado"))
    except Exception:
        layout = None

    return {
        "arquivo": nome,
        "mapa": v2.get("_mapa_usado"),
        "layout": layout,
        "gate": qualidade.get("gate"),
        "score": qualidade.get("score"),
        "n_itens": len(v2.get("itens_fatura") or []),
        "colunas": colunas,
        "texto": {
            "plumber": len(texto_plumber or ""),
            "markdown": len(texto_md or ""),
            "bbox": len(texto_bbox or ""),
        },
    }


def extrair_arquivo(caminho: str | os.PathLike) -> dict:
    p = Path(caminho)
    return extrair_campos(p.read_bytes(), p.name)


def _principal(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    como_json = "--json" in argv
    for a in argv:
        if a.startswith("--"):
            continue
        r = extrair_arquivo(a)
        if como_json:
            print(json.dumps(r, ensure_ascii=False, indent=1, default=str))
            continue
        c = r["colunas"]
        print(f"{r['arquivo']}: mapa={r['mapa']} layout={r['layout']} gate={r['gate']} "
              f"score={r['score']} itens={r['n_itens']}")
        for k in sorted(c):
            v = c[k]
            if v not in (None, "", [], {}):
                print(f"  {k} = {str(v)[:100]}")
    return 0


if __name__ == "__main__":
    sys.exit(_principal(sys.argv[1:]))
