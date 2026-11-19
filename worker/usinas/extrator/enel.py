"""Parser determinístico das faturas Enel (RJ/Ampla e CE; testar SP) — DANF3E, A4 estendido (595×985).

Cabeçalhos em texto. Medições (x<277) e itens (x≥277) ficam lado a lado na mesma faixa de altura; colunas pela borda
direita dos cabeçalhos. Chave de acesso impressa em grupos de 4 dígitos. Tributos, grandezas contratadas e histórico
no rodapé da p1; avisos em "MENSAGENS IMPORTANTES"; notificação de contas vencidas.
"""
import re

from base import data_br, e_numero, esqueleto, linhas, mes_ano, num, palavras, posto_de, sem_acento

NOME = 'enel_v1'
CNPJS = {'33.050.071/0001-58': ('ENEL RJ', 'Ampla Energia e Serviços S. A.'),
         '07.047.251/0001-70': ('ENEL CE', 'Companhia Energética do Ceará - COELCE'),
         '61.695.227/0001-93': ('ENEL SP', 'Eletropaulo Metropolitana Eletricidade de São Paulo S.A.')}
MES3 = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ']


def _grupos(ws, tol=2.2):
    out = []
    for w in sorted(ws, key=lambda w: w.y1):
        if out and abs(out[-1][0] - w.y1) <= tol:
            out[-1][1].append(w)
        else:
            out.append([w.y1, [w]])
    return [(y, sorted(g, key=lambda w: w.x0)) for y, g in out]


def _txt(g):
    return ' '.join(w.t for w in g)


def _chave(texto):
    t = re.sub(r'(?<=\d) (?=\d{4}\b)', '', texto)
    m = re.search(r'\b(\d{44})\b', t)
    return m[1] if m else None


def _cnpj(ch):
    c = ch[6:20]
    return f'{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:]}'


def detecta(texto, doc=None):
    ch = _chave(texto)
    return bool(ch) and _cnpj(ch) in CNPJS and 'Itens de Fatura' in texto


def _col(ws, anc, tol=12):
    out = {}
    for w in ws:
        k = min(anc, key=lambda c: abs(anc[c] - w.x1))
        if abs(anc[k] - w.x1) <= tol:
            out[k] = w.t if k not in out else out[k] + ' ' + w.t
    return out


def _posto(t):
    d = ' ' + sem_acento(t).upper().replace('-', ' ') + ' '
    if re.search(r' (FORA PONTA|F PONTA|FP|HFP) ', d):
        return 'FORA_PONTA'
    if re.search(r' (PONTA|HP|P) ', d):
        return 'PONTA'
    if re.search(r' (INTERMEDIARIO|INT) ', d):
        return 'INTERMEDIARIO'
    return None


def componente_de(desc):
    d = sem_acento(desc).upper()
    if d.startswith('DIF.'):
        return 'AJUSTE', None
    if 'INJ' in d or 'COMPENS' in d and 'GD' in d:
        return 'GD_INJETADA', _posto(d)
    if 'GERACAO' in d or 'TUSDG' in d.replace(' ', ''):
        return ('DEMANDA_GERACAO_ULTRAPASSAGEM' if 'ULTRA' in d else 'DEMANDA_GERACAO'), 'GERACAO'
    if 'ULTRA' in d:
        return 'DEMANDA_ULTRAPASSAGEM', _posto(d) or 'UNICO'
    if 'REAT' in d or 'UFER' in d or 'DMCR' in d:
        return 'REATIVO_EXCEDENTE', _posto(d)
    if 'DEMANDA' in d or d.startswith('DIF. DEM'):
        return 'DEMANDA', _posto(d) or 'UNICO'
    if 'BAND' in d:
        return 'BANDEIRA', _posto(d)
    if re.search(r'\bTE\b', d):
        return 'TE', _posto(d)
    if 'TUSD' in d:
        return 'TUSD', _posto(d)
    if 'CONSUMO' in d or 'ENERGIA' in d:
        return 'CONSUMO', _posto(d)
    if 'CIP' in re.split(r'[\s-]+', d) or 'ILUM' in d or 'COSIP' in d:
        return 'ILUMINACAO_PUBLICA', None
    if d.startswith('MULTA'):
        return 'MULTA', None
    if d.startswith('JUROS'):
        return 'JUROS', None
    if 'ATUALIZ' in d or 'CORRECAO' in d or 'IPCA' in d or 'IGP' in d:
        return 'ATUALIZACAO_MONETARIA', None
    if re.search(r'\b(DIC|FIC|DMIC|DICRI)\b', d):
        return 'COMPENSACAO_CONTINUIDADE', None
    if 'PARCEL' in d:
        return 'PARCELAMENTO', None
    if 'DEVOL' in d or 'ESTORNO' in d or 'RESTITUI' in d:
        return 'ESTORNO', None
    return 'AJUSTE', None


def parse(doc, fid, caminho):
    d = esqueleto(fid, caminho, len(doc))
    d['extracao']['parser'] = NOME
    d['totais'].update({'tributos_retidos': None, 'subtotais': [], 'totais_colunas': [], 'total_nota_fiscal': None})
    d['gd'] = {'uc_geradora': None, 'conta_contrato_geradora': None, 'participacao_pct': None, 'lancamentos': [],
               'rateio_beneficiarias': []}
    d['informacoes_consumo'] = []
    d['entrega'] = {'endereco_correspondencia': None, 'unidade_entrega': None, 'sequencia': None,
                    'endereco_devolucao': None}
    pags = [(i + 1, palavras(p)) for i, p in enumerate(doc)]
    brutos = [p.get_text() for p in doc]
    t1 = pags[0][1]
    ls = linhas(t1)
    tj = ' '.join(l.texto() for l in ls)
    d['extracao']['paginas_lidas'] = [p for p, _ in pags]
    d['extracao']['paginas'] = [{'pagina': p, 'tipo': 'conteudo' if t else 'em_branco', 'repete_pagina': None}
                                for p, t in pags]
    doc_, nf, uc_, tit, ref, tot = (d['documento'], d['documento']['nota_fiscal'], d['unidade_consumidora'],
                                    d['titular'], d['referencia'], d['totais'])
    ch = _chave(tj)
    nf['chave_acesso'] = ch
    if ch:
        doc_['distribuidora_cnpj'] = _cnpj(ch)
        doc_['distribuidora_sigla'], doc_['distribuidora'] = CNPJS.get(doc_['distribuidora_cnpj'], ('OUTRA', None))
    em = [l.texto(110, 340).strip() for l in ls if l.y < 45 and l.entre(110, 340)]
    if em:
        doc_['distribuidora'] = em[0]
        doc_['distribuidora_endereco'] = ' '.join(em[1:-1]) or None
        mm = re.search(r'Inscri\S+ Estadual:\s*(\S+)', em[-1])
        doc_['distribuidora_ie'] = mm[1] if mm else None
    nf['modelo'] = 'DANF3E - DOCUMENTO AUXILIAR DA NOTA FISCAL DE ENERGIA ELÉTRICA ELETRÔNICA'
    # classificação / fornecimento / datas de leitura
    lc = next((l for l in ls if 70 < l.y < 90 and l.entre(36, 200)), None)
    if lc:
        cls = lc.texto(36, 200).strip()
        nxt = next((l for l in ls if lc.y < l.y < lc.y + 12 and l.entre(36, 200) and not l.entre(36, 200)[0].t.isupper()), None)
        if nxt:
            cls += ' ' + nxt.texto(36, 200).strip()
        uc_['classificacao'] = cls
        mm = re.match(r'([AB]\d\w?)\s+(\S+(?:\s+(?:VERDE|AZUL))?)\s+(.*)', cls)
        if mm:
            uc_['subgrupo'], uc_['grupo'] = mm[1], mm[1][0]
            uc_['tipo_tarifa_impresso'] = f'{mm[1]} {mm[2]}'
            mod = mm[2].upper()
            uc_['modalidade_tarifaria'] = 'Verde' if 'VERDE' in mod else 'Azul' if 'AZUL' in mod else \
                'Convencional' if 'CONV' in mod else 'Branca' if 'BRANCA' in mod else None
            p = mm[3].split(None, 1)
            uc_['classe'] = p[0] if p else None
            uc_['subclasse'] = p[1] if len(p) > 1 else None
        mm = re.search(r'(MONOF\S+|BIF\S+|TRIF\S+)', lc.texto(190, 300))
        uc_['tipo_fornecimento'] = mm[1] if mm else None
        mm = re.search(r'(\d\d/\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+(\d{1,3})\s+(\d\d/\d\d/\d{4})',
                       ' '.join(l.texto(300, 600) for l in ls if lc.y - 2 < l.y < lc.y + 6))
        if mm:
            ref.update({'leitura_anterior': data_br(mm[1]), 'leitura_atual': data_br(mm[2]),
                        'dias_faturados': int(mm[3]), 'proxima_leitura': data_br(mm[4])})
    # titular (x≈40, y 90–125)
    bt = [l.texto(36, 180).strip() for l in ls if 90 < l.y < 125 and l.entre(36, 180)]
    bt = [x for x in bt if x and not x.startswith('CPF/CNPJ')]
    if bt:
        tit['nome'] = bt[0]
        cep = next((x for x in bt if x.startswith('CEP:')), None)
        if cep:
            tit['cep'] = (re.search(r'\d{5}-\d{3}', cep) or [None])[0]
        end = [x for x in bt[1:] if x is not cep]
        if end:
            mm = re.match(r'(.*?)\s+([A-Z]{2})$', end[-1])
            if mm:
                tit['uf'] = mm[2]
                tit['cidade'] = ' '.join(mm[1].split()[1:]) or mm[1]
            tit['endereco'] = ' '.join(end[:-1]) or None
        uc_['endereco'] = ' '.join(bt[1:]) or None
    lab = next((w for w in t1 if w.t == 'CPF/CNPJ:' and w.x0 < 60), None)  # linhas a 2 pt: ler pela altura da palavra
    if lab:
        mesma = sorted([w for w in t1 if abs(w.y1 - lab.y1) < 1 and lab.x1 < w.x0 < 200], key=lambda w: w.x0)
        s_ = _txt(mesma)
        mm = re.match(r'(\S+)(?:\s+INSC\s+EST:\s*(\S+))?', s_)
        if mm:
            tit['cnpj_cpf'], tit['inscricao_estadual'] = mm[1], mm[2]
    mm = re.search(r'\b(\d\.\d{3}\.\d{3}\.\d{3}-\d{2}|\d{6,10})\b',
                   ' '.join(l.texto(200, 270) for l in ls if 105 < l.y < 116))
    uc_['uc'] = uc_['instalacao'] = mm[1] if mm else None
    mm = re.search(r'\b(\d{6,10})\b', ' '.join(l.texto(200, 270) for l in ls if 136 < l.y < 146))
    tit['codigo_cliente'] = mm[1] if mm else None
    # NF3e
    tn = ' '.join(l.texto(340, 600) for l in ls if 100 < l.y < 155)
    mm = re.search(r'NOTA FISCAL N\S*\s*(\d+)\s*-\s*S\S*RIE\s*(\S+)\s*/\s*DATA DE EMISS\S*:?\s*(\d\d/\d\d/\d{4})', tn)
    if mm:
        nf.update({'numero': mm[1], 'serie': mm[2], 'data_emissao': data_br(mm[3])})
        ref['data_emissao'] = data_br(mm[3])
    mm = re.search(r'(https?://\S+)', tn)
    nf['url_consulta'] = mm[1] if mm else None
    mm = re.search(r'Protocolo de autoriza\S*\s*(\d+)\s*-\s*(\d\d/\d\d/\d{4})\s*\S+\s*(\d\d:\d\d:\d\d)', tn)
    if mm:
        nf['protocolo_autorizacao'], nf['data_autorizacao'] = mm[1], f'{data_br(mm[2])}T{mm[3]}'
    mm = re.search(r'CFOP\s+(\d{4}):?\s*(.*?)(?:\s+Data de|$)', tn)
    nf['cfop'] = f'{mm[1]}: {mm[2].strip()}' if mm else None
    mm = re.search(r'Data de apresenta\S+:\s*(\d\d/\d\d/\d{4})', tn)
    nf['data_apresentacao'] = data_br(mm[1]) if mm else None
    # mês / vencimento / total
    mm = re.search(r'\b(\d\d)/(\d{4})\s+(\d\d/\d\d/\d{4})\s+R\$\s*([\d.]+,\d\d)', tj)
    if mm:
        ref['mes_referencia'] = f'{mm[2]}-{mm[1]}'
        ref['data_vencimento'] = data_br(mm[3])
        tot['total_a_pagar'] = num(mm[4])
    else:  # variante com blocos rotulados: MÊS/ANO, VENCIMENTO, UC / TOTAL A PAGAR (coluna x≈200–260)
        col = sorted([w for w in t1 if 60 < w.x0 < 270 and 95 < w.y1 < 185], key=lambda w: w.y1)
        def apos(rot, rx):
            lab = next((w for w in col if w.t == rot), None)
            if lab:
                return next((w.t for w in col if lab.y1 < w.y1 < lab.y1 + 20 and abs(w.x0 - lab.x0) < 25
                             and re.fullmatch(rx, w.t)), None)
            return None
        ma = apos('MÊS/ANO', r'\d\d/\d{4}')
        if ma:
            ref['mes_referencia'] = f'{ma[3:]}-{ma[:2]}'
        vc = apos('VENCIMENTO', r'\d\d/\d\d/\d{4}')
        ref['data_vencimento'] = data_br(vc) if vc else None
        mt = re.search(r'R\$\s*([\d.]+,\d\d)', ' '.join(l.texto(195, 270) for l in ls if 165 < l.y < 185))
        tot['total_a_pagar'] = num(mm_[1]) if (mm_ := mt) else None
        mu = re.search(r'\b(\d{6,10})\s*/\s*(\d{6,10})\b', ' '.join(l.texto(60, 160) for l in ls if 165 < l.y < 185))
        if mu:
            uc_['uc'], uc_['instalacao'] = mu[1], mu[2]
    _itens(t1, d)
    _medicoes(t1, d)
    _rodape(t1, d, ls)
    _mensagens(t1, d)
    _pagamento(brutos, d)
    ilum = [i['valor'] for i in d['itens'] if i['componente'] == 'ILUMINACAO_PUBLICA' and i['valor'] is not None]
    tot['valor_cosip_cip'] = round(sum(ilum), 2) if ilum else None
    uc_['geracao']['e_gerador'] = any(i['componente'] in ('DEMANDA_GERACAO', 'GD_INJETADA') for i in d['itens']) or \
        any(m['grandeza'] and 'Injetada' in m['grandeza'] for m in d['medicoes'])
    return d


def _itens(t1, d):
    cab = next((w for w in t1 if w.t == 'Itens' and w.x0 > 250), None)
    if not cab:
        return
    x_it = cab.x0 - 3
    hdr = [w for w in t1 if cab.y1 - 3 < w.y1 < cab.y1 + 8 and w.x0 >= x_it]

    def x1(pred):
        c = [w.x1 for w in hdr if pred(w.t)]
        return max(c) if c else None
    anc = {'quant': x1(lambda t: t.startswith('Quant')), 'preco': x1(lambda t: t == 'tributos'),
           'valor': None, 'pis_cofins': x1(lambda t: 'COFINS' in t),
           'base_icms': max((w.x1 for w in hdr if w.t == '(R$)' and 455 < w.x0 < 485), default=None),
           'aliquota_icms': x1(lambda t: t.startswith('Alíquota') or t == '(%)' or (t == 'ICMS' and False)),
           'icms': None, 'tarifa': x1(lambda t: t == 'Tarifa')}
    v = next((w for w in hdr if w.t == 'Valor'), None)
    if v:
        anc['valor'] = next((w.x1 for w in hdr if w.t == '(R$)' and abs(w.y1 - v.y1) < 2 and w.x0 > v.x0), v.x1 + 9)
    xi = [w for w in hdr if w.t == 'ICMS' and 505 < w.x0 < 525]
    anc['icms'] = xi[0].x1 if xi else 521
    if anc['aliquota_icms'] is None:
        anc['aliquota_icms'] = 502
    anc = {k: v for k, v in anc.items() if v}
    tot_w = next((w for w in t1 if w.t == 'TOTAL' and w.x0 >= x_it and w.y1 > cab.y1), None)
    y_fim = tot_w.y1 + 1 if tot_w else 470
    y_ini = max(w.y1 for w in hdr) + 1
    tot = d['totais']
    for y, g in _grupos([w for w in t1 if y_ini < w.y1 < y_fim and w.x0 >= x_it]):
        desc = [w for w in g if w.x0 < 355 and not e_numero(w.t)]
        nums = [w for w in g if w.x0 >= 370 and e_numero(w.t)]
        unid = next((w.t for w in g if 355 <= w.x0 < 372 and not e_numero(w.t)), None)
        t = _txt(desc)
        cols = _col(nums, anc)
        if not t:
            continue
        if t == 'TOTAL':
            rot = {'valor': 'Valor (R$)', 'pis_cofins': 'PIS/COFINS (R$)', 'base_icms': 'Base Calc. ICMS (R$)',
                   'icms': 'ICMS (R$)'}
            for k, v in cols.items():
                if k in rot:
                    tot['totais_colunas'].append({'pagina': 1, 'coluna': rot[k], 'valor': num(v)})
            tot['total_nota_fiscal'] = num(cols.get('valor'))
            continue
        if t.startswith('Subtotal'):
            vv = num(cols.get('valor'))
            tot['subtotais'].append({'pagina': 1, 'rotulo': t, 'valor': vv})
            if t == 'Subtotal Faturamento':
                tot['subtotal'] = vv
            continue
        if not nums:
            d['itens'].append(_item(t, {}, None, 'INFO', None))
            continue
        comp, posto = componente_de(t)
        it = _item(t, cols, unid, comp, posto)
        d['itens'].append(it)


def _item(desc, cols, unid, comp, posto):
    a = cols.get('aliquota_icms')
    return {'pagina': 1, 'secao_impressa': 'Itens de Fatura', 'codigo': None, 'descricao': desc, 'mes_ref': None,
            'componente': comp, 'posto': posto, 'quantidade_registrada': None,
            'quantidade_faturada': num(cols.get('quant')), 'unidade': unid,
            'tarifa_com_tributos': num(cols.get('preco'), ponto_decimal=True),
            'tarifa_sem_tributos': num(cols.get('tarifa'), ponto_decimal=True), 'valor': num(cols.get('valor')),
            'valor_sem_tributos': None, 'base_icms': num(cols.get('base_icms')),
            'aliquota_icms': num(a) if a else None, 'icms': num(cols.get('icms')), 'base_pis_cofins': None,
            'aliquota_pis': None, 'pis': None, 'aliquota_cofins': None, 'cofins': None,
            'pis_cofins': num(cols.get('pis_cofins')), 'nf_referencia': None,
            'colunas_originais': {'Itens de Fatura': desc, 'Unid.': unid, **cols}}


def _y_tributos(t1):
    """Altura do cabeçalho TRIBUTOS do rodapé (a faixa varia entre versões do layout)."""
    w = next((w for w in t1 if w.t == 'TRIBUTOS' and w.x0 < 60 and w.y1 > 300), None)
    if w:
        return w.y1
    w = next((w for w in t1 if w.t == 'PIS/PASEP' and w.x0 < 60 and w.y1 > 300), None)
    return w.y1 - 18 if w else 474


def _y_historico(t1):
    """Altura do cabeçalho MÊS/ANO do histórico de faturamento."""
    w = next((w for w in t1 if w.t == 'MÊS/ANO' and w.x0 < 60 and w.y1 > 450), None)
    return w.y1 if w else 547


def _medicoes(t1, d):
    gz = next((w for w in t1 if w.t == 'Grandezas' and w.x0 < 130 and 250 < w.y1 < 400), None)
    gy = gz.y1 if gz else 308
    hdr = [w for w in t1 if w.t in ('Anterior', 'Atual', 'Medidor', 'kWh', 'Tarifários') and gy - 1 < w.y1 < gy + 9
           and 120 < w.x0 < 270]
    xa = {w.t: w.x1 for w in hdr}
    anc = {'leitura_anterior': xa.get('Anterior', 189), 'leitura_atual': xa.get('Atual', 214),
           'constante': xa.get('Medidor', 242), 'consumo': xa.get('kWh', 257) + 8}
    y_ini = max([w.y1 for w in hdr] + [gy + 4])
    y_fim = _y_tributos(t1) - 2
    for y, g in _grupos([w for w in t1 if y_ini < w.y1 < y_fim and w.x0 < 272]):
        if not re.fullmatch(r'\d{6,}(-\w+)*', g[0].t) or g[0].x0 > 50:
            continue
        med = g[0].t
        gr = _txt([w for w in g[1:] if w.x0 < 130])
        po = _txt([w for w in g[1:] if 130 <= w.x0 < 165])
        cols = _col([w for w in g if w.x0 >= 165 and e_numero(w.t)], anc, tol=10)
        un = gr.split('-')[-1] if '-' in gr else None
        d['medicoes'].append({'pagina': 1, 'tabela_origem': 'DADOS DE MEDIÇÃO', 'medidor': med, 'grandeza': gr,
                              'posto': _posto(po), 'leitura_anterior': num(cols.get('leitura_anterior')),
                              'leitura_atual': num(cols.get('leitura_atual')),
                              'constante': num(cols.get('constante'), ponto_decimal=True), 'perdas_pct': None,
                              'ajuste': None, 'consumo': num(cols.get('consumo')), 'consumo_faturado': None,
                              'fator_potencia': None, 'ajuste_fator_potencia': None, 'unidade': un,
                              'data_hora_registro': None, 'leitura_arredondada': False,
                              'colunas_originais': {'Medidor': med, 'Grandezas': gr, 'Postos Tarifários': po, **cols}})
        if med not in d['unidade_consumidora']['medidor']:
            d['unidade_consumidora']['medidor'].append(med)


def _rodape(t1, d, ls):
    yt, yh = _y_tributos(t1), _y_historico(t1)
    for y, g in _grupos([w for w in t1 if yt + 2 < w.y1 < yt + 56 and w.x0 < 180]):
        s = _txt(g)
        mm = re.match(r'(PIS/PASEP|COFINS|ICMS)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)$', s)
        if mm:
            d['tributos'].append({'pagina': 1, 'tributo': 'PIS' if mm[1].startswith('PIS') else mm[1],
                                  'base': num(mm[2]), 'aliquota': num(mm[3]), 'valor': num(mm[4]), 'retido': False,
                                  'colunas_originais': {'Tributo': mm[1], 'Base': mm[2], 'Alíquota': mm[3],
                                                        'Valor': mm[4]}})
    tab = {'pagina': 1, 'nome': 'GRANDEZAS CONTRATADAS', 'linhas': []}
    for y, g in _grupos([w for w in t1 if yt + 2 < w.y1 < yt + 56 and 180 <= w.x0 < 292]):
        s = _txt(g)
        mm = re.match(r'(DEMANDA.*?)\s+([\d.,]+)$', s)
        if mm:
            rot = mm[1]
            ger = 'GER' in rot
            tab['linhas'].append({'colunas_originais': {rot: mm[2]}})
            d['demanda'].append({'pagina': 1, 'tipo': 'geracao' if ger else 'consumo',
                                 'posto': 'GERACAO' if ger else (_posto(rot) or 'UNICO'), 'contratada_kw': num(mm[2]),
                                 'medida_kw': None, 'faturada_kw': None, 'faturada_ultrapassagem_kw': None,
                                 'nao_consumida_kw': None, 'data_hora': None, 'rotulo': rot,
                                 'colunas_originais': {rot: mm[2]}})
    if tab['linhas']:
        d['tabelas_complementares'].append(tab)
    # histórico (MÊS/ANO | Demanda kW ponta/fora | Consumo faturado ponta/fora | nº dias)
    for y, g in _grupos([w for w in t1 if yh + 8 < w.y1 < yh + 103 and w.x0 < 285]):
        ws = [w.t for w in g]
        if len(ws) >= 8 and ws[0] in MES3 and ws[1] == '/' and re.fullmatch(r'\d{4}', ws[2]):
            mes = f'{ws[2]}-{MES3.index(ws[0]) + 1:02d}'
            vs = ws[3:8]
            for (serie, posto, un), v in zip((('demanda', 'PONTA', 'kW'), ('demanda', 'FORA_PONTA', 'kW'),
                                              ('consumo', 'PONTA', 'kWh'), ('consumo', 'FORA_PONTA', 'kWh'),
                                              ('dias', None, 'dias')), vs):
                d['historico'].append({'pagina': 1, 'mes': mes, 'serie': serie, 'posto': posto, 'valor': num(v),
                                       'unidade': un, 'unidade_original': un, 'faturado_pela_media': False})
    d['historico_formato'] = 'tabela' if d['historico'] else 'ausente'
    # notificação de contas vencidas (Mes/Ano | Valor)
    for y, g in _grupos([w for w in t1 if yh + 13 < w.y1 < yh + 103 and 290 < w.x0 < 380]):
        s = _txt(g)
        mm = re.match(r'(\d\d/\d{4})\s+([\d.]+,\d\d)$', s)
        if mm:
            d['debitos_pendentes'] = d.get('debitos_pendentes') or []
            d['debitos_pendentes'].append({'referencia': f'{mm[1][3:]}-{mm[1][:2]}', 'vencimento': None,
                                           'data_reaviso': None, 'valor': num(mm[2])})


def _mensagens(t1, d):
    ini = next((w for w in t1 if w.t == 'MENSAGENS' and w.y1 < 300), None)
    fim = next((w for w in t1 if w.t == 'DADOS' and w.y1 > (ini.y1 if ini else 0)), None)
    if ini and fim:
        y_ini, y_fim = ini.y1 + 3, fim.y0 - 2
    else:  # variante (ENEL CE) com os títulos das caixas em imagem: começa em "Períodos:", termina no cabeçalho da medição
        per = next((w for w in t1 if w.t == 'Períodos:' and w.x0 < 80 and 180 < w.y1 < 300), None)
        gz = next((w for w in t1 if w.t == 'Grandezas' and w.x0 < 130 and per and per.y1 < w.y1 < 400), None)
        if not per or not gz:
            return
        y_ini, y_fim = per.y0 - 1, gz.y0 - 12
    bloco = ' '.join(_txt(g) for y, g in _grupos([w for w in t1 if y_ini < w.y1 < y_fim]))
    for parte in re.split(r'\s*\|\|\|\s*|(?<=\.)\s+(?=Band\. Tarif|Conforme|Expirar|Saldo|Unidade|Esta|A partir|Informamos)', bloco):
        if parte.strip():
            d['mensagens'].append({'pagina': 1, 'texto': parte.strip()})
    for m in re.finditer(r'Band\. Tarif\.:\s*(\w+)\s*:\s*(\d\d)/(\d\d)\s*-\s*(\d\d)/(\d\d)', bloco):
        ano = (d['referencia']['mes_referencia'] or '0000')[:4]
        cor = sem_acento(m[1]).upper()
        d['bandeiras'].append({'pagina': 1, 'cor': 'VERMELHA_1' if cor == 'VERMELHA' else cor,
                               'inicio': f'{ano}-{m[3]}-{m[2]}', 'fim': f'{ano}-{m[5]}-{m[4]}', 'dias': None})
    _gd_mensagens(bloco, d)


# Bloco de GD nas MENSAGENS: "Energia Injetada HFP no mês: 532.980.00 kWh. Saldo utilizado no mês: … kWh.
# Saldo atualizado: … kWh. Créditos a Expirar no próximo mês: 0 kWh." e o mesmo para HP. O posto vem do
# "(HFP)/(HP)" do próprio rótulo ou, se não houver, do último "Energia Injetada HFP/HP" lido antes.
_GD_RX = re.compile(
    r'(?P<rot>(?P<inj>Energia\s+Injetada(?:\s+(?P<pinj>HFP|HP|FP|FORA\s+PONTA|PONTA))?\s+no\s+m\S+s)'
    r'|(?P<uti>Saldo\s+utilizado\s+no\s+m\S+s)'
    r'|(?P<atu>Saldo\s+atualizado)'
    r'|(?P<exp>Cr\S+ditos\s+a\s+Expirar\s+no\s+pr\S+ximo\s+m\S+s|Expirar\s+no\s+pr\S+ximo\s+m\S+s))'
    r'\s*(?:\((?P<pp>HFP|HP|FP|P)\))?\s*:\s*(?P<v>-?\d[\d.,]*)\s*kWh', re.I)


def _kwh_msg(s):
    """Número do texto da mensagem; a Enel imprime '532.980.00' (ponto como separador decimal nos 2 últimos)."""
    s = s.rstrip('.')
    if ',' in s:
        return num(s)
    if re.fullmatch(r'-?\d{1,3}(\.\d{3})*\.\d{1,2}', s):
        i = s.rfind('.')
        return float(s[:i].replace('.', '') + '.' + s[i + 1:])
    if re.fullmatch(r'-?\d{1,3}(\.\d{3})+', s):
        return float(s.replace('.', ''))
    try:
        return float(s)
    except ValueError:
        return None


def _gd_mensagens(bloco, d):
    tipos = {'inj': 'injetada', 'uti': 'compensada', 'atu': 'saldo_atual', 'exp': 'a_expirar'}
    posto = None
    for m in _GD_RX.finditer(bloco):
        tipo = next(tipos[k] for k in tipos if m[k])
        if m['inj']:
            posto = _posto(m['pinj']) if m['pinj'] else None
        p = _posto(m['pp']) if m['pp'] else posto
        d['gd']['lancamentos'].append({'pagina': 1, 'tipo': tipo, 'posto': p, 'kwh': _kwh_msg(m['v']),
                                       'mes_ref': None,
                                       'ref_expiracao': 'próximo mês' if tipo == 'a_expirar' else None,
                                       'unidade_impressa': 'kWh', 'rotulo': re.sub(r'\s+', ' ', m[0]).strip()})


def _pagamento(brutos, d):
    pag = d['pagamento']
    tudo = re.sub(r'\s+', ' ', ' '.join(brutos))
    m = re.search(r'\b(\d{12} \d{12} \d{12} \d{12}|\d{11}-\d \d{11}-\d \d{11}-\d \d{11}-\d|\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14})\b', tudo)
    pag['linha_digitavel'] = m[1] if m else None
    m = re.search(r'Fatura No\. No\. da UC .*? (\d{16}) (\d{5,})', tudo)
    if m:
        pag['numero_fatura'] = m[1]
    m = re.search(r'No\. de Controle .*? (\d{12})\b', tudo)
    if m:
        d['documento']['controle'] = m[1]
    if 'CADASTRO DÉBITO AUTOMÁTICO' in tudo:
        d['outros'].append({'pagina': 1, 'secao_impressa': 'CADASTRO DÉBITO AUTOMÁTICO', 'rotulo': 'aviso',
                            'valor': 'Se você ainda não tem débito automático, cadastra-se na sua instituição bancária'})
    pag['boleto'] = None
    pag.setdefault('conta_recebedora', None)
