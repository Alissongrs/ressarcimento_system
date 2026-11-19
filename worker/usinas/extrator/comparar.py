"""Compara o JSON do robô (dados/json_robo) com o gabarito visual (dados/json), campo a campo.

Uso: python comparar.py LIGHT [--detalhe N]   → acerto por campo + exemplos de diferença.
Números: iguais com tolerância de 0,005. Textos: sem acento, maiúsculas, espaços colapsados.
"""
import glob, json, os, re, sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from base import sem_acento

B = r'C:\usinas_thopen\dados'
ESCALARES = [
    'documento.nota_fiscal.numero', 'documento.nota_fiscal.serie', 'documento.nota_fiscal.data_emissao',
    'documento.nota_fiscal.chave_acesso', 'documento.nota_fiscal.protocolo_autorizacao',
    'titular.nome', 'titular.cnpj_cpf', 'titular.conta_contrato', 'titular.codigo_cliente', 'titular.cep',
    'titular.cidade', 'titular.uf',
    'unidade_consumidora.uc', 'unidade_consumidora.classificacao', 'unidade_consumidora.grupo',
    'unidade_consumidora.subgrupo', 'unidade_consumidora.modalidade_tarifaria',
    'unidade_consumidora.tipo_fornecimento',
    'referencia.mes_referencia', 'referencia.data_vencimento', 'referencia.leitura_anterior',
    'referencia.leitura_atual', 'referencia.dias_faturados', 'referencia.proxima_leitura',
    'totais.total_a_pagar', 'totais.valor_cosip_cip', 'pagamento.linha_digitavel',
]
CAMPOS_ITEM = ['quantidade_faturada', 'unidade', 'tarifa_com_tributos', 'tarifa_sem_tributos', 'valor', 'base_icms',
               'aliquota_icms', 'icms', 'pis_cofins']
CLASSIF_ITEM = ['componente', 'posto']
CAMPOS_MED = ['medidor', 'leitura_anterior', 'leitura_atual', 'constante', 'consumo']


def pegar(d, caminho):
    for k in caminho.split('.'):
        d = (d or {}).get(k) if isinstance(d, dict) else None
    return d


def norm(v):
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        return round(float(v), 4)
    s = sem_acento(str(v)).upper()
    return re.sub(r'\s+', ' ', s).strip() or None


def igual(a, b):
    a, b = norm(a), norm(b)
    if isinstance(a, float) and isinstance(b, float):
        return abs(a - b) <= 0.005 + abs(b) * 1e-9
    if isinstance(a, str) and isinstance(b, (int, float)) or isinstance(b, str) and isinstance(a, (int, float)):
        return False
    return a == b


def chave_desc(s):
    return re.sub(r'[^A-Z0-9]', '', sem_acento(s or '').upper())


def parear(robo, gold, chave):
    """Pareia listas pela chave; sobra = não encontrado."""
    livres = list(range(len(gold)))
    pares = []
    for r in robo:
        k = chave(r)
        j = next((j for j in livres if chave(gold[j]) == k), None)
        if j is not None:
            livres.remove(j)
            pares.append((r, gold[j]))
        else:
            pares.append((r, None))
    return pares, [gold[j] for j in livres]


def main(sigla, detalhe=8):
    ac = defaultdict(lambda: [0, 0])  # campo → [acertos, total]
    exemplos = defaultdict(list)
    n = 0
    for p in sorted(glob.glob(os.path.join(B, 'json_robo', '*.json'))):
        fid = os.path.basename(p)[:-5]
        gp = os.path.join(B, 'json', fid + '.json')
        if not os.path.exists(gp):
            continue
        r = json.load(open(p, encoding='utf-8'))
        g = json.load(open(gp, encoding='utf-8'))
        if pegar(g, 'documento.distribuidora_sigla') != sigla:
            continue
        n += 1

        def conta(campo, ok, info):
            ac[campo][1] += 1
            ac[campo][0] += bool(ok)
            if not ok and len(exemplos[campo]) < detalhe:
                exemplos[campo].append(f'{fid}: {info}')

        for c in ESCALARES:
            a, b = pegar(r, c), pegar(g, c)
            conta(c, igual(a, b), f'robô={a!r} gabarito={b!r}')
        # itens
        ri, gi = r.get('itens') or [], g.get('itens') or []
        conta('itens.quantidade', len(ri) == len(gi), f'robô {len(ri)} × gabarito {len(gi)}')
        pares, sobra = parear(ri, gi, lambda x: (chave_desc(x.get('descricao')), norm(x.get('valor'))))
        for a, b in pares:
            if b is None:
                conta('itens.pareados', False, f'só no robô: {a.get("descricao")!r} {a.get("valor")}')
                continue
            conta('itens.pareados', True, '')
            for c in CAMPOS_ITEM + CLASSIF_ITEM:
                conta('item.' + c, igual(a.get(c), b.get(c)), f'{a.get("descricao")!r}: robô={a.get(c)!r} gabarito={b.get(c)!r}')
        for b in sobra:
            conta('itens.pareados', False, f'só no gabarito: {b.get("descricao")!r} {b.get("valor")}')
        # tributos
        pares, sobra = parear(r.get('tributos') or [], g.get('tributos') or [],
                              lambda x: chave_desc(x.get('tributo'))[:3])
        for a, b in pares:
            for c in ('base', 'aliquota', 'valor'):
                conta('tributo.' + c, b is not None and igual(a.get(c), b.get(c)),
                      f'{a.get("tributo")}: robô={a.get(c)!r} gabarito={(b or {}).get(c)!r}')
        for b in sobra:
            conta('tributo.valor', False, f'só no gabarito: {b.get("tributo")} {b.get("valor")}')
        # medições
        rm, gm = r.get('medicoes') or [], g.get('medicoes') or []
        conta('medicoes.quantidade', len(rm) == len(gm), f'robô {len(rm)} × gabarito {len(gm)}')
        for k, (a, b) in enumerate(zip(rm, gm)):
            for c in CAMPOS_MED:
                conta('medicao.' + c, igual(a.get(c), b.get(c)), f'#{k} {a.get("grandeza")}: robô={a.get(c)!r} gabarito={b.get(c)!r}')
            conta('medicao.posto', igual(a.get('posto'), b.get('posto')), f'#{k}: robô={a.get("posto")!r} gabarito={b.get("posto")!r}')
        if (g.get('extracao') or {}).get('versao_formato', 1) < 2:
            continue  # gabarito v1 (piloto): histórico/GD em formato antigo
        # histórico (formato longo v2)
        rh = {(h.get('mes'), h.get('serie'), h.get('posto')): h.get('valor') for h in r.get('historico') or []}
        gh = {(h.get('mes'), h.get('serie'), h.get('posto')): h.get('valor') for h in g.get('historico') or []}
        conta('historico.chaves', set(rh) == set(gh),
              f'só robô {sorted(set(rh) - set(gh), key=str)[:3]} só gabarito {sorted(set(gh) - set(rh), key=str)[:3]}')
        for k in set(rh) & set(gh):
            conta('historico.valor', igual(rh[k], gh[k]), f'{k}: robô={rh[k]!r} gabarito={gh[k]!r}')
        conta('historico_formato', r.get('historico_formato') == g.get('historico_formato'),
              f'robô={r.get("historico_formato")!r} gabarito={g.get("historico_formato")!r}')
        # GD: lançamentos por (tipo, posto)
        rl = {(x.get('tipo'), x.get('posto')): x.get('kwh') for x in (r.get('gd') or {}).get('lancamentos') or []}
        gl = {(x.get('tipo'), x.get('posto')): x.get('kwh') for x in (g.get('gd') or {}).get('lancamentos') or []}
        conta('gd.chaves', set(rl) == set(gl), f'só robô {sorted(set(rl) - set(gl), key=str)} só gabarito {sorted(set(gl) - set(rl), key=str)}')
        for k in set(rl) & set(gl):
            conta('gd.kwh', igual(rl[k], gl[k]), f'{k}: robô={rl[k]!r} gabarito={gl[k]!r}')
    print(f'{sigla}: {n} faturas comparadas\n')
    for c, (ok, tot) in sorted(ac.items(), key=lambda kv: kv[1][0] / max(1, kv[1][1])):
        print(f'{100 * ok / max(1, tot):6.1f}%  {ok:5d}/{tot:<5d} {c}')
    print()
    for c, ex in exemplos.items():
        print(f'── {c}')
        for e in ex:
            print('   ', e[:220])


if __name__ == '__main__':
    a = sys.argv[1:]
    det = int(a[a.index('--detalhe') + 1]) if '--detalhe' in a else 6
    main(a[0].upper(), det)
