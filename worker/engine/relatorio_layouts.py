# -*- coding: utf-8 -*-
"""Acerto por layout × campo na base inteira (24/11/2026) — onde escrever/consertar o próximo parser. SÓ LEITURA.

Sem gabarito para 190 mil faturas, mede por sinais independentes do extrator:
  vazio        — campo-chave em branco (total, mês, instalação, kWh, ICMS, leituras no Grupo A/B com tabela)
  sefaz        — só informativo: valor_total_sefaz é o BRUTO da NF3e (antes de compensação/retenção) e fica sempre
                 acima do total a pagar em Light/Equatorial/EDP — não entra em "com problema"
  continuidade — leitura não emenda com o mês anterior/seguinte da mesma instalação (continuidade.py)
  gate         — validador reprovou
"layout_desconhecido" é subdividido por impressão digital: distribuidora + quais rótulos-âncora aparecem no texto.

    python relatorio_layouts.py saida.csv [--quebras quebras.csv]
"""
from __future__ import annotations

import collections
import csv
import hashlib
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ROTULOS = ["leitura anterior", "leitura atual", "constante", "medidor", "fora ponta", "ponta", "demanda", "bandeira",
           "icms", "pis", "cofins", "total a pagar", "valor a pagar", "vencimento", "nota fiscal", "danf3e",
           "chave de acesso", "codigo de barras", "historico", "injetada", "compensada", "reativo", "cip", "iluminacao"]
CAMPOS = ["valor_total_fatura", "mes_referencia", "numero_instalacao", "kwh_total", "icms_valor", "leit_atu_ativa_fponta",
          "leit_atu_ativa_ponta", "constante_k", "numero_medidor", "data_vencimento"]


def _norm(t: str) -> str:
    import unicodedata
    return unicodedata.normalize("NFKD", t or "").encode("ascii", "ignore").decode().lower()


def digital(dist, texto) -> str:
    t = _norm(texto)
    bits = "".join("1" if r in t else "0" for r in ROTULOS)
    return f"{str(dist or '?')[:28]}#{hashlib.md5(bits.encode()).hexdigest()[:6]}"


def main(saida: str, quebras: str | None = None) -> None:
    import mysql.connector
    from db_env import conexao
    c = mysql.connector.connect(**conexao("DB_APP_URL"))
    cur = c.cursor()
    qb = collections.Counter()
    if quebras and os.path.exists(quebras):
        with open(quebras, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f, delimiter=";"):
                qb[r["uid"]] += 1
    cur.execute("SELECT MIN(id), MAX(id) FROM FATURA_DADOS_EXTRAIDOS")
    lo, hi = cur.fetchone()
    agg: dict = collections.defaultdict(lambda: collections.Counter())
    exemplo: dict = {}
    sel = ", ".join(["uid", "layout_template_id", "distribuidora", "subgrupo_tarifario", "validador_gate",
                     "valor_total_sefaz", "consumo_ativo_sefaz_kwh"] + CAMPOS)
    passo = 20000
    for a in range(lo, hi + 1, passo):
        cur.execute(f"SELECT {sel}, CASE WHEN layout_template_id IS NULL OR layout_template_id='layout_desconhecido' "
                    f"THEN LEFT(texto_plumber, 6000) END FROM FATURA_DADOS_EXTRAIDOS WHERE id BETWEEN %s AND %s", (a, a + passo - 1))
        for row in cur.fetchall():
            d = dict(zip(sel.split(", ") + ["_txt"], row))
            lay = d["layout_template_id"] or "layout_desconhecido"
            if lay == "layout_desconhecido":
                lay = "?" + digital(d["distribuidora"], d["_txt"] or "")
            g = agg[lay]
            g["n"] += 1
            prob = False
            grupo_a = str(d["subgrupo_tarifario"] or "").upper().startswith("A")
            for campo in CAMPOS:
                if campo == "leit_atu_ativa_ponta" and not grupo_a:
                    continue
                if d[campo] in (None, ""):
                    g["vazio:" + campo] += 1
                    prob = prob or campo in ("valor_total_fatura", "mes_referencia", "numero_instalacao", "kwh_total")
            if d["valor_total_sefaz"] is not None and d["valor_total_fatura"] is not None:
                g["sefaz_total_n"] += 1
                if abs(float(d["valor_total_sefaz"]) - float(d["valor_total_fatura"])) > 0.02:
                    g["sefaz_total_div"] += 1
            if d["consumo_ativo_sefaz_kwh"] is not None and d["kwh_total"] is not None and float(d["consumo_ativo_sefaz_kwh"]) > 0:
                g["sefaz_kwh_n"] += 1
                if abs(float(d["consumo_ativo_sefaz_kwh"]) - float(d["kwh_total"])) > max(1.0, 0.005 * float(d["consumo_ativo_sefaz_kwh"])):
                    g["sefaz_kwh_div"] += 1
            if qb.get(d["uid"]):
                g["quebra_leitura"] += 1
                prob = True
            if str(d["validador_gate"] or "") == "reprovado":
                g["gate_reprovado"] += 1
            if prob:
                g["com_problema"] += 1
                exemplo.setdefault(lay, d["uid"])
            g["dist:" + str(d["distribuidora"] or "?")[:40]] += 1
    linhas = []
    for lay, g in agg.items():
        n = g["n"]
        dist = max(((k[5:], v) for k, v in g.items() if k.startswith("dist:")), key=lambda x: x[1])[0]
        linhas.append({
            "layout": lay, "distribuidora": dist, "faturas": n, "com_problema": g["com_problema"],
            "pct_problema": round(100 * g["com_problema"] / n, 1),
            **{f"vazio_{c}": round(100 * g["vazio:" + c] / n, 1) for c in CAMPOS},
            "sefaz_total_div": f"{g['sefaz_total_div']}/{g['sefaz_total_n']}",
            "sefaz_kwh_div": f"{g['sefaz_kwh_div']}/{g['sefaz_kwh_n']}",
            "quebra_leitura": g["quebra_leitura"], "gate_reprovado": g["gate_reprovado"], "exemplo_uid": exemplo.get(lay, ""),
        })
    linhas.sort(key=lambda r: -r["com_problema"])
    with open(saida, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(linhas[0]), delimiter=";")
        w.writeheader()
        w.writerows(linhas)
    tot = sum(r["faturas"] for r in linhas)
    prob = sum(r["com_problema"] for r in linhas)
    print(f"{len(linhas)} layouts/grupos, {tot} faturas, {prob} com problema ({100 * prob / tot:.1f}%)")
    print(f"{'layout':52} {'dist':24} {'fat':>6} {'probl':>6} {'%':>5} {'vz_tot':>6} {'vz_kwh':>6} {'sefaz_tot':>10} {'sefaz_kwh':>10} {'quebra':>6}")
    for r in linhas[:30]:
        print(f"{r['layout'][:52]:52} {r['distribuidora'][:24]:24} {r['faturas']:6} {r['com_problema']:6} {r['pct_problema']:5} "
              f"{r['vazio_valor_total_fatura']:6} {r['vazio_kwh_total']:6} {r['sefaz_total_div']:>10} {r['sefaz_kwh_div']:>10} {r['quebra_leitura']:6}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
    else:
        main(sys.argv[1], sys.argv[sys.argv.index("--quebras") + 1] if "--quebras" in sys.argv else None)
