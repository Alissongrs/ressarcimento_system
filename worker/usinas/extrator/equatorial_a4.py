"""Parser determinístico das faturas Equatorial no layout DANF3E A4 (PI; testar AL/MA/PA), 2–4 páginas, 595×842.

Cabeçalhos das colunas estão no texto: itens, medições e quadros da direita são lidos pela borda direita dos
cabeçalhos. p1: dados, informações ao cliente (bandeira, GD, avisos), itens, tributos, grandezas contratadas,
medições, informações sobre consumo, boleto; p2: histórico (8 colunas) e tarifas sem tributos; p3 repete a p1.
"""
import re

from base import (colunas_por_ancora, data_br, e_numero, esqueleto, linhas, mes_ano, num, palavras, posto_de,
                  sem_acento)

NOME = 'equatorial_a4_v1'
CNPJS = {'01.543.032/0001-04': 'EQUATORIAL GO', '12.272.084/0001-00': 'EQUATORIAL AL',
         '04.895.728/0001-80': 'EQUATORIAL PA', '06.272.793/0001-84': 'EQUATORIAL MA',
         '06.840.748/0001-89': 'EQUATORIAL PI'}
MES3 = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ']
HIST8 = [('DEMANDA MEDIDA PONTA', 'demanda', 'PONTA', 'kW'), ('DEMANDA MEDIDA FORA PONTA', 'demanda', 'FORA_PONTA', 'kW'),
         ('DEMANDA MEDIDA REATIVO EXCEDENTE', 'reativo_dre', None, 'kVAr'),
         ('CONSUMO FATURADO PONTA/TOT', 'consumo', 'PONTA', 'kWh'),
         ('CONSUMO FATURADO FORA PONTA', 'consumo', 'FORA_PONTA', 'kWh'),
         ('CONSUMO FATURADO REATIVO EXCEDENTE', 'reativo_ere', None, 'kVArh'),
         ('HORÁRIO RESERVADO CONSUMO', 'consumo', 'RESERVADO', 'kWh'),
         ('HORÁRIO RESERVADO REATIVO EXCEDENTE', 'reativo_ere', 'RESERVADO', 'kVArh')]


def _cnpj(chave):
    c = chave[6:20]
    return f'{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:]}'


HIST10 = HIST8 + [('ENERGIA INJETADA PONTA', 'injetada', 'PONTA', 'kWh'),
                  ('ENERGIA INJETADA FORA PONTA', 'injetada', 'FORA_PONTA', 'kWh')]
NOMES = {'EQUATORIAL PI': 'Equatorial Piauí Distribuidora de Energia S.A.',
         'EQUATORIAL AL': 'Equatorial Alagoas Distribuidora de Energia S.A.',
         'EQUATORIAL MA': 'Equatorial Maranhão Distribuidora de Energia S.A.',
         'EQUATORIAL PA': 'Equatorial Pará Distribuidora de Energia S.A.',
         'EQUATORIAL GO': 'Equatorial Goiás Distribuidora de Energia S.A.'}
# modelo novo (2026, "GRUPO DE TENSÃO"): IE/endereço só na imagem; valores dos gabaritos visuais
IE = {'EQUATORIAL PI': '19.301.383-5', 'EQUATORIAL AL': '24.007.177-8', 'EQUATORIAL MA': '120.515.11-3',
      'EQUATORIAL PA': '150.744.80-3'}
END_NOVO = {'EQUATORIAL PI': 'Av. Maranhão, 759 - Centro/Sul | Teresina/PI - CEP: 64001-030'}


def detecta(texto, doc=None):
    if doc is not None and abs(doc[0].rect.width - 595) > 5:
        return False
    m = re.search(r'\b(\d{44})\b', texto)
    return bool(m) and _cnpj(m[1]) in CNPJS and ('Itens de Fatura' in texto or 'GRUPO DE TENSÃO' in texto)


def _posto(t):
    d = ' ' + sem_acento(t).upper().replace('.', ' ') + ' '
    if re.search(r' (FP|F PONTA|FORA PONTA|FORA PTA) ', d):
        return 'FORA_PONTA'
    if re.search(r' (NP|PONTA|PTA) ', d):
        return 'PONTA'
    if re.search(r' (HR|RESERVADO) ', d):
        return 'RESERVADO'
    if re.search(r' (UNICA|UNICO) ', d):
        return 'UNICO'
    return None


def componente_de(desc):
    d = sem_acento(desc).upper()
    if 'COMPENSADO' in d:
        return 'CONSUMO_COMPENSADO', _posto(d)
    if 'INJ' in d:
        return 'GD_INJETADA', _posto(d)
    if 'ULTRAP' in d and 'GERA' in d:
        return 'DEMANDA_GERACAO_ULTRAPASSAGEM', 'GERACAO'
    if 'DEMANDA' in d and 'GERA' in d:
        return 'DEMANDA_GERACAO', 'GERACAO'
    if 'ULTRAP' in d:
        return 'DEMANDA_ULTRAPASSAGEM', 'UNICO'
    if 'REAT' in d or 'UFER' in d or 'DMCR' in d:
        return 'REATIVO_EXCEDENTE', _posto(d)
    if 'DEMANDA' in d:
        return 'DEMANDA', 'UNICO'
    if 'CIP' in d.split() or 'ILUM' in d:
        return ('ILUMINACAO_PUBLICA', None) if not re.match(r'(MULTA|JUROS|CORRECAO)', d) else (None, None)
    if d.startswith('MULTA'):
        return 'MULTA', None
    if d.startswith('JUROS'):
        return 'JUROS', None
    if 'CORRECAO' in d or 'ATUALIZ' in d or 'IPCA' in d:
        return 'ATUALIZACAO_MONETARIA', None
    if re.search(r'\b(DIC|FIC|DMIC|DICRI)\b', d):
        return 'COMPENSACAO_CONTINUIDADE', None
    if 'BANDEIRA' in d or 'BAND.' in d:
        return 'BANDEIRA', None
    if 'PARCEL' in d:
        return 'PARCELAMENTO', None
    if 'DEVOL' in d or 'ESTORNO' in d or 'RESTITUI' in d:
        return 'ESTORNO', None
    if d.startswith('CREDITO'):
        return 'OUTRO', None
    if 'CONSUMO' in d or 'ENERGIA' in d:
        return 'CONSUMO', _posto(d)
    return 'AJUSTE', None


def _comp(desc):
    c, p = componente_de(desc)
    if c is None:  # "Multa CIP", "Juros CIP", "Correção Monetária CIP"
        d = sem_acento(desc).upper()
        c = 'MULTA' if d.startswith('MULTA') else ('JUROS' if d.startswith('JUROS') else 'ATUALIZACAO_MONETARIA')
    return c, p


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
    t1 = pags[0][1]
    ls = linhas(t1)
    tj = ' '.join(l.texto() for l in ls)
    todo = ' '.join(' '.join(w.t for w in t) for _, t in pags)
    d['extracao']['paginas_lidas'] = [p for p, _ in pags]
    pag_tipos = []
    for p, t in pags:
        tx = ' '.join(w.t for w in t)
        tipo = 'conteudo'
        if p > 1 and 'Formulário com informações complementares' in tx:
            tipo = 'repetida'
        pag_tipos.append({'pagina': p, 'tipo': tipo, 'repete_pagina': 1 if tipo == 'repetida' else None})
    d['extracao']['paginas'] = pag_tipos
    doc_, nf, uc_, tit, ref, tot = (d['documento'], d['documento']['nota_fiscal'], d['unidade_consumidora'],
                                    d['titular'], d['referencia'], d['totais'])

    # emitente (topo, x≈96): nome / CNPJ | IE / endereço
    m = re.search(r'\b(\d{44})\b', todo)
    if m:
        nf['chave_acesso'] = m[1]
        doc_['distribuidora_cnpj'] = _cnpj(m[1])
        doc_['distribuidora_sigla'] = CNPJS.get(doc_['distribuidora_cnpj'], 'OUTRA')
    topo = [l for l in ls if l.y < 66 and l.entre(90, 330)]
    if len(topo) >= 3:
        doc_['distribuidora'] = next((l.texto(90, 330) for l in topo if l.texto(90, 330).startswith('Equatorial')), None)
        m = re.search(r'Insc\. Estadual:\s*(\S+)', tj)
        doc_['distribuidora_ie'] = m[1] if m else None
        i = next((k for k, l in enumerate(topo) if 'CNPJ:' in l.texto()), None)
        if i is not None:
            doc_['distribuidora_endereco'] = ' '.join(l.texto(90, 330) for l in topo[i + 1:]).strip() or None
    doc_['segunda_via'] = bool(re.search(r'\b2ª Via\b', tj))
    if doc_['segunda_via']:
        d['outros'].append({'pagina': 1, 'secao_impressa': 'Cabeçalho', 'rotulo': 'via', 'valor': '2ª Via'})
    doc_['tipo'] = 'fatura_energia'
    nf['modelo'] = 'DANF3E - DOCUMENTO AUXILIAR DA NOTA FISCAL DE ENERGIA ELÉTRICA ELETRÔNICA'

    # NF3e (coluna direita, x≥410)
    tdir = ' '.join(l.texto(410, 600) for l in ls if l.y < 200)
    m = re.search(r'NOTA FISCAL N\S*\s*(\d+)\s*-\s*S\S*RIE\s*(\d+)\s*/?\s*DATA DE EMISS\S*\s*(\d\d/\d\d/\d{4})', tdir)
    if m:
        nf.update({'numero': m[1], 'serie': m[2], 'data_emissao': data_br(m[3])})
        ref['data_emissao'] = data_br(m[3])
    m = re.search(r'(https?://\S+)', tdir)
    nf['url_consulta'] = m[1] if m else None
    m = re.search(r'Protocolo de autoriza\S*\s*(\d+)\s*-?\s*(\d\d/\d\d/\d{4})\s*\S+\s*(\d\d:\d\d:\d\d)', tdir)
    if m:
        nf['protocolo_autorizacao'] = m[1]
        nf['data_autorizacao'] = f'{data_br(m[2])}T{m[3]}'

    # classificação / tipo de fornecimento / tensão / tipo de tarifa
    ic = next((k for k, l in enumerate(ls) if l.texto().startswith('Classificação:')), None)
    itn = next((k for k, l in enumerate(ls) if sem_acento(l.texto()).startswith('Tensao Nominal')), None)
    if ic is not None and itn is not None:
        cls = ' '.join(l.texto(0, 170) for l in ls[ic:itn]).replace('Classificação:', '').strip()
        uc_['classificacao'] = re.sub(r'\s+', ' ', cls)
        p = uc_['classificacao'].split(' - ', 1)
        uc_['classe'], uc_['subclasse'] = (p[0], p[1]) if len(p) == 2 else (p[0], None)
    m = re.search(r'Tipo de Fornecimento:\s*(\S+)', tj)
    uc_['tipo_fornecimento'] = m[1] if m else None
    tec = {'tensao_nominal': None, 'tensao_contratada_v': None, 'tensao_fornecimento_kv': None, 'tensao_minima': None,
           'tensao_maxima': None, 'faixa_adequada': None, 'fator_potencia_referencia': None, 'rtc': None, 'rtp': None,
           'constantes': [], 'perdas_transformacao_pct': None, 'horario_ponta': None, 'equipamento_medidor': None,
           'responsavel_iluminacao_publica': None}
    m = re.search(r'Tens\S+ Nominal Disp:\s*([\d.]+)\s*(?:V\s+)?Lim Min:\s*([\d.]+)\s*V\s+Lim Max:\s*([\d.]+)', tj)
    if m:
        tec.update({'tensao_nominal': m[1], 'tensao_minima': num(m[2]), 'tensao_maxima': num(m[3])})
    m = re.search(r'Tipo de Tarifa:\s*(\S+)', todo)
    if m:
        tt = m[1]
        uc_['tipo_tarifa_impresso'] = tt
        g = re.match(r'([AB])(\d[a-z]?)', tt)
        if g:
            uc_['grupo'], uc_['subgrupo'] = g[1], g[1] + g[2]
        uc_['modalidade_tarifaria'] = {'VD': 'Verde', 'AZ': 'Azul', 'CV': 'Convencional', 'CONV': 'Convencional',
                                       'BR': 'Branca'}.get(tt.split('_')[-1], None) if '_' in tt else None
    uc_['tecnico'] = tec

    # datas de leitura
    m = re.search(r'Leituras\s+(\d\d/\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+(\d{1,3})\s+(\d\d/\d\d/\d{4})', tj)
    if m:
        ref.update({'leitura_anterior': data_br(m[1]), 'leitura_atual': data_br(m[2]), 'dias_faturados': int(m[3]),
                    'proxima_leitura': data_br(m[4])})
    # conta mês / vencimento / total
    m = re.search(r'\b(\d{2})/(\d{4})\s+(\d\d/\d\d/\d{4})\s+R\$\s*([\d.]+,\d\d)', tj)
    if m:
        ref['mes_referencia'] = f'{m[2]}-{m[1]}'
        ref['data_vencimento'] = data_br(m[3])
        tot['total_a_pagar'] = num(m[4])

    novo = 'GRUPO DE TENSÃO' in tj
    if novo:
        _cabecalho_novo(t1, ls, d, tj)
    else:
        _titular(ls, d, tj, todo)
    y_itens = _itens(t1, d)
    _quadros_direita(t1, d)
    _medicoes(t1, d)
    _info_cliente(pags, d)
    _pagina2(pags, d)
    _boleto(t1, ls, d, tj)
    _fechamento(d, t1, tj)
    return d


def _titular(ls, d, tj, todo):
    tit, uc_ = d['titular'], d['unidade_consumidora']
    # bloco entre a palavra "Leituras" (x>300) e "FATOR DE POTÊNCIA" (as linhas podem estar a 1 pt umas das outras)
    y_ini = min((w.y1 for l in ls for w in l.p if w.t == 'Leituras' and w.x0 > 300), default=None)
    y_fim = min((w.y1 for l in ls for w in l.p if w.t == 'FATOR' and w.x0 < 40), default=None)
    if y_ini is None or y_fim is None:
        return
    bloco = [l for l in ls if y_ini - 3 < l.y <= y_fim + 1]
    nome = next((l for l in bloco if l.p[0].x0 < 40 and not re.match(r'(INSTALA|CNPJ|CPF)', l.texto())), None)
    if nome:
        tit['nome'] = nome.texto(0, 235).strip()
    m = re.search(r'INSTALA\S+:\s*(\d+)', tj)
    uc_['instalacao'] = m[1] if m else None
    m = re.search(r'\b(?:CNPJ|CPF):\s*([\d*./-]{11,})', ' '.join(l.texto(0, 235) for l in bloco))
    if m:
        if '*' in m[1]:
            tit['cnpj_cpf_mascarado'] = m[1]
            d['valores_alternativos'].append({'campo': 'titular.cnpj_cpf', 'valor': m[1], 'pagina': 1})
        else:
            tit['cnpj_cpf'] = m[1]
    k_cnpj = next((k for k, l in enumerate(bloco) if re.match(r'(CNPJ|CPF):', l.texto())), None)
    if k_cnpj is not None:
        end = ' '.join(l.texto(0, 235) for l in bloco[k_cnpj + 1:] if not l.texto().startswith('FATOR')).strip()
        end = re.sub(r'\s+', ' ', end)
        uc_['endereco'] = end or None
        m = re.match(r'(.*?)\s*CEP:\s*(\d{5}-?\d{3})\s*(.*?)\s*-\s*([^-]+?)\s*-\s*([A-Z]{2})$', end)
        if m:
            tit['endereco'], tit['cep'], tit['cidade'], tit['uf'] = m[1].strip(), m[2], m[4].strip(), m[5]
        else:
            tit['endereco'] = end
    # Parceiro de Negócio / Conta Contrato: número logo abaixo do rótulo (x≈239–300)
    for rot, campo in (('Parceiro', 'parceiro_negocio'), ('Conta', 'conta_contrato')):
        lab = next((w for l in bloco for w in l.p if w.t == rot and 230 < w.x0 < 260), None)
        if lab:
            val = next((w.t for l in ls for w in l.entre(230, 310) if lab.y1 + 3 < w.y1 < lab.y1 + 20
                        and re.fullmatch(r'\d{6,}', w.t)), None)
            tit[campo] = val
    uc_['uc'] = tit.get('conta_contrato') or uc_['instalacao']
    m = re.search(r'FATOR DE POT\S+:\s*([\d.,]+)', tj)
    if m:
        d['informacoes_consumo'].append({'pagina': 1, 'rotulo': 'fator de potência', 'posto': None,
                                         'valor': num(m[1]), 'unidade': None})


def _itens(t1, d):
    cab = [w for w in t1 if w.t == 'Itens' and w.x0 < 40]
    meds = [w for w in t1 if re.fullmatch(r'\d{9,}', w.t) and w.x0 < 40 and w.y1 > 300]
    medh = [w for w in t1 if w.t == 'Medidor' and w.x0 < 60]
    y_fim = (medh[0].y0 - 2) if medh else ((min(w.y0 for w in meds) - 2) if meds else 470)
    if cab:
        y_cab = cab[0].y1
        hdr = [w for w in t1 if y_cab - 3 <= w.y1 <= y_cab + 9 and w.x0 < 430]
    else:  # modelo novo: sem cabeçalho em texto
        icms = [w for w in t1 if w.t == 'ICMS' and w.x0 > 430 and w.y1 > 250]
        if not icms:
            return None
        y_cab, hdr = icms[0].y1 - 9, []
    def x1(pred):
        c = [w.x1 for w in hdr if pred(w.t)]
        return max(c) if c else None
    anc = {'quant': x1(lambda t: t.startswith('Quant')), 'preco': x1(lambda t: t == 'Tributos'),
           'tarifa': max((w.x1 for w in hdr if w.t == 'Unit.(R$)' and w.x0 > 240), default=None),
           'pis_cofins': x1(lambda t: 'COFINS' in t), 'icms': max((w.x1 for w in hdr if w.t in ('(R$)',) and w.x0 > 340
                                                                   and w.x0 < 380), default=None),
           'valor': x1(lambda t: t.startswith('Valor(R$)'))}
    anc = {k: v for k, v in anc.items() if v}
    if len(anc) < 6:  # posições padrão do layout (borda direita dos números)
        anc = {'quant': 174, 'preco': 224, 'tarifa': 274, 'pis_cofins': 323, 'icms': 373, 'valor': 422}
    y_corpo = (max(w.y1 for w in hdr) + 1) if hdr else y_cab
    ws = [w for w in t1 if y_corpo < w.y1 < y_fim and w.x0 < 430]
    secao = 'FORNECIMENTO'
    for y, g in _grupos(ws):
        desc = [w for w in g if w.x0 < 145]
        nums = [w for w in g if w.x0 >= 145 and e_numero(w.t)]
        t = _txt(desc)
        if not nums:
            if t.isupper() and len(t.split()) <= 3:
                secao = t
            elif t:
                d['itens'].append(_item(t, {}, secao, 'INFO', None))
            continue
        cols = colunas_por_ancora(nums, anc)
        comp, posto = _comp(t)
        it = _item(t, cols, secao, comp, posto)
        mm = re.search(r'\b(\d{2})/(\d{4})\b', t)
        if mm and 1 <= int(mm[1]) <= 12:
            it['mes_ref'] = f'{mm[2]}-{mm[1]}'
        m = re.search(r'\((kWh|kW|kVArh|kVAr)\)', t)
        it['unidade'] = m[1] if m else None
        d['itens'].append(it)
    return y_fim


def _item(desc, cols, secao, comp, posto):
    return {'pagina': 1, 'secao_impressa': secao, 'codigo': None, 'descricao': desc, 'mes_ref': None,
            'componente': comp, 'posto': posto, 'quantidade_registrada': None,
            'quantidade_faturada': num(cols.get('quant')), 'unidade': None,
            'tarifa_com_tributos': num(cols.get('preco')), 'tarifa_sem_tributos': num(cols.get('tarifa')),
            'valor': num(cols.get('valor')), 'valor_sem_tributos': None, 'base_icms': None, 'aliquota_icms': None,
            'icms': num(cols.get('icms')), 'base_pis_cofins': None, 'aliquota_pis': None, 'pis': None,
            'aliquota_cofins': None, 'cofins': None, 'pis_cofins': num(cols.get('pis_cofins')), 'nf_referencia': None,
            'colunas_originais': {'Itens de Fatura': desc, **cols}}


def _quadros_direita(t1, d):
    """Tributos (ICMS/PIS/COFINS), Grandezas Contratadas, Reservado ao Fisco, Informações sobre Consumo."""
    tab_gc = {'pagina': 1, 'nome': 'Grandezas Contratadas', 'linhas': []}
    for y, g in _grupos([w for w in t1 if w.x0 >= 430 and 270 < w.y1 < 470]):
        t = _txt(g)
        m = re.match(r'(ICMS|PIS|COFINS)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)$', t)
        if m:
            d['tributos'].append({'pagina': 1, 'tributo': m[1], 'base': num(m[2]), 'aliquota': num(m[3]),
                                  'valor': num(m[4]), 'retido': False,
                                  'colunas_originais': {'Tributo': m[1], 'Base(R$)': m[2], 'Aliquota(%)': m[3],
                                                        'Valor(R$)': m[4]}})
            continue
        m = re.match(r'(Dem.*?\(kW\)):\s*([\d.,]+)?$', t)
        if m:
            tab_gc['linhas'].append({'colunas_originais': {m[1]: m[2] or ''}})
            if m[2]:
                rot = m[1]
                ger = 'Gera' in rot
                d['demanda'].append({'pagina': 1, 'tipo': 'geracao' if ger else 'consumo',
                                     'posto': 'GERACAO' if ger else (_posto(rot) or 'UNICO'),
                                     'contratada_kw': num(m[2]), 'medida_kw': None, 'faturada_kw': None,
                                     'faturada_ultrapassagem_kw': None, 'nao_consumida_kw': None, 'data_hora': None,
                                     'rotulo': rot, 'colunas_originais': {rot: m[2]}})
    if tab_gc['linhas']:
        d['tabelas_complementares'].append(tab_gc)
    caixa = [w for w in t1 if w.x0 >= 340 and 470 < w.y1 < 600]
    for y, g in _grupos(caixa):
        t = _txt(g)
        m = re.search(r'([0-9A-F]{4}(?:\.[0-9A-F]{4}){7})', t)
        if m:
            d['documento']['nota_fiscal']['reservado_fisco'] = m[1]
        m = re.match(r'(Consumo Médio Diário|Média dos 12 meses|Dem\. Máx\. F\. Ponta|Dem\. Máx\. Ponta)\s*\((kWh|kW)\):\s*([\d.,]+)?', t)
        if m:
            d['informacoes_consumo'].append({'pagina': 1, 'rotulo': m[1], 'posto': _posto(m[1]) if 'Dem' in m[1] else None,
                                             'valor': num(m[3]) if m[3] else None, 'unidade': m[2]})
            if 'Dem' in m[1]:
                d['demanda'].append({'pagina': 1, 'tipo': 'consumo', 'posto': _posto(m[1]), 'contratada_kw': None,
                                     'medida_kw': num(m[3]) if m[3] else None, 'faturada_kw': None,
                                     'faturada_ultrapassagem_kw': None, 'nao_consumida_kw': None, 'data_hora': None,
                                     'rotulo': m[1] + ' (kW)', 'colunas_originais': {m[1]: m[3] or ''}})
    dt = next((w.t for w in caixa if w.x0 > 480 and re.fullmatch(r'\d\d/\d\d/\d{4}', w.t)), None)
    d['documento']['nota_fiscal']['data_apresentacao'] = data_br(dt) if dt else None
    aviso = ' '.join(_txt(g) for y, g in _grupos([w for w in t1 if w.x0 >= 340 and 560 < w.y1 < 600]))
    if aviso.startswith('Incidir'):
        d['mensagens'].append({'pagina': 1, 'texto': aviso})


def _medicoes(t1, d):
    hdr = [w for w in t1 if w.t in ('Anterior', 'Atual', 'Const.', 'Consumo', 'Medidor') and 460 < w.y1 < 480]
    xa = {w.t: w.x1 for w in hdr}
    anc = {'leitura_anterior': xa.get('Anterior', 236), 'leitura_atual': xa.get('Atual', 265),
           'constante': max((w.x1 for w in hdr if w.t in ('Const.', 'Medidor') and w.x0 > 270), default=297),
           'consumo': xa.get('Consumo', 333)}
    for y, g in _grupos([w for w in t1 if w.y1 > 478 and w.x0 < 345]):
        if not re.fullmatch(r'\d{6,}', g[0].t) or g[0].x0 > 40:
            continue
        med = g[0].t
        resto = g[1:]
        nums = [w for w in resto if e_numero(w.t) and w.x0 > 205]
        unid = next((w.t for w in resto if w.t in ('kWh', 'kW', 'kVAr', 'kVArh')), None)
        gr = _txt([w for w in resto if w.x0 < 130 and w not in nums])
        po = _txt([w for w in resto if 130 <= w.x0 < 215 and w not in nums])
        cols = colunas_por_ancora(nums, anc)
        d['medicoes'].append({'pagina': 1, 'tabela_origem': 'Medidor', 'medidor': med,
                              'grandeza': f'{gr} / {po}' if po else gr, 'posto': _posto(po) or _posto(gr),
                              'leitura_anterior': num(cols.get('leitura_anterior')),
                              'leitura_atual': num(cols.get('leitura_atual')), 'constante': num(cols.get('constante')),
                              'perdas_pct': None, 'ajuste': None, 'consumo': num(cols.get('consumo')),
                              'consumo_faturado': None, 'fator_potencia': None, 'ajuste_fator_potencia': None,
                              'unidade': unid or 'kWh', 'data_hora_registro': None, 'leitura_arredondada': False,
                              'colunas_originais': {'Medidor': med, 'Grandeza': gr, 'Posto Horário': po,
                                                    'Leitura Anterior': cols.get('leitura_anterior'),
                                                    'Leitura Atual': cols.get('leitura_atual'),
                                                    'Const. Medidor': cols.get('constante'),
                                                    'Consumo': ' '.join(x for x in (cols.get('consumo'), unid) if x)}})
        if med not in d['unidade_consumidora']['medidor']:
            d['unidade_consumidora']['medidor'].append(med)
    # constantes por tipo de grandeza (energia × demanda)
    vistos = {}
    for me in d['medicoes']:
        k = 'kW' if me['unidade'] == 'kW' else 'kWh/kVAr'
        if me['constante'] is not None and k not in vistos:
            vistos[k] = me['constante']
    d['unidade_consumidora']['tecnico']['constantes'] = [{'grandeza': k, 'valor': v} for k, v in vistos.items()]


def _frases(texto):
    """Divide o bloco em frases (ponto seguido de maiúscula), sem quebrar números como 1.862,28."""
    partes = re.split(r'(?<=[.)])\s+(?=(?:[A-ZÁÉÍÓÚÂÊÔÃÕÇ]|Esta|Saldo|Conta|Conforme|Reajuste|Bandeira|Per))', texto)
    return [p.strip() for p in partes if p.strip()]


def _info_cliente(pags, d):
    """Bloco "INFORMAÇÕES PARA O CLIENTE" (p1 e p3): bandeira, GD, avisos; sem repetir frases."""
    vistas = {m['texto'][:50] for m in d['mensagens']}
    ref = d['referencia']['mes_referencia']
    ano = int(ref[:4]) if ref else None
    gd = d['gd']
    # energia injetada do mês: só a impressa como injetada no quadro de medição ("Ener. Inje. F. Ponta" …)
    for me in d['medicoes']:
        co = me.get('colunas_originais') or {}
        gr = co.get('Grandeza') or me['grandeza'] or ''
        if me['unidade'] == 'kWh' and me['consumo'] is not None and \
                re.match(r'Ener\w*\.?\s*Inje|ENERGIA\s+INJETADA', sem_acento(gr), re.I):
            rot = ' / '.join(x for x in (gr, co.get('Posto Horário')) if x) + f": {co.get('Consumo') or me['consumo']}"
            gd['lancamentos'].append(_lanc(me['pagina'], 'injetada', me['posto'], me['consumo'], ref, None,
                                           f'Medição {rot}'))
    # energia compensada por posto: quantidade impressa nos itens "Consumo Compensado NP/FP (kWh)"
    for it in d['itens']:
        if it.get('componente') == 'CONSUMO_COMPENSADO' and it.get('unidade') == 'kWh' and \
                it.get('quantidade_faturada') is not None and it.get('posto'):
            q = (it.get('colunas_originais') or {}).get('quant') or it['quantidade_faturada']
            gd['lancamentos'].append(_lanc(it['pagina'], 'compensada', it['posto'], it['quantidade_faturada'], ref,
                                           None, f"{it['descricao']} {q}"))
    blocos = []
    for np_, t in pags:
        ini = [w for w in t if w.t == 'INFORMAÇÕES' and w.x0 < 40 and w.y1 < 260]
        y_ini = ini[0].y1 if ini else min((w.y1 - 6 for w in t if w.t == 'Períodos:' and w.x0 < 60), default=None)
        fim = [w for w in t if w.t == 'Itens' and w.x0 < 40] or \
            [w for w in t if w.t == 'ICMS' and w.x0 > 430 and w.y1 > 250]
        if y_ini is None or not fim:
            continue
        bloco = ' '.join(_txt(g) for y, g in _grupos([w for w in t if y_ini + 2 < w.y1 < fim[0].y0 - 2]))
        blocos.append((np_, bloco))
        for m in re.finditer(r'Band\. Tarif\.:\s*(\w+)\s*:\s*(\d\d)/(\d\d)\s*-\s*(\d\d)/(\d\d)', bloco):
            if ano:
                cor = sem_acento(m[1]).upper()
                cor = {'VERMELHA': 'VERMELHA_1'}.get(cor, cor)
                b = {'pagina': np_, 'cor': cor, 'inicio': f'{ano}-{m[3]}-{m[2]}', 'fim': f'{ano}-{m[5]}-{m[4]}', 'dias': None}
                if not any(x['cor'] == b['cor'] and x['inicio'] == b['inicio'] for x in d['bandeiras']):
                    d['bandeiras'].append(b)
        bloco_f = re.sub(r'Band\. Tarif\.', 'Band Tarif', bloco)
        for f in _frases(bloco_f):
            f = f.replace('Band Tarif', 'Band. Tarif.')
            if f[:50] in vistas:
                continue
            vistas.add(f[:50])
            d['mensagens'].append({'pagina': np_, 'texto': f})
            m = re.search(r'Band\. Tarif\.:\s*(\w+)\s*:\s*(\d\d)/(\d\d)\s*-\s*(\d\d)/(\d\d)', f)
            if m and ano:
                cor = sem_acento(m[1]).upper()
                cor = {'VERMELHA': 'VERMELHA_1'}.get(cor, cor)
                d['bandeiras'].append({'pagina': np_, 'cor': cor, 'inicio': f'{ano}-{m[3]}-{m[2]}',
                                       'fim': f'{ano}-{m[5]}-{m[4]}', 'dias': None})
            m = re.search(r'CONSUMO COMPENSADO pela mini/microgera\S+ \(([\d.,]+) kWh\)', f)
            if m:
                gd['lancamentos'].append(_lanc(np_, 'compensada', None, num(m[1]), ref, None, m[0]))
            m = re.search(r'Saldo de cr\S+ expirados no ciclo ref (\d\d)/(\d\d):\s*([\d.,]+)\s*kWh', f)
            if m:
                gd['lancamentos'].append(_lanc(np_, 'expirado', None, num(m[3]), f'20{m[2]}-{m[1]}', None, f.rstrip('.')))
            mg = re.search(r'Unidade Consumidora geradora ([\d.\-]{6,}):', f)
            if mg:
                gd['uc_geradora'] = mg[1]
            m = re.search(r'modalidade (.*?) das seguintes (?:CC|UC|UCs):\s*(.*?)\.?$', f)
            if m:
                d['unidade_consumidora']['geracao']['modalidade_gd'] = m[1]
                for uc, pct in re.findall(r'(\d[\d.\-]{5,}\d)\(([\d.,]+)%\)', m[2]):
                    gd['rateio_beneficiarias'].append({'uc': uc, 'percentual': num(pct), 'kwh': None})
                    if gd['participacao_pct'] is None:
                        gd['participacao_pct'] = num(pct)
        mm = re.search(r'Conta contrato geradora (\d+)', bloco)
        if mm:
            gd['conta_contrato_geradora'] = mm[1]
    # saldos por posto: o texto vem em segmentos "Saldo do Mês Geral <posto>: … a expirar de X na ref MM/AA";
    # o último segmento de uma página pode continuar no início do bloco da página seguinte
    vistos_l = {(x['tipo'], x['posto'], x['kwh']) for x in gd['lancamentos']}
    for k, (np_, bloco) in enumerate(blocos):
        segs = re.split(r'(?=Saldo do M\S+s Geral )', bloco)[1:]
        if segs and k + 1 < len(blocos):
            prox = blocos[k + 1][1]
            corte = re.search(r'Saldo do M\S+s Geral |Per\S+odos:|Band\. Tarif|Esta |O montante|Demonstrativo|'
                              r'Conforme|Conta contrato|Unidade Consumidora|Saldo de cr', prox)
            segs[-1] += ' ' + prox[:corte.start() if corte else len(prox)]
        for seg in segs:
            mp = re.match(r'Saldo do M\S+s Geral (Fora Ponta|Ponta|Reservado|Intermedi\S+):\s*([\d.,]+)', seg)
            if not mp:
                continue
            posto = _posto(mp[1])
            # "Saldo do Mês" não é o saldo acumulado: tipo "outro", rótulo "Saldo do Mês Geral …"
            achados = [('outro', posto, num(mp[2].rstrip(',')), ref, None, f'Saldo do Mês Geral {mp[1]}: {mp[2].rstrip(",")}')]
            ma = re.search(r'Saldo Acumulado Geral [^:]*:\s*([\d.,]+?),?\s', seg + ' ')
            if ma:
                achados.append(('saldo_atual', posto, num(ma[1]), None, None, f'Saldo Acumulado Geral {mp[1]}: {ma[1]}'))
            for v, mm_, aa in re.findall(r'a expirar de ([\d.,]+) na ref (\d\d)/(\d\d)', seg):
                achados.append(('a_expirar', posto, num(v), None, f'20{aa}-{mm_}',
                                f'Saldo atualizado a expirar de {v} na ref {mm_}/{aa}'))
            for tipo, po, kwh, mes, exp, rot in achados:
                if (tipo, po, kwh) not in vistos_l:
                    vistos_l.add((tipo, po, kwh))
                    gd['lancamentos'].append(_lanc(np_, tipo, po, kwh, mes, exp, rot))
    if d['unidade_consumidora']['geracao']['modalidade_gd'] or gd['lancamentos']:
        d['unidade_consumidora']['geracao']['e_gerador'] = any(i['componente'] == 'DEMANDA_GERACAO' for i in d['itens'])


def _lanc(p, tipo, posto, kwh, mes, exp, rot):
    return {'pagina': p, 'tipo': tipo, 'posto': posto, 'kwh': kwh, 'mes_ref': mes, 'ref_expiracao': exp,
            'unidade_impressa': 'kWh', 'rotulo': rot}


def _pagina2(pags, d):
    """Histórico (8 colunas; meses sem ano → deduzidos do mês de referência), tarifas sem tributos, avisos."""
    ref = d['referencia']['mes_referencia']
    for np_, t in pags[1:]:
        tx = ' '.join(w.t for w in t)
        if 'Histórico' not in tx and 'PONTA/TOT' not in tx:
            continue
        rows = []
        for y, g in _grupos(t):
            if g[0].t in MES3 and g[0].x0 < 60:
                vs = [w.t for w in g[1:] if e_numero(w.t)]
                if len(vs) >= 6:
                    rows.append((g[0].t, vs[:10]))
        if rows and ref:
            a, mth = int(ref[:4]), int(ref[5:])
            tab = {'pagina': np_, 'nome': 'Histórico dos últimos meses', 'linhas': []}
            mapa = HIST10 if max(len(v) for _, v in rows) >= 10 else HIST8
            for m3, vs in rows:
                k = MES3.index(m3) + 1
                ano = a if k <= mth else a - 1
                mes = f'{ano}-{k:02d}'
                a, mth = (ano, k)  # a tabela desce mês a mês
                tab['linhas'].append({'colunas_originais': {'MÊS': m3, **{r: v for (r, *_), v in zip(mapa, vs)}}})
                for (r, serie, posto, un), v in zip(mapa, vs):
                    d['historico'].append({'pagina': np_, 'mes': mes, 'serie': serie, 'posto': posto, 'valor': num(v),
                                           'unidade': un, 'unidade_original': None, 'faturado_pela_media': False})
            d['tabelas_complementares'].append(tab)
            d['historico_formato'] = 'tabela'
        for y, g in _grupos([w for w in t if w.x0 > 310]):
            s = _txt(g)
            m = re.match(r'RESOLU\S+ ANEEL\s+(\S+)', s)
            if m:
                d['documento']['resolucao_aneel'] = m[1]
            m = re.match(r'(Consumo Fora Ponta|Consumo Ponta|Demanda Ativa|Demanda de Gera\S+|Consumo):\s*([\d.,]+)$', s)
            if m:
                comp = 'DEMANDA' if m[1].startswith('Demanda') else 'CONSUMO'
                d['tarifas'].append({'pagina': np_, 'rotulo': f'Tarifa sem tributos - {m[1]}', 'componente': comp,
                                     'posto': _posto(m[1]) or 'UNICO', 'valor': num(m[2]),
                                     'unidade': 'R$/kW' if comp == 'DEMANDA' else 'R$/kWh', 'tipo': 'aneel'})
        # avisos da p2 ("É direito do consumidor...", "Conforme Resolução Normativa...")
        vistas = {m['texto'][:50] for m in d['mensagens']}
        par, y_ult, x_ini = [], None, None
        for y, g in _grupos(t):
            s = _txt(g)
            novo = re.match(r'(É direito|Conforme Resolu)', s)
            if par and (novo or y - y_ult > 9 or abs(g[0].x0 - x_ini) > 25):
                tt = ' '.join(par)
                if re.match(r'(É direito|Conforme Resolu)', tt) and tt[:50] not in vistas:
                    vistas.add(tt[:50])
                    d['mensagens'].append({'pagina': np_, 'texto': tt})
                par = []
            if not par:
                x_ini = g[0].x0
            par.append(s)
            y_ult = y
        if par:
            tt = ' '.join(par)
            if re.match(r'(É direito|Conforme Resolu)', tt) and tt[:50] not in vistas:
                d['mensagens'].append({'pagina': np_, 'texto': tt})
        if 'Ouvidoria' in tx:
            d['outros'].append({'pagina': np_, 'secao_impressa': 'Ouvidoria / Informações ao cliente',
                                'rotulo': 'institucional', 'valor': 'Ouvidoria, ANEEL 167, informações gerais ao cliente'})


def _boleto(t1, ls, d, tj):
    pag, tit = d['pagamento'], d['titular']
    m = re.search(r'([A-ZÀ-Ú][A-ZÀ-Ú .]+?)\s+(\d{3}-\d)\s+(\d{5}\.\d{5}\s+\d{5}\.\d{6}\s+\d{5}\.\d{6}\s+\d\s+\d{14})', tj)
    if not m:
        pag['boleto'] = None
        return
    cod = next((w for w in t1 if w.t == m[2] and w.y1 > 600), None)
    nome_b = ' '.join(w.t for w in sorted(t1, key=lambda w: w.x0) if cod and abs(w.y1 - cod.y1) < 1.5 and w.x1 < cod.x0)
    pag['banco'] = f'{nome_b or m[1].strip()} {m[2]}'
    pag['linha_digitavel'] = m[3]
    if 'Pague através do PIX' in tj:
        pag['pix'] = 'QR CODE impresso'
    bol = {'nosso_numero': None, 'numero_documento': None, 'carteira': None, 'especie': None, 'aceite': None,
           'data_documento': None, 'data_processamento': None, 'beneficiario': None, 'agencia_codigo_beneficiario': None,
           'pagador': None, 'local_pagamento': None, 'instrucoes': None}
    yb = next(l.y for l in ls if m[3].split()[0] in l.texto() and l.y > 600)
    abaixo = [l for l in ls if yb < l.y < yb + 140]
    for k, l in enumerate(abaixo):
        t = l.texto(0, 470)
        if t.startswith('PAGÁVEL') and not t.startswith('PAGÁVEL EM TODAS'):
            mm = re.match(r'(PAG\S+VEL .*?)\s+(\d\d[./]\d\d[./]\d{4})$', t)
            bol['local_pagamento'] = mm[1] if mm else t
            if mm:
                d['valores_alternativos'].append({'campo': 'pagamento.boleto.vencimento', 'valor': mm[2], 'pagina': 1})
        if t.startswith('BENEFICI') and k + 1 < len(abaixo):
            bol['beneficiario'] = abaixo[k + 1].texto(0, 220).strip()
        mm = re.match(r'(\d\d[./]\d\d[./]\d{4})\s+(\d{8,})\s+(\w{1,3})\s+(\w)\s+(\d\d[./]\d\d[./]\d{4})\s+([\d-]{8,})', t)
        if mm:
            bol['data_documento'] = data_br(mm[1].replace('.', '/'))
            bol['numero_documento'] = pag['numero_fatura'] = mm[2]
            bol['especie'], bol['aceite'] = mm[3], mm[4]
            bol['data_processamento'] = data_br(mm[5].replace('.', '/'))
            bol['nosso_numero'] = mm[6]
        mm = re.search(r'(?:^|\s)(\d{1,3})\s+R\$\s+([\d.]+,\d\d)$', t)
        if mm:
            bol['carteira'] = mm[1]
        pass
    # pagador: palavras logo abaixo do rótulo "NOME DO PAGADOR…" (linhas a 2–3 pt; não agrupar)
    lab = next((w for w in t1 if w.t == 'NOME' and w.y1 > yb and w.x0 < 40), None)
    if lab:
        pw = sorted([w for w in t1 if lab.y1 + 2 < w.y1 < lab.y1 + 16 and w.x0 < 380], key=lambda w: (round(w.y1), w.x0))
        bol['pagador'] = ' '.join(w.t for w in pw) or None
        mm = re.search(r'(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2})', bol['pagador'] or '')
        if mm and not tit.get('cnpj_cpf'):
            tit['cnpj_cpf'] = mm[1]
    instr = [l.texto(0, 380) for l in abaixo if re.match(r'(PAGÁVEL EM TODAS|EM CASO DE ATRASO)', l.texto())]
    bol['instrucoes'] = ' '.join(instr) or None
    pag['boleto'] = bol
    pag.setdefault('conta_recebedora', None)


def _fechamento(d, t1, tj):
    ilum = [i['valor'] for i in d['itens'] if i['componente'] == 'ILUMINACAO_PUBLICA' and i['valor'] is not None]
    d['totais']['valor_cosip_cip'] = round(sum(ilum), 2) if ilum else None
    if 'REAVISO DE VENCIMENTO' in tj:
        d['outros'].append({'pagina': 1, 'secao_impressa': 'REAVISO DE VENCIMENTO', 'rotulo': 'Reaviso de vencimento',
                            'valor': '(vazio)'})
    if d['documento'].get('resolucao_aneel') is None:
        m = re.search(r'RESOLU\S+ ANEEL\s+(\d{3,4}/\d{2})', tj)
        d['documento']['resolucao_aneel'] = m[1] if m else None
    # demanda (kW): registro não acumulado → consumo impresso ≠ (atual − anterior) × constante
    for j, me in enumerate(d['medicoes']):
        la, lb, c, cons = me['leitura_anterior'], me['leitura_atual'], me['constante'], me['consumo']
        if me['unidade'] in ('kW', 'kVAr') and None not in (la, lb, c, cons) and c and \
                abs((lb - la) * c - cons) > max(1, abs(cons) * 0.01):
            d['extracao']['divergencias_impressas'].append(
                {'onde': 'medicao', 'indice': j, 'nota': f'registro de demanda: consumo impresso {cons} ≠ ({lb}−{la})×{c}'})


def _cabecalho_novo(t1, ls, d, tj):
    """Modelo 2026 ("GRUPO DE TENSÃO"): sem rótulos de emitente/leituras/titular em texto."""
    doc_, uc_, tit, ref = d['documento'], d['unidade_consumidora'], d['titular'], d['referencia']
    sig = doc_['distribuidora_sigla']
    doc_['distribuidora'] = NOMES.get(sig)
    doc_['distribuidora_ie'] = IE.get(sig)
    doc_['distribuidora_endereco'] = END_NOVO.get(sig)
    d['extracao']['observacoes'].append('Modelo 2026: nome/IE/endereço do emitente impressos como imagem; '
                                        'preenchidos pelo CNPJ da chave e pelos gabaritos visuais'
                                        + ('' if sig in END_NOVO else ' (endereço não disponível)') + '.')

    def g(rx):
        m = re.search(rx, tj)
        return m[1].strip() if m else None
    uc_['grupo'], uc_['subgrupo'] = g(r'GRUPO DE TENS\S+:\s*([AB])\b'), g(r'SUBGRUPO:\s*(\S+)')
    uc_['tipo_fornecimento'] = g(r'TIPO DE FORNECIMENTO:\s*(\S+)')
    cl = g(r'CLASSIFICA\S+:\s*(.*?)\s+MODALIDADE TARIF')
    uc_['classificacao'] = cl
    uc_['classe'] = 'Comercial' if cl and cl.split()[0].startswith('COMERC') and len(cl.split()) > 1 else cl
    linha_sub = next((l for l in ls if l.texto().startswith('SUBCLASSE:')), None)
    uc_['subclasse'] = linha_sub.texto(0, 330).replace('SUBCLASSE:', '').strip() if linha_sub else None
    mt = g(r'MODALIDADE TARIF\S+:\s*(\S+(?: VERDE| AZUL| CONVENCIONAL| BRANCA)?)')
    if mt:
        if '_' in mt:
            uc_['tipo_tarifa_impresso'] = mt
        uc_['modalidade_tarifaria'] = next((v for k, v in (('VD', 'Verde'), ('VERDE', 'Verde'), ('AZ', 'Azul'),
                                                            ('AZUL', 'Azul'), ('CONV', 'Convencional'),
                                                            ('BRANCA', 'Branca')) if k in mt.upper()), None)
        if '_' not in mt:
            d['outros'].append({'pagina': 1, 'secao_impressa': 'Classificação', 'rotulo': 'MODALIDADE TARIFÁRIA',
                                'valor': mt})
    # datas de leitura: 4 datas + nº de dias na coluna direita
    rx4 = r'(\d\d/\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+(\d{1,3})\s+(\d\d/\d\d/\d{4})'
    dl = next((l for l in ls if re.search(rx4, l.texto(360, 600))), None)
    if dl:
        m = re.search(rx4, dl.texto(360, 600))
        ref.update({'leitura_anterior': data_br(m[1]), 'leitura_atual': data_br(m[2]), 'dias_faturados': int(m[3]),
                    'proxima_leitura': data_br(m[4])})
    # titular: da linha das datas até a linha "CEP: …"
    y0 = dl.y - 3 if dl else 90
    cep = next((l for l in ls if l.y > y0 and l.texto(0, 230).startswith('CEP:')), None)
    if cep:
        bloco = [l.texto(0, 200).strip() for l in ls if y0 < l.y <= cep.y + 1 and l.texto(0, 200).strip()]
        tit['nome'] = bloco[0] if bloco else None
        end = []
        for t in bloco[1:]:
            m = re.match(r'(?:CNPJ|CPF):\s*(\S+)', t)
            if m:
                if '*' in m[1]:
                    tit['cnpj_cpf_mascarado'] = m[1]
                    d['valores_alternativos'].append({'campo': 'titular.cnpj_cpf', 'valor': m[1], 'pagina': 1})
                else:
                    tit['cnpj_cpf'] = m[1]
                continue
            m = re.match(r'CEP:\s*(\d{5}-?\d{3})\s*-\s*(.*?)\s*-\s*([^-]+?)\s*-\s*([A-Z]{2})$', t)
            if m:
                tit['cep'], tit['cidade'], tit['uf'] = m[1], m[3].strip(), m[4]
                uc_['endereco'] = ' '.join(end + [t])
                continue
            end.append(t)
        tit['endereco'] = ' '.join(end) or None
    m = re.search(r'\b(\d\.\d{3}\.\d{3}\.\d{3}-\d{2})\b', ' '.join(l.texto(190, 330) for l in ls if l.y < 170))
    uc_['uc'] = m[1] if m else None
    if not uc_['uc']:  # variante com "INSTALAÇÃO:" e "Conta Contrato" (mesma convenção do modelo antigo)
        tj_ = ' '.join(l.texto() for l in ls)
        m = re.search(r'INSTALA\S+:\s*(\d+)', tj_)
        uc_['instalacao'] = m[1] if m else uc_.get('instalacao')
        lab = next((w for l in ls for w in l.p if w.t == 'Conta' and 230 < w.x0 < 260), None)
        if lab:
            tit['conta_contrato'] = next((w.t for l in ls for w in l.entre(230, 310) if lab.y1 + 3 < w.y1 < lab.y1 + 20
                                          and re.fullmatch(r'\d{6,}', w.t)), None)
        uc_['uc'] = tit.get('conta_contrato') or uc_['instalacao']
