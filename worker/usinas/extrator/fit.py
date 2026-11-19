"""Parser determinístico dos demonstrativos da FIT Economia de Energia (1 página, texto linear).

Dois modelos: "Relatório do gerador MM/AAAA" (contratos com razão social/CNPJ/banco/conta próprios e histórico com
rótulos em texto) e "DEMONSTRATIVO DE GERAÇÃO Nº" (faturamento por contrato, um bloco de dados bancários, geração do
mês e acumulados; os rótulos do gráfico não estão no texto do PDF).
"""
import re

from base import data_br, esqueleto, num

NOME = 'fit_v1'
MESES = {'JAN': '01', 'FEV': '02', 'MAR': '03', 'ABR': '04', 'MAI': '05', 'JUN': '06', 'JUL': '07', 'AGO': '08',
         'SET': '09', 'OUT': '10', 'NOV': '11', 'DEZ': '12'}
MESES_EXT = {'JANEIRO': '01', 'FEVEREIRO': '02', 'MARÇO': '03', 'MARCO': '03', 'ABRIL': '04', 'MAIO': '05',
             'JUNHO': '06', 'JULHO': '07', 'AGOSTO': '08', 'SETEMBRO': '09', 'OUTUBRO': '10', 'NOVEMBRO': '11',
             'DEZEMBRO': '12'}
END_FIT = 'Ed. Canopus Corporate Savassi, 5º Andar, R. Antônio de Albuquerque, 330 - Savassi, Belo Horizonte - MG CEP 30112-010'
INSTITUCIONAL = ('Bloco institucional FIT: Fale com a gente (geradores@fitenergia.com.br), redes sociais, endereço '
                 'Ed. Canopus Corporate Savassi - Belo Horizonte/MG')


def detecta(texto, doc=None):
    return 'fitenergia' in texto and ('Relatório do gerador' in texto or 'DEMONSTRATIVO DE GERAÇÃO' in texto)


def _depois(ls, rot, k=1):
    i = next((j for j, l in enumerate(ls) if l == rot), None)
    return ls[i + k] if i is not None and i + k < len(ls) else None


def _periodo(d, per, ano, mes):
    mm = re.search(r'(\d\d)/(\d\d) a (\d\d)/(\d\d)', per or '')
    if not mm:
        return
    a1 = ano - 1 if mm[2] > mm[4] else ano  # período que vira o ano (dez → jan)
    d['referencia']['leitura_anterior'] = f'{a1}-{mm[2]}-{mm[1]}'
    d['referencia']['leitura_atual'] = f'{ano}-{mm[4]}-{mm[3]}'
    d['extracao']['observacoes'].append('Período impresso sem ano (dd/mm a dd/mm); ano inferido do mês de referência impresso.')


def _item(desc, valor, secao, mes):
    return {'pagina': 1, 'secao_impressa': secao, 'codigo': None, 'descricao': desc, 'mes_ref': mes, 'componente': 'OUTRO',
            'posto': None, 'quantidade_registrada': None, 'quantidade_faturada': None, 'unidade': None,
            'tarifa_com_tributos': None, 'tarifa_sem_tributos': None, 'valor': num(valor), 'valor_sem_tributos': None,
            'base_icms': None, 'aliquota_icms': None, 'icms': None, 'base_pis_cofins': None, 'aliquota_pis': None,
            'pis': None, 'aliquota_cofins': None, 'cofins': None, 'pis_cofins': None, 'nf_referencia': None,
            'colunas_originais': {secao: desc, 'valor': valor}}


def _outro(d, secao, rot, valor):
    d['outros'].append({'pagina': 1, 'secao_impressa': secao, 'rotulo': rot, 'valor': valor})


def parse(doc, fid, caminho):
    d = esqueleto(fid, caminho, len(doc))
    d['extracao']['parser'] = NOME
    d['totais'].update({'tributos_retidos': None, 'subtotais': [], 'totais_colunas': [], 'total_nota_fiscal': None})
    d['gd'] = {'uc_geradora': None, 'conta_contrato_geradora': None, 'participacao_pct': None, 'lancamentos': [],
               'rateio_beneficiarias': []}
    d['informacoes_consumo'] = []
    d['entrega'] = {'endereco_correspondencia': None, 'unidade_entrega': None, 'sequencia': None,
                    'endereco_devolucao': None}
    d['extracao']['paginas_lidas'] = list(range(1, len(doc) + 1))
    d['extracao']['paginas'] = [{'pagina': i + 1, 'tipo': 'conteudo', 'repete_pagina': None} for i in range(len(doc))]
    doc_, ref, tit, uc_ = d['documento'], d['referencia'], d['titular'], d['unidade_consumidora']
    doc_['tipo'] = 'demonstrativo_fit'
    doc_['distribuidora'] = 'FIT Economia de Energia'
    doc_['distribuidora_sigla'] = 'FIT'
    doc_['distribuidora_endereco'] = END_FIT
    doc_['emissor'] = 'FIT Economia de Energia - Uma empresa Santander'
    uc_['geracao']['e_gerador'] = True
    ls = [x.strip() for x in doc[0].get_text().split('\n') if x.strip()]
    if ls and ls[0].startswith('Relatório do gerador'):
        _modelo_relatorio(d, ls)
    else:
        _modelo_demonstrativo(d, ls)
    nome_usina = next((o['valor'] for o in d['outros'] if o['rotulo'] == 'Usina'), '')
    uc_['geracao']['tipo_usina'] = nome_usina.split()[0] if nome_usina.split() and nome_usina.split()[0] in ('UFV', 'PCH', 'UTE', 'EOL') else None
    for it in d['itens']:
        it['mes_ref'] = ref['mes_referencia']
    _outro(d, 'rodapé', 'institucional', INSTITUCIONAL)
    return d


def _modelo_relatorio(d, ls):
    doc_, ref, tit, tot, pag = d['documento'], d['referencia'], d['titular'], d['totais'], d['pagamento']
    nf = doc_['nota_fiscal']
    nf['modelo'] = 'Relatório do gerador'
    mm = re.search(r'(\d\d)/(\d{4})', ls[0])
    ano = int(mm[2]) if mm else None
    if mm:
        ref['mes_referencia'] = f'{mm[2]}-{mm[1]}'
    nf['numero'] = _depois(ls, 'Relatório nº')
    nf['data_emissao'] = ref['data_emissao'] = data_br(_depois(ls, 'Data da emissão') or '')
    per = _depois(ls, 'Período')
    if ano:
        _periodo(d, per, ano, None)
    i = ls.index('Data de pagamento') if 'Data de pagamento' in ls else None
    usina = ls[i + 2] if i is not None else None
    _outro(d, 'cabeçalho', 'Usina', usina)
    _outro(d, 'cabeçalho', 'Distribuidora', _depois(ls, 'Distribuidora'))
    _outro(d, 'cabeçalho', 'Período', per)
    _outro(d, 'cabeçalho', 'Data de pagamento', data_br(_depois(ls, 'Data de pagamento') or ''))
    if i is not None:
        d['unidade_consumidora']['endereco'] = ls[i + 3]
        mm = re.match(r'CNPJ:\s*(\S+)', ls[i + 4])
        if mm:
            _outro(d, 'cabeçalho', 'CNPJ (sob o nome da usina)', mm[1])
    # contratos: nome, Razão social, …, Valor total
    j = ls.index('Valor por contrato') + 1 if 'Valor por contrato' in ls else len(ls)
    while j < len(ls) and not ls[j].startswith('Valor final'):
        nome = ls[j]
        if j + 1 < len(ls) and ls[j + 1] == 'Razão social':
            bloco = {}
            k = j + 1
            while k < len(ls) and not ls[k].startswith('Valor total'):
                if ls[k] in ('Razão social', 'CNPJ', 'Banco', 'Agência', 'Conta') and k + 1 < len(ls):
                    bloco[ls[k]] = ls[k + 1]
                    k += 2
                    continue
                if ls[k].startswith('O valor informado'):
                    d['mensagens'].append({'pagina': 1, 'texto': ls[k]})
                k += 1
            vt = re.search(r'R\$\s*([\d.]+,\d\d)', ls[k]) if k < len(ls) else None
            bloco['Valor total'] = f'R$ {vt[1]}' if vt else None
            d['tabelas_complementares'].append({'pagina': 1, 'nome': nome, 'linhas': [{'colunas_originais': bloco}]})
            if vt:
                d['itens'].append(_item(nome, vt[1], 'Valor por contrato', None))
            if not tit['nome']:
                tit['nome'], tit['cnpj_cpf'] = bloco.get('Razão social'), bloco.get('CNPJ')
                pag['banco'], pag['agencia'], pag['conta_recebedora'] = bloco.get('Banco'), bloco.get('Agência'), bloco.get('Conta')
            j = k + 1
        else:
            j += 1
    iv = next((k for k, l in enumerate(ls) if l.startswith('Valor final')), None)
    vf = ls[iv + 1] if iv is not None and iv + 1 < len(ls) else None
    if iv is not None and iv + 2 < len(ls) and ls[iv + 2].startswith('*'):
        d['mensagens'].append({'pagina': 1, 'texto': ls[iv + 2]})
    mm = re.search(r'([\d.]+,\d\d)', vf or '')
    if mm:
        tot['total_a_pagar'] = num(mm[1])
        _outro(d, 'faixa azul', 'Valor final', num(mm[1]))
    # histórico: pares "mmm/aa" + valor
    for k in range(len(ls) - 1):
        mm = re.fullmatch(r'([a-z]{3})/(\d\d)', ls[k])
        if mm and mm[1].upper() in MESES and re.fullmatch(r'[\d.,]+', ls[k + 1]):
            d['historico'].append({'pagina': 1, 'mes': f'20{mm[2]}-{MESES[mm[1].upper()]}', 'serie': 'injetada', 'posto': None,
                                   'valor': num(ls[k + 1]), 'unidade': 'MWh', 'unidade_original': 'MWh',
                                   'faturado_pela_media': False})
    d['historico_formato'] = 'tabela' if d['historico'] else 'so_grafico'


def _contratos_bancarios(d, ls, j):
    """Variante com um bloco de dados bancários por contrato: nome, "R$ valor", Razão social, CNPJ, Banco, Agência, Conta."""
    tit, pag = d['titular'], d['pagamento']
    rotulos = ('Razão social', 'CNPJ', 'Banco', 'Agência', 'Conta')
    while j + 1 < len(ls) and not ls[j].startswith(('*', 'DEMONSTRATIVO')):
        mv = re.fullmatch(r'R\$\s*(-?[\d.]+,\d\d)', ls[j + 1])
        if not mv:
            j += 1
            continue
        nome, k, bloco = ls[j], j + 2, {}
        while k < len(ls) and not ls[k].startswith(('*', 'DEMONSTRATIVO')) and \
                not (k + 1 < len(ls) and re.fullmatch(r'R\$\s*-?[\d.]+,\d\d', ls[k + 1])):
            if ls[k] in rotulos and k + 1 < len(ls):
                v, k = ls[k + 1], k + 2
                # razão social quebrada em duas linhas
                while ls[k - 2] == 'Razão social' and k < len(ls) and ls[k] not in rotulos:
                    v, k = v + ' ' + ls[k], k + 1
                bloco[ls[k - 2] if ls[k - 2] in rotulos else 'Razão social'] = v
                continue
            mm = re.match(r'Chave PIX\s+(\S+)', ls[k])
            if mm:
                bloco['Chave PIX'] = mm[1]
            k += 1
        bloco['Valor total'] = ls[j + 1]
        d['itens'].append(_item(nome, mv[1], 'Detalhamento', None))
        d['tabelas_complementares'].append({'pagina': 1, 'nome': nome, 'linhas': [{'colunas_originais': bloco}]})
        if not tit['nome']:
            tit['nome'], tit['cnpj_cpf'] = bloco.get('Razão social'), bloco.get('CNPJ')
            pag['banco'], pag['agencia'], pag['conta_recebedora'] = bloco.get('Banco'), bloco.get('Agência'), bloco.get('Conta')
            pag['pix'] = bloco.get('Chave PIX')
        j = k
    return j


def _modelo_demonstrativo(d, ls):
    doc_, ref, tit, tot, pag = d['documento'], d['referencia'], d['titular'], d['totais'], d['pagamento']
    nf = doc_['nota_fiscal']
    nf['modelo'] = 'DEMONSTRATIVO DE GERAÇÃO'
    k = next((j for j, l in enumerate(ls) if l.startswith('DEMONSTRATIVO DE GERAÇÃO')), None)
    ano = None
    if k is not None:
        mm = re.search(r'N\S*\s*(\d+)', ls[k])
        nf['numero'] = mm[1] if mm else None
        mm = re.fullmatch(r'([A-ZÇ]+)/(\d{4})', ls[k + 1]) if k + 1 < len(ls) else None
        if mm and mm[1] in MESES_EXT:
            ano = int(mm[2])
            ref['mes_referencia'] = f'{mm[2]}-{MESES_EXT[mm[1]]}'
        if ano and k + 2 < len(ls):
            _periodo(d, ls[k + 2], ano, None)
    nf['data_emissao'] = ref['data_emissao'] = data_br(_depois(ls, 'DATA DE EMISSÃO') or '')
    fat = _depois(ls, 'Faturamento')
    ger = _depois(ls, 'Geração deste mês')
    gi = ls.index('Geração deste mês') if 'Geração deste mês' in ls else None
    usina = ls[gi + 2] if gi is not None else None
    local = ls[gi + 3] if gi is not None else None
    _outro(d, 'cabeçalho', 'Usina', usina)
    _outro(d, 'cabeçalho', 'Local - distribuidora', local)
    if local and ' - ' in local:
        d['unidade_consumidora']['endereco'] = local.split(' - ')[0]
        _outro(d, 'cabeçalho', 'Distribuidora local (sigla)', local.split(' - ', 1)[1])
    _outro(d, 'cabeçalho', 'Data de pagamento', data_br(_depois(ls, 'DATA DE PAGAMENTO') or ''))
    mm = re.search(r'([\d.]+,\d\d)', fat or '')
    if mm:
        tot['total_a_pagar'] = num(mm[1])
        _outro(d, 'faixa azul', 'Faturamento', num(mm[1]))
    mm = re.search(r'([\d.]+,\d+)\s*MWh', ger or '')
    if mm:
        mwh = num(mm[1])
        _outro(d, 'faixa azul', 'Geração deste mês (MWh)', mwh)
        d['gd']['lancamentos'].append({'pagina': 1, 'tipo': 'injetada', 'posto': None, 'kwh': round(mwh * 1000, 3),
                                       'mes_ref': ref['mes_referencia'], 'ref_expiracao': None, 'unidade_impressa': 'MWh',
                                       'rotulo': f'Geração deste mês: {ger}'})
    mm = re.search(r'([\d.]+,\d\d)', _depois(ls, 'Esta usina já faturou com a FIT') or '')
    if mm:
        _outro(d, 'faixa verde', 'Esta usina já faturou com a FIT (R$)', num(mm[1]))
    mm = re.search(r'([\d.,]+)\s*MWh', _depois(ls, 'Esta usina já gerou') or '')
    if mm:
        _outro(d, 'faixa verde', 'Esta usina já gerou (MWh)', num(mm[1]))
    # contratos
    if 'Faturamento por contrato (R$)' in ls:
        j = ls.index('Faturamento por contrato (R$)') + 1
        desc = []
        while j < len(ls) and not ls[j].startswith('*') and ls[j] != 'Razão social':
            if re.fullmatch(r'-?[\d.]+,\d\d', ls[j]) and desc:
                d['itens'].append(_item(' '.join(desc), ls[j], 'Faturamento por contrato (R$)', None))
                desc = []
            else:
                desc.append(ls[j])
            j += 1
    elif 'Detalhamento' in ls:
        j = _contratos_bancarios(d, ls, ls.index('Detalhamento') + 1)
    else:
        j = len(ls)
    msg = []
    while j < len(ls) and (ls[j].startswith('*') or msg) and ls[j] != 'Razão social':
        msg.append(ls[j])
        j += 1
        if msg[-1].endswith('.'):
            break
    if msg:
        d['mensagens'].append({'pagina': 1, 'texto': ' '.join(msg)})
    if not tit['nome']:
        tit['nome'] = _depois(ls, 'Razão social')
        tit['cnpj_cpf'] = _depois(ls, 'CNPJ')
        pag['banco'] = _depois(ls, 'Banco')
        pag['agencia'] = _depois(ls, 'Agência')
        pag['conta_recebedora'] = _depois(ls, 'Conta')
        pag['pix'] = _depois(ls, 'Chave PIX')
    if pag['conta_recebedora']:
        _outro(d, 'Dados bancários', 'Conta', pag['conta_recebedora'])
    d['historico_formato'] = 'so_grafico'
    d['extracao']['observacoes'].append('Gráfico "Média de geração mensal em (MWh)": rótulos das barras não estão no '
                                        'texto do PDF; histórico não lido pelo robô.')
