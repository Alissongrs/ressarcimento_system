#!/usr/bin/env python3
"""
Extrai ressarcimento de todos os 497 casos CONFIRMADO pela 4.1-mini
Analisa dados de fatura e calcula valor correto
"""

import json
import re
from pathlib import Path
from dotenv import load_dotenv
import mysql.connector

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

def extrair_valor_art323(texto):
    """Extrai valor de refaturamento Art. 323"""
    if not texto:
        return 0.0

    # Procura por "CONS.ATIVO-REN" ou "ART.323" ou "ART323"
    padrao_art323 = r'CONS\.ATIVO[^\n]*REN\s*1000[^\n]*ART\.?323[^\n]*?(\d{1,5}[.,]\d{2,3})'
    matches = re.findall(padrao_art323, texto, re.IGNORECASE)

    if matches:
        # Pega o primeiro valor encontrado
        valor_str = matches[-1].replace(',', '.')
        try:
            return float(valor_str)
        except:
            pass

    # Tenta procurar por "ABATIMENTO PARCELAMENTO ART323" ou padrão similar
    padrao_abatimento = r'ABATIMENTO\s+PARCELAMENTO\s+ART(?:\s*\.?\s*)?323\s+(-?\d{1,5}[.,]\d{2,3})'
    match_abat = re.search(padrao_abatimento, texto, re.IGNORECASE)
    if match_abat:
        valor_str = match_abat.group(1).replace(',', '.')
        try:
            return float(valor_str)
        except:
            pass

    return 0.0

def extrair_valor_revisao(texto):
    """Extrai valores de revisão/refaturamento geral"""
    if not texto:
        return 0.0

    # Procura por linhas de revisão ou faturamento anterior
    padrao_revisao = r'(?:revisao|revis[ã]o|faturamento.*(?:anterior|complementar)|fatura.*menor)[^\n]*?(\d{1,5}[.,]\d{2,3})'
    matches = re.findall(padrao_revisao, texto, re.IGNORECASE)

    if matches:
        valor_str = matches[-1].replace(',', '.')
        try:
            return float(valor_str)
        except:
            pass

    return 0.0

def extrair_kwh_art323(texto):
    """Extrai quantidade de kWh em Art. 323"""
    if not texto:
        return 0.0

    # Procura por "13.698" ou padrões similares após REN 1000-ART.323
    padrao_kwh = r'(?:CONS\.ATIVO[^\n]*REN.*ART\.?323|ART\.?323.*REN)[^\n]*?(\d{1,5}[.,]\d{1,3})\s*(?:KWH|kWh)'
    matches = re.findall(padrao_kwh, texto, re.IGNORECASE)

    if matches:
        valor_str = matches[-1].replace('.', '').replace(',', '.')
        try:
            return float(valor_str)
        except:
            pass

    return 0.0

def main():
    print("\n" + "="*100)
    print("EXTRAÇÃO DE RESSARCIMENTO - 497 CASOS CONFIRMADO")
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
    """)

    registros = cur.fetchall()
    total = len(registros)

    print(f"📊 Total de registros CONFIRMADO: {total}")
    print()

    relatorio = []
    relatorio.append("ID       | UC              | MÊS      | CONCESSIONÁRIA         | TOTAL FATURA | FICHAS      | VALOR ESTIMADO (R$)")
    relatorio.append("-" * 120)

    com_valor = 0
    total_ressarcimento = 0.0

    for i, reg in enumerate(registros, 1):
        fid = reg['id']
        texto = reg['texto_plumber'] or ""
        fichas = reg['fichas'] or []

        # Tenta extrair valor
        valor_art323 = extrair_valor_art323(texto)
        valor_revisao = extrair_valor_revisao(texto)
        valor_final = max(valor_art323, valor_revisao)

        if valor_final > 0:
            com_valor += 1
            total_ressarcimento += valor_final

        fichas_str = ",".join(fichas) if fichas else "-"
        mes_ref = reg['Mes_Ref'][:7] if reg['Mes_Ref'] else "?"

        linha = f"{fid:<8} | {reg['UC']:<15} | {mes_ref} | {reg['Concessionaria']:<22} | R$ {reg['RS_Total_Fatura']:>10,.2f} | {fichas_str:<11} | R$ {valor_final:>10,.2f}"
        relatorio.append(linha)

        if i % 50 == 0:
            print(f"  [{i}/{total}] processadas... ({com_valor} com valor)")

    relatorio.append("")
    relatorio.append("="*120)
    relatorio.append(f"RESUMO: {com_valor}/{total} com ressarcimento estimado")
    relatorio.append(f"Total ressarcimento identificado: R$ {total_ressarcimento:,.2f}")
    relatorio.append(f"Média por fatura com ressarcimento: R$ {total_ressarcimento/max(com_valor,1):,.2f}")
    relatorio.append("="*120)

    # Salva
    arquivo = "ressarcimento_confirmados_extraido.txt"
    with open(arquivo, "w", encoding="utf-8") as f:
        f.write("\n".join(relatorio))

    cur.close()
    conn.close()

    print(f"\n✅ Relatório salvo em: {arquivo}")
    print(f"📊 Resumo:")
    print(f"   - Total analisado: {total}")
    print(f"   - Com ressarcimento: {com_valor} ({com_valor/total*100:.1f}%)")
    print(f"   - Total: R$ {total_ressarcimento:,.2f}")
    print(f"   - Média: R$ {total_ressarcimento/max(com_valor,1):,.2f}")

if __name__ == "__main__":
    main()
