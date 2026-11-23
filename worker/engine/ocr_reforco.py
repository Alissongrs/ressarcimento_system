# -*- coding: utf-8 -*-
"""Segunda leitura do OCR por recorte (17/11/2026): onde a leitura da página inteira não fechou, recorta só o
quadro (medição, tributos) em zoom alto e lê de novo; as duas leituras votam.

Por que: o RapidOCR em zoom 3 perde dígito em fonte pequena (Enel SP ruidosa, Energisa com números colados) e
varia entre uma passagem e outra (Equatorial perdeu a base do ICMS). Ler só o quadro, em zoom 6, é mais preciso
e mais rápido que ler a página inteira de novo. A posição do quadro vem das âncoras que a primeira leitura já
achou — os rótulos do cabeçalho da tabela de medição ("Leitura", "Anterior", "Atual", "Const") e os rótulos dos
tributos (ICMS, PIS, COFINS) — então funciona em qualquer layout sem molde de posição.

Voto (medido 19/11/2026 em 39 escaneadas com gabarito visual): medição e ICMS — uma releitura em zoom 6 que fecha a
conta (física + item kWh; base × alíquota, nunca a soma calculada das linhas); PIS/COFINS — várias releituras com
tratamento de imagem (ocr_itens.VARIANTES) e entra o valor que duas acharam igual e que fecha. Nunca grava o que
não fechou.

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
            # o cabeçalho de DATAS ("Leitura anterior | Leitura atual | Nº de dias", Copel/Enel) também tem 2 âncoras;
            # o da tabela de medição tem medidor/constante/grandeza/posto — sem um desses não é a tabela
            if len(juntas) >= 2 and any(re.search(r"\b(const|medidor|grandeza|posto)", b.norm) for b in juntas):
                y0 = min(b.y for b in juntas) - MARGEM
                xs = [b.x for b in itens if b.page == pg]
                return pg, (max(0.0, min(xs) - MARGEM) if xs else 0.0, y0, 10_000.0, y0 + 150.0)
    # 22/11/2026: cabeçalho ilegível na escaneada (615514 CPFL: "Medidor/Grandezas" saiu "eiai | Asier."). As linhas
    # da tabela começam pelo nº do medidor (que o OCR também varia): ≥ 2 linhas na página com número + posto horário
    from medicao import agrupar_linhas, pedacos  # noqa: E402
    por_pg: dict = {}
    for ln in agrupar_linhas(itens):
        toks = [t.strip() for t, _ in pedacos(ln)]
        if toks and re.fullmatch(r"\d{6,12}", toks[0]) and re.search(r"pon[tl]a|porta|pona|unico",
                                                                      normalizar(" ".join(toks[1:]))):
            por_pg.setdefault(ln[0].page, []).append(ln)
    for pg in sorted(por_pg):
        lns = por_pg[pg]
        if len(lns) >= 2:
            ys = [ln[0].y for ln in lns]
            xs = [b.x for b in itens if b.page == pg]
            return pg, (max(0.0, min(xs) - MARGEM) if xs else 0.0, min(ys) - 14.0, 10_000.0, max(ys) + 10.0)
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


def _caixa_tributos_unica(itens: list[Item]) -> list[tuple[int, tuple[float, float, float, float]]]:
    """Um recorte só cobrindo todos os rótulos de tributo da página (menos leituras que um por rótulo)."""
    por_pg: dict[int, list[tuple[float, float, float, float]]] = {}
    for pg, (x0, y0, x1, y1) in _caixas_tributos(itens):
        por_pg.setdefault(pg, []).append((x0, y0, x1, y1))
    return [(pg, (min(c[0] for c in cs), min(c[1] for c in cs), 10_000.0, max(c[3] for c in cs))) for pg, cs in por_pg.items()]


def _variantes():
    import ocr_itens
    return list(getattr(ocr_itens, "VARIANTES", [(6.0, None)]))


def _soma_calculada(tr2: dict, t: str) -> bool:
    """tributos.py devolve a SOMA das linhas por item quando não acha o total ("trios por item sem total; soma"):
    valor calculado, com alíquota implícita que fecha sozinha. Na releitura não vale (Enel CE 398057: 35,24 × 34,97)."""
    obs = " | ".join(tr2.get("obs") or [])
    return f"{t}:" in obs and "soma" in obs.split(f"{t}:", 1)[1].split("|", 1)[0]


def aplicar(v2_out: dict, pdf_bytes: bytes, zoom: float = 6.0) -> dict:
    """Só no modo OCR. Relê os quadros que não fecharam e a conta da fatura escolhe. Nunca levanta exceção.

    Medido em 39 escaneadas com gabarito visual (19/11/2026):
    - medição: uma releitura (zoom 6). Várias variantes e o molde por distribuidora não recuperaram nenhuma leitura
      (o gargalo é o leitor de cada layout, não o OCR) e triplicavam o tempo.
    - ICMS: uma releitura (zoom 6) que fecha base × alíquota, sem soma calculada. Variantes geravam ICMS de UMA linha
      (Light 493430: 1.329,87 no lugar de 8.850,45) que fecha e duas leituras confirmam.
    - PIS/COFINS: até 5 variantes (ocr_itens.VARIANTES); entra o valor que DUAS leituras acharam igual e que fecha.
      PIS 75 % → 81 %, COFINS 75 % → 78 %, nenhum erro novo."""
    if v2_out.get("_fonte_itens") != "ocr":
        return v2_out
    try:
        import ocr_itens
        from medicao import _ocr_linhas_ativa, aplicar_medicao, ler_medicao
        from tributos import ler_tributos
        itens, _, _ = _idn.itens_do_pdf(pdf_bytes, 3)
        med1 = v2_out.get("_medicao") or {}
        tr1 = v2_out.get("_tributos") or {}
        relidos: list[str] = []
        aceitos: list[str] = []

        # medição: uma releitura do quadro (âncora da tabela); vale se fecha a física E bate com item kWh
        if not med1.get("validado"):
            cx = _caixa_medicao(itens)
            if cx:
                pg, caixa = cx
                novos = ocr_itens.itens_recorte(pdf_bytes, pg, caixa, zoom)
                if novos:
                    relidos.append("medicao")
                    itens2 = _juntar(list(itens), novos, pg, caixa)
                    antes = dict(v2_out.get("_medicao") or {})
                    med2 = ler_medicao(pdf_bytes, itens2)
                    # a releitura vale se o molde fechar OU se as leituras (as duas leituras do quadro juntas)
                    # fecharem com o item kWh impresso (_ocr_reparar_por_itens, 615514)
                    if med2 is not None or _ocr_linhas_ativa(itens2):
                        _idn.definir_fonte("ocr")
                        import copy as _copy
                        _snap = {k: _copy.deepcopy(v2_out.get(k)) for k in
                                 ("identificadores_instalacao", "periodo_leitura", "ligacao_tecnica")}
                        # mais uma passada binarizada em zoom 5: na 615514 só ela leu "551624" e "254561"
                        # (as outras liam o 6 como 0). Serve de candidata a _ocr_reparar_por_itens, nunca sozinha
                        extra = [list(itens)]
                        try:
                            nb = ocr_itens.itens_recorte(pdf_bytes, pg, caixa, 5.0, "binaria")
                            if nb:
                                extra.append(_juntar(list(itens), nb, pg, caixa))
                        except Exception:  # noqa: BLE001
                            pass
                        v2_out["_ocr_med_extra"] = extra
                        try:
                            v2_out = _aplicar_com_itens(v2_out, pdf_bytes, itens2, aplicar_medicao)
                        finally:
                            v2_out.pop("_ocr_med_extra", None)
                        m2 = v2_out.get("_medicao") or {}
                        # um recorte pode ler só UM dos registros do posto (Enel SP: fora ponta capacitivo + indutivo)
                        # e a física fecha nesse registro sozinho — só vale se algum consumo bate com item kWh
                        if m2.get("validado") and (any((m2.get("itens_confirmam") or {}).values())
                                                   or m2.get("confirmado_ocr_itens")):
                            aceitos.append("medicao")
                            m2["obs"] = (m2.get("obs") or []) + ["segunda leitura (recorte zoom alto) fechou a física e bate com item"]
                        else:
                            v2_out["_medicao"] = antes
                            for k, v in _snap.items():  # releitura recusada não deixa rastro
                                if v is None:
                                    v2_out.pop(k, None)
                                else:
                                    v2_out[k] = v

        faltam = [t for t in ("icms", "pis", "cofins") if not (tr1.get(t) or {}).get("fecha")]
        novo = dict(tr1) if tr1 else {"obs": []}
        if faltam:
            # 1ª passada = a de produção: um recorte por rótulo de tributo (zoom 6), todos juntos numa leitura; vale o
            # tributo que fecha base × alíquota — agora sem a soma calculada das linhas por item
            itens2 = list(itens)
            for pg, caixa in _caixas_tributos(itens):
                novos = ocr_itens.itens_recorte(pdf_bytes, pg, caixa, zoom)
                if novos:
                    itens2 = _juntar(itens2, novos, pg, caixa)
                    relidos.append("tributos")
            if "tributos" in relidos:
                tr2 = ler_tributos(None, itens2) or {}
                for t in faltam:
                    e2 = tr2.get(t)
                    if e2 and e2.get("fecha") and not _soma_calculada(tr2, t):
                        novo[t] = e2
                        aceitos.append(t)
                        novo.setdefault("obs", []).append(f"{t}: segunda leitura (recorte) fechou base × alíquota")
            # 2ª passada só para PIS/COFINS que ainda faltam: variantes de imagem no quadro inteiro; entra o valor
            # que DUAS leituras acharam igual e que fecha (ICMS não: as variantes pegavam o ICMS de uma linha)
            pendentes = [t for t in faltam if t in ("pis", "cofins") and t not in aceitos]
            votos: dict[str, dict[tuple, list]] = {t: {} for t in pendentes}
            for pg, caixa in (_caixa_tributos_unica(itens) if pendentes else []):
                for z, modo in _variantes():
                    if not pendentes:
                        break
                    novos = ocr_itens.itens_recorte(pdf_bytes, pg, caixa, z, modo)
                    if not novos:
                        continue
                    tr3 = ler_tributos(None, _juntar(list(itens), novos, pg, caixa)) or {}
                    for t in list(pendentes):
                        e3 = tr3.get(t)
                        if not (e3 and e3.get("fecha") and e3.get("valor") is not None) or _soma_calculada(tr3, t):
                            continue
                        chave = (round(float(e3["valor"]), 2), round(float(e3.get("base") or 0), 2))
                        lst = votos[t].setdefault(chave, [])
                        lst.append("z%g %s" % (z, modo or "normal"))
                        if len(lst) >= 2:
                            novo[t] = e3
                            pendentes.remove(t)
                            aceitos.append(t)
                            novo.setdefault("obs", []).append(
                                f"{t}: {len(lst)} releituras ({', '.join(lst)}) acharam o mesmo valor e fecham base × alíquota")
                if not pendentes:
                    break
        if any(a in ("icms", "pis", "cofins") for a in aceitos):
            from tributos import montar_aplicar
            novo["aplicar"] = montar_aplicar(novo)
            v2_out["_tributos"] = novo
        v2_out["_ocr_reforco"] = {"relidos": sorted(set(relidos)), "aceitos": aceitos}
    except Exception as e:  # pragma: no cover
        v2_out["_ocr_reforco"] = {"erro": str(e)[:200]}
    return v2_out


def _aplicar_com_itens(v2_out: dict, pdf_bytes: bytes, itens2: list[Item], fn):
    """Roda aplicar_medicao/aplicar_tributos com a lista de itens relida — só nesta thread (itens_forcados);
    trocar itens_do_pdf no módulo entregava os itens desta fatura às outras threads do pdf_pipeline."""
    with _idn.itens_forcados(itens2):
        return fn(v2_out, pdf_bytes)


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
