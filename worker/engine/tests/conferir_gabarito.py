# -*- coding: utf-8 -*-
"""Compara a extração (JSON por fatura) com o gabarito conferido visualmente.
uso: python conferir_gabarito.py <gabarito.json> <pasta_json_extraido> [--md saida.md]"""
import collections, glob, io, json, os, re, sys

gab = json.load(io.open(sys.argv[1], encoding="utf-8"))
pasta = sys.argv[2]
md_out = sys.argv[sys.argv.index("--md") + 1] if "--md" in sys.argv else None

from conferir_gabarito_lib import CAMPOS, NUM, ID, vazio, num, so_alnum, confere  # noqa: E402


tot = {c: collections.Counter() for c in CAMPOS}
por_fatura = []
erros = collections.defaultdict(list)
for nome, verdade in sorted(gab.items()):
    f = os.path.join(pasta, nome[:-4] + ".json")
    if not os.path.exists(f):
        continue
    r = json.load(io.open(f, encoding="utf-8"))
    col = r.get("colunas") or {}
    res = {}
    for c in CAMPOS:
        v = confere(c, verdade.get(c), col.get(c), col)
        if v is None:
            continue
        res[c] = v
        tot[c][v] += 1
        if v != "certo":
            erros[c].append((nome, verdade.get(c), col.get(c) if not vazio(col.get(c)) else "—"))
    n = len(res)
    ok = sum(1 for v in res.values() if v == "certo")
    por_fatura.append((nome, verdade.get("_layout", ""), r.get("gate"), r.get("score"), ok, n, res))

linhas = []
linhas.append(f"# Conferência visual × extração — {len(por_fatura)} faturas\n")
linhas.append("## Por campo (certo / errado / vazio)\n")
linhas.append("| campo | certo | errado | vazio | acerto |")
linhas.append("|---|---:|---:|---:|---:|")
for c in CAMPOS:
    t = tot[c]; n = sum(t.values())
    if n:
        linhas.append(f"| {c} | {t['certo']} | {t['errado']} | {t['vazio']} | {100*t['certo']/n:.0f}% |")
linhas.append("\n## Por fatura\n")
linhas.append("| fatura | layout | gate | score | certos |")
linhas.append("|---|---|---|---:|---:|")
for nome, lay, gate, score, ok, n, res in por_fatura:
    linhas.append(f"| {nome} | {lay} | {gate} | {score} | {ok}/{n} |")
linhas.append("\n## Erros e vazios, por campo (fatura: verdade → extraído)\n")
for c in CAMPOS:
    if erros[c]:
        linhas.append(f"\n### {c}")
        for nome, v, e in erros[c]:
            linhas.append(f"- {nome}: {v} → {e}")
txt = "\n".join(linhas)
if md_out:
    io.open(md_out, "w", encoding="utf-8").write(txt)
print("\n".join(linhas[:40]))
print("...")
# gate × acerto real
print("\n## gate do validador × acerto medido")
for gate in ("aprovado", "revisao", "reprovado"):
    ls = [(ok, n) for _, _, g, _, ok, n, _ in por_fatura if g == gate]
    if ls:
        print(f"{gate:10s} {len(ls):2d} faturas  acerto médio {100*sum(o for o,_ in ls)/sum(n for _,n in ls):.0f}%")
