# -*- coding: utf-8 -*-
"""Segunda leitura do OCR por recorte (17/11/2026): onde a leitura da página inteira não fechou, recorta só o
quadro (medição, tributos) em zoom alto e lê de novo; as duas leituras votam.

Por que: o RapidOCR em zoom 3 perde dígito em fonte pequena (Enel SP ruidosa, Energisa com números colados) e
varia entre uma passagem e outra (Equatorial perdeu a base do ICMS). Ler só o quadro, em zoom 6, é mais preciso
e mais rápido que ler a página inteira de novo. A posição do quadro vem das âncoras que a primeira leitura já
achou — os rótulos do cabeçalho da tabela de medição ("Leitura", "Anterior", "Atual", "Const") e os rótulos dos
tributos (ICMS, PIS, COFINS) — então funciona em qualquer layout sem molde de posição.

Voto: o campo entra quando (a) a releitura fecha a conta da fatura (física ou base × alíquota), ou (b) as duas
leituras dizem o mesmo número. Nunca grava o que só uma passagem leu sem fechar.

Uso no pipeline: ocr_reforco.aplicar(v2_out, pdf_bytes) depois da medição e dos tributos, só no modo OCR.
Avulso: python ocr_reforco.py fatura.pdf
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
if str(AQUI) not in sys.path:
    sys.path.insert(0, str(AQUI))

import identificacao as _idn  # noqa: E402
from identificacao import Item, normalizar  # noqa: E402

RE_ANCORA_MED = re.compile(r"\b(leitura|anterior|atual|const|medidor|grandeza|posto)\b")
RE_ANCORA_TRIB = re.compile(r"^(icms|pis|pis/pasep|pispasep|cofins)")
MARGEM = 6.0


def _caixa_medicao(itens: list[Item]) -> tuple[int, tuple[float, float, float, float]] | None:
    """Quadro da medição: da linha do cabeçalho (≥ 2 âncoras) até 140 pt abaixo, largura da página."""
    por_pagina: dict[int, list[Item]] = {}
    for it in itens:
        if RE_ANCORA_MED.search(it.norm):
            por_pagina.setdefault(it.page, []).append(it)
    for pg in sorted(por_pagina):
        anc = sorted(por_pagina[pg], key=lambda i: i.y)
        for i, a in enumerate(anc):
            juntas = [b for b in anc if abs(b.y - a.y) <= 10]
            if len(juntas) >= 2:
                y0 = min(b.y for b in juntas) - MARGEM
                xs = [b.x for b in itens if b.page == pg]
                return pg, (max(0.0, min(xs) - MARGEM) if xs else 0.0, y0, 10_000.0, y0 + 150.0)
    return None


def _caixas_tributos(itens: list[Item]) -> list[tuple[int, tuple[float, float, float, float]]]:
    """Um recorte por rótulo de tributo: da esquerda do rótulo até a borda direita, 3 linhas de altura."""
    out = []
    for it in itens:
        if RE_ANCORA_TRIB.match(it.norm.replace(" ", "")) and it.page <= 1:
            out.append((it.page, (max(0.0, it.x - MARGEM), it.y - 14.0, 10_000.0, it.y + it.h + 14.0)))
    return out[:6]


def _juntar(itens: list[Item], novos: list[dict], pagina: int, caixa) -> list[Item]:
    """Troca os itens da página dentro da caixa pelos da releitura."""
    x0, y0, x1, y1 = caixa
    fora = [it for it in itens if not (it.page == pagina and y0 <= it.y <= y1 and x0 <= it.x <= x1)]
    dentro = [Item(n["text"], normalizar(n["text"]), float(n["x"]), float(n["y"]), float(n["w"]), float(n["h"]), pagina)
              for n in novos if (n.get("text") or "").strip()]
    out = fora + dentro
    out.sort(key=lambda i: (i.page, round(i.y / 2), i.x))
    return out


def _iguais(a, b) -> bool:
    try:
        return a is not None and b is not None and abs(float(a) - float(b)) <= max(0.011, 0.002 * abs(float(b)))
    except (TypeError, ValueError):
        return a == b


def aplicar(v2_out: dict, pdf_bytes: bytes, zoom: float = 6.0) -> dict:
    """Só no modo OCR. Relê os quadros que não fecharam e vota. Nunca levanta exceção."""
    if v2_out.get("_fonte_itens") != "ocr":
        return v2_out
    try:
        import ocr_itens
        from medicao import aplicar_medicao, ler_medicao
        from tributos import aplicar_tributos, ler_tributos
        itens, _, _ = _idn.itens_do_pdf(pdf_bytes, 3)
        med1 = v2_out.get("_medicao") or {}
        tr1 = v2_out.get("_tributos") or {}
        relidos: list[str] = []
        itens2 = list(itens)

        # medição não fechou → relê o quadro
        if not med1.get("validado"):
            cx = _caixa_medicao(itens)
            if cx:
                pg, caixa = cx
                novos = ocr_itens.itens_recorte(pdf_bytes, pg, caixa, zoom)
                if novos:
                    itens2 = _juntar(itens2, novos, pg, caixa)
                    relidos.append("medicao")
        # tributo sem trio fechado → relê cada rótulo
        faltam = [t for t in ("icms", "pis", "cofins") if not (tr1.get(t) or {}).get("fecha")]
        if faltam:
            for pg, caixa in _caixas_tributos(itens):
                novos = ocr_itens.itens_recorte(pdf_bytes, pg, caixa, zoom)
                if novos:
                    itens2 = _juntar(itens2, novos, pg, caixa)
                    relidos.append("tributos")
        if not relidos:
            v2_out["_ocr_reforco"] = {"relidos": [], "aceitos": []}
            return v2_out

        aceitos: list[str] = []
        # voto da medição: a releitura fecha a física → vale; senão, só se as duas leituras coincidem (nada novo)
        if "medicao" in relidos:
            antes = dict(v2_out.get("_medicao") or {})
            med2 = ler_medicao(pdf_bytes, itens2)
            if med2 and med2.get("validado"):
                _idn.ULTIMA_FONTE = "ocr"
                # aplica a releitura: aplicar_medicao relê itens_do_pdf (cache da página inteira) — passa os itens
                # relidos pela porta dos fundos, trocando o cache de leitura por esta chamada
                v2_out = _aplicar_com_itens(v2_out, pdf_bytes, itens2, aplicar_medicao)
                m2 = v2_out.get("_medicao") or {}
                # um recorte pode ler só UM dos registros do posto (Enel SP: fora ponta capacitivo + indutivo) e a
                # física fecha nesse registro sozinho — valor errado. A releitura só vale se algum consumo bate com um
                # item kWh da fatura; sem itens, fica como estava (vazio é melhor que parcial)
                if m2.get("validado") and any((m2.get("itens_confirmam") or {}).values()):
                    aceitos.append("medicao")
                    m2["obs"] = (m2.get("obs") or []) + ["segunda leitura (recorte zoom alto) fechou a física e bate com item"]
                else:
                    v2_out["_medicao"] = antes
                    if m2.get("validado"):
                        v2_out["_medicao"]["obs"] = (antes.get("obs") or []) + ["releitura fechou a física mas nenhum item confirma: não gravada"]
        if "tributos" in relidos:
            antes_t = dict(v2_out.get("_tributos") or {})
            tr2 = ler_tributos(None, itens2) or {}
            novo = dict(antes_t) if antes_t else {"obs": []}
            for t in faltam:
                e2 = tr2.get(t)
                if e2 and e2.get("fecha"):
                    novo[t] = e2
                    aceitos.append(t)
                    novo.setdefault("obs", []).append(f"{t}: segunda leitura (recorte) fechou base × alíquota")
            if aceitos and any(a in ("icms", "pis", "cofins") for a in aceitos):
                # junta: o que fechou na 1ª leitura fica; o que só a releitura fechou entra; colunas refeitas
                from tributos import montar_aplicar
                novo["aplicar"] = montar_aplicar(novo)
                v2_out["_tributos"] = novo
        v2_out["_ocr_reforco"] = {"relidos": sorted(set(relidos)), "aceitos": aceitos}
    except Exception as e:  # pragma: no cover
        v2_out["_ocr_reforco"] = {"erro": str(e)[:200]}
    return v2_out


def _aplicar_com_itens(v2_out: dict, pdf_bytes: bytes, itens2: list[Item], fn):
    """Roda aplicar_medicao/aplicar_tributos com a lista de itens relida: troca temporariamente itens_do_pdf."""
    original = _idn.itens_do_pdf

    def _falso(pdf, max_paginas=2):
        _idn.ULTIMA_FONTE = "ocr"
        return [i for i in itens2 if i.page < max_paginas], 0.0, 0.0

    _idn.itens_do_pdf = _falso
    try:
        import medicao as _m
        import tributos as _t
        _m.itens_do_pdf = _falso
        _t.itens_do_pdf = _falso
        return fn(v2_out, pdf_bytes)
    finally:
        _idn.itens_do_pdf = original
        _m.itens_do_pdf = original
        _t.itens_do_pdf = original


if __name__ == "__main__":
    import io
    import json
    import os
    os.environ["PDF_PIPELINE_NO_OCR"] = "0"
    for a in sys.argv[1:]:
        b = io.open(a, "rb").read()
        from medicao import aplicar_medicao
        from tributos import aplicar_tributos
        v2 = {}
        aplicar_medicao(v2, b)
        aplicar_tributos(v2, b)
        print("antes:", json.dumps({"validado": (v2.get("_medicao") or {}).get("validado"),
                                   "tributos": {t: ((v2.get("_tributos") or {}).get(t) or {}).get("valor") for t in ("icms", "pis", "cofins")}}))
        aplicar(v2, b)
        print("depois:", json.dumps({"reforco": v2.get("_ocr_reforco"), "validado": (v2.get("_medicao") or {}).get("validado"),
                                    "consumo": (v2.get("_medicao") or {}).get("consumo_faturado"),
                                    "tributos": {t: ((v2.get("_tributos") or {}).get(t) or {}).get("valor") for t in ("icms", "pis", "cofins")}},
                                   ensure_ascii=False))
