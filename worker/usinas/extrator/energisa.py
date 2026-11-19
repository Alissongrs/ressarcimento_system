"""Parser determinístico das faturas Energisa (MT, MS, TO, PB, SE, Sul-Sudeste) — DANF3E A4, 2 páginas.

p1: emitente, roteiro/matrícula/débito automático, classificação, tensão, titular, UC/instalação, NF3e, referência,
itens (cabeçalho em texto), tributos e grandezas contratadas (à direita), TOTAL, medições (pé da página);
p2: avisos de GD (classificação, saldo, a expirar), indicadores de continuidade, histórico de 13 meses (colunas fixas;
"*" = faturado pela média), datas, "estrutura do consumo" (medido × faturado), composição do valor, EUSD.
"""
import re

from base import data_br, e_numero, esqueleto, linhas, mes_ano, num, palavras, sem_acento

NOME = 'energisa_v1'
CNPJS = {'03.467.321/0001-99': 'ENERGISA MT', '15.413.826/0001-50': 'ENERGISA MS', '25.086.034/0001-71': 'ENERGISA TO',
         '09.095.183/0001-40': 'ENERGISA PB', '13.017.462/0001-63': 'ENERGISA SE', '07.282.377/0001-20': 'ENERGISA SUL-SUDESTE',
         '19.527.639/0001-58': 'ENERGISA MG'}
MES3 = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ']
# histórico p2: borda direita (x1) das colunas → (rótulo, série, posto, unidade)
HIST = [(217, 'PONTA CONSUMO FATURADO', 'consumo', 'PONTA', 'kWh'), (254, 'PONTA DEMANDA MEDIDA', 'demanda', 'PONTA', 'kW'),
        (281, 'INTERMEDIÁRIA CONS. FAT.', 'consumo', 'INTERMEDIARIO', 'kWh'),
        (314, 'FORA DE PONTA CONSUMO FATURADO', 'consumo', 'FORA_PONTA', 'kWh'),
        (348, 'FORA DE PONTA DEMANDA MEDIDA', 'demanda', 'FORA_PONTA', 'kW'),
        (376, 'PONTA ERE', 'reativo_ere', 'PONTA', 'kVArh'), (405, 'PONTA DRE', 'reativo_dre', 'PONTA', 'kVAr'),
        (433, 'FORA DE PONTA ERE', 'reativo_ere', 'FORA_PONTA', 'kVArh'),
        (462, 'FORA DE PONTA DRE', 'reativo_dre', 'FORA_PONTA', 'kVAr'),
        (491, 'RESERVADO CONS.', 'consumo', 'RESERVADO', 'kWh'), (520, 'RESERVADO ERE', 'reativo_ere', 'RESERVADO', 'kVArh'),
        (553, 'TUSDG DEMANDA MEDIDA', 'demanda_geracao', 'GERACAO', 'kW')]


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


def _col(ws, anc, tol=12):
    out = {}
    for w in ws:
        k = min(anc, key=lambda c: abs(anc[c] - w.x1))
        if abs(anc[k] - w.x1) <= tol:
            out[k] = w.t if k not in out else out[k] + ' ' + w.t
    return out


def _chave(t):
    t = re.sub(r'(?<=\d) (?=\d{4}\b)', '', t)
    m = re.search(r'\b(\d{44})\b', t)
    return m[1] if m else None


def _cnpj_ch(ch):
    c = ch[6:20]
    return f'{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:]}'


def detecta(texto, doc=None):
    return 'ENERGISA' in texto.upper() and 'Itens da Fatura' in texto


def _posto(t):
    d = ' ' + sem_acento(t).upper().replace('-', ' ') + ' '
    if re.search(r' (FORA PONTA|F PONTA|FPONTA|FP) ', d):
        return 'FORA_PONTA'
    if re.search(r' (PONTA|PTA|P) ', d):
        return 'PONTA'
    if re.search(r' (INTERMEDIARI[OA]|INT) ', d):
        return 'INTERMEDIARIO'
    if re.search(r' (RESERVADO|HR) ', d):
        return 'RESERVADO'
    return None


def componente_de(desc):
    d = sem_acento(desc).upper()
    if 'INJETADA' in d or 'COMPENSAD' in d:
        return 'GD_INJETADA', _posto(d)
    if 'TUSDG' in d or 'GERACAO' in d:
        return ('DEMANDA_GERACAO_ULTRAPASSAGEM' if 'ULTRAP' in d else 'DEMANDA_GERACAO'), 'GERACAO'
    if 'ULTRAP' in d:
        return 'DEMANDA_ULTRAPASSAGEM', _posto(d) or 'UNICO'
    if 'REATIV' in d or 'EXCED' in d:
        return 'REATIVO_EXCEDENTE', _posto(d)
    if 'DEMANDA' in d:
        return 'DEMANDA', _posto(d) or 'UNICO'
    if 'BANDEIRA' in d or 'ADC BAND' in d or 'ADIC' in d and 'BAND' in d:
        return 'BANDEIRA', _posto(d)
    if 'CONSUMO' in d:
        return 'CONSUMO', _posto(d)
    if 'ILUM' in d:
        return 'ILUMINACAO_PUBLICA', None
    if d.startswith('MULTA'):
        return 'MULTA', None
    if d.startswith('JUROS'):
        return 'JUROS', None
    if 'ATUALIZ' in d or 'CORRECAO' in d or 'IPCA' in d or 'IGPM' in d:
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
    # emitente (x≈151, topo)
    em = [l.texto(140, 420).strip() for l in ls if 22 < l.y < 50 and l.entre(140, 420)]
    if em:
        doc_['distribuidora'] = em[0]
        mm = re.search(r'CNPJ\s+([\d./-]{18})\s+Insc\.\s*Est\.\s*(\S+)', ' '.join(em))
        if mm:
            doc_['distribuidora_cnpj'], doc_['distribuidora_ie'] = mm[1], mm[2]
        doc_['distribuidora_endereco'] = ' '.join(x for x in em[1:] if not x.startswith('CNPJ')) or None
    ch = _chave(' '.join(brutos))
    nf['chave_acesso'] = ch
    if not doc_['distribuidora_cnpj'] and ch:
        doc_['distribuidora_cnpj'] = _cnpj_ch(ch)
    doc_['distribuidora_sigla'] = CNPJS.get(doc_['distribuidora_cnpj'], 'OUTRA')
    nf['modelo'] = 'DANF3E - DOCUMENTO AUXILIAR DA NOTA FISCAL DE ENERGIA ELÉTRICA ELETRÔNICA'
    g = lambda rx, s=tj: (re.search(rx, s) or [None, None])[1]
    uc_['roteiro_leitura'] = g(r'ROTEIRO:\s*([\d -]+?\d)(?:\s{2}|\s+[A-Za-z]|$)')
    tit['matricula'] = g(r'MATR\S+CULA:\s*(\S+)')
    nf['data_apresentacao'] = data_br(g(r'Data de Apresenta\S+:\s*(\d\d/\d\d/\d{4})')) if g(r'Data de Apresenta\S+:\s*(\d\d/\d\d/\d{4})') else None
    # classificação (2 linhas) e ligação
    lc = next((k for k, l in enumerate(ls) if 'Classificação:' in l.texto()), None)
    if lc is not None:
        cls = ls[lc].texto(0, 210).replace('Classificação:', '').strip()
        if lc + 1 < len(ls) and ls[lc + 1].y - ls[lc].y < 9:
            cls += ' ' + ls[lc + 1].texto(0, 210).strip()
        cls = re.sub(r'\s+', ' ', re.sub(r'LIGA\S+O:\s*\S+', '', cls)).strip()
        uc_['classificacao'] = cls
        p = [x.strip() for x in cls.split('/')]
        mm = re.search(r'(VERDE|AZUL|CONVENCIONAL|BRANCA)', cls.upper())
        uc_['modalidade_tarifaria'] = mm[1].capitalize() if mm else None
        mm = re.search(r'\b([AB]\d[A-Z]?)\b', cls)
        if mm:
            uc_['subgrupo'], uc_['grupo'] = mm[1], mm[1][0]
            uc_['tipo_tarifa_impresso'] = cls[:cls.find(mm[1]) + len(mm[1])].strip()
        if len(p) >= 3:
            uc_['classe'] = p[1].split()[-1] if p[1].split() else None
            uc_['subclasse'] = p[2] or None
    uc_['tipo_fornecimento'] = g(r'LIGA\S+O:\s*(\S+)')
    tec = {'tensao_nominal': None, 'tensao_contratada_v': None, 'tensao_fornecimento_kv': None, 'tensao_minima': None,
           'tensao_maxima': None, 'faixa_adequada': None, 'fator_potencia_referencia': None, 'rtc': None, 'rtp': None,
           'constantes': [], 'perdas_transformacao_pct': None, 'horario_ponta': None, 'equipamento_medidor': None,
           'responsavel_iluminacao_publica': None}
    mm = re.search(r'TENS\S+ NOMINAL EM VOLTS\s+DISP:\s*(\d+)\s+Lim\. Min\.:\s*(\d+)\s+Lim\. Max\.:\s*(\d+)', tj)
    if mm:
        tec.update({'tensao_nominal': mm[1], 'tensao_minima': num(mm[2]), 'tensao_maxima': num(mm[3])})
    uc_['tecnico'] = tec
    # datas de leitura (direita, y≈184)
    rx4 = r'(\d\d/\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+(\d{1,3})\s+(\d\d/\d\d/\d{4})'
    mm = next((re.search(rx4, l.texto(340, 600)) for l in ls if re.search(rx4, l.texto(340, 600))), None)
    if mm:
        ref.update({'leitura_anterior': data_br(mm[1]), 'leitura_atual': data_br(mm[2]), 'dias_faturados': int(mm[3]),
                    'proxima_leitura': data_br(mm[4])})
    _titular(t1, ls, d)
    # NF3e (direita)
    wn = next((w for w in t1 if w.t == 'NOTA' and w.x0 > 380 and w.y1 < 300), None)
    wp = next((w for w in t1 if w.t == 'Protocolo' and w.x0 > 380), None)
    x_nf = (wn.x0 - 4) if wn else 410
    y0_nf, y1_nf = (wn.y1 - 3 if wn else 190), (wp.y1 + 12 if wp else 290)
    tn = ' '.join(l.texto(x_nf, 600) for l in ls if y0_nf < l.y < y1_nf)
    if not nf['chave_acesso']:
        nf['chave_acesso'] = _chave(tn)
        if nf['chave_acesso'] and not doc_['distribuidora_cnpj']:  # emitente pela chave lida no quadro da NF
            doc_['distribuidora_cnpj'] = _cnpj_ch(nf['chave_acesso'])
            doc_['distribuidora_sigla'] = CNPJS.get(doc_['distribuidora_cnpj'], 'OUTRA')
            if (doc_['distribuidora'] or '').startswith('DANF3E'):  # título do documento lido no lugar do emitente
                doc_['distribuidora'] = None
    mm = re.search(r'NOTA FISCAL N\S*:?\s*([\d.]+)\s*-\s*S\S*rie:\s*(\S+)', tn, re.I)
    if mm:
        nf['numero'], nf['serie'] = mm[1], mm[2]
    mm = re.search(r'EMISS\S+:\s*(\d\d/\d\d/\d{4})', tn)
    if mm:
        nf['data_emissao'] = ref['data_emissao'] = data_br(mm[1])
    mm = re.search(r'Protocolo de autoriza\S*:?\s*(\d+)\s*-?\s*(\d\d/\d\d/\d{4})\s*(?:\S+\s*)?(\d\d:\d\d:\d\d)?', tn, re.I)
    if mm:
        nf['protocolo_autorizacao'] = mm[1]
        nf['data_autorizacao'] = data_br(mm[2]) + (f'T{mm[3]}' if mm[3] else '')
    mm = re.search(r'(https?://\S+)', ' '.join(brutos[:1]))
    nf['url_consulta'] = mm[1] if mm else None
    # referência: "Março / 2025  01/04/2025  R$ 26.913,70"
    meses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro',
             'Novembro', 'Dezembro']
    mm = re.search(r'(' + '|'.join(meses) + r')\s*/\s*(\d{4})\s+(\d\d/\d\d/\d{4})\s+R\$\s*([\d.]+,\d\d)', tj)
    if mm:
        ref['mes_referencia'] = f'{mm[2]}-{meses.index(mm[1]) + 1:02d}'
        ref['data_vencimento'] = data_br(mm[3])
        tot['total_a_pagar'] = num(mm[4])
    _itens(t1, d)
    _direita(t1, d)
    _medicoes(t1, d)
    if len(pags) > 1:
        _pagina2(pags[1][1], brutos[1], d)
    _pagamento(brutos, d)
    ilum = [i['valor'] for i in d['itens'] if i['componente'] == 'ILUMINACAO_PUBLICA' and i['valor'] is not None]
    tot['valor_cosip_cip'] = round(sum(ilum), 2) if ilum else None
    uc_['geracao']['e_gerador'] = any(i['componente'] in ('DEMANDA_GERACAO', 'GD_INJETADA') for i in d['itens'])
    _complementos(t1, pags, brutos, d)
    for it in d['itens']:
        if it['componente'] == 'GD_INJETADA' and it['quantidade_faturada']:
            d['gd']['lancamentos'].append({'pagina': 1, 'tipo': 'compensada', 'posto': it['posto'],
                                           'kwh': it['quantidade_faturada'], 'mes_ref': ref['mes_referencia'],
                                           'ref_expiracao': None, 'unidade_impressa': 'kWh', 'rotulo': it['descricao']})
    return d


def _titular(t1, ls, d):
    tit, uc_ = d['titular'], d['unidade_consumidora']
    yt = next((w.y1 for w in t1 if w.t == 'TENSÃO' and w.x0 < 80), 156)
    yi = next((w.y1 for w in t1 if w.t == 'Insc.' and w.x0 < 80 and w.y1 > yt), yt + 90)
    bl = [l for l in ls if yt + 4 < l.y <= yi + 1 and l.entre(40, 225)]
    lin = [l.texto(40, 225).strip() for l in bl]
    lin = [x for x in lin if x and not re.fullmatch(r'\d', x)]
    if lin:
        k = 1  # nome em 1 ou 2 linhas (2ª linha sem dígitos, sem vírgula e seguida do endereço)
        l1 = lin[1] if len(lin) > 1 else ''
        if len(lin) > 2 and ',' not in l1 and not l1.startswith(('CNPJ', 'Insc')) and re.search(r'[\d,]', lin[2]) \
                and (not re.search(r'\d', l1) or re.search(r'\b(LTDA|S\.?A\.?|EIRELI|ME|EPP)$', l1)):
            k = 2
        tit['nome'] = ' '.join(lin[:k])
        end, resto = [], lin[k:]
        for x in resto:
            mm = re.match(r'CNPJ/CPF:\s*(\S+)', x)
            if mm:
                if 'X' in mm[1]:
                    tit['cnpj_cpf_mascarado'] = mm[1]
                else:
                    tit['cnpj_cpf'] = mm[1]
                continue
            mm = re.match(r'Insc\.\s*Est\.:\s*(\S*)', x)
            if mm:
                tit['inscricao_estadual'] = mm[1] or None
                continue
            end.append(x)
        if end:
            mm = re.search(r'-\s*(\d{8})\b', end[0])
            tit['cep'] = mm[1] if mm else None
            tit['endereco'] = end[0] + (' ' + end[1] if len(end) > 2 else '')
            tit['cidade'] = re.sub(r'\s*\(AG:\s*\d+\)$', '', end[-1])
            uc_['endereco'] = ' '.join(end)
    mid = [w for w in t1 if 225 < w.x0 < 320 and yt + 4 < w.y1 < yi + 20]
    uc = next((w.t for w in mid if re.fullmatch(r'\d+/\d+-\d|\d{1,3}(?:\.\d{3}){1,3}-\d{2}', w.t)), None)
    ins = next((w.t for w in mid if re.fullmatch(r'[A-Z]\d{6,}', w.t)), None)
    uc_['uc'] = uc
    tit['codigo_cliente'] = uc
    uc_['instalacao'] = None  # Energisa não imprime instalação; o "W9…" do quadro é o número do medidor
    if ins:
        uc_['medidor'].append(ins)
    mm = re.search(r'-\s*([A-Z]{2})\s+-\s*CEP', ' '.join(d['documento'].get('distribuidora_endereco') or ''))
    tit['uf'] = (re.search(r'/([A-Z]{2})\b', d['documento'].get('distribuidora_endereco') or '') or [None, None])[1]


def _itens(t1, d):
    cab = next((w for w in t1 if w.t == 'Itens' and w.x0 < 40), None)
    if not cab:
        return
    hdr = [w for w in t1 if cab.y1 - 9 < w.y1 < cab.y1 + 3]

    def x1(pred, default=None):
        c = [w.x1 for w in hdr if pred(w.t)]
        return max(c) if c else default
    anc = {'quant': x1(lambda t: t.startswith('Quant'), 217) + 12, 'preco': x1(lambda t: t == 'tributos', 251),
           'valor': x1(lambda t: t == '(R$)' and False, None) or 289,
           'pis_cofins': max((w.x1 for w in hdr if w.t == '(R$)' and 300 < w.x0 < 330), default=324) - 7,
           'base_icms': max((w.x1 for w in hdr if w.t == '(R$)' and 340 < w.x0 < 360), default=354),
           'aliquota_icms': x1(lambda t: t.startswith('Alíq'), 372) - 6,
           'icms': max((w.x1 for w in hdr if w.t == '(R$)' and 385 < w.x0 < 410), default=403),
           'tarifa': x1(lambda t: t == 'Tarifa', 441)}
    v = next((w for w in t1 if w.t == 'Valor' and cab.y1 - 6 < w.y1 < cab.y1 + 1), None)
    if v:
        anc['valor'] = v.x1 + 9
    tot_w = next((w for w in t1 if w.t == 'TOTAL:' and w.y1 > cab.y1), None)
    y_fim = tot_w.y1 + 1 if tot_w else 600
    ws = [w for w in t1 if cab.y1 + 3 < w.y1 < y_fim and w.x0 < 445]
    secao = None
    rows = _grupos(ws, 2.4)
    tot = d['totais']
    x_un = next((w.x0 for w in hdr if w.t.startswith('Unid')), 162) - 6
    x1s = sorted(w.x1 for w in ws if w.x0 >= x_un + 25 and e_numero(w.t))
    grp = []
    for x in x1s:
        if grp and x - grp[-1][-1] <= 8:
            grp[-1].append(x)
        else:
            grp.append([x])
    grp = [g_ for g_ in grp if len(g_) >= 3]
    if len(grp) == 8:
        anc = {k_: sorted(g_)[len(g_) // 2] for k_, g_ in zip(('quant', 'preco', 'valor', 'pis_cofins', 'base_icms',
                                                               'aliquota_icms', 'icms', 'tarifa'), grp)}
    for k, (y, g) in enumerate(rows):
        unid_w = next((w for w in g if re.fullmatch(r'KWH|KW|UN|KVARH|KVAR|kWh|kW', w.t) and x_un - 15 <= w.x0 < x_un + 25), None)
        unid = unid_w.t if unid_w else None
        desc = [w for w in g if w.x0 < x_un + 2 and w is not unid_w and not (e_numero(w.t) and w.x0 > x_un - 20)]
        nums = [w for w in g if w.x0 >= x_un + 20 and e_numero(w.t)]
        t = _txt(desc)
        if t == 'TOTAL:' or (not t and nums and tot_w and abs(y - tot_w.y1) < 3):
            cols = _col(nums, anc)
            rot = {'valor': 'Valor (R$)', 'pis_cofins': 'PIS/COFINS (R$)', 'base_icms': 'Base Calc. ICMS (R$)',
                   'icms': 'ICMS (R$)'}
            for c, v_ in cols.items():
                if c in rot:
                    tot['totais_colunas'].append({'pagina': 1, 'coluna': rot[c], 'valor': num(v_)})
            tot['total_nota_fiscal'] = num(cols.get('valor'))
            continue
        if t and not nums:
            if t.isupper() and len(t.split()) <= 4:
                secao = t
            continue
        if not t and nums and d['itens']:  # PIS/COFINS ou quantidade em linha solta (deslocada alguns pt)
            cols = _col(nums, anc)
            it = d['itens'][-1]
            for c, v_ in cols.items():
                campo = {'pis_cofins': 'pis_cofins', 'quant': 'quantidade_faturada', 'base_icms': 'base_icms'}.get(c)
                if campo and it.get(campo) is None:
                    it[campo] = num(v_)
                    it['colunas_originais'][c] = v_
            continue
        if not t:
            continue
        cols = _col(nums, anc)
        comp, posto = componente_de(t)
        d['itens'].append({'pagina': 1, 'secao_impressa': secao, 'codigo': None, 'descricao': t, 'mes_ref': None,
                           'componente': comp, 'posto': posto, 'quantidade_registrada': None,
                           'quantidade_faturada': num(cols.get('quant')), 'unidade': unid,
                           'tarifa_com_tributos': num(cols.get('preco'), ponto_decimal=True),
                           'tarifa_sem_tributos': num(cols.get('tarifa'), ponto_decimal=True),
                           'valor': num(cols.get('valor')), 'valor_sem_tributos': None,
                           'base_icms': num(cols.get('base_icms')), 'aliquota_icms': num(cols.get('aliquota_icms')),
                           'icms': num(cols.get('icms')), 'base_pis_cofins': None, 'aliquota_pis': None, 'pis': None,
                           'aliquota_cofins': None, 'cofins': None, 'pis_cofins': num(cols.get('pis_cofins')),
                           'nf_referencia': None, 'colunas_originais': {'Itens da Fatura': t, 'Unid.': unid, **cols}})


def _direita(t1, d):
    trb = next((w for w in t1 if w.t == 'Tributo' and w.x0 > 400), None)
    xz = (trb.x0 - 6) if trb else 445
    zona = [w for w in t1 if w.x0 >= xz and (trb.y1 if trb else 375) < w.y1 < 560]
    tab = {'pagina': 1, 'nome': 'Grandezas Contratadas', 'linhas': []}
    pend = None
    for y, g in _grupos(zona, 2.4):
        s = _txt(g)
        mm = re.match(r'(PIS|COFINS|ICMS)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)$', s) or \
            re.match(r'(PIS|COFINS|ICMS)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)', ' '.join(s.split()[:1] + sorted(s.split()[1:], key=lambda x: 0)))
        if mm:
            ws = [w for w in g if w.t != mm[1]]
            nn = sorted([w for w in ws if e_numero(w.t)], key=lambda w: w.x0)
            base, al, val = (nn[0].t, nn[1].t, nn[2].t) if len(nn) >= 3 else (None, None, None)
            d['tributos'].append({'pagina': 1, 'tributo': mm[1], 'base': num(base), 'aliquota': num(al),
                                  'valor': num(val), 'retido': False,
                                  'colunas_originais': {'Tributo': mm[1], 'Base de Cálc.(R$)': base, 'Alíquota (%)': al,
                                                        'Valor (R$)': val}})
            continue
        mm = re.match(r'(Demanda .*? - kW)\s*([\d.,]+)?$', s)
        if mm:
            rot, val = mm[1], mm[2]
            tab['linhas'].append({'colunas_originais': {rot: val or ''}})
            if val:
                ger = 'TUSDG' in rot
                d['demanda'].append({'pagina': 1, 'tipo': 'geracao' if ger else 'consumo',
                                     'posto': 'GERACAO' if ger else _posto(rot), 'contratada_kw': num(val),
                                     'medida_kw': None, 'faturada_kw': None, 'faturada_ultrapassagem_kw': None,
                                     'nao_consumida_kw': None, 'data_hora': None,
                                     'rotulo': f'Grandezas Contratadas: {rot}', 'colunas_originais': {rot: val}})
    if tab['linhas']:
        d['tabelas_complementares'].append(tab)


def _medicoes(t1, d):
    tot_w = next((w for w in t1 if w.t == 'TOTAL:'), None)
    y0 = tot_w.y1 + 5 if tot_w else 560
    for y, g in _grupos([w for w in t1 if y0 < w.y1 < y0 + 130 and w.x0 < 320], 1.2):
        if not re.fullmatch(r'[A-Z]?\d{6,}', g[0].t) or g[0].x0 > 70:
            continue
        med = g[0].t
        gr = _txt([w for w in g[1:] if w.x0 < 140 and not e_numero(w.t)])
        po = _txt([w for w in g[1:] if 140 <= w.x0 < 180 and not e_numero(w.t)])
        ns = sorted([w for w in g if w.x0 >= 180 and e_numero(w.t)], key=lambda w: w.x0)
        vals = [w.t for w in ns]
        if len(vals) == 3 and d['medicoes']:  # constante e consumo colados no PDF ("12000135,98" = 120 + 200135,98)
            k0 = d['medicoes'][-1]['colunas_originais'].get('constante')
            if k0 and vals[2].startswith(k0) and len(vals[2]) > len(k0) + 3:
                resto = vals[2][len(k0):]
                vals = vals[:2] + [k0, resto]
                d['extracao']['observacoes'].append(f'medidor {med}: constante e consumo impressos sobrepostos '
                                                    f'("{ns[2].t}" lido como {k0} e ...{resto})')
        cols = {k_: v_ for k_, v_ in zip(('leitura_anterior', 'leitura_atual', 'constante', 'consumo'), vals)}
        if not gr:  # grandeza na linha de cima/baixo ("Energia injetada")
            gr = _txt(sorted([w for w in t1 if 0 < abs(w.y1 - y) < 4 and 75 < w.x0 < 140 and not e_numero(w.t)],
                             key=lambda w: w.x0))
        d['medicoes'].append({'pagina': 1, 'tabela_origem': 'Medidor (quadro da página 1)', 'medidor': med,
                              'grandeza': gr, 'posto': _posto(po), 'leitura_anterior': num(cols.get('leitura_anterior')),
                              'leitura_atual': num(cols.get('leitura_atual')), 'constante': num(cols.get('constante')),
                              'perdas_pct': None, 'ajuste': None, 'consumo': num(cols.get('consumo')),
                              'consumo_faturado': None, 'fator_potencia': None, 'ajuste_fator_potencia': None,
                              'unidade': 'kWh' if 'kWh' in gr or 'injetada' in gr else ('kW' if 'kW' in gr else None),
                              'data_hora_registro': None, 'leitura_arredondada': False,
                              'colunas_originais': {'Medidor': med, 'Grandezas': gr, 'Postos horários': po, **cols}})
        if med not in d['unidade_consumidora']['medidor']:
            d['unidade_consumidora']['medidor'].append(med)


def _pagina2(t2, b2, d):
    tx = re.sub(r'\s+', ' ', b2)
    uc_, gd, ref = d['unidade_consumidora'], d['gd'], d['referencia']
    mm = re.search(r'(UC com M\S+gera\S+o classificada como (GD_\w+) para faturamento, conforme Lei [\d./]+)', tx)
    if mm:
        uc_['geracao']['modalidade_gd'], uc_['geracao']['classificacao_gd'] = mm[1], mm[2]
        d['mensagens'].append({'pagina': 2, 'texto': 'ATENÇÃO: ' + mm[1]})
    mm = re.search(r'Saldo Ac:\s*([\d.,]+)\(P\)\s*([\d.,]+)\(FP\)', tx)
    if mm:
        for po, v in (('PONTA', mm[1]), ('FORA_PONTA', mm[2])):
            gd['lancamentos'].append({'pagina': 2, 'tipo': 'saldo_atual', 'posto': po, 'kwh': num(v), 'mes_ref': None,
                                      'ref_expiracao': None, 'unidade_impressa': 'kWh', 'rotulo': f'Saldo Ac: {v}'})
    mm = re.search(r'A expirar em (\d\d/\d{4}):\s*([\d.,]+)\(P\)\s*([\d.,]+)\(FP\)', tx)
    if mm:
        for po, v in (('PONTA', mm[2]), ('FORA_PONTA', mm[3])):
            gd['lancamentos'].append({'pagina': 2, 'tipo': 'a_expirar', 'posto': po, 'kwh': num(v), 'mes_ref': None,
                                      'ref_expiracao': f'{mm[1][3:]}-{mm[1][:2]}', 'unidade_impressa': 'kWh',
                                      'rotulo': f'A expirar em {mm[1]}: {v}'})
    for frase in dict.fromkeys(re.findall(r'(Rever\. Isen\. do ICMS .*?\d{15,})', tx)):
        d['mensagens'].append({'pagina': 2, 'texto': frase})
    # indicadores de continuidade (x<160)
    conj = re.search(r'Conjunto:\s*([A-ZÀ-Ú ]+?)\s', ' '.join(_txt(g) for y, g in _grupos([w for w in t2 if w.x0 < 160])))
    refq = re.search(r'Refer\S+ncia:\s*(\d\d/\d{4})', tx)
    for y, g in _grupos([w for w in t2 if w.x0 < 160 and 195 < w.y1 < 240]):
        ws = [w for w in g]
        if ws and ws[0].t in ('DIC', 'FIC', 'DMIC', 'DICRI'):
            c = _col([w for w in ws[1:] if e_numero(w.t)], {'m': 82, 'a': 109, 't': 132, 'n': 157}, 8)
            d['qualidade_servico'].append({'indicador': ws[0].t,
                                           'conjunto': (conj[1].strip() if conj else None),
                                           'periodo_apuracao': f'{refq[1][3:]}-{refq[1][:2]}' if refq else None,
                                           'limite_mensal': num(c.get('m')), 'limite_trimestral': num(c.get('t')),
                                           'limite_anual': num(c.get('n')), 'apurado_mensal': num(c.get('a')),
                                           'apurado_trimestral': None, 'apurado_anual': None})
    # histórico (13 meses)
    anc = {k: x for x, *k_ in HIST for k in [k_[0]]}
    for y, g in _grupos([w for w in t2 if 160 <= w.x0 and 195 < w.y1 < 300], 2.0):
        mes_w = next((w for w in g if re.fullmatch(r'[A-Z]{3}/\d{2}', w.t) and w.x0 < 190), None)
        if not mes_w:
            continue
        mes = mes_ano(mes_w.t)
        nums = [w for w in g if w.x0 > 190 and e_numero(w.t)]
        estrela = {round(w.x0) for w in g if w.t == '*'}
        cols = _col(nums, {rot: x for x, rot, *_ in HIST}, 9)
        for x, rot, serie, posto, un in HIST:
            if rot in cols:
                d['historico'].append({'pagina': 2, 'mes': mes, 'serie': serie, 'posto': posto, 'valor': num(cols[rot]),
                                       'unidade': un, 'unidade_original': un,
                                       'faturado_pela_media': any(abs(e - x) <= 6 for e in estrela),
                                       'colunas_originais': {'MÊS': mes_w.t, **cols}})
    d['historico_formato'] = 'tabela' if d['historico'] else 'ausente'
    # estrutura do consumo (medido × faturado)
    tab = {'pagina': 2, 'nome': 'DADOS DA DEMANDA', 'linhas': []}
    COLS_E = ('ATUAL', 'ANTERIOR', 'K', 'PERDAS (%)', 'FAT. POT.', 'AJ. FAT. POT.', 'MEDIDO', 'FATURADO')
    linhas_e = [(y, g) for y, g in _grupos([w for w in t2 if w.x0 > 178 and 320 < w.y1 < 470], 2.0)
                if len(g) >= 4 and re.fullmatch(r'[A-Z]{2,4}', g[0].t)]
    cheias = [[w.x1 for w in g if e_numero(w.t)] for y, g in linhas_e]
    cheias = [c for c in cheias if len(c) == 8]
    anc_e = {nome: sorted(c[i] for c in cheias)[len(cheias) // 2] for i, nome in enumerate(COLS_E)} if cheias else \
        dict(zip(COLS_E, (278, 318, 343, 388, 428, 472, 511, 551)))
    med_p1 = d['unidade_consumidora']['medidor'][0] if d['unidade_consumidora']['medidor'] else None
    for y, g in linhas_e:
        ws = [w.t for w in g]
        if True:
            gr, po = ws[0], ws[1]
            nums = [w for w in g if e_numero(w.t)]
            ce = _col(nums, anc_e, 9)
            medido, fat = ce.get('MEDIDO'), ce.get('FATURADO')
            d['medicoes'].append({'pagina': 2, 'tabela_origem': 'ESTRUTURA DO CONSUMO', 'medidor': med_p1, 'grandeza': gr,
                                  'posto': _posto(po), 'leitura_anterior': num(ce.get('ANTERIOR')),
                                  'leitura_atual': num(ce.get('ATUAL')), 'constante': num(ce.get('K')),
                                  'perdas_pct': num(ce.get('PERDAS (%)')), 'ajuste': None, 'consumo': num(medido),
                                  'consumo_faturado': num(fat), 'fator_potencia': num(ce.get('FAT. POT.')),
                                  'ajuste_fator_potencia': num(ce.get('AJ. FAT. POT.')),
                                  'unidade': {'KWH': 'kWh', 'INJ': 'kWh', 'KW': 'kW', 'ULTP': 'kW', 'KWTG': 'kW',
                                              'ERE': 'kVArh', 'DRE': 'kVAr'}.get(gr),
                                  'data_hora_registro': None, 'leitura_arredondada': True,
                                  'colunas_originais': {'UN.': gr, 'POSTO': po, **ce}})
            tab['linhas'].append({'colunas_originais': {'grandeza': gr, 'posto': po, 'MEDIDO': medido, 'FATURADO': fat}})
            if gr == 'INJ':
                gd['lancamentos'].append({'pagina': 2, 'tipo': 'injetada', 'posto': _posto(po), 'kwh': num(medido),
                                          'mes_ref': None, 'ref_expiracao': None, 'unidade_impressa': 'kWh',
                                          'rotulo': f'Estrutura do consumo INJ {po} (MEDIDO)'})
            if gr in ('KW', 'KWTG'):
                ger = gr == 'KWTG'
                alvo = next((x for x in d['demanda'] if (x['tipo'] == 'geracao') == ger and
                             (ger or x['posto'] == _posto(po))), None)
                if alvo is None:
                    alvo = {'pagina': 2, 'tipo': 'geracao' if ger else 'consumo', 'posto': 'GERACAO' if ger else _posto(po),
                            'contratada_kw': None, 'medida_kw': None, 'faturada_kw': None,
                            'faturada_ultrapassagem_kw': None, 'nao_consumida_kw': None, 'data_hora': None,
                            'rotulo': f'Estrutura do consumo {gr} {po}', 'colunas_originais': {}}
                    d['demanda'].append(alvo)
                alvo['medida_kw'], alvo['faturada_kw'] = num(medido), num(fat)
            if gr == 'ULTP':
                alvo = next((x for x in d['demanda'] if x['tipo'] == 'consumo' and x['posto'] == _posto(po)), None)
                if alvo:
                    alvo['faturada_ultrapassagem_kw'] = num(fat)
    if tab['linhas']:
        d['tabelas_complementares'].append(tab)
    # medições da p1 × "estrutura do consumo" da p2 (mesma grandeza/posto): perdas e números sobrepostos
    est = {(m['grandeza'], m['posto']): m for m in d['medicoes'] if m['tabela_origem'] == 'ESTRUTURA DO CONSUMO'}
    for m in d['medicoes']:
        if m['tabela_origem'] == 'ESTRUTURA DO CONSUMO':
            continue
        gk = 'INJ' if 'injetada' in (m['grandeza'] or '').lower() else 'KWH'
        e = est.get((gk, m['posto']))
        la, lb, c, cons = m['leitura_anterior'], m['leitura_atual'], m['constante'], m['consumo']
        if None in (la, lb, c):
            continue
        calc = (lb - la) * c
        if cons is not None and abs(calc - cons) <= max(1, abs(cons) * 0.01):
            continue
        if e and e['perdas_pct'] and cons is not None and abs(calc * (1 - e['perdas_pct'] / 100) - cons) <= max(1, cons * 0.01):
            m['perdas_pct'] = e['perdas_pct']  # consumo impresso já com perdas de transformação
            continue
        perdas = [0.0] + ([e['perdas_pct']] if e and e['perdas_pct'] else [])
        if cons is not None and cons > 0:  # dígitos à esquerda escondidos pela constante sobreposta
            n = len(str(int(cons)))
            alvo = next((calc * (1 - p_ / 100) for p_ in perdas
                         if (calc * (1 - p_ / 100) - cons) > 0 and
                         abs((calc * (1 - p_ / 100) - cons) - round((calc * (1 - p_ / 100) - cons) / 10 ** n) * 10 ** n) < 0.02),
                        None)
            if alvo is not None and alvo != calc:
                m['perdas_pct'] = e['perdas_pct']
            calc = alvo if alvo is not None else calc
            dif = calc - cons
            if alvo is not None and dif > 0 and abs(dif - round(dif / 10 ** n) * 10 ** n) < 0.02:
                d['valores_alternativos'].append({'campo': f'medicoes[{m["grandeza"]} {m["posto"]}].consumo',
                                                  'valor': m['colunas_originais'].get('consumo'), 'pagina': 1})
                d['extracao']['observacoes'].append(f'Consumo {m["grandeza"]} {m["posto"]} impresso sobreposto à '
                                                    f'constante; dígitos escondidos repostos por (atual−anterior)×K = '
                                                    f'{round(calc, 6)}')
                m['consumo'] = round(calc, 6)
                continue
        if e and e['consumo'] is not None and abs(calc - e['consumo']) <= max(1, e['consumo'] * 0.001):
            d['valores_alternativos'].append({'campo': f'medicoes[{m["grandeza"]} {m["posto"]}].consumo',
                                              'valor': m['colunas_originais'].get('consumo'), 'pagina': 1})
            d['extracao']['observacoes'].append(f'Consumo {m["grandeza"]} {m["posto"]} sobreposto na p1; usado o '
                                                f'MEDIDO da estrutura do consumo (p2): {e["consumo"]}')
            m['consumo'] = e['consumo']
            m['constante'] = c
    # composição do valor e EUSD
    for y, g in _grupos([w for w in t2 if w.x0 < 180 and 320 < w.y1 < 420], 2.0):
        s = _txt(g)
        mm = re.match(r'(.*?)\s+([\d.]+,\d\d)\s+([\d.]+,\d\d)$', s)
        if mm and not mm[1].startswith('Total'):
            d['composicao_valor'] = d.get('composicao_valor') or []
            d['composicao_valor'].append({'rotulo': mm[1], 'valor': num(mm[2]), 'percentual': num(mm[3])})
    mm = re.search(r'Encargo de Uso do Sistema de Distribui\S+o \(Ref (\d\d/\d{4})\):\s*R\$\s*([\d.,]+)', tx)
    if mm:
        d['encargo_uso_eusd'] = [{'referencia': f'{mm[1][3:]}-{mm[1][:2]}', 'valor': num(mm[2])}]
    mm = re.search(r'Tens\S+o Contratada:\s*(\d+)', tx)
    if mm:
        uc_['tecnico']['tensao_contratada_v'] = num(mm[1])
    mm = re.search(r'Limite Adequado:\s*(\d+) a (\d+)', tx)
    if mm:
        uc_['tecnico']['faixa_adequada'] = f'{mm[1]} a {mm[2]}'


def _pagamento(brutos, d):
    pag = d['pagamento']
    tudo = re.sub(r'\s+', ' ', ' '.join(brutos))
    m = re.search(r'\b(\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14}|\d{11}-\d \d{11}-\d \d{11}-\d \d{11}-\d)\b', tudo)
    pag['linha_digitavel'] = m[1] if m else None
    m = re.search(r'Utilize o C\S+digo:\s*(\S+)', tudo)
    deb = []
    if m:
        deb.append(f'Cadastre sua Fatura em Débito Automático. Utilize o Código: {m[1]}')
    m = re.search(r'DOM\. BANC\.:\s*([\d ]+?)\s+DOM\.', tudo)
    if m:
        deb.append(f'DOM. BANC.: {m[1].strip()}')
    m = re.search(r'(FATURA A SER QUITADA ATRAV\S+S DE D\S+BITO AUTOM\S+TICO).*?NO BANCO (\d{4})', tudo)
    if m:
        deb.append(f'{m[1]} - NO BANCO {m[2]}')
        pag['banco'] = m[2]
        d['mensagens'].insert(0, {'pagina': 1, 'texto': m[1] + ' CONSIDERAR ESTA NOTA FISCAL QUITADA SOMENTE APÓS O EFETIVO DÉBITO'})
    pag['debito_automatico'] = '; '.join(deb) or None
    m = re.search(r'N\S* FATURA .*?(\d{8})\b', tudo)
    pag['numero_fatura'] = m[1] if m else None
    if 'PIX' in tudo:
        pag['pix'] = 'QR Code PIX impresso'
    i = tudo.find('PAGADOR')
    if i >= 0 and not d['titular'].get('cnpj_cpf'):
        cands = re.findall(r'(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2})', tudo[i:i + 400])
        cands = [c for c in cands if c != d['documento'].get('distribuidora_cnpj')]
        if cands:
            d['titular']['cnpj_cpf'] = cands[0]
            if d['titular'].get('cnpj_cpf_mascarado'):
                d['valores_alternativos'].append({'campo': 'titular.cnpj_cpf',
                                                  'valor': d['titular']['cnpj_cpf_mascarado'], 'pagina': 1})
    pag['boleto'] = None
    pag.setdefault('conta_recebedora', None)


def _complementos(t1, pags, brutos, d):
    nf, uc_, ref, pag = d['documento']['nota_fiscal'], d['unidade_consumidora'], d['referencia'], d['pagamento']
    tot_w = next((w for w in t1 if w.t == 'TOTAL:'), None)
    if tot_w:  # reservado ao fisco: texto à direita, logo abaixo do TOTAL
        rf = ' '.join(_txt(g) for y, g in _grupos([w for w in t1 if w.x0 > 310 and tot_w.y1 + 3 < w.y1 < tot_w.y1 + 45]))
        nf['reservado_fisco'] = rf.strip() or None
    if any(w.t == 'SEGUNDA' for w in t1) and any(w.t == 'VIA' for w in t1):
        d['documento']['segunda_via'] = True
        d['outros'].append({'pagina': 1, 'secao_impressa': 'cabeçalho', 'rotulo': 'SEGUNDA VIA', 'valor': 'SEGUNDA VIA'})
    # mês de referência dos itens: explícito na descrição ("11/2025", "mUC 1/2026") ou o mês da fatura
    for it in d['itens']:
        mm = re.search(r'\b(\d{1,2})/(\d{4})\b', it['descricao'] or '')
        it['mes_ref'] = f'{mm[2]}-{int(mm[1]):02d}' if mm and 1 <= int(mm[1]) <= 12 else ref['mes_referencia']
        if 'NAO CONSUMIDA' in sem_acento(it['descricao'] or '').upper() and it['quantidade_faturada'] is not None:
            alvo = next((x for x in d['demanda'] if x['tipo'] == 'consumo' and x['posto'] == it['posto']), None)
            if alvo:
                alvo['nao_consumida_kw'] = it['quantidade_faturada']
    # constantes do medidor (quadro da p1)
    vis = []
    for m in d['medicoes']:
        if m['tabela_origem'].startswith('Medidor') and m['constante'] is not None and m['constante'] not in vis:
            vis.append(m['constante'])
    uc_['tecnico']['constantes'] = [{'grandeza': 'Const Medidor', 'valor': v} for v in vis]
    # tensão contratada / limite adequado (p2: valor impresso antes do rótulo)
    if len(pags) > 1:
        t2 = pags[1][1]
        lab = next((w for w in t2 if w.t == 'Contratada:' and w.x0 < 120), None)
        if lab:
            v = next((w.t for w in t2 if abs(w.y1 - lab.y1) < 3 and w.x0 > lab.x1 and re.fullmatch(r'\d{3,6}', w.t)), None)
            uc_['tecnico']['tensao_contratada_v'] = num(v) if v else None
        lab = next((w for w in t2 if w.t == 'Adequado:' and w.x0 < 120), None)
        if lab:
            vs = [w.t for w in sorted(t2, key=lambda w: w.x0) if abs(w.y1 - lab.y1) < 3 and w.x0 > lab.x1]
            mm = re.match(r'(\d+) a (\d+)', ' '.join(vs))
            uc_['tecnico']['faixa_adequada'] = f'{mm[1]} a {mm[2]}' if mm else None
    # boleto (ficha de compensação): banco, nosso número, documento, espécie, aceite, carteira
    tudo = re.sub(r'\s+', ' ', ' '.join(brutos))
    ld = next((w for w in t1 if re.fullmatch(r'\d{5}\.\d{5}', w.t) and w.y1 > 500), None)
    linha_b = _txt(sorted([w for w in t1 if ld and abs(w.y1 - ld.y1) < 2], key=lambda w: w.x0))
    mm = re.search(r'\b([A-Z]{3,}) (\d{3}) ?-(\d) (\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14})', linha_b)
    tudo_b = _txt(sorted([w for w in t1 if ld and w.y1 > ld.y1 - 5], key=lambda w: (round(w.y1), w.x0)))
    if mm:
        pag['banco'] = f'{mm[1]} {mm[2]}-{mm[3]}'
        pag['linha_digitavel'] = mm[4]
        bol = {'nosso_numero': None, 'numero_documento': None, 'carteira': None, 'especie': None, 'aceite': None,
               'data_documento': None, 'data_processamento': None, 'beneficiario': None,
               'agencia_codigo_beneficiario': None, 'pagador': None, 'local_pagamento': None, 'instrucoes': None}
        m2 = re.search(r'(\d{3}/\d{8}-\d)', tudo_b)
        bol['nosso_numero'] = m2[1] if m2 else None
        m2 = re.search(r'(\d\d/\d\d/\d{4}) (\d{6,}-\d{4}-\d{2}-\d) (\w{1,3}) (\w) (\d\d/\d\d/\d{4})', tudo_b)
        if m2:
            bol['data_documento'], bol['numero_documento'] = data_br(m2[1]), m2[2]
            bol['especie'], bol['aceite'], bol['data_processamento'] = m2[3], m2[4], data_br(m2[5])
        m2 = re.search(r'CARTEIRA ESP\S+CIE QUANTIDADE VALOR (\d{2,3}) R\$', tudo_b) or re.search(r'\b(\d{3}) R\$ ABATIMENTOS', tudo_b)
        bol['carteira'] = m2[1] if m2 else None
        m2 = re.search(r'(PAGAR PREFERENCIALMENTE NO [A-ZÀ-Ú ]+?)\s+\d', tudo_b)
        bol['local_pagamento'] = m2[1] if m2 else None
        m2 = re.search(r'(\d{4}/\d{5}-\d)', tudo_b)
        bol['agencia_codigo_beneficiario'] = m2[1] if m2 else None
        m2 = re.search(r'(ENERGISA [A-ZÀ-Ú -]+? S\.A\.)\s+(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})', tudo_b)
        bol['beneficiario'] = f'{m2[1]} CNPJ {m2[2]}' if m2 else None
        m2 = re.search(r'PAGADOR CPF/CNPJ (.*?) (\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2})(.*?)SACADOR', tudo_b)
        bol['pagador'] = re.sub(r'\s+', ' ', f'{m2[1]} {m2[2]}{m2[3]}').strip() if m2 else None
        m2 = re.search(r'(OS VALORES DA MULTA/JUROS .*?FATURA\.)', tudo_b)
        bol['instrucoes'] = m2[1] if m2 else None
        pag['boleto'] = bol
