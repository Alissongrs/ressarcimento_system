# -*- coding: utf-8 -*-
"""Molde de tributos (etapa 2b, 17/11/2026): ICMS, PIS e COFINS lidos pelas linhas posicionadas e conferidos
pela conta da própria fatura — base × alíquota = valor.

Toda distribuidora imprime o quadro de tributos do mesmo jeito, em qualquer lugar da página e às vezes dentro de
uma linha que também carrega colunas dos itens (Coelba, Energisa, CPFL, EDP, Enel):

    ICMS        3.126,71   20,00   625,34
    PIS/PASEP   2.501,35   0,9029   22,58
    COFINS      2.501,35   4,1588  104,02

O molde acha o rótulo, toma os números à direita dele (até o próximo rótulo) e procura o trio (base, alíquota,
valor) que fecha com tolerância de R$ 0,02 ou 0,5 %. Trio que não fecha não grava. Fatura isenta imprime
"ICMS 0,00 0,00 (0,00)": zeros fecham e gravam valor 0. OCR que perde a vírgula ("067", "8523") entra pela
tentativa /100. Quando o mesmo tributo aparece mais de uma vez (linha por item e total), vale o trio de maior
base; duas bases iguais com valores diferentes = ambíguo, não grava.

Uso: python tributos.py fatura.pdf        → o que leu e o que fechou
Como módulo: ler_tributos(pdf_bytes, itens=None) -> dict | None; aplicar_tributos(v2_out, pdf_bytes) deixa
v2_out["_tributos"] com "aplicar" = {coluna SQL: valor} (icms_valor, icms_base_calculo, icms_aliquota,
pis_valor, pis_aliquota, cofins_valor, cofins_aliquota).
"""
from __future__ import annotations

import io
import json
import re
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
if str(AQUI) not in sys.path:
    sys.path.insert(0, str(AQUI))

from identificacao import Item, itens_do_pdf, normalizar  # noqa: E402
from medicao import agrupar_linhas, parse_num, pedacos  # noqa: E402

RE_ROTULO = re.compile(r"^(icms|pis(?:/?pasep)?|pispasep|pasep|cofins)[:.]?$")
MAX_ALIQ = {"icms": 35.0, "pis": 3.0, "cofins": 12.0}
Trio = tuple[float, float, float]


def _tributo(tok: str) -> str | None:
    n = normalizar(tok).replace(" ", "")
    m = RE_ROTULO.match(n)
    if not m:
        return None
    t = m.group(1)
    return "pis" if t.startswith("pis") or t == "pasep" else t


def _num(tok: str) -> float | None:
    t = tok.strip().rstrip("%").replace("R$", "").strip()
    neg = t.endswith("-") or t.startswith("-")  # CPFL imprime "20,77-" (crédito)
    t = t.strip("-")
    v = parse_num(t)
    if v is None and re.fullmatch(r"\d+", t):  # "067", "8523": OCR perdeu a vírgula (tentado como /100 em _trio)
        v = float(t)
    return -v if (v is not None and neg) else v


def _fecha(base: float, aliq: float, valor: float) -> bool:
    return abs(base * aliq / 100 - valor) <= max(0.02, 0.005 * abs(valor))


def _variantes(tok: str, v: float) -> list[float]:
    return [v, v / 100] if re.fullmatch(r"\d+", tok) else [v]


def _trio_impresso(nums: list[tuple[str, float]], tributo: str) -> Trio | None:
    """Sem trio que feche: os três primeiros números à direita do rótulo, na ordem impressa (base, alíquota, valor),
    desde que a alíquota seja plausível e base ≥ valor. É o que a fatura diz; se não fecha, a regra F39 aponta."""
    cand = nums[:3]
    if len(cand) < 3:
        return None
    (_, b), (_, a), (_, v) = cand
    if b <= 0 or not (0 < a <= MAX_ALIQ[tributo]) or v < 0 or v > b:
        return None
    return round(b, 2), round(a, 4), round(v, 2)


def _trio(nums: list[tuple[str, float]], tributo: str) -> Trio | None:
    """Primeiro (base, alíquota, valor) que fecha entre os até 5 números à direita do rótulo.
    Número sem vírgula (OCR) ainda pode valer /100. Base e valor negativos (crédito) fecham entre si."""
    cand = nums[:5]
    if len(cand) >= 2 and all(abs(v) < 0.005 for _, v in cand[:3]):
        return 0.0, 0.0, 0.0  # isento: "0,00 0,00 0,00" ou "0,00 0,00"
    for i in range(len(cand) - 2):
        (tb, b), (ta, a), (tv, v) = cand[i], cand[i + 1], cand[i + 2]
        for bb in _variantes(tb, b):
            for aa in _variantes(ta, a):
                for vv in _variantes(tv, v):
                    if bb == 0 or (bb < 0) != (vv < 0) or not (0 < aa <= MAX_ALIQ[tributo]):
                        continue
                    if _fecha(bb, aa, vv):
                        return round(bb, 2), round(aa, 4), round(vv, 2)
    return None


def _par(nums: list[tuple[str, float]], tributo: str) -> tuple[float, float] | None:
    """(alíquota, valor) quando a base não está impressa ao lado (Light B: 'PASEP | 1,25 | 1,15'; CEMIG GD:
    'COFINS | 4,6445% | 204,63'). Confirmado depois pela base do outro tributo (PIS e COFINS têm a mesma base)."""
    cand = nums[:4]
    for i in range(len(cand) - 1):
        (ta, a), (tv, v) = cand[i], cand[i + 1]
        if 0 < a <= MAX_ALIQ[tributo] and v > 0 and v / a * 100 > a:
            return a, v
    return None


RE_CABECALHO = re.compile(r"^(\(r\$\)|\(rs\)|\(%\)|r\$|rs|aliq\w*\.?|base|tarifa|unid\.?|quant\.?)$")
RE_DESCRICAO_ANTES = re.compile(r"^(sem|isent[oa]|s/|c/|com|cob\.?|cobranca|subven\w*|subv\.?|reducao|sobre|do|da|de|credito|dif\.?|diferenca|ajuste|desc\.?|desconto)$")


def _eh_cabecalho(tok: str) -> bool:
    """Token de cabeçalho de quadro ("(R$)", "Alíquota", "Base"): nessa linha o rótulo é título de coluna e os
    números da linha vizinha são de um item, não do tributo."""
    return bool(RE_CABECALHO.match(normalizar(tok).replace(" ", "")))


def _descricao_antes(tok: str) -> bool:
    """Palavra imediatamente antes do rótulo que o torna parte da descrição de um item."""
    palavras = [w for w in re.split(r"[^a-z/]+", normalizar(tok)) if w]  # "Tanfana-TUSD-Com" (OCR) → "com"
    return bool(palavras) and bool(RE_DESCRICAO_ANTES.match(palavras[-1]))


def _numeros(toks: list[tuple[str, float]], de: int, x_min: float | None = None) -> list[tuple[str, float]]:
    nums: list[tuple[str, float]] = []
    for tok, x in toks[de:]:
        if _tributo(tok):
            break
        if x_min is not None and x < x_min:
            continue
        v = _num(tok)
        if v is not None:
            nums.append((tok.strip().rstrip("%"), v))
        elif nums and not re.search(r"\d", tok):
            break  # texto depois dos números: fim do quadro
    return nums


def ler_tributos(pdf_bytes: bytes | None, itens: list[Item] | None = None) -> dict | None:
    if itens is None:
        itens, _, _ = itens_do_pdf(pdf_bytes, 3)
    linhas = [ln for ln in agrupar_linhas(itens) if ln[0].page <= 2]
    toks_por_linha = [pedacos(ln) for ln in linhas]
    achados: dict[str, list[Trio]] = {"icms": [], "pis": [], "cofins": []}
    pares: dict[str, list[tuple[float, float]]] = {"icms": [], "pis": [], "cofins": []}
    impressos: dict[str, list[Trio]] = {"icms": [], "pis": [], "cofins": []}  # trio na posição do rótulo que NÃO fecha
    import identificacao as _idn
    fonte_texto = getattr(_idn, "ULTIMA_FONTE", "texto") != "ocr"
    for li, toks in enumerate(toks_por_linha):
        cabecalho = any(_eh_cabecalho(t) for t, _ in toks)
        for k, (tok, x) in enumerate(toks):
            trib = _tributo(tok)
            if not trib:
                continue
            if k and _descricao_antes(toks[k - 1][0]):
                continue  # "Demanda Distribuição sem ICMS", "Cob. ICMS Subven-CDE", "TUSD Com ICMS": item, não tributo
            nums = _numeros(toks, k + 1)
            t = _trio(nums, trib)
            if t is None and not cabecalho:
                # rótulo no fim da linha (Energisa "… ICMS" / Equatorial "3.513,89 PIS"), ou números na linha
                # vizinha (Elektro "COFINS" 2,6 pt abaixo dos números): olha a linha anterior e a seguinte, só à direita
                for lj in (li - 1, li + 1):
                    if 0 <= lj < len(linhas) and linhas[lj][0].page == linhas[li][0].page \
                            and abs(linhas[lj][0].y - linhas[li][0].y) <= 8:
                        viz = _numeros(toks_por_linha[lj], 0, x_min=x - 10)
                        t = _trio(viz, trib)
                        if t:
                            break
                        if not nums:
                            nums = viz
            if t is None and not cabecalho and fonte_texto:
                ti = _trio_impresso(nums, trib)
                if ti and ti not in impressos[trib]:
                    impressos[trib].append(ti)
            if t is not None:
                if t not in achados[trib]:
                    achados[trib].append(t)
            else:
                pr = _par(nums, trib)
                if pr and pr not in pares[trib]:
                    pares[trib].append(pr)
    if not any(achados.values()) and not any(pares.values()) and not any(impressos.values()):
        return None
    out: dict = {"obs": []}
    for trib, lst in achados.items():
        if not lst:
            out[trib] = None
            continue
        if len(lst) == 1:
            b, a, v = lst[0]
            out[trib] = {"base": b, "aliquota": a, "valor": v}
            continue
        maior = max(lst, key=lambda t: abs(t[0]))
        resto = [t for t in lst if t is not maior]
        if abs(sum(t[0] for t in resto) - maior[0]) <= max(0.05, 0.002 * abs(maior[0])):
            out[trib] = {"base": maior[0], "aliquota": maior[1], "valor": maior[2]}  # linhas por item + total
            out["obs"].append(f"{trib}: {len(lst)} trios (por item e total); vale o total")
        else:
            b, v = round(sum(t[0] for t in lst), 2), round(sum(t[2] for t in lst), 2)  # só linhas por item: soma
            out[trib] = {"base": b, "aliquota": round(v / b * 100, 4) if b else None, "valor": v}
            out["obs"].append(f"{trib}: {len(lst)} trios por item sem total; soma")
    # base compartilhada: PIS e COFINS incidem sobre a mesma base — um par (alíquota, valor) fecha se a base que ele
    # implica bate com a base do outro (impressa ou implicada)
    for trib, outro in (("pis", "cofins"), ("cofins", "pis")):
        if out.get(trib) or not pares[trib]:
            continue
        a, v = pares[trib][0]
        base_est = v / a * 100
        ref = (out.get(outro) or {}).get("base")
        if ref is None and pares[outro]:
            a2, v2 = pares[outro][0]
            ref = v2 / a2 * 100
        if ref and abs(base_est - ref) <= max(0.5, 0.005 * ref):
            out[trib] = {"base": round(ref, 2), "aliquota": round(a, 4), "valor": round(v, 2)}
            out["obs"].append(f"{trib}: base não impressa; fecha com a base do {outro}")
    for trib in ("icms", "pis", "cofins"):
        out.setdefault(trib, None)
        if out[trib]:
            out[trib]["fecha"] = True
        elif impressos[trib] and len(impressos[trib]) == 1:
            # texto exato e nenhuma leitura fecha: grava o impresso e deixa a regra apontar (F39)
            b, a, v = impressos[trib][0]
            out[trib] = {"base": b, "aliquota": a, "valor": v, "fecha": False}
            out["obs"].append(f"{trib}: impresso {b} × {a}% ≠ {v} — gravado como está (regra F39)")
    if not any(out[t] for t in ("icms", "pis", "cofins")):
        return None
    return out


def aplicar_tributos(v2_out: dict, pdf_bytes: bytes) -> dict:
    """Lê os tributos pelo molde e deixa em v2_out['_tributos'] (com 'aplicar' = colunas). Nunca levanta exceção."""
    try:
        itens, _, _ = itens_do_pdf(pdf_bytes, 3)
        tr = ler_tributos(None, itens)
    except Exception as e:  # pragma: no cover
        v2_out["_tributos"] = {"erro": str(e)[:200]}
        return v2_out
    if not tr:
        return v2_out
    tr["aplicar"] = montar_aplicar(tr)
    v2_out["_tributos"] = tr
    return v2_out


def montar_aplicar(tr: dict) -> dict:
    """Colunas SQL a partir do resultado de ler_tributos (também usado pelo ocr_reforco depois de juntar leituras)."""
    aplicar: dict = {}
    if tr.get("icms"):
        aplicar["icms_valor"] = tr["icms"]["valor"]
        aplicar["icms_base_calculo"] = tr["icms"]["base"]
        aplicar["icms_aliquota"] = tr["icms"]["aliquota"]
    if tr.get("pis"):
        aplicar["pis_valor"] = tr["pis"]["valor"]
        aplicar["pis_aliquota"] = tr["pis"]["aliquota"]
    if tr.get("cofins"):
        aplicar["cofins_valor"] = tr["cofins"]["valor"]
        aplicar["cofins_aliquota"] = tr["cofins"]["aliquota"]
    return aplicar


def _principal(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    for a in argv:
        tr = ler_tributos(Path(a).read_bytes())
        print(a, json.dumps(tr, ensure_ascii=False, indent=1) if tr else "nenhum tributo fechou")
    return 0


if __name__ == "__main__":
    sys.exit(_principal(sys.argv[1:]))
