"""Carrega os JSON extraídos (C:/usinas_thopen/dados/json) nas tabelas FATURA_USINA* do banco do SURE.

Uso:  python carregar.py [ids... | todos] [--aplicar] [--criar-tabelas]
Sem --aplicar só simula (lê, normaliza, mostra o que gravaria). Cada fatura é gravada numa transação:
FATURA_USINA (upsert, com o JSON inteiro em dados_json) + tabelas filhas apagadas e reinseridas para aquele id —
recarregar o mesmo JSON dá o mesmo resultado. Só toca nas tabelas FATURA_USINA*.
Aceita JSON v1 (piloto) e v2 (ESPECIFICACAO_JSON.md).
"""
import csv, glob, json, os, re, sys
from datetime import date, datetime

sys.path.insert(0, r'C:\Users\AlissonGonçalvesRodr\OneDrive - AMEnergia\Área de Trabalho\Docker\ressarcimento_system\ia\Copia\essencial')
from pdf_pipeline import DB  # noqa: E402  (credenciais do banco ficam lá, fora deste projeto)
import mysql.connector  # noqa: E402

RAIZ = r'C:\usinas_thopen'
JSON_DIR = os.path.join(RAIZ, 'dados', 'json')
DRIVE = 'gdrive:Faturas Usinas Thopen/'



def gd_do_mes(gdl, mes_fat):
    """Quadro de GD com vários meses em colunas (Celesc): fica só a coluna do mês da fatura. Só filtra quando as linhas
    de INJETADA trazem mais de um mês e um deles é o da fatura."""
    meses = {str(g.get('mes_ref'))[:7] for g in gdl if g.get('tipo') == 'injetada' and g.get('mes_ref')}
    if len(meses) <= 1 or not mes_fat or mes_fat[:7] not in meses:
        return gdl
    return [g for g in gdl if not g.get('mes_ref') or str(g.get('mes_ref'))[:7] == mes_fat[:7]]

def tributo_impresso(d, nome, padrao=None):
    """Valor do tributo no quadro de tributos impresso (dados['tributos']): uma única linha não retida; ambíguo → padrao."""
    vals = set()
    for t in (d.get('tributos') or []):
        if not isinstance(t, dict) or t.get('retido') or t.get('valor') is None:
            continue
        n = str(t.get('tributo') or '').strip().upper().replace('/PASEP', '').replace('PASEP', 'PIS')
        if n == nome:
            vals.add(round(float(num(t['valor'])), 2))
    return vals.pop() if len(vals) == 1 else padrao


def num(v):
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    s = str(v).strip().replace('R$', '').replace(' ', '')
    neg = s.endswith('-') or (s.startswith('(') and s.endswith(')'))
    s = s.strip('()-')
    if re.fullmatch(r'-?\d{1,3}(\.\d{3})*(,\d+)?|-?\d+(,\d+)?', s):
        s = s.replace('.', '').replace(',', '.')
    try:
        x = float(s)
        return -x if neg else x
    except ValueError:
        return None


def dia(v):
    if not v:
        return None
    s = str(v)[:10]
    try:
        return date.fromisoformat(s)
    except ValueError:
        m = re.fullmatch(r'(\d{2})/(\d{2})/(\d{4})', s)
        return date(int(m[3]), int(m[2]), int(m[1])) if m else None


def mes(v):
    if not v:
        return None
    s = str(v)
    m = re.match(r'(\d{4})-(\d{2})', s) or None
    if m:
        return f'{m[1]}-{m[2]}'
    m = re.match(r'(\d{2})/(\d{4})', s)
    return f'{m[2]}-{m[1]}' if m else s[:10]


def txt(v, n):
    if v is None:
        return None
    if isinstance(v, (list, dict)):
        v = json.dumps(v, ensure_ascii=False)
    return str(v)[:n]


def lista(v):
    return v if isinstance(v, list) else []


def gd_lancamentos(gd):
    """v2: gd.lancamentos; v1: listas energia_injetada/energia_compensada/saldo_creditos/…"""
    if not isinstance(gd, dict):
        return []
    if isinstance(gd.get('lancamentos'), list):
        return gd['lancamentos']
    out = []
    mapa = {'energia_injetada': 'injetada', 'energia_compensada': 'compensada', 'saldo_creditos': 'saldo_atual',
            'creditos_a_expirar': 'a_expirar', 'excedente': 'excedente'}
    for chave, tipo in mapa.items():
        for x in lista(gd.get(chave)):
            if isinstance(x, dict):
                out.append({**x, 'tipo': tipo, 'kwh': x.get('kwh', x.get('valor'))})
    for x in lista(gd.get('outros')):
        if isinstance(x, dict):
            out.append({'tipo': 'outro', 'rotulo': txt(x, 600), 'pagina': x.get('pagina')})
    return out


def _soma_contratada(dem, tipos, excluir=False):
    """Soma contratada_kw das linhas do(s) tipo(s), contando uma vez cada par (posto, valor) — 25/11/2026."""
    vistos, out = set(), []
    for x in dem:
        if (x.get('tipo') in tipos) == excluir:
            continue
        v = num(x.get('contratada_kw'))
        if v is None:
            continue
        # geração/injeção: um contrato só por usina — o posto do quadro (FORA_PONTA × GERACAO) não distingue valores
        k = v if not excluir else (str(x.get('posto') or '').upper(), v)
        if k in vistos:
            continue
        vistos.add(k)
        out.append(v)
    return round(sum(out), 2) if out else None


def demanda_linhas(dm):
    if isinstance(dm, list):
        return dm
    out = []
    if isinstance(dm, dict):
        for chave, campo in (('contratada', 'contratada_kw'), ('medida', 'medida_kw'), ('faturada', 'faturada_kw'),
                             ('ultrapassagem', 'faturada_ultrapassagem_kw')):
            for x in lista(dm.get(chave)):
                if isinstance(x, dict):
                    out.append({'posto': x.get('posto'), campo: x.get('kw', x.get('valor')), 'rotulo': x.get('rotulo') or chave,
                                'tipo': x.get('tipo') or ('geracao' if 'GERA' in str(x).upper() or 'TUSDG' in str(x).upper() else 'consumo'),
                                'pagina': x.get('pagina'), 'colunas_originais': x})
    return out


def historico_linhas(hs):
    """v2 já é longo (mes, serie, posto, valor); v1 tinha consumo_kwh/injetada_kwh/demanda_kw por mês."""
    out = []
    for h in lista(hs):
        if not isinstance(h, dict):
            continue
        if 'serie' in h:
            out.append(h)
            continue
        for campo, serie, unid in (('consumo_kwh', 'consumo', 'kWh'), ('injetada_kwh', 'injetada', 'kWh'),
                                   ('demanda_kw', 'demanda', 'kW'), ('dias', 'dias', 'dias')):
            if num(h.get(campo)) is not None:
                out.append({'pagina': h.get('pagina'), 'mes': h.get('mes'), 'serie': serie, 'posto': h.get('posto'),
                            'valor': h.get(campo), 'unidade': unid, 'unidade_original': h.get('unidade_original')})
    return out


def manifesto():
    with open(os.path.join(RAIZ, 'dados', 'manifesto.csv'), encoding='utf-8-sig') as f:
        return {l['id_fatura']: l for l in csv.DictReader(f, delimiter=';')}


def montar(d, man):
    fid = d['id_fatura']
    m = man.get(fid, {})
    doc, nf = d.get('documento') or {}, (d.get('documento') or {}).get('nota_fiscal') or {}
    tit, uc, ref, tot = d.get('titular') or {}, d.get('unidade_consumidora') or {}, d.get('referencia') or {}, d.get('totais') or {}
    ext = d.get('extracao') or {}
    itens = [i for i in lista(d.get('itens')) if isinstance(i, dict)]
    gdl = gd_lancamentos(d.get('gd'))
    dem = demanda_linhas(d.get('demanda'))
    soma = lambda xs: round(sum(x for x in xs if x is not None), 2) if any(x is not None for x in xs) else None
    pc = soma([num(i.get('pis_cofins')) for i in itens])
    caminho = (d.get('arquivo') or {}).get('caminho') or m.get('caminho')
    cab = {
        'id_fatura': fid, 'caminho': txt(caminho, 500), 'pasta_usina': txt(m.get('pasta_usina'), 200),
        'mes_geracao_pasta': txt(m.get('mes_geracao_pasta'), 7), 'arquivo': txt(m.get('arquivo'), 300),
        'paginas': (d.get('arquivo') or {}).get('paginas') or num(m.get('paginas')),
        'link_drive': txt(DRIVE + str(caminho).replace('\\', '/'), 600), 'duplicata_de': m.get('duplicata_de') or None,
        'tipo_documento': txt(doc.get('tipo'), 30), 'distribuidora': txt(doc.get('distribuidora'), 200),
        'distribuidora_sigla': txt(doc.get('distribuidora_sigla'), 60), 'distribuidora_cnpj': txt(doc.get('distribuidora_cnpj'), 20),
        'nf_numero': txt(nf.get('numero'), 40), 'nf_serie': txt(nf.get('serie'), 10), 'nf_chave_acesso': txt(nf.get('chave_acesso'), 60),
        'nf_substituida': txt(nf.get('nf_substituida'), 60), 'data_emissao': dia(nf.get('data_emissao') or ref.get('data_emissao')),
        'titular_nome': txt(tit.get('nome'), 250), 'titular_cnpj_cpf': txt(tit.get('cnpj_cpf'), 20),
        # UC = número da instalação (decisão do usuário 30/10); sem instalação impressa, fica o número lido como UC
        'uc': txt(uc.get('instalacao') or uc.get('uc'), 40), 'instalacao': txt(uc.get('instalacao'), 40), 'classificacao': txt(uc.get('classificacao'), 250),
        'grupo': txt(uc.get('grupo'), 2), 'subgrupo': txt(uc.get('subgrupo'), 6),
        'modalidade_tarifaria': txt(uc.get('modalidade_tarifaria'), 30),
        'modalidade_gd': txt((uc.get('geracao') or {}).get('modalidade_gd'), 80),
        'mes_referencia': mes(ref.get('mes_referencia')), 'data_vencimento': dia(ref.get('data_vencimento')),
        'leitura_anterior': dia(ref.get('leitura_anterior')), 'leitura_atual': dia(ref.get('leitura_atual')),
        'dias_faturados': num(ref.get('dias_faturados')),
        'total_a_pagar': num(tot.get('total_a_pagar')), 'total_nota_fiscal': num(tot.get('total_nota_fiscal')),
        'total_icms': tributo_impresso(d, 'ICMS', soma([num(i.get('icms')) for i in itens])),
        # 24/11/2026: ICMS/PIS/COFINS total = o do QUADRO DE TRIBUTOS impresso (uma linha não retida); sem quadro, soma dos
        # itens como antes (vazio quando o item só tem a coluna PIS/COFINS junta)
        'total_pis': tributo_impresso(d, 'PIS', soma([num(i.get('pis')) for i in itens])),
        'total_cofins': tributo_impresso(d, 'COFINS', soma([num(i.get('cofins')) for i in itens])), 'total_pis_cofins': pc,
        'cosip': num(tot.get('valor_cosip_cip')) if tot.get('valor_cosip_cip') is not None else
                 soma([num(i.get('valor')) for i in itens if i.get('componente') == 'ILUMINACAO_PUBLICA']),
        # 25/11/2026: a Celesc imprime o quadro de GD com 6 meses lado a lado (mes_ref = coluna) — o total é só a coluna do
        # mês da fatura (somar as colunas deu 275.817 kWh numa fatura com injeção 0). Elektro: mes_ref da compensada é a
        # origem do crédito (MUC 05/2024) e a injetada não tem mês → não filtra.
        'kwh_injetada_total': soma([num(g.get('kwh')) for g in gd_do_mes(gdl, mes(ref.get('mes_referencia'))) if g.get('tipo') == 'injetada']),
        'kwh_compensada_total': soma([num(g.get('kwh')) for g in gd_do_mes(gdl, mes(ref.get('mes_referencia'))) if g.get('tipo') == 'compensada']),
        # 25/11/2026: 'injecao' (Demanda de Injeção: Light, Neoenergia, Celesc) é demanda de GERAÇÃO — antes entrava somada
        # na contratada de consumo. Geração = linhas 'geracao'; sem elas, a de injeção (as duas juntas contariam 2×).
        # o mesmo contratado aparece em 2 quadros (CEMIG: "Grandezas Contratadas" e "Demanda ativa ... Contratado"):
        # soma só pares (posto, valor) distintos — 0b6edca0: 30 + 30 não é 60
        'demanda_contratada_kw': _soma_contratada(dem, ('geracao', 'injecao'), excluir=True),
        'demanda_geracao_kw': _soma_contratada(dem, ('geracao',))
                              if any(x.get('tipo') == 'geracao' and x.get('contratada_kw') is not None for x in dem) else
                              _soma_contratada(dem, ('injecao',)),
        'soma_itens': (ext.get('conferencias') or {}).get('soma_itens'),
        'validacao_ok': None, 'n_divergencias_impressas': len(lista(ext.get('divergencias_impressas'))),
        'n_ilegiveis': len(lista(ext.get('ilegiveis'))), 'versao_formato': ext.get('versao_formato', 1),
        'extraido_em': (lambda s: datetime.fromisoformat(s[:19]) if s and re.match(r'\d{4}-\d{2}-\d{2}T', s) else None)(ext.get('extraido_em')),
        'dados_json': json.dumps(d, ensure_ascii=False),
    }
    conf = ext.get('conferencias') or {}
    cab['validacao_ok'] = 1 if conf.get('soma_itens_bate', True) and not conf.get('divergencias_calculo') or cab['n_divergencias_impressas'] else 0
    cab['metodo'] = 'robo' if ext.get('parser') else 'visual'
    if cab['metodo'] == 'robo':
        cab['validacao_ok'] = 1 if ext.get('aceita') else 0
    filhos = {
        'FATURA_USINA_ITENS': [{
            'ordem': k, 'pagina': num(i.get('pagina')), 'secao_impressa': txt(i.get('secao_impressa') or i.get('grupo_impresso'), 120),
            'codigo': txt(i.get('codigo'), 30), 'descricao': txt(i.get('descricao'), 400), 'mes_ref': txt(i.get('mes_ref'), 10),
            'componente': txt(i.get('componente'), 40), 'posto': txt(i.get('posto'), 20),
            'quantidade_registrada': num(i.get('quantidade_registrada')), 'quantidade_faturada': num(i.get('quantidade_faturada')),
            'unidade': txt(i.get('unidade'), 20), 'tarifa_com_tributos': num(i.get('tarifa_com_tributos')),
            'tarifa_sem_tributos': num(i.get('tarifa_sem_tributos')), 'valor': num(i.get('valor')),
            'valor_sem_tributos': num(i.get('valor_sem_tributos') or i.get('valor_fornecimento')),
            'base_icms': num(i.get('base_icms')), 'aliquota_icms': num(i.get('aliquota_icms')), 'icms': num(i.get('icms')),
            'base_pis_cofins': num(i.get('base_pis_cofins')), 'aliquota_pis': num(i.get('aliquota_pis')), 'pis': num(i.get('pis')),
            'aliquota_cofins': num(i.get('aliquota_cofins')), 'cofins': num(i.get('cofins')), 'pis_cofins': num(i.get('pis_cofins')),
            'nf_referencia': txt(i.get('nf_referencia'), 60), 'colunas_originais': txt(i.get('colunas_originais') or {}, 60000),
        } for k, i in enumerate(itens)],
        'FATURA_USINA_MEDICOES': [{
            'ordem': k, 'pagina': num(x.get('pagina')), 'tabela_origem': txt(x.get('tabela_origem'), 150), 'medidor': txt(x.get('medidor'), 60),
            'grandeza': txt(x.get('grandeza'), 120), 'posto': txt(x.get('posto'), 20),
            'leitura_anterior': num(x.get('leitura_anterior')), 'leitura_atual': num(x.get('leitura_atual')), 'constante': num(x.get('constante')),
            'perdas_pct': num(x.get('perdas_pct')), 'ajuste': num(x.get('ajuste')), 'consumo': num(x.get('consumo')),
            'consumo_faturado': num(x.get('consumo_faturado') or x.get('faturado') or x.get('quantidade_faturada')),
            'fator_potencia': num(x.get('fator_potencia')), 'ajuste_fator_potencia': num(x.get('ajuste_fator_potencia') or x.get('ajuste_fp')),
            'unidade': txt(x.get('unidade'), 20), 'data_hora_registro': txt(x.get('data_hora_registro'), 30),
            'leitura_arredondada': 1 if x.get('leitura_arredondada') else 0, 'colunas_originais': txt(x.get('colunas_originais') or {}, 60000),
        } for k, x in enumerate(m_ for m_ in lista(d.get('medicoes')) if isinstance(m_, dict))],
        'FATURA_USINA_DEMANDA': [{
            'ordem': k, 'pagina': num(x.get('pagina')), 'tipo': txt(x.get('tipo'), 20), 'posto': txt(x.get('posto'), 20),
            'contratada_kw': num(x.get('contratada_kw')), 'medida_kw': num(x.get('medida_kw')), 'faturada_kw': num(x.get('faturada_kw')),
            'faturada_ultrapassagem_kw': num(x.get('faturada_ultrapassagem_kw')), 'nao_consumida_kw': num(x.get('nao_consumida_kw')),
            'data_hora': txt(x.get('data_hora'), 30), 'rotulo': txt(x.get('rotulo'), 300), 'colunas_originais': txt(x.get('colunas_originais') or {}, 60000),
        } for k, x in enumerate(dem)],
        'FATURA_USINA_GD': [{
            'ordem': k, 'pagina': num(g.get('pagina')), 'tipo': txt(g.get('tipo'), 30), 'posto': txt(g.get('posto'), 20),
            'kwh': num(g.get('kwh')), 'mes_ref': txt(g.get('mes_ref'), 10), 'ref_expiracao': txt(g.get('ref_expiracao') or g.get('prazo'), 20),
            'unidade_impressa': txt(g.get('unidade_impressa'), 20), 'uc_beneficiaria': None, 'percentual': None,
            'rotulo': txt(g.get('rotulo'), 600),
        } for k, g in enumerate(gdl)] + [{
            'ordem': 10000 + k, 'pagina': None, 'tipo': 'rateio', 'posto': None, 'kwh': num(r.get('kwh')), 'mes_ref': None,
            'ref_expiracao': None, 'unidade_impressa': None, 'uc_beneficiaria': txt(r.get('uc'), 40),
            'percentual': num(r.get('percentual')), 'rotulo': None,
        } for k, r in enumerate(x for x in lista((d.get('gd') or {}).get('rateio_beneficiarias')) if isinstance(x, dict))],
        'FATURA_USINA_HISTORICO': [{
            'ordem': k, 'pagina': num(h.get('pagina')), 'mes': mes(h.get('mes')), 'serie': txt(h.get('serie'), 30),
            'posto': txt(h.get('posto'), 20), 'valor': num(h.get('valor')), 'unidade': txt(h.get('unidade'), 20),
            'unidade_original': txt(h.get('unidade_original'), 20), 'faturado_pela_media': 1 if h.get('faturado_pela_media') else 0,
        } for k, h in enumerate(historico_linhas(d.get('historico')))],
    }
    return cab, filhos


def criar_tabelas(cur):
    sql = open(os.path.join(RAIZ, 'tools', 'ddl_fatura_usina.sql'), encoding='utf-8').read()
    for st in [s for s in re.sub(r'--[^\n]*', '', sql).split(';') if s.strip()]:
        cur.execute(st)


def main(args):
    global JSON_DIR
    aplicar, criar = '--aplicar' in args, '--criar-tabelas' in args
    robo = '--robo' in args  # lê dados/json_robo: só aceitas pela conferência, sem gabarito visual e sem duplicata
    ids = [a for a in args if not a.startswith('--')]
    man = manifesto()
    if robo:
        JSON_DIR = os.path.join(RAIZ, 'dados', 'json_robo')
        visuais = {os.path.basename(p)[:-5] for p in glob.glob(os.path.join(RAIZ, 'dados', 'json', '*.json'))}
        if not ids or ids == ['todos']:
            ids = sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(JSON_DIR, '*.json')))
        fora = [f for f in ids if f in visuais or (man.get(f) or {}).get('duplicata_de')]
        ids = [f for f in ids if f not in fora]
        aceitas = []
        for f in ids:
            if json.load(open(os.path.join(JSON_DIR, f'{f}.json'), encoding='utf-8'))['extracao'].get('aceita'):
                aceitas.append(f)
        print(f'robô: {len(aceitas)} aceitas a carregar; ignoradas {len(fora)} (têm gabarito visual ou são duplicata) '
              f'e {len(ids) - len(aceitas)} rejeitadas pela conferência')
        ids = aceitas
    elif not ids or ids == ['todos']:
        ids = sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(JSON_DIR, '*.json')))
    c = mysql.connector.connect(**DB) if (aplicar or criar) else None
    cur = c.cursor() if c else None
    if criar:
        criar_tabelas(cur)
        c.commit()
        print('tabelas FATURA_USINA* criadas/conferidas')
    ok = erro = 0
    for fid in ids:
        try:
            d = json.load(open(os.path.join(JSON_DIR, f'{fid}.json'), encoding='utf-8'))
            cab, filhos = montar(d, man)
        except Exception as e:
            erro += 1
            print(f'{fid}: ERRO ao montar: {e}')
            continue
        if not aplicar:
            ok += 1
            print(f'{fid}: {cab["distribuidora_sigla"]} uc={cab["uc"]} ref={cab["mes_referencia"]} total={cab["total_a_pagar"]} '
                  + ' '.join(f'{t.split("_")[-1].lower()}={len(v)}' for t, v in filhos.items()))
            continue
        try:
            cols = list(cab)
            cur.execute(f"INSERT INTO FATURA_USINA ({','.join(cols)}) VALUES ({','.join(['%s'] * len(cols))}) "
                        f"ON DUPLICATE KEY UPDATE {','.join(f'{k}=VALUES({k})' for k in cols if k != 'id_fatura')}",
                        [cab[k] for k in cols])
            for tab, linhas in filhos.items():
                cur.execute(f'DELETE FROM {tab} WHERE id_fatura=%s', (fid,))
                if linhas:  # várias linhas num INSERT só (o RDS é longe: 1 ida e volta por tabela)
                    ks = ['id_fatura'] + list(linhas[0])
                    cur.executemany(f"INSERT INTO {tab} ({','.join(ks)}) VALUES ({','.join(['%s'] * len(ks))})",
                                    [[fid] + [l.get(k) for k in ks[1:]] for l in linhas])
            c.commit()
            ok += 1
        except Exception as e:
            c.rollback()
            erro += 1
            print(f'{fid}: ERRO ao gravar: {e}')
    print(f'{"gravadas" if aplicar else "simuladas"}: {ok}  erros: {erro}')
    return 1 if erro else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
