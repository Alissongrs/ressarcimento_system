"""Parser determinístico das faturas Equatorial (modelo GO; testar AL/PA/MA/PI), 2–5 páginas, página 909×1210.

Cabeçalhos das colunas estão na imagem de fundo: as colunas são lidas pela posição fixa da borda direita dos
números (proporcional à largura da página). p1: dados, tributos, SCEE, itens, medições (continuam na p2), boleto;
p3: histórico de 13 meses (10 colunas).
"""
import re

from base import (data_br, e_numero, esqueleto, linhas, mes_ano, num, palavras, posto_de, sem_acento)

NOME = 'equatorial_v1'
CNPJS = {'01.543.032/0001-04': ('EQUATORIAL GO', 'EQUATORIAL GOIÁS DISTRIBUIDORA DE ENERGIA S/A'),
         '12.272.084/0001-00': ('EQUATORIAL AL', 'EQUATORIAL ALAGOAS DISTRIBUIDORA DE ENERGIA S.A.'),
         '04.895.728/0001-80': ('EQUATORIAL PA', 'EQUATORIAL PARÁ DISTRIBUIDORA DE ENERGIA S.A.'),
         '06.272.793/0001-84': ('EQUATORIAL MA', 'EQUATORIAL MARANHÃO DISTRIBUIDORA DE ENERGIA S.A.'),
         '06.840.748/0001-89': ('EQUATORIAL PI', 'EQUATORIAL PIAUÍ DISTRIBUIDORA DE ENERGIA S.A.')}
MES3 = r'(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)'
LARG = 909.0
# borda direita (x1) de cada coluna da tabela de itens, na página de 909 pt
COL_ITENS = {'quant': 272, 'preco': 333, 'valor': 399, 'pis_cofins': 451, 'base_icms': 505, 'aliquota_icms': 543,
             'icms': 590, 'tarifa': 631}
COL_MED = {'leitura_anterior': 340, 'leitura_atual': 408, 'constante': 478, 'consumo': 549}
HIST_COLS = [  # colunas da p3 da esquerda para a direita (modelo 2026, 10 colunas) → (rótulo, série, posto, unidade)
    ('DEMANDA MEDIDA Ponta', 'demanda', 'PONTA', 'kW'), ('DEMANDA MEDIDA Fora Ponta', 'demanda', 'FORA_PONTA', 'kW'),
    ('DEMANDA MEDIDA Reativo Excedente', 'reativo_dre', None, 'kVAr'),
    ('CONSUMO FATURADO Ponta', 'consumo', 'PONTA', 'kWh'), ('CONSUMO FATURADO Fora Ponta', 'consumo', 'FORA_PONTA', 'kWh'),
    ('CONSUMO FATURADO Reativo Excedente', 'reativo_ere', None, 'kVArh'),
    ('HORÁRIO RESERVADO Consumo', 'consumo', 'RESERVADO', 'kWh'),
    ('HORÁRIO RESERVADO Reativo Excedente', 'reativo_ere', 'RESERVADO', 'kVArh'),
    ('ENERGIA INJETADA Ponta', 'injetada', 'PONTA', 'kWh'), ('ENERGIA INJETADA Fora Ponta', 'injetada', 'FORA_PONTA', 'kWh')]


def _cnpj_da_chave(t):
    m = re.search(r'\b\d{6}(\d{14})\d{24}\b', t.replace(' ', ''))
    if not m:
        return None
    c = m[1]
    return f'{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:]}'


def detecta(texto, doc=None):
    # só o modelo GO (página 909×1210); PI/MA/PA/AL usam outro layout (DANF3E A4)
    if doc is not None and abs(doc[0].rect.width - LARG) > 5:
        return False
    return _cnpj_da_chave(texto) in CNPJS or ('EQUATORIAL' in texto.upper() and 'INFORMAÇÕES DO SCEE' in texto)


def componente_de(desc):
    d = sem_acento(desc).upper()
    if 'BENEFICIO TARIFARIO' in d:
        return 'OUTRO', None
    if d.startswith('PARC INJET'):  # parcela injetada sem desconto (TUSD cobrada)
        return 'TUSD', _posto_eq(d)
    if 'INJECAO' in d or 'INJET' in d:
        return 'GD_INJETADA', _posto_eq(d)
    if 'ULTRA' in d and 'GERACAO' in d:
        return 'DEMANDA_GERACAO_ULTRAPASSAGEM', 'GERACAO'
    if 'DEMANDA' in d and 'GERACAO' in d:
        return 'DEMANDA_GERACAO', 'GERACAO'
    if 'ULTRA' in d:
        return 'DEMANDA_ULTRAPASSAGEM', 'UNICO'
    if 'DMCR' in d or 'UFER' in d or 'REATIV' in d:
        return 'REATIVO_EXCEDENTE', _posto_eq(d)
    if 'DEMANDA' in d:
        return 'DEMANDA', 'UNICO'
    if 'PARCELA TE' in d or re.search(r'\bTE\b', d):
        return 'TE', _posto_eq(d)
    if 'TUSD' in d or 'CONSUMO' in d:
        return 'TUSD', _posto_eq(d)
    if 'ILUM' in d or 'CIP' in d.split():
        return 'ILUMINACAO_PUBLICA', None
    if 'JUROS' in d:
        return 'JUROS', None
    if 'MULTA' in d:
        return 'MULTA', None
    if 'ATUALIZ' in d or 'IPCA' in d or 'CORRECAO' in d:
        return 'ATUALIZACAO_MONETARIA', None
    if re.search(r'\b(DIC|FIC|DMIC|DICRI)\b', d):
        return 'COMPENSACAO_CONTINUIDADE', None
    if 'PARCELAMENTO' in d or 'PARCELA ' in d:
        return 'PARCELAMENTO', None
    if 'DEVOL' in d or 'ESTORNO' in d or 'RESTITUI' in d:
        return 'ESTORNO', None
    return 'AJUSTE', None


def _posto_eq(d):
    d = ' ' + d + ' '
    if re.search(r' FP ', d):
        return 'FORA_PONTA'
    if re.search(r' HR ', d):
        return 'RESERVADO'
    if re.search(r' P ', d):
        return 'PONTA'
    return posto_de(d)


def _por_coluna(ws, cols, escala, tol=16):
    """número → coluna cuja borda direita (escalada) está mais perto; fora da tolerância fica sem coluna."""
    out = {}
    for w in ws:
        k = min(cols, key=lambda c: abs(cols[c] * escala - w.x1))
        if abs(cols[k] * escala - w.x1) <= tol * escala:
            out[k] = w.t if k not in out else out[k] + ' ' + w.t
    return out


def _agrupar(ws, tol):
    out = []
    for w in sorted(ws, key=lambda w: w.y1):
        if out and abs(out[-1][0] - w.y1) <= tol:
            out[-1][1].append(w)
        else:
            out.append([w.y1, [w]])
    return out


def _itens_paginas(pags, d):
    """A lista de itens continua nas páginas seguintes (mesma faixa de altura) até a página do TOTAL."""
    secao = [None]
    faixas = []
    for np_, todas, esc in pags:
        ini = [w for w in todas if w.t == 'FORNECIMENTO' and w.x0 < 60 * esc]
        fim = [w for w in todas if w.t == 'TOTAL' and w.x0 < 60 * esc and 380 * esc < w.y1 < 720 * esc]
        y0 = ini[0].y0 - 1 if ini else 380 * esc
        y1 = fim[0].y1 if fim else 706 * esc
        # a tabela de medições pode começar logo abaixo dos itens (modelo 2025): corta na 1ª linha com medidor
        meds = [w.y0 for w in todas if re.fullmatch(r'\d{5,}-\d', w.t) and y0 < w.y1 < y1 + 1]
        if meds:
            y1 = min(y1, min(meds) - 1)
        faixas.append((np_, todas, esc, y0, y1, bool(fim)))
        if fim:
            break
    else:
        return False
    # colunas calibradas pela própria fatura (modelos 2025/2026 têm posições diferentes)
    x1s = sorted(w.x1 for _, todas, esc, y0, y1, _f in faixas for w in todas
                 if y0 <= w.y1 < y1 - 1 and 245 * esc <= w.x0 < 640 * esc and e_numero(w.t))
    grupos = []
    for x in x1s:
        if grupos and x - grupos[-1][-1] <= 9:
            grupos[-1].append(x)
        else:
            grupos.append([x])
    grupos = [g for g in grupos if len(g) >= 2]
    cols = None
    if len(grupos) == len(COL_ITENS):
        cols = {k: sorted(g)[len(g) // 2] for k, g in zip(COL_ITENS, grupos)}
    for np_, todas, esc, y0, y1, tem in faixas:
        _itens(todas, d, esc, np_, y0, y1, tem, secao, cols)
    if cols is None:
        d['extracao']['observacoes'].append(f'colunas dos itens pela posição padrão ({len(grupos)} grupos de x)')
    return True


def _itens(todas, d, esc, np_, y0, y1, tem_total, secao_ref, cols_cal=None):
    cols_it, esc_it = (cols_cal, 1.0) if cols_cal else (COL_ITENS, esc)
    x_lim = 640 * esc  # à direita: quadro de tributos / demanda contratada
    ws = [w for w in todas if y0 <= w.y1 < y1 - 1 and w.x0 < x_lim]
    ws = [w for w in ws if not (w.x0 > 590 * esc and w.y1 > 700 * esc)]  # aviso judicial à direita
    desc_ws = [w for w in ws if w.x0 < 210 * esc]
    num_ws = [w for w in ws if w.x0 >= 210 * esc]
    lnum = _agrupar(num_ws, 2.2)
    ldesc = [(y, ' '.join(w.t for w in sorted(g, key=lambda w: w.x0))) for y, g in _agrupar(desc_ws, 2.2)]
    secao = secao_ref[0]
    usados = set()
    for y, txt in ldesc:
        cand = [k for k, (yn, _) in enumerate(lnum) if -1 <= yn - y <= 4.5 and k not in usados]
        if not cand:
            if txt in ('FORNECIMENTO', 'ITENS FINANCEIROS') or (txt.isupper() and len(txt.split()) <= 2
                                                                 and not any(c.isdigit() for c in txt)):
                secao = secao_ref[0] = txt
                continue
            it = _item(txt, {}, secao, 'INFO', None)
            it['pagina'] = np_
            d['itens'].append(it)
            continue
        k = min(cand, key=lambda k: abs(lnum[k][0] - y))
        usados.add(k)
        g = lnum[k][1]
        unid = [w for w in g if not e_numero(w.t) and w.x1 < 252 * esc]
        nums = [w for w in g if e_numero(w.t)]
        cols = _por_coluna(nums, cols_it, esc_it, tol=16 * esc / esc_it)
        comp, posto = componente_de(txt)
        it = _item(txt, cols, secao, comp, posto)
        it['unidade'] = ' '.join(w.t for w in unid) or None
        it['pagina'] = np_
        d['itens'].append(it)
    if not tem_total:
        return
    tot = [w for w in todas if abs(w.y1 - y1) <= 1.5 and w.x0 > 210 * esc and w.x0 < x_lim and e_numero(w.t)]
    tc = _por_coluna(tot, cols_it, esc_it, tol=16 * esc / esc_it)
    rot = {'valor': 'Valor (R$)', 'pis_cofins': 'PIS/COFINS (R$)', 'base_icms': 'Base ICMS (R$)', 'icms': 'ICMS (R$)'}
    for k, v in tc.items():
        if k in rot:
            d['totais']['totais_colunas'].append({'pagina': np_, 'coluna': rot[k], 'valor': num(v)})
    return y1


def _item(desc, cols, secao, comp, posto):
    return {'pagina': 1, 'secao_impressa': secao, 'codigo': None, 'descricao': desc, 'mes_ref': None,
            'componente': comp, 'posto': posto, 'quantidade_registrada': None,
            'quantidade_faturada': num(cols.get('quant')), 'unidade': None,
            'tarifa_com_tributos': num(cols.get('preco')), 'tarifa_sem_tributos': num(cols.get('tarifa')),
            'valor': num(cols.get('valor')), 'valor_sem_tributos': None, 'base_icms': num(cols.get('base_icms')),
            'aliquota_icms': num(cols.get('aliquota_icms')), 'icms': num(cols.get('icms')), 'base_pis_cofins': None,
            'aliquota_pis': None, 'pis': None, 'aliquota_cofins': None, 'cofins': None,
            'pis_cofins': num(cols.get('pis_cofins')), 'nf_referencia': None,
            'colunas_originais': {'descricao': desc, **cols}}


def _medicoes(pags, d):
    vistos = set()
    for np_, todas, esc in pags:
        for y, g in _agrupar([w for w in todas if w.x0 < 600 * esc and w.y1 > 690 * esc], 1.8):
            # medidor "NNNNNNNN-N" à esquerda (modelo 2026) ou à direita (modelo 2025) da linha
            g = sorted(g, key=lambda w: w.x0)
            med = next((w for w in g if re.fullmatch(r'\d{5,}-\d', w.t)), None)
            resto = [w for w in g if w is not med]
            if not med or not resto or not re.match(r'(ENERGIA|DEMANDA|UFER|DMCR)', resto[0].t):
                continue
            postos = ('PONTA', 'FORA', 'RESERVADO', 'INTERMEDIÁRIO', 'INTERMEDIARIO', 'ÚNICO')
            k = next((i for i, w in enumerate(resto) if w.t in postos), len(resto))
            nums = [w for w in resto[k:] if e_numero(w.t)]
            gr = ' '.join(w.t for w in resto[:k])
            po = ' '.join(w.t for w in resto[k:] if not e_numero(w.t))
            v = [w.t for w in nums[:4]] + [None] * (4 - len(nums[:4]))
            cols = {c: x for c, x in zip(('leitura_anterior', 'leitura_atual', 'constante', 'consumo'), v) if x}
            g = [med] + resto
            un = 'kW' if re.search(r'-\s*KW\b', gr.upper()) else ('kVArh' if 'UFER' in gr.upper() else
                                                                  ('kVAr' if 'DMCR' in gr.upper() else 'kWh'))
            d['medicoes'].append({'pagina': np_, 'tabela_origem': 'Medição', 'medidor': g[0].t, 'grandeza': gr,
                                  'posto': posto_de(po) or ('RESERVADO' if 'RESERVADO' in po else
                                                            ('INTERMEDIARIO' if 'INTERMED' in sem_acento(po).upper()
                                                             else None)),
                                  'leitura_anterior': num(cols.get('leitura_anterior')),
                                  'leitura_atual': num(cols.get('leitura_atual')), 'constante': num(cols.get('constante')),
                                  'perdas_pct': None, 'ajuste': None, 'consumo': num(cols.get('consumo')),
                                  'consumo_faturado': None, 'fator_potencia': None, 'ajuste_fator_potencia': None,
                                  'unidade': un, 'data_hora_registro': None, 'leitura_arredondada': False,
                                  'colunas_originais': {'Medidor': g[0].t, 'Grandeza': gr, 'Posto': po, **cols}})
            if g[0].t not in d['unidade_consumidora']['medidor']:
                d['unidade_consumidora']['medidor'].append(g[0].t)


def _historico(pags, d):
    for np_, todas, esc in pags:
        rows = []
        for y, g in _agrupar(todas, 2.0):
            g = sorted(g, key=lambda w: w.x0)
            t = ' '.join(w.t for w in g[:3])
            m = re.match(r'(' + MES3 + r') / (\d{2})$', t)
            if m:
                rows.append((mes_ano(f'{m[1]}/{m[2]}'), [w.t for w in g[3:] if e_numero(w.t)]))
        if len(rows) < 3:
            continue
        ncols = max(len(v) for _, v in rows)
        tab = {'pagina': np_, 'nome': 'HISTÓRICO DE CONSUMO (13 meses)', 'linhas': []}
        mapa = HIST_COLS if ncols == 10 else (HIST_COLS[:8] if ncols == 8 else None)  # 2025: sem injetada
        for mes, vs in rows:
            if mapa and len(vs) == ncols:
                cols = {rot: v for (rot, *_), v in zip(mapa, vs)}
                for (rot, serie, posto, un), v in zip(mapa, vs):
                    d['historico'].append({'pagina': np_, 'mes': mes, 'serie': serie, 'posto': posto, 'valor': num(v),
                                           'unidade': un, 'unidade_original': None, 'faturado_pela_media': False})
            else:  # modelo com outra quantidade de colunas: rótulos a confirmar no gabarito visual
                cols = {f'col{k + 1}': v for k, v in enumerate(vs)}
            tab['linhas'].append({'colunas_originais': {'Mês': mes, **cols}})
        d['tabelas_complementares'].append(tab)
        d['historico_formato'] = 'tabela' if d['historico'] else 'tabela_sem_rotulo'
        if not d['historico']:
            d['extracao']['observacoes'].append(f'Histórico com {ncols} colunas: transcrito em tabelas_complementares; '
                                                'rótulos das colunas ainda não mapeados para séries.')
        return
    d['historico_formato'] = 'ausente'


def _scee(tj, d):
    lanc = d['gd']['lancamentos']
    ref = d['referencia']['mes_referencia']
    m = re.search(r'INFORMA\S+ DO SCEE:(.*?)(?=NOTIFICA|A SUSPENS|Nota fiscal emitida|$)', tj)
    if not m:
        return
    s = m[1]
    d['mensagens'].append({'pagina': 1, 'texto': 'INFORMAÇÕES DO SCEE:' + s.rstrip()})

    def pfh(trecho, tipo, rot, mes=None):
        for p, posto in (('P', 'PONTA'), ('FP', 'FORA_PONTA'), ('HR', 'RESERVADO')):
            mm = re.search(r'\b' + p + r'=(-?[\d.,]+)', trecho)
            if mm:
                lanc.append({'pagina': 1, 'tipo': tipo, 'posto': posto, 'kwh': num(mm[1].rstrip(',')),
                             'mes_ref': mes, 'ref_expiracao': None, 'unidade_impressa': 'kWh', 'rotulo': rot})
    g = re.search(r'GERA\S+ CICLO \((\d+)/(\d{4})\) KWH:(?: UC (\d+) :)?(.*?)(?=EXCEDENTE|CR\S+DITO|SALDO|$)', s)
    if g:
        pfh(g[4], 'injetada', f'GERAÇÃO CICLO ({g[1]}/{g[2]})', f'{g[2]}-{int(g[1]):02d}')
        d['gd']['uc_geradora'] = g[3]
    e = re.search(r'EXCEDENTE RECEBIDO KWH:(?: UC \d+ :)?(.*?)(?=CR\S+DITO|SALDO|$)', s)
    if e:
        pfh(e[1], 'excedente', 'EXCEDENTE RECEBIDO')
    c = re.search(r'CR\S+DITO RECEBIDO KWH:?\s*(-?[\d.,]+)', s)
    if c:
        lanc.append({'pagina': 1, 'tipo': 'compensada', 'posto': None, 'kwh': num(c[1].rstrip(',')), 'mes_ref': ref,
                     'ref_expiracao': None, 'unidade_impressa': 'kWh', 'rotulo': 'CRÉDITO RECEBIDO KWH'})
    sa = re.search(r'SALDO KWH:(.*?)(?=SALDO A EXPIRAR|CADASTRO|$)', s)
    if sa:
        pfh(sa[1], 'saldo_atual', 'SALDO KWH')
    for dias, v in re.findall(r'SALDO A EXPIRAR EM (\d+) DIAS KWH:\s*(-?[\d.,]+)', s):
        lanc.append({'pagina': 1, 'tipo': 'a_expirar', 'posto': None, 'kwh': num(v.rstrip(',')), 'mes_ref': None,
                     'ref_expiracao': f'{dias} dias', 'unidade_impressa': 'kWh',
                     'rotulo': f'SALDO A EXPIRAR EM {dias} DIAS'})
    for uc, pct in re.findall(r'CADASTRO RATEIO GERA\S+: UC (\d+) = ([\d.,]+)%', s):
        d['gd']['rateio_beneficiarias'].append({'uc': uc, 'percentual': num(pct), 'kwh': None})


def parse(doc, fid, caminho):
    d = esqueleto(fid, caminho, len(doc))
    d['extracao']['parser'] = NOME
    d['totais'].update({'tributos_retidos': None, 'subtotais': [], 'totais_colunas': [], 'total_nota_fiscal': None})
    d['gd'] = {'uc_geradora': None, 'conta_contrato_geradora': None, 'participacao_pct': None, 'lancamentos': [],
               'rateio_beneficiarias': []}
    pags = []
    for i, pg in enumerate(doc):
        esc = pg.rect.width / LARG
        pags.append((i + 1, palavras(pg), esc))
    np1, t1, esc = pags[0]
    ls = linhas(t1)
    tj = ' '.join(l.texto() for l in ls)
    d['extracao']['paginas_lidas'] = [p for p, *_ in pags]
    d['extracao']['paginas'] = [{'pagina': p, 'tipo': 'conteudo' if len(t) > 30 else 'em_branco',
                                 'repete_pagina': None} for p, t, _ in pags]
    doc_, nf = d['documento'], d['documento']['nota_fiscal']
    todo_txt = ' '.join(' '.join(w.t for w in t) for _, t, _ in pags)
    m = re.search(r'\b(\d{44})\b', todo_txt)  # CNPJ do emitente = posições 7–20 da chave de acesso
    c = m[1][6:20] if m else None
    cnpj = f'{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:]}' if c else None
    sig, nome = CNPJS.get(cnpj, ('OUTRA', None))
    doc_.update({'distribuidora_sigla': sig, 'distribuidora': nome, 'distribuidora_cnpj': cnpj})
    if 'Segunda via' in tj:
        doc_['segunda_via'] = True
    # NF3e (procura em todas as páginas: às vezes só na p2)
    m = re.search(r'NOTA FISCAL N\S*\s*(\d+)\s*-\s*S\S*RIE\s*(\d+)\s*/\s*DATA DE EMISS\S*\s*(\d\d/\d\d/\d{4})(?:\s+(\d\d:\d\d:\d\d))?',
                  todo_txt)
    if m:
        nf.update({'numero': m[1], 'serie': m[2], 'modelo': 'NF3e',
                   'data_emissao': data_br(m[3]) + (f'T{m[4]}' if m[4] else '')})
        d['referencia']['data_emissao'] = data_br(m[3])
    m = re.search(r'\b(\d{44})\b', todo_txt)
    nf['chave_acesso'] = m[1] if m else None
    m = re.search(r'Protocolo de autoriza\S*\s*(\d+)\s*-\s*(\d\d/\d\d/\d{4})\s*\S+\s*(\d\d:\d\d:\d\d)', todo_txt)
    if m:
        nf['protocolo_autorizacao'] = m[1]
        nf['data_autorizacao'] = f'{data_br(m[2])}T{m[3]}'
    m = re.search(r'(https?://dfe-portal\S+)', todo_txt)
    nf['url_consulta'] = m[1] if m else None
    m = re.search(r'CFOP (\d{4}):?\s*([^|]*?)(?=\s{2}|$| Classifica| NOTA| Tens)', todo_txt)
    nf['cfop'] = f'{m[1]}: {m[2].strip()}' if m else None

    uc_, tit, ref = d['unidade_consumidora'], d['titular'], d['referencia']
    m = re.search(r'Classifica\S+:\s*(.*?)\s+Tipo de Fornecimento', tj) or \
        re.search(r'Classifica\S+:\s*(.*?THS_\w+|.*?CONVENCIONAL\w*)', todo_txt)
    cls = None
    if m:
        cls = re.sub(r'\s+', ' ', m[1]).strip()
        # a linha de baixo da classificação (x<300) vem antes de "Tipo de Fornecimento" só no texto da p1
    y_cls = next((l.y for l in ls if sem_acento(l.texto(0, 300 * esc)).startswith('Classificacao')), None)
    y_ten0 = next((l.y for l in ls if sem_acento(l.texto(0, 300 * esc)).startswith('Tensao Nominal')), None)
    linhas_cls = [l.texto(0, 300 * esc) for l in ls if y_cls is not None and y_ten0 is not None
                  and y_cls - 1 <= l.y < y_ten0 - 1 and l.entre(0, 300 * esc)]
    if linhas_cls:
        cls = ' '.join(linhas_cls).replace('Classificação: ', '').strip()
    uc_['classificacao'] = cls
    if cls:
        m = re.match(r'([AB])\s+([AB]\d(?:-[A-Z])?)', cls)
        if m:
            uc_['grupo'] = m[1]
            uc_['subgrupo'] = m[2]  # como impresso ("A3-A")
        mm = re.search(r'THS_(\w+)', cls)
        if mm:
            uc_['tipo_tarifa_impresso'] = 'THS_' + mm[1]
            uc_['modalidade_tarifaria'] = mm[1].capitalize()
        elif 'CONVENCIONAL' in cls:
            uc_['modalidade_tarifaria'] = 'Convencional'
    m = re.search(r'Tipo de Fornecimento:\s*(\S+)', tj)
    uc_['tipo_fornecimento'] = m[1] if m else None
    tec = {'tensao_nominal': None, 'tensao_contratada_v': None, 'tensao_fornecimento_kv': None, 'tensao_minima': None,
           'tensao_maxima': None, 'faixa_adequada': None, 'fator_potencia_referencia': None, 'rtc': None, 'rtp': None,
           'constantes': [], 'perdas_transformacao_pct': None, 'horario_ponta': None, 'equipamento_medidor': None,
           'responsavel_iluminacao_publica': None}
    m = re.search(r'Tens\S+ Nominal Disp:\s*([\d.]+)\s*V\s+Lim Min:\s*([\d.]+)\s*V\s+Lim Max:\s*([\d.]+)\s*V', todo_txt)
    if m:
        tec.update({'tensao_nominal': f'{m[1]} V', 'tensao_minima': num(m[2]), 'tensao_maxima': num(m[3])})
    m = re.search(r'PERDAS DE TRANSFORMA\S+ / RAMAL:\s*([\d.,]+)\s*%', tj)
    if m:
        tec['perdas_transformacao_pct'] = num(m[1])
    uc_['tecnico'] = tec

    # titular: bloco da esquerda (x≈22) abaixo da tensão até o CEP
    y_ten = next((l.y for l in ls if sem_acento(l.texto(0, 300 * esc)).startswith('Tensao Nominal')), 125 * esc)
    y_per = next((l.y for l in ls if l.texto(0, 300 * esc).startswith('PERDAS DE')), 205 * esc)
    esq = [l for l in ls if y_ten + 2 < l.y < y_per - 2 and l.entre(0, 300 * esc)]
    bloco = [l.texto(0, 300 * esc).strip() for l in esq]
    if bloco:
        tit['nome'] = bloco[0]
        end = []
        for t in bloco[1:]:
            m = re.search(r'CNPJ/CPF:\s*([\d./-]+)(?:\s+INSC\. ESTADUAL:\s*(\S+))?', t)
            if m:
                tit['cnpj_cpf'] = m[1]
                tit['inscricao_estadual'] = m[2]
                continue
            m = re.match(r'CEP:\s*(\d{5}-?\d{3})\s+(.*?)\s+([A-Z]{2})\s+BRASIL', t)
            if m:
                tit['cep'], tit['cidade'], tit['uf'] = m[1], m[2], m[3]
                continue
            end.append(t)
        tit['endereco'] = re.sub(r'\s+', ' ', ' '.join(end)).strip() or None
    uc_['endereco'] = ' '.join(x for x in (tit['endereco'], tit['cep'] and f"CEP: {tit['cep']} {tit['cidade']} {tit['uf']}") if x)
    # UC (formato novo pontuado ou 11 dígitos) e parceiro de negócio (número acima dela), no meio do cabeçalho
    meio = sorted([w for w in t1 if 330 * esc < w.x0 < 470 * esc and 150 * esc < w.y1 < 215 * esc
                   and re.fullmatch(r'\d\.\d{3}\.\d{3}\.\d{3}-\d{2}|\d{6,12}', w.t)], key=lambda w: w.y1)
    if meio:
        uc_['uc'] = meio[-1].t
        if len(meio) > 1:
            tit['parceiro_negocio'] = meio[0].t
    cc = [w for w in t1 if 150 * esc < w.x0 < 260 * esc and 1085 * esc < w.y1 < 1112 * esc and re.fullmatch(r'\d{10}', w.t)]
    if cc:
        tit['conta_contrato'] = cc[0].t
    topo = [l.texto(690 * esc, 2000) for l in ls if l.y < 90 * esc and l.entre(690 * esc, 2000)]
    ent = ' '.join(t for t in topo if 'ENDEREÇO DE ENTREGA' not in t).strip()
    d['entrega'] = {'endereco_correspondencia': ent or None, 'unidade_entrega': None, 'sequencia': None,
                    'endereco_devolucao': None}

    m = re.search(r'(\d\d/\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+(\d{1,3})\s+(\d\d/\d\d/\d{4})', tj)
    if m:
        ref.update({'leitura_anterior': data_br(m[1]), 'leitura_atual': data_br(m[2]), 'dias_faturados': int(m[3]),
                    'proxima_leitura': data_br(m[4])})
    m = re.search(r'\b(' + MES3 + r'/\d{4})\s+R\$\**([\d.]+,\d\d)\s+(\d\d/\d\d/\d{4})', tj)
    if m:
        ref['mes_referencia'] = mes_ano(m[1])
        d['totais']['total_a_pagar'] = num(m[2])
        ref['data_vencimento'] = data_br(m[3])
    else:  # modelo 2025: mês, vencimento, total
        m = re.search(r'\b(' + MES3 + r'/\d{4})\s+(\d\d/\d\d/\d{4})\s+R\$\**([\d.]+,\d\d)', tj)
        if m:
            ref['mes_referencia'] = mes_ano(m[1])
            ref['data_vencimento'] = data_br(m[2])
            d['totais']['total_a_pagar'] = num(m[3])

    # tributos (quadro à direita, acima dos itens)
    trib = [w for w in t1 if w.x0 >= 640 * esc and 300 * esc < w.y1 < 700 * esc]
    for y, g in _agrupar(trib, 2.5):
        t = ' '.join(w.t for w in sorted(g, key=lambda w: w.x0))
        m = re.match(r'(PIS/PASEP|PIS|ICMS|COFINS)\s+([\d.,]+)\s+([\d.,]+)%\s+([\d.,]+)', t)
        if m:
            d['tributos'].append({'pagina': 1, 'tributo': {'PIS/PASEP': 'PIS'}.get(m[1], m[1]), 'base': num(m[2]),
                                  'aliquota': num(m[3]), 'valor': num(m[4]), 'retido': False,
                                  'colunas_originais': {'Tributo': m[1], 'Base': m[2], 'Alíquota': m[3] + '%',
                                                        'Valor': m[4]}})
    # demanda contratada (quadro à direita dos itens)
    for y, g in _agrupar([w for w in t1 if w.x0 >= 640 * esc and 300 * esc < w.y1 < 700 * esc], 2.5):
        t = ' '.join(w.t for w in sorted(g, key=lambda w: w.x0))
        m = re.match(r'(DEMANDA(?: GERA\S+)? - kW)\s+([\d.,]+)$', t)
        if m:
            d['demanda'].append({'pagina': 1, 'tipo': 'geracao' if 'GERA' in m[1] else 'consumo',
                                 'posto': 'GERACAO' if 'GERA' in m[1] else None, 'contratada_kw': num(m[2]),
                                 'medida_kw': None, 'faturada_kw': None, 'faturada_ultrapassagem_kw': None,
                                 'nao_consumida_kw': None, 'data_hora': None, 'rotulo': m[1],
                                 'colunas_originais': {m[1]: m[2]}})
    _itens_paginas(pags, d)
    _medicoes(pags, d)
    _historico(pags, d)
    _scee(tj, d)
    for x in d['gd']['lancamentos']:
        if x['tipo'] == 'compensada':
            x['mes_ref'] = ref['mes_referencia']

    # quadros soltos à direita das medições (Informações sobre Consumo / Resolução ANEEL)
    m = re.search(r'\b(\d{3,4}/\d{2})\b', ' '.join(w.t for w in t1 if w.x0 > 780 * esc and 790 * esc < w.y1 < 830 * esc))
    if m:
        d['documento']['resolucao_aneel'] = m[1]
    soltos = sorted([w for w in t1 if w.x0 > 700 * esc and 760 * esc < w.y1 < 800 * esc], key=lambda w: w.y1)
    for w in soltos:
        d['outros'].append({'pagina': 1, 'secao_impressa': 'Informações sobre Consumo', 'rotulo': f'y={w.y1:.0f}',
                            'valor': w.t})
    # mensagens (processo judicial à direita; notificações no pé da p1)
    for l in ls:
        t = l.texto(590 * esc, 2000).strip()
        if 700 * esc < l.y < 745 * esc and t:
            d['mensagens'].append({'pagina': 1, 'texto': t})
    for l in ls:
        t = l.texto().strip()
        if 890 * esc < l.y < 1000 * esc and t:
            d['mensagens'].append({'pagina': 1, 'texto': t})
    _boleto(t1, ls, d, esc, tj)
    _complementos(pags, ls, d, tj, todo_txt, esc)
    tv = next((x['valor'] for x in d['totais']['totais_colunas'] if x['coluna'].startswith('Valor')), None)
    d['totais']['total_nota_fiscal'] = tv
    # demanda (kW/kVAr) não é leitura acumulada: o consumo impresso não é (atual − anterior) × constante
    for j, me in enumerate(d['medicoes']):
        la, lb, c, cons = me['leitura_anterior'], me['leitura_atual'], me['constante'], me['consumo']
        if me['unidade'] in ('kW', 'kVAr') and None not in (la, lb, c, cons) and c and \
                abs((lb - la) * c - cons) > max(1, abs(cons) * 0.01):
            d['extracao']['divergencias_impressas'].append(
                {'onde': 'medicao', 'indice': j, 'nota': f'{me["grandeza"]} {me["posto"]}: registro de demanda; '
                                                         f'consumo impresso {cons} ≠ ({lb}−{la})×{c} (impresso assim)'})
    return d


def _boleto(t1, ls, d, esc, tj):
    """Boleto no pé da p1, ancorado na linha "BANCO …" (a altura muda entre modelos; BB ou Itaú)."""
    pag = d['pagamento']
    banco = next((l for l in ls if l.y > 900 * esc and l.texto(0, 200 * esc).startswith('BANCO ')), None)
    m = re.search(r'(\d{5}\.\d{5}\s+\d{5}\.\d{6}\s+\d{5}\.\d{6}\s+\d\s+\d{14,})', tj)
    pag['linha_digitavel'] = m[1] if m else None
    m = re.search(r'(00020101\S+)\s*(\S*)', ' '.join(l.texto() for l in ls if l.y > 1100 * esc))
    pag['pix'] = (m[1] + m[2]) if m else None
    m = re.search(r'c\S+digo (\d{8,})', tj)
    if m and 'débito automático' in tj and not pag.get('debito_automatico'):
        pag['debito_automatico'] = f'Código para débito automático: {m[1]}'
    if not banco:
        pag['boleto'] = None
        pag.setdefault('conta_recebedora', None)
        return
    yb = banco.y
    bc = re.search(r'\b(\d{3}-\d)\b', ' '.join(l.texto() for l in ls if abs(l.y - yb) < 4))
    pag['banco'] = banco.texto(0, 200 * esc).strip() + (f' {bc[1]}' if bc else '')
    bol = {'nosso_numero': None, 'numero_documento': None, 'carteira': None, 'especie': None, 'aceite': None,
           'data_documento': None, 'data_processamento': None, 'beneficiario': None, 'agencia_codigo_beneficiario': None,
           'pagador': None, 'local_pagamento': None, 'instrucoes': None}
    abaixo = [l for l in ls if yb < l.y < yb + 210 * esc]
    y_instr = None
    for l in abaixo:
        t = l.texto()
        if sem_acento(t).startswith('PAGAVEL'):
            bol['local_pagamento'] = l.texto(0, 400 * esc).strip()
        if t.startswith('EQUATORIAL'):
            bol['beneficiario'] = l.texto(0, 330 * esc).strip()
        m = re.match(r'(\d\d/\d\d/\d{4})\s+(\d{10,})\b', t)
        if m:
            bol['data_documento'], bol['numero_documento'] = data_br(m[1]), m[2]
            pag['numero_fatura'] = m[2]
            nn = re.search(r'(\d{3}/\d{6,}-\d|\d{14,})\s*$', t)
            bol['nosso_numero'] = nn[1] if nn else None
        ws = l.entre(300 * esc, 560 * esc)
        if any(w.t == 'MN' for w in ws):
            dt = [w.t for w in ws if re.fullmatch(r'\d\d/\d\d/\d{4}', w.t)]
            bol['data_processamento'] = data_br(dt[0]) if dt else bol['data_processamento']
            bol['especie'] = 'MN'
        cart = [w for w in l.entre(180 * esc, 235 * esc) if re.fullmatch(r'\d{2,3}', w.t)]
        if cart and any(w.t == 'R$' for w in l.p) or (cart and not bol['carteira'] and l.y > yb + 50 * esc):
            bol['carteira'] = cart[0].t
        if re.match(r'O Pagamento poder', t):
            bol['instrucoes'] = t
            y_instr = l.y
    if y_instr:
        pg = [l.texto(0, 600 * esc).strip() for l in abaixo if y_instr + 10 * esc < l.y < y_instr + 45 * esc]
        bol['pagador'] = ' '.join(pg) or None
    pag['boleto'] = bol
    pag.setdefault('conta_recebedora', None)


# impressos como imagem (cabeçalho da Equatorial Goiás); o formato muda entre o modelo 2025 e o 2026
CONST_GO = {2026: ('10.054.942-0', 'Rua 2, Qd. A-37, 505 - Jardim Goiás | Goiânia/GO - CEP: 74805-180'),
            2025: ('100.549.420', 'Rua 2, Qd. A-37, Nº 505 - Jardim Goiás - Goiânia-GO • CEP: 74.805-180')}
AVISO = re.compile(r'^(CONFORME|Conforme|NOTA FISCAL|Nota fiscal|INCIDIR|Incidir|FATURA COM|PER\S+ODO DE REF|N\S+O RECEBER|'
                   r'PAGUE|Pague|A SUSPENS|NOTIFICA|A EQUATORIAL|O FATURAMENTO|IMPORTANTE|AVISO|REAVISO)')


def _complementos(pags, ls, d, tj, todo_txt, esc):
    doc_, nf, uc_, tit = d['documento'], d['documento']['nota_fiscal'], d['unidade_consumidora'], d['titular']
    modelo = 2026 if 'FORNECIMENTO' in ' '.join(w.t for w in pags[0][1] if w.x0 < 30 * esc) else 2025
    if doc_['distribuidora_sigla'] == 'EQUATORIAL GO':
        doc_['distribuidora_ie'], doc_['distribuidora_endereco'] = CONST_GO[modelo]
        d['extracao']['observacoes'].append(f'IE/endereço da distribuidora: constantes do layout {modelo} (impressos como imagem).')
    # classe / subclasse: "A A3-A COMERCIAL OU SERVIÇOS E OUTRAS ATIVIDADES - COMERCIAL NORMAL THS_VERDE"
    m = re.match(r'[AB]\s+[AB]\d(?:-[A-Z])?\s+(.*?)\s+-\s+(.*?)\s+(THS_\w+|CONVENCIONAL\S*)?$', uc_['classificacao'] or '')
    if m:
        uc_['classe'], uc_['subclasse'] = m[1].strip(), m[2].strip()
    ger = any(i['componente'] in ('DEMANDA_GERACAO', 'GD_INJETADA') for i in d['itens']) or \
        any(x['tipo'] == 'injetada' for x in d['gd']['lancamentos'])
    uc_['geracao']['e_gerador'] = ger
    m = re.search(r'\bGD (I{1,3})\b', ' '.join(i['descricao'] for i in d['itens']))
    uc_['geracao']['classificacao_gd'] = f'GD_{m[1]}' if m else None
    if d['gd']['rateio_beneficiarias']:
        d['gd']['participacao_pct'] = d['gd']['rateio_beneficiarias'][0]['percentual']
    if 'INFORMAÇÕES DO SCEE' in tj:
        uc_['geracao']['modalidade_gd'] = 'SCEE'
    if not doc_.get('resolucao_aneel'):
        m = re.search(r'\b(\d{3,4}/\d{2})\b', ' '.join(w.t for w in pags[0][1] if w.x0 > 650 * esc and 690 * esc < w.y1 < 860 * esc))
        doc_['resolucao_aneel'] = m[1] if m else None
    # constantes do medidor por grandeza/posto
    vistos = set()
    for me in d['medicoes']:
        k = (me['grandeza'], me['posto'], me['constante'])
        if me['constante'] is not None and k not in vistos:
            vistos.add(k)
            uc_['tecnico']['constantes'].append({'grandeza': f"{me['grandeza']} ({me['posto']})", 'valor': me['constante']})
    # quadro à direita das medições: Consumo Médio Diário, Média 12 meses, data de apresentação, Resolução ANEEL
    t1 = pags[0][1]
    caixa = sorted([w for w in t1 if w.x0 > 650 * esc and 700 * esc < w.y1 < 840 * esc], key=lambda w: w.y1)
    nums = [w for w in caixa if e_numero(w.t) and ',' in w.t]
    for rot, w in zip(('Consumo Médio Diário', 'Média dos 12 meses'), nums):
        d['informacoes_consumo'] = d.get('informacoes_consumo') or []
        d['informacoes_consumo'].append({'pagina': 1, 'rotulo': rot, 'posto': None, 'valor': num(w.t), 'unidade': 'kWh'})
    dt = next((w.t for w in caixa if re.fullmatch(r'\d\d/\d\d/\d{4}', w.t)), None)
    nf['data_apresentacao'] = data_br(dt) if dt else None
    d['outros'] = [o for o in d['outros'] if not o['rotulo'].startswith('y=')]
    if uc_['tecnico']['perdas_transformacao_pct'] is not None:
        d.setdefault('informacoes_consumo', []).append({'pagina': 1, 'rotulo': 'Perdas de transformação / ramal',
                                                        'posto': None, 'valor': uc_['tecnico']['perdas_transformacao_pct'],
                                                        'unidade': '%'})
    if d['documento'].get('resolucao_aneel'):
        d['outros'].append({'pagina': 1, 'secao_impressa': 'Resolução ANEEL', 'rotulo': 'Resolução ANEEL',
                            'valor': d['documento']['resolucao_aneel']})
    if doc_.get('segunda_via'):
        d['outros'].append({'pagina': 1, 'secao_impressa': 'Cabeçalho', 'rotulo': 'via', 'valor': 'Segunda via'})
    # valor controverso por determinação judicial (aviso à direita da p1; o valor vem na linha seguinte)
    msg_p1 = ' '.join(m_['texto'] for m_ in d['mensagens'] if m_['pagina'] == 1)
    mj = re.search(r'(Nota fiscal emitida conforme determina\S+ Judicial.*?Valor controverso)\s*(R\$\s*[\d.,]*\d)?',
                   msg_p1)
    if mj:
        d['outros'].append({'pagina': 1, 'secao_impressa': 'Reservado ao Fisco', 'rotulo': 'Valor controverso (determinação judicial)',
                            'valor': ' '.join(x for x in (mj[1], mj[2]) if x)})
    # avisos impressos (qualquer página; parágrafos que começam com as frases típicas), sem repetir
    vistos_t = {m_['texto'][:60] for m_ in d['mensagens']}
    for np_, todas, e in pags:
        lns = linhas([w for w in todas if not (w.y1 > 1000 * e)])  # boleto fora
        par, x_ini, y_ult = [], None, None
        def fecha():
            if par:
                t = re.sub(r'\s+', ' ', ' '.join(par)).strip()
                if AVISO.match(t) and t[:60] not in vistos_t and len(t) > 25:
                    vistos_t.add(t[:60])
                    d['mensagens'].append({'pagina': np_, 'texto': t})
                    if t.startswith('FATURA COM LAN') or 'DÉBITO AUTOMÁTICO' in t.upper() and 'NÃO RECEBER' in t.upper():
                        d['pagamento']['debito_automatico'] = d['pagamento'].get('debito_automatico') or t
                    if t.startswith('Nota fiscal emitida') and not nf.get('reservado_fisco'):
                        nf['reservado_fisco'] = t
        for l in lns:
            x0 = l.p[0].x0
            if par and (abs(x0 - x_ini) > 30 or l.y - y_ult > 13 or AVISO.match(l.texto())):
                fecha()
                par = []
            if not par:
                x_ini = x0
            par.append(l.texto())
            y_ult = l.y
        fecha()
    if not nf.get('reservado_fisco'):
        nf['reservado_fisco'] = next((m_['texto'] for m_ in d['mensagens'] if m_['texto'].startswith('Nota fiscal emitida')), None)
    # total impresso com asteriscos
    m = re.search(r'(R\$\*+[\d.]+,\d\d)', tj)
    if m:
        d['valores_alternativos'].append({'campo': 'totais.total_a_pagar', 'valor': m[1], 'pagina': 1})
    # entrega (modelo 2025: unidade de entrega "46 / 60" e sequência na última página)
    for np_, todas, e in pags:
        t = ' '.join(w.t for w in todas)  # ordem do PDF: "... BRASIL 46 / 60 300 12505020-8"
        m = re.search(r'BRASIL (\d{1,3} / \d{1,3}) (\d{1,5}) \d{6,}-\d', t)
        if m:
            d['entrega']['unidade_entrega'], d['entrega']['sequencia'] = m[1], m[2]
    # grandezas contratadas como tabela complementar
    if d['demanda']:
        d['tabelas_complementares'].append({'pagina': 1, 'nome': 'Grandezas Contratadas',
                                            'linhas': [{'colunas_originais': x['colunas_originais']} for x in d['demanda']]})
