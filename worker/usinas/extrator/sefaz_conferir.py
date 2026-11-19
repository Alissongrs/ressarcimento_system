"""Conferência pela SEFAZ (NF3e, consulta pública do QR code) das faturas lidas pelo robô.

NUNCA altera o JSON do robô: grava o resultado à parte em dados/sefaz/<id>.json.
Confere: situação da nota (autorizada / cancelada / substituída, pelos eventos), número da NF,
e cada item do robô contra os itens da nota (mesmo valor em R$; quantidade em kWh quando houver).
A página pública NÃO traz saldo de créditos, rateio, leituras nem tributos — esses seguem só do PDF.

Uso: python -I -X utf8 sefaz_conferir.py <id> [<id>...]
     python -I -X utf8 sefaz_conferir.py --lista arquivo.json   (lista JSON de ids)
"""
import json, os, re, sys

sys.path.insert(0, r'C:\Users\AlissonGonçalvesRodr\OneDrive - AMEnergia\Área de Trabalho\Docker'
                   r'\ressarcimento_system\worker\engine')
from consultar_nf3e_sefaz import consultar_nf3e, chave_valida  # noqa: E402

B = r'C:\usinas_thopen\dados'
SAIDA = os.path.join(B, 'sefaz')


def _num(v):
    try:
        return None if v in (None, '') else float(v)
    except (TypeError, ValueError):
        return None


def conferir(fid):
    rob = json.load(open(os.path.join(B, 'json_robo', fid + '.json'), encoding='utf-8'))
    nf = (rob.get('documento') or {}).get('nota_fiscal') or {}
    chave = re.sub(r'\D', '', nf.get('chave_acesso') or '')
    res = {'id': fid, 'chave': chave or None}
    if not chave or not chave_valida(chave):
        res['status'] = 'sem_chave_valida'
        return res
    s = consultar_nf3e(chave)
    if not s or s.get('_erro'):
        res['status'] = 'sefaz_indisponivel'
        res['erro'] = (s or {}).get('_erro')
        return res
    res['status'] = 'consultada'
    res['situacao_nota'] = s.get('situacao') or 'desconhecida'
    res['eventos'] = s.get('eventos')
    num_rob = re.sub(r'\D', '', str(nf.get('numero') or '')).lstrip('0')
    res['numero_nf'] = {'robo': num_rob or None, 'sefaz': s.get('numero'),
                        'igual': bool(num_rob) and num_rob == (s.get('numero') or '').lstrip('0')}
    # itens: pareia por valor absoluto em R$ (tolerância 0,01); confere a quantidade quando a SEFAZ traz
    livres = list(s.get('itens') or [])
    pares, sem_par = [], []
    for it in rob.get('itens') or []:
        v = _num(it.get('valor'))
        if v is None:
            continue
        k = next((i for i, x in enumerate(livres)
                  if x.get('valor_total_numerico') is not None and abs(abs(v) - x['valor_total_numerico']) <= 0.01), None)
        if k is None:
            sem_par.append({'descricao': it.get('descricao'), 'valor': v})
            continue
        x = livres.pop(k)
        q_rob, q_sef = _num(it.get('quantidade_faturada')), x.get('quantidade_numerica')
        if q_rob is None or q_sef is None:
            qi = None
        else:
            d = abs(abs(q_rob) - q_sef)
            # a fatura (ex.: Light) imprime kWh inteiro e a nota tem 4 casas: diferença < 1 com valor inteiro é arredondamento da impressão
            qi = True if d <= 0.01 else ('arredondado' if float(q_rob).is_integer() and d < 1 else False)
        pares.append({'descricao': it.get('descricao'), 'valor': v, 'qtd_robo': q_rob, 'qtd_sefaz': q_sef, 'qtd_igual': qi})
    res['itens'] = {'robo': len(rob.get('itens') or []), 'sefaz': len(s.get('itens') or []),
                    'conferidos': len(pares),
                    'qtd_divergente': [p for p in pares if p['qtd_igual'] is False],
                    'robo_sem_par_na_sefaz': sem_par,
                    'sefaz_sem_par_no_robo': [{'cci': x.get('codigo_cci'), 'qtd': x.get('quantidade_numerica'),
                                               'valor': x.get('valor_total_numerico')} for x in livres]}
    return res


def main(ids):
    os.makedirs(SAIDA, exist_ok=True)
    for fid in ids:
        try:
            r = conferir(fid)
        except Exception as e:  # uma fatura com problema não para as outras
            r = {'id': fid, 'status': 'erro', 'erro': repr(e)}
        json.dump(r, open(os.path.join(SAIDA, fid + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        it = r.get('itens') or {}
        print(fid, r['status'], r.get('situacao_nota', ''), f"itens {it.get('conferidos', '-')}/{it.get('robo', '-')}",
              f"qtd_div {len(it.get('qtd_divergente') or [])}", f"NF {'ok' if (r.get('numero_nf') or {}).get('igual') else '?'}",
              flush=True)


if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] == '--lista':
        a = json.load(open(a[1], encoding='utf-8'))
    main(a)
