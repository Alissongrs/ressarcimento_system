#!/usr/bin/env python3
"""
relatorio_confirmados.py
────────────────────────
Gera relatório das faturas confirmadas com gpt-5.4.

Uso:
    python relatorio_confirmados.py                    # todas
    python relatorio_confirmados.py --empresa 14       # empresa 14
    python relatorio_confirmados.py --limite 50        # últimas 50
    python relatorio_confirmados.py --empresa 14 --csv resultado.csv
"""

import argparse
import json
import sys
from pathlib import Path
from dotenv import load_dotenv
import mysql.connector

load_dotenv(Path(__file__).parent / ".env")

# ─── Banco ────────────────────────────────────────────────────────────────────
DB_APP = dict(
    host               = "db-acesso-ressarcimento.cvicxzrqb58o.us-east-2.rds.amazonaws.com",
    port               = 3306,
    user               = "super_user_ressarcimento",
    password           = "qZ8YbD3GxK9uN4RmV2sAeT7LwBjCp5X0",
    database           = "db_ressarcimento",
    charset            = "utf8mb4",
    connection_timeout = 60,
    use_pure           = True,
    ssl_disabled       = True,
)

def main():
    parser = argparse.ArgumentParser(description="Relatório de confirmados com gpt-5.4")
    parser.add_argument("--empresa", type=int, help="ID da empresa")
    parser.add_argument("--limite", type=int, help="Máximo de registros")
    parser.add_argument("--csv", help="Salvar em arquivo CSV")
    args = parser.parse_args()

    # Conecta ao banco
    try:
        conn = mysql.connector.connect(**DB_APP)
        cur = conn.cursor(dictionary=True)
    except Exception as e:
        print(f"❌ Erro de conexão: {e}")
        return 1

    # Busca dados
    sql = """
        SELECT
            frc.id,
            frc.UC,
            frc.Mes_Ref,
            frc.Concessionaria,
            frc.RS_Total_Fatura,
            frc.analise_IA,
            frc.resultado_analises,
            frc.resultado_final_em,
            fac.ia_status as status_fichas
        FROM Faturas_Registradas_Cache frc
        LEFT JOIN fichas_anomalias_cache fac ON frc.id = fac.id
        WHERE frc.resultado_final_em IS NOT NULL
          AND frc.resultado_analises LIKE '%gpt-5.4%'
    """
    params = []

    if args.empresa:
        sql += " AND frc.Cod_Empresa = %s"
        params.append(args.empresa)

    sql += " ORDER BY frc.resultado_final_em DESC"

    if args.limite:
        sql += f" LIMIT {args.limite}"

    cur.execute(sql, params)
    registros = cur.fetchall()

    if not registros:
        print("❌ Nenhum registro encontrado com resultado_final_em preenchido")
        return 1

    print(f"\n{'='*100}")
    print(f"RELATÓRIO: {len(registros)} fatura(s) confirmada(s) com gpt-5.4")
    print('='*100)

    dados_csv = []
    total_ressarcimento = 0

    for i, reg in enumerate(registros, 1):
        fid = reg['id']
        uc = reg['UC']
        mes = str(reg['Mes_Ref'])[:7] if reg['Mes_Ref'] else '—'
        concessionaria = reg['Concessionaria'] or '—'
        total_fatura = float(reg['RS_Total_Fatura'] or 0)

        # Parse dos JSONs
        analise_mini_wrapper = {}
        analise_mini = {}
        try:
            analise_mini_wrapper = json.loads(reg['analise_IA'] or '{}')
            if 'resultado' in analise_mini_wrapper:
                analise_mini = analise_mini_wrapper['resultado']
                if isinstance(analise_mini, str):
                    try:
                        analise_mini = json.loads(analise_mini)
                    except:
                        analise_mini = {}
        except:
            pass

        resultado_gpt5_wrapper = {}
        resultado_gpt5 = {}
        try:
            resultado_gpt5_wrapper = json.loads(reg['resultado_analises'] or '{}')
            if 'resultado' in resultado_gpt5_wrapper:
                resultado_gpt5 = resultado_gpt5_wrapper['resultado']
                if isinstance(resultado_gpt5, str):
                    try:
                        resultado_gpt5 = json.loads(resultado_gpt5)
                    except:
                        resultado_gpt5 = {}
        except:
            pass

        status_mini = analise_mini.get('ia_status', '?')
        fichas_mini = analise_mini.get('ia_fichas_confirmadas', '—')
        valor_mini = analise_mini.get('valor_ressarcimento_estimado', 0)

        status_gpt5 = resultado_gpt5.get('ia_status', '?')
        fichas_gpt5 = resultado_gpt5.get('ia_fichas_confirmadas', '—')
        valor_gpt5 = resultado_gpt5.get('valor_ressarcimento_estimado', 0)

        total_ressarcimento += float(valor_gpt5 or 0)

        # Print formatado
        print(f"\n[{i}] ID={fid} | UC={uc} | Mês={mes}")
        print(f"    Concessionária: {concessionaria}")
        print(f"    Total Fatura: R$ {total_fatura:,.2f}")
        print(f"    Status mini → gpt-5.4: {status_mini} → {status_gpt5}")
        print(f"    Fichas mini → gpt-5.4: {fichas_mini} → {fichas_gpt5}")
        print(f"    Valor mini → gpt-5.4: R$ {valor_mini:,.2f} → R$ {valor_gpt5:,.2f}")
        print(f"    Confirmado em: {reg['resultado_final_em']}")

        # Coleta dados para CSV
        dados_csv.append({
            'ID': fid,
            'UC': uc,
            'Mês': mes,
            'Concessionária': concessionaria,
            'Total Fatura': f"R$ {total_fatura:,.2f}",
            'Status Mini': status_mini,
            'Status GPT-5.4': status_gpt5,
            'Fichas Mini': fichas_mini,
            'Fichas GPT-5.4': fichas_gpt5,
            'Valor Mini (R$)': f"{valor_mini:,.2f}",
            'Valor GPT-5.4 (R$)': f"{valor_gpt5:,.2f}",
            'Confirmado em': reg['resultado_final_em']
        })

    # Resumo final
    print(f"\n{'='*100}")
    print(f"RESUMO FINAL")
    print('='*100)
    print(f"Total de faturas: {len(registros)}")
    print(f"Ressarcimento total: R$ {total_ressarcimento:,.2f}")

    # Salvar CSV se solicitado
    if args.csv:
        try:
            import csv
            with open(args.csv, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=dados_csv[0].keys())
                writer.writeheader()
                writer.writerows(dados_csv)
            print(f"\n✅ Relatório salvo em: {args.csv}")
        except Exception as e:
            print(f"\n⚠️ Erro ao salvar CSV: {e}")

    cur.close()
    conn.close()
    return 0

if __name__ == "__main__":
    sys.exit(main())
