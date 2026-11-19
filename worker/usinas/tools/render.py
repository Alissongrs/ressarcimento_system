"""Renderiza as páginas de uma fatura em PNG para a leitura visual.

Uso: python C:/usinas_thopen/tools/render.py <id_fatura> [dpi]
Lê o caminho no manifesto, grava C:/usinas_thopen/png/<id_fatura>/p1.png, p2.png… e imprime os caminhos.
dpi padrão 150 (tabelas pequenas ficam legíveis); use 200 para conferir números miúdos.
"""
import csv, os, sys
import fitz

BASE = r'C:\usinas_thopen\faturas_originais'
MANIF = r'C:\usinas_thopen\dados\manifesto.csv'
PNG = r'C:\usinas_thopen\png'

fid = sys.argv[1]
dpi = int(sys.argv[2]) if len(sys.argv) > 2 else 150
with open(MANIF, encoding='utf-8-sig') as f:
    linha = next((l for l in csv.DictReader(f, delimiter=';') if l['id_fatura'] == fid), None)
if not linha:
    sys.exit(f'id {fid} não está no manifesto')
dest = os.path.join(PNG, fid)
os.makedirs(dest, exist_ok=True)
doc = fitz.open(os.path.join(BASE, linha['caminho']))
for i, pg in enumerate(doc):
    alvo = os.path.join(dest, f'p{i + 1}.png')
    if not os.path.exists(alvo) or dpi != 150:
        pg.get_pixmap(dpi=dpi).save(alvo)
    print(alvo)
