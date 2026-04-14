"""
Prepara o template DOCX de Ouvidoria inserindo placeholders {{...}} no XML.
Execute uma vez para gerar data/template/template_ouvidoria.docx.

Usage:
    cd backend
    python ia/prepare_docx_template.py
"""

import zipfile
import os
import io
import re
import shutil

SRC = os.path.join("data", "template", "CEMIG - Ouvidoria.docx")
DST = os.path.join("data", "template", "template_ouvidoria.docx")


def patch_document_xml(xml: str) -> str:
    # ── 1. Data (4 runs separados → 1 run com {{DATA}}) ──────────────────────
    # Captura desde o texto "09 " até o fechamento do último run "de 2024"
    date_pattern = re.compile(
        r'(<w:t[^>]*>)09 </w:t></w:r>'          # run 1: "09 "
        r'.*?'                                    # rPr do run 2
        r'<w:t[^>]*>de </w:t></w:r>'             # run 2: "de "
        r'.*?'                                    # rPr do run 3
        r'<w:t[^>]*>Dezembro </w:t></w:r>'        # run 3: "Dezembro "
        r'.*?'                                    # rPr do run 4
        r'<w:t[^>]*>de 2024</w:t>',              # run 4: "de 2024"
        re.DOTALL,
    )
    # Substitui todo o bloco pelo placeholder no primeiro run
    xml = date_pattern.sub(r'\g<1>{{DATA}}</w:t>', xml, count=1)

    # ── 2. Cliente ────────────────────────────────────────────────────────────
    xml = xml.replace('<w:t>CLARO SA</w:t>', '<w:t>{{CLIENTE}}</w:t>')

    # ── 3. Unidade Consumidora ────────────────────────────────────────────────
    xml = xml.replace('<w:t>3011982659</w:t>', '<w:t>{{UC}}</w:t>')

    # ── 4. Número de protocolo ────────────────────────────────────────────────
    xml = xml.replace('<w:t>1005172380</w:t>', '<w:t>{{PROTOCOLO}}</w:t>')

    # ── 5. Número de referência ───────────────────────────────────────────────
    xml = xml.replace('<w:t>4077736821</w:t>', '<w:t>{{REFERENCIA}}</w:t>')

    return xml


def build_patched_docx(src_path: str, dst_path: str) -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(src_path, "r") as zin, zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/document.xml":
                xml = data.decode("utf-8")
                xml = patch_document_xml(xml)
                data = xml.encode("utf-8")
            zout.writestr(item, data)

    with open(dst_path, "wb") as f:
        f.write(buf.getvalue())
    print(f"Template gerado: {dst_path}")


if __name__ == "__main__":
    if not os.path.exists(SRC):
        raise FileNotFoundError(f"Template original não encontrado: {SRC}")
    build_patched_docx(SRC, DST)

    # Verificação rápida
    with zipfile.ZipFile(DST) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    placeholders = ["{{DATA}}", "{{CLIENTE}}", "{{UC}}", "{{PROTOCOLO}}", "{{REFERENCIA}}"]
    for ph in placeholders:
        found = ph in xml
        print(f"  {'OK' if found else 'FALTANDO'}: {ph}")
