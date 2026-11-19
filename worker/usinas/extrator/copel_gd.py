"""Parser do "Demonstrativo UC Geradora / Beneficiária" da Copel (paisagem, uma UC por página, 13 meses de créditos).

Não é fatura: grava documento.tipo = 'demonstrativo_gd', a geradora em gd.uc_geradora, cada UC em
gd.rateio_beneficiarias (crédito utilizado no mês de referência) e o quadro completo de cada UC em
tabelas_complementares. Conferência própria: o Saldo Final de um mês tem de ser o Saldo Anterior do mês seguinte.
"""
import re

from base import data_br, esqueleto, num, palavras
from neoenergia import _grupos, _txt

NOME = 'copel_gd_v1'


def detecta(texto, doc=None):
    return texto.startswith('Demonstrativo UC Geradora / Beneficiária')


ROTULOS = ('Saldo Anterior', 'Cred. Receb. Outra UC', 'Energia Injetada', 'Energia Ativa', 'Credito Utilizado no Mês',
           'Percentual', 'Prioridade', 'Saldo Transferido Outra UC', 'Saldo Final')


def _cabecalho(t):
    """Grupos de colunas (linha dos rótulos) × subcolunas PT/FP/TP/% → lista (nome, posto, x_centro)."""
    sub = sorted([w for w in t if w.t in ('PT', 'FP', 'TP', '%') and 135 < w.y1 < 155], key=lambda w: w.x0)
    if not sub:
        return [], None
    y_sub = max(w.y1 for w in sub if w.t != '%')
    rot = sorted([w for w in t if y_sub - 20 < w.y1 < y_sub - 6 and w.t not in ('%',)], key=lambda w: w.x0)
    grupos, k = [], 0
    while k < len(rot):  # junta as palavras pelos rótulos conhecidos
        for nome in ROTULOS:
            n = len(nome.split())
            if ' '.join(w.t for w in rot[k:k + n]) == nome:
                grupos.append([nome, rot[k].x0, rot[k + n - 1].x1])
                k += n
                break
        else:
            k += 1
    cols = []
    for w in sub:
        cx = (w.x0 + w.x1) / 2
        g = [x for x in grupos if x[1] <= w.x1 + 20]
        nome = g[-1][0] if g else '?'
        cols.append((nome, None if w.t == '%' else w.t, cx))
    # coluna sem subtítulo (Prioridade): centro do rótulo
    for nome, x0, x1 in grupos:
        if not any(c[0] == nome for c in cols):
            cols.append((nome, None, (x0 + x1) / 2))
    cols.sort(key=lambda c: c[2])
    return cols, y_sub


def _campo(t, rot):
    lab = next((w for w in t if w.t == rot and w.x0 < 60), None)
    if not lab:
        return None
    lin = [w for w in t if abs(w.y1 - lab.y1) < 3.5 and 58 < w.x0 < 330]
    s = _txt(sorted(lin, key=lambda w: (round(w.y1), w.x0))).lstrip(': ').strip()
    return s or None


def parse(doc, fid, caminho):
    d = esqueleto(fid, caminho, len(doc))
    d['extracao']['parser'] = NOME
    d['documento']['tipo'] = 'demonstrativo_gd'
    d['documento']['distribuidora'] = 'Copel Distribuição S.A.'
    d['documento']['distribuidora_sigla'] = 'COPEL'
    d['documento']['nota_fiscal']['modelo'] = 'Demonstrativo UC Geradora / Beneficiária'
    d['gd'] = {'uc_geradora': None, 'conta_contrato_geradora': None, 'participacao_pct': None, 'lancamentos': [],
               'rateio_beneficiarias': []}
    d['informacoes_consumo'] = []
    d['entrega'] = {'endereco_correspondencia': None, 'unidade_entrega': None, 'sequencia': None,
                    'endereco_devolucao': None}
    d['totais'].update({'tributos_retidos': None, 'subtotais': [], 'totais_colunas': [], 'total_nota_fiscal': None})
    d['extracao']['paginas_lidas'] = list(range(1, len(doc) + 1))
    d['extracao']['paginas'] = []
    falhas, checadas = [], 0
    for i, pg in enumerate(doc):
        np_ = i + 1
        t = palavras(pg)
        tx = re.sub(r'\s+', ' ', pg.get_text())
        mm = re.search(r'UC Conces\.:\s*(\d+)', tx) or re.search(r'UC\.\s*:\s*(\d+)', tx)
        if not mm:
            d['extracao']['paginas'].append({'pagina': np_, 'tipo': 'em_branco', 'repete_pagina': None})
            continue
        d['extracao']['paginas'].append({'pagina': np_, 'tipo': 'conteudo', 'repete_pagina': None})
        uc = mm[1]
        papel = 'geradora' if 'UC Geradora - expressos' in tx else 'beneficiaria'
        mg = re.search(r'Dados originados da geradora UC:\s*(?:UC Conces\.:|UC\.\s*:?)?\s*(\d+)', tx)
        if mg and not d['gd']['uc_geradora']:
            d['gd']['uc_geradora'] = mg[1]
        me = re.search(r'Emitido em\s*:\s*(\d\d/\d\d/\d{4})', tx)
        if me and not d['referencia']['data_emissao']:
            d['referencia']['data_emissao'] = d['documento']['nota_fiscal']['data_emissao'] = data_br(me[1])
        info = {'UC': uc, 'Papel': papel, 'Nome': _campo(t, 'Nome'), 'Endereço': _campo(t, 'Endereço'),
                'Bairro': _campo(t, 'Bairro'), 'Cidade': _campo(t, 'Cidade')}
        mm = re.search(r'Tipo da Fase\s*:\s*(\S+)', tx)
        info['Tipo da Fase'] = mm[1] if mm else None
        mm = re.search(r'Valor do Custo de Disp\. Kwh\s*:\s*(\d+)?', tx)
        info['Custo de Disponibilidade (kWh)'] = mm[1] if mm and mm[1] else None
        mm = re.search(r'Etapa\s*:\s*(\d+)', tx)
        info['Etapa'] = mm[1] if mm else None
        mm = re.search(r'(\d+) em (\d\d/\d\d/\d{4})', tx)
        info['Saldo a expirar'] = f'{mm[1]} em {mm[2]}' if mm else ('UC sem saldo a expirar' if 'sem saldo a expirar' in tx else None)
        cols, y_sub = _cabecalho(t)
        linhas = []
        if cols:
            for y, g in _grupos([w for w in t if y_sub + 4 < w.y1 < y_sub + 200]):
                if not re.fullmatch(r'\d\d/\d{4}', g[0].t) or g[0].x0 > 45:
                    continue
                reg = {'Referência': g[0].t}
                for w in g[1:]:
                    if not re.fullmatch(r'-?[\d.]*\d|\.\d+|-?\d+,\d+', w.t):
                        continue
                    c = min(cols, key=lambda c: abs(c[2] - (w.x0 + w.x1) / 2))
                    reg[f'{c[0]} {c[1]}'.strip() if c[1] else c[0]] = w.t
                linhas.append(reg)
        d['tabelas_complementares'].append({'pagina': np_, 'nome': f'UC {uc} ({papel}) - {info["Nome"]}',
                                            'linhas': [{'colunas_originais': info}] + [{'colunas_originais': r} for r in linhas]})
        if linhas and not d['referencia']['mes_referencia']:
            m_, a_ = linhas[0]['Referência'].split('/')
            d['referencia']['mes_referencia'] = f'{a_}-{m_}'

        def tot(r, grupo):
            return sum(num(v) or 0 for k, v in r.items() if k.startswith(grupo) and k != grupo + ' %')
        if linhas:
            r0 = linhas[0]
            util = tot(r0, 'Credito Utilizado no Mês')
            pct = next((v for k, v in r0.items() if k.startswith('Percentual')), None)
            d['gd']['rateio_beneficiarias'].append({
                'uc': uc, 'percentual': (float(pct) * 100 if pct and pct.startswith('.') else num(pct)) if pct else None,
                'kwh': util, 'kwh_ponta': num(r0.get('Credito Utilizado no Mês PT')),
                'kwh_fora_ponta': num(r0.get('Credito Utilizado no Mês FP')), 'pagina': np_, 'papel': papel,
                'colunas_originais': r0})
            if papel == 'geradora':
                for po, k in (('PONTA', 'PT'), ('FORA_PONTA', 'FP')):
                    v = num(r0.get(f'Energia Injetada {k}'))
                    if v is not None:
                        d['gd']['lancamentos'].append({'pagina': np_, 'tipo': 'injetada', 'posto': po, 'kwh': v,
                                                       'mes_ref': d['referencia']['mes_referencia'], 'ref_expiracao': None,
                                                       'unidade_impressa': 'kWh', 'rotulo': f'Energia Injetada {k}'})
        # conferência: Saldo Final de m = Saldo Anterior de m+1 (linhas em ordem decrescente)
        for a, b in zip(linhas[1:], linhas[:-1]):
            for k in ('PT', 'FP', 'TP'):
                sf, sa = a.get(f'Saldo Final {k}'), b.get(f'Saldo Anterior {k}')
                if sf is None or sa is None:
                    continue
                checadas += 1
                if num(sf) != num(sa):
                    falhas.append(f'p{np_} UC {uc} {a["Referência"]}→{b["Referência"]} {k}: final {sf} ≠ anterior {sa}')
    if not d['gd']['uc_geradora']:
        d['gd']['uc_geradora'] = next((r['uc'] for r in d['gd']['rateio_beneficiarias'] if r['papel'] == 'geradora'), None)
    d['extracao']['conferencia_saldos'] = {'checadas': checadas, 'falhas': falhas[:50], 'n_falhas': len(falhas)}
    d['unidade_consumidora']['uc'] = d['unidade_consumidora']['instalacao'] = d['gd']['uc_geradora']
    d['unidade_consumidora']['geracao']['e_gerador'] = True
    d['historico_formato'] = 'so_grafico'
    return d
