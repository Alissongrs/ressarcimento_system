"""Mapa instalação/UC → (sigla, CNPJ) da distribuidora, a partir das faturas cujo CNPJ veio da chave de acesso
(json_robo e gabaritos). Usado pelos layouts antigos que não imprimem o emitente em texto.
Uso: python mapa_uc.py  → dados/uc_distribuidora.json"""
import glob, json, os
from collections import Counter, defaultdict

B = r'C:\usinas_thopen\dados'
m = defaultdict(Counter)
for pasta in ('json_robo', 'json'):
    for p in glob.glob(os.path.join(B, pasta, '*.json')):
        try:
            d = json.load(open(p, encoding='utf-8'))
        except Exception:
            continue
        doc = d.get('documento') or {}
        if not (doc.get('nota_fiscal') or {}).get('chave_acesso') or not doc.get('distribuidora_cnpj'):
            continue
        uc = d.get('unidade_consumidora') or {}
        for k in {uc.get('uc'), uc.get('instalacao')} - {None}:
            m[str(k)][(doc.get('distribuidora_sigla'), doc.get('distribuidora_cnpj'))] += 1
out = {k: list(c.most_common(1)[0][0]) for k, c in m.items()}
json.dump(out, open(os.path.join(B, 'uc_distribuidora.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
print(len(out), 'UCs mapeadas')
