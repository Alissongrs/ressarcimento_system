"""Parser determinístico das faturas Light (DANF3E, 1 página): Grupo A (geradoras) e Grupo B (consumidoras).

Lê só o texto embutido com posição. Tabelas (itens, tributos, medições, histórico) são lidas por coluna:
cada número vai para a coluna cujo cabeçalho termina mais perto da borda direita dele.
Saída no formato v2 da ESPECIFICACAO_JSON.md.
"""
import re

from base import (colunas_por_ancora, data_br, e_numero, esqueleto, linhas, mes_ano, num, palavras, posto_de,
                  sem_acento)

NOME = 'light_v2'
CNPJ_LIGHT = '60.444.437/0001-46'
MES3 = r'(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)'
PREFIXO_RUA = re.compile(r'^(R|RUA|AV|AVENIDA|EST|ESTR|ESTRADA|ROD|RODOVIA|TV|TRAV|AL|ALAMEDA|PC|PRACA|LGO|LARGO|VIA|'
                         r'QD|LOT|LOTE|SITIO|FAZ|FAZENDA|BR|RJ|SN|S/N)\b', re.I)


def detecta(texto):
    # o CNPJ da Light não sai como texto; está dentro da chave de acesso (posições 7–20)
    t = texto.replace(' ', '')
    if CNPJ_LIGHT in texto or re.search(r'\d{6}60444437000146\d{24}', t):
        return True
    # chave às vezes só na imagem: DANF3E com a estrutura da Light
    return 'DANF3E' in texto and 'Itens de fatura' in texto and ('Conta Contrato' in texto or 'light.com.br' in texto
                                                              or 'Grandezas' in texto)


def componente_de(desc):
    d = sem_acento(desc).upper()
    if 'ULTRAP' in d and 'INJETADA' in d:
        return 'DEMANDA_GERACAO_ULTRAPASSAGEM', 'GERACAO'
    if 'DEMANDA' in d and 'INJETADA' in d:
        return 'DEMANDA_GERACAO', 'GERACAO'
    if 'ULTRAP' in d:
        return 'DEMANDA_ULTRAPASSAGEM', posto_de(desc)
    if 'REATIV' in d:
        return 'REATIVO_EXCEDENTE', posto_de(desc)
    if 'DEMANDA' in d:
        return 'DEMANDA', posto_de(desc)
    if 'INJETADA GD' in d:  # consumidora: crédito de GD abatido do consumo
        return 'CONSUMO_COMPENSADO', posto_de(desc)
    if 'INJETADA' in d:
        return 'GD_INJETADA', posto_de(desc)
    if 'RESTITUI' in d or 'ESTORNO' in d or 'DEVOL' in d:
        return 'ESTORNO', None
    if 'FORNECIDA' in d or ('ENERGIA' in d and ('ELETRICA' in d or 'ATIVA' in d)):
        if re.search(r'\bTUSD\b|-TUSD', d):
            return 'TUSD', posto_de(desc)
        if re.search(r'\bTE\b', d):
            return 'TE', posto_de(desc)
        return 'CONSUMO', posto_de(desc)
    if 'ILUM' in d:
        return 'ILUMINACAO_PUBLICA', None
    if 'IPCA' in d or 'ATUALIZ' in d:
        return 'ATUALIZACAO_MONETARIA', None
    if 'JUROS' in d:
        return 'JUROS', None
    if 'MULTA' in d:
        return 'MULTA', None
    if re.search(r'\b(DIC|FIC|DMIC|DICRI)\b', d):
        return 'COMPENSACAO_CONTINUIDADE', None
    if 'SALDO' in d:
        return 'SALDO_TRANSPORTADO', None
    if 'BANDEIRA' in d:
        return 'BANDEIRA', None
    return 'AJUSTE', None


def _achar(ls, padrao, ini=0):
    rx = re.compile(padrao, re.I)
    for i in range(ini, len(ls)):
        if rx.search(sem_acento(ls[i].texto())):
            return i
    return None


def _cabecalho_itens(todas):
    """Limites da tabela pelas palavras (as linhas podem ficar a 2 pt umas das outras):
    y_cab = 'Itens' de 'Itens de fatura'; y_tot = 'TOTAL' na margem; y_fim = quadro de medições."""
    itens_w = [w for w in todas if w.t == 'Itens' and w.x0 < 120]
    if not itens_w:
        return None
    y_cab = itens_w[0].y1
    tot_w = [w for w in todas if w.t == 'TOTAL' and w.x0 < 100 and w.y1 > y_cab]
    if not tot_w:
        return None
    y_tot = min(w.y1 for w in tot_w)
    fim_w = [w for w in todas if w.y1 > y_tot and (w.t in ('Medidor', 'Postos'))]
    y_fim = min((w.y0 for w in fim_w), default=y_tot + 80)
    cab = [w for w in todas if y_cab - 8 <= w.y1 <= y_cab + 4]
    x_trib = min((w.x0 for w in cab if sem_acento(w.t).startswith('Tributo')), default=455) - 4

    def x1(pred):
        c = [w.x1 for w in cab if pred(sem_acento(w.t)) and w.x0 < x_trib]
        return max(c) if c else None

    anc = {'quant': x1(lambda t: t.startswith('Quant')), 'preco': x1(lambda t: t == 'tributos'),
           'pis_cofins': x1(lambda t: 'COFINS' in t), 'base_icms': x1(lambda t: t == 'Calc.'),
           'aliquota_icms': x1(lambda t: t.startswith('Aliquota')), 'tarifa': x1(lambda t: t == 'Tarifa')}
    xv = [w for w in cab if w.t == 'Valor' and w.x0 < x_trib]
    if xv:
        rs = [w.x1 for w in cab if w.t == '(R$)' and abs(w.y1 - xv[0].y1) < 2 and w.x0 > xv[0].x0]
        anc['valor'] = min(rs) if rs else xv[0].x1 + 12
    xi = [w for w in cab if w.t == 'ICMS' and anc['aliquota_icms'] and anc['aliquota_icms'] - 5 < w.x0
          < (anc['tarifa'] or 1e9) - 15]
    if xi:
        anc['icms'] = max(w.x1 for w in xi)
    unid = x1(lambda t: t == 'Unid.')
    y_corpo = max(w.y1 for w in cab) + 1.5
    return {'y_corpo': y_corpo, 'y_tot': y_tot, 'y_fim': y_fim, 'x_trib': x_trib,
            'anc': {k: v for k, v in anc.items() if v}, 'x_desc': (unid or 200) - 14}


def _itens(todas, d, grupo):
    cab = _cabecalho_itens(todas)
    if not cab:
        return None
    anc, x_desc, x_trib, y_tot = cab['anc'], cab['x_desc'], cab['x_trib'], cab['y_tot']
    ws = [w for w in todas if cab['y_corpo'] < w.y1 < cab['y_fim'] and w.x0 < x_trib and abs(w.y1 - y_tot) > 1.0]
    # depois do TOTAL só entram linhas com valor (ex.: "Multa 2% conta de 02/2026 ..."), não avisos
    x_valor = anc.get('valor', 315)
    ys_valor = [w.y1 for w in ws if w.y1 > y_tot and e_numero(w.t) and abs(w.x1 - x_valor) < 12]
    ws = [w for w in ws if w.y1 < y_tot or any(abs(w.y1 - y) <= 5 for y in ys_valor)]
    desc_ws = [w for w in ws if w.x0 < x_desc]
    num_ws = [w for w in ws if w.x0 >= x_desc]
    # linhas de números (cada uma é um item); descrição vai para a linha de números mais próxima (±5 pt)
    linhas_num = []
    for w in sorted(num_ws, key=lambda w: w.y1):
        if linhas_num and abs(linhas_num[-1][0] - w.y1) <= 2.5:
            linhas_num[-1][1].append(w)
        else:
            linhas_num.append([w.y1, [w]])
    linhas_desc = []
    for w in sorted(desc_ws, key=lambda w: w.y1):
        if linhas_desc and abs(linhas_desc[-1][0] - w.y1) <= 2.5:
            linhas_desc[-1][1].append(w)
        else:
            linhas_desc.append([w.y1, [w]])
    linhas_num = [ln for ln in linhas_num if any(e_numero(w.t) for w in ln[1])]
    usados = {}
    soltas = []
    for y, wl in linhas_desc:
        txt = ' '.join(w.t for w in sorted(wl, key=lambda w: w.x0))
        livres = [k for k, (yn, _) in enumerate(linhas_num) if abs(yn - y) <= 5 and k not in usados]
        if livres:
            k = min(livres, key=lambda k: abs(linhas_num[k][0] - y))
            usados[k] = txt
        else:
            soltas.append((y, txt))
    eventos = [(linhas_num[k][0], 'num', k) for k in range(len(linhas_num))] + [(y, 'txt', t) for y, t in soltas]
    eventos.sort(key=lambda e: e[0])
    # linhas só de texto consecutivas viram um item INFO (ex.: "Adicional Bandeiras ... / Bandeira Amarela 2,09")
    bloco_txt, ultimo_y = [], None
    def fecha():
        if not bloco_txt:
            return
        band = [t for t in bloco_txt if re.match(r'Bandeira\s', t)]
        # uma bandeira: item único "Adicional Bandeiras ... Bandeira Amarela 2,09"; várias: uma linha cada
        grupos = [bloco_txt[:]] if len(band) <= 1 else [[t] for t in bloco_txt]
        for g in grupos:
            d['itens'].append(_item(' '.join(g), {}, 'INFO', None))
        for t in band:
            m = re.match(r'Bandeira\s+(Verde|Amarela|Vermelha)(?:\s+(?:Patamar\s+)?(1|2|I|II)\b)?', t, re.I)
            if m:
                cor = sem_acento(m[1]).upper()
                if cor == 'VERMELHA':
                    cor += '_' + {'I': '1', 'II': '2'}.get((m[2] or '1').upper(), m[2] or '1')
                d['bandeiras'].append({'pagina': 1, 'cor': cor, 'inicio': None, 'fim': None, 'dias': None})
        bloco_txt.clear()
    y_item = None
    for y, tipo, v in eventos:
        if tipo == 'txt':
            # continuação da descrição do item de cima ("... Lei Mun" / "9049/2025")
            if not bloco_txt and y_item is not None and 0 < y - y_item <= 9 and re.match(r'[\da-z(]', v):
                ult = d['itens'][-1]
                ult['descricao'] = (ult['descricao'] + ' ' + v).strip()
                ult['colunas_originais']['Itens de fatura'] = ult['descricao']
                y_item = y
                continue
            if bloco_txt and ultimo_y is not None and y - ultimo_y > 12:
                fecha()
            bloco_txt.append(v)
            ultimo_y = y
            y_item = None
            continue
        fecha()
        y_item = y
        wl = linhas_num[v][1]
        unid = [w for w in wl if not e_numero(w.t)]
        nums = [w for w in wl if e_numero(w.t)]
        cols = colunas_por_ancora(nums, anc)
        desc = usados.get(v, '')
        comp, posto = componente_de(desc)
        if posto is None and grupo == 'B' and comp in ('CONSUMO', 'TUSD', 'TE', 'GD_INJETADA', 'CONSUMO_COMPENSADO'):
            posto = 'UNICO'
        it_ = _item(desc, cols, comp, posto)
        it_['unidade'] = ' '.join(w.t for w in unid) or None
        d['itens'].append(it_)
    fecha()
    return cab


def _item(desc, cols, comp, posto):
    pd = lambda k: num(cols.get(k), ponto_decimal=True)  # tarifas: '1.22082' é decimal
    return {'pagina': 1, 'secao_impressa': 'Itens de fatura', 'codigo': None, 'descricao': desc, 'mes_ref': None,
            'componente': comp, 'posto': posto, 'quantidade_registrada': None,
            'quantidade_faturada': num(cols.get('quant')), 'unidade': None,
            'tarifa_com_tributos': pd('preco'), 'tarifa_sem_tributos': pd('tarifa'),
            'valor': num(cols.get('valor')), 'valor_sem_tributos': None,
            'base_icms': num(cols.get('base_icms')), 'aliquota_icms': num(cols.get('aliquota_icms')),
            'icms': num(cols.get('icms')), 'base_pis_cofins': None, 'aliquota_pis': None, 'pis': None,
            'aliquota_cofins': None, 'cofins': None, 'pis_cofins': num(cols.get('pis_cofins')), 'nf_referencia': None,
            'colunas_originais': {'Itens de fatura': desc, **cols}}


ROT_COL = {'pis_cofins': 'PIS / COFINS (R$)', 'base_icms': 'Base Calc. ICMS (R$)', 'icms': 'ICMS (R$)',
           'valor': 'Valor (R$)'}


def _total_e_tributos(todas, d, cab):
    x_trib, anc, y_tot = cab['x_trib'], cab['anc'], cab['y_tot']
    tc = colunas_por_ancora([w for w in todas if abs(w.y1 - y_tot) <= 1.0 and w.x0 < x_trib and e_numero(w.t)],
                            {k: v for k, v in anc.items() if k in ROT_COL})
    for k, v in tc.items():
        d['totais']['totais_colunas'].append({'pagina': 1, 'coluna': ROT_COL[k], 'valor': num(v)})
    # tributos à direita (PIS/PASEP, COFINS) e montantes contratados — linhas próprias dessa coluna
    direita = [w for w in todas if w.x0 >= x_trib and cab['y_corpo'] - 4 < w.y1 < cab['y_fim']]
    for l in linhas(direita, tol=2.2):
        t = l.texto()
        m = re.match(r'(PIS/PASEP|PIS|COFINS)\s+([\d.,]+)\s+([\d.,]+)%\s+([\d.,]+)', t)
        if m:
            d['tributos'].append({'pagina': 1, 'tributo': 'COFINS' if m[1] == 'COFINS' else 'PIS', 'base': num(m[2]),
                                  'aliquota': num(m[3]), 'valor': num(m[4]), 'retido': False,
                                  'colunas_originais': {'Tributo': m[1], 'Base de Calc. (R$)': m[2],
                                                        'Alíquota (%)': m[3] + '%', 'Valor (R$)': m[4]}})
            continue
        m = re.match(r'(Demanda[^\d]*?)\s+(-?[\d.]+,\d+)$', t)
        if m:
            rot = m[1].strip()
            d['demanda'].append({'pagina': 1, 'tipo': 'injecao' if 'Injetada' in rot else 'consumo', 'posto': None,
                                 'contratada_kw': num(m[2]), 'medida_kw': None, 'faturada_kw': None,
                                 'faturada_ultrapassagem_kw': None, 'nao_consumida_kw': None, 'data_hora': None,
                                 'rotulo': 'GRANDEZAS CONTRATADAS - ' + rot, 'colunas_originais': {rot: m[2]}})
    if 'icms' in tc:
        aliqs = {i['aliquota_icms'] for i in d['itens'] if i['icms']}
        base = num(tc.get('base_icms'))
        d['tributos'].append({'pagina': 1, 'tributo': 'ICMS', 'base': base,
                              'aliquota': aliqs.pop() if len(aliqs) == 1 and base is not None else None,
                              'valor': num(tc['icms']), 'retido': False,
                              'colunas_originais': {'ICMS (R$) TOTAL': tc['icms']}})


def _medicoes(ls, d):
    ih = _achar(ls, r'Postos\s+Leitura|^Medidor\s+Grandezas')
    if ih is None:
        return
    cab = [w for l in ls[ih:ih + 3] for w in l.p]
    px = min((w.x0 for w in cab if sem_acento(w.t) in ('Postos', 'horarios')), default=135)
    x_fim = max((w.x1 for w in cab if w.t == 'Consumo' or (w.t == 'kWh' and w.x0 > px)), default=275) + 14
    ultimo = None
    gx = min((w.x0 for w in cab if w.t == 'Grandezas'), default=87) - 18
    for l in ls[ih + 1:]:
        if re.search(MES3 + r'/\d{2}\b', l.texto()):  # começou o histórico
            break
        ws = l.entre(0, x_fim)
        nums = [w for w in ws if e_numero(w.t) and w.x0 > px + 30]
        tem_grandeza = any(gx <= w.x0 < px - 12 and not e_numero(w.t) for w in ws)
        if len(nums) < 3 or not tem_grandeza:
            if ultimo is not None and l.y - ultimo > 14:
                break
            extra = l.texto(x_fim, 600).strip()
            if ultimo is not None and extra:
                d.setdefault('_fisco', []).append(extra)
            continue
        ultimo = l.y
        medidor = ws[0].t if re.fullmatch(r'\d{5,}', ws[0].t) and ws[0].x0 < gx else None
        texto = [w for w in ws if w not in nums and w.t != medidor]
        grand = ' '.join(w.t for w in texto if w.x0 < px - 12)
        posto_txt = ' '.join(w.t for w in texto if w.x0 >= px - 12)
        v = [w.t for w in nums][-4:]
        v = [None] * (4 - len(v)) + v
        ant, atu, cte, cons = v
        posto = posto_de(posto_txt) or ('UNICO' if 'CONVENCIONAL' in sem_acento(posto_txt).upper() else
                                        (posto_txt.upper() or None))
        g = sem_acento(grand).upper().replace(' ', '')
        d['medicoes'].append({'pagina': 1, 'tabela_origem': 'Medidor / Grandezas', 'medidor': medidor,
                              'grandeza': grand, 'posto': posto, 'leitura_anterior': num(ant),
                              'leitura_atual': num(atu), 'constante': num(cte), 'perdas_pct': None, 'ajuste': None,
                              'consumo': num(cons), 'consumo_faturado': None, 'fator_potencia': None,
                              'ajuste_fator_potencia': None,
                              'unidade': 'kWh' if 'KWH' in g else ('kW' if 'KW' in g else 'kWh'),
                              'data_hora_registro': None, 'leitura_arredondada': False,
                              'colunas_originais': {'Medidor': medidor, 'Grandezas': grand,
                                                    'Postos horários': posto_txt, 'Leitura Anterior': ant,
                                                    'Leitura Atual': atu, 'Const Medidor': cte, 'Consumo kWh': cons}})
        if medidor and medidor not in d['unidade_consumidora']['medidor']:
            d['unidade_consumidora']['medidor'].append(medidor)
        extra = l.texto(x_fim, 600).strip()
        if extra:
            d.setdefault('_fisco', []).append(extra)


SERIES_A = [  # (prefixo impresso, serie v2, unidade)
    ('Consumo Reativo', 'reativo_ere', 'kVArh'), ('Demanda Reativa', 'reativo_dre', 'kVAr'),
    ('Consumo Injetado', 'injetada', 'kWh'), ('Energia Injetada', 'injetada', 'kWh'),
    ('Demanda Injetada', 'demanda_geracao', 'kW'), ('Consumo', 'consumo', 'kWh'), ('Demanda', 'demanda', 'kW')]


def _historico(ls, d):
    for l in ls:  # Grupo A: uma linha por série "Consumo Fora Ponta MAI/25 0 ABR/25 0 ..."
        t = l.texto()
        if len(re.findall(MES3 + r'/\d{2}\b', t)) < 6:
            continue
        rot = re.split(r'\s' + MES3 + r'/\d{2}\b', t)[0].strip()
        serie = next(((s, u) for p, s, u in SERIES_A if sem_acento(rot).upper().startswith(sem_acento(p).upper())),
                     ('outro', None))
        posto = posto_de(rot)
        for mm, v in re.findall(r'(' + MES3 + r'/\d{2})\s+(-?[\d.,]+)', t):
            d['historico'].append({'pagina': 1, 'mes': mes_ano(mm), 'serie': serie[0], 'posto': posto,
                                   'valor': num(v), 'unidade': serie[1], 'unidade_original': None,
                                   'faturado_pela_media': False})
    if d['historico']:
        d['historico_formato'] = 'texto'
        return
    ih = _achar(ls, r'CONSUMO FATURADO')  # Grupo B: quadro à direita "MÊS | CONSUMO FATURADO | Nº DIAS FAT"
    if ih is None:
        d['historico_formato'] = 'ausente'
        return
    x0 = min(w.x0 for w in ls[ih].p if w.t == 'CONSUMO') - 12
    for l in ls[ih + 1:]:
        t = ' '.join(w.t for w in l.entre(x0, 1e9))
        m = re.match(r'^(' + MES3 + r'/\d{2})\s+(\S+)\s+(\S+)\s+(\d+)$', t)
        if m:
            mes = mes_ano(m[1])
            d['historico'].append({'pagina': 1, 'mes': mes, 'serie': 'consumo', 'posto': None, 'valor': num(m[3]),
                                   'unidade': 'kWh', 'unidade_original': 'kWh', 'faturado_pela_media': False})
            d['historico'].append({'pagina': 1, 'mes': mes, 'serie': 'dias', 'posto': None, 'valor': int(m[4]),
                                   'unidade': 'dias', 'unidade_original': 'Nº DIAS FAT', 'faturado_pela_media': False})
        elif d['historico'] and t:
            break
    d['historico_formato'] = 'tabela' if d['historico'] else 'ausente'


def _gd(d, tj):
    lanc = d['gd']['lancamentos'] = []
    m = re.search(r'(SALDO ATUAL GERA\S+\s*DISTRIBU\S*?(-?[\d.]+)\s*PONTA\s*(Kwh)),\s*((-?[\d.]+)\s*FORA PONTA\s*Kwh)', tj)
    if m:
        lanc.append({'pagina': 1, 'tipo': 'saldo_atual', 'posto': 'PONTA', 'kwh': num(m[2]), 'mes_ref': None,
                     'ref_expiracao': None, 'unidade_impressa': m[3], 'rotulo': m[1]})
        lanc.append({'pagina': 1, 'tipo': 'saldo_atual', 'posto': 'FORA_PONTA', 'kwh': num(m[5]), 'mes_ref': None,
                     'ref_expiracao': None, 'unidade_impressa': 'Kwh', 'rotulo': m[4]})
    m = re.search(r'(Unidade consumidora no sistema de compensa\S+ \(kWh\): Energia injetada\s*-\s*(-?[\d.,]+))\s*/\s*'
                  r'(Saldo de Cr\S+:\s*(-?[\d.,]+))', tj)
    if m:
        lanc.append({'pagina': 1, 'tipo': 'injetada', 'posto': None, 'kwh': num(m[2]), 'mes_ref': None,
                     'ref_expiracao': None, 'unidade_impressa': 'kWh', 'rotulo': m[1]})
        lanc.append({'pagina': 1, 'tipo': 'saldo_atual', 'posto': None, 'kwh': num(m[4]), 'mes_ref': None,
                     'ref_expiracao': None, 'unidade_impressa': 'kWh', 'rotulo': m[3]})
    inj = [i for i in d['itens'] if i['componente'] in ('GD_INJETADA', 'CONSUMO_COMPENSADO')
           and i['quantidade_faturada'] and d['unidade_consumidora']['grupo'] == 'B']
    vistos = set()
    for i in inj:  # quantidade compensada (itens "Energia Injetada ... TUSD/TE")
        k = (i['posto'], i['quantidade_faturada'])
        if k in vistos:
            continue
        vistos.add(k)
        lanc.append({'pagina': 1, 'tipo': 'compensada', 'posto': 'UNICO', 'kwh': i['quantidade_faturada'],
                     'mes_ref': None, 'ref_expiracao': None, 'unidade_impressa': i['unidade'] or 'kWh',
                     'rotulo': i['descricao'] + ' (Quant., itens de fatura)'})


def parse(doc, fid, caminho):
    d = esqueleto(fid, caminho, len(doc))
    d['extracao']['parser'] = NOME
    d['totais'].update({'tributos_retidos': None, 'subtotais': [], 'totais_colunas': []})
    d['gd'] = {'uc_geradora': None, 'conta_contrato_geradora': None, 'participacao_pct': None, 'lancamentos': [],
               'rateio_beneficiarias': []}
    pg = doc[0]
    todas = palavras(pg)
    ls = linhas(todas)
    tj = ' '.join(l.texto() for l in ls)
    tdir = ' '.join(l.texto(360, 600) for l in ls if l.y < 240)  # bloco da NF3e (coluna direita)
    d['extracao']['paginas_lidas'] = list(range(1, len(doc) + 1))
    d['extracao']['paginas'] = [{'pagina': p, 'tipo': 'conteudo', 'repete_pagina': None} for p in range(1, len(doc) + 1)]
    doc_ = d['documento']
    doc_.update({'distribuidora': 'LIGHT SERVIÇOS DE ELETRICIDADE SA', 'distribuidora_sigla': 'LIGHT',
                 'distribuidora_cnpj': CNPJ_LIGHT})
    nf = doc_['nota_fiscal']
    m = re.search(r'NOTA FISCAL N\S*\s*(\d+)\s*-\s*S\S*RIE\s*(\d+)\s*/\s*DATA DE\s+EMISS\S*\s*(\d\d/\d\d/\d{4})', tdir)
    if m:
        nf.update({'numero': m[1], 'serie': m[2], 'data_emissao': data_br(m[3]), 'modelo': 'NF3e'})
        d['referencia']['data_emissao'] = data_br(m[3])
    m = re.search(r'\b(\d{44})\b', tdir)
    if m:
        nf['chave_acesso'] = m[1]
    m = re.search(r'(https?://\S+)', tdir)
    if m:
        nf['url_consulta'] = m[1]
    m = re.search(r'Protocolo de autoriza\S*\s*(\d+)\s*-\s*(\d\d/\d\d/\d{4})\s*\S+\s*(\d\d:\d\d:\d\d)', tdir)
    if m:
        nf['protocolo_autorizacao'] = m[1]
        nf['data_autorizacao'] = f'{data_br(m[2])}T{m[3]}'

    # classificação (topo esquerdo): da linha "Grupo ..." até o tipo de fornecimento
    uc_ = d['unidade_consumidora']
    ig = _achar(ls, r'^Grupo\s')
    if ig is not None:
        partes, forn = [], None
        for l in ls[ig:ig + 4]:
            for w in l.entre(0, 330):
                if re.match(r'(?i)^(MONOF|BIF|TRIF)', sem_acento(w.t)):
                    forn = w.t
                elif l is ls[ig] or 85 <= w.x0 < 200:
                    partes.append(w.t)
            if forn:
                break
        cls = ' '.join(partes).strip()
        uc_['classificacao'] = cls
        uc_['tipo_fornecimento'] = forn
        m = re.match(r'Grupo\s+([AB])(\d\w?)?', cls)
        if m:
            uc_['grupo'] = m[1]
            uc_['subgrupo'] = (m[1] + m[2]) if m[2] else None
        m = re.search(r'Subgrupo\s+(\w+)', cls)
        if m:
            uc_['subgrupo'] = m[1]
        for mod in ('Verde', 'Azul', 'Convencional', 'Branca'):
            if re.search(r'\b' + mod + r'\b', cls):
                uc_['modalidade_tarifaria'] = mod
        if uc_['grupo'] == 'B' and not uc_['modalidade_tarifaria'] and 'Tarifa Convencional' in tj:
            uc_['modalidade_tarifaria'] = 'Convencional'
            uc_['tipo_tarifa_impresso'] = 'Tarifa Convencional'
        p = [x.strip() for x in cls.split('/')]
        if uc_['grupo'] == 'A' and len(p) >= 4:
            uc_['classe'], uc_['subclasse'] = p[2], p[3]
        elif len(p) >= 3:
            m = re.match(r'Subgrupo\s+\w+\s+(.*)', p[1])
            uc_['classe'], uc_['subclasse'] = (m[1] if m else None), p[2]
        e_ger = 'Ger Distribuida' in cls
        uc_['geracao']['e_gerador'] = e_ger
        uc_['geracao']['modalidade_gd'] = 'Geração Distribuída' if e_ger else None

    # titular (coluna da esquerda, x≈42): nome (1–2 linhas), endereço…, CEP, CNPJ, Conta Contrato
    tit = d['titular']
    esq = [l for l in ls if l.entre(36, 50) and 100 <= l.y <= 215]
    bloco = []
    for l in esq:
        t = l.texto(0, 195).strip()
        if t.startswith('CEP'):
            tit['cep'] = (re.search(r'\d{5}-\d{3}', t) or [None])[0]
        elif t.startswith('CNPJ') or t.startswith('CPF'):
            tit['cnpj_cpf'] = (re.search(r'[\d./-]{11,}', t) or [None])[0]
        elif t.startswith('Conta Contrato'):
            tit['conta_contrato'] = (re.search(r'\d{6,}', t) or [None])[0]
        elif not tit['cep'] and t:
            bloco.append(t)
    if bloco:
        nome = [bloco[0]]
        k = 1
        while k < len(bloco) - 1 and not re.search(r'\d', bloco[k]) and not PREFIXO_RUA.match(bloco[k]):
            nome.append(bloco[k])
            k += 1
        tit['nome'] = ' '.join(nome)
        end = bloco[k:]
        if len(end) >= 2 and re.fullmatch(r'[A-Z]{2}', end[-1]):  # UF sozinha na linha de baixo
            end = end[:-2] + [end[-2].rstrip(',') + ', ' + end[-1]]
        if end:
            m = re.match(r'(.*?)\s*[-/]\s*([^-/]+?),\s*([A-Z]{2})$', end[-1])
            if m:
                tit['cidade'], tit['uf'] = m[2].strip(), m[3]
                end = end[:-1] + ([m[1]] if m[1] else [])
            tit['endereco'] = ' '.join(end)
    # UC (formato antigo 430310487 ou novo 2.094.784.059-90) e código do cliente, no meio (x≈195-300)
    meio = [w for l in ls if 110 <= l.y <= 215 for w in l.entre(195, 300)
            if re.fullmatch(r'\d{7,14}|\d{1,3}(?:\.\d{3}){2,3}-\d{2}', w.t)]
    if meio:
        uc_['uc'] = meio[0].t
        uc_['instalacao'] = meio[0].t if meio[0].t.isdigit() else None
        if len(meio) > 1:
            tit['codigo_cliente'] = meio[1].t
    topo = [l.texto(330, 600) for l in ls if l.y < 60 and l.entre(330, 600)]
    if topo:  # consumidoras: nome + endereço da UC no canto superior direito
        s = ' '.join(topo)
        m = re.search(r'MEDIDOR:\s*(\d+)', s)
        if m:
            uc_['medidor'].append(m[1])
        s = re.sub(r'\s*\|\s*MEDIDOR:.*', '', s)
        s = re.sub(r'^DANF3E.*?ELETR\S*NICA\s*', '', s)
        uc_['endereco'] = s.replace(tit['nome'] or '\0', '').strip()
    else:
        uc_['endereco'] = ' '.join(x for x in (tit['endereco'], tit['cidade'] and f"- {tit['cidade']}, {tit['uf']}",
                                               tit['cep'] and f"CEP {tit['cep']}") if x)

    ref = d['referencia']
    m = re.search(r'(\d\d/\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+(\d{1,3})\s+(\d\d/\d\d/\d{4})', tj)
    if m:
        ref.update({'leitura_anterior': data_br(m[1]), 'leitura_atual': data_br(m[2]), 'dias_faturados': int(m[3]),
                    'proxima_leitura': data_br(m[4])})
    m = re.search(r'\b(' + MES3 + r'/\d{4})\s+(\d\d/\d\d/\d{4}|XX/XX/XXXX)\s+R\$\s*([\d.]+,\d\d)', tj)
    if m:
        ref['mes_referencia'] = mes_ano(m[1])
        ref['data_vencimento'] = data_br(m[2])
        if m[2].startswith('X'):
            d['outros'].append({'pagina': 1, 'secao_impressa': 'cabeçalho', 'rotulo': 'Vencimento', 'valor': m[2]})
        d['totais']['total_a_pagar'] = num(m[3])

    r = _itens(todas, d, uc_["grupo"])
    if r:
        _total_e_tributos(todas, d, r)
    _medicoes(ls, d)
    _historico(ls, d)
    ilum = [i['valor'] for i in d['itens'] if i['componente'] == 'ILUMINACAO_PUBLICA' and i['valor'] is not None]
    if ilum:
        d['totais']['valor_cosip_cip'] = round(sum(ilum), 2)
    _gd(d, tj)

    # mensagens: faixa entre a linha de referência/total e o cabeçalho dos itens
    ir = _achar(ls, r'R\$\s*[\d.]+,\d\d')
    ih = _achar(ls, r'Itens de fatura|^Unid\.|Preco unit|Base de Calc')
    if ir is not None and ih is not None and ih > ir:
        bloco = ' '.join(l.texto() for l in ls[ir + 1:ih])
        for k, parte in enumerate(re.split(r'\s*(?=\|\|\|)', bloco)):
            if parte.strip():
                d['mensagens'].append({'pagina': 1, 'texto': parte.strip()})

    pag = d['pagamento']
    m = re.search(r'\b(\d{5}\.\d{10}\.\d{11}\.\d{15,}|\d{11}\.\d\.\d{11}\.\d\.\d{11}\.\d\.\d{11}\.\d)\b', tj)
    if m:
        pag['linha_digitavel'] = m[1]
    m = re.search(r'(BANCO [A-Z0-9ÇÃÉÍÓÚ .]+?S\.A\.)\s+(\d{3}-\d)', tj)
    if m:
        pag['banco'] = f'{m[1]} {m[2]}'
    # aviso de débito automático: coluna estreita à esquerda, no rodapé
    u = sem_acento(' '.join(w.t for w in sorted((w for w in todas if w.y1 > 600 and w.x0 < 135),
                                                key=lambda w: (round(w.y1), w.x0)))).upper()
    if 'NAO EFETUAR O PAGAMENTO' in u and 'DEBITO AUTOMATICO' in u:
        pag['debito_automatico'] = 'NÃO EFETUAR O PAGAMENTO DESTA FATURA. ELA SE ENCONTRA EM DÉBITO AUTOMÁTICO'
        d['mensagens'].append({'pagina': 1, 'texto': pag['debito_automatico']})
    m = re.search(r'(Coloque sua conta em d\S*bito autom\S*tico, Ref\. Banc\S*ria (\d+))', tj)
    if m:
        d['mensagens'].append({'pagina': 1, 'texto': m[1]})
        d['outros'].append({'pagina': 1, 'secao_impressa': 'Itens de fatura',
                            'rotulo': 'Ref. Bancária (débito automático)', 'valor': m[2]})
    _complementos(todas, ls, d, tj)
    d.pop('_fisco', None)
    return d


# impressos como imagem no fundo da fatura Light — iguais nos 49 gabaritos visuais
CONST_LIGHT = {'ie': '81380.023', 'endereco': 'AV. MAL. FLORIANO 168 RIO DE JANEIRO RJ CEP 20080-002',
               'insc_municipal': '00794678',
               'beneficiario': 'LIGHT - SERVIÇOS DE ELETRICIDADE S.A. CNPJ 060.444.437/0001-46'}
RE_DATA = re.compile(r'^\d\d/\d\d/\d{4}$')


def _linha_em(todas, y, tol=1.5, x0=0, x1=1e9):
    return sorted([w for w in todas if abs(w.y1 - y) <= tol and x0 <= w.x0 < x1], key=lambda w: w.x0)


def _complementos(todas, ls, d, tj):
    """Tudo o que o gabarito visual traz além do núcleo: boleto, canhoto, constantes, demanda consolidada,
    tabelas complementares, reservado ao fisco, mês de referência dos itens e da GD."""
    doc_, nf, uc_, tit, tot, pag = (d['documento'], d['documento']['nota_fiscal'], d['unidade_consumidora'],
                                    d['titular'], d['totais'], d['pagamento'])
    doc_['distribuidora_ie'] = CONST_LIGHT['ie']
    doc_['distribuidora_endereco'] = CONST_LIGHT['endereco']
    d['outros'].insert(0, {'pagina': 1, 'secao_impressa': 'cabeçalho', 'rotulo': 'INSC. MUNICIPAL',
                           'valor': CONST_LIGHT['insc_municipal']})
    d['extracao']['observacoes'].append('IE, endereço e inscrição municipal da Light: constantes do layout '
                                        '(impressos como imagem; iguais em todos os gabaritos visuais).')
    m = re.search(r'(Resolu\S+ Homologat\S+ n\S* [\d.]+,? de \d\d/\d\d/\d{4})', tj)
    doc_['resolucao_aneel'] = m[1] if m else None
    m = re.search(r'substitui (?:a )?(?:fatura|nota fiscal)\D{0,20}(\d{6,})', tj, re.I)
    nf['nf_substituida'] = m[1] if m else None
    fisco = ' '.join(d.get('_fisco') or [])
    nf['reservado_fisco'] = re.sub(r'\s*\|\|\|\s*', ' ', fisco).strip() or None
    if nf['reservado_fisco']:  # aviso sobre a própria fatura: também em mensagens (spec: transcrever inteiro)
        d['mensagens'].append({'pagina': 1, 'texto': nf['reservado_fisco']})

    # classificação: "A4 - Verde" impresso
    p = [x.strip() for x in (uc_['classificacao'] or '').split('/')]
    uc_['tipo_tarifa_impresso'] = uc_.get('tipo_tarifa_impresso') or (p[1] if uc_['grupo'] == 'A' and len(p) > 1 else None)
    # roteiro de leitura e endereço de correspondência (canto superior direito das consumidoras)
    for l in ls:
        t = l.texto(330, 600).strip()
        if l.y < 90 and re.fullmatch(r'\d{2} \d{2} L\d{3} \d{2} \d{4} Z\d{3}', t):
            uc_['roteiro_leitura'] = t
    topo = [l.texto(330, 600) for l in ls if l.y < 60 and l.entre(330, 600)]
    ent = {'endereco_correspondencia': None, 'unidade_entrega': None, 'sequencia': None, 'endereco_devolucao': None}
    if topo:
        s = re.sub(r'\s*\|\s*MEDIDOR:.*', '', ' '.join(topo))
        s = re.sub(r'^DANF3E.*?ELETR\S*NICA\s*', '', s).strip()
        ent['endereco_correspondencia'] = s
        uc_['endereco'] = ' '.join(x for x in (tit['endereco'], tit['cidade'] and f"- {tit['cidade']}, {tit['uf']}",
                                               tit['cep'] and f"CEP {tit['cep']}") if x)
    d['entrega'] = ent
    # constantes do medidor (consumidoras: uma grandeza)
    tec = {'tensao_nominal': None, 'tensao_contratada_v': None, 'tensao_fornecimento_kv': None, 'tensao_minima': None,
           'tensao_maxima': None, 'faixa_adequada': None, 'fator_potencia_referencia': None, 'rtc': None, 'rtp': None,
           'constantes': [], 'perdas_transformacao_pct': None, 'horario_ponta': None, 'equipamento_medidor': None,
           'responsavel_iluminacao_publica': None}
    if uc_['grupo'] == 'B':
        for me in d['medicoes']:
            if me['constante'] is not None:
                tec['constantes'].append({'grandeza': me['grandeza'], 'valor': me['constante']})
    uc_['tecnico'] = tec

    # mês de referência nos itens ("conta de 02/2026", "DIC Mensal 09/2025", "COSIP RJ - Jan/26")
    for it in d['itens']:
        m = re.search(r'\b(\d{2})/(\d{4})\b', it['descricao'] or '')
        if m and 1 <= int(m[1]) <= 12:
            it['mes_ref'] = f'{m[2]}-{m[1]}'
        else:
            m = re.search(r'\b(' + MES3 + r')/(\d{2})\b', sem_acento(it['descricao'] or '').upper())
            if m:
                it['mes_ref'] = mes_ano(f'{m[1]}/{m[2]}')
    ref_mes = d['referencia']['mes_referencia']
    for x in d['gd']['lancamentos']:
        if x['tipo'] in ('injetada', 'compensada'):
            x['mes_ref'] = ref_mes

    # GD das geradoras: injetada (medição) e compensada (itens), além do saldo
    if uc_['grupo'] == 'A':
        lanc = d['gd']['lancamentos']
        for me in d['medicoes']:
            g = sem_acento(me['grandeza'] or '').upper().replace(' ', '')
            if 'INJETADA' in g and 'KWH' in g:
                lanc.insert(0, {'pagina': 1, 'tipo': 'injetada', 'posto': me['posto'], 'kwh': me['consumo'],
                                'mes_ref': ref_mes, 'ref_expiracao': None, 'unidade_impressa': 'kWh',
                                'rotulo': f"{me['grandeza']} {me['colunas_originais'].get('Postos horários')} (medição)"})
        vistos = set()
        for it in d['itens']:
            if it['componente'] == 'GD_INJETADA' and it['quantidade_faturada'] and it['posto'] not in vistos:
                vistos.add(it['posto'])
                lanc.append({'pagina': 1, 'tipo': 'compensada', 'posto': it['posto'], 'kwh': it['quantidade_faturada'],
                             'mes_ref': ref_mes, 'ref_expiracao': None, 'unidade_impressa': it['unidade'] or 'kWh',
                             'rotulo': it['descricao'] + ' (itens)'})

    # demanda consolidada (geradoras): contratada × medida × faturada × ultrapassagem
    if uc_['grupo'] == 'A':
        montantes = {x['tipo']: x for x in d['demanda']}
        d['tabelas_complementares'].append({'pagina': 1, 'nome': 'GRANDEZAS CONTRATADAS',
                                            'linhas': [{'colunas_originais': x['colunas_originais']} for x in d['demanda']]})
        qtd = lambda comp: next((i['quantidade_faturada'] for i in d['itens'] if i['componente'] == comp), None)
        med = lambda chave: next((m['consumo'] for m in d['medicoes']
                                  if sem_acento(m['grandeza'] or '').upper().replace(' ', '').startswith(chave)), None)
        cons = {'pagina': 1, 'tipo': 'consumo', 'posto': 'UNICO',
                'contratada_kw': (montantes.get('consumo') or {}).get('contratada_kw'),
                'medida_kw': med('DEMANDAATIVA'), 'faturada_kw': qtd('DEMANDA'),
                'faturada_ultrapassagem_kw': qtd('DEMANDA_ULTRAPASSAGEM'), 'nao_consumida_kw': None, 'data_hora': None,
                'rotulo': 'Grandezas Contratadas "Demanda"; medição Demanda Ativa; itens Demanda Ativa/Ultrapassagem',
                'colunas_originais': (montantes.get('consumo') or {}).get('colunas_originais', {})}
        ger = {'pagina': 1, 'tipo': 'geracao', 'posto': 'GERACAO',
               'contratada_kw': (montantes.get('injecao') or {}).get('contratada_kw'),
               'medida_kw': med('DEMANDAINJETADA'), 'faturada_kw': qtd('DEMANDA_GERACAO'),
               'faturada_ultrapassagem_kw': qtd('DEMANDA_GERACAO_ULTRAPASSAGEM'), 'nao_consumida_kw': None,
               'data_hora': None,
               'rotulo': 'Grandezas Contratadas "Demanda Injetada - kW"; medição Demanda injetada; item Demanda Injetada',
               'colunas_originais': (montantes.get('injecao') or {}).get('colunas_originais', {})}
        d['demanda'] = [x for x in (cons, ger) if any(x[k] is not None for k in
                                                       ('contratada_kw', 'medida_kw', 'faturada_kw'))]
    # histórico bruto como tabela complementar
    if d['historico_formato'] == 'texto':
        linhas_h = [l.texto() for l in ls if len(re.findall(MES3 + r'/\d{2}\b', l.texto())) >= 6]
        d['tabelas_complementares'].append({'pagina': 1, 'nome': 'HISTÓRICO',
                                            'linhas': [{'colunas_originais': {'linha': t}} for t in linhas_h]})
    elif d['historico_formato'] == 'tabela':
        ih = _achar(ls, r'CONSUMO FATURADO')
        x0 = min(w.x0 for w in ls[ih].p if w.t == 'CONSUMO') - 12
        lin = []
        for l in ls[ih + 1:]:
            m = re.match(r'^(' + MES3 + r'/\d{2})\s+(\S+)\s+(\S+)\s+(\d+)$', ' '.join(w.t for w in l.entre(x0, 1e9)))
            if m:
                lin.append({'colunas_originais': {'Mês': m[1], '(sem título)': m[2], 'CONSUMO FATURADO': m[3],
                                                  'Nº DIAS FAT': m[4]}})
        d['tabelas_complementares'].append({'pagina': 1, 'nome': 'CONSUMO / kWh', 'linhas': lin})

    # boleto (geradoras): rótulos estão na imagem; valores em posições fixas abaixo do canhoto
    banco = [w for w in todas if w.t == 'BANCO' and w.x0 < 60]
    pagavel = [w for w in todas if sem_acento(w.t).startswith('PAGAVEL') and w.x0 < 60]
    if banco or pagavel:  # fatura quitada: "COMPROVANTE DE PAGAMENTO" no lugar da linha do banco
        yb = banco[0].y1 if banco else pagavel[0].y1 - 17
        bol = {'nosso_numero': None, 'numero_documento': None, 'carteira': None, 'especie': 'R$', 'aceite': None,
               'data_documento': None, 'data_processamento': None, 'beneficiario': CONST_LIGHT['beneficiario'],
               'agencia_codigo_beneficiario': None, 'pagador': None, 'local_pagamento': None, 'instrucoes': None}
        estrela = [w for w in todas if w.t.startswith('*****') and w.x0 > 200 and yb - 40 < w.y1 < yb]
        if estrela:
            ln = _linha_em(todas, estrela[0].y1)
            tot['total_nota_fiscal'] = num(estrela[0].t.strip('*'))
            ret = [w for w in ln if 340 <= w.x0 < 400 and e_numero(w.t)]
            if ret:
                tot['tributos_retidos'] = num(ret[0].t)
        lp = next((l.texto(0, 300).strip() for l in ls if sem_acento(l.texto(0, 300)).startswith('PAGAVEL')), None)
        bol['local_pagamento'] = lp
        d['valores_alternativos'].append({'campo': 'documento.distribuidora_cnpj', 'valor': '060.444.437/0001-46',
                                          'pagina': 1})
        cart = [w for w in todas if yb + 45 < w.y1 < yb + 66 and 180 < w.x0 < 230 and re.fullmatch(r'\d{2,3}', w.t)]
        if cart:
            bol['carteira'] = cart[0].t
        m = re.search(r'\b(\d{4} / \d{5}-\d)\b', tj)
        if m:
            bol['agencia_codigo_beneficiario'] = m[1]
            pag['agencia'] = m[1].split(' / ')[0]
        m = re.search(r'\b(\d{3}/\d{10})\b', tj)
        if m:
            bol['nosso_numero'] = m[1]
            yn = next(w.y1 for w in todas if w.t == m[1])
            datas = [w for w in _linha_em(todas, yn, 2.5) if RE_DATA.match(w.t)]
            if datas:
                bol['data_documento'] = data_br(datas[0].t)
                d['outros'].append({'pagina': 1, 'secao_impressa': 'Boleto', 'rotulo': 'DMI / CLIENTE', 'valor': datas[0].t})
            if len(datas) > 1:
                bol['data_processamento'] = data_br(datas[1].t)
            vdoc = [w for w in todas if yn < w.y1 < yn + 18 and w.x0 > 480 and e_numero(w.t)]
            if vdoc:
                d['outros'].append({'pagina': 1, 'secao_impressa': 'Boleto', 'rotulo': 'Valor de Documento',
                                    'valor': vdoc[0].t})
        instr = [l.texto(0, 400) for l in ls if l.y > yb and re.match(r'(Receber|Pagamento com cheque|Anotar)', l.texto())]
        bol['instrucoes'] = ' '.join(instr) or None
        # pagador: bloco da esquerda no pé do boleto (nome, endereço, CNPJ só dígitos)
        pagador = [l for l in ls if yb + 105 < l.y < yb + 142 and l.entre(36, 60)
                   and not re.match(r'(Receber|Pagamento com cheque|Anotar)', l.texto())]
        bol['pagador'] = ' '.join(l.texto(0, 400) for l in pagador) or None
        cnpj = next((re.search(r'\b(\d{14}|\d{11})\b', l.texto(0, 400))[1] for l in pagador
                     if re.search(r'\b(\d{14}|\d{11})\b', l.texto(0, 400))), None)
        if cnpj:
            d['valores_alternativos'].append({'campo': 'titular.cnpj_cpf', 'valor': cnpj, 'pagina': 1})
        cobr = [w for w in todas if w.y1 > yb + 105 and w.x0 > 480 and e_numero(w.t)]
        if cobr:
            d['outros'].append({'pagina': 1, 'secao_impressa': 'Boleto', 'rotulo': '(=) Valor Cobrado',
                                'valor': cobr[-1].t})
        pag['boleto'] = bol
    else:
        pag['boleto'] = None
        # canhoto das consumidoras: vencimento, total, código, mês
        est = [w for w in todas if w.t.startswith('*****') and w.x0 < 200 and w.y1 > 700]
        if est:
            ln = _linha_em(todas, est[0].y1, 2)
            d['outros'].append({'pagina': 1, 'secao_impressa': 'canhoto', 'rotulo': 'VENCIMENTO / TOTAL A PAGAR / CÓDIGO / MÊS',
                                'valor': ' / '.join(w.t.strip('*') for w in ln)})
    pag.setdefault('conta_recebedora', None)
