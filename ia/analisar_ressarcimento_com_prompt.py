#!/usr/bin/env python3
"""
analisar_ressarcimento_com_prompt.py
Aplica prompt otimizado com cálculo de ressarcimento aos 497 CONFIRMADO
"""

import sys
import json
from pathlib import Path
from datetime import datetime
import mysql.connector
import anthropic
from dotenv import load_dotenv
import os
import re

load_dotenv(Path(__file__).parent / ".env")

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

PROMPT_RESSARCIMENTO = Path(__file__).parent / "prompt_confirmar_com_ressarcimento.txt"

def carregar_prompt_ressarcimento():
    """Carrega o novo prompt otimizado"""
    if PROMPT_RESSARCIMENTO.exists():
        return PROMPT_RESSARCIMENTO.read_text(encoding="utf-8")
    return ""

def extrair_valor_resposta(texto_resposta):
    """Extrai o valor de ressarcimento da resposta"""
    # Procura por padrão: "número | número | fichas | R$ xxx,xx"
    # Última coluna é o ressarcimento
    linhas = texto_resposta.strip().split('\n')
    if linhas:
        ultima_linha = linhas[-1]
        # Procura por padrão monetário R$ xxx,xx
        match = re.search(r'R\$\s*([\d.,]+)', ultima_linha)
        if match:
            valor_str = match.group(1).replace('.', '').replace(',', '.')
            try:
                return float(valor_str)
            except:
                pass
    return 0.0

def analisar_com_sonnet(fatura_id, uc, valor_total, texto_fatura):
    """Envia para Sonnet análise com cálculo de ressarcimento"""
    try:
        client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
        prompt_base = carregar_prompt_ressarcimento()

        prompt = f"""{prompt_base}

FATURA A ANALISAR:
─────────────────────────────────────────────────────────────────────────────
ID: {fatura_id}
UC: {uc}
Valor Total: R$ {valor_total:,.2f}

TEXTO DA FATURA (primeiros 4000 caracteres):
─────────────────────────────────────────────────────────────────────────────
{texto_fatura[:4000]}

RESPONDA APENAS COM UMA LINHA NO FORMATO:
{fatura_id} | {uc} | FICHAS | {valor_total:,.2f} | RESSARCIMENTO_ESTIMADO | Observação
"""

        response = client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}]
        )

        resultado = response.content[0].text.strip()
        return resultado
    except Exception as e:
        return f"{fatura_id} | {uc} | ERRO | {valor_total:,.2f} | 0,00 | {str(e)[:50]}"

def main():
    print("\n" + "="*100)
    print("ANÁLISE DE RESSARCIMENTO COM PROMPT OTIMIZADO")
    print("Aplicando cálculo automático aos 497 CONFIRMADO")
    print(f"Data: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("="*100)

    try:
        conn = mysql.connector.connect(**DB)
        cur = conn.cursor(dictionary=True)
    except Exception as e:
        print(f"❌ Erro ao conectar: {e}")
        return

    # Busca todos os CONFIRMADO
    cur.execute("""
        SELECT
            id, UC, Mes_Ref, Concessionaria, RS_Total_Fatura,
            JSON_EXTRACT(analise_IA, '$.resultado.ia_fichas_confirmadas') as fichas,
            texto_plumber
        FROM Faturas_Registradas_Cache
        WHERE Cod_Empresa = 14
          AND JSON_EXTRACT(analise_IA, '$.resultado.ia_status') = 'CONFIRMADO'
        ORDER BY RS_Total_Fatura DESC
        LIMIT 20  -- Começar com 20 para teste
    """)

    registros = cur.fetchall()
    total = len(registros)

    print(f"\n📊 Analisando os {total} maiores CONFIRMADO...")
    print()

    relatorio = []
    relatorio.append("ID       | UC              | FICHAS      | VALOR (R$)  | RESSARCIMENTO (R$) | OBSERVAÇÃO")
    relatorio.append("-" * 110)

    total_valor = 0.0
    total_ressarcimento = 0.0
    processados = 0
    erros = 0

    for i, reg in enumerate(registros, 1):
        fid = reg['id']
        uc = reg['UC']
        valor = reg['RS_Total_Fatura']
        fichas = reg['fichas'] or []
        texto = reg['texto_plumber'] or ""

        # Análise
        resultado = analisar_com_sonnet(fid, uc, valor, texto)

        # Tenta extrair ressarcimento
        valor_ressarcimento = extrair_valor_resposta(resultado)

        fichas_str = ",".join(fichas) if fichas else "-"

        relatorio.append(f"{fid:<8} | {uc:<15} | {fichas_str:<11} | R$ {valor:>10,.2f} | R$ {valor_ressarcimento:>16,.2f} | ✓")

        total_valor += valor
        total_ressarcimento += valor_ressarcimento
        processados += 1

        if i % 5 == 0:
            print(f"  [{i}/{total}] processadas... Ressarcimento acumulado: R$ {total_ressarcimento:,.2f}")

    relatorio.append("")
    relatorio.append("="*110)
    relatorio.append(f"RESUMO: {processados} faturas analisadas")
    relatorio.append(f"Total em questão: R$ {total_valor:,.2f}")
    relatorio.append(f"Total ressarcimento estimado: R$ {total_ressarcimento:,.2f}")
    relatorio.append(f"Taxa média: {(total_ressarcimento/total_valor*100) if total_valor > 0 else 0:.1f}%")
    relatorio.append("="*110)

    # Salva
    arquivo = f"analise_ressarcimento_resultado_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
    with open(arquivo, "w", encoding="utf-8") as f:
        f.write("\n".join(relatorio))

    cur.close()
    conn.close()

    print(f"\n✅ Análise concluída!")
    print(f"📊 Resultado:")
    print(f"   - Faturas analisadas: {processados}")
    print(f"   - Total em questão: R$ {total_valor:,.2f}")
    print(f"   - Ressarcimento estimado: R$ {total_ressarcimento:,.2f}")
    print(f"   - Taxa: {(total_ressarcimento/total_valor*100) if total_valor > 0 else 0:.1f}%")
    print(f"\n📄 Resultado salvo em: {arquivo}")

if __name__ == "__main__":
    main()
