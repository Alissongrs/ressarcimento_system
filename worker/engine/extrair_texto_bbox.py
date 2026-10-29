"""Reordena o text-layer de PDFs por bbox (linha-real).

Problema: PyMuPDF/pdfplumber leem PDFs em ordem de stream, que muitas vezes é
"coluna a coluna" — cada célula de uma tabela vira uma linha separada. Resultado:
um item "Consumo HFP MW 114,759 386,77 44.385,90" aparece como 5 linhas verticais
e quebra qualquer regex que espere "tudo na mesma linha".

Solução: ler spans com `page.get_text("dict")`, agrupar por Y (tolerância em pontos)
e ordenar dentro de cada linha por X. Resultado: linhas reconstruídas como lidas
visualmente.

Uso:
    from extrair_texto_bbox import extrair_texto_bbox_ordenado
    texto = extrair_texto_bbox_ordenado(pdf_bytes, y_tol=3.0, x_gap=" ")

Testado em Via Varejo (Light ACL) e Energisa MT — reconstrói itens de tabela
mantendo descrição+unidade+qtd+tarifa+valor numa mesma linha.
"""
from __future__ import annotations
import io
from typing import Tuple

import fitz  # PyMuPDF


def extrair_texto_bbox_ordenado(
    pdf_bytes: bytes,
    *,
    y_tol: float = 3.0,
    x_gap: str = " ",
    page_sep: str = "\n",
) -> str:
    """Lê PDF e devolve texto com linhas reagrupadas por coordenada Y.

    Args:
        pdf_bytes: bytes do PDF.
        y_tol: tolerância em pontos pra considerar 2 spans "na mesma linha".
               3.0 funciona pra fontes de 7-10pt. Aumente se linha tiver entrelinha grande.
        x_gap: separador entre spans da mesma linha (default 1 espaço).
        page_sep: separador entre páginas.

    Returns:
        Texto com linhas reconstruídas. Vazio se PDF não tem text-layer.
    """
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception:
        return ""

    paginas: list[str] = []
    try:
        for page in doc:
            d = page.get_text("dict")
            spans: list[tuple[float, float, str]] = []
            for block in d.get("blocks", []):
                if block.get("type") != 0:  # 0 = texto, 1 = imagem
                    continue
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        txt = (span.get("text") or "").strip()
                        if not txt:
                            continue
                        x0, y0, x1, y1 = span.get("bbox", (0, 0, 0, 0))
                        # Usa o centro Y (média) — mais estável que o topo
                        yc = (y0 + y1) / 2
                        spans.append((yc, x0, txt))

            if not spans:
                continue

            # Agrupa por Y (cluster greedy: novo span entra na linha aberta se |yc - y_linha| <= y_tol)
            spans.sort(key=lambda s: (s[0], s[1]))
            linhas: list[list[tuple[float, str]]] = []
            y_ref = None
            for yc, x0, txt in spans:
                if y_ref is None or abs(yc - y_ref) > y_tol:
                    linhas.append([(x0, txt)])
                    y_ref = yc
                else:
                    linhas[-1].append((x0, txt))
                    # Atualiza y_ref pra média móvel — evita drift em linhas com sub/sobrescrita
                    y_ref = (y_ref + yc) / 2

            # Ordena cada linha por X e junta
            linhas_txt = [
                x_gap.join(t for _, t in sorted(itens, key=lambda p: p[0]))
                for itens in linhas
            ]
            paginas.append("\n".join(linhas_txt))
    finally:
        doc.close()

    return page_sep.join(paginas)


def diagnosticar(pdf_bytes: bytes) -> dict:
    """Compara extração nativa vs reordenada — útil pra A/B test."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        nativo = "\n".join(p.get_text() for p in doc)
    finally:
        doc.close()
    ordenado = extrair_texto_bbox_ordenado(pdf_bytes)
    return {
        "nativo_chars": len(nativo),
        "ordenado_chars": len(ordenado),
        "nativo_linhas": nativo.count("\n") + 1,
        "ordenado_linhas": ordenado.count("\n") + 1,
        "nativo_preview": nativo[:500],
        "ordenado_preview": ordenado[:500],
    }


if __name__ == "__main__":
    import sys, requests, json
    if len(sys.argv) < 2:
        print("Uso: python extrair_texto_bbox.py <url_pdf_ou_arquivo>")
        sys.exit(1)
    src = sys.argv[1]
    if src.startswith("http"):
        b = requests.get(src, timeout=30).content
    else:
        with open(src, "rb") as f:
            b = f.read()
    d = diagnosticar(b)
    print(f"NATIVO:   {d['nativo_chars']} chars / {d['nativo_linhas']} linhas")
    print(f"ORDENADO: {d['ordenado_chars']} chars / {d['ordenado_linhas']} linhas")
    print("\n=== NATIVO (primeiros 500) ===")
    print(d["nativo_preview"])
    print("\n=== ORDENADO (primeiros 500) ===")
    print(d["ordenado_preview"])
    if len(sys.argv) > 2 and sys.argv[2] == "--full":
        print("\n=== ORDENADO COMPLETO ===")
        print(extrair_texto_bbox_ordenado(b))
