"""O que o gabarito visual traz e o robô não: por caminho de campo, em quantas faturas o gabarito tem valor
e o robô está vazio/ausente. Listas: compara o tamanho (e campos dentro dos objetos da lista).

Uso: python cobertura.py LIGHT [--exemplos 3]
"""
import glob, json, os, sys
from collections import Counter, defaultdict

B = r'C:\usinas_thopen\dados'


def achatar(v, p='', out=None):
    """{'a': {'b': 1}, 'l': [{'x': 2}]} → {'a.b': 1, 'l[]': 1(tamanho), 'l[].x': 2}"""
    if out is None:
        out = {}
    if isinstance(v, dict):
        for k, x in v.items():
            if k in ('colunas_originais', 'conferencias'):
                continue
            achatar(x, f'{p}.{k}' if p else k, out)
    elif isinstance(v, list):
        out[p + '[]'] = len(v)
        for x in v:
            if isinstance(x, dict):
                for k, y in achatar(x).items():
                    if y not in (None, '', [], {}, 0) or isinstance(y, (int, float)) and not isinstance(y, bool):
                        out.setdefault(f'{p}[].{k}', y)
    else:
        out[p] = v
    return out


def vazio(v):
    return v is None or v == '' or v == [] or v == {}


def main(sigla, nex=3):
    falta, tem, ex = Counter(), Counter(), defaultdict(list)
    lista_menor = Counter()
    n = 0
    for p in sorted(glob.glob(os.path.join(B, 'json_robo', '*.json'))):
        fid = os.path.basename(p)[:-5]
        gp = os.path.join(B, 'json', fid + '.json')
        if not os.path.exists(gp):
            continue
        g = json.load(open(gp, encoding='utf-8'))
        if (g.get('documento') or {}).get('distribuidora_sigla') != sigla or \
                (g.get('extracao') or {}).get('versao_formato', 1) < 2:
            continue
        r = json.load(open(p, encoding='utf-8'))
        n += 1
        fg, fr = achatar(g), achatar(r)
        for k, v in fg.items():
            if k.startswith('extracao.') or k.startswith('id_fatura') or k.startswith('arquivo.'):
                continue
            if k.endswith('[]'):
                if v and fr.get(k, 0) < v:
                    lista_menor[k] += 1
                    if len(ex[k]) < nex:
                        ex[k].append(f'{fid}: gabarito {v} × robô {fr.get(k, 0)}')
                continue
            if vazio(v) or v is False:
                continue
            tem[k] += 1
            if vazio(fr.get(k)):
                falta[k] += 1
                if len(ex[k]) < nex:
                    ex[k].append(f'{fid}: {str(v)[:150]!r}')
    print(f'{sigla}: {n} faturas (gabarito v2)\n')
    print('Campos que o gabarito tem e o robô não:')
    for k, c in falta.most_common():
        print(f'  {c:3d}/{tem[k]:<3d} {k}')
        for e in ex[k]:
            print('          ', e)
    print('\nListas menores no robô:')
    for k, c in lista_menor.most_common():
        print(f'  {c:3d} {k}')
        for e in ex[k]:
            print('          ', e)


if __name__ == '__main__':
    a = sys.argv[1:]
    main(a[0].upper(), int(a[a.index('--exemplos') + 1]) if '--exemplos' in a else 3)
