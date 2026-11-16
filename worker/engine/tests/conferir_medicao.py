# -*- coding: utf-8 -*-
"""Mede o módulo medicao.py sozinho contra o gabarito visual (sem o resto do pipeline).
uso: python conferir_medicao.py <gabarito.json> <pasta_pdfs> [--verbose] [nomes...]

Campos conferidos (quando o gabarito tem): numero_medidor, leit_ant/atu_ativa_fponta, constante_k,
consumo_ativo_ponta/fponta_kwh (faturado do molde; aceita também o medido), demanda_contratada_fponta_kw,
demanda_faturada_fponta_kw (demanda_faturada explícita ou máxima medida fora ponta)."""
import collections, glob, io, json, os, re, sys

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(AQUI))
from medicao import ler_medicao  # noqa: E402

gab = json.load(io.open(sys.argv[1], encoding="utf-8"))
pasta = sys.argv[2]
verbose = "--verbose" in sys.argv
so = {a for a in sys.argv[3:] if not a.startswith("--")}


def num(v):
    try:
        return float(v)
    except Exception:
        return None


def bate(campo, verdade, obtido):
    alts = verdade if isinstance(verdade, list) else [verdade]
    if obtido is None:
        return "vazio"
    for v in alts:
        if campo == "numero_medidor":
            if re.sub(r"[^0-9A-Za-z]", "", str(obtido)).upper().lstrip("0") == re.sub(r"[^0-9A-Za-z]", "", str(v)).upper().lstrip("0"):
                return "certo"
        else:
            a, b = num(obtido), num(v)
            if a is not None and b is not None and (abs(a - b) <= 0.011 or abs(a - b) <= 0.002 * abs(b)):
                return "certo"
    return "errado"


CAMPOS = ["numero_medidor", "leit_ant_ativa_fponta", "leit_atu_ativa_fponta", "constante_k",
          "consumo_ativo_ponta_kwh", "consumo_ativo_fponta_kwh", "demanda_contratada_fponta_kw", "demanda_faturada_fponta_kw"]
tot = {c: collections.Counter() for c in CAMPOS}
moldes = collections.Counter()
for nome, verdade in sorted(gab.items()):
    if so and nome not in so:
        continue
    p = os.path.join(pasta, nome)
    if not os.path.exists(p):
        continue
    med = ler_medicao(io.open(p, "rb").read()) or {}
    moldes[med.get("molde")] += 1
    le = med.get("leituras") or {}
    lfp = le.get("fp") or le.get("unico") or le.get("intermediario") or {}
    fat, medido = med.get("consumo_faturado") or {}, med.get("consumo_medido") or {}
    if not lfp and "p" in le and "consumo_ativo_ponta_kwh" not in verdade:  # grupo B impresso como "Ponta" (Energisa)
        lfp = le["p"]
        fat = {**fat, "unico": fat.get("p")}; fat.pop("p", None)
        medido = {**medido, "unico": medido.get("p")}; medido.pop("p", None)
    fp_fat = sum(v for k, v in fat.items() if k in ("fp", "unico", "intermediario")) if any(k in fat for k in ("fp", "unico", "intermediario")) else None
    fp_med = sum(v for k, v in medido.items() if k in ("fp", "unico", "intermediario")) if any(k in medido for k in ("fp", "unico", "intermediario")) else None
    dm = med.get("demanda_medida") or {}
    df = med.get("demanda_faturada") or {}
    obtido = {
        "numero_medidor": med.get("medidor"),
        "leit_ant_ativa_fponta": lfp.get("ant"), "leit_atu_ativa_fponta": lfp.get("atu"),
        "constante_k": med.get("constante"),
        "consumo_ativo_ponta_kwh": [fat.get("p"), medido.get("p")],
        "consumo_ativo_fponta_kwh": [fp_fat, fp_med],
        "demanda_contratada_fponta_kw": (med.get("demanda_contratada") or {}).get("fp"),
        "demanda_faturada_fponta_kw": df.get("fp") if df else dm.get("fp"),
    }
    res = {}
    for c in CAMPOS:
        if c not in verdade or verdade[c] is None:
            continue
        o = obtido[c]
        if isinstance(o, list):
            rs = [bate(c, verdade[c], x) for x in o if x is not None]
            r = "certo" if "certo" in rs else ("errado" if rs else "vazio")
        else:
            r = bate(c, verdade[c], o)
        res[c] = r
        tot[c][r] += 1
    ok = sum(1 for v in res.values() if v == "certo")
    marca = "" if ok == len(res) else "  <-- " + ", ".join(f"{c}:{verdade[c]}→{obtido[c]}" for c, r in res.items() if r != "certo")
    print(f"{nome:20s} {str(med.get('molde')):9s} val={str(med.get('validado'))[:1]} {med.get('n_ok', 0)}/{med.get('n_registros', 0)} "
          f"{ok}/{len(res)}{marca}")
    if verbose and med.get("obs"):
        for o in med["obs"]:
            print("      obs:", o)
print("\nmoldes:", dict(moldes))
print(f"{'campo':30s} certo errado vazio")
for c in CAMPOS:
    t = tot[c]
    n = sum(t.values())
    if n:
        print(f"{c:30s} {t['certo']:5d} {t['errado']:6d} {t['vazio']:5d}   {100 * t['certo'] / n:.0f}%")
