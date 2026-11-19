"""Parser determinístico das faturas CPFL no modelo anterior à NF3e ("Nota Fiscal / Conta de Energia Elétrica",
série C), A4, 4–5 páginas.

p1: NF, correspondência, roteiro/lote/PN/reservado ao fisco, titular, classificação, UC, referência, itens (com
cabeçalho em texto: Cod., Descrição, Mês Ref., Quant. Registrada/Faturada, Unid., Tarifa c/ tributos, Valor, Base
ICMS, Aliq., ICMS, Base PIS/COFINS, PIS x%, COFINS y%), subtotais, Total Consolidado, pagamento; p2 institucional;
p3: demanda contratada, bandeira, participação/injetado, tarifas, datas, medidores, leituras, histórico (consumo
ponta/fora ponta e demanda, com dias), indicadores de continuidade, saldos GD, avisos.
"""
import re

from base import data_br, e_numero, esqueleto, linhas, mes_ano, num, palavras, sem_acento
from cpfl import CNPJS, _grupos, _posto, _txt, componente_de

NOME = 'cpfl_antigo_v1'
MES3 = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ']
EMIT = {'CPFL PAULISTA': ('244.163.955.115',
                          'Rua Jorge de Figueiredo Correa, 1632 Jd. Prof. Tarcília - Campinas - SP - CEP 13087-397')}
NOMES = {'CPFL PAULISTA': 'Companhia Paulista de Força e Luz', 'CPFL PIRATININGA': 'Companhia Piratininga de Força e Luz',
         'CPFL SANTA CRUZ': 'Companhia Jaguari de Energia (CPFL Santa Cruz)'}


def detecta(texto, doc=None):
    return 'Conta de Energia Elétrica' in texto and 'Nota Fiscal' in texto and 'Classificação:' in texto \
        and ('cpfl' in texto.lower() or 'Roteiro de Leitura' in texto)


def _col(ws, anc, tol=12):
    out = {}
    for w in ws:
        k = min(anc, key=lambda c: abs(anc[c] - w.x1))
        if abs(anc[k] - w.x1) <= tol:
            out[k] = w.t if k not in out else out[k] + ' ' + w.t
    return out


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
    todo = '\n'.join(brutos)
    d['extracao']['paginas_lidas'] = [p for p, _ in pags]
    d['extracao']['paginas'] = [{'pagina': p, 'tipo': 'em_branco' if not t else 'conteudo', 'repete_pagina': None}
                                for p, t in pags]
    doc_, nf, uc_, tit, ref, tot = (d['documento'], d['documento']['nota_fiscal'], d['unidade_consumidora'],
                                    d['titular'], d['referencia'], d['totais'])
    cn = next((c for c in CNPJS if c in todo), None)
    if not cn:
        cn = next((c for c, s in CNPJS.items() if s.split()[-1].capitalize() in todo), None)
    doc_['distribuidora_cnpj'] = cn
    doc_['distribuidora_sigla'] = CNPJS.get(cn, 'OUTRA')
    doc_['distribuidora'] = NOMES.get(doc_['distribuidora_sigla'])
    if doc_['distribuidora_sigla'] in EMIT:
        doc_['distribuidora_ie'], doc_['distribuidora_endereco'] = EMIT[doc_['distribuidora_sigla']]
        d['extracao']['observacoes'].append('Nome/IE/endereço do emitente: impressos como imagem no modelo antigo; '
                                            'valores do cabeçalho do DANF3E da mesma distribuidora.')
    nf['modelo'] = 'Conta de Energia Elétrica'
    mm = re.search(r'N\S*\.\s*(\d{6,})\s+s\S*rie\s+(\w+)', tj)
    if mm:
        nf['numero'], nf['serie'] = mm[1], mm[2]
    mm = re.search(r'Data de Emiss\S+\s+(\d\d/\d\d/\d{4})', tj)
    if mm:
        nf['data_emissao'] = ref['data_emissao'] = data_br(mm[1])
    mm = re.search(r'Data de Apresenta\S+\s+(\d\d/\d\d/\d{4})', tj)
    nf['data_apresentacao'] = data_br(mm[1]) if mm else None
    mm = re.search(r'([0-9A-F]{4}(?:\.[0-9A-F]{4}){7})', tj)
    nf['reservado_fisco'] = mm[1] if mm else None
    # correspondência (x≈89, y 85–125)
    corr = [l.texto(80, 380).strip() for l in ls if 85 < l.y < 125 and l.entre(80, 380)]
    d['entrega']['endereco_correspondencia'] = ' '.join(corr) or None
    # roteiro / lote / PN (linha abaixo dos rótulos "Roteiro de Leitura  Lote  PN")
    lr = next((l for l in ls if 165 < l.y < 185 and re.search(r'\w+\d+-\d{6,}', l.texto())), None)
    if lr:
        uc_['roteiro_leitura'] = next((w.t for w in lr.p if re.fullmatch(r'\w+\d+-\d{6,}', w.t)), None)
        uc_['lote'] = next((w.t for w in lr.p if 160 < w.x0 < 200 and w.t.isalpha()), None)
        tit['parceiro_negocio'] = next((w.t for w in lr.p if 200 < w.x0 < 280 and w.t.isdigit()), None)
    # titular (x≈50, y 195–230) e quadro à direita (classificação, CNPJ, conta contrato)
    blt = [l for l in ls if 195 < l.y < 242]
    esq = [l.texto(40, 280).strip() for l in blt if l.texto(40, 280).strip()]
    if esq:
        tit['nome'] = re.split(r'\s+Classifica', blt[0].texto(40, 600))[0].strip() if blt[0].texto(40, 280).strip() == esq[0] else esq[0]
        uc_['endereco'] = ' '.join(esq[1:]) or None
        if len(esq) >= 2:
            mm = re.match(r'(\d{5}-\d{3})\s+(.*?)\s*/\s*([A-Z]{2})$', esq[-1])
            if mm:
                tit['cep'], tit['cidade'], tit['uf'] = mm[1], mm[2], mm[3]
                tit['endereco'] = ' '.join(esq[1:-1]) or None
    dir_ = ' '.join(l.texto(280, 600) for l in blt)
    mm = re.search(r'Classifica\S+:\s*(.*?)\s*(?:CNPJ|CPF|$)', dir_)
    if mm:
        cls = mm[1].strip()
        uc_['classificacao'] = cls
        m2 = re.match(r'(Tarifa (\w+)-([AB]\d\w?))\s+(\S+)(?:\s+(.*))?', cls)
        if m2:
            uc_['tipo_tarifa_impresso'], uc_['modalidade_tarifaria'] = m2[1], m2[2]
            uc_['subgrupo'], uc_['grupo'] = m2[3], m2[3][0]
            uc_['classe'], uc_['subclasse'] = m2[4], m2[5]
    mm = re.search(r'\b(?:CNPJ|CPF):\s*(\S+)', dir_)
    tit['cnpj_cpf'] = mm[1] if mm else None
    mm = re.search(r'Inscri\S+ Estadual:\s*(\S+)', dir_)
    tit['inscricao_estadual'] = mm[1] if mm else None
    mm = re.search(r'Conta Contrato N\S*\.?\s*(\d+)', dir_) or re.search(r'Conta Contrato N\S*\.?\s*(\d+)', tj)
    tit['conta_contrato'] = mm[1] if mm else None
    # linha de referência: PN, UC, mês, vencimento, total
    lref = next((l for l in ls if 250 < l.y < 300 and re.search(r'\b(' + '|'.join(MES3) + r')/\d{4}\b', l.texto())
                 and re.search(r'\d\d/\d\d/\d{4}', l.texto())), None)
    if lref:
        mm = re.search(r'(\d{10})\s+((?:' + '|'.join(MES3) + r')/\d{4})\s+(\d\d/\d\d/\d{4})\s+([\d.]+,\d\d)', lref.texto())
        if mm:
            uc_['uc'] = uc_['instalacao'] = tit['codigo_cliente'] = mm[1]
            ref['mes_referencia'], ref['data_vencimento'] = mes_ano(mm[2]), data_br(mm[3])
            tot['total_a_pagar'] = num(mm[4])
    if doc_['distribuidora_sigla'] == 'OUTRA' and uc_.get('uc'):
        # sem emitente em texto: distribuidora da mesma instalação nas faturas DANF3E (CNPJ da chave de acesso)
        import json as _json, os as _os
        mp = _os.path.join(r'C:\usinas_thopen\dados', 'uc_distribuidora.json')
        mapa = _json.load(open(mp, encoding='utf-8')) if _os.path.exists(mp) else {}
        if uc_['uc'] in mapa:
            doc_['distribuidora_sigla'], doc_['distribuidora_cnpj'] = mapa[uc_['uc']]
            doc_['distribuidora'] = NOMES.get(doc_['distribuidora_sigla'])
            if doc_['distribuidora_sigla'] in EMIT:
                doc_['distribuidora_ie'], doc_['distribuidora_endereco'] = EMIT[doc_['distribuidora_sigla']]
            d['extracao']['observacoes'].append('Distribuidora deduzida pela instalação (faturas DANF3E da mesma UC, '
                                                'CNPJ da chave de acesso); o modelo antigo não imprime o emitente.')
    _itens(t1, d, pags)
    d.pop('_aliq', None)
    for it in d['itens']:
        it['pagina'] = it.pop('pagina_item', 1)
    _pag3(pags, brutos, d)
    _pagamento(brutos, d)
    ilum = [i['valor'] for i in d['itens'] if i['componente'] == 'ILUMINACAO_PUBLICA' and i['valor'] is not None]
    tot['valor_cosip_cip'] = round(sum(ilum), 2) if ilum else None
    uc_['geracao']['e_gerador'] = any(i['componente'] in ('DEMANDA_GERACAO', 'GD_INJETADA') for i in d['itens'])
    return d


def _itens(t1, d, pags=None):
    for np_, t in (pags or [(1, t1)]):
        if _itens_pag(t, d, np_):
            break


def _itens_pag(t1, d, np_):
    """Itens de uma página; True quando achou o "Total a Pagar" (fim da lista)."""
    cab = next((w for w in t1 if w.t == 'Cod.' and w.x0 < 60), None)
    if not cab:
        return False
    hdr = [w for w in t1 if cab.y1 - 2 < w.y1 < cab.y1 + 18]
    pcts = sorted([w for w in hdr if re.fullmatch(r'\d+,\d+%', w.t) and w.x0 > 480], key=lambda w: w.x0)
    al_pis = num(pcts[0].t) if pcts else None
    al_cof = num(pcts[1].t) if len(pcts) > 1 else None
    d['_aliq'] = (al_pis, al_cof) if al_pis is not None else d.get('_aliq', (None, None))
    al_pis, al_cof = d['_aliq']
    anc = {'qreg': 213, 'qfat': 254, 'preco': 301, 'valor': 346, 'base_icms': 390, 'aliquota_icms': 409,
           'icms': 441, 'base_pis_cofins': 486, 'pis': 516, 'cofins': 548}
    sub = next((w for w in t1 if w.t == 'Subtotal' and w.y1 > cab.y1), None)
    tap = next((w for w in t1 if w.t == 'Pagar' and w.y1 > cab.y1 and w.x0 < 120), None)
    y_fim = (tap.y1 + 1) if tap else 552
    corpo = [w for w in t1 if cab.y1 + 3 < w.y1 < y_fim]
    pend = None
    tot = d['totais']
    for y, g in _grupos(corpo, 2.0):
        cod = g[0].t if re.fullmatch(r'\d{3,4}', g[0].t) and g[0].x0 < 60 else None
        if cod == '115' or (g[0].t == '115'):
            mm = re.search(r'N\S*\s+(\d{9,})', _txt(g))
            d['outros'].append({'pagina': 1, 'secao_impressa': 'Descrição da Operação', 'rotulo': 'Cod.', 'valor': '115'})
            if mm:
                d['outros'].append({'pagina': 1, 'secao_impressa': 'Descrição da Operação', 'rotulo': 'Nº', 'valor': mm[1]})
            continue
        desc_ws = [w for w in g if 60 <= w.x0 < 156 or (cod is None and w.x0 < 156)]
        mes_w = next((w for w in g if 150 <= w.x0 < 180 and re.fullmatch(r'[A-Z]{3}/\d{2}', w.t)), None)
        unid = next((w.t for w in g if 255 <= w.x0 < 272 and not e_numero(w.t)), None)
        nums = [w for w in g if w.x0 >= 180 and e_numero(w.t)]
        desc = _txt([w for w in desc_ws if w is not mes_w and w.t != cod])
        cols = _col(nums, anc)
        if not desc and cols and d['itens'] and not cod:  # números soltos da linha de cima/baixo (tarifa, quantidade)
            it = d['itens'][-1]
            for k, v in cols.items():
                campo = {'qreg': 'quantidade_registrada', 'preco': 'tarifa_com_tributos'}.get(k)
                if campo and it.get(campo) is None:
                    it[campo] = num(v)
                    it['colunas_originais'][k] = v
            continue
        if desc in ('Subtotal', 'Total Distribuidora', 'Total a Pagar') or desc.startswith('Total'):
            v = num(cols.get('valor'))
            tot['subtotais'].append({'pagina': 1, 'rotulo': desc, 'valor': v})
            if desc == 'Subtotal':
                tot['subtotal'] = v
            elif desc == 'Total Distribuidora':
                tot['total_distribuidora'] = v
            continue
        if not desc:
            continue
        comp, posto = componente_de(desc)
        pis, cof = num(cols.get('pis')), num(cols.get('cofins'))
        d['itens'].append({'pagina': 1, 'secao_impressa': 'DISCRIMINAÇÃO DA OPERAÇÃO - RESERVADO AO FISCO',
                           'codigo': cod, 'descricao': desc, 'mes_ref': mes_ano(mes_w.t) if mes_w else None,
                           'componente': comp if nums else 'INFO', 'posto': posto,
                           'quantidade_registrada': num(cols.get('qreg')), 'quantidade_faturada': num(cols.get('qfat')),
                           'unidade': unid, 'tarifa_com_tributos': num(cols.get('preco')), 'tarifa_sem_tributos': None,
                           'valor': num(cols.get('valor')), 'valor_sem_tributos': None,
                           'base_icms': num(cols.get('base_icms')), 'aliquota_icms': num(cols.get('aliquota_icms')),
                           'icms': num(cols.get('icms')), 'base_pis_cofins': num(cols.get('base_pis_cofins')),
                           'aliquota_pis': al_pis if pis is not None else None, 'pis': pis,
                           'aliquota_cofins': al_cof if cof is not None else None, 'cofins': cof, 'pis_cofins': None,
                           'nf_referencia': None,
                           'pagina_item': np_,
                           'colunas_originais': {'Cod.': cod, 'Descrição da Operação': desc,
                                                 'Mês Ref.': mes_w.t if mes_w else None, 'Unid. Med.': unid, **cols}})
    # Total Consolidado: números na linha logo acima do rótulo
    tc = next((w for w in t1 if w.t == 'Consolidado' and w.x0 < 120), None)
    if tc and tap:
        ns = [w for w in t1 if abs(w.y1 - tc.y1) < 3 and e_numero(w.t) and w.x0 > 280]
        cols = _col(ns, anc)
        rot = {'valor': 'Valor Total Operação R$', 'base_icms': 'Base Cálculo ICMS R$', 'icms': 'ICMS',
               'base_pis_cofins': 'Base Cálculo PIS/COFINS', 'pis': f'PIS {al_pis}%', 'cofins': f'COFINS {al_cof}%'}
        for k, v in cols.items():
            if k in rot:
                tot['totais_colunas'].append({'pagina': 1, 'coluna': rot[k], 'valor': num(v)})
        tot['total_consolidado'] = num(cols.get('valor'))
        aliq_icms = {i['aliquota_icms'] for i in d['itens'] if i['icms']}
        if 'icms' in cols:
            d['tributos'].append({'pagina': 1, 'tributo': 'ICMS', 'base': num(cols.get('base_icms')),
                                  'aliquota': aliq_icms.pop() if len(aliq_icms) == 1 else None,
                                  'valor': num(cols['icms']), 'retido': False, 'colunas_originais': {}})
        for k, al_ in (('pis', al_pis), ('cofins', al_cof)):
            if k in cols:
                d['tributos'].append({'pagina': np_, 'tributo': k.upper(), 'base': num(cols.get('base_pis_cofins')),
                                      'aliquota': al_, 'valor': num(cols[k]), 'retido': False, 'colunas_originais': {}})
    return tap is not None


def _pag3(pags, brutos, d):
    ref = d['referencia']
    uc_, gd = d['unidade_consumidora'], d['gd']
    for np_, t in pags[1:]:
        tx = _txt(sorted(t, key=lambda w: (round(w.y1), w.x0)))
        if 'Leitura Anterior' not in tx and 'Participação' not in tx:
            continue
        g = lambda rx: (re.search(rx, tx) or [None, None])[1]
        ref['leitura_anterior'] = data_br(g(r'Leitura Anterior\s+(\d\d/\d\d/\d{4})')) if g(r'Leitura Anterior\s+(\d\d/\d\d/\d{4})') else None
        la = g(r'Leitura Atual\s+(\d\d/\d\d/\d{4})')
        ref['leitura_atual'] = data_br(la) if la else None
        qd = g(r'Qtd de dias\s+(\d+)')
        ref['dias_faturados'] = int(qd) if qd else None
        pl = g(r'Pr\S+xima Leitura Prevista\s+(\d\d/\d\d/\d{4})')
        ref['proxima_leitura'] = data_br(pl) if pl else None
        tec = {'tensao_nominal': None, 'tensao_contratada_v': num(g(r'Contratado\s+([\d.]+)')), 'tensao_fornecimento_kv': None,
               'tensao_minima': num(g(r'M\S+nimo\s+([\d.]+)')), 'tensao_maxima': num(g(r'M\S+ximo\s+([\d.]+)')),
               'faixa_adequada': None, 'fator_potencia_referencia': None, 'rtc': None, 'rtp': None, 'constantes': [],
               'perdas_transformacao_pct': num(g(r'Taxa de perda \(%\)\s+([\d.,]+)')), 'horario_ponta': None,
               'equipamento_medidor': None, 'responsavel_iluminacao_publica': None}
        meds = re.findall(r'Energia (Ativa|Reativa)\s+(\d{6,})', tx)
        if meds:
            tec['equipamento_medidor'] = '; '.join(f'Energia {a} {n}' for a, n in meds)
            for _, n in meds:
                if n not in uc_['medidor']:
                    uc_['medidor'].append(n)
        uc_['tecnico'] = tec
        # demanda contratada (Única / Ponta / Fora Ponta / Geração)
        for y, gg in _grupos([w for w in t if w.x0 < 170 and 150 < w.y1 < 185]):
            s = _txt(gg)
            mm = re.match(r'(Única|Ponta|Fora Ponta|Geração)\s+([\d.,]+)$', s)
            if mm:
                ger = mm[1] == 'Geração'
                d['demanda'].append({'pagina': np_, 'tipo': 'geracao' if ger else 'consumo',
                                     'posto': 'GERACAO' if ger else (_posto(mm[1]) or 'UNICO'),
                                     'contratada_kw': num(mm[2]), 'medida_kw': None, 'faturada_kw': None,
                                     'faturada_ultrapassagem_kw': None, 'nao_consumida_kw': None, 'data_hora': None,
                                     'rotulo': f'Demanda Contratada - {mm[1]}', 'colunas_originais': {mm[1]: mm[2]}})
        # bandeira: "Vermelha P1 : De 01 a 30/06 - 30 Dias"
        for mm in re.finditer(r'(Verde|Amarela|Vermelha|Escassez)(?: (P\d))? : De (\d\d) a (\d\d)/(\d\d) - (\d+) Dias', tx):
            cor = sem_acento(mm[1]).upper()
            if cor == 'VERMELHA':
                cor += '_' + (mm[2][1] if mm[2] else '1')
            ano = (ref['mes_referencia'] or '0000')[:4]
            d['bandeiras'].append({'pagina': np_, 'cor': cor, 'inicio': f'{ano}-{mm[5]}-{mm[3]}',
                                   'fim': f'{ano}-{mm[5]}-{mm[4]}', 'dias': int(mm[6])})
        mm = re.search(r'Participa\S+:\s*([\d.,]+)%', tx)
        if mm:
            gd['participacao_pct'] = num(mm[1])
            uc_['geracao']['modalidade_gd'] = 'Micro e Mini Geração'
            d['outros'].append({'pagina': np_, 'secao_impressa': 'Micro e Mini Geração', 'rotulo': 'Participação',
                                'valor': mm[1] + '%'})
        for po, rot in (('PONTA', 'Ponta'), ('FORA_PONTA', 'FPonta')):
            mm = re.search(r'kWh Injetado ' + rot + r'\s+([\d.,]+)', tx)
            if mm:
                gd['lancamentos'].append({'pagina': np_, 'tipo': 'injetada', 'posto': po, 'kwh': num(mm[1]),
                                          'mes_ref': ref['mes_referencia'], 'ref_expiracao': None,
                                          'unidade_impressa': 'kWh', 'rotulo': f'kWh Injetado {rot} {mm[1]}'})
        b = brutos[np_ - 1]
        mm = re.search(r'Saldo em Energia da Instala\S+:\s*Ponta\s+([\d.,]+)\s*kWh\s+Fora Ponta\s+([\d.,]+)\s*kWh', b)
        if mm:
            gd['lancamentos'].append({'pagina': np_, 'tipo': 'saldo_atual', 'posto': 'PONTA', 'kwh': num(mm[1]),
                                      'mes_ref': None, 'ref_expiracao': None, 'unidade_impressa': 'kWh',
                                      'rotulo': f'Saldo em Energia da Instalação: Ponta {mm[1]} kWh'})
            gd['lancamentos'].append({'pagina': np_, 'tipo': 'saldo_atual', 'posto': 'FORA_PONTA', 'kwh': num(mm[2]),
                                      'mes_ref': None, 'ref_expiracao': None, 'unidade_impressa': 'kWh',
                                      'rotulo': f'Fora Ponta {mm[2]} kWh'})
            d['mensagens'].append({'pagina': np_, 'texto': re.sub(r'\s+', ' ', mm[0])})
        mm = re.search(r'Saldo a expirar pr\S+ximo m\S+s:\s*([\d.,]+)\s*kWh', b)
        if mm:
            gd['lancamentos'].append({'pagina': np_, 'tipo': 'a_expirar', 'posto': None, 'kwh': num(mm[1]),
                                      'mes_ref': None, 'ref_expiracao': None, 'unidade_impressa': 'kWh',
                                      'rotulo': f'Saldo a expirar próximo mês: {mm[1]} kWh'})
        _tarifas(t, np_, d)
        _leituras(t, np_, d)
        _historico(t, np_, d)
        if '[MWh]' in tx:
            for h in d['historico']:
                if h['serie'] == 'consumo' and h['valor'] is not None and h['unidade_original'] != 'MWh':
                    h['valor'], h['unidade_original'] = round(h['valor'] * 1000, 3), 'MWh'
        _qualidade(t, np_, d, _txt(sorted([w for w in t if w.x0 < 200], key=lambda w: (round(w.y1), w.x0))))
        for frase in re.findall(r'(Mantenha seus dados.*?conta\.|Excepcionalmente.*?ANEEL\.|Considerar quitada.*?pagamento\.)',
                                re.sub(r'\s+', ' ', b)):
            d['mensagens'].append({'pagina': np_, 'texto': frase})
        return


def _tarifas(t, np_, d):
    for y, g in _grupos([w for w in t if 190 < w.y1 < 235 and w.x0 > 190]):
        s = _txt(g)
        for rot, val in re.findall(r'((?:kWh|kW|KW|Reat\.kWh|Reativo)[^R$]*?)\s*R\$\s*([\d.,]+)', s):
            rot = rot.strip()
            comp = ('DEMANDA_GERACAO' if 'GER' in rot else 'DEMANDA_ULTRAPASSAGEM' if 'Ultrap' in rot else
                    'REATIVO_EXCEDENTE' if 'Reat' in rot else 'TE' if rot.endswith('TE') else
                    'TUSD' if 'TUSD' in rot else 'DEMANDA')
            d['tarifas'].append({'pagina': np_, 'rotulo': rot, 'componente': comp,
                                 'posto': 'GERACAO' if 'GER' in rot else (_posto(rot) or ('UNICO' if 'Único' in rot else None)),
                                 'valor': num(val, ponto_decimal=True),
                                 'unidade': 'R$/kW' if re.match(r'(kW|KW)\b', rot) or 'Reativo kW' in rot else 'R$/kWh',
                                 'tipo': 'aneel'})


GRAND = {'kWh': ('Energia ativa', 'kWh'), 'kW': ('Demanda', 'kW'), 'Ufer': ('Energia reativa excedente', 'kVArh'),
         'kWh Inj.': ('Energia injetada', 'kWh')}


def _leituras(t, np_, d):
    hdr = next((w for w in t if w.t == 'U.M.' and w.x0 < 70), None)
    if not hdr:
        return
    med = d['unidade_consumidora']['medidor'][0] if d['unidade_consumidora']['medidor'] else None
    for y, g in _grupos([w for w in t if hdr.y1 + 2 < w.y1 < hdr.y1 + 90 and w.x0 < 190]):
        s = _txt([w for w in g if not e_numero(w.t) or w.x0 < 100])
        mm = re.match(r'(kWh Inj\.|kWh|kW|Ufer)\s+(\S+)', s)
        if not mm:
            continue
        nums = [w for w in g if w.x0 >= 100 and e_numero(w.t)]
        cols = {}
        for w in nums:
            k = 'leitura_atual' if w.x1 < 128 else ('leitura_anterior' if w.x1 < 158 else 'constante')
            cols[k] = w.t
        gr, un = GRAND[mm[1]]
        posto = {'Ponta': 'PONTA', 'F.Ponta': 'FORA_PONTA', 'Fponta': 'FORA_PONTA', 'Reserv.': 'RESERVADO',
                 'Reserv': 'RESERVADO'}.get(mm[2], _posto(mm[2]))
        d['medicoes'].append({'pagina': np_, 'tabela_origem': 'DADOS DE LEITURA', 'medidor': med, 'grandeza': gr,
                              'posto': posto, 'leitura_anterior': num(cols.get('leitura_anterior')),
                              'leitura_atual': num(cols.get('leitura_atual')), 'constante': num(cols.get('constante')),
                              'perdas_pct': None, 'ajuste': None, 'consumo': None, 'consumo_faturado': None,
                              'fator_potencia': None, 'ajuste_fator_potencia': None, 'unidade': un,
                              'data_hora_registro': None, 'leitura_arredondada': True,
                              'colunas_originais': {'U.M.': f'{mm[1]} {mm[2]}', 'Atual': cols.get('leitura_atual'),
                                                    'Anter': cols.get('leitura_anterior'),
                                                    'Ft.Multip': cols.get('constante')}})


def _historico(t, np_, d):
    """Consumo ponta (x≈205–365) e fora ponta (x≈380–540) com dias; demanda (x≈293–453) com dias. O ano só
    aparece na 1ª linha e na virada; os meses descem."""
    def bloco(x0, x1, serie, posto, un):
        ano = None
        for y, g in _grupos([w for w in t if x0 <= w.x0 < x1 and 240 < w.y1 < 560]):
            ws = [w.t for w in g]
            k = next((i for i, x in enumerate(ws) if x in MES3), None)
            if k is None or len(ws) < k + 3:
                continue
            if k > 0 and re.fullmatch(r'\d{4}', ws[k - 1]):
                ano = int(ws[k - 1])
            if ano is None:
                continue
            mes = f'{ano}-{MES3.index(ws[k]) + 1:02d}'
            v, dias = ws[k + 1], ws[k + 2]
            if not e_numero(v):
                continue
            d['historico'].append({'pagina': np_, 'mes': mes, 'serie': serie, 'posto': posto, 'valor': num(v),
                                   'unidade': un, 'unidade_original': un, 'faturado_pela_media': False})
            d['historico'].append({'pagina': np_, 'mes': mes, 'serie': 'dias', 'posto': posto, 'valor': num(dias),
                                   'unidade': 'dias', 'unidade_original': 'dias', 'faturado_pela_media': False})
            if ws[k] == 'JAN':
                ano -= 1
    yd = next((w.y1 for w in t if w.t == 'Demanda' and w.x0 > 300 and w.y1 > 400), None)
    if yd:  # demanda fica abaixo do consumo
        tt = t
        t = [w for w in tt if w.y1 < yd]
        bloco(200, 370, 'consumo', 'PONTA', 'kWh')
        bloco(375, 560, 'consumo', 'FORA_PONTA', 'kWh')
        t = [w for w in tt if w.y1 > yd]
        for y, g in []:
            pass
        _demanda_hist(t, np_, d)
        t = tt
    else:
        bloco(200, 370, 'consumo', 'PONTA', 'kWh')
        bloco(375, 560, 'consumo', 'FORA_PONTA', 'kWh')
    d['historico_formato'] = 'tabela' if d['historico'] else 'ausente'


def _demanda_hist(t, np_, d):
    ano = None
    for y, g in _grupos([w for w in t if 280 <= w.x0 < 470]):
        ws = [w.t for w in g]
        k = next((i for i, x in enumerate(ws) if x in MES3), None)
        if k is None or len(ws) < k + 3:
            continue
        if k > 0 and re.fullmatch(r'\d{4}', ws[k - 1]):
            ano = int(ws[k - 1])
        if ano is None:
            continue
        mes = f'{ano}-{MES3.index(ws[k]) + 1:02d}'
        d['historico'].append({'pagina': np_, 'mes': mes, 'serie': 'demanda', 'posto': None, 'valor': num(ws[k + 1]),
                               'unidade': 'kW', 'unidade_original': 'kW', 'faturado_pela_media': False})
        d['historico'].append({'pagina': np_, 'mes': mes, 'serie': 'dias', 'posto': None, 'valor': num(ws[k + 2]),
                               'unidade': 'dias', 'unidade_original': 'dias', 'faturado_pela_media': False})
        if ws[k] == 'JAN':
            ano -= 1


def _qualidade(t, np_, d, tx):
    mm = re.search(r'(\S+(?: \d)?) DIC FIC DMIC DICRI Padr\S+o Mensal ([\d.,]+) ([\d.,]+) ([\d.,]+) ([\d.,]+)', tx)
    if not mm:
        return
    conj = mm[1]
    ap = re.search(r'Apurado Mensal ([\d.,]+) ([\d.,]+) ([\d.,]+) ([\d.,]+)', tx)
    per = re.search(r'Per\S+odo de Apura\S+o M\S+s:\s*(\S+)', tx)
    for k, ind in enumerate(('DIC', 'FIC', 'DMIC', 'DICRI')):
        d['qualidade_servico'].append({'indicador': ind, 'conjunto': conj, 'periodo_apuracao': per[1] if per else None,
                                       'limite_mensal': num(mm[k + 2]), 'limite_trimestral': None, 'limite_anual': None,
                                       'apurado_mensal': num(ap[k + 1]) if ap else None, 'apurado_trimestral': None,
                                       'apurado_anual': None})
    ev = re.search(r'Valor EUSD/VRC:\s*R\$\s*([\d.,]+)', tx)
    if ev:
        d['encargo_uso_eusd'] = [{'referencia': per[1] if per else None, 'valor': num(ev[1])}]
        d['outros'].append({'pagina': np_, 'secao_impressa': 'Indicadores de continuidade', 'rotulo': 'Valor EUSD/VRC',
                            'valor': ev[1]})


def _pagamento(brutos, d):
    pag = d['pagamento']
    tudo = re.sub(r'\s+', ' ', ' '.join(brutos))
    mm = re.search(r'\b(\d{12} \d{12} \d{12} \d{12})\b', tudo) or \
        re.search(r'\b(\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14})\b', tudo)
    pag['linha_digitavel'] = mm[1] if mm else None
    mm = re.search(r'Banco (\d{3}) Ag\S+ncia (\d+)', tudo)
    if mm:
        pag['banco'], pag['agencia'] = mm[1], mm[2]
    mm = re.search(r'C\S+d\. D\S+b\. Autom\S+tico-Banco.*?(\d{9,})', tudo)
    if mm:
        pag['debito_automatico'] = mm[1]
    if 'Pague aqui - PIX' in tudo or 'PIX' in tudo:
        pag['pix'] = 'QR Code "Pague aqui - PIX" (conteúdo não impresso)'
    mm = re.search(r'(ATRASO NO PAGAMENTO SER\S+ COBRADO EM CONTA FUTURA.*?VIGENTE)', tudo)
    if mm:
        d['mensagens'].append({'pagina': 1, 'texto': mm[1]})
    pag['boleto'] = None
    pag.setdefault('conta_recebedora', None)
