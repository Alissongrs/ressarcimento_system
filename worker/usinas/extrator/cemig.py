"""Parser determinístico da CEMIG Distribuição S.A. — DANF3E A4 (faturas de usinas/geradoras do grupo A).

p1: emitente (x≈152), titular (x≈17), Referente a / Vencimento / Valor a pagar, NF3e (x≈324), UC ou instalação,
classe / subclasse / modalidade tarifária, datas de leitura (dd/mm, sem ano), "Valores Faturados" (itens com colunas
Unid., Quant., Preço Unit., Valor, PIS/COFINS, Base Calc. ICMS, Aliq. ICMS, ICMS, Tarifa Unit.), Grandezas
Contratadas, Informações Gerais (saldo de geração SCEE, bandeira), notificação de débitos, Histórico de Consumo
(tabela 13 meses), tributos (ICMS / PASEP / COFINS), débito automático e linha digitável.
p2: "DEMONSTRATIVO DE GRANDEZAS FATURADAS" — LEITURAS (só leitura atual nas grandezas de demanda), quadros DEMANDA (kW)
e ENERGIA (kWh) com o "Registrado" de cada grandeza, FATORES e CONSTANTES, Notas.

Colunas calibradas pelos cabeçalhos impressos em cada página (fallback fixo). Nada é calculado: o consumo da medição é
o "Registrado" impresso nos quadros DEMANDA/ENERGIA da p2 (null quando não impresso).
"""
import re
from datetime import date, timedelta

from base import colunas_por_ancora, data_br, e_numero, esqueleto, linhas, mes_ano, num, palavras, sem_acento

NOME = 'cemig_v1'
SEGS = ['FORA_PONTA', 'PONTA', 'RESERVADO']   # HFP/único, HP, HR — ordem impressa
SEG_ROT = {'FORA_PONTA': 'HFP/único', 'PONTA': 'HP', 'RESERVADO': 'HR'}
ANC_ITEM = {'quant': 221, 'preco': 279, 'valor': 325, 'pis_cofins': 366, 'base_icms': 412, 'aliquota_icms': 451,
            'icms': 496, 'tarifa': 559}
ROT_ITEM = {'quant': 'Quant.', 'preco': 'Preço Unit. (R$)', 'valor': 'Valor (R$)', 'pis_cofins': 'PIS/COFINS',
            'base_icms': 'Base Calc. ICMS', 'aliquota_icms': 'Aliq. ICMS', 'icms': 'ICMS', 'tarifa': 'Tarifa Unit.'}
CAMPO_ITEM = {'quant': 'quantidade_faturada', 'preco': 'tarifa_com_tributos', 'valor': 'valor',
              'pis_cofins': 'pis_cofins', 'base_icms': 'base_icms', 'aliquota_icms': 'aliquota_icms', 'icms': 'icms',
              'tarifa': 'tarifa_sem_tributos'}
# grandeza da tabela LEITURAS → (produto nos quadros DEMANDA/ENERGIA, unidade, constante usada)
GRANDEZAS = {'kW': ('DEMANDA ATIVA', 'kW', 'kW'), 'kWh': ('ENERGIA ATIVA', 'kWh', 'kWh'),
             'kWh Injet.': ('ENERGIA INJETADA', 'kWh', 'kWh'), 'UFER': ('ENERGIA REATIVA - UFER', 'kVArh', 'kWh'),
             'DMCR': ('DMCR', 'kW', 'kW'), 'kW Injet.': ('DEMANDA INJETADA', 'kW', 'kW')}
MESES_EXT = {'JANEIRO': 1, 'FEVEREIRO': 2, 'MARCO': 3, 'ABRIL': 4, 'MAIO': 5, 'JUNHO': 6, 'JULHO': 7, 'AGOSTO': 8,
             'SETEMBRO': 9, 'OUTUBRO': 10, 'NOVEMBRO': 11, 'DEZEMBRO': 12}


def detecta(txt, doc=None):
    t = sem_acento(txt or '').upper()
    return ('06.981.180/0001-16' in txt or 'CEMIG DISTRIBUICAO S' in t) and 'NOTA FISCAL' in t


# ── utilidades ───────────────────────────────────────────────────────────────
def _u(s):
    return sem_acento(s or '').upper()


def _txt(ws):
    return ' '.join(w.t for w in sorted(ws, key=lambda w: w.x0))


def _num_tok(t):
    return bool(re.fullmatch(r'-?[\d.]*\d(,\d+)?-?', t))


def _linha_com(ls, *palavras_):
    """Primeira linha que contém todas as palavras (sem acento, maiúsculas)."""
    for ln in ls:
        u = _u(ln.texto())
        if all(_u(p) in u for p in palavras_):
            return ln
    return None


def _ancoras_cab(ln, pares, padrao):
    """Âncoras (centro x) de cabeçalhos de duas palavras ('Leitura anterior', 'Faturado normal'...)."""
    out = dict(padrao)
    if ln is None:
        return out
    ws = ln.p
    for i, w in enumerate(ws):
        for nome, (a, b) in pares.items():
            if _u(w.t) == _u(a) and (b is None or (i + 1 < len(ws) and _u(ws[i + 1].t).startswith(_u(b)))):
                x1 = ws[i + 1].x1 if b else w.x1
                if nome in out and isinstance(out[nome], list):
                    out[nome].append((w.x0 + x1) / 2)
                else:
                    out[nome] = (w.x0 + x1) / 2
    return out


def _mais_proxima(anc, w):
    c = (w.x0 + w.x1) / 2
    return min(anc, key=lambda k: abs(anc[k] - c))


def _data_sem_ano(dm, alvo, depois=None, antes=None):
    """'30/11' → data ISO com o ano que deixa a data mais perto de `alvo` (date), respeitando depois/antes."""
    m = re.fullmatch(r'(\d\d)/(\d\d)', dm or '')
    if not m or alvo is None:
        return None
    cands = []
    for a in (alvo.year - 1, alvo.year, alvo.year + 1):
        try:
            x = date(a, int(m[2]), int(m[1]))
        except ValueError:
            continue
        if depois and x <= depois or antes and x >= antes:
            continue
        cands.append(x)
    return min(cands, key=lambda x: abs((x - alvo).days)) if cands else None


def _posto(desc):
    d = ' ' + _u(desc).replace('/', ' ') + ' '
    if re.search(r' (HFP|FP|FORA PONTA|F PONTA) ', d):
        return 'FORA_PONTA'
    if re.search(r' (HP|PONTA) ', d):
        return 'PONTA'
    if re.search(r' (HR|RESERVADO|NOTURNO) ', d):
        return 'RESERVADO'
    if re.search(r' (UNICO|UNICA) ', d):
        return 'UNICO'
    return None


def componente_de(desc):
    d = _u(desc)
    po = _posto(d)
    if 'BANDEIRA' in d or d.startswith('BAND'):
        return 'BANDEIRA', po
    if 'GERACAO' in d and 'DEMANDA' in d or 'INJ' in d and 'DEMANDA' in d:
        return ('DEMANDA_GERACAO_ULTRAPASSAGEM' if 'ULTRA' in d else 'DEMANDA_GERACAO'), 'GERACAO'
    if 'COMPENSADA' in d:
        return 'CONSUMO_COMPENSADO', po
    if 'INJETADA' in d:
        return 'GD_INJETADA', po
    if 'REATIV' in d or 'UFER' in d or 'UFDR' in d or 'EXCEDENTE' in d:
        return 'REATIVO_EXCEDENTE', po
    if 'ULTRA' in d:
        return 'DEMANDA_ULTRAPASSAGEM', po
    if d.startswith('DEMANDA'):
        return 'DEMANDA', po
    if 'ILUM' in d or 'CIP' in d.split() or 'COSIP' in d:
        return 'ILUMINACAO_PUBLICA', None
    if d.startswith('MULTA'):
        return 'MULTA', None
    if d.startswith('JUROS'):
        return 'JUROS', None
    if 'CORRECAO' in d or 'ATUALIZ' in d or 'IPCA' in d or 'IGPM' in d:
        return 'ATUALIZACAO_MONETARIA', None
    if re.search(r'\b(DIC|FIC|DMIC|DICRI)\b', d):
        return 'COMPENSACAO_CONTINUIDADE', None
    if 'PARCEL' in d:
        return 'PARCELAMENTO', None
    if d.startswith(('DEVOL', 'ESTORNO')):
        return 'ESTORNO', None
    if d.startswith(('SERV', 'TAXA', 'RELIGA', 'VISTORIA')):
        return 'SERVICO', None
    if 'TUSD' in d:
        return 'TUSD', po
    if re.search(r'\bTE\b', d):
        return 'TE', po
    if 'ENERGIA' in d or 'CONSUMO' in d:
        return 'CONSUMO', po
    return 'OUTRO', None


def _mes_ref_desc(desc):
    m = re.search(r'(?<![/\d])(\d\d)/(\d{4}|\d\d)(?![/\d])', desc)   # '12/2025', '12/25'; não '26/01/26'
    if not m or not 1 <= int(m[1]) <= 12:
        return None
    a = int(m[2]) + (2000 if len(m[2]) == 2 else 0)
    return f'{a:04d}-{int(m[1]):02d}'


# ── parse ────────────────────────────────────────────────────────────────────
def parse(doc, fid, cam):
    d = esqueleto(fid, cam, len(doc))
    d['extracao']['parser'] = NOME
    d['documento'].update({'segunda_via': False, 'controle': None, 'filiais': [], 'emissor': None,
                           'resolucao_aneel': None})
    d['documento']['nota_fiscal'].update({'cfop': None, 'nf_substituida': None, 'url_consulta': None})
    d['titular'].update({'cnpj_cpf_mascarado': None, 'matricula': None})
    d['unidade_consumidora'].update({'tipo_tarifa_impresso': None})
    d['unidade_consumidora']['geracao'].update({'classificacao_gd': None})
    d['unidade_consumidora']['tecnico'] = {
        'tensao_nominal': None, 'tensao_contratada_v': None, 'tensao_fornecimento_kv': None, 'tensao_minima': None,
        'tensao_maxima': None, 'faixa_adequada': None, 'fator_potencia_referencia': None, 'rtc': None, 'rtp': None,
        'constantes': [], 'perdas_transformacao_pct': None, 'horario_ponta': None, 'equipamento_medidor': None,
        'responsavel_iluminacao_publica': None}
    d['referencia']['ciclo'] = None
    d['totais'].update({'total_nota_fiscal': None, 'tributos_retidos': None, 'subtotais': [], 'totais_colunas': []})
    d['gd'] = {'uc_geradora': None, 'conta_contrato_geradora': None, 'participacao_pct': None, 'lancamentos': [],
               'rateio_beneficiarias': []}
    d['informacoes_consumo'] = []
    d['composicao_valor'] = []
    d['debitos_pendentes'] = []
    d['encargo_uso_eusd'] = []
    d['entrega'] = {'endereco_correspondencia': None, 'unidade_entrega': None, 'sequencia': None,
                    'endereco_devolucao': None}
    d['pagamento'].update({'boleto': None, 'conta_recebedora': None})
    d['unidades'] = []
    pags = [palavras(p) for p in doc]
    brutos = [p.get_text() for p in doc]
    d['extracao']['paginas_lidas'] = list(range(1, len(doc) + 1))
    d['extracao']['paginas'] = [{'pagina': i + 1, 'tipo': 'conteudo' if pags[i] else 'em_branco', 'repete_pagina': None}
                                for i in range(len(doc))]
    ws1 = pags[0]
    _cabecalho(ws1, brutos[0], d)
    _itens(ws1, d)
    _direita(ws1, d)
    _historico_tributos(ws1, d)
    _rodape(ws1, d)
    # páginas seguintes: demonstrativo de grandezas faturadas (ou cópia da NF)
    for np_ in range(2, len(doc) + 1):
        u = _u(brutos[np_ - 1])
        if 'DEMONSTRATIVO DE GRANDEZAS' in u:
            _demonstrativo(pags[np_ - 1], np_, d)
        elif pags[np_ - 1] and 'VALORES FATURADOS' in u:
            d['extracao']['observacoes'].append(f'p{np_}: outra página de Valores Faturados não lida pelo robô.')
    _datas_leitura(d)
    _gd_e_geracao(d)
    _provas(d)
    return d


def _cabecalho(ws, bruto, d):
    ls = linhas(ws)
    doc_, nf, tit, uc, ref, tot = (d['documento'], d['documento']['nota_fiscal'], d['titular'],
                                   d['unidade_consumidora'], d['referencia'], d['totais'])
    doc_['distribuidora_sigla'] = 'CEMIG'
    doc_['distribuidora'] = 'CEMIG DISTRIBUIÇÃO S.A.'
    for ln in ls[:12]:
        t = ln.texto(150, 380)
        m = re.search(r'^(CEMIG DISTRIBUI\S* S\.A\.)\s+CNPJ\s+([\d./-]+)\s*/?\s*INSC\.? ESTADUAL\s+([\d.]+?)\.?$', t)
        if m:
            doc_['distribuidora'], doc_['distribuidora_cnpj'], doc_['distribuidora_ie'] = m[1], m[2], m[3]
    em = [ln.texto(150, 380) for ln in ls if 38 < ln.y < 55]
    doc_['distribuidora_endereco'] = ' '.join(em) or None
    topo = _u(' '.join(ln.texto() for ln in ls if ln.y < 58))
    if 'REIMPRESS' in topo:
        doc_['segunda_via'] = True
        d['outros'].append({'pagina': 1, 'secao_impressa': 'cabeçalho', 'rotulo': 'Marcação', 'valor': 'REIMPRESSÃO'})
    if 'SEGUNDA VIA' in topo or '2A VIA' in topo:
        doc_['segunda_via'] = True
    nf['modelo'] = 'NF3e (DANF3E)'
    # bloco do titular (x < 290) entre o nome e a linha do CNPJ
    cab = _linha_com(ls, 'Referente', 'Vencimento')
    y0 = cab.y - 3 if cab else 55
    blk = [ln for ln in ls if y0 <= ln.y < 145 and ln.texto(0, 290)]
    k_cnpj = next((i for i, ln in enumerate(blk) if re.match(r'(CNPJ|CPF)\b', ln.texto(0, 290))), None)
    if blk:
        tit['nome'] = blk[0].texto(0, 290)
        end = [ln.texto(0, 290) for ln in blk[1:k_cnpj]]
        if end:
            m = re.match(r'(\d{5}-\d{3})\s+(.*?),?\s+([A-Z]{2})$', end[-1])
            if m:
                tit['cep'], tit['cidade'], tit['uf'] = m[1], m[2].rstrip(','), m[3]
                end = end[:-1]
            tit['endereco'] = ' '.join(end) or None
        if k_cnpj is not None:
            m = re.match(r'(?:CNPJ|CPF)\s*:?\s*(\S+)', blk[k_cnpj].texto(0, 290))
            if m:
                tit['cnpj_cpf_mascarado' if '*' in m[1] else 'cnpj_cpf'] = m[1]
            m = re.search(r'(?:INSC\.?|I\.E\.?)\S*\s*(?:ESTADUAL)?:?\s*([\d./-]+)', blk[k_cnpj].texto(0, 320))
            if m:
                tit['inscricao_estadual'] = m[1]
    # referência / vencimento / valor
    for ln in ls:
        m = re.search(r'([A-Z]{3}/\d{4})\s+(\d\d/\d\d/\d{4})\s+([\d.]+,\d\d)', ln.texto(280, 560))
        if m and mes_ano(m[1]):
            ref['mes_referencia'] = mes_ano(m[1])
            ref['data_vencimento'] = data_br(m[2])
            tot['total_a_pagar'] = num(m[3])
            break
    # NF3e
    direita = re.sub(r'\s+', ' ', ' '.join(ln.texto(315, 600) for ln in ls if 85 < ln.y < 160))
    m = re.search(r'NOTA FISCAL N\S*\s*(\d+)\s*-\s*S[ÉE]RIE\s*(\w+)', direita)
    if m:
        nf['numero'], nf['serie'] = m[1], m[2]
    m = re.search(r'emiss[ãa]o:\s*(\d\d/\d\d/\d{4})', direita)
    if m:
        nf['data_emissao'] = ref['data_emissao'] = data_br(m[1])
    m = re.search(r'(https?://\S+)', direita)
    nf['url_consulta'] = m[1] if m else None
    m = re.search(r'\b(\d{44})\b', re.sub(r'(?<=\d) (?=\d)', '', direita))
    nf['chave_acesso'] = m[1] if m else None
    m = re.search(r'autoriza[çc][ãa]o:\s*(\d+)\s+(\d\d)\.(\d\d)\.(\d{4})\s*[àa]s\s*(\d\d:\d\d:\d\d)', direita)
    if m:
        nf['protocolo_autorizacao'] = m[1]
        nf['data_autorizacao'] = f'{m[4]}-{m[3]}-{m[2]}T{m[5]}'
    elif (m := re.search(r'autoriza[çc][ãa]o:\s*(\d+)', direita)):
        nf['protocolo_autorizacao'] = m[1]
    # UC / instalação
    lab = next((ln for ln in ls if 140 < ln.y < 160 and ('UNIDADE' in _u(ln.texto(0, 300))
                                                          or 'INSTALA' in _u(ln.texto(0, 300)))), None)
    if lab:
        val = next((ln for ln in ls if lab.y + 5 < ln.y < lab.y + 30 and ln.texto(0, 300)), None)
        if val:
            v = val.texto(0, 300).replace(' ', '')
            uc['uc'] = v
            if 'INSTALA' in _u(lab.texto(0, 300)):
                uc['instalacao'] = v
    # classe / subclasse / modalidade tarifária
    hc = _linha_com(ls, 'Classe', 'Subclasse')
    if hc:
        xs = {w.t: w for w in hc.p}
        x_sub = xs['Subclasse'].x0 - 25 if 'Subclasse' in xs else 170
        x_mod = xs['Modalidade'].x0 - 10 if 'Modalidade' in xs else 295
        lv = [ln for ln in ls if hc.y + 3 < ln.y < hc.y + 30]
        classe = ' '.join(ln.texto(0, x_sub) for ln in lv if ln.texto(0, x_sub)).strip()
        sub = ' '.join(ln.texto(x_sub, x_mod) for ln in lv if ln.texto(x_sub, x_mod)).strip()
        mod = ' '.join(ln.texto(x_mod, 400) for ln in lv if ln.texto(x_mod, 400)).strip()
        uc['classe'], uc['subclasse'] = classe or None, sub or None
        uc['classificacao'] = ' / '.join(x for x in (classe, sub) if x) or None
        if mod:
            uc['tipo_tarifa_impresso'] = mod
            m = re.search(r'\b(VERDE|AZUL|CONVENCIONAL|BRANCA)\b', _u(mod))
            uc['modalidade_tarifaria'] = m[1].capitalize() if m else None
            m = re.search(r'\b([AB]\d?[a-zA-Z]?|AS)\b$', mod.split()[-1])
            if m:
                uc['subgrupo'] = m[1]
                uc['grupo'] = m[1][0]
        # datas de leitura (dd/mm), dias
        for ln in lv:
            m = re.search(r'(\d\d/\d\d)\s+(\d\d/\d\d)\s+(\d+)\s+(\d\d/\d\d)', ln.texto(400, 600))
            if m:
                d['_datas'] = (m[1], m[2], int(m[3]), m[4])


def _itens(ws, d):
    ls = linhas(ws)
    cab = _linha_com(ls, 'Itens', 'Quant.')
    if cab is None:
        return
    anc = dict(ANC_ITEM)
    hp = cab.p
    rs = [w for w in hp if w.t == '(R$)']
    for nome, w in (('quant', next((w for w in hp if w.t.startswith('Quant')), None)),
                    ('preco', rs[0] if rs else None), ('valor', rs[1] if len(rs) > 1 else None),
                    ('pis_cofins', next((w for w in hp if w.t.startswith('PIS')), None)),
                    ('aliquota_icms', next((w for w in hp if w.t.startswith('Aliq')), None)),
                    ('tarifa', [w for w in hp if w.t.startswith('Unit')][-1] if any(w.t.startswith('Unit') for w in hp)
                     else None)):
        if w is not None and abs(w.x1 - ANC_ITEM[nome]) < 15:
            anc[nome] = w.x1
    x_unid = next((w.x0 for w in hp if w.t.startswith('Unid')), 156) - 2
    fim = min([ln.y for ln in ls if ln.y > cab.y and re.search(r'Grandezas Contratadas|NOTIFICA|Informa[çc][õo]es Gerais',
                                                                   ln.texto())] + [430])
    total_visto = False
    pend = None
    for ln in ls:
        if not (cab.y + 4 < ln.y < fim - 2):
            continue
        g = ln.p
        if all(w.t == 'ICMS' for w in g):
            continue
        unid_w = next((w for w in g if x_unid <= w.x0 < x_unid + 25 and
                       re.fullmatch(r'kWh|kW|kVArh|kVAr|kvarh|MWh|UN|R\$', w.t)), None)
        unid = unid_w.t if unid_w else None
        nums = [w for w in g if w.x0 >= x_unid + 25 and _num_tok(w.t)]
        # descrição: tudo à esquerda da coluna Unid. + palavras não numéricas que a invadem ("... a pagar")
        desc = _txt([w for w in g if w.x0 < x_unid or (w is not unid_w and w not in nums)])
        if _u(desc) == 'TOTAL':
            total_visto = True
            cols = colunas_por_ancora(nums, anc)
            for k, rot in (('valor', 'Valor (R$)'), ('pis_cofins', 'PIS/COFINS'), ('base_icms', 'Base Calc. ICMS'),
                           ('icms', 'ICMS')):
                if k in cols:
                    d['totais']['totais_colunas'].append({'pagina': 1, 'coluna': rot, 'valor': num(cols[k])})
            if 'valor' in cols:
                d['totais']['subtotais'].append({'pagina': 1, 'rotulo': 'TOTAL (Valores Faturados)',
                                                 'valor': num(cols['valor'])})
            continue
        if not desc and not nums:
            continue
        if desc and not nums and not total_visto:
            pend = (pend + ' ' + desc) if pend else desc
            continue
        if not desc and nums:
            desc, pend = pend or '', None
        elif pend:
            desc, pend = pend + ' ' + desc, None
        if not desc:
            continue
        cols = colunas_por_ancora(nums, anc)
        comp, posto = componente_de(desc)
        it = {'pagina': 1, 'secao_impressa': 'Valores Faturados', 'codigo': None, 'descricao': desc,
              'mes_ref': _mes_ref_desc(desc), 'componente': comp, 'posto': posto, 'quantidade_registrada': None,
              'quantidade_faturada': None, 'unidade': unid, 'tarifa_com_tributos': None, 'tarifa_sem_tributos': None,
              'valor': None, 'valor_sem_tributos': None, 'base_icms': None, 'aliquota_icms': None, 'icms': None,
              'base_pis_cofins': None, 'aliquota_pis': None, 'pis': None, 'aliquota_cofins': None, 'cofins': None,
              'pis_cofins': None, 'nf_referencia': None, 'colunas_originais': {'Itens da Fatura': desc}}
        if unid:
            it['colunas_originais']['Unid.'] = unid
        for k, v in cols.items():
            it[CAMPO_ITEM[k]] = num(v)
            it['colunas_originais'][ROT_ITEM[k]] = v
        if total_visto:
            # linha abaixo do TOTAL ("Bandeira ... - Já Incluído no valor a pagar"): informativa, fora da soma
            it['valor'] = None
            if comp not in ('BANDEIRA',):
                it['componente'] = 'INFO'
            d['extracao']['observacoes'].append(
                f'Linha "{desc}" impressa abaixo do TOTAL ({cols.get("valor")}): já incluída no valor a pagar; '
                'gravada com valor nulo (valor impresso em colunas_originais).')
            d['outros'].append({'pagina': 1, 'secao_impressa': 'Valores Faturados', 'rotulo': desc,
                                'valor': cols.get('valor')})
        d['itens'].append(it)
        if it['tarifa_sem_tributos'] is not None and it['valor'] is not None:
            un = it['unidade'] or ''
            d['tarifas'].append({'pagina': 1, 'rotulo': desc, 'componente': it['componente'], 'posto': it['posto'],
                                 'valor': it['tarifa_sem_tributos'], 'unidade': f'R$/{un}' if un else None,
                                 'tipo': 'aneel'})
    ilum = [i['valor'] for i in d['itens'] if i['componente'] == 'ILUMINACAO_PUBLICA' and i['valor'] is not None]
    d['totais']['valor_cosip_cip'] = round(sum(ilum), 2) if ilum else None


def _direita(ws, d):
    """Grandezas Contratadas, Informações Gerais (x ≥ 240) e notificação de débitos (x < 240)."""
    ls = linhas(ws)
    gc = _linha_com(ls, 'Grandezas', 'Contratadas')
    ig = _linha_com(ls, 'Informações', 'Gerais') or _linha_com(ls, 'Informacoes', 'Gerais')
    hist = _linha_com(ls, 'Histórico', 'Consumo') or _linha_com(ls, 'Historico', 'Consumo')
    if gc:
        tab = {'pagina': 1, 'nome': 'Grandezas Contratadas', 'linhas': []}
        for ln in ls:
            if gc.y + 3 < ln.y < (ig.y - 3 if ig else gc.y + 80):
                ws_ = ln.entre(240, 600)
                if not ws_:
                    continue
                vals = [w for w in ws_ if _num_tok(w.t) and w.x0 > 450]
                rot = _txt([w for w in ws_ if w not in vals])
                if not rot:
                    continue
                v = ' '.join(w.t for w in vals) or None
                tab['linhas'].append({'colunas_originais': {'Grandeza': rot, 'Valor': v}})
                ru = _u(rot)
                if v and 'DEMANDA' in ru:
                    tipo, po = ('geracao', 'GERACAO') if ('GERA' in ru or 'INJ' in ru) else ('consumo', _posto(rot))
                    d['demanda'].append({'pagina': 1, 'tipo': tipo, 'posto': po, 'contratada_kw': num(v),
                                         'medida_kw': None, 'faturada_kw': None, 'faturada_ultrapassagem_kw': None,
                                         'nao_consumida_kw': None, 'data_hora': None,
                                         'rotulo': f'Grandezas Contratadas: {rot}', 'colunas_originais': {rot: v}})
        if tab['linhas']:
            d['tabelas_complementares'].append(tab)
    if ig:
        fim = min([ln.y for ln in ls if ln.y > ig.y and re.search(r'Reservado ao Fisco|Base de c[áa]lculo', ln.texto(240))]
                  + [720])
        txt = ' '.join(ln.texto(240, 600) for ln in ls if ig.y + 3 < ln.y < fim - 3 and ln.texto(240, 600))
        txt = re.sub(r'\s+', ' ', txt).strip()
        if txt:
            d['mensagens'].append({'pagina': 1, 'texto': txt})
            _info_gerais(txt, d)
    noti = _linha_com(ls, 'NOTIFICA')
    if noti:
        fim = hist.y if hist else noti.y + 140
        bl = [ln for ln in ls if noti.y - 2 <= ln.y < fim - 3 and ln.texto(0, 238)]
        txt = re.sub(r'\s+', ' ', ' '.join(ln.texto(0, 238) for ln in bl)).strip()
        if txt:
            d['mensagens'].append({'pagina': 1, 'texto': txt})
        for ln in bl:
            for m in re.finditer(r'(\d\d/\d{4})\s+([\d.]+,\d\d)(?:\s+(\d\d/\d\d/\d{4}))?', ln.texto(0, 238)):
                d['debitos_pendentes'].append({'referencia': mes_ano_num(m[1]), 'vencimento': None,
                                               'data_reaviso': data_br(m[3]) if m[3] else None, 'valor': num(m[2])})


def mes_ano_num(t):
    m = re.fullmatch(r'(\d\d)/(\d{4})', t)
    return f'{m[2]}-{m[1]}' if m else t


def _info_gerais(txt, d):
    gd = d['gd']
    m = re.search(r'SALDO ATUAL DE GERA[ÇC][ÃA]O:\s*((?:[\d.]+,\d+\s*kWh\s+(?:F\.\s*PONTA|FORA PONTA|PONTA|NOTURNO|'
                  r'RESERVADO|INTERMEDI\w+)[,.]?\s*)+)', txt)
    if m:
        for v, po in re.findall(r'([\d.]+,\d+)\s*kWh\s+(F\.\s*PONTA|FORA PONTA|PONTA|NOTURNO|RESERVADO|INTERMEDI\w+)', m[1]):
            pu = _u(po)
            posto = ('FORA_PONTA' if 'F' in pu.split()[0] and pu != 'PONTA' else
                     'RESERVADO' if pu in ('NOTURNO', 'RESERVADO') else 'INTERMEDIARIO' if 'INTERMED' in pu
                     else 'PONTA')
            gd['lancamentos'].append({'pagina': 1, 'tipo': 'saldo_atual', 'posto': posto, 'kwh': num(v),
                                      'mes_ref': d['referencia']['mes_referencia'], 'ref_expiracao': None,
                                      'unidade_impressa': 'kWh', 'rotulo': f'SALDO ATUAL DE GERAÇÃO: {v} kWh {po}'})
    m = re.search(r'Res\.?\s*Aneel\s*n[ºo°]\s*([\d.]+),?\s*de\s*(\d\d/\d\d/\d{4})', txt)
    if m:
        d['documento']['resolucao_aneel'] = f'Res Aneel nº {m[1]}, de {m[2]}'
    cores = {'VERDE': 'VERDE', 'AMARELA': 'AMARELA', 'VERM. P1': 'VERMELHA_1', 'VERMELHA P1': 'VERMELHA_1',
             'VERM. P2': 'VERMELHA_2', 'VERMELHA P2': 'VERMELHA_2', 'VERMELHA PATAMAR 1': 'VERMELHA_1',
             'VERMELHA PATAMAR 2': 'VERMELHA_2', 'ESCASSEZ': 'ESCASSEZ'}
    for mes, cor in re.findall(r'([A-Z]{3}/\d{4}):\s*Band\.?\s*(Verde|Amarela|Verm(?:elha)?\.?\s*(?:Patamar\s*)?P?\d|Escassez\w*)',
                               txt, re.I):
        c = re.sub(r'\s+', ' ', _u(cor))
        c = cores.get(c) or cores.get(c.replace('PATAMAR ', 'P')) or ('VERMELHA_2' if c.endswith('2') else
                                                                     'VERMELHA_1' if c.endswith('1') else c)
        d['bandeiras'].append({'pagina': 1, 'cor': c, 'inicio': None, 'fim': None, 'dias': None,
                               'mes_ref': mes_ano(mes)})
    if 'FATURAMENTO PELA MEDIA' in _u(txt):
        d['extracao']['observacoes'].append('Informações Gerais: "Faturamento pela média" impresso.')


def _historico_tributos(ws, d):
    ls = linhas(ws)
    # histórico (x < 240)
    cab = next((ln for ln in ls if any(w.t.startswith('Demanda(kW)') for w in ln.entre(0, 240))
                and any(w.t.startswith('Energia(kWh)') for w in ln.entre(0, 240))), None)
    if cab:
        sub = next((ln for ln in ls if cab.y < ln.y < cab.y + 15 and ln.entre(60, 240)
                    and all(w.t in ('HP', 'HFP', 'HR', 'HI') for w in ln.entre(60, 240))), None)
        ws_sub = sub.entre(60, 240) if sub else []
        series = []
        grupo, vistos = 0, set()   # "HP HFP | HP HFP HR": o rótulo repetido abre o grupo da energia
        for w in ws_sub:
            if w.t in vistos:
                grupo, vistos = grupo + 1, set()
            vistos.add(w.t)
            serie, un = ('demanda', 'kW') if grupo == 0 else ('consumo', 'kWh')
            series.append((w.x1, serie, {'HP': 'PONTA', 'HFP': 'FORA_PONTA', 'HR': 'RESERVADO',
                                         'HI': 'INTERMEDIARIO'}[w.t], un,
                           f'{"Demanda(kW)" if serie == "demanda" else "Energia(kWh)"} {w.t}'))
        if series:
            tab = {'pagina': 1, 'nome': 'Histórico de Consumo', 'linhas': []}
            for ln in ls:
                if ln.y <= (sub.y if sub else cab.y):
                    continue
                g = ln.entre(0, 238)
                if not g or not re.fullmatch(r'[A-Z]{3}/\d{2,4}', g[0].t) or not mes_ano(g[0].t):
                    continue
                mes = mes_ano(g[0].t)
                co = {'Mês/Ano': g[0].t}
                for w in g[1:]:
                    if not _num_tok(w.t):
                        continue
                    x1, serie, po, un, rot = min(series, key=lambda s: abs(s[0] - w.x1))
                    co[rot] = w.t
                    d['historico'].append({'pagina': 1, 'mes': mes, 'serie': serie, 'posto': po, 'valor': num(w.t),
                                           'unidade': un, 'unidade_original': None, 'faturado_pela_media': False})
                tab['linhas'].append({'colunas_originais': co})
            if tab['linhas']:
                d['tabelas_complementares'].append(tab)
    d['historico_formato'] = 'tabela' if d['historico'] else 'ausente'
    # tributos (x ≥ 240, abaixo de "Base de cálculo (R$) Alíquota (%) Valor (R$)")
    ct = _linha_com(ls, 'Base', 'Alíquota') or _linha_com(ls, 'Base', 'Aliquota')
    if ct:
        for ln in ls:
            if not ct.y < ln.y < ct.y + 45:
                continue
            m = re.match(r'(ICMS|PASEP|PIS/PASEP|PIS|COFINS)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)$', ln.texto(240, 600))
            if m:
                trib = {'PASEP': 'PIS', 'PIS/PASEP': 'PIS'}.get(m[1], m[1])
                d['tributos'].append({'pagina': 1, 'tributo': trib, 'base': num(m[2]), 'aliquota': num(m[3]),
                                      'valor': num(m[4]), 'retido': False,
                                      'colunas_originais': {'Tributo': m[1], 'Base de cálculo (R$)': m[2],
                                                            'Alíquota (%)': m[3], 'Valor (R$)': m[4]}})
    if d['tributos']:
        d['totais']['total_tributos'] = None  # não impresso como total


def _rodape(ws, d):
    ls = linhas(ws)
    pag = d['pagamento']
    cab = _linha_com(ls, 'Débito', 'Automático') or _linha_com(ls, 'Debito', 'Automatico')
    if cab:
        val = next((ln for ln in ls if cab.y + 4 < ln.y < cab.y + 20), None)
        if val:
            m = re.match(r'(\d{6,})\b', val.texto(100, 250))
            pag['debito_automatico'] = m[1] if m else None
            m = re.search(r'R\$\s*([\d.]+,\d\d)', val.texto(450, 600))
            if m and d['totais']['total_a_pagar'] is not None and num(m[1]) != d['totais']['total_a_pagar']:
                d['valores_alternativos'].append({'campo': 'totais.total_a_pagar', 'valor': num(m[1]), 'pagina': 1})
            if m and d['totais']['total_a_pagar'] is None:
                d['totais']['total_a_pagar'] = num(m[1])
            uc_ = re.search(r'(\d[\d.]+-\d{2}|\d{8,})', val.texto(250, 380))
            if uc_ and not d['unidade_consumidora']['uc']:
                d['unidade_consumidora']['uc'] = uc_[1]
    for ln in ls:
        t = ln.texto()
        m = re.search(r'(\d{11}-\d)\s+(\d{11}-\d)\s+(\d{11}-\d)\s+(\d{11}-\d)', t)
        if m:
            pag['linha_digitavel'] = ' '.join(m.groups())
            mm = re.match(r'([A-Za-zçÇ]+)/(\d{4})', ln.texto(0, 260))
            if mm and _u(mm[1]) in MESES_EXT:
                mr = f'{mm[2]}-{MESES_EXT[_u(mm[1])]:02d}'
                if mr != d['referencia']['mes_referencia']:
                    d['valores_alternativos'].append({'campo': 'referencia.mes_referencia', 'valor': mm[0],
                                                      'pagina': 1})
    if any(_u(w.t) == 'PIX' for w in ws):
        pag['pix'] = 'QR code PIX impresso (conteúdo não transcrito)'
    rf = _linha_com(ls, 'Reservado', 'Fisco')
    if rf:
        d['outros'].append({'pagina': 1, 'secao_impressa': 'Reservado ao Fisco', 'rotulo': 'Reservado ao Fisco',
                            'valor': None})
    fale = _linha_com(ls, 'Fale', 'CEMIG')
    if fale:
        d['outros'].append({'pagina': 1, 'secao_impressa': 'rodapé', 'rotulo': 'Canais de atendimento',
                            'valor': fale.texto()})


def _demonstrativo(ws, np_, d):
    ls = linhas(ws)
    uc = d['unidade_consumidora']
    tec = uc['tecnico']
    topo = re.sub(r'\s+', ' ', ' '.join(ln.texto() for ln in ls if ln.y < 200))
    m = re.search(r'Medidor:\s*(\S+)', topo)
    medidor = m[1] if m else None
    if medidor and medidor not in uc['medidor']:
        uc['medidor'].append(medidor)
    m = re.search(r'Per[íi]odo de Medi[çc][ãa]o\s*(\d\d/\d\d/\d{4})\s*[àa]\s*(\d\d/\d\d/\d{4})', topo)
    if m:
        d['_periodo'] = (data_br(m[1]), data_br(m[2]))
        d['outros'].append({'pagina': np_, 'secao_impressa': 'DEMONSTRATIVO DE GRANDEZAS FATURADAS',
                            'rotulo': 'Período de Medição', 'valor': f'{m[1]} à {m[2]}'})
    m = re.search(r'Local de Medi[çc][ãa]o:\s*(.*?)\s+M[êe]s/Ano:', topo)
    if m:
        uc['endereco'] = m[1]
    m = re.search(r'Subgrupo:\s*(\S+)', topo)
    if m and not uc['subgrupo']:
        uc['subgrupo'], uc['grupo'] = m[1], m[1][0]
    m = re.search(r'Hor[áa]rio de ponta:\s*(\d\d:\d\d\s*[àa]s\s*\d\d:\d\d)', topo)
    if m:
        tec['horario_ponta'] = m[1]
    m = re.search(r'Instala[çc][ãa]o:\s*(\d+)', topo)
    if m and not uc['instalacao']:
        uc['instalacao'] = m[1]
    # CONSTANTES (x ≥ 290) e FATORES (x < 290)
    fat = _linha_com(ls, 'FATORES')
    const = {}
    if fat:
        for ln in ls:
            if ln.y <= fat.y or ln.y > fat.y + 90:
                continue
            ws_c = ln.entre(290, 600)
            if ws_c:
                rot = _txt([w for w in ws_c if not _num_tok(w.t)])
                val = ' '.join(w.t for w in ws_c if _num_tok(w.t) and w.x0 > 420)
                if rot:
                    const[rot] = val or None
            ws_f = ln.entre(0, 290)
            seg = next((w.t for w in ws_f if w.t in ('HFP', 'HP', 'HR') and w.x0 < 60), None)
            if seg:
                for w in ws_f:
                    if _num_tok(w.t):
                        rot = 'fator de carga' if w.x1 < 190 else 'fator de potência'
                        d['informacoes_consumo'].append({'pagina': np_, 'rotulo': rot,
                                                         'posto': {'HFP': 'FORA_PONTA', 'HP': 'PONTA',
                                                                   'HR': 'RESERVADO'}[seg],
                                                         'valor': num(w.t), 'unidade': None})
    tec['rtc'], tec['rtp'] = const.get('RTC'), const.get('RTP')
    for k, v in const.items():
        if k in ('RTC', 'RTP'):
            continue
        if k.startswith('Perdas'):
            tec['perdas_transformacao_pct'] = num(v) if v else None
            continue
        if v:
            tec['constantes'].append({'grandeza': k, 'valor': num(v)})
    c_kw, c_kwh = num(const.get('kW')) if const.get('kW') else None, num(const.get('kWh')) if const.get('kWh') else None
    if const:
        d['tabelas_complementares'].append({'pagina': np_, 'nome': 'CONSTANTES',
                                            'linhas': [{'colunas_originais': {k: v}} for k, v in const.items()]})
    # quadros DEMANDA (kW) e ENERGIA (kWh): Registrado / Contratado / Faturado por produto e segmento
    quadros = {}
    for titulo, chave_q in (('DEMANDA(kW)', 'DEMANDA'), ('ENERGIA', 'ENERGIA')):
        tq = next((ln for ln in ls if ln.p and ln.p[0].t.startswith(titulo) and ln.p[0].x0 > 200), None)
        if tq is None:
            continue
        hq = next((ln for ln in ls if tq.y < ln.y < tq.y + 20 and _u(ln.texto()).startswith('SEGMENTO')), None)
        if hq is None:
            continue
        anc = {}
        ws_h = hq.p
        for i, w in enumerate(ws_h):
            nx = ws_h[i + 1].t if i + 1 < len(ws_h) else ''
            if w.t == 'Registrado':
                anc['Registrado'] = (w.x0 + w.x1) / 2
            elif w.t == 'Acerto' and nx.lower().startswith('reg'):
                anc['Acerto Reg.'] = (w.x0 + ws_h[i + 1].x1) / 2
            elif w.t == 'Acerto' and nx.lower().startswith('fat'):
                anc['Acerto Fat.'] = (w.x0 + ws_h[i + 1].x1) / 2
            elif w.t.startswith('Data/Hora'):
                anc['Data/Hora'] = (w.x0 + w.x1) / 2
            elif w.t == 'Contratado':
                anc['Contratado'] = (w.x0 + w.x1) / 2
            elif w.t == 'Take':
                anc['Take or pay'] = (w.x0 + w.x1) / 2
            elif w.t == 'Faturado':
                anc['Faturado ultrapass.' if 'Faturado ultrapass.' not in anc else 'Faturado normal'] = (w.x0 + w.x1) / 2
        fimq = next((ln.y for ln in ls if ln.y > hq.y + 15 and ln.p and
                     (ln.p[0].t in ('ENERGIA', 'FATORES') or ln.p[0].t.startswith('FATORES')) and ln.p[0].x0 > 120), 1e9)
        rows = [ln for ln in ls if hq.y + 15 < ln.y < fimq - 3 and ln.entre(70, 200)]
        segs_lbl = sorted([(ln.y, w.t) for ln in ls if hq.y + 15 < ln.y < fimq for w in ln.p
                           if w.x0 < 70 and w.t in ('HFP/Único', 'HFP/único', 'HFP', 'HP', 'HR', 'HI')])
        primeiro = 'DEMANDA ATIVA' if chave_q == 'DEMANDA' else 'ENERGIA ATIVA'
        k_seg = -1
        tab = {'pagina': np_, 'nome': f'{chave_q} ({"kW" if chave_q == "DEMANDA" else "kWh"})', 'linhas': []}
        for ln in rows:
            prod = _txt([w for w in ln.p if 70 <= w.x0 < 185 and not _num_tok(w.t)])
            pu = re.sub(r'\s*-\s*', ' - ', _u(prod)).replace('REATIVA- ', 'REATIVA - ')
            if pu == primeiro:
                k_seg += 1
            seg = SEGS[k_seg] if 0 <= k_seg < len(SEGS) else None
            if segs_lbl and 0 <= k_seg < len(segs_lbl):
                lb = segs_lbl[k_seg][1]
                seg = 'FORA_PONTA' if lb.startswith('HFP') else {'HP': 'PONTA', 'HR': 'RESERVADO',
                                                                 'HI': 'INTERMEDIARIO'}.get(lb, seg)
            vals = {}
            for w in ln.p:
                if w.x0 >= 185 and (_num_tok(w.t) or re.fullmatch(r'\d\d/\d\d/\d{2,4}|\d\d:\d\d(:\d\d)?', w.t)):
                    c = _mais_proxima(anc, w) if anc else 'Registrado'
                    vals[c] = (vals[c] + ' ' + w.t) if c in vals else w.t
            quadros[(chave_q, pu, seg)] = (prod, vals)
            if vals:
                tab['linhas'].append({'colunas_originais': {'Segmento': SEG_ROT.get(seg, seg), 'Produto': prod, **vals}})
        if tab['linhas']:
            d['tabelas_complementares'].append(tab)
    for (q, pu, seg), (prod, vals) in quadros.items():
        if q != 'DEMANDA' or not vals:
            continue
        tipo = 'geracao' if 'INJETADA' in pu else 'consumo'
        d['demanda'].append({'pagina': np_, 'tipo': tipo, 'posto': seg,
                             'contratada_kw': num(vals['Contratado']) if 'Contratado' in vals else None,
                             'medida_kw': num(vals['Registrado']) if 'Registrado' in vals else None,
                             'faturada_kw': num(vals['Faturado normal']) if 'Faturado normal' in vals else None,
                             'faturada_ultrapassagem_kw': num(vals['Faturado ultrapass.'])
                             if 'Faturado ultrapass.' in vals else None,
                             'nao_consumida_kw': None, 'data_hora': vals.get('Data/Hora'),
                             'rotulo': f'{SEG_ROT.get(seg, seg)} - {prod}',
                             'colunas_originais': {'Segmento': SEG_ROT.get(seg, seg), 'Produto': prod, **vals}})
    for (q, pu, seg), (prod, vals) in quadros.items():
        if q == 'ENERGIA' and pu == 'ENERGIA INJETADA' and 'Registrado' in vals:
            d['gd']['lancamentos'].append({'pagina': np_, 'tipo': 'injetada', 'posto': seg,
                                           'kwh': num(vals['Registrado']), 'mes_ref': d['referencia']['mes_referencia'],
                                           'ref_expiracao': None, 'unidade_impressa': 'kWh',
                                           'rotulo': f'{SEG_ROT.get(seg, seg)} - Energia Injetada (Registrado)'})
    # LEITURAS
    hl = _linha_com(ls, 'Grandezas', 'Leitura')
    if hl is None:
        return
    pos = [((w.x0 + hl.p[i + 1].x1) / 2, hl.p[i + 1].t.lower()) for i, w in enumerate(hl.p[:-1]) if w.t == 'Leitura']
    cols = {}
    for k, (xc, tipo) in enumerate(pos):
        cols[(SEGS[k // 2] if k // 2 < 3 else f'S{k // 2}', 'leitura_anterior' if tipo.startswith('ant')
              else 'leitura_atual')] = xc
    if not cols:
        return
    fim_l = next((ln.y for ln in ls if ln.y > hl.y and ln.p and ln.p[0].t.startswith('DEMANDA')), hl.y + 90)
    for ln in ls:
        if not hl.y + 3 < ln.y < fim_l - 3:
            continue
        gr = _txt([w for w in ln.p if w.x0 < 75 and not _num_tok(w.t)])
        if not gr:
            continue
        nums = [w for w in ln.p if w.x0 >= 75 and _num_tok(w.t)]
        por_seg = {}
        for w in nums:
            seg, campo = min(cols, key=lambda c: abs(cols[c] - (w.x0 + w.x1) / 2))
            por_seg.setdefault(seg, {})[campo] = w.t
        prod, unid, ck = GRANDEZAS.get(gr, (None, 'kWh', 'kWh'))
        const_v = c_kw if ck == 'kW' else c_kwh
        for seg in SEGS:
            v = por_seg.get(seg)
            if not v:
                continue
            q = quadros.get(('DEMANDA' if unid == 'kW' else 'ENERGIA', prod, seg), (None, {}))[1] if prod else {}
            reg = q.get('Registrado')
            fat_n = q.get('Faturado normal')
            co = {'Grandezas': gr, 'Segmento': SEG_ROT[seg],
                  'Leitura anterior': v.get('leitura_anterior'), 'Leitura atual': v.get('leitura_atual')}
            if reg:
                co['Registrado'] = reg
            if fat_n:
                co['Faturado normal'] = fat_n
            d['medicoes'].append({'pagina': np_, 'tabela_origem': 'LEITURAS (Demonstrativo de Grandezas Faturadas)',
                                  'medidor': medidor, 'grandeza': gr, 'posto': seg,
                                  'leitura_anterior': num(v['leitura_anterior']) if 'leitura_anterior' in v else None,
                                  'leitura_atual': num(v['leitura_atual']) if 'leitura_atual' in v else None,
                                  'constante': const_v, 'perdas_pct': None, 'ajuste': None,
                                  'consumo': num(reg) if reg else None,
                                  'consumo_faturado': num(fat_n) if fat_n else None,
                                  'fator_potencia': None, 'ajuste_fator_potencia': None, 'unidade': unid,
                                  'data_hora_registro': None, 'leitura_arredondada': False, 'colunas_originais': co})
    # notas
    notas = _linha_com(ls, 'Notas:')
    if notas:
        txt = re.sub(r'\s+', ' ', ' '.join(ln.texto() for ln in ls if ln.y >= notas.y - 1)).strip()
        d['mensagens'].append({'pagina': np_, 'texto': txt})


def _datas_leitura(d):
    ref = d['referencia']
    dt = d.pop('_datas', None)
    per = d.pop('_periodo', None)
    if not dt:
        return
    ant, atu, dias, prox = dt
    alvo = None
    if per and per[1]:
        alvo = date.fromisoformat(per[1])
    elif ref['data_emissao']:
        alvo = date.fromisoformat(ref['data_emissao'])
    elif ref['mes_referencia']:
        alvo = date.fromisoformat(ref['mes_referencia'] + '-28')
    a_atu = _data_sem_ano(atu, alvo)
    if a_atu is None:
        return
    a_ant = _data_sem_ano(ant, a_atu - timedelta(days=30), antes=a_atu)
    a_prox = _data_sem_ano(prox, a_atu + timedelta(days=30), depois=a_atu)
    ref['leitura_atual'] = a_atu.isoformat()
    ref['leitura_anterior'] = a_ant.isoformat() if a_ant else None
    ref['proxima_leitura'] = a_prox.isoformat() if a_prox else None
    ref['dias_faturados'] = dias
    d['extracao']['observacoes'].append(
        f'Datas de leitura impressas sem ano ({ant}, {atu}, próxima {prox}); ano deduzido do '
        + ('Período de Medição da p2.' if per else 'mês de referência/emissão.'))
    if a_ant and abs((a_atu - a_ant).days - dias) > 1:
        d['extracao']['divergencias_impressas'].append(
            {'onde': 'dias', 'indice': 0, 'nota': f'Datas de leitura impressas {ant} a {atu} '
             f'({(a_atu - a_ant).days} dias) com Nº de dias {dias} impresso.'})


def _gd_e_geracao(d):
    gd, uc = d['gd'], d['unidade_consumidora']
    for it in d['itens']:
        if it['componente'] == 'CONSUMO_COMPENSADO' and it['quantidade_faturada'] is not None:
            gd['lancamentos'].append({'pagina': it['pagina'], 'tipo': 'compensada', 'posto': it['posto'],
                                      'kwh': it['quantidade_faturada'], 'mes_ref': d['referencia']['mes_referencia'],
                                      'ref_expiracao': None, 'unidade_impressa': it['unidade'] or 'kWh',
                                      'rotulo': it['descricao']})
        m = re.search(r'\bGD\s+(I{1,3})\b', it['descricao'])
        if m:
            uc['geracao']['classificacao_gd'] = f'GD_{m[1]}'
    ger = any(i['componente'] in ('DEMANDA_GERACAO', 'GD_INJETADA', 'CONSUMO_COMPENSADO') for i in d['itens']) or \
        any(x['tipo'] == 'injetada' for x in gd['lancamentos']) or any(x['tipo'] == 'geracao' for x in d['demanda'])
    uc['geracao']['e_gerador'] = ger
    txt = ' '.join(m['texto'] for m in d['mensagens'])
    if ger and ('SCEE' in ' '.join(i['descricao'] for i in d['itens']) or 'compensação de energia' in txt):
        uc['geracao']['modalidade_gd'] = 'SCEE'


def _provas(d):
    """Medições cujas leituras × constante não dão o Registrado impresso: só anota (o validar rejeita a fatura)."""
    for j, m in enumerate(d['medicoes']):
        la, lb, c, cons = m['leitura_anterior'], m['leitura_atual'], m['constante'], m['consumo']
        if None in (la, lb, c, cons) or lb < la or abs((lb - la) * c - cons) <= max(1, abs(cons) * 0.01):
            continue
        d['extracao']['observacoes'].append(
            f'medição {j + 1} {m["grandeza"]} {m["posto"]}: Registrado impresso {cons} ≠ ({lb}−{la})×{c}.')
