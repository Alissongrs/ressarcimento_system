"""Quadro de continuidade (DIC, FIC, DMIC, DICRI) das faturas de Energia → tabela FATURA_CONTINUIDADE.

Lê o texto JÁ GUARDADO de cada fatura (FATURA_DADOS_EXTRAIDOS.texto_plumber) — não reabre PDF — com o leitor
ler_quadro() abaixo, e grava uma linha por indicador. É o dado das regras F48/F49 na aba Energia
(handlers/energia_regras.go: lerContinuidade).

Uso (a partir de ressarcimento_system/, com DB_APP_URL no backend/.env):
    python -X utf8 ferramentas/continuidade/importar.py medir            # só lê: quantas faturas, violações
    python -X utf8 ferramentas/continuidade/importar.py gravar           # cria a tabela (se faltar) e grava
    python -X utf8 ferramentas/continuidade/importar.py desfazer         # apaga o que este importador gravou

Não altera nenhuma tabela existente: só cria e preenche FATURA_CONTINUIDADE (fonte='texto_plumber').
"""
import os, re, sys, collections
from urllib.parse import urlparse, unquote

NUM = r'\d{1,4}(?:\.\d{3})*,\d{1,4}'
RX_LINHA = re.compile(r'^[ \t]*(DICRI|DMIC|DIC|FIC)\b(?:[ \t]*-[ \t]*[A-Za-zÀ-ú ]+?(?=[ \t]+\d))?(?:[ \t]+(MENSAL|TRIMESTRAL|ANUAL))?((?:[ \t]+' + NUM + r')+)', re.M | re.I)
RX_CPFL_CAB = re.compile(r'\bDIC\s+FIC\s+DMIC(\s+DICRI)?\b', re.I)
RX_PADRAO = re.compile(r'Padr[aã]o\s+Mensal((?:\s+' + NUM + r'){3,4})', re.I)
RX_APUR = re.compile(r'Apurado\s+Mensal((?:\s+' + NUM + r'){1,4})', re.I)
RX_REF = re.compile(r'Refer[êe]ncias?\s*:?\s*(\d{2}/\d{4})|Per[ií]odo\s+de\s+Apura[çc][aã]o[^\d]{0,12}(\d{2}/\d{4})|(\d{2}/\d{4})\s*-\s*Conjunto', re.I)
RX_VRC = re.compile(r'(?:EUSD|VRC)[^\d\n]{0,25}(?:Ref\.?\s*\d{2}/\d{4}\)?)?[^\d\n]{0,8}(' + NUM + ')', re.I)
RX_APUR_PRIMEIRO = re.compile(r'APURADO\s+MENSAL\s+TRIM|CONJUNTO\s+APURADO\s+MENSAL', re.I)
FONTE = 'texto_plumber'


def n(s):
    return float(s.replace('.', '').replace(',', '.'))


def ler_quadro(t):
    """→ {'linhas': [{ind, lim, apur}], 'ref': 'AAAA-MM'|None, 'vrc': float|None} ou None.
    Formatos (conferidos no PDF em 06/11/2026):
      Coelba / Energisa MS: "DIC 4,83 6,18" (limite, apurado);
      Coelba Grupo A: "DMIC - Duração… 0,0000 2,52 0,00 0,00" (APURADO, limite mensal, trimestral, anual);
      Energisa MT/TO, Equatorial PA: "DIC 28,00 35,82 0,00 0,00" (meta mensal, REALIZADO, trimestral, anual);
      Elektro: "DIC - Duração… 5,19 10,38 20,77 0,00" (mensal, trimestral = 2×mensal, anual, APURADO);
      CPFL: cabeçalho "DIC FIC DMIC DICRI" + "Padrão Mensal …" + "Apurado Mensal …";
      999 = "não se aplica" (Energisa)."""
    if not t:
        return None
    out = {}
    mc = RX_CPFL_CAB.search(t)
    if mc:
        pad = RX_PADRAO.search(t, mc.start())
        if pad and pad.start() - mc.end() < 400:
            inds = ['DIC', 'FIC', 'DMIC'] + (['DICRI'] if mc.group(1) else [])
            lims = [n(x) for x in re.findall(NUM, pad.group(1))]
            ap = RX_APUR.search(t, pad.end())
            aps = [n(x) for x in re.findall(NUM, ap.group(1))] if ap and ap.start() - pad.end() < 400 else []
            for i, ind in enumerate(inds):
                if i < len(lims):
                    out[ind] = {'ind': ind, 'lim': lims[i], 'apur': aps[i] if i < len(aps) else None}
    # Coelba Grupo A: cabeçalho "VALOR APURADO | LIMITE MENSAL | TRIMESTRAL | ANUAL" — o APURADO vem primeiro
    apurado_primeiro = bool(RX_APUR_PRIMEIRO.search(t))
    if not out:
        for m in RX_LINHA.finditer(t):
            ind, per, nums = m.group(1).upper(), (m.group(2) or '').upper(), [n(x) for x in re.findall(NUM, m.group(3))]
            if per in ('TRIMESTRAL', 'ANUAL') or ind in out:
                continue
            lim = nums[0]
            if apurado_primeiro and len(nums) >= 2:
                if nums[1] >= 999:
                    continue
                out[ind] = {'ind': ind, 'lim': nums[1], 'apur': nums[0]}
                continue
            if len(nums) >= 4:
                elektro = lim > 0 and abs(nums[1] - 2 * lim) <= 0.03 * lim + 0.02
                apur = nums[3] if elektro else nums[1]
            elif len(nums) == 2:
                apur = nums[1]
            else:
                apur = None
            if apur is not None and apur >= 999:
                apur = None
            if lim >= 999:
                continue
            out[ind] = {'ind': ind, 'lim': lim, 'apur': apur}
    if not out or ('DIC' not in out and 'DMIC' not in out):
        return None
    r = RX_REF.search(t)
    ref = None
    if r:
        mm = next(g for g in r.groups() if g)
        ref = mm[3:] + '-' + mm[:2]
    v = RX_VRC.search(t)
    return {'linhas': list(out.values()), 'ref': ref, 'vrc': n(v.group(1)) if v else None}


def conectar():
    raiz = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    url = None
    for ln in open(os.path.join(raiz, 'backend', '.env'), encoding='utf-8'):
        if ln.startswith('DB_APP_URL='):
            url = ln.split('=', 1)[1].strip().strip('"').strip("'")
    import pymysql
    # formato Go: usuario:senha@tcp(host:porta)/banco?params
    m = re.match(r'([^:]+):(.*)@tcp\(([^:)]+):?(\d+)?\)/([^?]+)', url)
    return pymysql.connect(host=m.group(3), port=int(m.group(4) or 3306), user=unquote(m.group(1)), password=unquote(m.group(2)),
                           database=m.group(5), charset='utf8mb4', ssl={'ssl': {}} if 'tls' in url else None)


def ler_tudo(cur):
    cur.execute("SELECT id FROM FATURA_DADOS_EXTRAIDOS WHERE texto_plumber LIKE '%DMIC%' OR texto_plumber LIKE '%DICRI%'")
    ids = [r[0] for r in cur.fetchall()]
    res = []
    for i in range(0, len(ids), 400):
        lote = ids[i:i + 400]
        cur.execute('SELECT id, texto_plumber FROM FATURA_DADOS_EXTRAIDOS WHERE id IN (' + ','.join(['%s'] * len(lote)) + ')', lote)
        for idr, t in cur.fetchall():
            q = ler_quadro(t)
            if q:
                q['id'] = str(idr)
                res.append(q)
    return ids, res


def main():
    acao = sys.argv[1] if len(sys.argv) > 1 else 'medir'
    con = conectar(); cur = con.cursor()
    if acao == 'desfazer':
        cur.execute("DELETE FROM FATURA_CONTINUIDADE WHERE base='energia' AND fonte=%s", (FONTE,))
        con.commit(); print('apagadas', cur.rowcount); return
    ids, res = ler_tudo(cur)
    viol = sum(1 for q in res if any(x['apur'] is not None and x['lim'] and x['apur'] > x['lim'] for x in q['linhas']))
    print('candidatas', len(ids), '· com quadro lido', len(res), '· com indicador acima do limite', viol)
    if acao != 'gravar':
        return
    cur.execute("""CREATE TABLE IF NOT EXISTS FATURA_CONTINUIDADE (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        base VARCHAR(10) NOT NULL, fatura_id VARCHAR(32) NOT NULL, indicador VARCHAR(8) NOT NULL,
        periodo CHAR(7) NULL, limite DECIMAL(10,2) NULL, apurado DECIMAL(10,2) NULL, vrc DECIMAL(14,2) NULL,
        fonte VARCHAR(40) NOT NULL, criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_cont (base, fatura_id, indicador), KEY ix_cont_fatura (base, fatura_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")
    linhas = [('energia', q['id'], x['ind'], q['ref'], x['lim'], x['apur'], q['vrc'], FONTE) for q in res for x in q['linhas']]
    for i in range(0, len(linhas), 2000):
        cur.executemany("""INSERT INTO FATURA_CONTINUIDADE (base, fatura_id, indicador, periodo, limite, apurado, vrc, fonte)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON DUPLICATE KEY UPDATE periodo=VALUES(periodo), limite=VALUES(limite),
            apurado=VALUES(apurado), vrc=VALUES(vrc), fonte=VALUES(fonte)""", linhas[i:i + 2000])
    con.commit()
    print('gravadas', len(linhas), 'linhas (', len(res), 'faturas )')


if __name__ == '__main__':
    main()
