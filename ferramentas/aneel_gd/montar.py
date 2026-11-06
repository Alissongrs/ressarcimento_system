r"""Atualiza backend/handlers/data/aneel_gd_usinas.json.gz — empreendimentos de geração distribuída da ANEEL nos
municípios das usinas (FATURA_USINA.pasta_usina), usados pela regra F63 (enquadramento GD I/II/III) —
handlers/regras_enquadramento.go.

Fonte: dados abertos da ANEEL, "Relação de empreendimentos de Geração Distribuída" (zip de ~110 MB, CSV de 1,5 GB).
A lista NÃO tem o nº da UC: a regra casa usina × empreendimento por município + CNPJ do titular + potência.

Uso (a partir de ressarcimento_system/, com DB_APP_URL no backend/.env; o banco só é LIDO):
    python -X utf8 ferramentas/aneel_gd/montar.py --zip C:\temp\gd.zip      # baixa o zip se não existir
Depois: deploy.
"""
import argparse, csv, gzip, io, json, os, re, sys, unicodedata, urllib.request, zipfile

URL = ('https://dadosabertos.aneel.gov.br/dataset/5e0fafd2-21b9-4d5b-b622-40438d40aba2/resource/'
       'b1bd71e7-d0ad-4214-9053-cbd58e9564a7/download/empreendimento-geracao-distribuida.zip')
AQUI = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.join(AQUI, '..', '..', 'backend', 'handlers', 'data', 'aneel_gd_usinas.json.gz')
# mesma regra do Go (municipioUsina): "UFV Diamantino 1.2" → DIAMANTINO
RX_USINA = re.compile(r'^(?:UFV|CGH|PCH|UTE|EOL|BIO\w*)\s+(.+?)\s+\d+(?:\.\d+)?$')


def norm(s):
    return unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().upper().strip()


def municipios():
    sys.path.insert(0, os.path.join(AQUI, '..', 'continuidade'))
    from importar import conectar
    c = conectar(); k = c.cursor()
    k.execute('SELECT DISTINCT pasta_usina FROM FATURA_USINA WHERE pasta_usina IS NOT NULL')
    out = set()
    for (p,) in k.fetchall():
        m = RX_USINA.match(p.strip())
        if m:
            out.add(norm(m.group(1)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--zip', required=True)
    a = ap.parse_args()
    if not os.path.exists(a.zip):
        print('baixando', URL)
        with urllib.request.urlopen(URL, timeout=900) as r, open(a.zip + '.part', 'wb') as f:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
        os.replace(a.zip + '.part', a.zip)
    mun = municipios()
    z = zipfile.ZipFile(a.zip)
    f = io.TextIOWrapper(z.open(z.infolist()[0]), encoding='utf-8', errors='replace', newline='')
    out = []
    for r in csv.DictReader(f, delimiter=';'):
        p = float((r['MdaPotenciaInstaladaKW'] or '0').replace(',', '.'))
        if p < 75 or norm(r['NomMunicipio']) not in mun:  # só minigeração (> 75 kW)
            continue
        out.append({'c': r['CodEmpreendimento'], 'a': r['SigAgente'], 'uf': r['SigUF'], 'm': norm(r['NomMunicipio']),
                    'd': re.sub(r'\D', '', r['NumCPFCNPJ']), 't': r['DthAtualizaCadastralEmpreend'][:10],
                    'mo': r['DscModalidadeHabilitado'], 'q': int(r['QtdUCRecebeCredito'] or 0), 'p': p,
                    'n': r['NomTitularEmpreendimento'][:60], 'ref': r['DatGeracaoConjuntoDados']})
    with gzip.open(DEST, 'wt', encoding='utf-8') as g:
        json.dump(out, g, ensure_ascii=False, separators=(',', ':'))
    print('municípios', len(mun), '· empreendimentos', len(out), '→', os.path.abspath(DEST), os.path.getsize(DEST), 'bytes')


if __name__ == '__main__':
    main()
