#!/usr/bin/env python3
"""
analisar_sonnet.py - Analisa uma fatura específica com Claude Sonnet + Regras de Prompt
"""

import argparse
import base64
import io
import json
import os
import sys
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

import requests
try:
    import pypdfium2 as pdfium
    HAS_PDFIUM = True
except:
    HAS_PDFIUM = False

import mysql.connector
import anthropic

# Config
ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "")
DB = dict(
    host="db-acesso-ressarcimento.cvicxzrqb58o.us-east-2.rds.amazonaws.com",
    port=3306,
    user="super_user_ressarcimento",
    password="qZ8YbD3GxK9uN4RmV2sAeT7LwBjCp5X0",
    database="db_ressarcimento",
    charset="utf8mb4",
    connection_timeout=60,
    use_pure=True,
    ssl_disabled=True,
)

def carregar_prompt():
    """Carrega prompt_confirmar.txt"""
    p = Path(__file__).parent.parent / "backend" / "data" / "prompt_confirmar.txt"
    if p.exists():
        return p.read_text(encoding="utf-8")
    return ""

def pdf_para_imagens(url):
    """Baixa PDF e converte em imagens base64"""
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        pdf_bytes = r.content

        if not HAS_PDFIUM:
            return [], ""

        pdf = pdfium.PdfDocument(pdf_bytes)
        imagens = []

        for i in range(min(len(pdf), 4)):
            page = pdf[i]
            bitmap = page.render(scale=2.0)
            pil_img = bitmap.to_pil()
            buf = io.BytesIO()
            pil_img.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode()
            imagens.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": b64
                }
            })

        return imagens, pdf_bytes
    except Exception as e:
        print(f"Erro ao baixar PDF: {e}")
        return [], b""

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("fatura_id", type=int, help="ID da fatura")
    args = parser.parse_args()

    # Busca fatura
    try:
        conn = mysql.connector.connect(**DB)
        cur = conn.cursor(dictionary=True)
        cur.execute("""
            SELECT id, Link, UC, Mes_Ref, Concessionaria, RS_Total_Fatura,
                   analise_IA
            FROM Faturas_Registradas_Cache
            WHERE id = %s
        """, (args.fatura_id,))
        fatura = cur.fetchone()
        cur.close()
        conn.close()
    except Exception as e:
        print(f"Erro ao buscar fatura: {e}")
        return 1

    if not fatura:
        print(f"Fatura {args.fatura_id} não encontrada")
        return 1

    print(f"\n{'='*80}")
    print(f"Fatura: {fatura['id']} | UC: {fatura['UC']} | {fatura['Concessionaria']}")
    print(f"Mês: {fatura['Mes_Ref']} | Total: R$ {fatura['RS_Total_Fatura']:,.2f}")
    print('='*80)

    # Baixa PDF e imagens
    print("Baixando PDF...")
    imagens, pdf_bytes = pdf_para_imagens(fatura['Link'])
    print(f"OK: {len(imagens)} páginas")

    # Carrega prompt
    prompt_confirmar = carregar_prompt()
    print(f"\nPrompt carregado: {len(prompt_confirmar)} caracteres")

    # Monta contexto
    contexto = f"""
FATURA A ANALISAR:
ID: {fatura['id']}
UC: {fatura['UC']}
Mês: {fatura['Mes_Ref']}
Concessionária: {fatura['Concessionaria']}
Total a Pagar: R$ {fatura['RS_Total_Fatura']:,.2f}

ANÁLISE ANTERIOR (gpt-4.1-mini):
{fatura['analise_IA'][:2000] if fatura['analise_IA'] else 'Nenhuma análise anterior'}
"""

    # Chama Sonnet
    print("\nAnalisando com Claude Sonnet...")

    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

    content_blocks = [
        {"type": "text", "text": prompt_confirmar},
        {"type": "text", "text": "CONTEXTO DA FATURA:\n" + contexto}
    ]

    # Adiciona imagens se disponíveis
    if imagens:
        content_blocks.append({"type": "text", "text": "\nFATURA (imagens PDF anexadas):"})
        content_blocks.extend(imagens)

    try:
        response = client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=2048,
            messages=[
                {
                    "role": "user",
                    "content": content_blocks
                }
            ]
        )

        resultado = response.content[0].text

        print(f"\n{'='*80}")
        print("RESULTADO - CLAUDE SONNET:")
        print('='*80)
        print(resultado)
        print('='*80)

        return 0

    except Exception as e:
        print(f"Erro ao chamar API: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(main())
