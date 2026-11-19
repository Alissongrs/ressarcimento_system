"""Roda o robô nas faturas e grava em dados/json_robo/<id>.json (separado do gabarito visual). Não grava no banco.

Uso: python rodar.py LIGHT gabarito   → só as faturas que já têm gabarito visual (para medir acerto)
     python rodar.py LIGHT reservadas → as reservadas para o robô (dados/reservadas_robo.json)
     python rodar.py LIGHT <id> [<id>...]
Cada saída passa pelo mesmo validar.conferir do fluxo visual; a fatura só é "aceita" se der OK.
"""
import csv, glob, json, os, sys, traceback

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, r'C:\usinas_thopen\tools')
import base
import equatorial
import equatorial_a4
import cpfl
import cpfl_antigo
import enel
import enel_sp
import energisa
import edp
import neoenergia
import neoenergia_bsb
import light
import fit
import elektro
import copel_gd
import copel
from validar import conferir

B = r'C:\usinas_thopen'
PARSERS = {'LIGHT': [light], 'EQUATORIAL GO': [equatorial, equatorial_a4], 'EQUATORIAL AL': [equatorial_a4],
           'EQUATORIAL PA': [equatorial_a4], 'EQUATORIAL MA': [equatorial_a4], 'EQUATORIAL PI': [equatorial_a4],
           'CPFL PAULISTA': [cpfl, cpfl_antigo], 'CPFL PIRATININGA': [cpfl, cpfl_antigo],
           'CPFL SANTA CRUZ': [cpfl, cpfl_antigo], 'CPFL': [cpfl, cpfl_antigo],
           'ENEL RJ': [enel], 'ENEL SP': [enel_sp, enel], 'ENEL CE': [enel],
           'ENERGISA MT': [energisa], 'ENERGISA MS': [energisa], 'ENERGISA TO': [energisa], 'EMT': [energisa],
           'EMS': [energisa], 'ETO': [energisa], 'EDP SP': [edp, energisa], 'EDP ES': [edp],
           'NEOENERGIA BSB': [neoenergia, neoenergia_bsb], 'NEOENERGIA RN': [neoenergia, neoenergia_bsb], 'NEOENERGIA BRASILIA': [neoenergia, neoenergia_bsb],
           'NEOENERGIA COSERN': [neoenergia, neoenergia_bsb], 'Neoenergia Cosern': [neoenergia, neoenergia_bsb],
           'NEOENERGIA BRASÍLIA': [neoenergia, neoenergia_bsb],
           'FIT': [fit], 'COPEL': [copel, copel_gd], 'NEOENERGIA ELEKTRO': [elektro], 'Neoenergia Elektro': [elektro], 'FIT (DEMONSTRATIVO DE GERAÇÃO)': [fit]}


TODOS = [light, equatorial, equatorial_a4, cpfl, cpfl_antigo, enel_sp, enel, energisa, edp, neoenergia, neoenergia_bsb, fit, elektro, copel_gd, copel]


def main(sigla, alvo):
    # AUTO: tenta todos os parsers pela detecção (faturas fora dos grupos do índice)
    mods = TODOS if sigla == 'AUTO' else PARSERS[sigla]
    man = {r['id_fatura']: r for r in csv.DictReader(open(os.path.join(B, 'dados', 'manifesto.csv'), encoding='utf-8-sig'), delimiter=';')}
    if alvo == ['resto']:
        # nem gabarito visual nem reservada; duplicatas ficam de fora (vale a original)
        gab = {os.path.basename(p)[:-5] for p in glob.glob(os.path.join(B, 'dados', 'json', '*.json'))}
        res = json.load(open(os.path.join(B, 'dados', 'reservadas_robo.json'), encoding='utf-8'))
        res = {f for v in res.values() for f in v}
        ids = [f for f, r in man.items() if f not in gab and f not in res and not r['duplicata_de']]
    elif alvo == ['gabarito']:
        ids = []
        for p in glob.glob(os.path.join(B, 'dados', 'json', '*.json')):
            g = json.load(open(p, encoding='utf-8'))
            if (g.get('documento') or {}).get('distribuidora_sigla') == sigla:
                ids.append(g['id_fatura'])
    elif alvo == ['reservadas']:
        res = json.load(open(os.path.join(B, 'dados', 'reservadas_robo.json'), encoding='utf-8'))
        ids = next((v for k, v in res.items() if k.upper() == sigla), [])
    else:
        ids = alvo
    out_dir = os.path.join(B, 'dados', 'json_robo')
    os.makedirs(out_dir, exist_ok=True)
    aceitas, rejeitadas, erros = 0, [], []
    for fid in ids:
        cam = man[fid]['caminho']
        try:
            with base.abrir(os.path.join(B, 'faturas_originais', cam)) as doc:
                txt = doc[0].get_text() if len(doc) else ''
                mod = next((m for m in mods if (m.detecta(txt) if m is light else m.detecta(txt, doc))), None)
                if mod is None:
                    rejeitadas.append((fid, 'layout não reconhecido'))
                    continue
                d = mod.parse(doc, fid, cam)
        except Exception as e:
            erros.append((fid, f'{type(e).__name__}: {e}'))
            traceback.print_exc(limit=2)
            continue
        if d['documento'].get('tipo') == 'demonstrativo_gd':
            # não é fatura: vale a conferência de continuidade dos saldos e a geradora/referência
            cs = d['extracao']['conferencia_saldos']
            probs = [f'{cs["n_falhas"]} quebra(s) de continuidade de saldo'] if cs['n_falhas'] else []
            probs += [f'{c} vazio' for c, v in (('gd.uc_geradora', d['gd']['uc_geradora']),
                                                 ('referencia.mes_referencia', d['referencia']['mes_referencia'])) if not v]
            d['extracao'].update({'conferencias': cs, 'aceita': not probs, 'problemas': probs})
            json.dump(d, open(os.path.join(out_dir, fid + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            if d['extracao']['aceita']:
                aceitas += 1
            else:
                rejeitadas.append((fid, '; '.join(probs)[:200]))
            continue
        probs, conf = conferir(d)
        d['extracao']['conferencias'] = conf
        d['extracao']['aceita'] = not probs
        d['extracao']['problemas'] = probs
        if not d['itens']:
            d['extracao']['aceita'] = False
            d['extracao']['problemas'].append('nenhum item lido')
        # campos essenciais: sem eles a fatura não serve para as regras
        essenciais = ['referencia.mes_referencia', 'totais.total_a_pagar', 'documento.nota_fiscal.numero',
                      'unidade_consumidora.uc', 'referencia.leitura_atual']
        if d['documento'].get('tipo') == 'demonstrativo_fit':
            essenciais.remove('unidade_consumidora.uc')  # demonstrativo da FIT não tem UC
        for campo in essenciais:
            v = d
            for k in campo.split('.'):
                v = (v or {}).get(k)
            if v is None:
                d['extracao']['aceita'] = False
                d['extracao']['problemas'].append(f'{campo} vazio')
        json.dump(d, open(os.path.join(out_dir, fid + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        if d['extracao']['aceita']:
            aceitas += 1
        else:
            rejeitadas.append((fid, '; '.join(d['extracao']['problemas'])[:200]))
    print(f'{sigla}: {len(ids)} faturas → {aceitas} aceitas pela conferência, {len(rejeitadas)} rejeitadas, {len(erros)} erros')
    for fid, m in rejeitadas[:15]:
        print('  rejeitada', fid, m)
    for fid, m in erros[:15]:
        print('  erro', fid, m)


if __name__ == '__main__':
    main(sys.argv[1].upper(), sys.argv[2:])
