# -*- coding: utf-8 -*-
"""Leitura × mês anterior/seguinte (24/11/2026).

Num medidor que acumula, a leitura ANTERIOR de um mês é a leitura ATUAL do mês anterior, e a ATUAL é a anterior do
mês seguinte. Na PROD (24/11/2026), dos pares de meses consecutivos do mesmo medidor com as duas leituras gravadas,
~96% fecham; a quebra concentra o erro de extração (Energisa MT/MS/TO/Minas Rio: 27–60% fecham).

Este módulo só faz UMA correção: anterior e atual INVERTIDAS (anterior > atual) quando os vizinhos confirmam a ordem
trocada — os dois números estão impressos, só a posição muda. Dígito a mais/a menos (111.582 × 11.582) NÃO é
corrigido aqui: seria valor deduzido; fica como divergência na confiança (confirmacao.py, fontes anterior/posterior)
e no relatório (python continuidade.py --relatorio saida.csv).

Leitura zerada (anterior = 0) não entra: medidor que zera a cada ciclo imprime assim (Energisa MS Grupo A).
"""
from __future__ import annotations

import re

POSTOS = (("ponta", "leit_ant_ativa_ponta", "leit_atu_ativa_ponta", "consumo_ativo_ponta_kwh"),
          ("fponta", "leit_ant_ativa_fponta", "leit_atu_ativa_fponta", "consumo_ativo_fponta_kwh"))
_COLS = ["uid", "mes_referencia", "numero_medidor", "constante_k"] + [c for _, a, t, k in POSTOS for c in (a, t, k)]


def _f(v):
    try:
        return float(v) if v not in (None, "", "__SET_NULL__") else None
    except (TypeError, ValueError):
        return None


def _med(v) -> str:
    return re.sub(r"[^0-9A-Z]", "", str(v or "").upper()).lstrip("0")


def _mes(v) -> int | None:
    m = re.match(r"(\d{4})-(\d{2})", str(v or ""))
    return int(m[1]) * 12 + int(m[2]) if m else None


def _eq(a, b) -> bool | None:
    return None if a is None or b is None else abs(a - b) <= 0.5


def _linha(cur, tbl: str, sql_where: str, args) -> dict | None:
    cur.execute(f"SELECT {', '.join(_COLS)} FROM {tbl} WHERE {sql_where}", args)
    r = cur.fetchone()
    if not r:
        return None
    return r if isinstance(r, dict) else dict(zip(_COLS, r))


def por_instalacao(cur, tbl: str, cod_empresa, instalacao, mes_ref, delta: int, cols: list[str]) -> dict | None:
    """Fatura da mesma empresa + nº de instalação no mês mes_ref + delta. O prefixo do uid NÃO é fixo por UC
    (Energisa PB: 426535720251001 → 426535820251201), por isso a busca é pela instalação (índice idx_fde_motor)."""
    m = _mes(mes_ref)
    if m is None or not cod_empresa or not str(instalacao or "").strip():
        return None
    alvo = m + delta
    ini = f"{(alvo - 1) // 12:04d}-{(alvo - 1) % 12 + 1:02d}-01"
    try:
        cur.execute(f"SELECT {', '.join(cols)} FROM {tbl} WHERE cod_empresa=%s AND numero_instalacao=%s "
                    f"AND mes_referencia >= %s AND mes_referencia < DATE_ADD(%s, INTERVAL 1 MONTH) ORDER BY id DESC LIMIT 1",
                    (int(cod_empresa), str(instalacao).strip(), ini, ini))
        r = cur.fetchone()
    except Exception:
        return None
    if not r:
        return None
    return r if isinstance(r, dict) else dict(zip(cols, r))


def vizinhos(cur, atual: dict, tbl_viz: str = "FATURA_DADOS_EXTRAIDOS") -> tuple[dict | None, dict | None]:
    """Faturas do mês anterior e do seguinte da mesma instalação (PROD, só leitura)."""
    args = (atual.get("cod_empresa"), atual.get("numero_instalacao"), atual.get("mes_referencia"))
    return (por_instalacao(cur, tbl_viz, *args, -1, _COLS), por_instalacao(cur, tbl_viz, *args, +1, _COLS))


def elos_para_medicao(cur, uid: str, tbl: str = "FATURA_DADOS_EXTRAIDOS") -> dict | None:
    """{posto ('p'/'fp'): (atual do mês anterior, anterior do mês seguinte)} da mesma instalação, para o medicao.py e
    o ocr_reforco.py escolherem entre leituras candidatas do OCR. Empresa/instalação/mês vêm da linha já gravada
    (PROD, só leitura). None sem vizinho."""
    extra = ["cod_empresa", "numero_instalacao"]
    try:
        cur.execute(f"SELECT {', '.join(_COLS + extra)} FROM {tbl} WHERE uid=%s", (uid,))
        r = cur.fetchone()
    except Exception:
        return None
    if not r:
        return None
    atual = r if isinstance(r, dict) else dict(zip(_COLS + extra, r))
    ant, pos = vizinhos(cur, atual, tbl)
    m = _mes(atual.get("mes_referencia"))
    ant = ant if ant and _mesmo_medidor(atual, ant) and _mes(ant.get("mes_referencia")) == (m or 0) - 1 else None
    pos = pos if pos and _mesmo_medidor(atual, pos) and _mes(pos.get("mes_referencia")) == (m or 0) + 1 else None
    if not ant and not pos:
        return None
    out = {}
    for nome, ca, ct, _ in POSTOS:
        va = _f(ant.get(ct)) if ant else None
        vp = _f(pos.get(ca)) if pos else None
        out["p" if nome == "ponta" else "fp"] = (va if va else None, vp if vp else None)
    return out


def _mesmo_medidor(a: dict, b: dict | None) -> bool:
    if not b:
        return False
    x, y = _med(a.get("numero_medidor")), _med(b.get("numero_medidor"))
    return not x or not y or x == y


def corrigir_trocadas(atual: dict, ant: dict | None, pos: dict | None) -> dict:
    """{coluna: valor} para desinverter anterior/atual de um posto. Exige: anterior > atual (impossível sem virada),
    anterior ≠ 0, ao menos um vizinho de mês consecutivo e mesmo medidor confirmando a ordem trocada, nenhum
    contradizendo, e — havendo consumo — (atual − anterior) × K fechando o consumo em até 3%."""
    out: dict = {}
    m = _mes(atual.get("mes_referencia"))
    a_ok = m is not None and _mesmo_medidor(atual, ant) and _mes(ant.get("mes_referencia")) == m - 1
    p_ok = m is not None and _mesmo_medidor(atual, pos) and _mes(pos.get("mes_referencia")) == m + 1
    k = _f(atual.get("constante_k")) or 1.0
    for _, ca, ct, cc in POSTOS:
        a, t = _f(atual.get(ca)), _f(atual.get(ct))
        if a is None or t is None or a == 0 or a <= t + 0.5:
            continue
        na, nt = t, a  # ordem trocada
        provas = [x for x in ((_eq(_f(ant.get(ct)), na) if a_ok else None),
                              (_eq(_f(pos.get(ca)), nt) if p_ok else None)) if x is not None]
        if not provas or not all(provas):
            continue
        c = _f(atual.get(cc))
        if c and abs((nt - na) * k - c) > 0.03 * c and abs(nt - na - c) > 0.03 * c:
            continue
        out[ca], out[ct] = na, nt
    return out


def aplicar(cur, tbl: str, uid: str, tbl_viz: str = "FATURA_DADOS_EXTRAIDOS") -> dict:
    """Lê a fatura em `tbl` e os vizinhos em `tbl_viz` (PROD, só leitura); devolve as colunas a desinverter."""
    cur.execute(f"SELECT {', '.join(_COLS + ['cod_empresa', 'numero_instalacao'])} FROM {tbl} WHERE uid=%s", (uid,))
    r = cur.fetchone()
    if not r:
        return {}
    atual = r if isinstance(r, dict) else dict(zip(_COLS + ["cod_empresa", "numero_instalacao"], r))
    ant, pos = vizinhos(cur, atual, tbl_viz)
    return corrigir_trocadas(atual, ant, pos)


# ─── relatório (só leitura) ──────────────────────────────────────────────────
def relatorio(saida: str) -> None:
    """CSV: cada fatura × posto cuja leitura não fecha com o mês anterior e/ou o seguinte (mesmo medidor)."""
    import collections
    import csv
    import os
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import mysql.connector
    from db_env import conexao
    c = mysql.connector.connect(**conexao("DB_APP_URL"))
    cur = c.cursor()
    cur.execute(f"SELECT cod_empresa, numero_instalacao, distribuidora, {', '.join(_COLS)} FROM FATURA_DADOS_EXTRAIDOS "
                f"WHERE numero_instalacao IS NOT NULL AND mes_referencia IS NOT NULL")
    g = collections.defaultdict(dict)
    for r in cur.fetchall():
        d = dict(zip(["cod_empresa", "numero_instalacao", "distribuidora"] + _COLS, r))
        mm = _mes(d["mes_referencia"])
        if mm is not None:
            g[(d["cod_empresa"], str(d["numero_instalacao"]).strip())].setdefault(mm, d)
    tot = collections.Counter()
    with open(saida, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["uid", "distribuidora", "mes", "posto", "anterior", "atual", "atual_mes_anterior",
                    "anterior_mes_seguinte", "situacao", "desinverter"])
        for ms in g.values():
            for mm, d in ms.items():
                ant = ms.get(mm - 1) if _mesmo_medidor(d, ms.get(mm - 1)) else None
                pos = ms.get(mm + 1) if _mesmo_medidor(d, ms.get(mm + 1)) else None
                troca = corrigir_trocadas(d, ant, pos)
                for posto, ca, ct, _ in POSTOS:
                    a, t = _f(d[ca]), _f(d[ct])
                    if a is None or t is None or a == 0:
                        continue
                    la = _eq(a, _f(ant[ct])) if ant else None
                    lp = _eq(t, _f(pos[ca])) if pos else None
                    if la is None and lp is None:
                        continue
                    sit = "ok" if la is not False and lp is not False else "quebra"
                    tot[(str(d["distribuidora"])[:40], sit)] += 1
                    tot[("TOTAL", sit)] += 1
                    if sit == "quebra":
                        w.writerow([d["uid"], d["distribuidora"], str(d["mes_referencia"])[:7], posto, a, t,
                                    _f(ant[ct]) if ant else "", _f(pos[ca]) if pos else "",
                                    "quebra com o anterior" if lp is not False else
                                    "quebra com o seguinte" if la is not False else "quebra dos dois lados",
                                    "sim" if ca in troca else ""])
    dists = sorted({k[0] for k in tot}, key=lambda x: -(tot[(x, "ok")] + tot[(x, "quebra")]))
    for d in dists[:26]:
        n = tot[(d, "ok")] + tot[(d, "quebra")]
        print(f"{d:40} {n:7}  fecha {tot[(d, 'ok')] / n:6.1%}  quebras {tot[(d, 'quebra')]}")


if __name__ == "__main__":
    import sys
    if len(sys.argv) >= 3 and sys.argv[1] == "--relatorio":
        relatorio(sys.argv[2])
    else:
        print("uso: python continuidade.py --relatorio saida.csv   (só leitura da PROD)")
