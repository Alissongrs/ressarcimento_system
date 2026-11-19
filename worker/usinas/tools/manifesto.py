"""Manifesto das faturas de usinas (Thopen): uma linha por arquivo, com ID estável.

id_fatura = primeiros 16 hex do SHA-256 do conteúdo do PDF (mesmo PDF em duas pastas = mesmo id; cópia
"_unlocked" é outro arquivo → outro id, marcada como duplicata_de quando o texto da 1ª página é igual).
Junta os dados do "Índice das faturas.xlsx" (usina, cliente, distribuidora, UC, mês de geração, mês da fatura,
energia injetada, situação). Saída: C:/usinas_thopen/dados/manifesto.csv
"""
import csv, hashlib, os, re, sys
import fitz, openpyxl

BASE = r'C:\usinas_thopen\faturas_originais'
SAIDA = r'C:\usinas_thopen\dados\manifesto.csv'


def indice():
    wb = openpyxl.load_workbook(os.path.join(BASE, 'Índice das faturas.xlsx'), read_only=True)
    out = {}
    for r in list(wb['Índice'].iter_rows(values_only=True))[4:]:
        m = re.search(r'HYPERLINK\("([^"]+)"', str(r[13] or ''))
        if m:
            out[os.path.normcase(os.path.normpath(m.group(1)))] = r
    return out


def main():
    os.makedirs(os.path.dirname(SAIDA), exist_ok=True)
    idx = indice()
    linhas, primeira_pag = [], {}
    for raiz, _, arqs in os.walk(BASE):
        for a in sorted(arqs):
            if not a.lower().endswith('.pdf'):
                continue
            p = os.path.join(raiz, a)
            rel = os.path.relpath(p, BASE)
            dados = open(p, 'rb').read()
            fid = hashlib.sha256(dados).hexdigest()[:16]
            try:
                doc = fitz.open(stream=dados, filetype='pdf')
                pags = doc.page_count
                txt1 = re.sub(r'\s+', ' ', doc[0].get_text()).strip()[:3000] if pags else ''
                tem_texto = len(txt1) > 200
            except Exception as e:  # PDF protegido/corrompido
                pags, txt1, tem_texto = 0, '', False
            partes = rel.split(os.sep)
            r = idx.get(os.path.normcase(rel)) or ()
            g = lambda i: (r[i] if len(r) > i else None)
            chave_txt = hashlib.sha1(txt1.encode()).hexdigest() if txt1 else None
            dup = primeira_pag.get(chave_txt) if chave_txt else None
            if chave_txt and not dup:
                primeira_pag[chave_txt] = fid
            linhas.append({
                'id_fatura': fid, 'caminho': rel, 'pasta_usina': partes[0],
                'mes_geracao_pasta': partes[1] if len(partes) > 2 else '', 'arquivo': partes[-1],
                'paginas': pags, 'tem_texto': int(tem_texto), 'bytes': len(dados),
                'usina_indice': g(0), 'cliente_indice': g(2), 'distribuidora_indice': g(3), 'uc_indice': g(4),
                'mes_fatura_indice': g(6), 'energia_injetada_indice': g(9), 'situacao_indice': g(10),
                'duplicata_de': dup if dup and dup != fid else '',
            })
    with open(SAIDA, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=list(linhas[0].keys()), delimiter=';')
        w.writeheader()
        w.writerows(linhas)
    ids = {l['id_fatura'] for l in linhas}
    print(f'{len(linhas)} PDFs, {len(ids)} ids distintos, {sum(1 for l in linhas if l["duplicata_de"])} duplicatas por texto, '
          f'{sum(l["paginas"] for l in linhas)} páginas, {sum(1 for l in linhas if not l["tem_texto"])} sem texto')


if __name__ == '__main__':
    sys.exit(main())
