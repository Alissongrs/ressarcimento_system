"""Parser determinístico das faturas Elektro Redes (Neoenergia Elektro), DANFE NF3e A4 ("DANFELEKA").

p1: emitente (x≈214), titular (x≈14), UC / código do cliente (x≈240), NF3e (x≈397), referência/total/vencimento,
classificação, datas de leitura, itens (descrição e números podem ficar a 1 pt), tributos e grandezas contratadas
(direita), medições, bandeira e saldos de GD (texto), canhoto e linha digitável.
"""
import re

from base import data_br, e_numero, esqueleto, num, palavras, sem_acento
from neoenergia import _col, _grupos, _txt

NOME = 'elektro_v1'
MESES = {'JANEIRO': '01', 'FEVEREIRO': '02', 'MARÇO': '03', 'MARCO': '03', 'ABRIL': '04', 'MAIO': '05', 'JUNHO': '06',
         'JULHO': '07', 'AGOSTO': '08', 'SETEMBRO': '09', 'OUTUBRO': '10', 'NOVEMBRO': '11', 'DEZEMBRO': '12'}
ANC = {'quant': 196, 'preco': 238, 'valor': 275, 'pis_cofins': 309, 'base_icms': 347, 'aliquota_icms': 367,
       'icms': 407, 'tarifa': 442}
ROT = {'quant': 'QUANT.', 'preco': 'PREÇO UNIT. (R$) COM TRIBUTOS', 'valor': 'VALOR (R$)', 'pis_cofins': 'PIS/COFINS (R$)',
       'base_icms': 'BASE CALC. ICMS (R$)', 'aliquota_icms': 'ALÍQ. ICMS', 'icms': 'ICMS (R$)',
       'tarifa': 'TARIFA UNIT. (R$)'}
ANC_MED = {'leitura_anterior': 193, 'leitura_atual': 227, 'constante': 249, 'consumo': 295}


def detecta(texto, doc=None):
    return ('02.328.280/0001-97' in texto or 'ELEKTRO REDES' in texto.upper()) and 'NOTA FISCAL No.' in texto


def _posto(t):
    d = ' ' + sem_acento(t).upper().replace('.', ' ') + ' '
    if re.search(r' (FP|FORA PONTA|FORA) ', d):
        return 'FORA_PONTA'
    if re.search(r' (PT|PONTA) ', d):
        return 'PONTA'
    if re.search(r' TP ', d):
        return 'TODOS'
    return None


def componente_de(desc):
    d = sem_acento(desc).upper()
    po = _posto(d)
    if 'INJ' in d and 'DEMANDA' in d:
        return ('DEMANDA_GERACAO_ULTRAPASSAGEM' if 'ULTRA' in d else 'DEMANDA_GERACAO'), 'GERACAO'
    if d.startswith('ENERGIA INJ'):
        return 'GD_INJETADA', po
    if 'BANDEIRA' in d or 'BAND.' in d:
        return 'BANDEIRA', po
    if 'REAT' in d or 'EXCE' in d:
        return 'REATIVO_EXCEDENTE', po
    if 'ULTRA' in d:
        return 'DEMANDA_ULTRAPASSAGEM', None
    if d.startswith('DEMANDA'):
        return 'DEMANDA', None
    if 'ILUM' in d:
        return 'ILUMINACAO_PUBLICA', None
    if d.startswith('MULTA'):
        return 'MULTA', None
    if d.startswith('JUROS'):
        return 'JUROS', None
    if 'CORRECAO' in d or 'ATUALIZ' in d:
        return 'ATUALIZACAO_MONETARIA', None
    if re.search(r'\b(DIC|FIC|DMIC|DICRI)\b', d):
        return 'COMPENSACAO_CONTINUIDADE', None
    if 'TUSD' in d:
        return 'TUSD', po
    if re.search(r'\bTE\b', d):
        return 'TE', po
    if 'CONSUMO' in d:
        return 'CONSUMO', po
    return 'AJUSTE', None


def _l(ws, y0, y1, x0=0, x1=700):
    return _txt(sorted([w for w in ws if y0 <= w.y1 <= y1 and x0 <= w.x0 < x1], key=lambda w: w.x0))


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
    t1 = [w for w in pags[0][1] if w.t not in ('Segunda', 'Via') or w.x1 - w.x0 < 60]  # marca d'água "Segunda Via"
    d['extracao']['paginas_lidas'] = [p for p, _ in pags]
    d['extracao']['paginas'] = [{'pagina': p, 'tipo': 'conteudo', 'repete_pagina': None} for p, _ in pags]
    doc_, nf, uc_, tit, ref, tot = (d['documento'], d['documento']['nota_fiscal'], d['unidade_consumidora'],
                                    d['titular'], d['referencia'], d['totais'])
    doc_['distribuidora'] = 'Elektro Redes S.A.'
    doc_['distribuidora_sigla'] = 'NEOENERGIA ELEKTRO'
    doc_['distribuidora_cnpj'] = '02.328.280/0001-97'
    em = [_l(t1, y - 2, y + 2, 200, 390) for y in (45, 52, 59, 66)]
    doc_['distribuidora_endereco'] = ' '.join(x for x in em[:2] if x) or None
    mm = re.search(r'ESTADUAL\s+(\d+)', em[3])
    doc_['distribuidora_ie'] = mm[1] if mm else '244868522118'
    doc_['segunda_via'] = 'Segunda Via' in brutos[0]
    nf['modelo'] = 'DANFE - Documento Auxiliar da Nota Fiscal de Energia Elétrica Eletrônica'
    tn = ' '.join(_txt(g) for y, g in _grupos([w for w in t1 if 70 < w.y1 < 140 and w.x0 >= 390]))
    mm = re.search(r'NOTA FISCAL No\.\s*(\d+)\s*-\s*SÉRIE\s*(\w+)\s*DATA DE EMISSÃO:\s*(\d\d/\d\d/\d{2,4})', tn)
    if mm:
        nf['numero'], nf['serie'] = mm[1], mm[2]
        dt = mm[3] if len(mm[3]) == 10 else None
        nf['data_emissao'] = ref['data_emissao'] = data_br(dt) if dt else None
    mm = re.search(r'(https?://\S+)', tn)
    nf['url_consulta'] = mm[1] if mm else None
    mm = re.search(r'Chave de Acesso\s+((?:\d{4}\s?){11})', tn)
    nf['chave_acesso'] = re.sub(r'\s', '', mm[1]) if mm else None
    mm = re.search(r'Autorização:\s*(\d+)\s+(\d\d/\d\d/\d{4})\s+(\d\d:\d\d:\d\d)', tn)
    if mm:
        nf['protocolo_autorizacao'], nf['data_autorizacao'] = mm[1], f'{data_br(mm[2])}T{mm[3]}'
        if not nf['data_emissao']:
            nf['data_emissao'] = ref['data_emissao'] = data_br(mm[2])
    # titular
    cli = [_txt(g) for y, g in _grupos([w for w in t1 if 80 < w.y1 < 150 and w.x0 < 200])]
    if cli:
        k = next((i for i, c in enumerate(cli) if c.startswith('CNPJ') or c.startswith('CPF')), len(cli))
        tit['nome'] = ' '.join(cli[:k])
        if k < len(cli):
            mm = re.search(r'(?:CNPJ|CPF)\s*-\s*(\S+)', cli[k])
            if mm:
                tit['cnpj_cpf_mascarado' if '*' in mm[1] else 'cnpj_cpf'] = mm[1]
            mm = re.search(r'IE:\s*(\S+)', cli[k])
            tit['inscricao_estadual'] = mm[1] if mm else None
            end = cli[k + 1:]
            if end:
                mm = re.match(r'(.*?)\s*-\s*([A-Z]{2})\s*-\s*CEP\s*(\d{5}-\d{3})', end[-1])
                if mm:
                    tit['cidade'], tit['uf'], tit['cep'] = mm[1], mm[2], mm[3]
                    tit['endereco'] = ' '.join(end[:-1]) or None
                else:
                    tit['endereco'] = ' '.join(end)
                uc_['endereco'] = ' '.join(end)
    cods = sorted([w for w in t1 if 200 < w.x0 < 300 and 85 < w.y1 < 150 and
                   re.fullmatch(r'\d{6,}|\d\.\d{3}\.\d{3}\.\d{3}-\d{2}', w.t)], key=lambda w: w.y1)
    if cods:
        uc_['uc'] = uc_['instalacao'] = cods[0].t
    if len(cods) > 1:
        tit['codigo_cliente'] = cods[1].t
    else:  # "Seu Código" do canhoto
        mm = re.search(r'Seu Código.*?Total R\$\s+(\d{6,})\b', re.sub(r'\s+', ' ', brutos[0]))
        if mm and mm[1] != uc_['uc']:
            tit['codigo_cliente'] = mm[1]
    # referência / total / vencimento
    for y, g in _grupos([w for w in t1 if 150 < w.y1 < 185]):
        mm = re.search(r'([A-Za-zçÇ]+)/(\d{4})\s+R\$\s*([\d.]+,\d\d)\s+(\d\d/\d\d/\d{4})', _txt(g))
        if mm and mm[1].upper() in MESES:
            ref['mes_referencia'] = f'{mm[2]}-{MESES[mm[1].upper()]}'
            tot['total_a_pagar'] = num(mm[3])
            ref['data_vencimento'] = data_br(mm[4])
    # classificação / fornecimento
    for y, g in _grupos([w for w in t1 if 180 < w.y1 < 205]):
        s_ = _txt(g)
        mm = re.search(r'\s((?:HORÁRIA|CONVENCIONAL|BRANCA)\b.*)$', s_)
        cl, tf = (s_[:mm.start()].strip(), mm[1]) if mm else (s_, '')
        if cl:
            uc_['classificacao'] = cl
            if ' / ' in cl:
                uc_['classe'], uc_['subclasse'] = cl.split(' / ', 1)
        if tf:
            uc_['tipo_fornecimento'] = tf
            uc_['tipo_tarifa_impresso'] = tf.split(' / ')[0]
            mm = re.search(r'(VERDE|AZUL|CONVENCIONAL|BRANCA)', tf)
            uc_['modalidade_tarifaria'] = mm[1].capitalize() if mm else None
            if tf.startswith('HORÁRIA'):
                uc_['grupo'] = 'A'
    for y, g in _grupos([w for w in t1 if 205 < w.y1 < 250]):
        mm = re.match(r'(\d\d/\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+(\d+)\s+(\d\d/\d\d/\d{4})$', _txt(g))
        if mm:
            ref.update({'leitura_anterior': data_br(mm[1]), 'leitura_atual': data_br(mm[2]),
                        'dias_faturados': int(mm[3]), 'proxima_leitura': data_br(mm[4])})
    uc_['tecnico'] = {'tensao_nominal': None, 'tensao_contratada_v': None, 'tensao_fornecimento_kv': None,
                      'tensao_minima': None, 'tensao_maxima': None, 'faixa_adequada': None,
                      'fator_potencia_referencia': None, 'rtc': None, 'rtp': None, 'constantes': [],
                      'perdas_transformacao_pct': None, 'horario_ponta': None, 'equipamento_medidor': None,
                      'responsavel_iluminacao_publica': None}
    _itens(t1, d)
    _direita(t1, d)
    _medicoes(t1, d)
    _rodape(t1, brutos[0], d)
    for np_, t in pags[1:]:
        if any(w.t == 'INJETADA' for w in t) and not any(w.t == 'NOTA' and w.y1 < 90 for w in t if w.x0 > 390 and False):
            _demonstrativo(t, d, np_)
    for it in d['itens']:
        if it['componente'] == 'GD_INJETADA' and re.search(r'\bTE\b', it['descricao']) and it['quantidade_faturada'] is not None:
            d['gd']['lancamentos'].append({'pagina': 1, 'tipo': 'compensada', 'posto': it['posto'],
                                           'kwh': it['quantidade_faturada'], 'mes_ref': it['mes_ref'], 'ref_expiracao': None,
                                           'unidade_impressa': 'kWh',
                                           'rotulo': f'{it["descricao"]} (itens TE e TUSD com a mesma quantidade)'})
    uc_['geracao']['e_gerador'] = any(i['componente'] in ('GD_INJETADA', 'DEMANDA_GERACAO') for i in d['itens'])
    d['historico_formato'] = 'so_grafico'
    _provas(d)
    return d


def _itens(t1, d):
    ws = [w for w in t1 if 258 < w.y1 < 420 and w.x0 < 450]
    for y, g in _grupos(ws, 1.6):
        unid = next((w.t for w in g if 140 <= w.x0 < 160 and re.fullmatch(r'kWh|kW|kVArh|kVAr', w.t)), None)
        desc = _txt([w for w in g if w.x0 < 140])
        nums = [w for w in g if w.x0 >= 160 and re.fullmatch(r'-?[\d.]*\d,\d+|-?[\d.]+|\d+%', w.t)]
        if not desc and not nums:
            continue
        cols = _col(nums, ANC)
        if not desc and d['itens'] and d['itens'][-1]['_sem_num']:  # números da linha de baixo (1 pt)
            it = d['itens'][-1]
            _preenche(it, cols, unid)
            continue
        if not desc:
            continue
        if not nums and d['itens'] and not d['itens'][-1]['_sem_num'] and False:
            continue
        comp, posto = componente_de(desc)
        mm = re.search(r'(\d\d)/(\d{4})', desc)
        it = {'pagina': 1, 'secao_impressa': 'ITENS DE FATURA', 'codigo': None, 'descricao': desc,
              'mes_ref': f'{mm[2]}-{mm[1]}' if mm else (d['referencia']['mes_referencia'] if comp == 'GD_INJETADA' else None),
              'componente': comp, 'posto': posto, 'quantidade_registrada': None, 'quantidade_faturada': None,
              'unidade': None, 'tarifa_com_tributos': None, 'tarifa_sem_tributos': None, 'valor': None,
              'valor_sem_tributos': None, 'base_icms': None, 'aliquota_icms': None, 'icms': None,
              'base_pis_cofins': None, 'aliquota_pis': None, 'pis': None, 'aliquota_cofins': None, 'cofins': None,
              'pis_cofins': None, 'nf_referencia': None, 'colunas_originais': {'ITENS DE FATURA': desc},
              '_sem_num': not nums}
        _preenche(it, cols, unid)
        d['itens'].append(it)
    for it in d['itens']:
        it.pop('_sem_num', None)
    d['itens'] = [i for i in d['itens'] if i['valor'] is not None or i['quantidade_faturada'] is not None]
    ilum = [i['valor'] for i in d['itens'] if i['componente'] == 'ILUMINACAO_PUBLICA' and i['valor'] is not None]
    d['totais']['valor_cosip_cip'] = round(sum(ilum), 2) if ilum else None


def _preenche(it, cols, unid):
    campos = {'quant': 'quantidade_faturada', 'preco': 'tarifa_com_tributos', 'valor': 'valor', 'pis_cofins': 'pis_cofins',
              'base_icms': 'base_icms', 'aliquota_icms': 'aliquota_icms', 'icms': 'icms', 'tarifa': 'tarifa_sem_tributos'}
    for k, v in cols.items():
        it[campos[k]] = num(v.rstrip('%'))
        it['colunas_originais'][ROT[k]] = v
    if unid:
        it['unidade'] = unid
        it['colunas_originais']['UNID.'] = unid
    if cols:
        it['_sem_num'] = False


def _direita(t1, d):
    tab = {'pagina': 1, 'nome': 'GRANDEZAS CONTRATADAS', 'linhas': []}
    for y, g in _grupos([w for w in t1 if w.x0 >= 450 and 255 < w.y1 < 420]):
        s = _txt(g)
        mm = re.match(r'(ICMS|COFINS|PIS)\s+([\d.,]+)\s+([\d.,]+%)\s+([\d.,]+)$', s)
        if mm:
            d['tributos'].append({'pagina': 1, 'tributo': mm[1], 'base': num(mm[2]), 'aliquota': num(mm[3].rstrip('%')),
                                  'valor': num(mm[4]), 'retido': False,
                                  'colunas_originais': {'TRIBUTO': mm[1], 'BASE DE CÁLCULO (R$)': mm[2],
                                                        'ALÍQUOTA (%)': mm[3], 'VALOR (R$)': mm[4]}})
            continue
        mm = re.match(r'(.*?:?)\s+([\d.,]+)\s*(kWh|kW)$', s)
        if mm:
            tab['linhas'].append({'colunas_originais': {mm[1]: f'{mm[2]} {mm[3]}'}})
            if mm[1].startswith('Demanda Todos'):
                d['demanda'].append({'pagina': 1, 'tipo': 'consumo', 'posto': None, 'contratada_kw': num(mm[2]),
                                     'medida_kw': None, 'faturada_kw': None, 'faturada_ultrapassagem_kw': None,
                                     'nao_consumida_kw': None, 'data_hora': None, 'rotulo': f'Grandezas contratadas: {s}',
                                     'colunas_originais': {mm[1]: f'{mm[2]} {mm[3]}'}})
    if tab['linhas']:
        d['tabelas_complementares'].append(tab)
    dem = [i for i in d['itens'] if i['componente'] == 'DEMANDA']
    for x in d['demanda']:
        if dem:
            x['faturada_kw'] = round(sum(i['quantidade_faturada'] or 0 for i in dem), 3)


def _medicoes(t1, d):
    ws = [w for w in t1 if 415 < w.y1 < 540 and w.x0 < 320]
    for y, g in _grupos(ws, 1.6):
        med = next((w.t for w in g if w.x0 < 55 and re.fullmatch(r'[A-Z]{1,3}\d{5,}\(?', w.t)), None)
        gr = _txt([w for w in g if 55 <= w.x0 < 128])
        po = _txt([w for w in g if 128 <= w.x0 < 150])
        nums = [w for w in g if w.x0 >= 160 and re.fullmatch(r'[\d.]*\.?\d+', w.t)]
        if not gr or not nums:
            continue
        cols = {k: v.t for k, v in ((min(ANC_MED, key=lambda c: abs(ANC_MED[c] - w.x1)), w) for w in nums)}
        def n_(v):  # números da medição: ponto é decimal (.21, 572.75); sem ponto = inteiro
            return float(v) if v is not None else None
        posto = {'PT': 'PONTA', 'FP': 'FORA_PONTA', 'TP': 'TODOS'}.get(po, po or None)
        d['medicoes'].append({'pagina': 1, 'tabela_origem': 'MEDIDOR / GRANDEZAS', 'medidor': med.rstrip('(') if med else None,
                              'grandeza': gr, 'posto': posto, 'leitura_anterior': n_(cols.get('leitura_anterior')),
                              'leitura_atual': n_(cols.get('leitura_atual')), 'constante': n_(cols.get('constante')),
                              'perdas_pct': None, 'ajuste': None, 'consumo': n_(cols.get('consumo')),
                              'consumo_faturado': None, 'fator_potencia': None, 'ajuste_fator_potencia': None,
                              'unidade': 'kW' if 'kW' == gr.split()[-1] else 'kWh', 'data_hora_registro': None,
                              'leitura_arredondada': False,
                              'colunas_originais': {'MEDIDOR': med, 'GRANDEZAS': gr, 'POSTOS': po, **cols}})
        if med and med.rstrip('(') not in d['unidade_consumidora']['medidor']:
            d['unidade_consumidora']['medidor'].append(med.rstrip('('))


def _demonstrativo(t, d, np_):
    if any(x['pagina'] == np_ for x in d['medicoes']):
        return
    anc = {'leitura_anterior': 204, 'leitura_atual': 249, 'constante': 300, 'consumo': 403}
    for y, g in _grupos([w for w in t if 255 < w.y1 < 420 and w.x0 < 420], 1.6):
        desc = _txt([w for w in g if w.x0 < 180 and not e_numero(w.t)])
        nums = [w for w in g if w.x0 >= 180 and re.fullmatch(r'[\d.]*\.?\d+', w.t)]
        if desc:
            pend = desc
            if not nums:
                continue
        elif not nums:
            continue
        else:
            desc = pend if 'pend' in dir() else ''
        du = sem_acento(desc).upper()
        if not (du.startswith('ENERGIA INJETADA') or du.startswith('DEMANDA GERA')):
            continue
        cols = {k: w.t for k, w in ((min(anc, key=lambda c: abs(anc[c] - w.x1)), w) for w in nums)}
        po = 'GERACAO' if du.startswith('DEMANDA') else (_posto(desc) or 'TODOS')
        cons = float(cols['consumo']) if 'consumo' in cols else None
        d['medicoes'].append({'pagina': np_, 'tabela_origem': 'DEMONSTRATIVO DE CONSUMO (p4, geração)', 'medidor': None,
                              'grandeza': desc, 'posto': po,
                              'leitura_anterior': float(cols['leitura_anterior']) if 'leitura_anterior' in cols else None,
                              'leitura_atual': float(cols['leitura_atual']) if 'leitura_atual' in cols else None,
                              'constante': float(cols['constante']) if 'constante' in cols else None,
                              'perdas_pct': None, 'ajuste': None, 'consumo': cons, 'consumo_faturado': None,
                              'fator_potencia': None, 'ajuste_fator_potencia': None,
                              'unidade': 'kW' if du.startswith('DEMANDA') else 'kWh', 'data_hora_registro': None,
                              'leitura_arredondada': False, 'colunas_originais': {'DESCRIÇÃO': desc, **cols}})
        if po in ('PONTA', 'FORA_PONTA') and cons is not None:
            d['gd']['lancamentos'].append({'pagina': np_, 'tipo': 'injetada', 'posto': po, 'kwh': cons, 'mes_ref': None,
                                           'ref_expiracao': None, 'unidade_impressa': 'kWh',
                                           'rotulo': f'{desc} (Demonstrativo de Consumo)'})


def _rodape(t1, bruto, d):
    tudo = re.sub(r'\s+', ' ', bruto)
    mm = re.search(r'(BandeiraTarifaria\s+.*?)(?=\s+Demonstrativos|\s+APOS|$)', tudo)
    if mm:
        d['mensagens'].append({'pagina': 1, 'texto': mm[1]})
        ano = (d['referencia']['leitura_atual'] or d['referencia']['mes_referencia'] or '')[:4]
        for cor, a, b in re.findall(r'(Amarela|Verde|Vermelha\s*\d?|Escassez)\s*:\s*(\d\d/\d\d)-(\d\d/\d\d)', mm[1]):
            ini_ano = ano
            if ano and d['referencia']['leitura_anterior'] and a[3:] == d['referencia']['leitura_anterior'][5:7]:
                ini_ano = d['referencia']['leitura_anterior'][:4]
            d['bandeiras'].append({'pagina': 1, 'cor': sem_acento(cor).upper().replace(' ', '_'),
                                   'inicio': f'{ini_ano}-{a[3:]}-{a[:2]}' if ini_ano else None,
                                   'fim': f'{ini_ano}-{b[3:]}-{b[:2]}' if ini_ano else None, 'dias': None})
    mm = re.search(r'(Demonstrativos de Saldos em kWh.*?\.)\s*(?:Saldo a\s+)?(?=APOS|CONTA|$)', tudo)
    mm = re.search(r'(Demonstrativos de Saldos em kWh referente a Mini e Micro Geracao\..*?Proximo\s+Mes\s+F(?:ora)?\s*Ponta\s*[\d.]+\.)', tudo)
    if mm:
        txt = re.sub(r'Saldo a\s+Expirar', 'Saldo a Expirar', mm[1])
        d['mensagens'].append({'pagina': 1, 'texto': txt})
        gd = d['gd']
        for rot, tipo in (('Saldo Mes', 'saldo_atual'), ('Saldo Acumulado', 'saldo_atual'),
                          ('Saldo a Expirar Proximo Mes', 'a_expirar')):
            for po, v in re.findall(re.escape(rot) + r'\s+(Ponta|F(?:ora)?\s*Ponta)\s+([\d.]+)', txt):
                gd['lancamentos'].append({'pagina': 1, 'tipo': tipo,
                                          'posto': 'PONTA' if po == 'Ponta' else 'FORA_PONTA', 'kwh': float(v),
                                          'mes_ref': None, 'ref_expiracao': None, 'unidade_impressa': 'kWh',
                                          'rotulo': f'{rot} {po} {v}'})
    mm = re.search(r'(APOS VENCIMENTO, CORRECAO MONETARIA MAIS JUROS LEGAIS NA PROXIMA FATURA)', tudo)
    if mm:
        d['mensagens'].append({'pagina': 1, 'texto': mm[1]})
    pag = d['pagamento']
    mm = re.search(r'\b(8\d{11} \d{12} \d{12} \d{12})\b', tudo) or \
        re.search(r'\b(\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14})\b', tudo)
    pag['linha_digitavel'] = mm[1] if mm else None
    mm = re.search(r'\b(\d{2}-\d{14}-\d{2})\b', tudo)
    if mm:
        d['documento']['controle'] = mm[1]
    if 'PAGUE COM O PIX' in tudo:
        pag['pix'] = 'QR code PIX impresso, sem código em texto'
    mm = re.search(r'(BANCO [A-Z ]+?S\s*A)\s+(\d{3}-\d)', tudo)
    if mm:
        pag['banco'] = f'{re.sub(" +", " ", mm[1])} {mm[2]}'
    pag.setdefault('conta_recebedora', None)


def _provas(d):
    div = d['extracao']['divergencias_impressas']
    for j, m in enumerate(d['medicoes']):
        la, lb, c, cons = m['leitura_anterior'], m['leitura_atual'], m['constante'], m['consumo']
        if None in (la, lb, c, cons) or abs((lb - la) * c - cons) <= max(1, abs(cons) * 0.01):
            continue
        div.append({'onde': 'medicao', 'indice': j, 'nota': f'{m["grandeza"]} {m["posto"]}: consumo impresso {cons} ≠ '
                    f'({lb}−{la})×{c}; leituras do registrador impressas arredondadas/escaladas no quadro.'})
        m['leitura_arredondada'] = True
