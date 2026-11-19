"""Parser determinístico das faturas EDP (SP e ES) — DANF3E A4, 3–4 páginas.

p1: emitente, bandeira, titular, instalação/código, classificação, tensão e horário de ponta, datas, NF3e,
referência, itens com código (colunas calibradas pelos números), tributos (PIS/COFINS com linhas negativas da
compensação), grandezas contratadas, TOTAL, histórico de 13 meses (ponto decimal); p2: leituras e boleto;
p3: informações de micro e minigeração, detalhes de faturamento (TUSD/TE sem tributos) e tarifas.
"""
import re

from base import data_br, e_numero, esqueleto, linhas, mes_ano, num, palavras, sem_acento

NOME = 'edp_v1'
CNPJS = {'02.302.100/0001-06': 'EDP SP', '28.152.650/0001-71': 'EDP ES'}


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


def _fmt_cnpj(c):
    c = re.sub(r'\D', '', c or '')
    return f'{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:]}' if len(c) == 14 else None


def detecta(texto, doc=None):
    return bool(re.search(r'EDP (SP|ES|ESPIRITO|ESPÍRITO)', texto.upper())) and \
        bool(re.search(r'\b\d{44}\b', texto.replace(' ', '')))


def _posto(t):
    d = ' ' + sem_acento(t).upper().replace('.', ' ') + ' '
    if re.search(r' (FPONTA|F PONTA|FORA PONTA) ', d):
        if re.search(r' CAP(ACITIVA)? ', d) or 'RESERVADO' in d:
            return 'RESERVADO'
        return 'FORA_PONTA'
    if 'RESERVADO' in d:
        return 'RESERVADO'
    if re.search(r' (PONTA|PT) ', d):
        return 'PONTA'
    return None


def componente_de(desc):
    d = sem_acento(desc).upper()
    if 'INJ' in d:
        return ('BANDEIRA', _posto(d) or 'TODOS') if 'BANDEIRA' in d else ('GD_INJETADA', _posto(d))
    if 'GERACAO' in d:
        return 'DEMANDA_GERACAO', 'GERACAO'
    if 'ULTRAP' in d:
        return 'DEMANDA_ULTRAPASSAGEM', _posto(d) or 'UNICO'
    if 'REAT' in d or 'DMCR' in d or 'ERE' in d.split():
        return 'REATIVO_EXCEDENTE', _posto(d)
    if 'DEMANDA' in d:
        return 'DEMANDA', _posto(d) or (None if 'UTILIZADA' in d else 'UNICO')
    if 'BANDEIRA' in d:
        return 'BANDEIRA', _posto(d) or 'TODOS'
    if d.startswith('TUSD'):
        return 'TUSD', _posto(d)
    if d.startswith('TE '):
        return 'TE', _posto(d)
    if 'CIP' in re.split(r'[\s-]+', d) or 'ILUM' in d:
        return 'ILUMINACAO_PUBLICA', None
    if 'MULTA' in d:
        return 'MULTA', None
    if 'JUROS' in d:
        return 'JUROS', None
    if 'ATUALIZ' in d or 'CORRECAO' in d or 'IPCA' in d or 'IGP' in d:
        return 'ATUALIZACAO_MONETARIA', None
    if re.search(r'\b(DIC|FIC|DMIC|DICRI)\b', d):
        return 'COMPENSACAO_CONTINUIDADE', None
    if 'PARCEL' in d:
        return 'PARCELAMENTO', None
    if 'DEVOL' in d or 'ESTORNO' in d or 'RESTITUI' in d:
        return 'ESTORNO', None
    if 'ENERGIA' in d or 'CONSUMO' in d:
        return 'CONSUMO', _posto(d)
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
    em = [l.texto(125, 400).strip() for l in ls if l.y < 80 and l.entre(125, 400)]
    if em:
        doc_['distribuidora'] = em[0]
        mm = re.search(r'CNPJ:\s*(\d{14})', ' '.join(em))
        doc_['distribuidora_cnpj'] = _fmt_cnpj(mm[1]) if mm else None
        mm = re.search(r'INSC\.ESTADUAL:\s*(\S+)', ' '.join(em))
        doc_['distribuidora_ie'] = mm[1] if mm else None
        doc_['distribuidora_endereco'] = ' '.join(x for x in em[1:] if not x.startswith(('CNPJ', 'INSC'))) or None
    mm = re.search(r'\b(\d{44})\b', tj.replace(' ', ' '))
    nf['chave_acesso'] = mm[1] if mm else None
    if not doc_['distribuidora_cnpj'] and nf['chave_acesso']:
        doc_['distribuidora_cnpj'] = _fmt_cnpj(nf['chave_acesso'][6:20])
    doc_['distribuidora_sigla'] = CNPJS.get(doc_['distribuidora_cnpj'], 'OUTRA')
    nf['modelo'] = 'DANF3E'
    # bandeira "VERMELHA 2 : 01/09/2025 a 30/09/2025 - 30 dias"
    for mm in re.finditer(r'(VERDE|AMARELA|VERMELHA|ESCASSEZ)\s*(\d)?\s*:\s*(\d\d/\d\d/\d{4})\s*a\s*(\d\d/\d\d/\d{4})\s*-\s*(\d+)\s*dias',
                          ' '.join(_txt(g) for y, g in _grupos([w for w in t1 if w.x0 > 440 and w.y1 < 140], 9))):
        cor = mm[1] + (f'_{mm[2]}' if mm[1] == 'VERMELHA' else '')
        d['bandeiras'].append({'pagina': 1, 'cor': cor, 'inicio': data_br(mm[3]), 'fim': data_br(mm[4]),
                               'dias': int(mm[5])})
    g = lambda rx: (re.search(rx, tj) or [None, None])[1]
    uc_['uc'] = g(r'N\S+MERO DA UC:\s*(\S+)') or g(r'INSTALA\S+O:\s*(\S+)') or \
        next((w.t for w in t1 if re.fullmatch(r'\d(?:\.\d{3}){4}-\d{2}', w.t)), None)
    if not uc_['uc']:  # modelo 2026: número da UC/instalação solto no canto superior direito
        uc_['uc'] = next((w.t for w in t1 if re.fullmatch(r'\d{10}', w.t) and w.x0 > 340 and 100 < w.y1 < 130), None)
    uc_['instalacao'] = g(r'INSTALA\S+O:\s*(\S+)') or uc_['uc']
    tit['codigo_cliente'] = g(r'COD\.\s*IDENT\.?:?\s*(\d+)')
    uc_['roteiro_leitura'] = g(r'ROTEIRO DE LEITURA:\s*(\S+)') or g(r'Roteiro de leitura:\s*(\S+)')
    mm = re.search(r'COD\. FISCAL:\s*(\d{4})', tj)
    nf['cfop'] = mm[1] if mm else None
    # classificação (A / A4 / VERDE / COMERCIAL / TRIFÁSICO), tensão, horário de ponta
    cl = [l for l in ls if 175 < l.y < 215]
    cls = ' '.join(l.texto(40, 330) for l in cl)
    mm = re.search(r'\b([AB])\s+([AB]\d\w?)\s+(VERDE|AZUL|CONVENCIONAL|BRANCA)?', cls)
    if mm:
        uc_['grupo'], uc_['subgrupo'] = mm[1], mm[2]
        uc_['modalidade_tarifaria'] = mm[3].capitalize() if mm[3] else None
        uc_['tipo_tarifa_impresso'] = mm[3]
    mm = re.search(r'(COMERCIAL|INDUSTRIAL|RESIDENCIAL|RURAL|PODER P\S+|SERVI\S+ P\S+)', cls)
    uc_['classe'] = mm[1] if mm else None
    mm = re.search(r'(MONOF\S+|BIF\S+|TRIF\S+)', cls)
    uc_['tipo_fornecimento'] = mm[1] if mm else None
    tec = {'tensao_nominal': None, 'tensao_contratada_v': None, 'tensao_fornecimento_kv': None, 'tensao_minima': None,
           'tensao_maxima': None, 'faixa_adequada': None, 'fator_potencia_referencia': None, 'rtc': None, 'rtp': None,
           'constantes': [], 'perdas_transformacao_pct': None, 'horario_ponta': None, 'equipamento_medidor': None,
           'responsavel_iluminacao_publica': None}
    dir_ = ' '.join(l.texto(440, 600) for l in cl)
    mm = re.search(r'([\d.]+)\s*V\b', dir_)
    tec['tensao_contratada_v'] = num(mm[1]) if mm else None
    mm = re.search(r'(\d\d:\d\d:\d\d)\s*A\s*(\d\d:\d\d:\d\d)', dir_)
    tec['horario_ponta'] = f'{mm[1]} A {mm[2]}' if mm else None
    uc_['tecnico'] = tec
    # datas de leitura (linha com UC + 4 datas)
    mm = re.search(r'(\d\d/\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+(\d{1,3})\s+(\d\d/\d\d/\d{4})', tj)
    if mm:
        ref.update({'leitura_anterior': data_br(mm[1]), 'leitura_atual': data_br(mm[2]), 'dias_faturados': int(mm[3]),
                    'proxima_leitura': data_br(mm[4])})
    _titular(ls, d)
    tn = ' '.join(l.texto(340, 600) for l in ls if 245 < l.y < 315)
    mm = re.search(r'NOTA FISCAL N\S*?\s*(\d[\d.]{4,})', tn)
    nf['numero'] = mm[1] if mm else None
    mm = re.search(r'S\S*RIE\s+(\S+(?: \S+)?)\s+DATA', tn)
    nf['serie'] = mm[1] if mm else None
    mm = re.search(r'EMISS\S+:\s*(\d\d/\d\d/\d{4})', tn)
    if mm:
        nf['data_emissao'] = ref['data_emissao'] = data_br(mm[1])
    mm = re.search(r'(https?://\S+)', tn)
    nf['url_consulta'] = mm[1] if mm else None
    tn = tn + ' ' + ' '.join(l.texto(340, 600) for l in ls if 315 <= l.y < 330)
    mm = re.search(r'Protocolo de autoriza\S*:?\s*(\d+)\s*-\s*(\d\d/\d\d/\d{4})\s*\S+\s*(\d\d:\d\d:\d\d)', tn)
    if mm:
        nf['protocolo_autorizacao'], nf['data_autorizacao'] = mm[1], f'{data_br(mm[2])}T{mm[3]}'
    meses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro',
             'Novembro', 'Dezembro']
    mm = re.search(r'(' + '|'.join(meses) + r')/(\d{4})\s+(\d\d/\d\d/\d{4})\s+(?:R\$\s*)?([\d.]+,\d\d)', tj)
    if mm:
        ref['mes_referencia'] = f'{mm[2]}-{meses.index(mm[1]) + 1:02d}'
        ref['data_vencimento'] = data_br(mm[3])
        tot['total_a_pagar'] = num(mm[4])
    # avisos (faixa entre a referência e os itens)
    yr = next((l.y for l in ls if re.search(r'(' + '|'.join(meses) + r')/\d{4}', l.texto())), 300)
    yi = next((w.y1 for w in t1 if re.fullmatch(r'0\d{3}', w.t) and w.x0 < 60), 420)
    bloco = ' '.join(l.texto(0, 455) for l in ls if yr + 5 < l.y < yi - 8)
    for parte in re.split(r'(?<=\.)\s+(?=[A-ZÀ-Ú])', bloco):
        if len(parte.strip()) > 20:
            d['mensagens'].append({'pagina': 1, 'texto': parte.strip()})
    _itens_paginas(pags, d, yi)
    _direita(t1, d, yi)
    _historico(t1, d)
    # leituras (+ boleto) e quadro de micro/minigeração: a página varia (3 págs: p2/p3; 4 págs: p3/p4)
    pl = _pag_leituras(pags)
    if pl is not None:
        _pagina2(pags[pl - 1][1], brutos[pl - 1], d, pl)
    pg = next((np_ for np_, b in zip((p for p, _ in pags), brutos) if np_ > 1 and 'MINIGERA' in b.upper()), None)
    if pg is None and len(pags) > 2:
        pg = 3
    if pg is not None:
        _pagina3(pags[pg - 1][1], d, pg)
    _aliquota_icms_unica(d)
    d.pop('_anc', None)
    ilum = [i['valor'] for i in d['itens'] if i['componente'] == 'ILUMINACAO_PUBLICA' and i['valor'] is not None]
    tot['valor_cosip_cip'] = round(sum(ilum), 2) if ilum else None
    uc_['geracao']['e_gerador'] = any(i['componente'] in ('DEMANDA_GERACAO', 'GD_INJETADA') for i in d['itens'])
    for it in d['itens']:
        mm = re.search(r'\b(\d\d)/(\d{4})\b', it['descricao'] or '')
        it['mes_ref'] = f'{mm[2]}-{mm[1]}' if mm else ref['mes_referencia']
    return d


def _titular(ls, d):
    tit, uc_ = d['titular'], d['unidade_consumidora']
    yf = next((w.y1 for l in ls for w in l.p if re.match(r'(MONOF|BIF|TRIF)', w.t) and w.x0 < 140), 199)
    yie = next((w.y1 for l in ls for w in l.p if w.t == 'IE:' and w.x0 < 60 and w.y1 > yf), 270)
    bl = [l.texto(30, 190).strip() for l in ls if yf + 5 < l.y <= yie + 1 and l.entre(30, 190)]
    bl = [x for x in bl if x]
    if not bl:
        return
    tit['nome'] = bl[0]
    end = []
    for x in bl[1:]:
        mm = re.match(r'CEP:\s*(\S+)', x)
        if mm:
            tit['cep'] = mm[1]
            continue
        mm = re.match(r'CNPJ:\s*(\S+)|CPF:\s*(\S+)', x)
        if mm:
            tit['cnpj_cpf'] = mm[1] or mm[2]
            continue
        mm = re.match(r'IE:\s*(\S+)', x)
        if mm:
            tit['inscricao_estadual'] = mm[1]
            continue
        end.append(x)
    if end:
        mm = re.match(r'(.*?)\s*-\s*([A-Z]{2})$', end[-1]) or re.match(r'(?:(\d{5}-\d{3})\s+)?(.*?)\s+([A-Z]{2})$', end[-1])
        if mm and mm.re.groups == 2:
            tit['cidade'], tit['uf'] = mm[1].strip(), mm[2]
            end = end[:-1]
        elif mm:
            tit['cep'] = tit.get('cep') or mm[1]
            tit['cidade'], tit['uf'] = mm[2].strip(), mm[3]
            end = end[:-1]
        tit['endereco'] = re.sub(r',(\d)', r' \1', ' '.join(end))
    uc_['endereco'] = ' '.join(bl[1:]).split(' CNPJ:')[0]


def _itens_paginas(pags, d, yi):
    for np_, t in pags[:3]:
        if np_ == 1:
            y0 = yi
        else:  # continuação: abaixo do cabeçalho "CCI Descrição …" (ou da 1ª linha com código)
            cci = next((w.y1 for w in t if w.t == 'CCI' and w.x0 < 60), None)
            y0 = (cci + 9) if cci else min((w.y1 for w in t if re.fullmatch(r'0\d{3}', w.t) and w.x0 < 60), default=None)
        if y0 is None:
            break
        if _itens(t, d, y0, np_):
            break


def _itens(t1, d, yi, np_=1):
    tot_w = next((w for w in t1 if w.t == 'TOTAL' and w.x0 < 80 and w.y1 > yi), None)
    y_fim = tot_w.y1 + 1 if tot_w else 600
    ws = [w for w in t1 if yi - 3 < w.y1 < y_fim and w.x0 < 458]
    un_x = min((w.x0 for w in ws if re.fullmatch(r'kWh|kW|KWH|KW|kVArh|kVAr', w.t) and 150 < w.x0 < 215), default=195)
    x1s = sorted(w.x1 for w in ws if w.x0 > un_x + 12 and e_numero(w.t))
    grp = []
    for x in x1s:
        if grp and x - grp[-1][-1] <= 8:
            grp[-1].append(x)
        else:
            grp.append([x])
    grp = [g_ for g_ in grp if len(g_) >= 2]
    nomes = ('quant', 'preco', 'valor', 'pis_cofins', 'base_icms', 'aliquota_icms', 'icms', 'tarifa')
    if len(grp) == 8:
        anc = {k: sorted(g_)[len(g_) // 2] for k, g_ in zip(nomes, grp)}
        d['_anc'] = anc
    else:  # página com poucas linhas (continuação): colunas da página 1
        anc = d.get('_anc') or dict(zip(nomes, (241, 273, 304, 339, 374, 394, 425, 457)))
    tot = d['totais']
    for y, g in _grupos(ws):
        cod = g[0].t if re.fullmatch(r'\d{4}', g[0].t) and g[0].x0 < 60 else None
        unid = next((w.t for w in g if re.fullmatch(r'kWh|kW|KWH|KW|kVArh|kVAr', w.t) and 150 < w.x0 < 215), None)
        desc = _txt([w for w in g if w.x0 < un_x - 2 and w.t != cod])
        nums = [w for w in g if w.x0 > un_x + 12 and e_numero(w.t)]
        cols = _col(nums, anc)
        if desc == 'TOTAL':
            rot = {'valor': 'Valor Total R$', 'pis_cofins': 'PIS/COFINS', 'base_icms': 'Base Cálc. ICMS (R$)',
                   'aliquota_icms': 'Alíquota ICMS', 'icms': 'ICMS (R$)'}
            for k, v in cols.items():
                if k in rot:
                    tot['totais_colunas'].append({'pagina': 1, 'coluna': rot[k], 'valor': num(v)})
            tot['total_nota_fiscal'] = num(cols.get('valor'))
            continue
        if not desc or not nums:
            continue
        comp, posto = componente_de(desc)
        d['itens'].append({'pagina': np_, 'secao_impressa': 'Detalhes do Faturamento', 'codigo': cod, 'descricao': desc,
                           'mes_ref': None, 'componente': comp, 'posto': posto, 'quantidade_registrada': None,
                           'quantidade_faturada': num(cols.get('quant')), 'unidade': unid,
                           'tarifa_com_tributos': num(cols.get('preco'), ponto_decimal=True),
                           'tarifa_sem_tributos': num(cols.get('tarifa'), ponto_decimal=True),
                           'valor': num(cols.get('valor')), 'valor_sem_tributos': None,
                           'base_icms': num(cols.get('base_icms')), 'aliquota_icms': num(cols.get('aliquota_icms')),
                           'icms': num(cols.get('icms')), 'base_pis_cofins': None, 'aliquota_pis': None, 'pis': None,
                           'aliquota_cofins': None, 'cofins': None, 'pis_cofins': num(cols.get('pis_cofins')),
                           'nf_referencia': None, 'colunas_originais': {'Código': cod, 'Descrição': desc, 'Unid.': unid, **cols}})
    return tot_w is not None


def _direita(t1, d, yi):
    tab = {'pagina': 1, 'nome': 'Grandezas Contratadas', 'linhas': []}
    for y, g in _grupos([w for w in t1 if w.x0 >= 458 and yi - 10 < w.y1 < 560]):
        s = _txt(g)
        # 2ª linha de PIS/COFINS (compensação): tudo com sufixo '-', inclusive a alíquota ("0.62-")
        mm = re.match(r'(PIS|COFINS|ICMS)\s+(-?[\d.,]+-?)\s+(-?[\d.,]+-?)\s+(-?[\d.,]+-?)$', s)
        if mm:
            d['tributos'].append({'pagina': 1, 'tributo': mm[1], 'base': num(mm[2]), 'aliquota': num(mm[3], ponto_decimal=True),
                                  'valor': num(mm[4]), 'retido': False,
                                  'colunas_originais': {'Tributo': mm[1], 'Base': mm[2], 'Alíquota': mm[3], 'Valor': mm[4]}})
            continue
        mm = re.match(r'(Demanda Contratual.*?)\s*-\s*([\d.,]+)$', s)
        if mm:
            tab['linhas'].append({'colunas_originais': {mm[1]: mm[2]}})
    if tab['linhas']:
        d['tabelas_complementares'].append(tab)
    icms = next((x['valor'] for x in d['totais']['totais_colunas'] if x['coluna'] == 'ICMS (R$)'), None)
    if icms is not None:
        b = next((x['valor'] for x in d['totais']['totais_colunas'] if x['coluna'] == 'Base Cálc. ICMS (R$)'), None)
        a = next((x['valor'] for x in d['totais']['totais_colunas'] if x['coluna'] == 'Alíquota ICMS'), None)
        d['tributos'].append({'pagina': 1, 'tributo': 'ICMS', 'base': b, 'aliquota': a, 'valor': icms, 'retido': False,
                              'colunas_originais': {}})


# histórico (p1, rodapé): borda direita das colunas → (série, posto, unidade)
HIST = [(113, 'consumo', 'PONTA', 'kWh'), (164, 'consumo', 'FORA_PONTA', 'kWh'), (207, 'consumo', 'RESERVADO', 'kWh'),
        (244, 'demanda', 'PONTA', 'kW'), (295, 'demanda', 'FORA_PONTA', 'kW'), (332, 'demanda_ultrapassagem', 'PONTA', 'kW'),
        (382, 'demanda_ultrapassagem', 'FORA_PONTA', 'kW'), (416, 'reativo_dre', 'PONTA', 'kVAr'),
        (468, 'reativo_dre', 'FORA_PONTA', 'kVAr'), (504, 'reativo_ere', 'TODOS', 'kVArh'), (553, 'total_fatura', None, 'R$')]


def _historico(t1, d):
    for y, g in _grupos([w for w in t1 if w.y1 > 640]):
        if not re.fullmatch(r'\d\d/\d\d', g[0].t) or g[0].x0 > 60:
            continue
        mes = f'20{g[0].t[3:]}-{g[0].t[:2]}'
        cols = _col([w for w in g[1:] if e_numero(w.t)], {i: x for i, (x, *_) in enumerate(HIST)}, 10)
        for i, v in cols.items():
            x, serie, posto, un = HIST[i]
            d['historico'].append({'pagina': 1, 'mes': mes, 'serie': serie, 'posto': posto,
                                   'valor': num(v, ponto_decimal=serie != 'total_fatura'), 'unidade': un,
                                   'unidade_original': un, 'faturado_pela_media': False})
    d['historico_formato'] = 'tabela' if d['historico'] else 'ausente'


def _medidor(w):
    return re.fullmatch(r'\d{7,9}', w.t) and 150 < w.x0 < 215


def _pag_leituras(pags):
    """Página do quadro de leituras (sem cabeçalho de itens 'CCI'): linhas com nº do medidor na coluna
    própria ou as linhas 'Demanda Contratada'. Sem achar, a 2ª página (layout de 3 páginas)."""
    for np_, t in pags[1:]:
        if any(w.t == 'CCI' and w.x0 < 60 for w in t):
            continue
        if sum(1 for w in t if 200 < w.y1 < 540 and _medidor(w)) >= 2 or \
                any(w.t == 'Contratada' and w.x0 < 120 and 200 < w.y1 < 540 for w in t):
            return np_
    return 2 if len(pags) > 1 else None


def _aliquota_icms_unica(d):
    """Quadro de tributos sem alíquota de ICMS: a alíquota é impressa por item; se todos os itens com
    base de ICMS trazem a mesma, ela é a alíquota do tributo (impressa, não calculada)."""
    for tr in d['tributos']:
        if tr['tributo'] != 'ICMS' or tr['aliquota'] is not None:
            continue
        als = {i['aliquota_icms'] for i in d['itens'] if i.get('base_icms') and i.get('aliquota_icms')}
        if len(als) == 1:
            tr['aliquota'] = als.pop()


def _pagina2(t2, b2, d, np_=2):
    uc_ = d['unidade_consumidora']
    vis = {}
    for y, g in _grupos([w for w in t2 if 200 < w.y1 < 540]):
        med = next((w for w in g if _medidor(w)), None)
        s = _txt([w for w in g if w.x0 < 155 and w is not med])
        nums = [w for w in g if w.x0 > 240 and re.match(r'-?[\d.,]+(KWH|KVH|KW)?$', w.t)]
        if not s or len(nums) < 3:
            continue
        cons_t = nums[-1].t
        mu = re.match(r'(-?[\d.,]+)\s*(KWH|KVH|KW)?$', cons_t.replace(' ', ''))
        un = (mu[2] if mu and mu[2] else next((w.t for w in g if w.t in ('KW', 'KWH', 'KVH')), None))
        cons = num(mu[1]) if mu else None
        if len(nums) >= 4:  # colunas na ordem impressa: anterior, atual, constante, consumo
            la, lb, k = nums[-4].t, nums[-3].t, nums[-2].t
        else:
            la = next((w.t for w in nums if w.x1 < 300), None)
            lb = next((w.t for w in nums if 320 < w.x1 < 380), None)
            k = next((w.t for w in nums if 430 < w.x1 < 480), None)
        if s.startswith('Demanda Contratada') or s.startswith('Demanda Registrada'):
            ger = 'Geração' in s or 'TUSDG' in s
            val = cons_t
            d['medicoes'].append({'pagina': np_, 'tabela_origem': 'DETALHES DE LEITURA', 'medidor': None, 'grandeza': s,
                                  'posto': 'GERACAO' if ger else None,
                                  'leitura_anterior': num(la), 'leitura_atual': num(lb), 'constante': num(k),
                                  'perdas_pct': None, 'ajuste': None,
                                  'consumo': num(re.sub(r',(?=\d{3},)', '', re.sub(r'[A-Z]+$', '', val))),
                                  'consumo_faturado': None, 'fator_potencia': None, 'ajuste_fator_potencia': None,
                                  'unidade': 'kW', 'data_hora_registro': None, 'leitura_arredondada': True,
                                  'colunas_originais': {'Descrição': s, 'Anterior': la, 'Atual': lb, 'Constante': k,
                                                        'Valor': val}})
            if ger:
                alvo = next((x for x in d['demanda'] if x['tipo'] == 'geracao'), None)
                if alvo is None:
                    alvo = {'pagina': np_, 'tipo': 'geracao', 'posto': 'GERACAO', 'contratada_kw': None, 'medida_kw': None,
                            'faturada_kw': None, 'faturada_ultrapassagem_kw': None, 'nao_consumida_kw': None,
                            'data_hora': None, 'rotulo': 'Demanda Contratada Geração / Demanda Registrada Inj.TUSDG',
                            'colunas_originais': {}}
                    d['demanda'].append(alvo)
                v = num(re.sub(r',(?=\d{3},)', '', val))  # "2,419,2000" impresso com duas vírgulas
                if s.startswith('Demanda Registrada'):
                    alvo['medida_kw'] = v
                else:
                    alvo['contratada_kw'] = v
                alvo['colunas_originais'][s] = f'{val} KW'
            else:
                d['demanda'].append({'pagina': np_, 'tipo': 'consumo', 'posto': None, 'contratada_kw': num(val),
                                     'medida_kw': None, 'faturada_kw': None, 'faturada_ultrapassagem_kw': None,
                                     'nao_consumida_kw': None, 'data_hora': None, 'rotulo': 'Demanda Contratada',
                                     'colunas_originais': {'Demanda Contratada': f'{val} KW'}})
            continue
        if not med:
            continue
        gr = re.sub(r'\s+(Ponta|F\s*Ponta|FPonta|Fora Ponta|Reservado).*$', '', s).strip()
        d['medicoes'].append({'pagina': np_, 'tabela_origem': 'DETALHES DE LEITURA', 'medidor': med.t, 'grandeza': gr,
                              'posto': _posto(s), 'leitura_anterior': num(la), 'leitura_atual': num(lb),
                              'constante': num(k), 'perdas_pct': None, 'ajuste': None, 'consumo': cons,
                              'consumo_faturado': None, 'fator_potencia': None, 'ajuste_fator_potencia': None,
                              'unidade': {'KWH': 'kWh', 'KW': 'kW', 'KVH': 'kVArh'}.get(un, un),
                              'data_hora_registro': None, 'leitura_arredondada': False,
                              'colunas_originais': {'Descrição': s, 'Medidor': med.t, 'Anterior': la, 'Atual': lb,
                                                    'Constante': k, 'Consumo': cons_t}})
        if med.t not in uc_['medidor']:
            uc_['medidor'].append(med.t)
        if k:
            vis.setdefault('Demanda Máxima' if 'Máxima' in s else 'Energia ativa/reativa/injetada, DMCR, ERE', num(k))
    uc_['tecnico']['constantes'] = [{'grandeza': k, 'valor': v} for k, v in vis.items()]
    for it in d['itens']:
        if 'NAO UTILIZADA' in sem_acento(it['descricao']).upper():
            alvo = next((x for x in d['demanda'] if x['tipo'] == 'consumo'), None)
            if alvo:
                alvo['nao_consumida_kw'] = it['quantidade_faturada']
        if it['componente'] == 'DEMANDA_GERACAO':
            alvo = next((x for x in d['demanda'] if x['tipo'] == 'geracao'), None)
            if alvo:
                alvo['faturada_kw'] = it['quantidade_faturada']
    # boleto
    tx = re.sub(r'\s+', ' ', b2)
    pag = d['pagamento']
    mm = re.search(r'(BANCO [A-Z ]+?)\s+(\d{3}-\d)\s+(\d{47,48})', tx)
    if mm:
        pag['banco'], pag['linha_digitavel'] = f'{mm[1]} {mm[2]}', mm[3]
        bol = {'nosso_numero': None, 'numero_documento': None, 'carteira': None, 'especie': None, 'aceite': None,
               'data_documento': None, 'data_processamento': None, 'beneficiario': None,
               'agencia_codigo_beneficiario': None, 'pagador': None, 'local_pagamento': None, 'instrucoes': None}
        m2 = re.search(r'(PAGUE PREFERENCIALMENTE NO [A-ZÀ-Ú]+)', tx)
        bol['local_pagamento'] = m2[1] if m2 else None
        m2 = re.search(r'(EDP [A-Z ]+?)\s+CNPJ\s+(\d{14})\s+(\d{4}/\d{5}-\d)', tx)
        if m2:
            bol['beneficiario'], bol['agencia_codigo_beneficiario'] = f'{m2[1]} CNPJ {m2[2]}', m2[3]
        m2 = re.search(r'\b(DM|DS|FAT)\s+(\w)\s+(\d\d/\d\d/\d{4})\s+(\d{3}/\d{8}-\d)', tx)
        if m2:
            bol['especie'], bol['aceite'], bol['data_documento'], bol['nosso_numero'] = m2[1], m2[2], data_br(m2[3]), m2[4]
        m2 = re.search(r'\b(\d{3})\s+R\$\s+[\d.]+,\d\d', tx)
        bol['carteira'] = m2[1] if m2 else None
        m2 = re.search(r'(Todas informa\S+es deste bloqueto.*?COMPENSA\S+O\.)', tx)
        bol['instrucoes'] = m2[1] if m2 else None
        nome = d['titular'].get('nome')
        if nome and nome in tx:
            i = tx.rfind(nome)
            m2 = re.match(r'(.{0,200}?[A-Z]{2})(?:\s|$)', tx[i:])
            bol['pagador'] = m2[1] if m2 else None
        pag['boleto'] = bol
    if 'Pix' in tx or 'PIX' in tx:
        pag['pix'] = 'QR Code Pague com Pix impresso (conteúdo não legível como texto)'
    pag.setdefault('conta_recebedora', None)
    if 'Agradecemos a pontualidade' in tx:
        d['mensagens'].append({'pagina': np_, 'texto': 'Agradecemos a pontualidade no pagamento'})


GD_POSTO = r'(Ponta|Fora Ponta(?: Cap\.| Ind\.)?|Reservado)'
GD_VALOR = r'\s+(\d[\d.]*,\d+)\s*(kWh|kW|k)?$'  # a coluna corta a unidade: "651289,2750k", "16404,5280kW"


def _pagina3(t3, d, np_=3):
    gd = d['gd']
    for y, g in _grupos(t3):
        s = _txt(g)
        mm = re.match(r'(Energia Injetada ' + GD_POSTO + r' no m\S+s)' + GD_VALOR, s)
        if mm:
            gd['lancamentos'].append({'pagina': np_, 'tipo': 'injetada', 'posto': _posto(mm[2]),
                                      'kwh': num(mm[3], ponto_decimal=True), 'mes_ref': None, 'ref_expiracao': None,
                                      'unidade_impressa': mm[4] or None, 'rotulo': mm[1]})
            continue
        mm = re.match(r'(Saldo (' + GD_POSTO[1:-1] + r'|Total)(?: Atualizado no m\S+s)?)' + GD_VALOR, s)
        if mm:
            gd['lancamentos'].append({'pagina': np_, 'tipo': 'saldo_atual',
                                      'posto': 'TODOS' if mm[2] == 'Total' else _posto(mm[2]),
                                      'kwh': num(mm[3], ponto_decimal=True), 'mes_ref': None, 'ref_expiracao': None,
                                      'unidade_impressa': mm[4] or None, 'rotulo': mm[1]})
            continue
        mm = re.match(r'Participa\S+o no Saldo\s+([\d.,]+)%$', s)
        if mm:
            gd['participacao_pct'] = num(mm[1])
            continue
        mm = re.match(r'(Tarifa (?:ANEEL|aplicada para o SCEE) TUSD/TE (Ponta|FPonta))\s+([\d,]+)\s+([\d,]+)$', s)
        if mm:
            for comp, v in (('TUSD', mm[3]), ('TE', mm[4])):
                d['tarifas'].append({'pagina': np_, 'rotulo': mm[1], 'componente': comp, 'posto': _posto(mm[2]),
                                     'valor': num(v), 'unidade': 'R$/kWh',
                                     'tipo': 'aneel' if 'ANEEL' in mm[1] else 'scee'})
    lin = []
    y_tar = min((w.y1 for w in t3 if w.t == 'Tarifa' and w.x0 < 60 and w.y1 > 260), default=365)
    for y, g in _grupos([w for w in t3 if 260 < w.y1 < y_tar - 3]):
        s = _txt(g)
        if re.search(r'\d,\d{2}-?$', s):
            lin.append({'colunas_originais': {'linha': s}})
    if lin:
        d['tabelas_complementares'].append({'pagina': np_, 'nome': 'DETALHES DE FATURAMENTO', 'linhas': lin})
