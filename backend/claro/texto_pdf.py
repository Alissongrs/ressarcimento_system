# -*- coding: utf-8 -*-
"""Texto do PDF para a extração da Claro (backend/claro).

Mesmo código de pdf_pipeline.extrair_plumber (texto do pdfplumber, página a página), sem importar o
pdf_pipeline — ele tem as conexões dos bancos escritas no arquivo e por isso fica fora do Git.
A extração da Claro só usa o texto; os "campos" do plumber não são usados (volta um dicionário vazio).
"""
import io
import logging

import pdfplumber

log = logging.getLogger("claro.texto_pdf")


def extrair_plumber(pdf_bytes: bytes):
    linhas = []
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                txt = page.extract_text() or ""
                linhas.extend(txt.splitlines())
    except Exception as e:
        log.warning(f"    pdfplumber texto: {e}")
        return "", {}
    if not linhas:
        return "", {}
    return "\n".join(linhas), {}


def extrair_markdown(pdf_bytes: bytes) -> str:
    # só o lote de teste do _fase1_pipeline usa; a extração da Claro não precisa
    return ""
