"""Parser determinístico das faturas Neoenergia (Cosern, Brasília, Coelba, Pernambuco, Elektro) — DANFE NF3e A4.

p1: emitente, cliente (nome/CNPJ mascarado/endereço), código da instalação e do cliente, NF3e, referência/total/
vencimento, classificação, fornecimento, datas de leitura, itens (cabeçalho em texto; descrição e números podem
ficar em linhas a 1 pt), tributos e grandezas contratadas (direita), TOTAL, medições, avisos e informações
importantes (demanda injetada, saldo de créditos, energia alocada), boleto/PIX/débito automático.
"""
import re

from base import data_br, e_numero, esqueleto, linhas, mes_ano, num, palavras, sem_acento

NOME = 'neoenergia_v1'
CNPJS = {'08.324.196/0001-81': 'NEOENERGIA COSERN', '07.522.669/0001-92': 'NEOENERGIA BRASILIA',
         '15.139.629/0001-94': 'NEOENERGIA COELBA', '10.835.932/0001-08': 'NEOENERGIA PE',
         '02.328.280/0001-97': 'NEOENERGIA ELEKTRO'}
MES3 = r'(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)'


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


def _cnpj(ch):
    c = ch[6:20]
    return f'{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:]}'


def detecta(texto, doc=None):
    ch = _chave(texto)
    return 'ITENS DA FATURA' in texto and ((bool(ch) and _cnpj(ch) in CNPJS) or 'neoenergia' in texto.lower())


def _posto(t):
    d = ' ' + sem_acento(t).upper().replace('.', ' ').replace('-', ' ') + ' '
    d = re.sub(r' (NP|FP)(TUSD|TE) ', r' \1 \2 ', d)
    if re.search(r' (F ?PONTA|FPONTA|FORA (DE )?PONTA|FP) ', d):
        return 'FORA_PONTA'
    if re.search(r' (N ?PONTA|NPONTA|NA PONTA|PONTA|NP|P) ', d):
        return 'PONTA'
    if re.search(r' (INTERMEDIARIO|INT) ', d):
        return 'INTERMEDIARIO'
    if ' UNICO ' in d:
        return 'UNICO'
    return None


def componente_de(desc):
    d = sem_acento(desc).upper()
    if 'BANDEIRA' in d or 'BAND.' in d or 'BD.' in d:
        return 'BANDEIRA', _posto(d)
    if re.match(r'G\d?C(OM)?P', d.replace('.', '')) or 'COMP.' in d:
        return 'CONSUMO_COMPENSADO', _posto(d)
    if 'INJ' in d:
        return ('DEMANDA_GERACAO_ULTRAPASSAGEM' if 'ULTRA' in d else 'DEMANDA_GERACAO'), 'GERACAO'
    if 'IMP.SOM' in d or 'DIM-C' in d:
        return 'DEMANDA_GERACAO', 'GERACAO'
    if 'GERA' in d and ('DEM' in d or 'MMGD' in d):
        return ('DEMANDA_GERACAO_ULTRAPASSAGEM' if 'ULTRA' in d else 'DEMANDA_GERACAO'), 'GERACAO'
    if 'REAT' in d or 'UFER' in d or 'DMCR' in d:
        return 'REATIVO_EXCEDENTE', _posto(d)
    if 'ULTRA' in d:
        return 'DEMANDA_ULTRAPASSAGEM', None
    if 'DEMANDA' in d:
        return 'DEMANDA', None
    if 'TUSD' in d:
        return 'TUSD', _posto(d)
    if '-TE' in d or re.search(r'\bTE\b', d):
        return 'TE', _posto(d)
    if re.match(r'EST[ .]', d):
        return 'ESTORNO', None
    if 'ILUM' in d or 'PUBLICA' in d or 'CIP' in re.split(r'[\s.-]+', d):
        return 'ILUMINACAO_PUBLICA', None
    if 'SEGUNDA VIA' in d or '2A VIA' in d or 'RELIGA' in d or 'TAXA' in d:
        return 'SERVICO', None
    if d.startswith('MULTA'):
        return 'MULTA', None
    if d.startswith('JUROS'):
        return 'JUROS', None
    if d.startswith('PARC'):
        return 'PARCELAMENTO', None
    if 'ATUALIZ' in d or 'CORRECAO' in d or 'IPCA' in d or 'IGP' in d or 'ATU.MON' in d:
        return 'ATUALIZACAO_MONETARIA', None
    if re.search(r'\b(DIC|FIC|DMIC|DICRI)\b', d):
        return 'COMPENSACAO_CONTINUIDADE', None
    if 'DEVOL' in d or 'ESTORNO' in d or 'RESTITUI' in d:
        return 'ESTORNO', None
    if 'CONSUMO' in d:
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
    ch = _chave(tj) or _chave(' '.join(brutos))
    nf['chave_acesso'] = ' '.join(ch[i:i + 4] for i in range(0, 44, 4)) if ch and re.search(r'\d{4} \d{4} \d{4}', tj) else ch
    em = [l.texto(150, 560).strip() for l in ls if 20 < l.y < 50 and l.entre(150, 560)]
    if em:
        doc_['distribuidora'] = em[0]
        mm = re.search(r'CNPJ\s+([\d./-]{18})\s*\|\s*INSCRI\S+ ESTADUAL\s+(\S+)', ' '.join(em))
        if mm:
            doc_['distribuidora_cnpj'], doc_['distribuidora_ie'] = mm[1], mm[2]
        doc_['distribuidora_endereco'] = next((x for x in em[1:] if not x.startswith('CNPJ')), None)
    if not doc_['distribuidora_cnpj'] and ch:
        doc_['distribuidora_cnpj'] = _cnpj(ch)
    doc_['distribuidora_sigla'] = CNPJS.get(doc_['distribuidora_cnpj'], 'OUTRA')
    doc_['segunda_via'] = bool(re.search(r'\b2ª VIA\b', tj, re.I))
    nf['modelo'] = 'DANFE - DOCUMENTO AUXILIAR DA NOTA FISCAL DE ENERGIA ELÉTRICA ELETRÔNICA'
    # cliente (x≈18): "NOME DO CLIENTE:" … "ENDEREÇO:" … CEP/cidade/UF
    yn = next((w.y1 for w in t1 if w.t == 'NOME' and w.x0 < 40), 79)
    yc = next((w.y1 for w in t1 if w.t == 'REF:MÊS/ANO' or (w.t.startswith('REF') and w.x0 < 60 and w.y1 > yn)), 143)
    bl = [l.texto(10, 200).strip() for l in ls if yn + 3 < l.y < yc - 3 and l.entre(10, 200)]
    bl = [x for x in bl if x and not x.startswith(('ENDEREÇO', 'ATUALIZE'))]
    if bl:
        tit['nome'] = bl[0]
        end = []
        for x in bl[1:]:
            mm = re.match(r'CNPJ:\s*(\S+)|CPF:\s*(\S+)', x)
            if mm:
                v = mm[1] or mm[2]
                if '*' in v:
                    tit['cnpj_cpf_mascarado'] = v
                else:
                    tit['cnpj_cpf'] = v
                m2 = re.search(r'Inscri\S+ Estadual:\s*(\S+)', x, re.I)
                if m2:
                    tit['inscricao_estadual'] = m2[1]
                continue
            mm = re.match(r'(?:INSC\S*\s*EST\S*|IE):\s*(\S+)', x)
            if mm:
                tit['inscricao_estadual'] = mm[1]
                continue
            end.append(x)
        if end:
            mm = re.match(r'(\d{5}-\d{3})\s+(.*?)\s+([A-Z]{2})$', end[-1])
            if mm:
                tit['cep'], tit['cidade'], tit['uf'] = mm[1], mm[2], mm[3]
                end = end[:-1]
            tit['endereco'] = ' '.join(end) or None
        uc_['endereco'] = ' '.join(x for x in bl[1:] if not re.match(r'(CNPJ|CPF|INSC|IE)', x)) or None
        d['entrega']['endereco_correspondencia'] = ' '.join([bl[0]] + [x for x in bl[1:] if not re.match(r'(CNPJ|CPF|INSC|IE)', x)])
    # códigos (coluna do meio)
    def abaixo(rot1, rx):
        lab = next((w for w in t1 if w.t == rot1 and 200 < w.x0 < 300), None)
        if not lab:
            return None
        return next((w.t for w in t1 if lab.y1 + 5 < w.y1 < lab.y1 + 20 and 200 < w.x0 < 320 and re.fullmatch(rx, w.t)), None)
    labs = sorted([w for w in t1 if w.t in ('CÓDIGO', 'NÚMERO') and 200 < w.x0 < 300], key=lambda w: w.y1)
    vals = []
    for lab in labs:
        v = next((w.t for w in t1 if lab.y1 + 5 < w.y1 < lab.y1 + 20 and 200 < w.x0 < 320 and re.fullmatch(r'[\d.\-]{6,}', w.t)), None)
        nxt = _txt(sorted([w for w in t1 if abs(w.y1 - lab.y1) < 2 and lab.x0 <= w.x0 < 330], key=lambda w: w.x0))
        vals.append((nxt, v))
    for rot, v in vals:
        if 'INSTALA' in rot or 'UNIDADE' in rot:
            uc_['uc'] = uc_['instalacao'] = v
        elif 'CLIENTE' in rot:
            tit['codigo_cliente'] = v
    # NF3e (direita)
    tn = ' '.join(l.texto(380, 600) for l in ls if 85 < l.y < 145)
    mm = re.search(r'NOTA FISCAL N\S*\s*(\d+)\s*-\s*S\S*RIE\s*(\S+)\s*/\s*DATA DE EMISS\S*:?\s*(\d\d/\d\d/\d{4})', tn)
    if mm:
        nf.update({'numero': mm[1], 'serie': mm[2], 'data_emissao': data_br(mm[3])})
        ref['data_emissao'] = data_br(mm[3])
    mm = re.search(r'(https?://\S+)', tn)
    nf['url_consulta'] = mm[1] if mm else None
    mm = re.search(r'Protocolo de autoriza\S*:?\s*(\d+)\s*-\s*(\d\d/\d\d/\d{4})\s*\S+\s*(\d\d:\d\d:\d\d)', tn)
    if mm:
        nf['protocolo_autorizacao'], nf['data_autorizacao'] = mm[1], f'{data_br(mm[2])}T{mm[3]}'
    # referência / total / vencimento (linha abaixo dos rótulos)
    lab = next((w for w in t1 if w.t.startswith('REF:') and w.x0 < 60), None)
    if lab:
        lin = _txt(sorted([w for w in t1 if lab.y1 + 4 < w.y1 < lab.y1 + 20 and w.x0 < 330], key=lambda w: w.x0))
        mm = re.search(r'(\d\d)/(\d{4})\s+([\d.]+,\d\d)\s+(\d\d/\d\d/\d{4})', lin)
        if mm:
            ref['mes_referencia'] = f'{mm[2]}-{mm[1]}'
            tot['total_a_pagar'] = num(mm[3])
            ref['data_vencimento'] = data_br(mm[4])
    # classificação / fornecimento
    lc = next((k for k, l in enumerate(ls) if 'CLASSIFICAÇÃO:' in l.texto()), None)
    if lc is not None:
        cls = ls[lc].texto(10, 360).replace('CLASSIFICAÇÃO:', '').strip()
        nx = next((l for l in ls[lc + 1:lc + 3] if l.y - ls[lc].y < 9 and l.entre(10, 360)), None)
        if nx:
            cls += ' ' + nx.texto(10, 360).strip()
        uc_['tipo_tarifa_impresso'] = re.sub(r'\s+', ' ', cls) or None
        cls = re.sub(r'\s+', ' ', cls)
        uc_['classificacao'] = cls
        mm = re.match(r'([AB]\d\w?)\s+(.*?)\s+(Verde|Azul|Convencional|Branca)?\s*([A-ZÀ-Ú]+)\s+--\s+(.*)', cls)
        if mm:
            uc_['subgrupo'], uc_['grupo'] = mm[1], mm[1][0]
            uc_['modalidade_tarifaria'] = mm[3]
            uc_['classe'], uc_['subclasse'] = mm[4], mm[5]
        else:
            m2 = re.match(r'([AB]\d\w?)', cls)
            if m2:
                uc_['subgrupo'], uc_['grupo'] = m2[1], m2[1][0]
    mm = re.search(r'TIPO DE FORNECIMENTO:\s*(\S+)', tj)
    uc_['tipo_fornecimento'] = mm[1] if mm else None
    mm = re.search(r'LEITURA ANTERIOR\s+(\d\d/\d\d/\d{4})\s+LEITURA ATUAL\s+(\d\d/\d\d/\d{4})\s+N\S+ DE DIAS\s+(\d+)'
                   r'(?:\s+PR\S+XIMA LEITURA\s+(\d\d/\d\d/\d{4}))?', tj)
    if mm:
        ref.update({'leitura_anterior': data_br(mm[1]), 'leitura_atual': data_br(mm[2]), 'dias_faturados': int(mm[3]),
                    'proxima_leitura': data_br(mm[4]) if mm[4] else None})
    tec = {'tensao_nominal': None, 'tensao_contratada_v': None, 'tensao_fornecimento_kv': None, 'tensao_minima': None,
           'tensao_maxima': None, 'faixa_adequada': None, 'fator_potencia_referencia': None, 'rtc': None, 'rtp': None,
           'constantes': [], 'perdas_transformacao_pct': None, 'horario_ponta': None, 'equipamento_medidor': None,
           'responsavel_iluminacao_publica': None}
    uc_['tecnico'] = tec
    _itens(pags, d)
    for np_, t in pags[:3]:
        if any(w.t == 'ITENS' and w.x0 < 40 for w in t):
            _direita(t, d, np_)
            _medicoes(t, d, np_)
    for np_, t in pags[1:3]:
        _demonstrativo(t, d, np_)
    _debitos(t1, d)
    _provas(d)
    _gd_direita(t1, d)
    _avisos(t1, d, ls)
    _pagamento(t1, brutos, d)
    ilum = [i['valor'] for i in d['itens'] if i['componente'] == 'ILUMINACAO_PUBLICA' and i['valor'] is not None]
    tot['valor_cosip_cip'] = round(sum(ilum), 2) if ilum else None
    uc_['geracao']['e_gerador'] = any(i['componente'] in ('DEMANDA_GERACAO', 'CONSUMO_COMPENSADO') for i in d['itens'])
    for it in d['itens']:
        if it['componente'] in ('DEMANDA', 'DEMANDA_ULTRAPASSAGEM') and not it['posto'] and                 doc_['distribuidora_sigla'] == 'NEOENERGIA BRASILIA' and 'VERDE' in (uc_['classificacao'] or '').upper():
            it['posto'] = 'FORA_PONTA'
        mm = re.search(r'\b(\d\d)/(\d{4})\b', it['descricao'] or '')
        it['mes_ref'] = f'{mm[2]}-{mm[1]}' if mm else ref['mes_referencia']
    d['historico_formato'] = 'so_grafico'
    return d


def _itens(pags, d):
    nomes = ('quant', 'preco', 'valor', 'pis_cofins', 'base_icms', 'aliquota_icms', 'icms', 'tarifa')
    anc_ok = None
    for np_, t in pags[:4]:
        cab = next((w for w in t if w.t == 'ITENS' and w.x0 < 40), None)
        if not cab:
            continue
        tot_w = next((w for w in t if w.t == 'TOTAL' and w.x0 < 50 and w.y1 > cab.y1), None)
        med_w = next((w for w in t if w.t == 'MEDIDOR' and w.x0 < 40 and w.y1 > cab.y1), None)
        y_fim = tot_w.y1 + 1 if tot_w else (med_w.y0 - 3 if med_w else 470)
        ws = [w for w in t if cab.y1 + 10 < w.y1 < y_fim and w.x0 < 452]
        x1s = sorted(w.x1 for w in ws if w.x0 > 140 and e_numero(w.t))
        grp = []
        for x in x1s:
            if grp and x - grp[-1][-1] <= 8:
                grp[-1].append(x)
            else:
                grp.append([x])
        grp = [g_ for g_ in grp if len(g_) >= 2]
        if len(grp) == 8:
            anc_ok = {k: sorted(g_)[len(g_) // 2] for k, g_ in zip(nomes, grp)}
        anc = anc_ok or dict(zip(nomes, (160, 202, 255, 302, 346, 371, 417, 450)))
        for y, g in _grupos(ws, 1.6):
            unid = next((w.t for w in g if 90 <= w.x0 < 125 and re.fullmatch(r'kWh|kW|kVAr|kVARh|kVArh|KWH|KW|UN', w.t)), None)
            desc = _txt([w for w in g if w.x0 < 95])
            nums = [w for w in g if w.x0 >= 125 and e_numero(w.t)]
            cols = _col(nums, anc)
            if desc == 'TOTAL':
                rot = {'valor': 'VALOR (R$)', 'pis_cofins': 'PIS/COFINS(R$)', 'base_icms': 'BASE CALC. ICMS(R$)',
                       'icms': 'ICMS (R$)'}
                for k, v in cols.items():
                    if k in rot:
                        d['totais']['totais_colunas'].append({'pagina': np_, 'coluna': rot[k], 'valor': num(v)})
                d['totais']['total_nota_fiscal'] = num(cols.get('valor'))
                continue
            if not desc and nums and d['itens'] and d['itens'][-1]['pagina'] == np_:
                it = d['itens'][-1]  # números da linha de cima/baixo (1 pt) que não juntaram
                for k, v in cols.items():
                    campo = {'quant': 'quantidade_faturada', 'pis_cofins': 'pis_cofins', 'base_icms': 'base_icms',
                             'aliquota_icms': 'aliquota_icms', 'icms': 'icms', 'tarifa': 'tarifa_sem_tributos',
                             'preco': 'tarifa_com_tributos', 'valor': 'valor'}[k]
                    if it.get(campo) is None:
                        it[campo] = num(v, ponto_decimal=k in ('preco', 'tarifa'))
                        it['colunas_originais'][k] = v
                if unid and not it['unidade']:
                    it['unidade'] = unid
                continue
            if not desc:
                continue
            if not nums:
                comp, posto = componente_de(desc)
                d['itens'].append(_item(np_, desc, {}, None, 'INFO' if comp == 'AJUSTE' else comp, posto))
                continue
            comp, posto = componente_de(desc)
            d['itens'].append(_item(np_, desc, cols, unid, comp, posto))
        novos = [(i['descricao'], i['valor']) for i in d['itens'] if i['pagina'] == np_]
        antes = [(i['descricao'], i['valor']) for i in d['itens'] if i['pagina'] < np_]
        if np_ > 1 and novos and novos == antes[:len(novos)]:
            d['itens'] = [i for i in d['itens'] if i['pagina'] != np_]  # página que só repete a anterior
    # unidade/valores na linha de cima (1 pt antes da descrição): segunda passada junta linhas órfãs
    for it in d['itens']:
        if it['componente'] == 'INFO':
            continue


def _item(np_, desc, cols, unid, comp, posto):
    return {'pagina': np_, 'secao_impressa': 'ITENS DA FATURA', 'codigo': None, 'descricao': desc, 'mes_ref': None,
            'componente': comp, 'posto': posto, 'quantidade_registrada': None,
            'quantidade_faturada': num(cols.get('quant')), 'unidade': unid,
            'tarifa_com_tributos': num(cols.get('preco'), ponto_decimal=True),
            'tarifa_sem_tributos': num(cols.get('tarifa'), ponto_decimal=True), 'valor': num(cols.get('valor')),
            'valor_sem_tributos': None, 'base_icms': num(cols.get('base_icms')),
            'aliquota_icms': num(cols.get('aliquota_icms')), 'icms': num(cols.get('icms')), 'base_pis_cofins': None,
            'aliquota_pis': None, 'pis': None, 'aliquota_cofins': None, 'cofins': None,
            'pis_cofins': num(cols.get('pis_cofins')), 'nf_referencia': None,
            'colunas_originais': {'ITENS DA FATURA': desc, 'UNID.': unid, **cols}}


def _direita(t1, d, np_=1):
    tab = {'pagina': np_, 'nome': 'GRANDEZAS CONTRATADAS', 'linhas': []}
    for y, g in _grupos([w for w in t1 if w.x0 >= 452 and 250 < w.y1 < 470]):
        s = _txt(g)
        mm = re.match(r'(PIS|COFINS|ICMS)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)$', s)
        if mm:
            d['tributos'].append({'pagina': np_, 'tributo': mm[1], 'base': num(mm[2]), 'aliquota': num(mm[3]),
                                  'valor': num(mm[4]), 'retido': False,
                                  'colunas_originais': {'Tributo': mm[1], 'Base': mm[2], 'Alíquota': mm[3], 'Valor': mm[4]}})
            continue
        mm = re.match(r'(Demanda.*?)\s+([\d.,]+)$', s)
        if mm and np_ == 1:
            rot = mm[1]
            inj = 'Inj' in rot or 'Ger' in rot
            tab['linhas'].append({'colunas_originais': {'GRANDEZAS CONTRATADAS': rot, 'valor': mm[2]}})
            d['demanda'].append({'pagina': 1, 'tipo': 'injecao' if inj else 'consumo', 'posto': 'GERACAO' if inj else None,
                                 'contratada_kw': num(mm[2]), 'medida_kw': None, 'faturada_kw': None,
                                 'faturada_ultrapassagem_kw': None, 'nao_consumida_kw': None, 'data_hora': None,
                                 'rotulo': rot, 'colunas_originais': {'GRANDEZAS CONTRATADAS': rot, 'valor': mm[2]}})
    if tab['linhas']:
        d['tabelas_complementares'].append(tab)


def _medicoes(t1, d, np_=1):
    hdr = next((w for w in t1 if w.t == 'MEDIDOR' and w.x0 < 40), None)
    if not hdr:
        return
    ns = {'leitura_anterior': 200, 'leitura_atual': 243, 'constante': 287, 'consumo': 335}
    for y, g in _grupos([w for w in t1 if hdr.y1 + 10 < w.y1 < hdr.y1 + 120 and w.x0 < 420], 1.6):
        if not re.fullmatch(r'\d{6,}', g[0].t) or g[0].x0 > 40:
            continue
        med = g[0].t
        gr = _txt([w for w in g[1:] if w.x0 < 120 and not e_numero(w.t)])
        po = _txt([w for w in g[1:] if 120 <= w.x0 < 165 and not e_numero(w.t)])
        nums = sorted([w for w in g if w.x0 >= 165 and e_numero(w.t)], key=lambda w: w.x0)
        cols = {k: w.t for k, w in zip(ns, nums)}
        d['medicoes'].append({'pagina': np_, 'tabela_origem': 'MEDIDOR', 'medidor': med, 'grandeza': gr,
                              'posto': _posto(po), 'leitura_anterior': num(cols.get('leitura_anterior')),
                              'leitura_atual': num(cols.get('leitura_atual')), 'constante': num(cols.get('constante')),
                              'perdas_pct': None, 'ajuste': None, 'consumo': num(cols.get('consumo')),
                              'consumo_faturado': None, 'fator_potencia': None, 'ajuste_fator_potencia': None,
                              'unidade': 'kW' if 'Demanda' in gr else ('kVArh' if 'Reat' in gr else 'kWh'),
                              'data_hora_registro': None, 'leitura_arredondada': False,
                              'colunas_originais': {'MEDIDOR': med, 'GRANDEZAS': gr, 'POSTOS HORÁRIOS': po, **cols}})
        if med not in d['unidade_consumidora']['medidor']:
            d['unidade_consumidora']['medidor'].append(med)
    vis = []
    for m in d['medicoes']:
        if m['constante'] is not None and (m['grandeza'], m['constante']) not in vis:
            vis.append((m['grandeza'], m['constante']))
    d['unidade_consumidora']['tecnico']['constantes'] = [{'grandeza': g_, 'valor': v} for g_, v in vis]


def _demonstrativo(t, d, np_):
    hdr = next((w for w in t if w.t == 'DEMONSTRATIVO' and 130 < w.x0 < 160), None)
    if not hdr:
        return
    tx = ' '.join(_txt(g) for y, g in _grupos(t))
    mm = re.search(r'CICLO - (\d\d/\d\d/\d{4}) a (\d\d/\d\d/\d{4})', tx)
    if mm:
        d['referencia']['ciclo'] = f'{mm[1]} a {mm[2]}'
    fc = next((w for w in t if w.t == 'Fator' and w.x0 > 360), None)
    if fc:
        lin = ' '.join(_txt(g) for y, g in _grupos([w for w in t if fc.y1 < w.y1 < fc.y1 + 20 and w.x0 > 360]))
        for mm in re.finditer(r'(Na Ponta|Fora de Ponta):\s*([\d,]+)', lin):
            d['informacoes_consumo'].append({'pagina': np_, 'rotulo': 'Fator de Carga', 'posto': _posto(mm[1]),
                                             'valor': num(mm[2]), 'unidade': None})
    ws = [w for w in t if w.y1 > hdr.y1 + 10 and w.x0 < 372]
    med = None
    mw = next((k for k, w in enumerate(ws) if w.t == 'MEDIDOR'), None)
    if mw is not None:
        med = next((w.t for w in ws if abs(w.y1 - ws[mw].y1) < 2 and re.fullmatch(r'\d{6,}', w.t)), None)
    ns = {'leitura_anterior': 190, 'leitura_atual': 229, 'constante': 270, 'ajuste': 309, 'consumo': 357}
    for y, g in _grupos(ws, 1.6):
        desc = _txt([w for w in g if w.x0 < 160 and not e_numero(w.t)])
        nums = [w for w in g if w.x0 >= 150 and e_numero(w.t)]
        if not desc or len(nums) < 4 or desc.startswith(('Data', 'Hora')) or desc.isupper():
            continue
        cols = _col(nums, ns)
        un = 'kW' if desc.startswith('Demanda') else ('kVArh' if 'Reativo' in desc else 'kWh')
        d['medicoes'].append({'pagina': np_, 'tabela_origem': 'DEMONSTRATIVO DE CONSUMO', 'medidor': med, 'grandeza': desc,
                              'posto': _posto(desc) or ('TODOS' if desc.endswith('Total') else None), 'leitura_anterior': num(cols.get('leitura_anterior')),
                              'leitura_atual': num(cols.get('leitura_atual')), 'constante': num(cols.get('constante')),
                              'perdas_pct': None, 'ajuste': num(cols.get('ajuste')), 'consumo': num(cols.get('consumo')),
                              'consumo_faturado': None, 'fator_potencia': None, 'ajuste_fator_potencia': None,
                              'unidade': un, 'data_hora_registro': None, 'leitura_arredondada': False,
                              'colunas_originais': {'DESCRIÇÃO': desc, **cols}})


def _provas(d):
    """Divergências impressas provadas pela própria fatura (a conferência dispensa só estas)."""
    div = d['extracao']['divergencias_impressas']
    # ICMS do item ≠ base×alíquota, mas a soma dos ICMS dos itens bate com o ICMS total impresso
    icms_tot = next((t['valor'] for t in d['tributos'] if t['tributo'] == 'ICMS'), None)
    soma = round(sum(i['icms'] or 0 for i in d['itens']), 2)
    if icms_tot is not None and abs(soma - icms_tot) <= 0.02:
        for k, it in enumerate(d['itens']):
            b, a, v = it['base_icms'], it['aliquota_icms'], it['icms']
            if None not in (b, a, v) and abs(b * a / 100 - v) > 0.03:
                div.append({'onde': 'item', 'indice': k, 'nota': f'{it["descricao"]}: impresso ICMS {v} para base {b} × {a}% '
                            f'(={round(b * a / 100, 2)}); soma dos ICMS dos itens bate com o ICMS total impresso {icms_tot}.'})
    # quantidade e preço impressos zerados com valor cheio (base de ICMS = valor confirma)
    for k, it in enumerate(d['itens']):
        q, t, v = it['quantidade_faturada'], it['tarifa_com_tributos'], it['valor']
        if q == 0 and t == 0 and v and abs(v) > 1 and it['base_icms'] is not None and abs(it['base_icms'] - abs(v)) <= 0.02:
            div.append({'onde': 'item', 'indice': k, 'nota': f'{it["descricao"]}: quantidade e preço unitário impressos 0,00 '
                        f'com valor {v}; a base de ICMS impressa ({it["base_icms"]}) confirma o valor.'})
    # quadro da p1 com consumo 0,00 zerado pelo AJUSTE do demonstrativo de consumo
    dem = [m for m in d['medicoes'] if m['tabela_origem'] == 'DEMONSTRATIVO DE CONSUMO']
    ja = {x['indice'] for x in div if x['onde'] == 'medicao'}
    for j, m in enumerate(d['medicoes']):
        la, lb, c, cons = m['leitura_anterior'], m['leitura_atual'], m['constante'], m['consumo']
        if j in ja or None in (la, lb, c, cons) or abs((lb - la) * c - cons) <= max(1, abs(cons) * 0.01):
            continue
        # registro de demanda (kW) não é acumulativo: consumo = leitura atual × constante
        if m['unidade'] == 'kW' and abs(lb * c - cons) <= max(1, abs(cons) * 0.01):
            div.append({'onde': 'medicao', 'indice': j, 'nota': f'{m["grandeza"]}: registro de demanda (não acumulativo); '
                        f'consumo impresso {cons} = leitura {lb} × {c}, não (atual − anterior).'})
            continue
        par = next((x for x in dem if (x['leitura_anterior'], x['leitura_atual'], x['constante']) == (la, lb, c)
                    and x['ajuste'] and abs((lb - la) * c + x['ajuste'] - cons) <= max(1, abs(cons) * 0.01)), None)
        # registro "Único" com consumo 0,00 cujo giro é a soma dos registros Ponta + Fora Ponta (faturados por posto)
        if not par and (m['posto'] == 'UNICO' or 'Total' in m['grandeza']) and cons == 0:
            pos = [x for x in d['medicoes'] if x['tabela_origem'] == m['tabela_origem'] and x['pagina'] == m['pagina']
                   and x['medidor'] == m['medidor'] and x['grandeza'].split()[:2] == m['grandeza'].split()[:2]
                   and x['posto'] in ('PONTA', 'FORA_PONTA')
                   and None not in (x['leitura_anterior'], x['leitura_atual'])]
            if len(pos) == 2 and abs(sum(x['leitura_atual'] - x['leitura_anterior'] for x in pos) - (lb - la)) <= 1:
                div.append({'onde': 'medicao', 'indice': j, 'nota': f'Registro Único de {m["grandeza"]} impresso com consumo '
                            f'0,00; o giro ({lb}−{la}) é a soma dos registros Ponta e Fora Ponta, faturados por posto.'})
                continue
        if par:
            div.append({'onde': 'medicao', 'indice': j, 'nota': f'Quadro p{m["pagina"]} imprime consumo {cons} para '
                        f'{m["grandeza"]}; ({lb}−{la})×{c} é compensado pelo AJUSTE {par["ajuste"]} impresso no '
                        f'Demonstrativo de Consumo (p{par["pagina"]}).'})


def _debitos(t1, d):
    lab = next((w for w in t1 if w.t == 'Vencto' and w.x0 < 40), None)
    deb = d.setdefault('debitos_pendentes', [])
    if not lab:
        return
    for y, g in _grupos([w for w in t1 if lab.y1 + 3 < w.y1 < lab.y1 + 40 and w.x0 < 425]):
        ws = [w.t for w in g]
        for k in range(0, len(ws) - 2, 3):
            a, b, v = ws[k:k + 3]
            if re.fullmatch(r'\d\d/\d\d/\d\d', a) and re.fullmatch(r'[\d.]+,\d\d', v):
                deb.append({'referencia': None, 'vencimento': data_br(a[:6] + '20' + a[6:]),
                            'data_reaviso': data_br(b[:6] + '20' + b[6:]) if re.fullmatch(r'\d\d/\d\d/\d\d', b) else None,
                            'valor': num(v)})


def _gd_direita(t1, d):
    gd = d['gd']
    bloco = ' '.join(_txt(g) for y, g in _grupos([w for w in t1 if w.x0 >= 425 and 480 < w.y1 < 640]))
    tipos = (('saldo anterior', 'saldo_anterior'), ('saldo atual', 'saldo_atual'), ('injetada', 'injetada'),
             ('compensada', 'compensada'), ('excedente', 'excedente'), ('alocada', 'outro'))
    for mm in re.finditer(r'([A-Za-zÀ-ú][A-Za-zÀ-ú ]*?)\s*=\s*([\d.]+,\d+)', bloco):
        rot = mm[1].strip()
        tipo = next((t for k, t in tipos if k in rot.lower()), 'outro')
        gd['lancamentos'].append({'pagina': 1, 'tipo': tipo, 'posto': None, 'kwh': num(mm[2]), 'mes_ref': None,
                                  'ref_expiracao': None, 'unidade_impressa': None, 'rotulo': f'{rot} = {mm[2]}'})


def _avisos(t1, d, ls):
    vistos = set()
    def add(t):
        t = re.sub(r'\s+', ' ', t).strip()
        if len(t) > 15 and t[:50] not in vistos:
            vistos.add(t[:50])
            d['mensagens'].append({'pagina': 1, 'texto': t})
    for l in ls:
        if 180 < l.y < 200 and l.texto().startswith('Cadastra-se'):
            add(l.texto())
    med = next((w for w in t1 if w.t == 'MEDIDOR' and w.x0 < 40), None)
    inf = next((w for w in t1 if w.t == 'INFORMAÇÕES' and w.x0 < 40), None)
    if med:
        y0 = med.y1 + 60
        bloco = ' '.join(l.texto(10, 420) for l in ls if y0 < l.y < (inf.y1 - 2 if inf else 610))
        for p in re.split(r'(?<=\.)\s+(?=[A-ZÀ-Ú])', bloco):
            add(p)
    if inf:
        bloco = ' '.join(l.texto() for l in ls if inf.y1 - 1 <= l.y < inf.y1 + 60)
        add(bloco)
        gd = d['gd']
        mm = re.search(r'Saldo atualizado de cr\S+ditos\s*=\s*([\d.,]+)', bloco)
        if mm:
            gd['lancamentos'].append({'pagina': 1, 'tipo': 'saldo_atual', 'posto': None, 'kwh': num(mm[1]),
                                      'mes_ref': None, 'ref_expiracao': None, 'unidade_impressa': None,
                                      'rotulo': f'Saldo atualizado de créditos = {mm[1]}'})
        mm = re.search(r'Energia Alocada no ciclo\s*=\s*([\d.,]+)', bloco)
        if mm:
            gd['lancamentos'].append({'pagina': 1, 'tipo': 'outro', 'posto': None, 'kwh': num(mm[1]), 'mes_ref': None,
                                      'ref_expiracao': None, 'unidade_impressa': None,
                                      'rotulo': f'Energia Alocada no ciclo = {mm[1]}'})
        mm = re.search(r'Energia injetada no m\S+s\s+([\d.]+(?:,\d+)?)(?=\s*kWh|Saldo|\s)', bloco)
        if mm:
            gd['lancamentos'].append({'pagina': 1, 'tipo': 'injetada', 'posto': None, 'kwh': num(mm[1]),
                                      'mes_ref': d['referencia']['mes_referencia'], 'ref_expiracao': None,
                                      'unidade_impressa': 'kWh', 'rotulo': mm[0]})
        mm = re.search(r'Saldo para o pr\S*\s*\S*ximo ci\s?clo\s+([\d.]+(?:,\s?\d+)?)\s*kWh', bloco)
        if mm:
            gd['lancamentos'].append({'pagina': 1, 'tipo': 'saldo_atual', 'posto': None,
                                      'kwh': num(mm[1].replace(' ', '')), 'mes_ref': None, 'ref_expiracao': None,
                                      'unidade_impressa': 'kWh', 'rotulo': mm[0]})
        mm = re.search(r'Saldo\D{0,40}?([\d.]+,\d+)\s*kWh', bloco)
        if mm and not gd['lancamentos']:
            gd['lancamentos'].append({'pagina': 1, 'tipo': 'saldo_atual', 'posto': None, 'kwh': num(mm[1]), 'mes_ref': None,
                                      'ref_expiracao': None, 'unidade_impressa': 'kWh', 'rotulo': mm[0]})
        mm = re.search(r'bandeira em vigor \S+ a (\w+)', bloco)
        if mm:
            cor = sem_acento(mm[1]).upper()
            d['bandeiras'].append({'pagina': 1, 'cor': 'VERMELHA_1' if cor == 'VERMELHA' else cor, 'inicio': None,
                                   'fim': None, 'dias': None})


def _pagamento(t1, brutos, d):
    pag = d['pagamento']
    tudo = re.sub(r'\s+', ' ', ' '.join(brutos))
    mm = re.search(r'\b(\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14})\b', tudo)
    pag['linha_digitavel'] = mm[1] if mm else None
    mm = re.search(r'(BANCO [A-Z ]+?(?:S/A|S\.A\.))', tudo)
    pag['banco'] = mm[1] if mm else None
    if 'PARA CADASTRAR SUA CONTA EM DÉBITO AUTOMÁTICO' in tudo:
        pag['debito_automatico'] = 'PARA CADASTRAR SUA CONTA EM DÉBITO AUTOMÁTICO, UTILIZE O CÓDIGO DO CLIENTE.'
    if pag['linha_digitavel']:
        bol = {'nosso_numero': None, 'numero_documento': None, 'carteira': None, 'especie': None, 'aceite': None,
               'data_documento': None, 'data_processamento': None, 'beneficiario': None,
               'agencia_codigo_beneficiario': None, 'pagador': None, 'local_pagamento': None, 'instrucoes': None}
        mm = re.search(r'(PAG\S+VEL EM QUALQUER REDE BANC\S+RIA)', tudo)
        bol['local_pagamento'] = mm[1] if mm else None
        lab = next((w for w in t1 if w.t == 'NOSSO' and w.y1 > 600), None)
        if lab:
            lin = sorted([w for w in t1 if lab.y1 + 2 < w.y1 < lab.y1 + 9], key=lambda w: w.x0)
            if lin:
                bol['nosso_numero'] = lin[0].t
                bol['numero_documento'] = next((w.t for w in lin if 140 < w.x0 < 200), None)
        mm = re.search(r'BENEFICI\S+RIO (.*?CEP \d{5}-\d{3})', tudo)
        bol['beneficiario'] = mm[1] if mm else None
        mm = re.search(r'AG\S+NCIA/CODIGO CEDENTE (\S+)', tudo)
        bol['agencia_codigo_beneficiario'] = mm[1] if mm else None
        mm = re.search(r'PAGADOR \| CPF/CNPJ \| ENDERE\S+O (.*?) NOSSO N', tudo)
        bol['pagador'] = mm[1] if mm else None
        pag['boleto'] = bol
    if 'PAGUE COM PIX' in tudo:
        d['outros'].append({'pagina': 1, 'secao_impressa': 'PAGUE COM PIX', 'rotulo': 'PAGUE COM PIX',
                            'valor': 'QR code PIX (sem código em texto impresso)'})
    pag.setdefault('conta_recebedora', None)
