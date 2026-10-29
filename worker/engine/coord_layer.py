# -*- coding: utf-8 -*-
"""Coord layer — extração de ITENS de tabela colunar via coordenadas (liteparse).

Substitui o papel do `parser_coordenadas` (morto/ausente), agora usando os
`text_items` (x/y) do liteparse. É ADITIVO e GATED: só preenche itens quando o
texto linear falhou E a soma dos itens reconstruídos fecha com o total da fatura.

Auto-calibração (sem x-band manual por layout): clusteriza os valores R$ por
coluna-x e escolhe a coluna cuja SOMA ≈ total_fatura. Isso identifica a coluna de
valor E auto-valida ao mesmo tempo. DEPENDE do total (que o parser/regex entrega) —
por isso é complementar aos parsers, não substituto.

Não roda em --revalidar (precisa do PDF p/ coords). Validado em Enel CE NF3e (3/3 exato).
"""
import re

_VAL_BR = re.compile(r"^-?\d{1,3}(?:\.\d{3})*,\d{2}$")  # valor BR c/ 2 decimais
_DESC_ITEM = re.compile(
    r"Energia\s+Atv|Energia\s+Ativa|Demanda\s+Ativ|Demanda\s+de|Adicional\s+Band|"
    r"CIP|Ilum|Consumo\s+Reat|Consumo\s+(Fora\s+)?Ponta|TUSD|Ultrapassagem|Bandeira",
    re.I)


def _brl(s):
    try:
        return float(str(s).replace(".", "").replace(",", "."))
    except Exception:
        return None


def extrair_itens_coord(pdf_bytes: bytes, total_fatura: float, *, ytol: float = 4.0,
                        xtol: float = 15.0, tol_rel: float = 0.01):
    """Reconstrói itens de fatura colunar por coordenadas (liteparse).

    Args:
        pdf_bytes: bytes do PDF (precisa do arquivo p/ extrair spans x/y).
        total_fatura: total da fatura (vem do parser/regex) — âncora de calibração.
        ytol/xtol: tolerâncias de agrupamento de linha (y) e coluna (x).
        tol_rel: tolerância relativa pra Σitens ≈ total (default 1%).

    Returns:
        dict {itens: [{descricao, valor_brl}], soma, total, validado: bool, _fonte}.
        validado=True só quando Σ(coluna escolhida) ≈ total. Caller deve IGNORAR
        os itens quando validado=False (mantém o atual). Retorna None se não der
        pra processar (sem PDF, liteparse off, total ausente).
    """
    if not pdf_bytes or not total_fatura or total_fatura <= 0:
        return None
    try:
        import liteparse
        import tempfile, os
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes); _tp = tmp.name
        try:
            res = liteparse.LiteParse(quiet=True, ocr_enabled=False).parse(_tp)
        finally:
            try: os.unlink(_tp)
            except Exception: pass
    except Exception:
        return None
    items = [t for p in (res.pages or []) for t in (p.text_items or [])]
    if not items:
        return None

    # y das linhas que contêm descrição de item
    desc_ys = [(t.y, t.text.strip()) for t in items if _DESC_ITEM.search(t.text or "")]
    if not desc_ys:
        return None

    # valores R$ que caem numa linha de item: (x, valor, y)
    cands = []
    for t in items:
        tx = (t.text or "").strip()
        if _VAL_BR.match(tx):
            v = _brl(tx)
            if v is None:
                continue
            for dy, _ in desc_ys:
                if abs(t.y - dy) <= ytol:
                    cands.append((round(t.x), v, t.y)); break
    if len(cands) < 2:
        return None

    # clusteriza por coluna-x
    cands.sort(key=lambda c: c[0])
    cols, cur, x0 = [], [], None
    for x, v, y in cands:
        if x0 is None or x - x0 <= xtol:
            cur.append((x, v, y))
        else:
            cols.append(cur); cur = [(x, v, y)]
        x0 = x
    if cur:
        cols.append(cur)

    # escolhe a coluna cuja soma ≈ total
    melhor, melhor_diff = None, None
    for col in cols:
        s = round(sum(v for _, v, _ in col), 2)
        d = abs(s - total_fatura)
        if melhor_diff is None or d < melhor_diff:
            melhor, melhor_diff = col, d
    if melhor is None:
        return None
    soma = round(sum(v for _, v, _ in melhor), 2)
    validado = melhor_diff <= max(0.50, total_fatura * tol_rel)

    # descrição por item (desc na mesma linha-y)
    itens = []
    for x, v, y in melhor:
        desc = min(desc_ys, key=lambda dy: abs(dy[0] - y))[1] if desc_ys else ""
        itens.append({"descricao": desc[:60], "valor_brl": v})
    return {"itens": itens, "soma": soma, "total": total_fatura,
            "validado": validado, "_fonte": "coord_liteparse"}


_PCT = re.compile(r"^\d{1,2}(?:,\d+)?%$")


def extrair_campos_coord(pdf_bytes: bytes, total: float = None, *, ytol: float = 3.0):
    """Extrai TRIBUTOS (ICMS/PIS/COFINS) por COORDENADA (liteparse x/y) — robusto a
    layout esparso onde regex-de-linha erra. Âncoras:
      - ICMS: valor BR à DIREITA do '<NN>%' (a linha de totais tem o maior → escolhe o
        maior candidato ≤ total). Captura a alíquota do próprio '%'.
      - PIS/COFINS: valor BR adjacente (direita/abaixo) ao rótulo 'PIS'/'PASEP'/'COFINS'.
    Self-valida: 0 < icms ≤ total e alíquota plausível (≤35%). Retorna dict ou None.
    Não roda em --revalidar (precisa do PDF)."""
    if not pdf_bytes:
        return None
    try:
        import liteparse, tempfile, os
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes); _tp = tmp.name
        try:
            res = liteparse.LiteParse(quiet=True, ocr_enabled=False).parse(_tp)
        finally:
            try: os.unlink(_tp)
            except Exception: pass
    except Exception:
        return None
    its = [(t.text.strip(), t.x, t.y) for p in (res.pages or []) for t in (p.text_items or []) if (t.text or "").strip()]
    if not its:
        return None

    def _val_dir(x, y):
        """menor BR-num à direita na mesma linha."""
        c = [(t2, x2) for t2, x2, y2 in its if abs(y2 - y) <= ytol and x2 > x and _VAL_BR.match(t2)]
        return _brl(min(c, key=lambda p: p[1])[0]) if c else None

    def _val_perto(rotulos):
        """valor BR à direita (mesma linha) ou logo abaixo (mesma coluna) de um rótulo."""
        for t, x, y in its:
            tu = t.upper()
            if any(r in tu for r in rotulos):
                v = _val_dir(x, y)
                if v is None:
                    ab = [(t2, y2) for t2, x2, y2 in its if abs(x2 - x) <= 25 and y2 > y and _VAL_BR.match(t2)]
                    if ab:
                        v = _brl(min(ab, key=lambda p: p[1])[0])
                if v is not None:
                    return v
        return None

    # ICMS: candidatos = valor à direita de cada 'NN%'
    icms_cands, aliq = [], None
    for t, x, y in its:
        if _PCT.match(t):
            v = _val_dir(x, y)
            if v is not None:
                if total and v > total:  # base não é ICMS — descarta
                    continue
                icms_cands.append(v)
                if aliq is None:
                    aliq = t.rstrip("%")
    icms = max(icms_cands) if icms_cands else None
    pis = _val_perto(("PIS/PASEP", "PIS ", "PASEP"))
    cof = _val_perto(("COFINS",))

    # PIS/COFINS são tributos PEQUENOS (~0,6-7,6% da base). Rejeita implausível:
    # grande demais (>10% do total = pegou consumo/base por engano) OU pis==cofins
    # (âncora grudou no mesmo número errado). Vira None (SKIP) em vez de dado falso.
    if total:
        if pis is not None and pis > total * 0.10:
            pis = None
        if cof is not None and cof > total * 0.10:
            cof = None
    if pis is not None and cof is not None and abs(pis - cof) < 0.01:
        pis = cof = None

    ok = (icms is not None) and (not total or 0 < icms <= total)
    return {"icms": icms, "pis": pis, "cofins": cof, "aliq_icms": aliq,
            "_validado": ok, "_fonte": "coord_campos_liteparse"}


if __name__ == "__main__":  # teste standalone (read-only)
    import os, glob, sys, warnings; warnings.filterwarnings("ignore")
    GOLD = {"20568024": 24064.08, "20568025": 10140.89, "20568026": 11847.17}
    base_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "p10_enel_ce")
    ok = 0
    for fn in sorted(glob.glob(os.path.join(base_dir, "*.pdf"))):
        b = os.path.basename(fn).split("_")[0]
        if b not in GOLD:
            continue
        r = extrair_itens_coord(open(fn, "rb").read(), GOLD[b])
        st = "OK" if (r and r["validado"]) else "FALHOU"
        print("%s | total=%.2f soma=%s validado=%s itens=%s [%s]" % (
            b, GOLD[b], r["soma"] if r else "-", r["validado"] if r else "-",
            len(r["itens"]) if r else 0, st))
        if r and r["validado"]:
            ok += 1
    print("=> %d/%d validados" % (ok, len(GOLD)))
