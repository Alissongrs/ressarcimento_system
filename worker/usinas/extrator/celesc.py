"""Parser determinístico das faturas Celesc Distribuição S.A. (DANF3E, grupo A — usinas/geradoras).

Layout (texto embutido; cabeçalhos dos quadros são imagem, por isso a leitura é por posição/ordem):
p1: classificação (y≈109), NF3e/chave/protocolo (x≥370), nome/CPF/endereço (x<200), UC/Cliente/Etapa/Grupo (x≈200),
    linha de referência (y≈218: ref, vencimento, total, leitura anterior/atual, dias, origem, próxima leitura),
    itens de fatura (y≈255–400; continuam na p2 a partir de y≈120): "(cód) descrição [unid] + 11 números"
    (Quantidade, Preço c/ tributos, Valor, Base COFINS/PIS, Alíq. COFINS, Alíq. PIS, PIS/COFINS, Base ICMS,
    Alíq. ICMS, ICMS, Tarifa unitária), SUBTOTAL/TOTAL;
    Grandezas (y≈445–540): leitura anterior / atual / total apurado + HISTÓRICO DE CONSUMO (meses no cabeçalho);
    quadros de baixo (y≈580–620): Informações Técnicas, Bandeira Tarifária, Grandezas Contratadas, Demandas;
    Mensagens; boleto (pagador, endereço, linha digitável, referência/nosso número).
última página: demonstrativo GD (meses × FP/PT), Tributos (PIS/COFINS/ICMS), quadro "Medidor Retirado".
"""
import re

from base import data_br, esqueleto, linhas, num, palavras, sem_acento

NOME = 'celesc_v1'
RE_N = re.compile(r'^-?[\d.]*\d,\d+$')
RE_COD = re.compile(r'^\(([0-9A-Z]{2})\)$')
COLS_ITEM = [('quantidade_faturada', 'Quantidade'), ('tarifa_com_tributos', 'Preço unitário com tributos (R$)'),
             ('valor', 'Valor (R$)'), ('base_pis_cofins', 'Base Cálculo COFINS/PIS (R$)'),
             ('aliquota_cofins', 'Alíquota COFINS (%)'), ('aliquota_pis', 'Alíquota PIS (%)'),
             ('pis_cofins', 'PIS/ COFINS (R$)'), ('base_icms', 'Base Cálculo ICMS (R$)'),
             ('aliquota_icms', 'Alíquota ICMS (%)'), ('icms', 'ICMS (R$)'), ('tarifa_sem_tributos', 'Tarifa Unitária (R$)')]
GRANDEZAS = ['Consumo Fora Ponta', 'Consumo Ponta', 'Demanda Fora Ponta', 'Demanda Ponta',
             'Demanda Injetada Fora Ponta', 'Demanda Injetada Ponta', 'Demanda Reativa Fora Ponta',
             'Demanda Reativa Ponta', 'Energia Injetada Fora Ponta', 'Energia Injetada Ponta',
             'Reativo Excedente Fora Ponta', 'Reativo Excedente Ponta']
MESES = {'JAN': '01', 'FEV': '02', 'MAR': '03', 'ABR': '04', 'MAI': '05', 'JUN': '06', 'JUL': '07', 'AGO': '08',
         'SET': '09', 'OUT': '10', 'NOV': '11', 'DEZ': '12'}
GD_TIPOS = [  # ordem importa (prefixos mais longos primeiro)
    ('Consumo Geradora no Período Atual', 'compensada'), ('Injeção no Período Atual', 'injetada'),
    ('Saldo Geradora Mês Anterior Restante', 'outro'), ('Saldo Geradora Mês Anterior', 'saldo_anterior'),
    ('Cobrança da Geradora', 'cobranca_geradora'), ('Injeção Restante Final', 'excedente'),
    ('Injeção Distribuída Geradora', 'outro'), ('Injeção Distribuída Beneficiárias', 'transferida'),
    ('Saldo Final Geradora', 'saldo_atual'),
    ('Energia Injetada utilizada', 'compensada'), ('Energia Injetada', 'injetada'),
    ('Excedente de energia distribuído', 'transferida'), ('Excedente de energia recebido', 'outro'),
    ('Saldo de créditos Anterior', 'saldo_anterior'), ('Créditos utilizados', 'outro'),
    ('Conversão entre postos horários', 'outro'), ('Saldo de créditos atualizado', 'saldo_atual'),
    ('Consumo', 'outro')]


def detecta(txt, doc=None):
    t = txt or ''
    return 'Celesc' in t and ('08336783' in t or '08.336.783' in t) and 'NOTA FISCAL' in t


def _limpa(ws):
    """Tira as barras verticais que o OCR lê como '|' (pdf escaneado)."""
    out = []
    for w in ws:
        t = w.t.replace('|', '').strip()
        if t:
            w.t = t
            out.append(w)
    return out


def _txt(ws):
    return ' '.join(w.t for w in ws)


def _mes(t):
    m = re.match(r'([A-Z]{3})/(\d{2})$', t or '')
    return f'20{m[2]}-{MESES[m[1]]}' if m and m[1] in MESES else None


def _posto(d):
    d = ' ' + sem_acento(d).upper().replace('/', ' ') + ' '
    if re.search(r' (FP|FORA PONTA) ', d):
        return 'FORA_PONTA'
    if re.search(r' (PT|PONTA) ', d):
        return 'PONTA'
    return None


def componente_de(desc, gerador):
    d = sem_acento(desc).upper()
    po = _posto(d)
    if 'DEMANDA' in d and ('INJET' in d):
        return 'DEMANDA_GERACAO', 'GERACAO'
    if 'DEMANDA' in d and 'ULTRAP' in d:
        return ('DEMANDA_GERACAO_ULTRAPASSAGEM', 'GERACAO') if gerador else ('DEMANDA_ULTRAPASSAGEM', None)
    if d.startswith('DEMANDA') or d.startswith('DIFERENCA DA DEMANDA'):
        return ('DEMANDA_GERACAO', 'GERACAO') if gerador else ('DEMANDA', None)
    if 'BANDEIRA' in d or d.startswith('BAND '):
        return 'BANDEIRA', None
    if d.startswith('ENERGIA INJETADA') or d.startswith('EN ATIV INJ'):
        return 'GD_INJETADA', po
    if 'REATIV' in d:
        return 'REATIVO_EXCEDENTE', None
    if 'COSIP' in d or 'ILUM' in d:
        return 'ILUMINACAO_PUBLICA', None
    if d.startswith('MULTA'):
        return 'MULTA', None
    if d.startswith('JUROS'):
        return 'JUROS', None
    if 'CORRECAO' in d or 'ATUALIZ' in d:
        return 'ATUALIZACAO_MONETARIA', None
    if re.search(r'\b(DIC|FIC|DMIC|DICRI)\b', d):
        return 'COMPENSACAO_CONTINUIDADE', None
    if 'DEVOLUCAO' in d or 'ESTORNO' in d:
        return 'ESTORNO', None
    if 'PARCEL' in d:
        return 'PARCELAMENTO', None
    if any(k in d for k in ('DESLIGAMENTO', 'RELIGACAO', 'PULSOS', 'VISTORIA', 'AFERICAO', 'SERVICO', 'TAXA')):
        return 'SERVICO', None
    if d.startswith('CONSUMO') and re.search(r'\bTE\b', d):
        return 'TE', po
    if d.startswith('CONSUMO') and re.search(r'\bTUSD\b', d):
        return 'TUSD', po
    if d.startswith('CONSUMO'):
        return 'CONSUMO', po
    return 'AJUSTE', None


def _novo_item(pagina, cod, desc, unid):
    return {'pagina': pagina, 'secao_impressa': 'Itens de Fatura', 'codigo': cod, 'descricao': desc, 'mes_ref': None,
            'componente': None, 'posto': None, 'quantidade_registrada': None, 'quantidade_faturada': None,
            'unidade': unid, 'tarifa_com_tributos': None, 'tarifa_sem_tributos': None, 'valor': None,
            'valor_sem_tributos': None, 'base_icms': None, 'aliquota_icms': None, 'icms': None,
            'base_pis_cofins': None, 'aliquota_pis': None, 'pis': None, 'aliquota_cofins': None, 'cofins': None,
            'pis_cofins': None, 'nf_referencia': None,
            'colunas_originais': {'Itens de Fatura': f'({cod}) {desc}' if cod else desc, 'Unidade': unid}}


def parse(doc, fid, caminho):
    d = esqueleto(fid, caminho, len(doc))
    d['extracao']['parser'] = NOME
    d['documento'].update({'segunda_via': False, 'controle': None, 'filiais': [], 'emissor': None,
                           'resolucao_aneel': None})
    d['documento']['nota_fiscal'].update({'cfop': None, 'nf_substituida': None, 'url_consulta': None})
    d['titular'].update({'cnpj_cpf_mascarado': None, 'matricula': None})
    d['totais'].update({'total_nota_fiscal': None, 'tributos_retidos': None, 'subtotais': [], 'totais_colunas': []})
    d['referencia']['ciclo'] = None
    d['gd'] = {'uc_geradora': None, 'conta_contrato_geradora': None, 'participacao_pct': None, 'lancamentos': [],
               'rateio_beneficiarias': []}
    d['entrega'] = {'endereco_correspondencia': None, 'unidade_entrega': None, 'sequencia': None,
                    'endereco_devolucao': None}
    d['informacoes_consumo'] = []
    uc_ = d['unidade_consumidora']
    uc_['tipo_tarifa_impresso'] = None
    uc_['geracao'].update({'classificacao_gd': None})
    uc_['tecnico'] = {'tensao_nominal': None, 'tensao_contratada_v': None, 'tensao_fornecimento_kv': None,
                      'tensao_minima': None, 'tensao_maxima': None, 'faixa_adequada': None,
                      'fator_potencia_referencia': None, 'rtc': None, 'rtp': None, 'constantes': [],
                      'perdas_transformacao_pct': None, 'horario_ponta': None, 'equipamento_medidor': None,
                      'responsavel_iluminacao_publica': None}
    pags = [_limpa(palavras(p)) for p in doc]
    brutos = [p.get_text() for p in doc]
    d['extracao']['paginas_lidas'] = list(range(1, len(doc) + 1))
    d['extracao']['paginas'] = [{'pagina': i + 1, 'tipo': 'conteudo' if brutos[i].strip() else 'em_branco',
                                 'repete_pagina': None} for i in range(len(doc))]
    if not pags or not pags[0]:
        d['extracao']['observacoes'].append('página 1 sem texto embutido (imagem): nada lido')
        return d
    if 'Itens de Fatura' in brutos[0] or 'DANFS3' in brutos[0]:
        d['extracao']['observacoes'].append('camada de texto de OCR (pdf escaneado): códigos de item podem trazer '
                                            'O/0 trocados; conferir na imagem')
    _cabecalho(pags[0], brutos[0], d)
    gerador = 'Medida G' in brutos[0] or any('Injeção no Período' in b or 'Energia Injetada utilizada' in b
                                               for b in brutos[1:])
    for np_, ws in enumerate(pags, 1):
        _itens(ws, np_, d, gerador)
    ilum = [i['valor'] for i in d['itens'] if i['componente'] == 'ILUMINACAO_PUBLICA' and i['valor'] is not None]
    d['totais']['valor_cosip_cip'] = round(sum(ilum), 2) if ilum else None
    _grandezas(pags[0], d)
    _quadros(pags[0], d, gerador)
    _mensagens(pags[0], d)
    _boleto(pags[0], brutos[0], d)
    for np_, ws in enumerate(pags[1:], 2):
        _demonstrativo_gd(ws, np_, d)
        _tributos(ws, np_, d)
        _retirado(ws, np_, d)
    uc_['geracao']['e_gerador'] = bool(gerador or any(i['componente'] == 'GD_INJETADA' for i in d['itens']))
    if d['gd']['lancamentos']:
        d['gd']['uc_geradora'] = uc_['uc']
    _provas(d)
    return d


# ── cabeçalho ────────────────────────────────────────────────────────────────
def _cabecalho(ws, bruto, d):
    doc_, nf, uc_, tit, ref, tot = (d['documento'], d['documento']['nota_fiscal'], d['unidade_consumidora'],
                                    d['titular'], d['referencia'], d['totais'])
    doc_['distribuidora'] = 'Celesc Distribuição S.A.'
    doc_['distribuidora_sigla'] = 'CELESC'
    doc_['distribuidora_cnpj'] = '08.336.783/0001-90'
    doc_['distribuidora_endereco'] = 'Av. Itamarati, nº 160 - Bloco A1, B1 e B2 Itacorubi CEP: 88.034-900 - Florianópolis/SC'
    doc_['segunda_via'] = 'SEGUNDA VIA' in bruto
    nf['modelo'] = 'DANF3E - DOCUMENTO AUXILIAR DA NOTA FISCAL DE ENERGIA ELÉTRICA ELETRÔNICA'
    ls = linhas(ws)
    tudo = re.sub(r'\s+', ' ', ' '.join(l.texto() for l in ls))
    m = re.search(r'NOTA FISCAL N\S*\s*(\d+)\s*SERIE:\s*(\w+)\s*DATA EMISSAO:\s*(\d\d/\d\d/\d{4})', tudo)
    if m:
        nf['numero'], nf['serie'] = m[1], m[2]
        nf['data_emissao'] = ref['data_emissao'] = data_br(m[3])
    m = re.search(r'(https?://sat\.sef\.sc\.gov\.br/\S+)', tudo)
    nf['url_consulta'] = m[1] if m else None
    m = re.search(r'\b(\d{4}(?:\.\d{4}){10})\b', tudo)
    nf['chave_acesso'] = m[1].replace('.', '') if m else None
    m = re.search(r'Autoriza\S*?:?\s*(\d[\d.]{14,})\s*-\s*(\d\d/\d\d/\d{4})(?:\s*às\s*(\d\d:\d\d:\d+))?', tudo)
    if m:
        nf['protocolo_autorizacao'] = m[1].replace('.', '')
        hora = m[3] if m[3] and re.fullmatch(r'\d\d:\d\d:\d\d', m[3]) else None
        nf['data_autorizacao'] = data_br(m[2]) + (f'T{hora}' if hora else '')
    # classificação
    cl = next((l.texto() for l in linhas([w for w in ws if 103 < w.y1 < 116 and w.x0 < 300]) if l.texto()), None)
    sub = ' '.join(l.texto() for l in linhas([w for w in ws if 100 < w.y1 < 122 and w.x0 >= 300]))
    m = re.search(r'Nota Fiscal n\S*\s*(\d+)\s*substitui.*?Nota Fiscal n\S*\s*(\d+)\s*de\s*(\d\d/\d\d/\d{4})', sub)
    if m:
        nf['nf_substituida'] = m[2]
        d['mensagens'].append({'pagina': 1, 'texto': sub})
    if cl:
        uc_['classificacao'] = cl
        p = [x.strip() for x in cl.split(' - ')]
        if len(p) >= 4:
            uc_['classe'], uc_['subclasse'] = p[0], ' - '.join(p[1:-2])
            uc_['tipo_tarifa_impresso'], uc_['tipo_fornecimento'] = p[-2], p[-1]
        mm = re.search(r'\b(verde|azul|convencional|branca)\b', cl, re.I)
        uc_['modalidade_tarifaria'] = mm[1].capitalize() if mm else None
    m = re.search(r'Tens\S*:\s*([AB])\s*/\s*(A\d\w?|AS|B\d?)\b', tudo)
    if m:
        uc_['grupo'], uc_['subgrupo'] = m[1], m[2]
    ucw = [w for w in ws if 195 <= w.x0 < 300 and 138 < w.y1 < 152 and
           re.fullmatch(r'\d{7,10}|\d\.\d{3}\.\d{3}\.\d{3}-\d{2}', w.t)]
    if ucw:
        uc_['uc'] = ucw[0].t
    m = re.search(r'Cliente:\s*(\d+)', tudo)
    tit['codigo_cliente'] = m[1] if m else None
    m = re.search(r'Etapa:\s*(\d+)', tudo)
    if m:
        uc_['roteiro_leitura'] = None
        d['outros'].append({'pagina': 1, 'secao_impressa': 'Dados da UC', 'rotulo': 'Etapa', 'valor': m[1]})
    m = re.search(r'CPF/CNPJ:\s*([\d./-]{11,})', tudo)
    tit['cnpj_cpf'] = m[1] if m else None
    nome = [l.texto(20, 200) for l in ls if 126 < l.y < 147]
    nome = ' '.join(x for x in nome if x and not x.startswith('CPF'))
    tit['nome'] = re.sub(r'^NOME:\s*', '', nome).strip() or None
    # referência / vencimento / total / leituras
    for l in ls:
        if 205 < l.y < 228:
            m = re.search(r'(\d\d)/(\d{4})\s+(\d\d/\d\d/\d{4})\s+R\$\s*([\d.]+,\d\d)\s+(\d\d/\d\d/\d{4})\s+'
                          r'(\d\d/\d\d/\d{4})\s+(\d+)\s+(.*?)\s*(\d\d/\d\d/\d{4})?$', l.texto())
            if m:
                ref['mes_referencia'] = f'{m[2]}-{m[1]}'
                ref['data_vencimento'] = data_br(m[3])
                tot['total_a_pagar'] = num(m[4])
                ref['leitura_anterior'], ref['leitura_atual'] = data_br(m[5]), data_br(m[6])
                ref['dias_faturados'] = int(m[7])
                ref['proxima_leitura'] = data_br(m[9]) if m[9] else None
                if m[8]:
                    d['outros'].append({'pagina': 1, 'secao_impressa': 'Leitura', 'rotulo': 'Origem da Leitura',
                                        'valor': m[8]})


# ── itens ────────────────────────────────────────────────────────────────────
def _itens(ws, np_, d, gerador):
    for l in linhas(ws):
        if l.y < 100 or l.y > 700:
            continue
        p = l.p
        t0 = p[0].t
        if t0 in ('SUBTOTAL', 'TOTAL') and p[0].x0 < 40 and len(p) == 2 and RE_N.match(p[1].t):
            d['totais']['subtotais'].append({'pagina': np_, 'rotulo': t0, 'valor': num(p[1].t)})
            if t0 == 'TOTAL':
                d['totais']['total_nota_fiscal'] = num(p[1].t)
            continue
        m = RE_COD.match(t0)
        if not m or p[0].x0 > 40:
            continue
        nums = []
        k = len(p)
        while k > 1 and RE_N.match(p[k - 1].t):
            k -= 1
        nums = [w.t for w in p[k:]]
        if len(nums) != 11:
            continue
        resto = [w.t for w in p[1:k]]
        unid = resto.pop() if resto and re.fullmatch(r'KWH|KW|KVARH|KVAR|kwh|kw|kWh|kW', resto[-1]) else None
        desc = ' '.join(resto)
        it = _novo_item(np_, m[1], desc, unid)
        for (campo, rot), v in zip(COLS_ITEM, nums):
            it[campo] = num(v)
            it['colunas_originais'][rot] = v
        it['componente'], it['posto'] = componente_de(desc, gerador)
        mm = re.search(r'\b(\d\d)/(\d{4})\b', desc)
        if mm:
            it['mes_ref'] = f'{mm[2]}-{mm[1]}'
        d['itens'].append(it)


# ── grandezas + histórico ────────────────────────────────────────────────────
def _grandezas(ws, d):
    ls = linhas([w for w in ws if 436 < w.y1 < 548])
    meses = []
    for l in ls:
        ms = [w for w in l.p if _mes(w.t) and w.x0 > 185]
        if ms:
            meses = [(w.x0 + 32, _mes(w.t), w.t) for w in ms]
    base = {'leitura_anterior': 133, 'leitura_atual': 165, 'consumo': 197}
    info = {k: None for k in ('medidor', 'constante', 'perdas')}
    for l in linhas([w for w in ws if 580 < w.y1 < 620 and w.x0 < 150]):
        s = l.texto()
        m = re.search(r'Medidor\s+(\S+)$', s)
        if m:
            info['medidor'] = m[1]
        m = re.search(r'Faturamento,?\s+([\d.,]+)$', s)
        if m:
            info['constante'] = num(m[1])
        m = re.search(r'\(%\)\s+([\d.,]+)$', s)
        if m:
            info['perdas'] = num(m[1])
    hist_tab = []
    for l in ls:
        nome = ' '.join(w.t for w in l.p if w.x0 < 100 and not RE_N.match(w.t))
        if nome not in GRANDEZAS:
            continue
        nums = [w for w in l.p if RE_N.match(w.t) or re.fullmatch(r'\d{1,3}(\.\d{3})+', w.t)]
        cols, hist = {}, []
        for w in nums:
            if w.x1 < 212:
                k = min(base, key=lambda c: abs(base[c] - w.x1))
                cols[k] = w.t
            elif meses:
                mx = min(meses, key=lambda c: abs(c[0] - w.x1))
                hist.append((mx, w.t))
        energia = nome.startswith(('Consumo', 'Energia', 'Reativo'))
        un = ('kVArh' if nome.startswith('Reativo') else 'kWh') if energia else \
            ('kVAr' if 'Reativa' in nome else 'kW')
        po = 'FORA_PONTA' if 'Fora Ponta' in nome else 'PONTA'
        d['medicoes'].append({
            'pagina': 1, 'tabela_origem': 'Grandezas', 'medidor': info['medidor'], 'grandeza': nome, 'posto': po,
            'leitura_anterior': num(cols.get('leitura_anterior')), 'leitura_atual': num(cols.get('leitura_atual')),
            'constante': info['constante'] if energia else None,
            'perdas_pct': info['perdas'] if energia else None, 'ajuste': None,
            'consumo': num(cols.get('consumo')), 'consumo_faturado': None, 'fator_potencia': None,
            'ajuste_fator_potencia': None, 'unidade': un, 'data_hora_registro': None, 'leitura_arredondada': False,
            'colunas_originais': {'Grandezas': nome, 'Leitura Anterior': cols.get('leitura_anterior'),
                                  'Leitura Atual': cols.get('leitura_atual'), 'Total Apurado': cols.get('consumo')}})
        if 'Consumo' in nome:
            serie = 'consumo'
        elif 'Demanda Injetada' in nome:
            serie = 'demanda_geracao'
        elif 'Demanda Reativa' in nome:
            serie = 'reativo_dre'
        elif nome.startswith('Demanda'):
            serie = 'demanda'
        elif nome.startswith('Energia Injetada'):
            serie = 'injetada'
        else:
            serie = 'reativo_ere'
        linha_tab = {'Grandezas': nome}
        for (x, mes, rot), v in hist:
            d['historico'].append({'pagina': 1, 'mes': mes, 'serie': serie, 'posto': po, 'valor': num(v),
                                   'unidade': un, 'unidade_original': un, 'faturado_pela_media': False})
            linha_tab[rot] = v
        if hist:
            hist_tab.append({'colunas_originais': linha_tab})
    d['historico_formato'] = 'tabela' if d['historico'] else 'ausente'
    if hist_tab:
        d['tabelas_complementares'].append({'pagina': 1, 'nome': 'HISTÓRICO DE CONSUMO', 'linhas': hist_tab})
    uc_ = d['unidade_consumidora']
    if info['medidor']:
        uc_['medidor'] = [info['medidor']]
        uc_['tecnico']['equipamento_medidor'] = info['medidor']
    if info['constante'] is not None:
        uc_['tecnico']['constantes'] = [{'grandeza': 'Constante de Faturamento', 'valor': info['constante']}]
    uc_['tecnico']['perdas_transformacao_pct'] = info['perdas']


# ── quadros de baixo (informações técnicas, bandeira, contratadas, demandas) ─
def _quadros(ws, d, gerador):
    reg = [w for w in ws if 580 < w.y1 < 622]
    tec = []
    for l in linhas([w for w in reg if w.x0 < 150]):
        m = re.match(r'(.*?)\s+([\d.,]+)$', l.texto())
        if m:
            tec.append({'colunas_originais': {'Informações Técnicas': m[1], 'Valores': m[2]}})
            if 'Tensão' in m[1]:
                d['unidade_consumidora']['tecnico']['tensao_fornecimento_kv'] = num(m[2])
    if tec:
        d['tabelas_complementares'].append({'pagina': 1, 'nome': 'Informações Técnicas', 'linhas': tec})
    band = []
    for l in linhas([w for w in reg if 150 <= w.x0 < 276]):
        s = l.texto()
        m = re.match(r'(.*?)\s*(\d+)$', s) if l.p[-1].x0 > 245 else None
        rot, dias = (m[1], int(m[2])) if m else (s, None)
        if not rot:
            continue
        band.append({'colunas_originais': {'Bandeira Tarifária': rot, 'Dias': str(dias) if dias is not None else None}})
        r = sem_acento(rot).upper()
        cor = None
        if 'ESCASSEZ' in r:
            cor = 'ESCASSEZ'
        elif 'VERMELHA' in r:
            cor = 'VERMELHA_2' if re.search(r'PATAMAR\s*2', r) else 'VERMELHA_1'
        elif 'AMARELA' in r:
            cor = 'AMARELA'
        elif 'VERDE' in r:
            cor = 'VERDE'
        if cor:
            d['bandeiras'].append({'pagina': 1, 'cor': cor, 'inicio': None, 'fim': None, 'dias': dias})
    if band:
        d['tabelas_complementares'].append({'pagina': 1, 'nome': 'Bandeira Tarifária', 'linhas': band})
    contr = {}
    tab = []
    for l in linhas([w for w in reg if 276 <= w.x0 < 428]):
        m = re.match(r'(.*?)\s+([\d.,]+)\s*(KW|kW)$', l.texto())
        if m:
            tab.append({'colunas_originais': {'Grandezas Contratadas': m[1], 'Montante': f'{m[2]} {m[3]}'}})
            contr['geracao' if 'Inje' in m[1] else 'consumo'] = num(m[2])
    if tab:
        d['tabelas_complementares'].append({'pagina': 1, 'nome': 'Grandezas Contratadas', 'linhas': tab})
    dem = {}
    tab = []
    for l in linhas([w for w in reg if w.x0 >= 428]):
        rot = ' '.join(w.t for w in l.p if not re.search(r'\d', w.t))
        if rot not in ('Medida', 'Medida G', 'Faturada'):
            continue
        linha = {'Demandas': rot}
        for w in l.p:
            m = re.fullmatch(r'([\d.,]+)KW', w.t, re.I)
            if m:
                col = 'PONTA' if w.x0 < 518 else 'FORA_PONTA'
                dem[(rot, col)] = num(m[1])
                linha['Ponta (PT)' if col == 'PONTA' else 'Fora Ponta (FP)'] = w.t
        tab.append({'colunas_originais': linha})
    if tab:
        d['tabelas_complementares'].append({'pagina': 1, 'nome': 'Demandas', 'linhas': tab})

    def reg_(tipo, posto, rotulo, **kw):
        x = {'pagina': 1, 'tipo': tipo, 'posto': posto, 'contratada_kw': None, 'medida_kw': None,
             'faturada_kw': None, 'faturada_ultrapassagem_kw': None, 'nao_consumida_kw': None, 'data_hora': None,
             'rotulo': rotulo, 'colunas_originais': {}}
        x.update(kw)
        d['demanda'].append(x)

    for col, nome in (('PONTA', 'Ponta (PT)'), ('FORA_PONTA', 'Fora Ponta (FP)')):
        if ('Medida', col) in dem:
            reg_('consumo', col, f'Demandas: Medida {nome}', medida_kw=dem[('Medida', col)],
                 colunas_originais={'Demandas': 'Medida', nome: dem[('Medida', col)]})
    if ('Medida G', 'PONTA') in dem:
        reg_('geracao', 'PONTA', 'Demandas: Medida G Ponta (PT)', medida_kw=dem[('Medida G', 'PONTA')],
             colunas_originais={'Demandas': 'Medida G', 'Ponta (PT)': dem[('Medida G', 'PONTA')]})
    fat = dem.get(('Faturada', 'PONTA'), dem.get(('Faturada', 'FORA_PONTA')))
    difs = [i for i in d['itens'] if sem_acento(i['descricao']).upper().startswith('DIFERENCA DA DEMANDA CONTRAT')]
    nao = round(sum(i['quantidade_faturada'] or 0 for i in difs), 3) if difs else None
    # 25/11/2026: o contrato "Demanda" é de CONSUMO ou de GERAÇÃO conforme o que o item Demanda cobra:
    # - com dois contratos ("Demanda" e "Demanda de Injeção"), a "Demanda" é a de consumo;
    # - com um só, vale a medida que o item Demanda (0T/4U) repete: medida de consumo (028fa31e: 0,98 ≈ 1 kW → consumo)
    #   ou Medida G (2a14d04d: 952,7 ≈ 953 kW → geração). Sem item, só há Medida G → geração; senão consumo.
    q = [i['quantidade_faturada'] for i in d['itens'] if i.get('quantidade_faturada') is not None and
         re.fullmatch(r'DEMANDA', sem_acento(i['descricao']).upper().strip())]
    m_c = max([v for (r_, _), v in dem.items() if r_ == 'Medida' and v is not None], default=None)
    m_g = dem.get(('Medida G', 'FORA_PONTA'))
    if not gerador or contr.get('geracao') is not None:
        tipo = 'consumo'
    elif q and m_g is not None:
        tipo = 'geracao' if (m_c is None or abs(q[0] - m_g) < abs(q[0] - m_c)) else 'consumo'
    else:
        tipo = 'geracao' if (m_g is not None and m_c is None) else 'consumo'
    if tipo == 'geracao':
        if ('Medida G', 'FORA_PONTA') in dem or fat is not None or contr.get('consumo') is not None:
            reg_('geracao', 'GERACAO',
                 'Demandas: Medida G Fora Ponta (FP) / Faturada; Grandezas Contratadas: Demanda; '
                 'não consumida = itens Diferença da Demanda Contratada',
                 contratada_kw=contr.get('consumo'), medida_kw=dem.get(('Medida G', 'FORA_PONTA')),
                 faturada_kw=fat, nao_consumida_kw=nao,
                 colunas_originais={'Medida G Fora Ponta (FP)': dem.get(('Medida G', 'FORA_PONTA')), 'Faturada': fat,
                                    'Grandezas Contratadas Demanda': contr.get('consumo')})
    else:
        if fat is not None or contr.get('consumo') is not None:
            reg_('consumo', None,
                 'Demandas: Faturada; Grandezas Contratadas: Demanda; não consumida = itens Diferença da Demanda Contratada',
                 contratada_kw=contr.get('consumo'), faturada_kw=fat, nao_consumida_kw=nao,
                 colunas_originais={'Faturada': fat, 'Grandezas Contratadas Demanda': contr.get('consumo')})
        if gerador and ('Medida G', 'FORA_PONTA') in dem:
            reg_('geracao', 'GERACAO', 'Demandas: Medida G Fora Ponta (FP)', medida_kw=dem[('Medida G', 'FORA_PONTA')],
                 colunas_originais={'Demandas': 'Medida G', 'Fora Ponta (FP)': dem[('Medida G', 'FORA_PONTA')]})
    if contr.get('geracao') is not None:
        difi = [i for i in d['itens'] if 'INJET' in sem_acento(i['descricao']).upper() and
                sem_acento(i['descricao']).upper().startswith('DIFERENCA DA DEMANDA')]
        reg_('injecao', 'GERACAO', 'Grandezas Contratadas: Demanda de Injeção', contratada_kw=contr['geracao'],
             nao_consumida_kw=None,
             colunas_originais={'Grandezas Contratadas Demanda de Injeção': contr['geracao'],
                                'itens': '; '.join(f'{i["descricao"]} {i["quantidade_faturada"]}' for i in difi)})


def _mensagens(ws, d):
    ls = [l for l in linhas([w for w in ws if 622 < w.y1 < 690]) if l.texto() not in ('Mensagens:',)]
    txt = [re.sub(r'^Mensagens:\s*', '', l.texto()) for l in ls]
    bloco, atraso = [], None
    for t in txt:
        if t.startswith('EM CASO DE PAGAMENTO'):
            atraso = t
        elif t:
            bloco.append(t)
    if bloco:
        d['mensagens'].append({'pagina': 1, 'texto': ' '.join(bloco)})
    if atraso:
        d['mensagens'].append({'pagina': 1, 'texto': atraso})
    m = re.search(r'UC antiga era\s+(\d+)', ' '.join(bloco))
    if m:
        d['valores_alternativos'].append({'campo': 'unidade_consumidora.uc', 'valor': m[1], 'pagina': 1})


def _boleto(ws, bruto, d):
    pag, tit, uc_ = d['pagamento'], d['titular'], d['unidade_consumidora']
    pag['boleto'] = {'nosso_numero': None, 'numero_documento': None, 'carteira': None, 'especie': None,
                     'aceite': None, 'data_documento': None, 'data_processamento': None, 'beneficiario': None,
                     'agencia_codigo_beneficiario': None, 'pagador': None, 'local_pagamento': None, 'instrucoes': None}
    pag['conta_recebedora'] = None
    bol = pag['boleto']
    ls = linhas([w for w in ws if w.y1 > 690])
    for l in ls:
        s = l.texto()
        m = re.search(r'\b(\d{5}\.\d{10}\.\d{11}\.\d{15,25}|8\d{47})\b', s)
        if m:
            pag['linha_digitavel'] = m[1]
        m = re.search(r'\b(\d{3}-\d)\b', s)
        if m and 'BRADESCO' in bruto and not pag['banco']:
            pag['banco'] = f'BRADESCO {m[1]}'
        m = re.match(r'Pagador:\s*(.+)$', s)
        if m:
            bol['pagador'] = m[1]
            if not tit['nome']:
                tit['nome'] = m[1]
        m = re.match(r'Endereço:\s*(.+)$', l.texto(0, 420))
        if m:
            tit['endereco'] = m[1].strip()
        m = re.match(r'CEP:\s*(\d{5}-\d{3})\s*Cidade:\s*(.+?)\s+([A-Z]{2})$', l.texto(0, 420))
        if m:
            tit['cep'], tit['cidade'], tit['uf'] = m[1], m[2], m[3]
        m = re.search(r'Cedente:\s*(\S+)', s)
        if m:
            bol['agencia_codigo_beneficiario'] = m[1]
        m = re.match(r'(\d\d/\d\d/\d{4})\s+(\d{6}-\d+)\s+([\d.\-]+)\s+(?:(\S+)\s+)?(\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+([\d.]+,\d\d)$', s)
        if m:
            bol['data_documento'] = data_br(m[1])
            bol['numero_documento'] = pag['numero_fatura'] = m[2]
            bol['nosso_numero'] = m[4]
            if m[3] != uc_['uc']:
                d['valores_alternativos'].append({'campo': 'unidade_consumidora.uc', 'valor': m[3], 'pagina': 1})
            tot = num(m[7])
            if d['totais']['total_a_pagar'] is None:
                d['totais']['total_a_pagar'] = tot
    m = re.search(r'Automático:\s*(\d{6,})', re.sub(r'\s+', ' ', bruto))
    if not m:
        cod = [w.t for w in ws if 425 < w.x0 < 500 and 740 < w.y1 < 760 and re.fullmatch(r'\d{8,}', w.t)]
        pag['debito_automatico'] = f'Código para Cadastro em Débito Automático: {cod[0]}' if cod else None
    else:
        pag['debito_automatico'] = f'Código para Cadastro em Débito Automático: {m[1]}'
    if 'PAGUE COM PIX' in bruto:
        pag['pix'] = 'QR code PAGUE COM PIX (conteúdo não impresso)'
    bol['beneficiario'] = 'Celesc Distribuição SA - CNPJ 08336783/0001-90' if 'Beneficiário' in bruto else None
    bol['local_pagamento'] = 'PAGÁVEL EM QUALQUER AGÊNCIA BANCÁRIA' if 'PAGÁVEL EM QUALQUER' in bruto else None
    if tit['endereco']:
        uc_['endereco'] = ', '.join(x for x in (tit['endereco'], f'{tit["cidade"]} {tit["uf"]}' if tit['cidade'] else None,
                                                 f'CEP {tit["cep"]}' if tit['cep'] else None) if x)


# ── últimas páginas ──────────────────────────────────────────────────────────
def _demonstrativo_gd(ws, np_, d):
    reg = [w for w in ws if 95 < w.y1 < 205 and w.x0 < 600]
    ls = linhas(reg)
    hm = next((l for l in ls if any(_mes(w.t) for w in l.p)), None)
    hp = next((l for l in ls if l.p and all(w.t in ('FP', 'PT') for w in l.p)), None)
    if not hm or not hp:
        return
    meses = sorted([w for w in hm.p if _mes(w.t)], key=lambda w: w.x0)
    cols = []
    for w in hp.p:
        cx = (w.x0 + w.x1) / 2
        mes = max([m for m in meses if m.x0 - 25 <= cx] or meses[:1], key=lambda m: m.x0)
        cols.append((cx, mes.t, 'FORA_PONTA' if w.t == 'FP' else 'PONTA', w.t))
    ref = meses[0].t
    tab = []
    for l in ls:
        if l is hm or l is hp:
            continue
        s = l.texto()
        if s.startswith('Saldo a expirar'):
            dt = re.search(r'em\s*(\d\d)\.(\d\d)\.(\d{4})', s)
            for po, v in re.findall(r'((?:Fora )?Ponta):\s*([\d.]+)', s):
                d['gd']['lancamentos'].append({'pagina': np_, 'tipo': 'a_expirar',
                                               'posto': 'FORA_PONTA' if po.startswith('Fora') else 'PONTA',
                                               'kwh': num(v), 'mes_ref': None,
                                               'ref_expiracao': f'{dt[3]}-{dt[2]}-{dt[1]}' if dt else None,
                                               'unidade_impressa': 'kWh', 'rotulo': s})
            d['mensagens'].append({'pagina': np_, 'texto': s})
            continue
        for w in l.p:  # pdf escaneado: OCR lê o zero isolado da tabela como a letra 'o'
            if w.x0 > 150 and w.t in ('o', 'O'):
                w.t = '0'
        if s.startswith('Maiores informações'):
            d['mensagens'].append({'pagina': np_, 'texto': s})
            continue
        rot = ' '.join(w.t for w in l.p if not re.fullmatch(r'-?[\d.]+-?', w.t))
        nums = [w for w in l.p if re.fullmatch(r'-?[\d.]+-?', w.t)]
        if not rot or not nums:
            continue
        tipo = next((t for k, t in GD_TIPOS if rot.startswith(k)), 'outro')
        linha = {'': rot}
        for w in nums:
            cx = (w.x0 + w.x1) / 2
            c = min(cols, key=lambda c: abs(c[0] - cx))
            linha[f'{c[1]} {c[3]}'] = w.t
            if c[1] == ref:
                d['gd']['lancamentos'].append({'pagina': np_, 'tipo': tipo, 'posto': c[2], 'kwh': num(w.t),
                                               'mes_ref': _mes(c[1]), 'ref_expiracao': None,
                                               'unidade_impressa': 'kWh', 'rotulo': f'{rot} ({c[1]} {c[3]})'})
        tab.append({'colunas_originais': linha})
    if tab:
        d['tabelas_complementares'].append({'pagina': np_, 'nome': 'Demonstrativo GD da geradora (sem título)',
                                            'linhas': tab})


def _tributos(ws, np_, d):
    for l in linhas([w for w in ws if 230 < w.y1 < 290 and w.x0 < 330]):
        m = re.match(r'(PIS|COFINS|ICMS)\s+([\d.]+,\d+)\s+([\d.]+,\d+)\s+([\d.]+,\d+)$', l.texto())
        if m:
            d['tributos'].append({'pagina': np_, 'tributo': m[1], 'base': num(m[2]), 'aliquota': num(m[3]),
                                  'valor': num(m[4]), 'retido': False,
                                  'colunas_originais': {'Tributos': m[1], 'Base de Cálculo (R$)': m[2],
                                                        'Alíquota (%)': m[3], 'Valor (R$)': m[4]}})
    if d['tributos']:
        d['totais']['total_tributos'] = None


def _retirado(ws, np_, d):
    tab = []
    for l in linhas([w for w in ws if 295 < w.y1 < 450 and w.x0 < 330]):
        nome = ' '.join(w.t for w in l.p if not re.fullmatch(r'-?[\d.,]+', w.t))
        nums = [w.t for w in l.p if re.fullmatch(r'-?[\d.,]+', w.t)]
        if nome not in GRANDEZAS or len(nums) != 3:
            continue
        tab.append({'colunas_originais': {'Grandeza': nome, 'Leitura Anterior': nums[0], 'Leitura Atual': nums[1],
                                          'Total Apurado': nums[2]}})
        energia = nome.startswith(('Consumo', 'Energia', 'Reativo'))
        un = ('kVArh' if nome.startswith('Reativo') else 'kWh') if energia else ('kVAr' if 'Reativa' in nome else 'kW')
        d['medicoes'].append({
            'pagina': np_, 'tabela_origem': 'Medidor Retirado', 'medidor': None, 'grandeza': nome,
            'posto': 'FORA_PONTA' if 'Fora Ponta' in nome else 'PONTA', 'leitura_anterior': num(nums[0]),
            'leitura_atual': num(nums[1]), 'constante': None, 'perdas_pct': None, 'ajuste': None,
            'consumo': num(nums[2]), 'consumo_faturado': None, 'fator_potencia': None, 'ajuste_fator_potencia': None,
            'unidade': un, 'data_hora_registro': None, 'leitura_arredondada': False,
            'colunas_originais': tab[-1]['colunas_originais']})
    if tab:
        d['tabelas_complementares'].append({'pagina': np_, 'nome': 'Medidor Retirado', 'linhas': tab})


# ── divergências que a própria fatura imprime ────────────────────────────────
def _provas(d):
    div = d['extracao']['divergencias_impressas']
    for i, it in enumerate(d['itens']):
        q, t, v = it['quantidade_faturada'], it['tarifa_com_tributos'], it['valor']
        if None in (q, t, v) or abs(v) <= 1:
            continue
        if abs(abs(q * t) - abs(v)) > max(0.05, abs(v) * 0.01) and (q == 0 or t == 0):
            div.append({'onde': 'item', 'indice': i,
                        'nota': f'({it["codigo"]}) {it["descricao"]} impresso com Quantidade {q} e Preço unitário {t} '
                                f'e Valor {v} (lançamento fixo, não é quantidade x tarifa)'})
    for j, m in enumerate(d['medicoes']):
        la, lb, c, cons = m['leitura_anterior'], m['leitura_atual'], m['constante'], m['consumo']
        if None in (la, lb, c, cons) or not c or m['perdas_pct'] or lb < la:
            continue
        if abs((lb - la) * c - cons) > max(1, abs(cons) * 0.01):
            div.append({'onde': 'medicao', 'indice': j,
                        'nota': f'{m["grandeza"]}: Total Apurado impresso {cons} ≠ ({lb}−{la})×{c}'})
