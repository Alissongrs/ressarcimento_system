"""Parser determinístico da conta Enel Distribuição São Paulo (Eletropaulo), página 612×1008.

p1: cabeçalho (via, Nº/página), classificação/fornecimento/datas, cliente, quadro (UC, cliente, referência, vencimento,
total — dois arranjos), NF3e, mensagens (bandeira, DEC/FEC, saldo/injeção de GD), dados de medição (x<285) e itens de
fatura (x≥285) lado a lado, grandezas contratadas, tributos, histórico do faturamento e boleto Bradesco.
p2: envelope (unidade de entrega, sequência, medidor, endereço de correspondência).
p3+: "Demonstrativo complementar de Micro e Minigeração" (saldo anterior, créditos distribuídos por UC, histórico 12 meses).
"""
import re

from base import data_br, e_numero, esqueleto, num, palavras, sem_acento
from neoenergia import _col, _grupos, _txt

NOME = 'enel_sp_v1'
MESES = {'JAN': '01', 'FEV': '02', 'MAR': '03', 'ABR': '04', 'MAI': '05', 'JUN': '06', 'JUL': '07', 'AGO': '08',
         'SET': '09', 'OUT': '10', 'NOV': '11', 'DEZ': '12'}
ANC_IT = {'quant': 403, 'preco': 435, 'valor': 458, 'pis_cofins': 482, 'base_icms': 505, 'aliquota_icms': 524,
          'icms': 544, 'tarifa': 565}
ROT_IT = {'quant': 'Quant. (kW/ kWh/KVArh)', 'preco': 'Preço unit (R$) com tributos', 'valor': 'Valor (R$)',
          'pis_cofins': 'PIS/ COFINS', 'base_icms': 'Base Calc ICMS (R$)', 'aliquota_icms': 'Alíquota ICMS',
          'icms': 'ICMS', 'tarifa': 'Tarifa unit (R$)'}
ANC_MED = {'leitura_anterior': 187, 'leitura_atual': 216, 'constante': 243, 'consumo': 280}
END_EMIT = ('Av. das Nações Unidas 14401 – Conjuntos 1 a 4 Andar 17º ao 23º Torre B1 – Vila Gertrudes São Paulo SP '
            'CEP:04794-000')


def detecta(texto, doc=None):
    if doc is None or not len(doc) or min(abs(doc[0].rect.height - h) for h in (1008, 842)) > 2:
        return False
    return any(k in texto for k in ('Eletropaulo', 'ENEL DISTRIBUIÇÃO SÃO PAULO', 'eneldistribuicaosp'))


def _l(ws, y0, y1, x0=0, x1=700):
    return _txt(sorted([w for w in ws if y0 <= w.y1 <= y1 and x0 <= w.x0 < x1], key=lambda w: w.x0))


def _ancoras(ws, n, padrao):
    """Âncoras (x1) das colunas numéricas pelos próprios dados; usa o padrão se não achar n colunas."""
    x1s = sorted(w.x1 for w in ws)
    grp = []
    for x in x1s:
        if grp and x - grp[-1][-1] <= 6:
            grp[-1].append(x)
        else:
            grp.append([x])
    grp = [g for g in grp if len(g) >= 2]
    if len(grp) == n:
        return {k: max(set(g), key=g.count) for k, g in zip(padrao, grp)}
    return padrao


def _posto_med(p):
    p = p.upper().strip()
    return {'PONTA': 'PONTA', 'F PONTA': 'FORA_PONTA', 'F PONTA INDU': 'INDUTIVO', 'F PONTA CAP': 'CAPACITIVO',
            'INTERMED': 'INTERMEDIARIO', 'F PONTA INDUTIV': 'INDUTIVO', 'F PONTA CAPACIT': 'CAPACITIVO'}.get(p, p or None)


def componente_de(desc):
    d = sem_acento(desc).upper()
    po = 'PONTA' if re.search(r'\b(PTA|PT|PONTA)\b', d) else None
    if re.search(r'\b(F\.? ?PONTA|FPT|FP|FORA PONTA)\b', d):
        po = 'FORA_PONTA'
    if d.startswith('EN COMP') or 'COMPENS' in d:
        return 'CONSUMO_COMPENSADO', po
    if 'GERACAO' in d and 'DEMANDA' in d:
        return ('DEMANDA_GERACAO_ULTRAPASSAGEM' if 'ULTRA' in d else 'DEMANDA_GERACAO'), 'GERACAO'
    if 'BANDEIRA' in d:
        return 'BANDEIRA', po
    if 'REAT' in d or 'UFER' in d or 'DMCR' in d:
        return 'REATIVO_EXCEDENTE', po
    if 'ULTRA' in d:
        return 'DEMANDA_ULTRAPASSAGEM', None
    if d.startswith('DEMANDA'):
        return 'DEMANDA', None
    if 'TUSD' in d:
        return 'TUSD', po
    if re.search(r'\bTE\b', d):
        return 'TE', po
    if d.startswith(('CIP', 'COSIP')) or 'ILUM' in d:
        return 'ILUMINACAO_PUBLICA', None
    if d.startswith('MULTA'):
        return 'MULTA', None
    if d.startswith('JUROS'):
        return 'JUROS', None
    if 'ATUALIZ' in d or 'CORRECAO' in d:
        return 'ATUALIZACAO_MONETARIA', None
    if re.search(r'\b(DIC|FIC|DMIC|DICRI)\b', d):
        return 'COMPENSACAO_CONTINUIDADE', None
    if 'DEVOL' in d or 'ESTORNO' in d:
        return 'ESTORNO', None
    if 'CONSUMO' in d:
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
    d.setdefault('debitos_pendentes', [])
    pags = [(i + 1, palavras(p)) for i, p in enumerate(doc)]
    brutos = [p.get_text() for p in doc]
    t1 = [w for w in pags[0][1] if w.x0 > 40 or w.y1 > 60]  # descarta a régua "DEMFP" da margem
    d['extracao']['paginas_lidas'] = [p for p, _ in pags]
    d['extracao']['paginas'] = [{'pagina': p, 'tipo': 'conteudo', 'repete_pagina': None} for p, _ in pags]
    doc_, nf, uc_, tit, ref, tot = (d['documento'], d['documento']['nota_fiscal'], d['unidade_consumidora'],
                                    d['titular'], d['referencia'], d['totais'])
    doc_['distribuidora'] = 'Eletropaulo Metropolitana Eletricidade de São Paulo S.A.'
    doc_['distribuidora_sigla'] = 'ENEL SP'
    doc_['distribuidora_endereco'] = END_EMIT
    doc_['distribuidora_cnpj'], doc_['distribuidora_ie'] = '61.695.227/0001-93', '133.122.090.117'
    d['entrega']['endereco_devolucao'] = (f'{doc_["distribuidora"]} {END_EMIT} CNPJ: 61.695.227/0001-93 – Inscrição '
                                          'Estadual 133.122.090.117')
    nf['modelo'] = 'NF3e - DOCUMENTO AUXILIAR DA NOTA FISCAL DE ENERGIA ELÉTRICA ELETRÔNICA'
    topo = ' '.join(_txt(g) for y, g in _grupos([w for w in t1 if 10 < w.y1 < 35 and w.x0 > 300]))
    doc_['segunda_via'] = 'SEGUNDA VIA' in topo
    mm = re.search(r'Nº\s*(\d+)\s+Página\s*(\d+/\d+)', topo)
    if mm:
        doc_['controle'] = d['pagamento']['numero_fatura'] = mm[1]
        d['outros'].append({'pagina': 1, 'secao_impressa': 'Cabeçalho', 'rotulo': 'Nº / Página', 'valor': f'Nº {mm[1]} Página {mm[2]}'})
    if doc_['segunda_via']:
        d['outros'].append({'pagina': 1, 'secao_impressa': 'Cabeçalho', 'rotulo': 'via', 'valor': 'SEGUNDA VIA.'})
    # classificação / fornecimento / datas
    linhas_topo = [(y, g) for y, g in _grupos([w for w in t1 if 60 < w.y1 < 100])]
    cl, forn, datas = '', '', ''
    for y, g in linhas_topo:
        s_ = _txt([w for w in g if w.x0 < 215])
        if re.match(r'[AB]\s*-\s*[AB]\d', s_):
            cl = s_
            forn = _txt([w for w in g if 215 <= w.x0 < 300]) or forn
        elif re.fullmatch(r'TRIF\S*|MONOF\S*|BIF\S*|Trif\S*|Monof\S*|Bif\S*', _txt([w for w in g if 215 <= w.x0 < 300])):
            forn = _txt([w for w in g if 215 <= w.x0 < 300])
        if re.search(r'\d\d/\d\d/\d{4}\s+\d\d/\d\d/\d{4}\s+\d+\s+\d\d/\d\d/\d{4}', _txt([w for w in g if w.x0 >= 300])):
            datas = _txt([w for w in g if w.x0 >= 300])
    uc_['classificacao'] = cl or None
    mm = re.match(r'([AB])\s*-\s*([AB]\d\w?)\s*-\s*(\S+)\s*-\s*(.*?)\s*-\s*(.*)', cl)
    if mm:
        uc_['grupo'], uc_['subgrupo'] = mm[1], mm[2]
        uc_['modalidade_tarifaria'] = mm[3].capitalize()
        uc_['classe'], uc_['subclasse'] = mm[4], mm[5]
    uc_['tipo_fornecimento'] = forn or None
    mm = re.search(r'(\d\d/\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+(\d+)\s+(\d\d/\d\d/\d{4})', datas)
    if mm:
        ref.update({'leitura_anterior': data_br(mm[1]), 'leitura_atual': data_br(mm[2]), 'dias_faturados': int(mm[3]),
                    'proxima_leitura': data_br(mm[4])})
    # cliente
    cli = [_txt(g) for y, g in _grupos([w for w in t1 if 92 < w.y1 < 132 and w.x0 < 200])]
    cli = [c for c in cli if not c.startswith(('CLASSIFICA', 'A - ', 'B - '))]
    cli = [c for c in cli if not re.fullmatch(r'[\d/]+', c)]
    if cli:
        tit['nome'] = cli[0]
        for c in cli[1:]:
            mm = re.match(r'(?:CPF/)?CNPJ:\s*(\S+)\s*(?:INSC\.\s*EST:\s*(\S+))?|CPF:\s*(\S+)', c)
            if mm:
                v = mm[1] or mm[3]
                tit['cnpj_cpf_mascarado' if '*' in v else 'cnpj_cpf'] = v
                tit['inscricao_estadual'] = mm[2]
                continue
            mm = re.match(r'CEP:\s*(\d{5}-\d{3})\s*-\s*(.*?)/([A-Z]{2})$', c)
            if mm:
                tit['cep'], tit['cidade'], tit['uf'] = mm[1], mm[2], mm[3]
                continue
            tit['endereco'] = c
        if tit['endereco']:
            uc_['endereco'] = f'{tit["endereco"]} - CEP: {tit["cep"]} - {tit["cidade"]}/{tit["uf"]}' if tit['cep'] else tit['endereco']
    # quadro (UC/cliente/referência/vencimento/total)
    caixa = ' '.join(_txt(g) for y, g in _grupos([w for w in t1 if 105 < w.y1 < 180 and 40 < w.x0 < 300 and
                                                     not (92 < w.y1 < 132 and w.x0 < 200)]))
    mm = re.search(r'R\$\s*([\d.]+,\d\d)', caixa)
    tot['total_a_pagar'] = tot['total_consolidado'] = num(mm[1]) if mm else None
    mm = re.search(r'(?<![\d/])(\d\d)/(\d{4})(?![\d/])', caixa)
    if mm:
        ref['mes_referencia'] = f'{mm[2]}-{mm[1]}'
    mm = re.search(r'(\d\d/\d\d/\d{4})', caixa)
    ref['data_vencimento'] = data_br(mm[1]) if mm else None
    mm = re.search(r'(\d{6,}\s*/\s*\d{6,})', caixa)
    if mm:
        uc_['uc'] = uc_['instalacao'] = re.sub(r'\s*/\s*', ' / ', mm[1])
    else:
        ns = [w for w in t1 if 105 < w.y1 < 150 and 200 < w.x0 < 300 and re.fullmatch(r'\d{6,}', w.t)]
        ns.sort(key=lambda w: w.y1)
        if ns:
            uc_['uc'] = uc_['instalacao'] = ns[0].t
        if len(ns) > 1:
            tit['codigo_cliente'] = ns[1].t
    # NF3e
    tn = ' '.join(_txt(g) for y, g in _grupos([w for w in t1 if 105 < w.y1 < 172 and w.x0 >= 275]))
    tn = re.sub(r'(\d\d/\d\d/\d{3}) (\d)\b', r'\1\2', tn)
    mm = re.search(r'NOTA FISCAL Nº\s*(\d+)\s*-\s*S[ée]rie\s*(\w+)', tn, re.I)
    if mm:
        nf['numero'], nf['serie'] = mm[1], mm[2]
    mm = re.search(r'DATA DE EMISSÃO:\s*(\d\d/\d\d/\d{4})', tn)
    if mm:
        nf['data_emissao'] = ref['data_emissao'] = data_br(mm[1])
    mm = re.search(r'\b([0-9A-F]{4}(?:\.[0-9A-F]{4}){7})\b', tn)
    if mm:  # modelo 2025 (antes da NF3e): código de autenticação
        nf['reservado_fisco'] = mm[1]
    mm = re.search(r'(http\S+)\s+(consulta)', tn)
    nf['url_consulta'] = mm[1] + mm[2] if mm else None
    mm = re.search(r'acesso:\s*((?:\d{4}\s?){11})', tn)
    if mm:
        nf['chave_acesso'] = re.sub(r'\s', '', mm[1])
        d['outros'].append({'pagina': 1, 'secao_impressa': 'INFORMAÇÕES FISCAIS', 'rotulo': 'Chave de acesso (como impressa)',
                            'valor': mm[1].strip()})
    mm = re.search(r'autorização:\s*(\d+)\s*-\s*(\d\d/\d\d/\d{4})\s*às\s*(\d\d:\d\d:\d\d)(\S*)', tn)
    if mm:
        nf['protocolo_autorizacao'] = mm[1]
        nf['data_autorizacao'] = f'{data_br(mm[2])}T{mm[3]}'
    mm = re.search(r'CFOP\s*(\d+:.*?)\s+Data de apresentação', tn) or re.search(r'CFOP:\s*(\d+\s*\(.*?\))', tn)
    nf['cfop'] = mm[1].strip() if mm else None
    mm = re.search(r'Data de apresentação:\s*(\d\d/\d\d/\d{4})', tn)
    nf['data_apresentacao'] = data_br(mm[1]) if mm else None
    uc_['tecnico'] = {'tensao_nominal': None, 'tensao_contratada_v': None, 'tensao_fornecimento_kv': None,
                      'tensao_minima': None, 'tensao_maxima': None, 'faixa_adequada': None,
                      'fator_potencia_referencia': None, 'rtc': None, 'rtp': None, 'constantes': [],
                      'perdas_transformacao_pct': None, 'horario_ponta': None, 'equipamento_medidor': None,
                      'responsavel_iluminacao_publica': None}
    _mensagens(t1, d)
    _medicoes(t1, d)
    _itens(t1, d)
    _contratadas_tributos(t1, d)
    _historico(t1, d)
    _boleto(t1, brutos[0], d)
    _debitos(t1, d)
    if not d['pagamento']['linha_digitavel']:
        for b in brutos[1:]:
            mm = re.search(r'\b(8\d{11} \d{12} \d{12} \d{12})\b', re.sub(r'\s+', ' ', b))
            if mm:
                d['pagamento']['linha_digitavel'] = mm[1]
                break
    if (d['pagamento']['linha_digitavel'] or '').startswith('8'):
        d['pagamento'].setdefault('boleto', {})['beneficiario'] = 'ENEL DISTRIBUIÇÃO SÃO PAULO'
    for b in brutos[1:]:
        if 'Nº do cliente:' in b:
            _envelope(b, d)
            break
    for np_, t in pags[2:]:
        if 'Demonstrativo complementar' in brutos[np_ - 1] or any(w.t == 'Instalação' for w in t) or d['gd']['rateio_beneficiarias']:
            _demonstrativo(t, d, np_)
    uc_['geracao']['e_gerador'] = bool(d['gd']['rateio_beneficiarias']) or \
        any(i['componente'] in ('DEMANDA_GERACAO', 'CONSUMO_COMPENSADO') for i in d['itens'])
    if d['gd']['rateio_beneficiarias'] or any(m['grandeza'].endswith('INJ') for m in d['medicoes']):
        d['gd']['uc_geradora'] = (uc_['uc'] or '').split(' / ')[0] or None
    d['historico_formato'] = 'tabela' if d['historico'] else 'so_grafico'
    _provas(d)
    return d


def _mensagens(t1, d):
    ls = [(y, _txt(g)) for y, g in _grupos([w for w in t1 if 190 < w.y1 < 300 and w.x0 < 300])]
    txt = ' '.join(s for _, s in ls)
    if txt:
        d['mensagens'].append({'pagina': 1, 'texto': 'MENSAGENS IMPORTANTES: ' + txt})
    mm = re.search(r'Bandeira\(s\) tarifária\(s\) aplicada\(s\) no mês:\s*((?:VERDE|AMARELA|VERMELHA\s*\d?|ESCASSEZ)(?:\s+(?:VERDE|AMARELA|VERMELHA\s*\d?))*)', txt)
    if mm:
        for cor in re.findall(r'VERDE|AMARELA|VERMELHA\s*\d?|ESCASSEZ', mm[1]):
            cor = cor.replace(' ', '_')
            d['bandeiras'].append({'pagina': 1, 'cor': 'VERMELHA_1' if cor == 'VERMELHA' else cor, 'inicio': None,
                                   'fim': None, 'dias': None})
    for ind, mm in zip(('DEC', 'FEC'), re.finditer(r'\((Ano/[^)]*)\):\s*([\d./]+)', txt)):
        rots, vals = mm[1].split('/'), mm[2].split('/')
        for r_, v in zip(rots, vals):
            ano = r_ == 'Ano'
            d['qualidade_servico'].append({'indicador': ind, 'conjunto': 'conjunto da UC (nome não impresso)',
                                           'periodo_apuracao': r_, 'limite_mensal': None, 'limite_trimestral': None,
                                           'limite_anual': None, 'apurado_mensal': None if ano else float(v),
                                           'apurado_trimestral': None, 'apurado_anual': float(v) if ano else None})
    gd = d['gd']
    for rot, tipo in (('Saldo atualizado de energia em kWh', 'saldo_atual'), ('Energia injetada no mês em kWh', 'injetada')):
        mm = re.search(re.escape(rot) + r':\s*(-?[\d.,]+-?)(?=\s+-\s|\s*$)', txt)
        if mm:
            gd['lancamentos'].append({'pagina': 1, 'tipo': tipo, 'posto': 'TODOS', 'kwh': num(mm[1]), 'mes_ref': None,
                                      'ref_expiracao': None, 'unidade_impressa': 'kWh', 'rotulo': f'{rot}: {mm[1]}'})
    mm = re.search(r'Saldo atualizado de energia em kWh:\s*(.*?)(?=\s*-\s*Energia|$)', txt)
    if mm:
        for po, v in re.findall(r'(Fora Ponta|Ponta):\s*([\d.,]+-?)', mm[1]):
            gd['lancamentos'].append({'pagina': 1, 'tipo': 'saldo_atual', 'posto': 'FORA_PONTA' if po.startswith('Fora') else 'PONTA',
                                      'kwh': num(v), 'mes_ref': None, 'ref_expiracao': None, 'unidade_impressa': 'kWh',
                                      'rotulo': f'Saldo atualizado de energia em kWh: {po}: {v}'})
    mm = re.search(r'Energia injetada no mês em kWh:\s*(.*?)(?=\s+-\s|$)', txt)
    if mm:
        for po, v in re.findall(r'(Fora Ponta|Ponta):\s*([\d.,]+-?)', mm[1]):
            gd['lancamentos'].append({'pagina': 1, 'tipo': 'injetada', 'posto': 'FORA_PONTA' if po.startswith('Fora') else 'PONTA',
                                      'kwh': num(v), 'mes_ref': None, 'ref_expiracao': None, 'unidade_impressa': 'kWh',
                                      'rotulo': f'Energia injetada no mês em kWh: {po}: {v}'})


def _medicoes(t1, d):
    hdr = next((w for w in t1 if w.t == 'Medidor' and w.x0 < 80 and 290 < w.y1 < 330), None)
    if not hdr:
        return
    xi = 275
    y_fim = next((w.y1 for w in t1 if w.t == 'TRIBUTOS' and w.y1 > hdr.y1), 480) - 6
    ws = [w for w in t1 if hdr.y1 + 6 < w.y1 < y_fim and w.x0 < xi]
    anc = _ancoras([w for w in ws if w.x0 >= 165 and e_numero(w.t)], 4, ANC_MED)
    gr_ant = None
    for y, g in _grupos(ws, 2.0):
        med = next((w.t for w in g if w.x0 < 70 and re.fullmatch(r'\d{5,}', w.t)), None)
        gr = _txt([w for w in g if 70 <= w.x0 < 130])
        po = _txt([w for w in g if 130 <= w.x0 < 165])
        nums = [w for w in g if w.x0 >= 165 and e_numero(w.t)]
        # leitura não executada: a coluna traz o texto "Não Exec." no lugar do número (usinas GD com medidor de
        # registro bidirecional); grava o texto em colunas_originais e o campo numérico fica None (não se infere)
        txts = [w for w in g if w.x0 >= 165 and not e_numero(w.t)]
        if len(nums) < 4 and not (len(nums) == 3 and re.fullmatch(r'N[ãa]o Exec\.?', _txt(txts))):
            continue
        if not gr:  # grandeza impressa na linha de baixo (DEMANDA DE GERAÇÃO)
            prox = [w for w in ws if y < w.y1 < y + 4 and 70 <= w.x0 < 130]
            gr = _txt(sorted(prox, key=lambda w: w.x0)) or gr_ant
        gr_ant = gr
        cols = _col(nums, anc)
        if txts:
            k = min(anc, key=lambda c: abs(anc[c] - max(w.x1 for w in txts)))
            if k not in cols:
                cols[k] = _txt(txts)
        un = 'kW' if gr.startswith(('DEMANDA', 'DEM ')) else ('kVArh' if 'RTV' in gr else 'kWh')
        d['medicoes'].append({'pagina': 1, 'tabela_origem': 'DADOS DE MEDIÇÃO', 'medidor': med, 'grandeza': gr,
                              'posto': _posto_med(po), 'leitura_anterior': num(cols.get('leitura_anterior')),
                              'leitura_atual': num(cols.get('leitura_atual')), 'constante': num(cols.get('constante')),
                              'perdas_pct': None, 'ajuste': None, 'consumo': num(cols.get('consumo')),
                              'consumo_faturado': None, 'fator_potencia': None, 'ajuste_fator_potencia': None,
                              'unidade': un, 'data_hora_registro': None, 'leitura_arredondada': False,
                              'colunas_originais': {'Medidor': med, 'Grandezas': gr, 'Postos Tarifários': po,
                                                    'Leitura Anterior': cols.get('leitura_anterior'),
                                                    'Leitura Atual': cols.get('leitura_atual'),
                                                    'Const. Medidor': cols.get('constante'),
                                                    'Consumo kWh/kW': cols.get('consumo')}})
        if med and med not in d['unidade_consumidora']['medidor']:
            d['unidade_consumidora']['medidor'].append(med)
    vis = {}
    for m in d['medicoes']:
        if m['constante'] is not None:
            vis.setdefault(m['grandeza'], m['constante'])
    d['unidade_consumidora']['tecnico']['constantes'] = [{'grandeza': g, 'valor': v} for g, v in sorted(vis.items())]
    for m in d['medicoes']:
        if m['unidade'] == 'kW' and m['grandeza'].startswith('DEMANDA'):
            ger = 'GERA' in sem_acento(m['grandeza']).upper()
            rot = f'DADOS DE MEDIÇÃO: {m["grandeza"]} {m["colunas_originais"]["Postos Tarifários"]}'.strip()
            d['demanda'].append({'pagina': 1, 'tipo': 'geracao' if ger else 'consumo', 'posto': m['posto'],
                                 'contratada_kw': None, 'medida_kw': m['consumo'], 'faturada_kw': None,
                                 'faturada_ultrapassagem_kw': None, 'nao_consumida_kw': None, 'data_hora': None,
                                 'rotulo': rot, 'colunas_originais': dict(m['colunas_originais'])})


def _itens(t1, d):
    hdr = next((w for w in t1 if w.t == 'Itens' and w.x0 > 265 and 290 < w.y1 < 330), None)
    if not hdr:
        return
    tw = next((w for w in t1 if w.t == 'TOTAL' and hdr.x0 - 5 < w.x0 < 300 and w.y1 > hdr.y1), None)
    y_fim = tw.y1 + 1 if tw else 480
    ws = [w for w in t1 if hdr.y1 + 6 < w.y1 < y_fim and w.x0 >= 275]
    un_w = next((w for w in t1 if w.t == 'Unid.' and abs(w.y1 - hdr.y1) < 3), None)
    ux0, ux1 = (un_w.x0 - 6, un_w.x1 + 3) if un_w else (362, 380)
    anc = _ancoras([w for w in ws if w.x0 >= ux1 and re.fullmatch(r'-?[\d.]*\d,\d+-?|\d+%', w.t)], 8, ANC_IT)
    tot = d['totais']
    for y, g in _grupos(ws, 2.0):
        unid = next((w.t for w in g if ux0 <= w.x0 < ux1 and re.fullmatch(r'KWH|KW|KVARH|KVAR|kWh|kW', w.t)), None)
        desc = _txt([w for w in g if w.x0 < ux0 + 3 and w.t != unid])
        nums = [w for w in g if w.x0 >= ux1 and re.fullmatch(r'-?[\d.]*\d,\d+-?|\d+%', w.t)]
        if not desc:
            continue
        cols = _col(nums, anc)
        if desc.startswith('Subtotal') or desc == 'TOTAL':
            tot['subtotais'].append({'pagina': 1, 'rotulo': desc, 'valor': num(cols.get('valor'))})
            for k in ('valor', 'pis_cofins', 'base_icms', 'icms'):
                if k in cols and not (desc == 'TOTAL' and False):
                    if desc == 'TOTAL' or k != 'valor':
                        tot['totais_colunas'].append({'pagina': 1, 'coluna': f'{desc} - {ROT_IT[k].replace("PIS/ COFINS", "PIS/COFINS")}',
                                                      'valor': num(cols[k])})
            continue
        if not nums:
            if d['itens'] and d['itens'][-1]['descricao']:  # continuação da descrição
                d['itens'][-1]['descricao'] += ' ' + desc
            continue
        comp, posto = componente_de(desc)
        mm = re.search(r'(\d\d)/(\d\d)', desc)
        al = cols.get('aliquota_icms')
        d['itens'].append({'pagina': 1, 'secao_impressa': 'DESCRIÇÃO DO FATURAMENTO', 'codigo': None, 'descricao': desc,
                           'mes_ref': f'20{mm[2]}-{mm[1]}' if mm and comp == 'CONSUMO_COMPENSADO' else None,
                           'componente': comp, 'posto': posto, 'quantidade_registrada': None,
                           'quantidade_faturada': num(cols.get('quant')), 'unidade': unid,
                           'tarifa_com_tributos': num(cols.get('preco')), 'tarifa_sem_tributos': num(cols.get('tarifa')),
                           'valor': num(cols.get('valor')), 'valor_sem_tributos': None,
                           'base_icms': num(cols.get('base_icms')), 'aliquota_icms': num(al.rstrip('%')) if al else None,
                           'icms': num(cols.get('icms')), 'base_pis_cofins': None, 'aliquota_pis': None, 'pis': None,
                           'aliquota_cofins': None, 'cofins': None, 'pis_cofins': num(cols.get('pis_cofins')),
                           'nf_referencia': None,
                           'colunas_originais': {'Itens de Fatura': desc, 'Unid.': unid,
                                                 **{ROT_IT[k]: cols.get(k) for k in ANC_IT}}})
    ilum = [i['valor'] for i in d['itens'] if i['componente'] == 'ILUMINACAO_PUBLICA' and i['valor'] is not None]
    tot['valor_cosip_cip'] = round(sum(ilum), 2) if ilum else None
    for i in d['itens']:
        if i['componente'].startswith('DEMANDA'):
            ger = i['componente'].startswith('DEMANDA_GERACAO')
            d['demanda'].append({'pagina': 1, 'tipo': 'geracao' if ger else 'consumo', 'posto': i['posto'],
                                 'contratada_kw': None, 'medida_kw': None,
                                 'faturada_kw': None if 'ULTRA' in i['componente'] else i['quantidade_faturada'],
                                 'faturada_ultrapassagem_kw': i['quantidade_faturada'] if 'ULTRA' in i['componente'] else None,
                                 'nao_consumida_kw': None, 'data_hora': None,
                                 'rotulo': f'DESCRIÇÃO DO FATURAMENTO: {i["descricao"]}',
                                 'colunas_originais': {'Itens de Fatura': i['descricao'],
                                                       'Quant.': i['colunas_originais'][ROT_IT['quant']]}})


def _contratadas_tributos(t1, d):
    for y, g in _grupos([w for w in t1 if 485 < w.y1 < 530 and 185 < w.x0 < 305]):
        s = _txt(g)
        mm = re.match(r'(Demanda.*?-\s*KW)\s+([\d.,]+)$', s)
        if mm:
            ger = 'Gera' in mm[1]
            d['demanda'].insert(0 if not ger else min(1, len(d['demanda'])), {
                'pagina': 1, 'tipo': 'geracao' if ger else 'consumo', 'posto': 'GERACAO' if ger else None,
                'contratada_kw': num(mm[2]), 'medida_kw': None, 'faturada_kw': None, 'faturada_ultrapassagem_kw': None,
                'nao_consumida_kw': None, 'data_hora': None, 'rotulo': f'GRANDEZAS CONTRATADAS: {mm[1]}',
                'colunas_originais': {mm[1]: mm[2]}})
    for y, g in _grupos([w for w in t1 if 485 < w.y1 < 530 and w.x0 < 186]):
        s = _txt(g)
        mm = re.match(r'(PIS/PASEP|COFINS|ICMS)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)$', s)
        if mm:
            d['tributos'].append({'pagina': 1, 'tributo': mm[1], 'base': num(mm[2]),
                                  'aliquota': num(mm[3], ponto_decimal=re.fullmatch(r'\d+\.\d\d', mm[3]) is not None),
                                  'valor': num(mm[4]), 'retido': False,
                                  'colunas_originais': {'TRIBUTOS': mm[1], 'BASE CALC (R$)': mm[2], 'ALÍQUOTA (%)': mm[3],
                                                        'VALOR (R$)': mm[4]}})
    rf = _l(t1, 490, 502, 295, 450)
    if rf:
        d['documento']['nota_fiscal']['reservado_fisco'] = rf
        d['outros'].append({'pagina': 1, 'secao_impressa': 'RESERVADO AO FISCO', 'rotulo': 'texto', 'valor': rf})


def _historico(t1, d):
    hdr = next((w for w in t1 if w.t == 'Mês/Ano' and 540 < w.y1 < 575), None)
    if not hdr:
        return
    for y, g in _grupos([w for w in t1 if hdr.y1 + 8 < w.y1 < hdr.y1 + 110 and w.x0 < 300]):
        if not re.fullmatch(r'[A-Z]{3}/\d\d', g[0].t) or g[0].t[:3] not in MESES:
            continue
        mes = f'20{g[0].t[4:]}-{MESES[g[0].t[:3]]}'
        cols = _col([w for w in g[1:] if e_numero(w.t) and w.x0 < 296], {'dem': 123, 'p': 204, 'fp': 258, 'dias': 292})
        co = {'Mês/Ano': g[0].t, 'Demanda kW': cols.get('dem'), 'Consumo Faturado kWh Hora Ponta': cols.get('p'),
              'Consumo Faturado kWh Hora Fora Ponta': cols.get('fp'), 'Nº DIAS FAT': cols.get('dias')}
        for k, serie, po, un in (('dem', 'demanda', None, 'kW'), ('p', 'consumo', 'PONTA', 'kWh'),
                                 ('fp', 'consumo', 'FORA_PONTA', 'kWh'), ('dias', 'dias', None, 'dias')):
            if cols.get(k) is not None:
                d['historico'].append({'pagina': 1, 'tabela': 'HISTÓRICO DO FATURAMENTO', 'mes': mes, 'serie': serie,
                                       'posto': po, 'valor': num(cols[k]), 'unidade': un, 'unidade_original': un,
                                       'faturado_pela_media': False, 'colunas_originais': co})


def _debitos(t1, d):
    lab = next((w for w in t1 if w.t == 'Vencimento' and w.x0 > 280 and w.y1 > 540), None)
    if not lab:
        return
    for y, g in _grupos([w for w in t1 if lab.y1 + 2 < w.y1 < lab.y1 + 40 and w.x0 > 280]):
        ws = [w.t for w in g]
        for k in range(0, len(ws) - 1, 2):
            if re.fullmatch(r'\d\d\.\d\d\.\d{4}', ws[k]) and re.fullmatch(r'[\d.]+,\d\d', ws[k + 1]):
                d['debitos_pendentes'].append({'referencia': None, 'vencimento': data_br(ws[k].replace('.', '/')),
                                               'data_reaviso': None, 'valor': num(ws[k + 1])})


def _boleto(t1, bruto, d):
    pag = d['pagamento']
    tudo = re.sub(r'\s+', ' ', bruto)
    mm = re.search(r'\b(\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14})\b', tudo) or \
        re.search(r'\b(8\d{11} \d{12} \d{12} \d{12})\b', tudo)
    pag['linha_digitavel'] = mm[1] if mm else None
    mm = re.search(r'(Sua conta não está em débito automático\? Cadastre-se em seu banco com o código: (\d+))', tudo)
    if mm:
        pag['debito_automatico'] = mm[1]
        d['titular']['conta_contrato'] = mm[2]
    mm = re.search(r'(ENEL DISTRIBUIÇÃO SÃO PAULO 0800 [\d ]+\d)', tudo)
    if mm:
        d['unidade_consumidora']['tecnico']['responsavel_iluminacao_publica'] = mm[1]
    if 'Pague via PIX' in tudo:
        pag['pix'] = "QR Code 'Pague via PIX! Utilize este QRCode' (conteúdo não transcrito)"
    if not pag['linha_digitavel']:
        return
    mm = re.search(r'BANCO\s+(\w+)\s+(\d{3}-\d)', tudo)
    pag['banco'] = f'BANCO {mm[1]} {mm[2]}' if mm else None

    def abaixo(rot, x0, x1, dy=(2, 12)):
        lab = next((w for w in t1 if w.t == rot and x0 <= w.x0 < x1 and w.y1 > 700), None)
        if not lab:
            return None
        return _l(t1, lab.y1 + dy[0], lab.y1 + dy[1], x0, x1) or None
    bol = {'nosso_numero': None, 'numero_documento': None, 'carteira': None, 'especie': None, 'aceite': None,
           'data_documento': None, 'data_processamento': None, 'beneficiario': None,
           'agencia_codigo_beneficiario': None, 'pagador': None, 'local_pagamento': None, 'instrucoes': None}
    mm = re.search(r'Nosso Número\s+(\S+)\s+(\S+)\s+Uso do Banco', tudo)
    bol['nosso_numero'] = f'{mm[1]} {mm[2]}' if mm else None
    mm = re.search(r'Data do Documento\s+(\d\d/\d\d/\d{4})\s+Nr\. Documento\s+(\d+)\s+Especie DOC\s+(\S+)\s+Aceite\s+(\S+)'
                   r'\s+Data do Processamento\s+(\d\d/\d\d/\d{4})', tudo)
    if mm:
        bol['data_documento'], bol['numero_documento'] = data_br(mm[1]), mm[2]
        bol['especie_doc'], bol['aceite'], bol['data_processamento'] = mm[3], mm[4], data_br(mm[5])
    mm = re.search(r'Carteira\s+(\d+)\s+Especie\s+(\S+)', tudo)
    if mm:
        bol['carteira'], bol['especie'] = mm[1], mm[2]
    mm = re.search(r'Nome do Beneficiário/CPF/CNPJ\s+(.*?)\s+Agência/Código do Beneficiário\s+(\S+)', tudo)
    if mm:
        bol['beneficiario'], bol['agencia_codigo_beneficiario'] = mm[1], mm[2]
        pag['agencia'] = mm[2].split('-')[0]
    mm = re.search(r'Loca de Pagamento\s+(.*?)\s+Data de Vencimento\s+(\d\d/\d\d/\d{4})', tudo)
    if mm:
        bol['local_pagamento'], bol['data_vencimento'] = mm[1], data_br(mm[2])
    mm = re.search(r'Informações de Responsabilidade do Beneficiário\s+(.*?)\s+\(-\) Desconto/Abatimento\s+(.*?)\s+\(\+\)', tudo)
    if mm:
        bol['instrucoes'] = f'{mm[1]} {mm[2]}'.strip()
    mm = re.search(r'\(=\) Valor do Documento\s+R\$\s*([\d.]+,\d\d)', tudo)
    bol['valor_documento'] = num(mm[1]) if mm else None
    mm = re.search(r'\(=\) Valor Cobrado\s+R\$\s*([\d.]+,\d\d)', tudo)
    bol['valor_cobrado'] = num(mm[1]) if mm else None
    mm = re.search(r'Nome do Pagador/CPF/CNPJ/Endereço\s+(.*?)\s+Sacador/Avalista', tudo)
    bol['pagador'] = re.sub(r'\s+', ' ', mm[1]).strip() if mm else None
    pag['boleto'] = bol
    mm = re.search(r'(- ENCARGOS POR ATRASO.*?)(?=\s{2}|$)', tudo)
    if mm:
        d['mensagens'].append({'pagina': 1, 'texto': 'MENSAGEM (canhoto/recibo): ' + mm[1].strip()})


def _envelope(bruto, d):
    ls = [x.strip() for x in bruto.split('\n') if x.strip()]
    ent = d['entrega']
    k = next((j for j in range(len(ls) - 2) if re.fullmatch(r'\d\d/\d\d/\d{4}', ls[j]) and re.fullmatch(r'\d\d/\d{4}', ls[j + 1])), None)
    if k is None:
        return
    j = k + 3
    if j + 2 < len(ls):
        ent['unidade_entrega'], ent['sequencia'] = ls[j], ls[j + 1]
        d['outros'].append({'pagina': 2, 'secao_impressa': 'Envelope', 'rotulo': 'Nº medidor', 'valor': ls[j + 2]})
        fim = next((i for i in range(j + 3, len(ls)) if ls[i].startswith('Nº do cliente')), None)
        if fim is not None:
            ent['endereco_correspondencia'] = ' '.join(ls[j + 3:fim + 1])
            mm = re.search(r'Nº do cliente:\s*(\d+)', ls[fim])
            if mm and not d['titular']['codigo_cliente']:
                d['titular']['codigo_cliente'] = mm[1]


def _demonstrativo(t, d, np_):
    gd = d['gd']
    # saldo anterior (Pta / FPta)
    desc = next((w for w in t if w.t == 'Descrição'), None)
    cab = {}
    if desc:
        cab = {w.t: (w.x0 + w.x1) / 2 for w in t if abs(w.y1 - desc.y1) < 3 and w.t in ('Atv', 'Pta', 'FPta', 'Int')}
        sa = next((w for w in t if w.t == 'Saldo' and w.x0 < 40 and w.y1 > desc.y1), None)
        if sa and cab:
            for w in t:
                if sa.y1 - 1 < w.y1 < sa.y1 + 9 and w.x0 > 300 and e_numero(w.t):
                    col = min(cab, key=lambda c: abs(cab[c] - (w.x0 + w.x1) / 2))
                    po = {'Pta': 'PONTA', 'FPta': 'FORA_PONTA', 'Int': 'INTERMEDIARIO', 'Atv': None}[col]
                    gd['lancamentos'].append({'pagina': np_, 'tipo': 'saldo_anterior', 'posto': po, 'kwh': num(w.t),
                                              'mes_ref': None, 'ref_expiracao': None, 'unidade_impressa': 'kWh',
                                              'rotulo': f'Saldo anterior de créditos ({col})'})
        for w0 in t:
            if w0.x0 < 40 and w0.t in ('Próxima', 'Total') and w0.y1 > desc.y1 and cab:
                lin = _l(t, w0.y1 - 2, w0.y1 + 2, 0, 360)
                mm = re.search(r'a expirar em (\d\d)/(\d{4})', lin)
                tipo = 'a_expirar' if mm else ('expirado' if 'expirados' in lin else None)
                if not tipo:
                    continue
                for w in t:
                    if w0.y1 - 2 < w.y1 < w0.y1 + 9 and w.x0 > 360 and e_numero(w.t):
                        col = min(cab, key=lambda c: abs(cab[c] - (w.x0 + w.x1) / 2))
                        po = {'Pta': 'PONTA', 'FPta': 'FORA_PONTA', 'Int': 'INTERMEDIARIO', 'Atv': None}[col]
                        gd['lancamentos'].append({'pagina': np_, 'tipo': tipo, 'posto': po, 'kwh': num(w.t), 'mes_ref': None,
                                                  'ref_expiracao': f'{mm[2]}-{mm[1]}' if mm else None,
                                                  'unidade_impressa': 'kWh', 'rotulo': f'{lin} ({col})'})
    # créditos distribuídos por UC (duas metades)
    hdrs = sorted([w for w in t if w.t == 'Instalação'], key=lambda w: w.x0)
    if hdrs:
        y_h = hdrs[0].y1
        cols = {w.t + ('2' if w.x0 > 300 else ''): (w.x0 + w.x1) / 2 for w in t
                if abs(w.y1 - y_h) < 3 and w.t in ('Atv', 'Pta', 'FPta', 'Int')}
        d['_enel_cols'] = cols
    else:
        y_h = 0
        cols = d.get('_enel_cols') or {}
    if not cols:
        return
    y_fim = next((w.y1 for w in t if w.t == 'Histórico' and w.y1 > y_h), 2000)
    for y, g in _grupos([w for w in t if y_h + 4 < w.y1 < y_fim - 4]):
        for metade in (0, 1):
            ws = [w for w in g if (w.x0 > 300) == bool(metade)]
            inst = next((w for w in ws if re.fullmatch(r'\d{6,}', w.t)), None)
            if not inst:
                continue
            reg = {}
            for w in ws:
                if w is inst or not re.fullmatch(r'[\d.]+(,\d+)?-?', w.t):
                    continue
                cs = {k: v for k, v in cols.items() if k.endswith('2') == bool(metade)}
                k = min(cs, key=lambda c: abs(cs[c] - (w.x0 + w.x1) / 2)).rstrip('2')
                reg[k] = w.t
            # o quadro não imprime total por instalação: kwh só recebe o valor impresso quando há UMA coluna preenchida
            # (Atv/Pta/FPta/Int); com dois postos, kwh fica None e os valores ficam em kwh_ponta/kwh_fora_ponta
            # (regra da casa: grava o impresso, não soma)
            p, fp = num(reg.get('Pta')), num(reg.get('FPta'))
            unico = [num(v) for v in reg.values()]
            gd['rateio_beneficiarias'].append({'uc': inst.t, 'percentual': None,
                                               'kwh': unico[0] if len(unico) == 1 else None,
                                               'kwh_ponta': p, 'kwh_fora_ponta': fp, 'pagina': np_,
                                               'colunas_originais': {'Instalação': inst.t, 'Atv': reg.get('Atv'),
                                                                     'Pta': reg.get('Pta'), 'FPta': reg.get('FPta'),
                                                                     'Int': reg.get('Int')}})
    # histórico de 12 meses (consumida / injetada × ponta / fora ponta)
    hist = next((w for w in t if w.t == 'Histórico' and w.x0 > 150), None)
    if not hist:
        return
    meses = [w for w in t if re.fullmatch(r'[A-Z]{3}/\d\d', w.t) and w.t[:3] in MESES and w.y1 > hist.y1]
    if not meses:
        return
    centros = {w.t: (w.x0 + w.x1) / 2 for w in meses}
    serie = None
    tab = 'Histórico de energia dos últimos 12 meses kWh (Demonstrativo complementar de Micro e Minigeração)'
    for y, g in _grupos([w for w in t if hist.y1 < w.y1 < hist.y1 + 160]):
        s = _txt(g)
        if s.startswith('Consumida'):
            serie = 'consumo'
            continue
        if s.startswith('Injetada'):
            serie = 'injetada'
            continue
        mm = re.match(r'(FORA PONTA|PONTA)\b', s)
        if not mm or not serie:
            continue
        po = 'FORA_PONTA' if mm[1] == 'FORA PONTA' else 'PONTA'
        for w in g:
            if w.x0 < 100 or not re.fullmatch(r'[\d.]+', w.t):
                continue
            m_ = min(centros, key=lambda c: abs(centros[c] - (w.x0 + w.x1) / 2))
            d['historico'].append({'pagina': np_, 'tabela': tab, 'mes': f'20{m_[4:]}-{MESES[m_[:3]]}', 'serie': serie,
                                   'posto': po, 'valor': int(num(w.t)), 'unidade': 'kWh', 'unidade_original': 'kWh',
                                   'faturado_pela_media': False})


def _provas(d):
    d.pop('_enel_cols', None)
    div = d['extracao']['divergencias_impressas']
    for j, m in enumerate(d['medicoes']):
        la, lb, c, cons = m['leitura_anterior'], m['leitura_atual'], m['constante'], m['consumo']
        if None in (la, lb, c, cons) or abs((lb - la) * c - cons) <= max(1, abs(cons) * 0.01):
            continue
        if m['unidade'] == 'kW' and abs(lb * c - cons) <= max(0.05, abs(cons) * 0.01):
            div.append({'onde': 'medicao', 'indice': j, 'nota': f'impresso: consumo {cons} = leitura atual {lb} × constante '
                        f'{c} (registrador de demanda/máximo, não diferença de leituras)'})
