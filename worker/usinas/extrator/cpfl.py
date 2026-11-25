"""Parser determinístico das faturas CPFL (Paulista, Piratininga, Santa Cruz) — modelo DANF3E (2025/2026), A4.

Sem cabeçalhos de coluna em texto: itens e medições pelas posições fixas da borda direita dos números.
p1: emitente, correspondência, datas, classificação, titular, UC, NF3e, itens, tributos, grandezas contratadas,
totais, medições, avisos; p2 institucional; p3: tensão, participação/injetado, histórico 13 meses (consumo ponta,
fora ponta, demanda + dias), saldos GD, avisos, boleto ou débito automático; p4 em branco ou boleto.
"""
import re

from base import data_br, e_numero, esqueleto, linhas, mes_ano, num, palavras, posto_de, sem_acento

NOME = 'cpfl_danf3e_v1'
CNPJS = {'33.050.196/0001-88': 'CPFL PAULISTA', '04.172.213/0001-51': 'CPFL PIRATININGA',
         '53.859.112/0001-69': 'CPFL SANTA CRUZ'}
COL = {'quant': 194, 'tarifa': 234, 'preco': 273, 'valor': 308.5, 'base_icms': 337.5, 'aliquota_icms': 359,
       'icms': 387.5, 'pis': 416.5, 'cofins': 445.5}
COL_MED = {'leitura_anterior': 176, 'leitura_atual': 205, 'constante': 233, 'consumo': 258}
MES3 = r'(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)'


def _cnpj(chave):
    c = chave[6:20]
    return f'{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:]}'


def detecta(texto, doc=None):
    m = re.search(r'\b(\d{44})\b', texto)
    return 'DANF3E' in texto and bool(m) and _cnpj(m[1]) in CNPJS


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


def _por_coluna(ws, cols, tol=12):
    out = {}
    for w in ws:
        k = min(cols, key=lambda c: abs(cols[c] - w.x1))
        if abs(cols[k] - w.x1) <= tol:
            out[k] = w.t if k not in out else out[k] + ' ' + w.t
    return out


def _posto(t):
    d = ' ' + sem_acento(t).upper().replace('-', ' ').replace('[', ' ') + ' '
    if re.search(r' (FPONTA|FORA PONTA|FORA DE PONTA|F PONTA|FPTA|FORA PTA) ', d):
        return 'FORA_PONTA'
    if re.search(r' (PONTA|PTA) ', d):
        return 'PONTA'
    return None


def componente_de(desc):
    d = sem_acento(desc).upper()
    if 'BAND' in d:
        return 'BANDEIRA', _posto(d)
    if 'INJ' in d:
        return 'GD_INJETADA', _posto(d)
    if 'GERACAO' in d and ('USO SIST' in d or 'DEMANDA' in d):
        return ('DEMANDA_GERACAO_ULTRAPASSAGEM' if 'ULTRAP' in d else 'DEMANDA_GERACAO'), 'GERACAO'
    if 'REAT' in d:
        return 'REATIVO_EXCEDENTE', _posto(d) or 'UNICO'
    if 'ULTRAP' in d:
        return 'DEMANDA_ULTRAPASSAGEM', 'UNICO'
    if 'DEMANDA' in d:
        return 'DEMANDA', 'UNICO'
    if re.search(r'\bTE\b', d):
        return 'TE', _posto(d)
    if 'TUSD' in d or 'CONSUMO' in d or d.startswith('CONS '):
        return 'TUSD', _posto(d)
    if 'ILUM' in d or 'CIP' in re.split(r'[\s-]+', d) or 'COSIP' in d or 'CUSTEIO IP' in d:
        return 'ILUMINACAO_PUBLICA', None
    if 'MULTA' in d:
        return 'MULTA', None
    if 'JUROS' in d:
        return 'JUROS', None
    if 'ATUALIZ' in d or 'CORRECAO' in d or 'IGP' in d or 'IPCA' in d:
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
    t1 = pags[0][1]
    ls = linhas(t1)
    tj = ' '.join(l.texto() for l in ls)
    todo = ' '.join(' '.join(w.t for w in t) for _, t in pags)
    d['extracao']['paginas_lidas'] = [p for p, _ in pags]
    d['extracao']['paginas'] = [{'pagina': p, 'tipo': ('em_branco' if not t else
                                                       ('institucional' if p == 2 and 'Fique atento' in _txt(t) or p == 2
                                                        and len(t) > 0 and 'DANF3E' not in _txt(t) and 'Instalação' not in _txt(t)
                                                        else 'conteudo')), 'repete_pagina': None} for p, t in pags]
    doc_, nf, uc_, tit, ref, tot = (d['documento'], d['documento']['nota_fiscal'], d['unidade_consumidora'],
                                    d['titular'], d['referencia'], d['totais'])
    m = re.search(r'\b(\d{44})\b', todo)
    if m:
        nf['chave_acesso'] = m[1]
        doc_['distribuidora_cnpj'] = _cnpj(m[1])
        doc_['distribuidora_sigla'] = CNPJS.get(doc_['distribuidora_cnpj'], 'OUTRA')
    # emitente (x≈139, topo)
    em = [l for l in ls if l.y < 46 and l.entre(130, 400)]
    if len(em) >= 4:
        doc_['distribuidora'] = em[2].texto(130, 400).strip()
        e3 = em[4].texto(130, 400) if len(em) > 4 else ''
        doc_['distribuidora_endereco'] = (em[3].texto(130, 400).strip() + ' ' +
                                          (re.match(r'(CEP:\s*[\d-]+)', e3) or [''])[0]).strip()
        mm = re.search(r'Inscri\S+ Estadual:\s*(\S+)', e3)
        doc_['distribuidora_ie'] = mm[1] if mm else None
    nf['modelo'] = 'DANF3E - Documento Auxiliar da Nota Fiscal de Energia Elétrica Eletrônica'
    # endereço de correspondência (x≈59, y 110–150)
    corr = [l.texto(50, 450).strip() for l in ls if 105 < l.y < 152 and l.entre(50, 450)]
    d['entrega']['endereco_correspondencia'] = ' '.join(corr) or None
    # lote / roteiro / medidor / página / datas (linha y≈191)
    lr = next((l for l in ls if 180 < l.y < 200 and re.search(r'\b\w+\d+-\d{6,}\b', l.texto())), None)
    if lr:
        ws = lr.p
        uc_['lote'] = next((w.t for w in ws if w.x0 < 70 and w.t.isalpha()), None)
        uc_['roteiro_leitura'] = next((w.t for w in ws if re.fullmatch(r'\w+\d+-\d{6,}', w.t)), None)
        datas = [w for w in ws if re.fullmatch(r'\d\d/\d\d/\d{4}', w.t)]
        if datas:
            nf['data_apresentacao'] = data_br(datas[0].t)
    # classificação / fornecimento / tensão
    lc = next((k for k, l in enumerate(ls) if 'Classificação:' in l.texto()), None)
    if lc is not None:
        cls = ls[lc].texto(0, 195).replace('Classificação:', '').strip()
        if lc + 1 < len(ls) and ls[lc + 1].y - ls[lc].y < 10:
            cls += ' ' + ls[lc + 1].texto(0, 195).strip()
        uc_['classificacao'] = re.sub(r'\s+', ' ', cls)
        mm = re.match(r'(Tarifa (\w+)-([AB]\d\w?))\s+(\S+)\s+(.*)', uc_['classificacao'])
        if mm:
            uc_['tipo_tarifa_impresso'], uc_['modalidade_tarifaria'] = mm[1], mm[2]
            uc_['subgrupo'], uc_['grupo'] = mm[3], mm[3][0]
            uc_['classe'], uc_['subclasse'] = mm[4], mm[5]
        forn = ' '.join(l.texto(195, 300) for l in ls[lc:lc + 2])
        mm = re.search(r'(Monof\S+|Bif\S+|Trif\S+)', forn)
        uc_['tipo_fornecimento'] = mm[1] if mm else None
    tec = {'tensao_nominal': None, 'tensao_contratada_v': None, 'tensao_fornecimento_kv': None, 'tensao_minima': None,
           'tensao_maxima': None, 'faixa_adequada': None, 'fator_potencia_referencia': None, 'rtc': None, 'rtp': None,
           'constantes': [], 'perdas_transformacao_pct': None, 'horario_ponta': None, 'equipamento_medidor': None,
           'responsavel_iluminacao_publica': None}
    mm = re.search(r'TENS\S+ NOMINAL EM VOLTS Disp\.:\s*([\d.]+)\s+Lim\. m\S+n\.:\s*([\d.]+)\s+Lim\. m\S+x\.:\s*([\d.]+)', tj)
    if mm:
        tec.update({'tensao_nominal': f'TENSÃO NOMINAL EM VOLTS Disp.: {mm[1]}', 'tensao_contratada_v': num(mm[1]),
                    'tensao_minima': num(mm[2]), 'tensao_maxima': num(mm[3])})
    uc_['tecnico'] = tec
    # datas de leitura: "atual anterior dias" (x>400) + "Próxima Leitura dd/mm/aaaa"
    for l in ls:
        mm = re.search(r'(\d\d/\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+(\d{1,3})$', l.texto(395, 600).strip())
        if mm and 230 < l.y < 260:
            ref['leitura_atual'], ref['leitura_anterior'] = data_br(mm[1]), data_br(mm[2])
            ref['dias_faturados'] = int(mm[3])
    mm = re.search(r'Pr\S+xima Leitura\s+(\d\d/\d\d/\d{4})', tj)
    ref['proxima_leitura'] = data_br(mm[1]) if mm else None
    # titular (x≈41, de y≈245 até a linha "CNPJ:"/"CPF:")
    bl = [l for l in ls if 245 < l.y < 300 and l.entre(36, 50)]
    nomes = []
    for l in bl:
        t = l.texto(36, 270).strip()
        mm = re.search(r'\b(CNPJ|CPF):\s*(\S+)', t)
        if mm:
            tit['cnpj_cpf'] = mm[2]
            mi = re.search(r'INSC\.?\s*EST\S*:\s*(\S+)', t)
            tit['inscricao_estadual'] = mi[1] if mi else None
            break
        nomes.append(t)
    if nomes:
        tit['nome'] = nomes[0]
        resto = nomes[1:]
        cep = next((x for x in resto if re.fullmatch(r'\d{5}-\d{3}', x)), None)
        cid = next((x for x in resto if re.search(r'-\s*[A-Z]{2}$', x)), None)
        tit['cep'] = cep
        if cid:
            mm = re.match(r'(.*?)\s+(\S+(?: \S+)*?)\s*-\s*([A-Z]{2})$', cid)
            tit['uf'] = cid[-2:]
            tit['cidade'] = cid.split(' - ')[0].split()[-1] if ' - ' in cid else None
        tit['endereco'] = ' '.join(x for x in resto if x not in (cep, cid)) or None
        uc_['endereco'] = ' '.join(resto) or None
    if tit.get('nome') and doc_.get('distribuidora') is None:
        pass
    # corrige nome cortado ("RENOVÁVE") com o da correspondência, se for o mesmo começo
    corr_l = [l.texto(50, 450).strip() for l in ls if 105 < l.y < 152 and l.entre(50, 450)]
    if tit.get('nome') and corr_l and corr_l[0].startswith(tit['nome']) and len(corr_l[0]) > len(tit['nome']):
        d['valores_alternativos'].append({'campo': 'titular.nome', 'valor': tit['nome'], 'pagina': 1})
        tit['nome'] = corr_l[0]
    # 25/11/2026: layout sem o bloco do titular (x≈41, y 245–300; piloto 5816263f) — o nome vem da correspondência
    if not tit.get('nome') and corr_l and not re.match(r'\d{5}-\d{3}(?!\d)', corr_l[0]):
        tit['nome'] = corr_l[0]
        d['valores_alternativos'].append({'campo': 'titular.nome_origem', 'valor': 'bloco de correspondência', 'pagina': 1})
    if corr_l:
        mm = re.match(r'(\d{5}-\d{3})\s+(.*?)\s+([A-Z]{2})$', corr_l[-1])
        if mm:
            tit['cep'] = tit.get('cep') or mm[1]
            tit['cidade'], tit['uf'] = mm[2], mm[3]
    mm = re.search(r'\b(\d\.\d{3}\.\d{3}\.\d{3}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2}|\d{10})\b',
                   ' '.join(l.texto(280, 420) for l in ls if 248 < l.y < 264))
    uc_['uc'] = uc_['instalacao'] = mm[1] if mm else None
    # NF3e
    tn = ' '.join(l.texto(280, 600) for l in ls if 280 < l.y < 340)
    mm = re.search(r'NOTA FISCAL N\S*\s*(\d+)\s*-\s*S\S*RIE\s*(\d+)\s*/\s*DATA DE EMISS\S*:?\s*(\d\d/\d\d/\d{4})', tn)
    if mm:
        nf.update({'numero': mm[1], 'serie': mm[2], 'data_emissao': data_br(mm[3])})
        ref['data_emissao'] = data_br(mm[3])
    mm = re.search(r'(https?://\S+)', tn)
    nf['url_consulta'] = mm[1] if mm else None
    mm = re.search(r'Protocolo de autoriza\S*\s*(\d+)\s*-\s*(\d\d)\.(\d\d)\.(\d{4})\s*\S+\s*(\d\d:\d\d:\d\d)', tn)
    if mm:
        nf['protocolo_autorizacao'] = mm[1]
        nf['data_autorizacao'] = f'{mm[4]}-{mm[3]}-{mm[2]}T{mm[5]}'
    # referência / vencimento / total
    mm = re.search(r'\b(' + MES3 + r'/\d{4})\s+(\d\d/\d\d/\d{4})\s+R\$\s*([\d.]+,\d\d)', tj)
    if mm:
        ref['mes_referencia'] = mes_ano(mm[1])
        ref['data_vencimento'] = data_br(mm[2])
        tot['total_a_pagar'] = num(mm[3])
    mm = next((w.t for w in t1 if 350 < w.y1 < 368 and w.x0 < 120 and re.fullmatch(r'\d{9,}', w.t)), None)
    if mm:
        d['outros'].append({'pagina': 1, 'secao_impressa': 'Descrição da operação', 'rotulo': 'Nº', 'valor': mm})
    _itens(t1, d, pags)
    _quadro_direita(t1, d)
    _medicoes(t1, d)
    _avisos(pags, d)
    _pagina3(pags, d)
    _pagamento(pags, d, [p.get_text() for p in doc])
    ilum = [i['valor'] for i in d['itens'] if i['componente'] == 'ILUMINACAO_PUBLICA' and i['valor'] is not None]
    tot['valor_cosip_cip'] = round(sum(ilum), 2) if ilum else None
    uc_['geracao']['e_gerador'] = any(i['componente'] in ('DEMANDA_GERACAO', 'GD_INJETADA') for i in d['itens'])
    for j, me in enumerate(d['medicoes']):  # demanda: registro não acumulado
        la, lb, c, cons = me['leitura_anterior'], me['leitura_atual'], me['constante'], me['consumo']
        if me['unidade'] in ('kW',) and 'Demanda' in me['grandeza'] and None not in (la, lb, c, cons) and c and \
                abs((lb - la) * c - cons) > max(1, abs(cons) * 0.01):
            d['extracao']['divergencias_impressas'].append(
                {'onde': 'medicao', 'indice': j, 'nota': f'registro de demanda: consumo impresso {cons} ≠ ({lb}−{la})×{c}'})
    return d


def _itens(t1, d, pags=None):
    """Itens: da linha das alíquotas PIS/COFINS até o "Total a Pagar"; continuam nas páginas seguintes (mesmo
    cabeçalho) quando a fatura tem muitos lançamentos. "Subtotal", "Total …" e "Devolução" isolada = subtotais."""
    pags = pags or [(1, t1)]
    tot = d['totais']
    al_pis = al_cof = None
    for np_, t in pags:
        if not t or not any(w.t == 'Classificação:' for w in t):
            continue
        aliq = next((y for y, g in _grupos([w for w in t if 340 < w.y1 < 380 and 380 < w.x0 < 450])
                     if re.match(r'[\d,]+ % [\d,]+ %', _txt(g))), None)
        if aliq:
            g = [w.t for w in t if abs(w.y1 - aliq) < 1.5 and 380 < w.x0 < 450 and w.t != '%']
            if len(g) >= 2:
                al_pis, al_cof = num(g[0]), num(g[1])
        y0 = (aliq or 362) + 3
        meds = [w.y0 for w in t if re.fullmatch(r'\d{6,}', w.t) and w.x0 < 60 and w.y1 > 560]
        tap = next((w for w in t if w.t == 'Pagar' and w.x0 < 90 and w.y1 > y0), None)
        y_fim = tap.y1 + 1 if tap else (min(meds) - 2 if meds else 600)
        fim_doc = tap is not None
        for y, g in _grupos([w for w in t if y0 < w.y1 < y_fim and w.x0 < 450]):
            desc = [w for w in g if w.x0 < 148]
            rest = [w for w in g if w.x0 >= 148]
            unid = next((w.t for w in rest if not e_numero(w.t) and w.x0 < 170), None)
            nums = [w for w in rest if e_numero(w.t)]
            t_ = _txt(desc)
            if not t_ or not nums:
                continue
            cols = _por_coluna(nums, COL)
            if t_ == 'Subtotal' or t_.startswith('Total') or t_ == 'Devolução':
                v = num(cols.get('valor'))
                tot['subtotais'].append({'pagina': np_, 'rotulo': t_, 'valor': v})
                if t_ == 'Subtotal':
                    tot['subtotal'] = v
                elif t_ == 'Total Distribuidora':
                    tot['total_distribuidora'] = v
                continue
            comp, posto = componente_de(t_)
            mm = re.search(r'\b(' + MES3 + r'/\d{2})$', t_)
            pis, cof = num(cols.get('pis')), num(cols.get('cofins'))
            d['itens'].append({'pagina': np_, 'secao_impressa': None, 'codigo': None, 'descricao': t_,
                               'mes_ref': mes_ano(mm[1]) if mm else None, 'componente': comp, 'posto': posto,
                               'quantidade_registrada': None, 'quantidade_faturada': num(cols.get('quant')),
                               'unidade': unid, 'tarifa_com_tributos': num(cols.get('preco')),
                               'tarifa_sem_tributos': num(cols.get('tarifa')), 'valor': num(cols.get('valor')),
                               'valor_sem_tributos': None, 'base_icms': num(cols.get('base_icms')),
                               'aliquota_icms': num(cols.get('aliquota_icms')), 'icms': num(cols.get('icms')),
                               'base_pis_cofins': None, 'aliquota_pis': al_pis if pis is not None else None, 'pis': pis,
                               'aliquota_cofins': al_cof if cof is not None else None, 'cofins': cof, 'pis_cofins': None,
                               'nf_referencia': None, 'colunas_originais': {'Descrição': t_, 'Unid.': unid, **cols}})
        if fim_doc:
            break


def _quadro_direita(t1, d):
    for y, g in _grupos([w for w in t1 if w.x0 >= 450 and 355 < w.y1 < 600]):
        t = _txt(g)
        mm = re.match(r'(ICMS|PIS/PASEP|PIS|COFINS)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)$', t)
        if mm:
            d['tributos'].append({'pagina': 1, 'tributo': 'PIS' if mm[1].startswith('PIS') else mm[1],
                                  'base': num(mm[2]), 'aliquota': num(mm[3]), 'valor': num(mm[4]), 'retido': False,
                                  'colunas_originais': {'Tributo': mm[1], 'Base': mm[2], 'Alíquota': mm[3],
                                                        'Valor': mm[4]}})
            continue
        mm = re.match(r'(Gera\S+|Demanda\S*|Ponta|Fora Ponta|F ?Ponta)\s*(kW)?\s+([\d.,]+)$', t)
        if mm:
            ger = mm[1].startswith('Gera')
            fat = next((i['quantidade_faturada'] for i in d['itens'] if i['componente'] == ('DEMANDA_GERACAO' if ger
                                                                                            else 'DEMANDA')), None)
            d['demanda'].append({'pagina': 1, 'tipo': 'geracao' if ger else 'consumo',
                                 'posto': 'GERACAO' if ger else 'UNICO', 'contratada_kw': num(mm[3]), 'medida_kw': None,
                                 'faturada_kw': fat, 'faturada_ultrapassagem_kw': None, 'nao_consumida_kw': None,
                                 'data_hora': None, 'rotulo': f'Grandezas contratadas - {mm[1]} kW',
                                 'colunas_originais': {f'{mm[1]} kW': mm[3]}})


def _medicoes(t1, d):
    for y, g in _grupos([w for w in t1 if w.y1 > 600 and w.x0 < 300]):
        if not re.fullmatch(r'\d{6,}', g[0].t) or g[0].x0 > 60:
            continue
        med = g[0].t
        gr = _txt([w for w in g[1:] if w.x0 < 125])
        po = _txt([w for w in g[1:] if 125 <= w.x0 < 160])
        cols = _por_coluna([w for w in g if w.x0 >= 160 and e_numero(w.t)], COL_MED, tol=10)
        un = gr.split('-')[-1].strip() if '-' in gr else None
        d['medicoes'].append({'pagina': 1, 'tabela_origem': 'Medição', 'medidor': med, 'grandeza': gr,
                              'posto': _posto(po), 'leitura_anterior': num(cols.get('leitura_anterior')),
                              'leitura_atual': num(cols.get('leitura_atual')), 'constante': num(cols.get('constante')),
                              'perdas_pct': None, 'ajuste': None, 'consumo': num(cols.get('consumo')),
                              'consumo_faturado': None, 'fator_potencia': None, 'ajuste_fator_potencia': None,
                              'unidade': un, 'data_hora_registro': None, 'leitura_arredondada': False,
                              'colunas_originais': {'Medidor': med, 'Grandeza': gr, 'Posto': po, **cols}})
        if med not in d['unidade_consumidora']['medidor']:
            d['unidade_consumidora']['medidor'].append(med)
    vis = {}
    for me in d['medicoes']:
        if me['constante'] is not None and me['grandeza'] not in vis:
            vis[me['grandeza']] = me['constante']
    d['unidade_consumidora']['tecnico']['constantes'] = [{'grandeza': k, 'valor': v} for k, v in vis.items()]


AVISO = re.compile(r'^(Atraso no pagamento|Aviso importante|Excepcionalmente|Considerar quitada|Essa fatura|'
                   r'Informa\S+es dos d\S+bitos|Conf\. Art|'
                   r'Em cumprimento|Em virtude|Indicadores de Continuidade|Informa\S+es de pagamento|Prezado|'
                   r'Conforme|Bandeira|Cobran\S+a|Fatura|Parcelamento|Comunicamos|Informamos)')


def _avisos(pags, d):
    vistos = set()
    for np_, t in pags:
        if not t:
            continue
        for coluna in ((0, 298), (298, 600)):
            ws = [w for w in t if coluna[0] <= w.x0 < coluna[1]]
            par, y_ult = [], None
            def fecha():
                if par:
                    s = re.sub(r'\s+', ' ', ' '.join(par)).strip()
                    if AVISO.match(s) and s[:50] not in vistos:
                        vistos.add(s[:50])
                        d['mensagens'].append({'pagina': np_, 'texto': s})
            for y, g in _grupos(ws):
                s = _txt(g)
                if par and (y - y_ult > 10 or AVISO.match(s)):
                    fecha()
                    par = []
                par.append(s)
                y_ult = y
            fecha()
        if any(w.t == 'Informações' for w in t) and 'Informações de pagamento na página' in _txt(t):
            pass


def _pagina3(pags, d):
    gd = d['gd']
    ref = d['referencia']['mes_referencia']
    for np_, t in pags[1:]:
        tx = _txt(sorted(t, key=lambda w: (round(w.y1), w.x0)))
        if 'Participação' not in tx and 'Saldo em Energia' not in tx:
            continue
        mm = re.search(r'Participa\S+:\s*([\d.,]+)%', tx)
        if mm:
            d['unidade_consumidora']['geracao']['modalidade_gd'] = 'Micro e Mini Geração'
            gd['participacao_pct'] = num(mm[1])
            d['outros'].append({'pagina': np_, 'secao_impressa': 'Micro e Mini Geração', 'rotulo': 'Participação',
                                'valor': mm[1] + '%'})
        for po, rot in (('PONTA', 'Ponta'), ('FORA_PONTA', 'FPonta')):
            mm = re.search(r'kWh Injetado ' + rot + r'\s+([\d.,]+)', tx)
            if mm:
                gd['lancamentos'].append({'pagina': np_, 'tipo': 'injetada', 'posto': po, 'kwh': num(mm[1]),
                                          'mes_ref': ref, 'ref_expiracao': None, 'unidade_impressa': 'kWh',
                                          'rotulo': f'kWh Injetado {rot} {mm[1]}'})
        tx_e = _txt(sorted([w for w in t if w.x0 < 298], key=lambda w: (round(w.y1), w.x0)))
        mm = re.search(r'Saldo em Energia da Instala\S+:\s*Ponta\s+([\d.,]+)\s*kWh\s+Fora Ponta\s+([\d.,]+)\s*kWh', tx_e)
        if mm:
            for po, v, rot in (('PONTA', mm[1], f'Saldo em Energia da Instalação: Ponta {mm[1]} kWh'),
                               ('FORA_PONTA', mm[2], f'Fora Ponta {mm[2]} kWh')):
                gd['lancamentos'].append({'pagina': np_, 'tipo': 'saldo_atual', 'posto': po, 'kwh': num(v),
                                          'mes_ref': None, 'ref_expiracao': None, 'unidade_impressa': 'kWh',
                                          'rotulo': rot})
        for mm in re.finditer(r'Saldo a expirar pr\S+ximo m\S+s:\s*(?:Ponta\s+)?([\d.,]+)\s*kWh(?:\s+Fora Ponta\s+([\d.,]+)\s*kWh)?', tx_e):
            gd['lancamentos'].append({'pagina': np_, 'tipo': 'a_expirar', 'posto': 'PONTA' if mm[2] else None,
                                      'kwh': num(mm[1]), 'mes_ref': None, 'ref_expiracao': 'próximo mês',
                                      'unidade_impressa': 'kWh', 'rotulo': mm[0]})
            if mm[2]:
                gd['lancamentos'].append({'pagina': np_, 'tipo': 'a_expirar', 'posto': 'FORA_PONTA', 'kwh': num(mm[2]),
                                          'mes_ref': None, 'ref_expiracao': 'próximo mês', 'unidade_impressa': 'kWh',
                                          'rotulo': mm[0]})
        mm = re.search(r'Energia Ativa \d+ (\w+)(?: (P\d))? (\d+) Dias', tx)
        if mm:
            cor = sem_acento(mm[1]).upper()
            if cor == 'VERMELHA':
                cor = 'VERMELHA_' + (mm[2][1] if mm[2] else '1')
            d['bandeiras'].append({'pagina': np_, 'cor': cor, 'inicio': None, 'fim': None, 'dias': int(mm[3])})
        mm = re.search(r'Taxa de perda\s+([\d.,]+)', tx)
        if mm:
            d['unidade_consumidora']['tecnico']['perdas_transformacao_pct'] = num(mm[1])
        # histórico: linhas "MÊS AA consumoP dias MÊS AA consumoFP dias MÊS AA demanda dias"
        mwh = '[MWh]' in tx
        for y, g in _grupos(t):
            s = _txt(g)
            mm = re.match(r'(' + MES3 + r') (\d\d) ([\d.,]+) (\d+) ' + MES3 + r' \d\d ([\d.,]+) (\d+) ' + MES3 +
                          r' \d\d ([\d.,]+) (\d+)$', s)
            if mm:
                mes = mes_ano(f'{mm[1]}/{mm[2]}')
                for serie, posto, v, un in (('consumo', 'PONTA', mm[3], 'kWh'), ('consumo', 'FORA_PONTA', mm[5], 'kWh'),
                                            ('demanda', None, mm[7], 'kW'), ('dias', None, mm[4], 'dias')):
                    val = num(v)
                    uo = 'Nº DIAS FAT' if serie == 'dias' else un
                    if mwh and serie == 'consumo' and val is not None:
                        val, uo = round(val * 1000, 3), 'MWh'
                    d['historico'].append({'pagina': np_, 'mes': mes, 'serie': serie, 'posto': posto, 'valor': val,
                                           'unidade': un, 'unidade_original': uo, 'faturado_pela_media': False})
        d['historico_formato'] = 'tabela' if d['historico'] else 'ausente'
        return


def _pagamento(pags, d, doc_txt=None):
    pag = d['pagamento']
    doc_txt = doc_txt or [''] * len(pags)
    for np_, t in pags[1:]:
        tx = _txt(sorted(t, key=lambda w: (round(w.y1), w.x0)))
        mm = re.search(r'D\S+bito Autom\S+tico .*?Banco (\d{3}) Ag\S+ncia (\d+) (\d{9,})', tx)
        if mm:
            pag['banco'], pag['agencia'] = mm[1], mm[2]
            pag['debito_automatico'] = f'Débito Automático Banco {mm[1]} Agência {mm[2]}; Cód. Déb. Aut. Banco {mm[3]}'
        mm = re.search(r'\b(\d{12} \d{12} \d{12} \d{12})\b', tx)
        if mm:
            pag['linha_digitavel'] = mm[1]
        mm = re.search(r'(\d{3}-\d) (\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14})', tx)
        if mm:
            pag['linha_digitavel'] = mm[2]
            bol = {'nosso_numero': None, 'numero_documento': None, 'carteira': None, 'especie': None, 'aceite': None,
                   'data_documento': None, 'data_processamento': None, 'beneficiario': None,
                   'agencia_codigo_beneficiario': None, 'pagador': None, 'local_pagamento': None, 'instrucoes': None}
            m2 = re.search(r'(PAGAR PREFERENCIALMENTE [A-ZÀ-Ú ]+?)\s+(?:Benefici|\d)', tx)
            bol['local_pagamento'] = m2[1].strip() if m2 else None
            m2 = re.search(r'(\d{4}/\d{5,}-\d)', tx)
            bol['agencia_codigo_beneficiario'] = m2[1] if m2 else None
            m2 = re.search(r'(Cia Paulista de For\S+a Luz|Cia Piratininga de For\S+a e Luz|[A-Z][\w ]+ de For\S+a e? ?Luz)\s+([\d./-]{18})', tx)
            bol['beneficiario'] = f'{m2[1]} {m2[2]}' if m2 else None
            m2 = re.search(r'(\d\d/\d\d/\d{4}) (\d{8,}) (\w{1,3}) (\w) (\d\d/\d\d/\d{4}) ([\d/-]{10,})', tx)
            if m2:
                bol['data_documento'], bol['numero_documento'] = data_br(m2[1]), m2[2]
                bol['especie'], bol['aceite'] = m2[3], m2[4]
                bol['data_processamento'], bol['nosso_numero'] = data_br(m2[5]), m2[6]
                pag['numero_fatura'] = m2[2]
            else:  # rótulos em texto (Itaú): valor na linha seguinte ao rótulo
                bruto = [x.strip() for x in doc_txt[np_ - 1].split('\n')]
                def apos(rot):
                    for k, x in enumerate(bruto):
                        if x.startswith(rot):
                            resto = x[len(rot):].strip()
                            if resto:
                                return resto
                            return next((y for y in bruto[k + 1:k + 3] if y), None)
                    return None
                dd = apos('Data de Documento')
                bol['data_documento'] = data_br(dd) if dd else None
                bol['numero_documento'] = pag['numero_fatura'] = apos('Nº de Documento')
                bol['aceite'] = apos('Aceite')
                dp = apos('Data do processamento')
                bol['data_processamento'] = data_br(dp) if dp else None
                bol['nosso_numero'] = apos('Nosso Número')
                bol['carteira'] = apos('Carteira')
                bol['especie'] = apos('Espécie') if apos('Espécie') and len(apos('Espécie')) <= 3 else None
                ag = apos('Agência/Código do Beneficiário')
                if ag:
                    bol['agencia_codigo_beneficiario'] = ag
                    pag['agencia'] = ag.split('/')[0]
            m2 = re.search(r'\b(\d{2,3}) R\$ ([\d.]+,\d\d)\b', tx)
            bol['carteira'] = m2[1] if m2 else None
            m2 = re.search(r'(ATRASO NO PAGAMENTO .*?VIGENTE)', tx)
            bol['instrucoes'] = m2[1] if m2 else None
            m2 = re.search(r'Pagador\s+(.*?)\s+C\S+digo de Baixa', tx)
            bol['pagador'] = re.sub(r'\s+', ' ', m2[1]).strip() if m2 else None
            pag['banco'] = next((w.t for w in t if w.t == mm[1]), mm[1])
            pag['boleto'] = bol
        if 'PIX' in tx and re.search(r'Pague aqui', tx, re.I):
            pag['pix'] = 'QR Code "PIX - Pague Aqui" (conteúdo não impresso)'
        mm = re.search(r'(Essa fatura est\S+ com d\S+bito autorizado em conta corrente\..*?pagamento\.)', tx)
        if mm and not pag.get('debito_automatico'):
            pag['debito_automatico'] = mm[1]
        mdeb = re.search(r'Informa\S+es dos d\S+bitos mais antigos:(.*?)(?:Participa|Conf\.|Autentica|Saldo|$)',
                         doc_txt[np_ - 1], re.S)
        if mdeb:
            for venc, val in re.findall(r'(\d\d/\d\d/\d{4})\s+(?:R\$\s*)?([\d.]+,\d\d)', mdeb[1]):
                d['debitos_pendentes'] = d.get('debitos_pendentes') or []
                d['debitos_pendentes'].append({'referencia': None, 'vencimento': data_br(venc), 'data_reaviso': None,
                                               'valor': num(val)})
    pag.setdefault('conta_recebedora', None)
