"""Confere o JSON extraído de uma fatura de usina e grava o resultado em extracao.conferencias.

Uso: python C:/usinas_thopen/tools/validar.py <id_fatura> [<id_fatura> ...]   (ou "todos")
Imprime OK ou a lista de problemas. Não altera dados extraídos — só a seção extracao.conferencias.
"""
import glob, json, os, sys
from datetime import date

JSON_DIR = r'C:\usinas_thopen\dados\json'
SECOES = ['id_fatura', 'arquivo', 'documento', 'titular', 'unidade_consumidora', 'referencia', 'totais', 'itens',
          'tributos', 'medicoes', 'demanda', 'gd', 'historico', 'pagamento', 'mensagens', 'outros', 'extracao']


def n(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def conferir(d):
    probs, conf = [], {}
    for s in SECOES:
        if s not in d:
            probs.append(f'seção ausente: {s}')
    for k in ('itens', 'medicoes', 'tributos', 'historico'):
        if k in d and not isinstance(d[k], list):
            probs.append(f'{k} deveria ser lista')
    itens = d.get('itens') or []
    tot = (d.get('totais') or {})
    total = n(tot.get('total_a_pagar'))
    soma = round(sum(n(i.get('valor')) or 0 for i in itens), 2)
    conf['soma_itens'] = soma
    conf['total_a_pagar'] = total
    if total is not None and itens:
        alvos = [x for x in (total, n(tot.get('subtotal')), n(tot.get('total_distribuidora')), n(tot.get('total_consolidado')),
                             n(tot.get('total_nota_fiscal'))) if x is not None]
        ok = any(abs(soma - a) <= max(0.05, abs(a) * 0.001) for a in alvos)
        conf['soma_itens_bate'] = ok
        if not ok:
            probs.append(f'soma dos itens {soma} ≠ total {alvos}')
    ext = d.get('extracao') or {}
    # divergência impressa na própria fatura, amarrada ao item/medição (v2); v1: frase "impresso assim" nas observações
    dispensa = {(x.get('onde'), x.get('indice')) for x in ext.get('divergencias_impressas') or [] if isinstance(x, dict)}
    v1_impresso = ext.get('versao_formato', 1) < 2 and 'impresso assim' in ' '.join(str(o) for o in ext.get('observacoes') or []).lower()
    ruins = []
    for i, it in enumerate(itens):
        b, a, v = n(it.get('base_icms')), n(it.get('aliquota_icms')), n(it.get('icms'))
        if ('item', i) in dispensa:
            continue
        if None not in (b, a, v) and abs(b * a / 100 - v) > 0.03:
            ruins.append(f'item {i + 1} ICMS {b}×{a}% = {round(b * a / 100, 2)} ≠ {v}')
        q, t, val = n(it.get('quantidade_faturada')), n(it.get('tarifa_com_tributos')), n(it.get('valor'))
        if None not in (q, t, val) and abs(val) > 1 and abs(abs(q * t) - abs(val)) > max(0.05, abs(val) * 0.01):
            ruins.append(f'item {i + 1} {q}×{t} = {round(q * t, 2)} ≠ {val}')
        if it.get('valor') is not None and n(it.get('valor')) is None:
            probs.append(f'item {i + 1} valor não numérico: {it.get("valor")!r}')
    for j, m in enumerate(d.get('medicoes') or []):
        la, lb, c, cons = n(m.get('leitura_anterior')), n(m.get('leitura_atual')), n(m.get('constante')), n(m.get('consumo'))
        if ('medicao', j) in dispensa or m.get('leitura_arredondada') or not c or n(m.get('perdas_pct')) or n(m.get('ajuste')):
            continue
        if None not in (la, lb, c, cons) and lb >= la and abs((lb - la) * c - cons) > max(1, abs(cons) * 0.01):
            ruins.append(f'medição {j + 1} ({lb}-{la})×{c} = {round((lb - la) * c, 2)} ≠ {cons}')
    ref = d.get('referencia') or {}
    try:
        dias = (date.fromisoformat(ref['leitura_atual']) - date.fromisoformat(ref['leitura_anterior'])).days
        conf['dias_calculados'] = dias
        if n(ref.get('dias_faturados')) is not None and abs(dias - ref['dias_faturados']) > 1 and ('dias', 0) not in dispensa                 and ('dias', None) not in dispensa:
            ruins.append(f'dias {ref["dias_faturados"]} ≠ {dias} pelas datas')
    except Exception:
        pass
    conf['divergencias_calculo'] = ruins
    if ruins and not v1_impresso:
        probs += ruins
    if ext.get('versao_formato', 1) >= 2:
        for k in ('historico_formato', 'tarifas', 'qualidade_servico', 'tabelas_complementares', 'valores_alternativos'):
            if k not in d:
                probs.append(f'v2: chave ausente {k}')
    return probs, conf


def main(ids):
    if ids == ['todos']:
        ids = [os.path.basename(p)[:-5] for p in glob.glob(os.path.join(JSON_DIR, '*.json'))]
    falhas = 0
    for fid in ids:
        p = os.path.join(JSON_DIR, f'{fid}.json')
        try:
            d = json.load(open(p, encoding='utf-8'))
        except Exception as e:
            print(f'{fid}: JSON inválido/ausente: {e}')
            falhas += 1
            continue
        probs, conf = conferir(d)
        d.setdefault('extracao', {})['conferencias'] = conf
        json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        if probs:
            falhas += 1
            print(f'{fid}: {len(probs)} problema(s)')
            for x in probs[:20]:
                print('   -', x)
        else:
            print(f'{fid}: OK (soma itens {conf.get("soma_itens")} / total {conf.get("total_a_pagar")})')
    return 1 if falhas else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
