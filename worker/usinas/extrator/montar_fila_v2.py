"""Fila v2: amostra visual (gabarito) por layout grande + layouts pequenos inteiros; o resto fica para o robô.
Saída: dados/lotes_v2.json (lotes de 5 p/ o workflow visual) e dados/reservadas_robo.json ({grupo: [ids]})."""
import csv, json, os
from collections import defaultdict
B = r'C:\usinas_thopen\dados'
AMOSTRA, MIN_GRANDE = 20, 40
cl = {r['id_fatura']: r['dist'] for r in csv.DictReader(open(os.path.join(B, 'classificacao.csv'), encoding='utf-8'), delimiter=';')}
man = {r['id_fatura']: r for r in csv.DictReader(open(os.path.join(B, 'manifesto.csv'), encoding='utf-8-sig'), delimiter=';')}
lotes = json.load(open(os.path.join(B, 'lotes.json')))
feitos = {f[:-5] for f in os.listdir(os.path.join(B, 'json')) if f.endswith('.json')}
grupos = defaultdict(list)
for x in (x for l in lotes for x in l if x not in feitos):
    g = cl[x] if cl[x] != 'OUTRA' else (man[x]['distribuidora_indice'] or 'SEM_INDICE')
    grupos[g].append(x)
visual, robo = [], {}
for g, ids in sorted(grupos.items(), key=lambda kv: -len(kv[1])):
    ids.sort(key=lambda i: man[i]['caminho'])
    if len(ids) < MIN_GRANDE:
        visual += ids
        print(f'{g:35s} {len(ids):4d}  todas visual')
        continue
    passo = len(ids) / AMOSTRA
    amostra = [ids[int(k * passo)] for k in range(AMOSTRA)]  # espalhada por usina/mês
    visual += amostra
    robo[g] = [i for i in ids if i not in set(amostra)]
    print(f'{g:35s} {len(ids):4d}  amostra {AMOSTRA}, robô {len(robo[g])}')
lv2 = [visual[i:i + 5] for i in range(0, len(visual), 5)]
json.dump(lv2, open(os.path.join(B, 'lotes_v2.json'), 'w'))
json.dump(robo, open(os.path.join(B, 'reservadas_robo.json'), 'w'), indent=1)
print('visual', len(visual), 'faturas em', len(lv2), 'lotes; robô', sum(map(len, robo.values())))
