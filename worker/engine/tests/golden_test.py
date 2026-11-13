# -*- coding: utf-8 -*-
"""Testes golden do motor de extração: cada fatura de tests/faturas/ tem de produzir os mesmos
campos que estão gravados em tests/golden/<nome>.json. Roda no CI (job "extracao-golden") e
na mão:

    python tests/golden_test.py                 # confere tudo; sai com 1 se algo mudou
    python tests/golden_test.py --so B3_18641423.pdf
    python tests/golden_test.py --atualizar     # regrava os goldens (depois de conferir que a
                                                # mudança é melhoria, não regressão!)
    python tests/golden_test.py --verbose       # mostra os campos de cada fatura

O golden é gerado no ambiente de requirements-golden.txt (sem OCR, sem SEFAZ, sem LLM), por
isso o número aqui pode diferir do banco em faturas escaneadas ou enriquecidas pela origem.
O que o teste protege é o caminho de texto: regex, mapas, extrator_v2/v3, complementos,
validador e a montagem das colunas SQL.
"""
from __future__ import annotations

import io
import json
import math
import os
import sys
import time
from pathlib import Path

AQUI = Path(__file__).resolve().parent
ENGINE = AQUI.parent
PASTA_FATURAS = AQUI / "faturas"
PASTA_GOLDEN = AQUI / "golden"
if str(ENGINE) not in sys.path:
    sys.path.insert(0, str(ENGINE))

# Chaves que variam entre execuções/ambientes e por isso NÃO entram na comparação.
VOLATEIS = {
    "texto",            # tamanho dos textos: muda com versão do liteparse/pdfplumber, não é campo
}
TOLERANCIA = 0.005      # diferença absoluta aceita entre números (centavos/arredondamento)


def _normalizar(v):
    """Deixa golden e atual comparáveis: sentinelas → None, JSON em string → objeto, etc."""
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip()
        if s in ("", "__SET_NULL__", "None", "null"):
            return None
        if s[:1] in "[{":
            try:
                return _normalizar(json.loads(s))
            except Exception:
                return s
        return s
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
        return float(v)
    if isinstance(v, dict):
        return {str(k): _normalizar(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_normalizar(x) for x in v]
    return str(v)


def _igual(a, b) -> bool:
    a, b = _normalizar(a), _normalizar(b)
    if isinstance(a, float) and isinstance(b, float):
        return abs(a - b) <= TOLERANCIA
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_igual(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_igual(x, y) for x, y in zip(a, b))
    return a == b


def _resumo(v) -> str:
    s = json.dumps(_normalizar(v), ensure_ascii=False, default=str)
    return s if len(s) <= 90 else s[:87] + "…"


def _achatar(r: dict) -> dict:
    """{mapa, layout, gate, score, n_itens, colunas.*} → dict plano de campo → valor."""
    plano = {}
    for k, v in (r or {}).items():
        if k in VOLATEIS or k == "arquivo":
            continue
        if k == "colunas" and isinstance(v, dict):
            for ck, cv in v.items():
                plano["colunas." + ck] = cv
        else:
            plano[k] = v
    return plano


def comparar(golden: dict, atual: dict) -> list[tuple[str, object, object]]:
    g, a = _achatar(golden), _achatar(atual)
    difs = []
    for k in sorted(set(g) | set(a)):
        if not _igual(g.get(k), a.get(k)):
            difs.append((k, g.get(k), a.get(k)))
    return difs


def main(argv: list[str]) -> int:
    atualizar = "--atualizar" in argv
    verbose = "--verbose" in argv
    so = {a for a in argv if not a.startswith("--")}

    import extrair_fatura as ef  # noqa: E402

    pdfs = sorted(p for p in PASTA_FATURAS.glob("*.pdf") if p.stat().st_size > 0)
    if so:
        pdfs = [p for p in pdfs if p.name in so]
    if not pdfs:
        print(f"nenhuma fatura em {PASTA_FATURAS}", file=sys.stderr)
        return 2
    PASTA_GOLDEN.mkdir(parents=True, exist_ok=True)

    ok, falhas, novos = 0, [], []
    t_total = time.time()
    for p in pdfs:
        t0 = time.time()
        atual = ef.extrair_campos(p.read_bytes(), p.name)
        dt = time.time() - t0
        gpath = PASTA_GOLDEN / (p.stem + ".json")
        if atualizar or not gpath.exists():
            with io.open(gpath, "w", encoding="utf-8") as f:
                json.dump(atual, f, ensure_ascii=False, indent=1, sort_keys=True, default=str)
            novos.append(p.name)
            print(f"{'ATUALIZADO' if atualizar else 'NOVO GOLDEN'} {p.name} ({dt:.1f}s) "
                  f"mapa={atual.get('mapa')} gate={atual.get('gate')} score={atual.get('score')}")
            continue
        golden = json.loads(gpath.read_text(encoding="utf-8"))
        difs = comparar(golden, atual)
        if difs:
            falhas.append((p.name, difs))
            print(f"FALHOU  {p.name} ({dt:.1f}s): {len(difs)} campo(s) diferente(s)")
            for k, g, a in difs:
                print(f"    {k}: golden={_resumo(g)}  atual={_resumo(a)}")
        else:
            ok += 1
            print(f"ok      {p.name} ({dt:.1f}s) mapa={atual.get('mapa')} gate={atual.get('gate')} "
                  f"score={atual.get('score')}")
        if verbose:
            for k, v in sorted(_achatar(atual).items()):
                if _normalizar(v) is not None:
                    print(f"        {k} = {_resumo(v)}")

    orfaos = sorted(g.name for g in PASTA_GOLDEN.glob("*.json")
                    if not (PASTA_FATURAS / (g.stem + ".pdf")).exists())
    print(f"\n{len(pdfs)} fatura(s) em {time.time()-t_total:.0f}s: {ok} ok, {len(falhas)} com diferença, "
          f"{len(novos)} golden(s) gravado(s)")
    if orfaos:
        print(f"aviso: golden sem PDF correspondente: {', '.join(orfaos)}")
    if falhas:
        print("\nSe a mudança for intencional (melhoria conferida na fatura), regrave com --atualizar.")
        return 1
    if novos and not atualizar:
        print("\nGoldens novos foram gravados — confira os valores contra a fatura e faça commit.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
