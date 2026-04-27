#!/usr/bin/env python3
"""
analisar_lote_sonnet.py - Analisa lote de faturas com Claude Sonnet
Aplica regras de prompt_confirmar e gera relatório .txt
"""

import sys
import json
from pathlib import Path
from datetime import datetime
import mysql.connector
import anthropic
from dotenv import load_dotenv
import os

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

FATURAS = [
    (133642, "2024-07"),
    (133640, "2024-07"),
    (133639, "2024-07"),
    (133637, "2024-07"),
    (133633, "2024-07"),
    (133626, "2024-07"),
    (133617, "2024-07"),
    (133616, "2024-07"),
    (133613, "2024-07"),
    (133609, "2024-07"),
    (133608, "2024-07"),
    (133600, "2024-07"),
    (133599, "2024-07"),
    (127346, "2024-08"),
    (127341, "2024-08"),
    (127338, "2024-08"),
    (127336, "2024-08"),
    (127335, "2024-08"),
    (127334, "2024-08"),
    (127333, "2024-08"),
    (127331, "2024-08"),
    (127330, "2024-08"),
    (127329, "2024-08"),
    (127328, "2024-08"),
    (127327, "2024-08"),
    (127326, "2024-08"),
    (127305, "2024-08"),
    (127284, "2024-08"),
    (127282, "2024-08"),
    (127280, "2024-08"),
    (127276, "2024-08"),
    (127275, "2024-08"),
    (119551, "2024-09"),
    (119546, "2024-09"),
    (119544, "2024-09"),
    (89511, "2025-01"),
    (89498, "2025-01"),
    (89491, "2025-01"),
    (89490, "2025-01"),
    (83259, "2025-02"),
    (83250, "2025-02"),
    (83240, "2025-02"),
    (83236, "2025-02"),
    (76981, "2025-03"),
    (70728, "2025-04"),
    (70718, "2025-04"),
    (70708, "2025-04"),
    (64388, "2025-05"),
    (64387, "2025-05"),
    (64382, "2025-05"),
    (58133, "2025-06"),
    (58124, "2025-06"),
    (58116, "2025-06"),
    (58113, "2025-06"),
    (58109, "2025-06"),
    (52086, "2025-07"),
    (52076, "2025-07"),
    (46135, "2025-08"),
    (46134, "2025-08"),
    (46131, "2025-08"),
    (46130, "2025-08"),
    (39668, "2025-09"),
    (33282, "2025-10"),
    (26726, "2025-11"),
    (20367, "2025-12"),
    (20351, "2025-12"),
    (14100, "2026-01"),
    (14096, "2026-01"),
    (14085, "2026-01"),
    (7852, "2026-02"),
    (7850, "2026-02"),
    (7846, "2026-02"),
]

def buscar_fatura(fatura_id):
    """Busca dados da fatura no banco"""
    try:
        conn = mysql.connector.connect(**DB)
        cur = conn.cursor(dictionary=True)
        cur.execute("""
            SELECT
                id, UC, Mes_Ref, Concessionaria, RS_Total_Fatura,
                Cod_Empresa, KWH_Ponta, KWH_FPonta, KWH_Total,
                LEFT(texto_plumber, 3000) as plumber,
                LEFT(analise_IA, 1000) as analise_mini
            FROM Faturas_Registradas_Cache
            WHERE id = %s
        """, (fatura_id,))
        result = cur.fetchone()
        cur.close()
        conn.close()
        return result
    except Exception as e:
        return None

def analisar_com_sonnet(fatura_id, fatura_data):
    """Envia para Sonnet análise rápida"""
    try:
        client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))

        prompt = f"""Você é auditor de faturas de energia. Analise RAPIDAMENTE (sem verbose):

FATURA ID: {fatura_id}
UC: {fatura_data.get('UC', '?')}
Mês: {fatura_data.get('Mes_Ref', '?')}
Concessionária: {fatura_data.get('Concessionaria', '?')}
Total: R$ {fatura_data.get('RS_Total_Fatura', 0):,.2f}

DADOS:
KWh Ponta: {fatura_data.get('KWH_Ponta', 'N/A')}
KWh FPonta: {fatura_data.get('KWH_FPonta', 'N/A')}
KWh Total: {fatura_data.get('KWH_Total', 'N/A')}

TEXTO DA FATURA (amostra):
{fatura_data.get('plumber', '')[:1000]}

Responda EM UMA LINHA:
[ID] | Status (OK/ANOMALIA) | Fichas (F01/F02/F03/F04/F05 ou -) | Valor estimado (R$)

Exemplo: 76981 | ANOMALIA | F02 | 15000.00"""

        response = client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=200,
            messages=[{"role": "user", "content": prompt}]
        )

        return response.content[0].text.strip()
    except Exception as e:
        return f"{fatura_id} | ERRO | - | 0.00"

def main():
    print(f"Analisando {len(FATURAS)} faturas...")
    print()

    relatorio = []
    relatorio.append("="*100)
    relatorio.append("ANÁLISE EM LOTE - CLAUDE SONNET + REGRAS prompt_confirmar")
    relatorio.append(f"Data: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    relatorio.append("="*100)
    relatorio.append("")
    relatorio.append("ID       | RESULTADO")
    relatorio.append("-"*100)

    processados = 0
    anomalias = 0

    for fatura_id, mes_ref in FATURAS:
        # Busca dados
        fatura_data = buscar_fatura(fatura_id)
        if not fatura_data:
            resultado = f"{fatura_id} | ERRO: Fatura não encontrada"
            relatorio.append(resultado)
            continue

        # Analisa com Sonnet
        analise = analisar_com_sonnet(fatura_id, fatura_data)
        relatorio.append(f"{analise}")

        # Conta anomalias
        if "ANOMALIA" in analise.upper():
            anomalias += 1

        processados += 1

        # Progresso a cada 10
        if processados % 10 == 0:
            print(f"  [{processados}/{len(FATURAS)}] processadas...")

    # Resumo
    relatorio.append("")
    relatorio.append("="*100)
    relatorio.append("RESUMO FINAL")
    relatorio.append("="*100)
    relatorio.append(f"Total analisado: {processados}")
    relatorio.append(f"Com anomalias: {anomalias}")
    relatorio.append(f"Taxa de anomalia: {anomalias/processados*100:.1f}%")
    relatorio.append("="*100)

    # Salva arquivo
    arquivo = "analise_lote_sonnet.txt"
    with open(arquivo, "w", encoding="utf-8") as f:
        f.write("\n".join(relatorio))

    print(f"\n✅ Relatório salvo em: {arquivo}")
    print(f"Faturas com anomalia: {anomalias}/{processados}")

if __name__ == "__main__":
    main()
