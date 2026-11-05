"""Atualiza backend/handlers/data/aneel_componentes.json.gz — componentes da tarifa homologada pela ANEEL usados
pelas regras F45 (CDE Covid), F46 (CDE Escassez) e F56 (Fio B da GD II) — handlers/regras_componentes.go.

Fonte: dados abertos da ANEEL, conjunto "Componentes Tarifárias" (um CSV por ano, ~0,5–1 GB cada).

Uso (de qualquer pasta; só leitura da internet, não toca no banco):
    python -X utf8 ferramentas/aneel_componentes/montar.py --pasta C:\\temp\\aneel 2022 2023 2024 2025 2026

Baixa os CSVs que faltam na pasta, reduz às linhas de interesse (Tarifa de Aplicação, detalhe "Não se aplica",
componentes TE_CDE_COVID, TUSD_CDE_COVID e TUSD_FioB) e grava o .json.gz. Depois: deploy.
"""
import argparse, csv, collections, gzip, json, os, sys, urllib.request

API = 'https://dadosabertos.aneel.gov.br/api/3/action/package_show?id=componentes-tarifarias'
COMP = {'TE_CDE_COVID': 'te_cde', 'TUSD_CDE_COVID': 'tusd_cde', 'TUSD_FioB': 'fiob'}
DEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'backend', 'handlers', 'data', 'aneel_componentes.json.gz')


def urls_por_ano():
    with urllib.request.urlopen(API, timeout=120) as r:
        pk = json.load(r)['result']
    out = {}
    for res in pk['resources']:
        n = res.get('name') or ''
        if n.endswith('.csv') and n.startswith('componentes-tarifarias-'):
            out[n[len('componentes-tarifarias-'):-4]] = res['url']
    return out


def baixar(url, dst):
    tmp = dst + '.part'
    with urllib.request.urlopen(url, timeout=600) as r, open(tmp, 'wb') as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
    os.replace(tmp, dst)


def ler(fn, linhas, rehs):
    enc = 'utf-8'
    with open(fn, 'rb') as f:
        if b'\xc3' not in f.read(4000):
            enc = 'latin-1'
    with open(fn, encoding=enc, errors='replace', newline='') as f:
        for r in csv.DictReader(f, delimiter=';'):
            c = COMP.get(r.get('DscComponenteTarifario'))
            if not c or 'Aplica' not in r['DscBaseTarifaria'] or r['DscDetalheConsumidor'] != 'Não se aplica':
                continue
            un = r['DscUnidade']
            if un not in ('R$/MWh', 'R$/kW') or (un == 'R$/kW' and c != 'fiob'):
                continue
            cls = '' if r['DscClasseConsumidor'] == 'Não se aplica' else r['DscClasseConsumidor']
            sub = '' if r['DscSubClasseConsumidor'] == 'Não se aplica' else r['DscSubClasseConsumidor']
            posto = {'Ponta': 'P', 'Fora ponta': 'FP', 'Não se aplica': ''}.get(r['DscPostoTarifario'], r['DscPostoTarifario'][:12])
            k = (r['NumCPFCNPJ'][:8], r['DatInicioVigencia'], r['DatFimVigencia'], r['DscSubGrupoTarifario'], r['DscModalidadeTarifaria'],
                 cls, sub, posto, 'kW' if un == 'R$/kW' else 'MWh')
            rehs[k] = r['DscResolucaoHomologatoria'].replace('RESOLUÇÃO HOMOLOGATÓRIA', 'REH')[:40]
            linhas[k][c] = round(float(r['VlrComponenteTarifario'].replace(',', '.') or 0), 5)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pasta', required=True)
    ap.add_argument('anos', nargs='+')
    a = ap.parse_args()
    os.makedirs(a.pasta, exist_ok=True)
    urls = None
    linhas, rehs = collections.defaultdict(dict), {}
    for ano in a.anos:
        fn = os.path.join(a.pasta, f'componentes-tarifarias-{ano}.csv')
        if not os.path.exists(fn):
            urls = urls or urls_por_ano()
            if ano not in urls:
                sys.exit(f'ano {ano} não está no catálogo da ANEEL')
            print('baixando', ano, flush=True)
            baixar(urls[ano], fn)
        print('lendo', ano, flush=True)
        ler(fn, linhas, rehs)
    out = [{'c': k[0], 'i': k[1], 'f': k[2], 'sg': k[3], 'm': k[4], 'cl': k[5], 'sc': k[6], 'p': k[7], 'u': k[8], 'r': rehs[k], **d}
           for k, d in linhas.items()]
    out.sort(key=lambda x: (x['c'], x['i'], x['sg'], x['m'], x['cl'], x['sc'], x['p'], x['u']))
    dado = {'fonte': 'ANEEL dados abertos — Componentes Tarifárias (Tarifa de Aplicação), detalhe "Não se aplica"',
            'anos': sorted({x['i'][:4] for x in out}), 'linhas': out}
    with gzip.open(DEST, 'wt', encoding='utf-8') as g:
        json.dump(dado, g, ensure_ascii=False, separators=(',', ':'))
    print(len(out), 'linhas →', os.path.abspath(DEST), os.path.getsize(DEST), 'bytes')


if __name__ == '__main__':
    main()
