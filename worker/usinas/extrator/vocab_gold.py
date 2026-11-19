"""Mostra como o gabarito visual classificou cada descrição de item (componente/posto) numa distribuidora.
Uso: python vocab_gold.py LIGHT"""
import glob, json, os, sys, re
from collections import Counter, defaultdict
J = r'C:\usinas_thopen\dados\json'
alvo = sys.argv[1].upper()
m = defaultdict(Counter)
for p in glob.glob(os.path.join(J, '*.json')):
    d = json.load(open(p, encoding='utf-8'))
    if (d.get('documento') or {}).get('distribuidora_sigla', '') != alvo:
        continue
    for it in d.get('itens') or []:
        desc = re.sub(r'\d+[.,]?\d*', '#', it.get('descricao') or '')
        m[desc][(it.get('componente'), it.get('posto'))] += 1
for desc, c in sorted(m.items(), key=lambda kv: -sum(kv[1].values())):
    print(f'{sum(c.values()):4d}  {desc[:60]:60s} {dict(c)}')
