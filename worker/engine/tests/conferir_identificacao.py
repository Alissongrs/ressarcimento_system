# -*- coding: utf-8 -*-
"""Mede identificacao.identificar contra o gabarito visual. uso: teste_ident.py <engine> <pdfs> <gabarito.json> [-v]"""
import glob, io, json, os, re, sys, collections
eng, pdfs, gab_p = sys.argv[1:4]
verb = "-v" in sys.argv
sys.path.insert(0, eng)
import identificacao as ide

gab = json.load(io.open(gab_p, encoding="utf-8"))
cat = ide.catalogo()
MAPA = {"distribuidora": "distribuidora", "codigo_uc": "uc", "mes_referencia": "mes", "valor_total_fatura": "total",
        "data_vencimento": "vencimento", "data_emissao_nf": "emissao", "dias_faturados": "dias",
        "grupo_tarifario": ("classificacao", "grupo"), "modalidade_tarifaria": ("classificacao", "modalidade")}


def alnum(s): return re.sub(r"[^0-9A-Za-z]", "", str(s)).upper().lstrip("0") or "0"


def dist_ok(verdade, r):
    nome = r.get("distribuidora") or ""
    textos = [nome, r.get("distribuidora_sigla") or ""]
    raiz = next((k for k, v in cat.items() if v["nome"] == nome), None)
    if raiz: textos += cat[raiz].get("aliases") or []
    return any(ide.normalizar(verdade) in ide.normalizar(t) for t in textos)


tot = {c: collections.Counter() for c in MAPA}
erros = collections.defaultdict(list)
for nome, v in sorted(gab.items()):
    p = os.path.join(pdfs, nome)
    if not os.path.exists(p) or os.path.getsize(p) == 0: continue
    r = ide.identificar(open(p, "rb").read())
    linha = []
    for campo, chave in MAPA.items():
        verdade = v.get(campo)
        if verdade is None: continue
        alts = verdade if isinstance(verdade, list) else [verdade]
        ext = r.get(chave[0], {}).get(chave[1]) if isinstance(chave, tuple) else r.get(chave)
        if campo == "codigo_uc" and ext is None: ext = r.get("cliente")
        if ext in (None, ""):
            res = "vazio"
        elif campo == "distribuidora":
            res = "certo" if any(dist_ok(a, r) for a in alts) else "errado"
        elif campo == "codigo_uc":
            cands = [r.get("uc"), r.get("cliente")]
            res = "certo" if any(c and alnum(c) == alnum(a) for c in cands for a in alts) else "errado"
        elif campo == "mes_referencia":
            res = "certo" if any(str(ext)[:7] == str(a)[:7] for a in alts) else "errado"
        elif campo in ("valor_total_fatura", "dias_faturados"):
            res = "certo" if any(abs(float(ext) - float(a)) <= 0.011 for a in alts) else "errado"
        elif campo == "grupo_tarifario":
            res = "certo" if str(ext)[:1].upper() == str(verdade)[:1].upper() else "errado"
        elif campo == "modalidade_tarifaria":
            res = "certo" if ide.normalizar(str(verdade)) in ide.normalizar(str(ext)) else "errado"
        else:
            res = "certo" if any(str(ext)[:10] == str(a)[:10] for a in alts) else "errado"
        tot[campo][res] += 1
        if res != "certo":
            erros[campo].append(f"{nome}: {verdade} -> {ext}  [{r.get('_origem', {}).get(chave if isinstance(chave, str) else chave[0], '')}]")
        linha.append(f"{campo[:6]}={res[0]}")
    if verb: print(nome, " ".join(linha))
print("\ncampo                 certo errado vazio")
for c in MAPA:
    t = tot[c]; print(f"{c:22s} {t['certo']:4d} {t['errado']:5d} {t['vazio']:5d}")
for c in MAPA:
    if erros[c]:
        print(f"\n## {c}")
        for e in erros[c]: print(" -", e)
