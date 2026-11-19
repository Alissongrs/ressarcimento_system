"""Parser determinístico da fatura Copel DANF3E ("DANF3EA4A"), A4, com páginas de continuação.

Cabeçalho pelo texto bruto (sai em ordem: classificação, fornecimento, datas, UC, referência, vencimento, total,
Nome/Endereço/CEP/Cidade/CNPJ/I.E., NF3e). Itens, tributos, grandezas contratadas e medições por posição, em todas as
páginas DANF3E (p1 + continuações). Mensagens: compensação, saldos SCEE, bandeira.
"""
import re

from base import data_br, e_numero, esqueleto, num, palavras, sem_acento
from neoenergia import _col, _grupos, _txt

NOME = 'copel_v1'
ANC = {'quant': 200, 'preco': 237, 'valor': 282, 'pis_cofins': 329, 'icms': 374, 'tarifa': 410}
ROT = {'quant': 'Quant.', 'preco': 'Preço unit. (R$) com tributos', 'valor': 'Valor (R$)', 'pis_cofins': 'PIS/COFINS',
       'icms': 'ICMS', 'tarifa': 'Tarifa unit. (R$)'}
ANC_MED = {'leitura_anterior': 218, 'leitura_atual': 258, 'constante': 281, 'consumo': 315}


def detecta(texto, doc=None):
    return '04.368.898/0001-06' in texto and 'DANF3E' in texto


def _posto(t):
    d = ' ' + sem_acento(t).upper().replace('.', ' ') + ' '
    if re.search(r' (F PONTA|FP|FPONTA|FORA PONTA|FORA P) ', d):
        return 'FORA_PONTA'
    if re.search(r' (PONTA|PT|PTA) ', d):
        return 'PONTA'
    if re.search(r' (INTERMEDIARIO|INT) ', d):
        return 'INTERMEDIARIO'
    if re.search(r' TP ', d):
        return 'TODOS'
    return None


def componente_de(desc):
    d = sem_acento(desc).upper()
    po = _posto(d)
    if 'BANDEIRA' in d or 'BAND.' in d:
        return 'BANDEIRA', po
    if 'INJ' in d and 'DEMANDA' in d:
        return ('DEMANDA_GERACAO_ULTRAPASSAGEM' if 'ULTRA' in d else 'DEMANDA_GERACAO'), 'GERACAO'
    if d.startswith('ENERGIA INJ'):
        return 'GD_INJETADA', po
    if 'REAT' in d or 'EXCED' in d:
        return 'REATIVO_EXCEDENTE', po
    if 'ULTRA' in d:
        return 'DEMANDA_ULTRAPASSAGEM', None
    if d.startswith('DEMANDA'):
        return 'DEMANDA', 'TODOS'
    if 'ILUMIN' in d:
        return 'ILUMINACAO_PUBLICA', None
    if d.startswith('MULTA'):
        return 'MULTA', None
    if d.startswith('JUROS'):
        return 'JUROS', None
    if 'CORRECAO' in d or 'ATUALIZ' in d or 'IPCA' in d or 'MORATORIO' in d:
        return 'ATUALIZACAO_MONETARIA', None
    if d.startswith(('SERV', 'TAXA')) or 'VISTORIA' in d or '2 VIA' in d:
        return 'SERVICO', None
    if re.search(r'\b(DIC|FIC|DMIC|DICRI)\b', d) or 'VIOL' in d:
        return 'COMPENSACAO_CONTINUIDADE', None
    if d.startswith(('DEVOL', 'DEV ', 'ESTORNO')):
        return 'ESTORNO', None
    if re.search(r'\bUSD\b|TUSD', d):
        return 'TUSD', po
    if re.search(r'\bTE\b', d):
        return 'TE', po
    if 'ENERGIA' in d or 'CONSUMO' in d:
        return 'CONSUMO', po
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
    brutos = [p.get_text() for p in doc]
    d['extracao']['paginas_lidas'] = list(range(1, len(doc) + 1))
    d['extracao']['paginas'] = []
    danf = []  # páginas DANF3E (p1 e continuações)
    for i, b in enumerate(brutos):
        b0 = re.sub(r'^(Segunda Via\n)+', '', b)
        if i == 0 or re.match(r'\S.*?\s*/\s*.*\n(Trif|Monof|Bif)', b0) or 'NOTA FISCAL No.' in b:
            danf.append(i)
            tipo = 'conteudo'
        elif not b.strip():
            tipo = 'em_branco'
        elif b.startswith('Página:'):
            tipo = 'institucional'
        else:
            tipo = 'conteudo'
        d['extracao']['paginas'].append({'pagina': i + 1, 'tipo': tipo, 'repete_pagina': None})
    doc_, nf, uc_, tit, ref, tot = (d['documento'], d['documento']['nota_fiscal'], d['unidade_consumidora'],
                                    d['titular'], d['referencia'], d['totais'])
    doc_['distribuidora'] = 'Copel Distribuição S.A.'
    doc_['distribuidora_sigla'] = 'COPEL'
    doc_['distribuidora_cnpj'] = '04.368.898/0001-06'
    nf['modelo'] = 'NF3e (DANF3E)'
    b1 = brutos[0]
    t1x = re.sub(r'[ \t]+', ' ', b1)
    doc_['segunda_via'] = 'Segunda Via' in b1
    mm = re.search(r'Copel Distribuição S\.A\.\n(.*?)\nCEP:\s*(\S+)\s*-\s*(.*?)\nCNPJ', t1x, re.S)
    if mm:
        doc_['distribuidora_endereco'] = f'{mm[1].strip()} - CEP: {mm[2]} - {mm[3].strip()}'
    mm = re.search(r'INSC\. ESTADUAL\s*(\d+)', t1x)
    doc_['distribuidora_ie'] = mm[1] if mm else None
    mm = re.search(r'Iluminação Pública:\s*(.*?)\s*(?:OUVIDORIA|\n)', t1x)
    resp_ip = mm[1].strip() if mm else None
    # bloco do cabeçalho
    mm = re.search(r'\n([AB]\d\w*\s.*?)\n((?:Trif|Monof|Bif)\S*.*?)\n(\d\d/\d\d/\d{4})\n(\d\d/\d\d/\d{4})\n(\d+)\n(\d\d/\d\d/\d{4})\n'
                   r'(\d{6,})\n(\d\d/\d{4})\n(\d\d/\d\d/\d{4})\nR\$\s*([\d.]+,\d\d)', t1x)
    if mm:
        cl = mm[1].strip()
        uc_['classificacao'] = cl
        m2 = re.match(r'([AB])(\d\w*)\s+(.*?)\s*/\s*(.*)', cl)
        if m2:
            uc_['grupo'], uc_['subgrupo'] = m2[1], m2[1] + m2[2]
            uc_['classe'], uc_['subclasse'] = m2[3], m2[4]
        uc_['tipo_fornecimento'] = mm[2].strip()
        ref.update({'leitura_anterior': data_br(mm[3]), 'leitura_atual': data_br(mm[4]), 'dias_faturados': int(mm[5]),
                    'proxima_leitura': data_br(mm[6])})
        uc_['uc'] = mm[7]
        ref['mes_referencia'] = f'{mm[8][3:]}-{mm[8][:2]}'
        ref['data_vencimento'] = data_br(mm[9])
        tot['total_a_pagar'] = num(mm[10])
    mm = re.search(r'Nome:\s*(.*?)\nEndereço:\s*(.*?)\nCEP:\s*(\S+)\nCidade:\s*(.*?)\s*-\s*Estado:\s*(\w\w)\n'
                   r'(?:CNPJ|CPF):\s*(\S+)\n(?:I\.E\.:\s*(\S*))?', t1x, re.S)
    if mm:
        tit['nome'] = re.sub(r'\s+', ' ', mm[1]).strip()
        tit['endereco'] = uc_['endereco'] = re.sub(r'\s+', ' ', mm[2]).strip()
        tit['cep'], tit['cidade'], tit['uf'] = mm[3], mm[4].strip(), mm[5]
        v = mm[6]
        if re.fullmatch(r'\d{8}/\d{4}-\d{2}', v):
            d['valores_alternativos'].append({'campo': 'titular.cnpj_cpf', 'valor': v, 'pagina': 1})
            v = f'{v[:2]}.{v[2:5]}.{v[5:8]}{v[8:]}'
        tit['cnpj_cpf_mascarado' if '*' in v else 'cnpj_cpf'] = v
        tit['inscricao_estadual'] = mm[7] or None
    mm = re.search(r'NOTA FISCAL No\.\s*(\d+)\s*-\s*SÉRIE\s*(\w+)\s*(?:/|\n)\s*DATA DE EMISSÃO:\s*(\d\d/\d\d/\d{4})', t1x)
    if mm:
        nf['numero'], nf['serie'] = mm[1], mm[2]
        nf['data_emissao'] = ref['data_emissao'] = data_br(mm[3])
    mm = re.search(r'(https?://\S+)', t1x)
    nf['url_consulta'] = mm[1] if mm else None
    mm = re.search(r'Chave de Acesso\n((?:\d{4}\s?){11})', t1x)
    nf['chave_acesso'] = re.sub(r'\s', '', mm[1]) if mm else None
    mm = re.search(r'Protocolo de Autorização:\s*(\d+)\s*\n?\s*(\d\d/\d\d/\d{4})\s*(?:às)?\s*(\d\d:\d\d:\d\d)', t1x)
    if mm:
        nf['protocolo_autorizacao'], nf['data_autorizacao'] = mm[1], f'{data_br(mm[2])}T{mm[3]}'
    tudo = re.sub(r'\s+', ' ', ' '.join(brutos[i] for i in danf))
    mm = re.search(r'\b([0-9A-F]{4}(?:\.[0-9A-F]{4}){7})\b', tudo)
    nf['reservado_fisco'] = mm[1] if mm else None
    mm = re.search(r'PERÍODO FISCAL:\s*(\d\d/\d\d/\d{4})', tudo)
    nf['periodo_fiscal'] = data_br(mm[1]) if mm else None
    uc_['tecnico'] = {'tensao_nominal': None, 'tensao_contratada_v': None, 'tensao_fornecimento_kv': None,
                      'tensao_minima': None, 'tensao_maxima': None, 'faixa_adequada': None,
                      'fator_potencia_referencia': None, 'rtc': None, 'rtp': None, 'constantes': [],
                      'perdas_transformacao_pct': None, 'horario_ponta': None, 'equipamento_medidor': None,
                      'responsavel_iluminacao_publica': resp_ip}
    for i in danf:
        t = [w for w in palavras(doc[i]) if not (w.t in ('Segunda', 'Via') and w.x1 - w.x0 > 60)]
        _itens(t, d, i + 1)
        if i == danf[0]:
            _direita(t, d)
        _medicoes(t, d, i + 1)
    _textos(tudo, d)
    d['_extrato'] = []
    for i, b in enumerate(brutos):
        if 'EXTRATO DE FATURAMENTO' in b or re.match(r'(Segunda Via\n)*página \d', b):
            pw = palavras(doc[i])
            d['_extrato'] += [_txt(g) for y, g in _grupos(pw)]
            if not d['historico']:
                _historico_extrato(pw, d, i + 1)
    ilum = [x['valor'] for x in d['itens'] if x['componente'] == 'ILUMINACAO_PUBLICA' and x['valor'] is not None]
    tot['valor_cosip_cip'] = round(sum(ilum), 2) if ilum else None
    uc_['geracao']['e_gerador'] = 'Micro/Minigeradora' in tudo
    if uc_['geracao']['e_gerador']:
        uc_['geracao']['modalidade_gd'] = 'Unidade Micro/Minigeradora no SCEE'
    for m in d['medicoes']:
        if m['grandeza'].startswith('GERAC') and m['posto'] in ('PONTA', 'FORA_PONTA') and m['consumo'] is not None:
            d['gd']['lancamentos'].append({'pagina': m['pagina'], 'tipo': 'injetada', 'posto': m['posto'],
                                           'kwh': m['consumo'], 'mes_ref': None, 'ref_expiracao': None,
                                           'unidade_impressa': 'kWh', 'rotulo': f'{m["grandeza"]} {m["posto"]} (medido)'})
    mm = re.search(r'EXTRATO DE FATURAMENTO\s*-\s*(TARIFA \w+ (\w+))', re.sub(r'\s+', ' ', ' '.join(brutos)))
    if mm:
        uc_['tipo_tarifa_impresso'] = mm[1]
        uc_['modalidade_tarifaria'] = mm[2].capitalize()
    d['historico_formato'] = 'tabela' if d['historico'] else 'so_grafico'
    _provas(d)
    d.pop('_extrato', None)
    return d


def _itens(t, d, np_):
    tw = next((w for w in t if w.t == 'TOTAL' and w.x0 < 60 and 290 < w.y1 < 600), None)
    med = next((w for w in t if w.x0 < 60 and re.fullmatch(r'\d{10}', w.t) and w.y1 > 290), None)
    y_fim = tw.y1 + 1 if tw else (med.y1 - 8 if med else 480)
    ws = [w for w in t if 295 < w.y1 < y_fim and w.x0 < 420]
    for y, g in _grupos(ws, 2.0):
        unid = next((w.t for w in g if 148 <= w.x0 < 170 and re.fullmatch(r'kWh|kW|kVArh|kVAr|kvarh', w.t)), None)
        desc = _txt([w for w in g if w.x0 < 148])
        nums = [w for w in g if w.x0 >= 170 and re.fullmatch(r'-?[\d.]*\d,\d+|-?[\d.]+', w.t)]
        if not desc:
            continue
        cols = _col(nums, ANC)
        if desc == 'TOTAL':
            for k in ('valor', 'pis_cofins', 'icms'):
                if k in cols:
                    d['totais']['totais_colunas'].append({'pagina': np_, 'coluna': f'{ROT[k]} TOTAL', 'valor': num(cols[k])})
            d['totais']['total_nota_fiscal'] = num(cols.get('valor'))
            continue
        if not nums:
            continue
        comp, posto = componente_de(desc)
        mm = re.search(r'(\d\d)/(\d{4})', desc)
        d['itens'].append({'pagina': np_, 'secao_impressa': 'Itens de fatura', 'codigo': None, 'descricao': desc,
                           'mes_ref': f'{mm[2]}-{mm[1]}' if mm else None, 'componente': comp, 'posto': posto,
                           'quantidade_registrada': None, 'quantidade_faturada': num(cols.get('quant')), 'unidade': unid,
                           'tarifa_com_tributos': num(cols.get('preco')), 'tarifa_sem_tributos': num(cols.get('tarifa')),
                           'valor': num(cols.get('valor')), 'valor_sem_tributos': None, 'base_icms': None,
                           'aliquota_icms': None, 'icms': num(cols.get('icms')), 'base_pis_cofins': None,
                           'aliquota_pis': None, 'pis': None, 'aliquota_cofins': None, 'cofins': None,
                           'pis_cofins': num(cols.get('pis_cofins')), 'nf_referencia': None,
                           'colunas_originais': {'Itens de fatura': desc, 'Unid.': unid, **{ROT[k]: v for k, v in cols.items()}}})


def _direita(t, d):
    tab = {'pagina': 1, 'nome': 'GRANDEZAS CONTRATADAS', 'linhas': []}
    for y, g in _grupos([w for w in t if w.x0 >= 418 and 295 < w.y1 < 440]):
        s = _txt(g)
        mm = re.match(r'(ICMS|COFINS|PIS)\s+([\d.,]+)\s+([\d.,]+%)\s+([\d.,]+)$', s)
        if mm:
            d['tributos'].append({'pagina': 1, 'tributo': mm[1], 'base': num(mm[2]), 'aliquota': num(mm[3].rstrip('%')),
                                  'valor': num(mm[4]), 'retido': False,
                                  'colunas_originais': {'Tributo': mm[1], 'Base de Cálc. (R$)': mm[2], 'Alíquota (%)': mm[3],
                                                        'Valor (R$)': mm[4]}})
            continue
        mm = re.match(r'(.*?:?)\s+([\d.,]+)\s*(kWh|kW)$', s)
        if mm:
            tab['linhas'].append({'colunas_originais': {'rotulo': mm[1], 'valor': f'{mm[2]} {mm[3]}'}})
            if mm[1].startswith('Demanda Todos'):
                dem = [i for i in d['itens'] if i['componente'] == 'DEMANDA']
                d['demanda'].append({'pagina': 1, 'tipo': 'consumo', 'posto': 'TODOS', 'contratada_kw': num(mm[2]),
                                     'medida_kw': None,
                                     'faturada_kw': round(sum(i['quantidade_faturada'] or 0 for i in dem), 3) if dem else None,
                                     'faturada_ultrapassagem_kw': None, 'nao_consumida_kw': None, 'data_hora': None,
                                     'rotulo': f'GRANDEZAS CONTRATADAS: {s}', 'colunas_originais': {mm[1]: f'{mm[2]} {mm[3]}'}})
    if tab['linhas']:
        d['tabelas_complementares'].append(tab)


def _medicoes(t, d, np_):
    rows = [w for w in t if w.x0 < 60 and re.fullmatch(r'\d{10}', w.t) and w.y1 > 290]
    if not rows:
        return
    y0 = min(w.y1 for w in rows) - 3
    ws = [w for w in t if y0 < w.y1 < y0 + 110 and w.x0 < 325]
    for y, g in _grupos(ws, 1.8):
        med = next((w.t for w in g if w.x0 < 60 and re.fullmatch(r'\d{10}', w.t)), None)
        gr = _txt([w for w in g if 80 <= w.x0 < 128])
        po = _txt([w for w in g if 128 <= w.x0 < 150])
        nums = [w for w in g if w.x0 >= 150 and re.fullmatch(r'[\d]*\.?\d+', w.t)]
        if not gr or not nums or not re.fullmatch(r'[A-Z][A-Z.\-/]*\s+(kWh|kW|kVArh|kvarh|KVARH)', gr):
            continue
        cols = {}
        for w in nums:
            cols[min(ANC_MED, key=lambda c: abs(ANC_MED[c] - w.x1))] = w.t
        f = lambda k: float(cols[k]) if k in cols else None
        posto = {'PT': 'PONTA', 'FP': 'FORA_PONTA', 'TP': 'TODOS', 'INT': 'INTERMEDIARIO'}.get(po, po or None)
        un = gr.split()[-1] if gr.split() else None
        d['medicoes'].append({'pagina': np_, 'tabela_origem': 'Medidor / Grandezas', 'medidor': med, 'grandeza': gr,
                              'posto': posto, 'leitura_anterior': f('leitura_anterior'), 'leitura_atual': f('leitura_atual'),
                              'constante': f('constante'), 'perdas_pct': None, 'ajuste': None, 'consumo': f('consumo'),
                              'consumo_faturado': None, 'fator_potencia': None, 'ajuste_fator_potencia': None,
                              'unidade': un, 'data_hora_registro': None,
                              'leitura_arredondada': un == 'kW' or 'leitura_anterior' not in cols,
                              'colunas_originais': {'Medidor': med, 'Grandezas': gr, 'Postos': po, **cols}})
        if med and med not in d['unidade_consumidora']['medidor']:
            d['unidade_consumidora']['medidor'].append(med)


HIST = {'Valor da Fatura': 111, 'Data de Vencimento': 149, 'Data de Pagamento': 189, 'Consumo Ponta': 227,
        'Consumo Fora Pta.': 261, 'Demanda Ponta': 295, 'Demanda Fora Pta.': 329, 'Dem.Cont. Ponta': 363,
        'Dem.Cont. Fora Pta.': 397, 'Dem.Tol. Ponta': 431, 'Dem.Tol. Fora Pta.': 465}


def _historico_extrato(t, d, np_):
    # o cabeçalho certo é o "Mês/Ano" seguido de uma linha mm/aaaa (há outro "Mês/Ano" nas Informações Técnicas)
    hdr = next((w for w in t if w.t == 'Mês/Ano' and w.x0 < 60 and
                any(re.fullmatch(r'\d\d/\d{4}', x.t) and x.x0 < 60 and 0 < x.y1 - w.y1 < 15 for x in t)), None)
    if not hdr:
        return
    tab = {'pagina': np_, 'nome': 'Histórico de Consumo e Pagamentos', 'linhas': []}
    for y, g in _grupos([w for w in t if hdr.y1 + 3 < w.y1 < hdr.y1 + 130]):
        if not re.fullmatch(r'\d\d/\d{4}', g[0].t) or g[0].x0 > 60:
            continue
        cols = {}
        for w in g[1:]:
            k = min(HIST, key=lambda c: abs(HIST[c] - w.x1))
            if abs(HIST[k] - w.x1) <= 10:
                cols[k] = w.t
        mes = f'{g[0].t[3:]}-{g[0].t[:2]}'
        tab['linhas'].append({'colunas_originais': {'Mês/Ano': g[0].t, **cols}})
        for k, serie, po, un in (('Valor da Fatura', 'total_fatura', None, 'R$'), ('Consumo Ponta', 'consumo', 'PONTA', 'kWh'),
                                 ('Consumo Fora Pta.', 'consumo', 'FORA_PONTA', 'kWh'),
                                 ('Demanda Ponta', 'demanda', 'PONTA', 'kW'), ('Demanda Fora Pta.', 'demanda', 'FORA_PONTA', 'kW')):
            v = cols.get(k)
            if v is None:
                continue
            val = num(v) if ',' in v or un == 'R$' else float(v)
            d['historico'].append({'pagina': np_, 'mes': mes, 'serie': serie, 'posto': po, 'valor': val, 'unidade': un,
                                   'unidade_original': un, 'faturado_pela_media': False})
    if tab['linhas']:
        d['tabelas_complementares'].append(tab)


def _textos(tudo, d):
    gd = d['gd']
    mm = re.search(r'(O montante da devolução é resultado da multiplicação do CONSUMO COMPENSADO.*?quando for o caso\.)', tudo)
    if mm:
        d['mensagens'].append({'pagina': 1, 'texto': mm[1]})
        for po, v in re.findall(r'(PONTA|FPONTA|INTERMEDIÁRIO)\s+(\d+)\s*kWh', mm[1]):
            gd['lancamentos'].append({'pagina': 1, 'tipo': 'compensada',
                                      'posto': {'PONTA': 'PONTA', 'FPONTA': 'FORA_PONTA'}.get(po, 'INTERMEDIARIO'),
                                      'kwh': int(v), 'mes_ref': None, 'ref_expiracao': None, 'unidade_impressa': 'kWh',
                                      'rotulo': f'CONSUMO COMPENSADO {po}'})
    mm = re.search(r'(Unidade Micro/Minigeradora no SCEE\..*?\(REN ANEEL 1000 Art\. \d+\)\.)', tudo)
    if mm:
        d['mensagens'].append({'pagina': 1, 'texto': mm[1]})
    mm = re.search(r'(Demonstrativo de saldos SCEE.*?Saldo a Expirar Próximo Mês:?.*?F Ponta:? \d+\.?)', tudo)
    if mm:
        d['mensagens'].append({'pagina': 1, 'texto': mm[1]})
        for rot, tipo in (('Saldo Mês', 'outro'), ('Saldo Acumulado', 'saldo_atual'), ('Saldo a Expirar Próximo Mês', 'a_expirar')):
            segs = [x.split('Saldo')[0] for x in mm[1].split(rot)[1:]]  # cada ocorrência do rótulo até o próximo "Saldo"
            for po, v in [pv for sg in segs for pv in re.findall(r'(F Ponta|Ponta):? (\d+)', sg)]:
                gd['lancamentos'].append({'pagina': 1, 'tipo': tipo, 'posto': 'PONTA' if po == 'Ponta' else 'FORA_PONTA',
                                          'kwh': int(v), 'mes_ref': None,
                                          'ref_expiracao': 'próximo mês' if tipo == 'a_expirar' else None,
                                          'unidade_impressa': None, 'rotulo': f'{rot} {po}'})
    mm = re.search(r'(Periodos Band\.Tarif\.:\s*(.*?))(?=\s+[A-ZÀ-Ú]{4,}|\s*$)', tudo)
    if mm:
        d['mensagens'].append({'pagina': 1, 'texto': mm[1]})
        ano_f = (d['referencia']['leitura_atual'] or '')[:4]
        ano_i = (d['referencia']['leitura_anterior'] or '')[:4]
        for cor, a, b in re.findall(r'(Verde|Amarela|Vermelha\s*P?\d?|Escassez)\s*:\s*(\d\d/\d\d)-(\d\d/\d\d)', mm[2]):
            ai = ano_i if ano_i and a[3:] == (d['referencia']['leitura_anterior'] or '')[5:7] else ano_f
            d['bandeiras'].append({'pagina': 1, 'cor': sem_acento(cor).upper().replace(' ', '_'),
                                   'inicio': f'{ai}-{a[3:]}-{a[:2]}' if ai else None,
                                   'fim': f'{ano_f}-{b[3:]}-{b[:2]}' if ano_f else None, 'dias': None})
    pag = d['pagamento']
    mm = re.search(r'\b(8\d{11} \d{12} \d{12} \d{12})\b', tudo) or \
        re.search(r'\b(\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14})\b', tudo)
    pag['linha_digitavel'] = mm[1] if mm else None
    mm = re.search(r'\b(FAT-\d\d-\d{14,}-\d\d)\b', tudo)
    pag['numero_fatura'] = mm[1] if mm else None
    pag.setdefault('conta_recebedora', None)
    mm = re.search(r'(GERENTE DA AGENCIA COPEL DE SUA REGIAO:.*?|CONSULTOR DE RELACIONAMENTO RESPONSAVEL.*?\.)(?=\s+A qualquer|\s+Periodos|$)', tudo)
    if mm:
        d['mensagens'].append({'pagina': 1, 'texto': mm[1].strip()})


def _provas(d):
    div = d['extracao']['divergencias_impressas']
    for j, m in enumerate(d['medicoes']):
        la, lb, c, cons = m['leitura_anterior'], m['leitura_atual'], m['constante'], m['consumo']
        if m['leitura_arredondada'] or None in (la, lb, c, cons) or abs((lb - la) * c - cons) <= max(1, abs(cons) * 0.01):
            continue
        if m['grandeza'].startswith('EN.EXCE'):
            q = [i['quantidade_faturada'] for i in d['itens'] if i['componente'] == 'REATIVO_EXCEDENTE'
                 and i['posto'] == m['posto'] and i['quantidade_faturada'] is not None]
            alvo = f' {la:g} {lb:g} ' + f'{cons:.2f}'.replace('.', ',')
            fp = m['posto'] == 'FORA_PONTA'
            ext_ok = any('REAT EXC' in l and (('F PONTA' in l) == fp) and alvo in ' ' + l for l in d.get('_extrato', []))
            if any(abs(x - cons) <= 1 for x in q) or ext_ok:
                div.append({'onde': 'medicao', 'indice': j, 'nota': f'{m["grandeza"]} {m["posto"]}: consumo impresso {cons} '
                            f'(≠ ({lb}−{la})×{c}) é a quantidade faturada no item de energia reativa excedente.'})
                continue
        if m['grandeza'].startswith('CONSUMO') and m['posto'] in ('PONTA', 'FORA_PONTA'):
            # registrador com leitura impressa arredondada: o consumo impresso é o que foi faturado (itens TE/TUSD do
            # mesmo posto) e Ponta + Fora Ponta fecha com o registro TP
            q = [i['quantidade_faturada'] for i in d['itens'] if i['componente'] in ('TE', 'TUSD', 'CONSUMO')
                 and i['posto'] == m['posto'] and i['quantidade_faturada'] is not None]
            tp = next((x['consumo'] for x in d['medicoes'] if x['grandeza'] == m['grandeza'] and x['posto'] == 'TODOS'
                       and x['pagina'] == m['pagina']), None)
            par = next((x['consumo'] for x in d['medicoes'] if x['grandeza'] == m['grandeza'] and x['pagina'] == m['pagina']
                        and x['posto'] == ('FORA_PONTA' if m['posto'] == 'PONTA' else 'PONTA')), None)
            if any(abs(x - cons) <= 1 for x in q) and (tp is None or par is None or abs(cons + par - tp) <= 2):
                div.append({'onde': 'medicao', 'indice': j, 'nota': f'{m["grandeza"]} {m["posto"]}: ({lb}−{la})×{c} ≠ '
                            f'consumo impresso {cons}, que é a quantidade faturada nos itens do posto'
                            + (f' e fecha com o registro TP ({tp})' if tp is not None and par is not None else '') + '.'})
                continue
        if abs(lb * c - cons) <= max(0.05, abs(cons) * 0.01):
            div.append({'onde': 'medicao', 'indice': j, 'nota': f'{m["grandeza"]}: registrador de máximo; consumo {cons} = '
                        f'leitura {lb} × {c}.'})
