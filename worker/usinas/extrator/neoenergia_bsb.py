"""Parser determinístico do DANFE "verde antigo" da Neoenergia Distribuição Brasília (formulário sem rótulos em texto).

Tudo é lido por posição: cliente (x≈44), UC/código do cliente (x≈250), NF3e/chave/protocolo (x≈373), referência/total/
vencimento (y≈151), classificação (y≈174), datas de leitura, itens (y≈235 até TOTAL), tributos e grandezas contratadas
(x≥430), medições (y≈370–400), quadro de GD (x≥405), demonstrativo de consumo e fator de carga (p2) e envelope (p3).
"""
import re

from base import data_br, e_numero, esqueleto, linhas, num, palavras
from neoenergia import _col, _grupos, _posto, _txt, componente_de

NOME = 'neoenergia_bsb_v1'
MESES = {'JAN': '01', 'FEV': '02', 'MAR': '03', 'ABR': '04', 'MAI': '05', 'JUN': '06', 'JUL': '07', 'AGO': '08',
         'SET': '09', 'OUT': '10', 'NOV': '11', 'DEZ': '12'}


def detecta(texto, doc=None):
    if 'ITENS DA FATURA' in texto:
        return False
    return 'Neoenergia Distribuição Brasília' in texto or bool(re.search(r'\d{6}07522669000192\d{24}', texto)) or \
        ('HORARIA' in texto and 'CPF/CNPJ:' in texto and bool(re.search(r'\b7\d{4}-?\d{3}\b', texto)))


def _ancoras(ws, n, padrao):
    """Âncoras (x1) das colunas numéricas: agrupa os x1 dos números; usa o padrão se não achar n colunas."""
    x1s = sorted(w.x1 for w in ws if e_numero(w.t))
    grp = []
    for x in x1s:
        if grp and x - grp[-1][-1] <= 8:
            grp[-1].append(x)
        else:
            grp.append([x])
    grp = [g for g in grp if len(g) >= 2]
    if len(grp) == n:
        return {k: sorted(g)[len(g) // 2] for k, g in zip(padrao, grp)}
    return padrao


def _linha(t, y0, y1, x0=0, x1=600):
    return _txt(sorted([w for w in t if y0 <= w.y1 <= y1 and x0 <= w.x0 < x1], key=lambda w: w.x0))


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
    t1 = pags[0][1]
    d['extracao']['paginas_lidas'] = [p for p, _ in pags]
    d['extracao']['paginas'] = [{'pagina': p, 'tipo': 'conteudo' if t else 'em_branco', 'repete_pagina': None}
                                for p, t in pags]
    doc_, nf, uc_, tit, ref, tot = (d['documento'], d['documento']['nota_fiscal'], d['unidade_consumidora'],
                                    d['titular'], d['referencia'], d['totais'])
    # emitente
    em = [_linha(t1, y - 2, y + 2, 210, 420) for y in (29, 35, 42, 49, 56)]
    doc_['distribuidora'] = em[0] or 'Neoenergia Distribuição Brasília S.A.'
    doc_['distribuidora_endereco'] = ' '.join(x for x in em[1:4] if x) or None
    mm = re.search(r'CNPJ:\s*([\d./-]{18})', em[4])
    doc_['distribuidora_cnpj'] = mm[1] if mm else '07.522.669/0001-92'
    doc_['distribuidora_sigla'] = 'NEOENERGIA BRASILIA'
    nf['modelo'] = 'DANFE - DOCUMENTO AUXILIAR DA NOTA FISCAL DE ENERGIA ELETRICA ELETRÔNICA'
    # cliente
    cli = [(y, _txt(g)) for y, g in _grupos([w for w in t1 if 65 < w.y1 < 135 and w.x0 < 215])]
    if cli:
        tit['nome'] = cli[0][1]
        end = []
        for y, x in cli[1:]:
            mm = re.match(r'CPF/CNPJ:\s*(\S+)', x)
            if mm:
                tit['cnpj_cpf'] = mm[1]
            elif x != '/DF':
                end.append(x)
        tit['uf'] = 'DF'
        if end:
            mm = re.match(r'(.*?)\s+(\d{8})$', end[-1])
            m2 = re.match(r'(\d{5}-\d{3})\s*-\s*(.*?)\s+(\S+)$', end[-1])
            m3 = re.match(r'(\d{8})\s+(.*?)(?:\s+DF)?$', end[-1])
            if m3:
                tit['cep'], tit['cidade'] = m3[1], m3[2]
                tit['endereco'] = ' '.join(end[:-1]) or None
            elif mm:
                tit['cidade'], tit['cep'] = mm[1], mm[2]
                tit['endereco'] = ' '.join(end[:-1]) or None
            elif m2:
                tit['cep'], tit['cidade'] = m2[1], m2[3]
                tit['endereco'] = ' '.join(end[:-1] + [m2[2]])
            else:
                tit['endereco'] = ' '.join(end)
            uc_['endereco'] = ' '.join(end)
    uc_['uc'] = uc_['instalacao'] = next((w.t for w in t1 if 80 < w.y1 < 95 and 225 < w.x0 < 300 and w.t.isdigit()), None)
    cc = _linha(t1, 112, 124, 225, 300)
    tit['codigo_cliente'] = cc or None
    # NF3e
    tn = ' '.join(_txt(g) for y, g in _grupos([w for w in t1 if 60 < w.y1 < 148 and w.x0 >= 350]))
    mm = re.search(r'N\S*\s*(\d+)\s*-\s*S\S*RIE\s*(\d+)\s*[/-]?\s*DATA DE EMISS\S*?:?\s*(\d\d/\d+)\s*(/\d{4}|\d?/\d{4})?', tn)
    if mm:
        dt = mm[3] + (mm[4] or '')
        nf['numero'], nf['serie'] = mm[1], mm[2]
        nf['data_emissao'] = ref['data_emissao'] = data_br(dt) if re.fullmatch(r'\d\d/\d\d/\d{4}', dt) else None
    mm = re.search(r'(https?://\S+)', tn)
    nf['url_consulta'] = mm[1] if mm else None
    mm = re.search(r'(?:NF3E)?\d{44}', tn)
    nf['chave_acesso'] = mm[0] if mm else None
    mm = re.search(r'(?i)Autoriza\S*:?\s*(\d+)\s*-\s*(\d\d/\d\d/\d{4})\s*(?:\S+\s*)?(\d\d:\d\d:\d\d)?', tn)
    if mm:
        nf['protocolo_autorizacao'] = mm[1]
        nf['data_autorizacao'] = f'{data_br(mm[2])}T{mm[3]}' if mm[3] else data_br(mm[2])
    # referência / total / vencimento
    mm = re.search(r'([A-Z]{3})/(\d{4})\s+(?:R\$\s*)?([\d.]+,\d\d)\s+(\d\d/\d\d/\d{4})', _linha(t1, 146, 157))
    if mm and mm[1] in MESES:
        ref['mes_referencia'] = f'{mm[2]}-{MESES[mm[1]]}'
        tot['total_a_pagar'] = num(mm[3])
        ref['data_vencimento'] = data_br(mm[4])
    # classificação
    cl = _linha(t1, 170, 178, 0, 370)
    tt = _linha(t1, 170, 178, 370)
    uc_['classificacao'] = cl or None
    uc_['tipo_tarifa_impresso'] = uc_['tipo_fornecimento'] = tt or None
    mm = re.match(r'([AB]\d\w?)\s+([A-ZÀ-Ú]+)\s*/\s*(.*)', cl)
    if mm:
        uc_['subgrupo'], uc_['grupo'], uc_['classe'], uc_['subclasse'] = mm[1], mm[1][0], mm[2], mm[3]
    mm = re.search(r'(VERDE|AZUL|CONVENCIONAL|BRANCA)', tt)
    uc_['modalidade_tarifaria'] = mm[1].capitalize() if mm else None
    # datas de leitura (y≈190 a 214, conforme o modelo)
    for y, g in _grupos([w for w in t1 if 180 < w.y1 < 225]):
        s = _txt(g)
        mm = re.match(r'(\d\d/\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+(\d+)\s+(\d\d/\d\d/\d{4})$', s)
        if mm:
            ref.update({'leitura_anterior': data_br(mm[1]), 'leitura_atual': data_br(mm[2]), 'dias_faturados': int(mm[3]),
                        'proxima_leitura': data_br(mm[4])})
            ref['ciclo'] = f'{data_br(mm[1])} a {data_br(mm[2])}'
    uc_['tecnico'] = {'tensao_nominal': None, 'tensao_contratada_v': None, 'tensao_fornecimento_kv': None,
                      'tensao_minima': None, 'tensao_maxima': None, 'faixa_adequada': None,
                      'fator_potencia_referencia': None, 'rtc': None, 'rtp': None, 'constantes': [],
                      'perdas_transformacao_pct': None, 'horario_ponta': None, 'equipamento_medidor': None,
                      'responsavel_iluminacao_publica': None}
    _itens(t1, d)
    _direita(t1, d)
    _medicoes(t1, d)
    if len(pags) > 1:
        _demonstrativo(pags[1][1], d, 2)
    _rodape(t1, brutos, d)
    if len(pags) > 2:
        _envelope(pags[2][1], brutos[2], d)
    verde = uc_['modalidade_tarifaria'] == 'Verde'
    for it in d['itens']:
        if it['componente'] in ('DEMANDA', 'DEMANDA_ULTRAPASSAGEM') and verde and not it['posto']:
            it['posto'] = 'FORA_PONTA'
        if it['componente'].startswith('DEMANDA_GERACAO'):
            it['posto'] = 'GERACAO'
    dm = next((m for m in d['medicoes'] if m['grandeza'] == 'DEMANDA'), None)
    it_d = next((i for i in d['itens'] if i['componente'] == 'DEMANDA'), None)
    for x in d['demanda']:
        if x['tipo'] == 'consumo':
            x['medida_kw'] = dm['consumo'] if dm else None
            x['faturada_kw'] = it_d['quantidade_faturada'] if it_d else None
    uc_['geracao']['e_gerador'] = any(m['grandeza'].startswith('ENERGIA INJETADA') for m in d['medicoes']) or \
        any(i['componente'].startswith('DEMANDA_GERACAO') for i in d['itens'])
    d['historico_formato'] = 'so_grafico'
    _provas(d)
    return d


ANC = {'quant': 176, 'preco': 211, 'valor': 258, 'pis_cofins': 298, 'base_icms': 337, 'aliquota_icms': 360,
       'icms': 400, 'tarifa': 428}
ANC_B = {'quant': 209, 'preco': 248, 'valor': 279, 'pis_cofins': 310, 'base_icms': 341, 'aliquota_icms': 366,
         'icms': 396, 'tarifa': 426}  # modelo com a unidade em x≈170


def _itens(t1, d):
    tw = next((w for w in t1 if w.t == 'TOTAL' and w.x0 < 60 and 300 < w.y1 < 370), None)
    tap = tw is not None and any(w.t == 'PAGAR' and abs(w.y1 - tw.y1) < 2 for w in t1)
    y_fim = tw.y1 - 3 if tw else 345
    ws = [w for w in t1 if 228 < w.y1 < y_fim and w.x0 < 432]
    unids = [w for w in ws if re.fullmatch(r'(?i)kwh|kw|kvarh|kvar', w.t) and 110 < w.x0 < 185]
    un_x = max((w.x1 for w in unids), default=135)
    anc = ANC_B if un_x > 160 else ANC
    for y, g in _grupos(ws, 1.6):
        unid = next((w.t for w in g if w in unids), None)
        desc = _txt([w for w in g if w.x1 < un_x - 12 or (w.x0 < un_x and not e_numero(w.t) and w.t != unid)])
        nums = [w for w in g if w.x0 > un_x + 5 and e_numero(w.t)]
        if not desc:
            continue
        cols = _col(nums, anc)
        comp, posto = componente_de(desc)
        if not nums:
            comp = 'INFO' if comp == 'AJUSTE' else comp
        d['itens'].append({'pagina': 1, 'secao_impressa': None, 'codigo': None, 'descricao': desc, 'mes_ref': None,
                           'componente': comp, 'posto': posto, 'quantidade_registrada': None,
                           'quantidade_faturada': num(cols.get('quant')), 'unidade': unid,
                           'tarifa_com_tributos': num(cols.get('preco'), ponto_decimal=True),
                           'tarifa_sem_tributos': num(cols.get('tarifa'), ponto_decimal=True),
                           'valor': num(cols.get('valor')), 'valor_sem_tributos': None,
                           'base_icms': num(cols.get('base_icms')), 'aliquota_icms': num(cols.get('aliquota_icms')),
                           'icms': num(cols.get('icms')), 'base_pis_cofins': None, 'aliquota_pis': None, 'pis': None,
                           'aliquota_cofins': None, 'cofins': None, 'pis_cofins': num(cols.get('pis_cofins')),
                           'nf_referencia': None,
                           'colunas_originais': {'DESCRIÇÃO': desc, 'UNID.': unid, **cols}})
    for it in d['itens']:
        it['mes_ref'] = d['referencia']['mes_referencia']
    ilum = [i['valor'] for i in d['itens'] if i['componente'] == 'ILUMINACAO_PUBLICA' and i['valor'] is not None]
    d['totais']['valor_cosip_cip'] = None
    if tw:
        v = _linha(t1, tw.y1 - 2, tw.y1 + 2, 150, 300)
        if tap:
            v = ''  # "TOTAL A PAGAR" (não é o total da tabela)
        if re.fullmatch(r'-?[\d.]+,\d\d', v):
            d['totais']['total_nota_fiscal'] = num(v)
            d['totais']['totais_colunas'].append({'pagina': 1, 'coluna': 'VALOR (R$) - TOTAL', 'valor': num(v)})
        elif v:
            d['extracao']['observacoes'].append(f'TOTAL da tabela de itens com fonte ilegível no texto do PDF ({v!r}).')
    del ilum


def _direita(t1, d):
    tab = {'pagina': 1, 'nome': 'GRANDEZAS CONTRATADAS', 'linhas': []}
    for y, g in _grupos([w for w in t1 if w.x0 >= 430 and 235 < w.y1 < 345]):
        s = _txt(g)
        mm = re.match(r'(PIS|COFINS|ICMS)\s+([\d.,]+)\s+([\d.,]+)(%?)\s+([\d.,]+)$', s)
        if mm:
            d['tributos'].append({'pagina': 1, 'tributo': mm[1], 'base': num(mm[2]), 'aliquota': num(mm[3]),
                                  'valor': num(mm[5]), 'retido': False,
                                  'colunas_originais': {'TRIBUTO': mm[1], 'BASE DE CÁLCULO (R$)': mm[2],
                                                        'ALÍQUOTA (%)': mm[3] + mm[4], 'VALOR (R$)': mm[5]}})
            continue
        mm = re.match(r'(DEMANDA.*?)\s+([\d.,]+)$', s)
        if mm:
            inj = 'GERA' in mm[1] or 'INJ' in mm[1]
            tab['linhas'].append({'colunas_originais': {'Grandeza': mm[1], 'CONSUMO FATURADO': mm[2], 'Nº DIAS FAT': None}})
            d['demanda'].append({'pagina': 1, 'tipo': 'injecao' if inj else 'consumo',
                                 'posto': 'GERACAO' if inj else _posto(mm[1]), 'contratada_kw': num(mm[2]),
                                 'medida_kw': None, 'faturada_kw': None, 'faturada_ultrapassagem_kw': None,
                                 'nao_consumida_kw': None, 'data_hora': None, 'rotulo': mm[1],
                                 'colunas_originais': {'GRANDEZAS CONTRATADAS': mm[1], 'CONSUMO FATURADO': mm[2]}})
    if tab['linhas']:
        d['tabelas_complementares'].append(tab)


def _medicoes(t1, d):
    ns = {'leitura_anterior': 207, 'leitura_atual': 236, 'constante': 265, 'consumo': 297}
    ws = [w for w in t1 if 365 < w.y1 < 410 and w.x0 < 305]
    grupos = _grupos(ws, 1.6)
    med = next((w.t for w in ws if w.x0 < 78 and re.fullmatch(r'\d{5,}', w.t)), None)
    for y, g in grupos:
        gr = _txt([w for w in g if 78 <= w.x0 < 141 and not e_numero(w.t)])
        po = _txt([w for w in g if 141 <= w.x0 < 180])
        nums = [w for w in g if w.x0 >= 175 and re.fullmatch(r'[\d.]*,\d+|[\d.]+', w.t)]
        if not gr or len(nums) < 3:
            continue
        cols = _col(nums, ns)
        cols = {k: ('0' + v if v.startswith(',') else v) for k, v in cols.items()}
        d['medicoes'].append({'pagina': 1, 'tabela_origem': 'MEDIDOR / GRANDEZAS / POSTOS HORÁRIOS', 'medidor': med,
                              'grandeza': gr, 'posto': _posto(po), 'leitura_anterior': num(cols.get('leitura_anterior')),
                              'leitura_atual': num(cols.get('leitura_atual')),
                              'constante': num(cols.get('constante'), ponto_decimal=False),
                              'perdas_pct': None, 'ajuste': None, 'consumo': num(cols.get('consumo')),
                              'consumo_faturado': None, 'fator_potencia': None, 'ajuste_fator_potencia': None,
                              'unidade': 'kW' if gr.startswith('DEMANDA') else ('kVArh' if 'REAT' in gr else 'kWh'),
                              'data_hora_registro': None, 'leitura_arredondada': False,
                              'colunas_originais': {'MEDIDOR': med, 'GRANDEZAS': gr, 'POSTOS HORÁRIOS': po, **cols}})
    if med:
        d['unidade_consumidora']['medidor'].append(med)
    vis = []
    for m in d['medicoes']:
        if m['constante'] is not None and (m['grandeza'], m['constante']) not in vis:
            vis.append((m['grandeza'], m['constante']))
    d['unidade_consumidora']['tecnico']['constantes'] = [{'grandeza': g_, 'valor': v} for g_, v in vis]
    gd = d['gd']
    tipos = (('SALDO ANTERIOR', 'saldo_anterior'), ('TRANSF', 'transferida'), ('INJETADO', 'injetada'),
             ('COMPENSADO', 'compensada'), ('SALDO ATUAL', 'saldo_atual'))
    for y, g in _grupos([w for w in t1 if w.x0 >= 400 and 405 < w.y1 < 450]):
        s = _txt(g)
        mm = re.match(r'(.*?:)\s*(-?[\d.]+)\s*(\(-\))?$', s)
        if not mm:
            continue
        tipo = next((t for k, t in tipos if s.replace('(', ' (').startswith(k)), 'outro')
        v = num(mm[2])
        gd['lancamentos'].append({'pagina': 1, 'tipo': tipo, 'posto': None, 'kwh': -v if mm[3] else v, 'mes_ref': None,
                                  'ref_expiracao': None, 'unidade_impressa': None, 'rotulo': s})


def _demonstrativo(t, d, np_):
    med = _linha(t, 242, 248, 40, 200)
    mm = re.search(r'MEDIDOR\s*-\s*(\d+)', med)
    med = mm[1] if mm else None
    cab = {'pagina': np_, 'nome': 'DEMONSTRATIVO DE CONSUMO - cabeçalho', 'linhas': []}
    for y0, rot, rx in ((242, 'Nº MEDIDOR', r'MEDIDOR\s*-\s*(\d+)'), (247, 'CICLO', r'CICLO\s*-\s*(.+)'),
                        (252, 'DIAS', r'DIAS\s*-\s*(\d+)')):
        mm = re.search(rx, _linha(t, y0, y0 + 6, 40, 200))
        if mm:
            cab['linhas'].append({'colunas_originais': {'DESCRIÇÃO': rot, 'valor': mm[1].strip()}})
    if cab['linhas']:
        d['tabelas_complementares'].append(cab)
    ns = {'leitura_anterior': 235, 'leitura_atual': 272, 'constante': 323, 'ajuste': 360, 'consumo': 401}
    for y, g in _grupos([w for w in t if 258 < w.y1 < 345 and w.x0 < 410], 1.6):
        desc = _txt([w for w in g if w.x0 < 200 and not e_numero(w.t)])
        nums = [w for w in g if w.x0 >= 195 and e_numero(w.t)]
        if not desc or len(nums) < 3:
            continue
        cols = _col(nums, ns)
        d['medicoes'].append({'pagina': np_, 'tabela_origem': 'DEMONSTRATIVO DE CONSUMO', 'medidor': med, 'grandeza': desc,
                              'posto': _posto(desc) or ('FORA_PONTA' if desc == 'DEMANDA' else None),
                              'leitura_anterior': num(cols.get('leitura_anterior')),
                              'leitura_atual': num(cols.get('leitura_atual')), 'constante': num(cols.get('constante')),
                              'perdas_pct': None, 'ajuste': num(cols.get('ajuste')), 'consumo': num(cols.get('consumo')),
                              'consumo_faturado': None, 'fator_potencia': None, 'ajuste_fator_potencia': None,
                              'unidade': 'kW' if desc.startswith('DEMANDA') else ('kVArh' if 'REAT' in desc else 'kWh'),
                              'data_hora_registro': None, 'leitura_arredondada': False,
                              'colunas_originais': {'DESCRIÇÃO': desc, **cols}})
    fc = next((w for w in t if w.t == 'FATOR' and w.x0 > 400), None)
    if fc:
        lin = _linha(t, fc.y1 + 2, fc.y1 + 9, 400)
        for mm in re.finditer(r'(NA PONTA|FORA DE PONTA):\s*([\d,]+)', lin):
            d['informacoes_consumo'].append({'pagina': np_, 'rotulo': 'FATOR DE CARGA', 'posto': _posto(mm[1]),
                                             'valor': num(mm[2]), 'unidade': None})
    for m in d['medicoes']:
        if m['grandeza'] == 'DEMANDA' and m['posto'] is None:
            m['posto'] = 'FORA_PONTA'


def _rodape(t1, brutos, d):
    pag = d['pagamento']
    tudo = re.sub(r'\s+', ' ', brutos[0])
    mm = re.search(r'\b(\d{12} \d{12} \d{12} \d{12})\b', tudo) or \
        re.search(r'\b(\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14})\b', tudo)
    pag['linha_digitavel'] = mm[1] if mm else None
    if 'PARA CADASTRAR SUA CONTA EM DÉBITO AUTOMÁTICO' in tudo:
        d['mensagens'].append({'pagina': 1, 'texto': 'PARA CADASTRAR SUA CONTA EM DÉBITO AUTOMÁTICO, UTILIZE O CÓDIGO DO CLIENTE.'})
        pag['debito_automatico'] = 'PARA CADASTRAR SUA CONTA EM DÉBITO AUTOMÁTICO, UTILIZE O CÓDIGO DO CLIENTE.'
    mm = re.search(r'(CONTA PARA ACOMPANHAMENTO\..*?VENCIMENTO)', tudo)
    if mm:
        d['mensagens'].append({'pagina': 1, 'texto': mm[1]})
        pag['debito_automatico'] = mm[1]
    pag.setdefault('conta_recebedora', None)
    mes = next((w.t for w in t1 if 565 < w.y1 < 576 and re.fullmatch(r'[A-ZÇ]+/\d{4}', w.t)), None)
    if mes:
        d['outros'].append({'pagina': 1, 'secao_impressa': 'Rodapé', 'rotulo': 'Mês por extenso', 'valor': mes})


def _envelope(t3, bruto, d):
    ent = d['entrega']
    bl = [(y, _txt(g)) for y, g in _grupos([w for w in t3 if 425 < w.y1 < 490 and 140 < w.x0 < 320])]
    if bl:
        ent['unidade_entrega'] = bl[0][1]
        ent['endereco_correspondencia'] = ' '.join(x for _, x in bl[1:]) or None
    ent['sequencia'] = next((w.t for w in t3 if 425 < w.y1 < 490 and w.x0 < 140 and re.fullmatch(r'\d{6,}', w.t)), None)
    mm = re.search(r'(NEOENERGIA BRASÍLIA - SETOR SMAS.*?GUARÁ - DF)', re.sub(r'\s+', ' ', bruto))
    ent['endereco_devolucao'] = mm[1] if mm else None


def _provas(d):
    div = d['extracao']['divergencias_impressas']
    ref = d['referencia']
    if ref['dias_faturados'] == 0 and ref['leitura_anterior'] and ref['leitura_atual']:
        div.append({'onde': 'dias', 'indice': 0, 'nota': f'Nº de dias impresso 0 com leituras {ref["leitura_anterior"]} '
                    f'a {ref["leitura_atual"]}.'})
    for k, it in enumerate(d['itens']):
        q, t, v = it['quantidade_faturada'], it['tarifa_com_tributos'], it['valor']
        if q == 0 and t == 0 and v and abs(v) > 1 and it['base_icms'] is not None and abs(it['base_icms'] - abs(v)) <= 0.02:
            div.append({'onde': 'item', 'indice': k, 'nota': f'{it["descricao"]}: quantidade e preço unitário impressos 0 '
                        f'com valor {v}; a base de ICMS impressa ({it["base_icms"]}) confirma o valor.'})
