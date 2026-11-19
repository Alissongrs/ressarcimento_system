"""Classifica cada PDF do manifesto pela distribuidora, lendo o texto embutido (sem OCR).
Saída: C:/usinas_thopen/dados/classificacao.csv (id_fatura;dist;tem_texto)."""
import csv, os, re, sys
import fitz
BASE = r'C:\usinas_thopen'
REGRAS = [  # (sigla, padrões no texto da 1ª página)
    ('COPEL', [r'04\.368\.898/0001-06', r'COPEL\s+DISTRIBUI']),
    ('CELESC', [r'08\.336\.783/0001-90', r'CELESC\s+DISTRIBUI']),
    ('NEOENERGIA ELEKTRO', [r'02\.328\.280/0001-97', r'ELEKTRO\s+REDES']),
]

def dist(texto):
    for sigla, pads in REGRAS:
        if any(re.search(p, texto, re.I) for p in pads):
            return sigla
    return 'OUTRA'

def main():
    man = list(csv.DictReader(open(os.path.join(BASE, 'dados', 'manifesto.csv'), encoding='utf-8-sig'), delimiter=';'))
    out = []
    for r in man:
        p = os.path.join(BASE, 'faturas_originais', r['caminho'])
        try:
            with fitz.open(p) as d:
                t = d[0].get_text() if len(d) else ''
        except Exception:
            t = ''
        out.append((r['id_fatura'], dist(t) if t.strip() else 'SEM_TEXTO', int(bool(t.strip()))))
    with open(os.path.join(BASE, 'dados', 'classificacao.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f, delimiter=';'); w.writerow(['id_fatura', 'dist', 'tem_texto']); w.writerows(out)
    from collections import Counter
    print(Counter(x[1] for x in out))

if __name__ == '__main__':
    main()
