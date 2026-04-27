#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import mysql.connector
import json

DB_CONFIG = {
    "host": "db-acesso-ressarcimento.cvicxzrqb58o.us-east-2.rds.amazonaws.com",
    "port": 3306,
    "user": "super_user_ressarcimento",
    "password": "qZ8YbD3GxK9uN4RmV2sAeT7LwBjCp5X0",
    "database": "db_ressarcimento",
    "charset": "utf8mb4",
}

try:
    conn = mysql.connector.connect(**DB_CONFIG)
    cur = conn.cursor(dictionary=True)
    print("[OK] Conectado ao banco\n")

    # Info sobre a tabela
    print("=" * 80)
    print("ESTRUTURA DE fichas_anomalias_cache")
    print("=" * 80)
    cur.execute("DESCRIBE fichas_anomalias_cache")
    for row in cur.fetchall():
        print(f"  {row['Field']:<30} {row['Type']:<25} {row.get('Null', 'YES')}")

    # Contagem
    print("\n" + "=" * 80)
    print("DADOS NA TABELA")
    print("=" * 80)
    cur.execute("SELECT COUNT(*) as total FROM fichas_anomalias_cache")
    total = cur.fetchone()["total"]
    print(f"Total de registros: {total}")

    # Amostra
    print("\n" + "=" * 80)
    print("AMOSTRA (10 primeiros registros)")
    print("=" * 80)
    cur.execute("""
        SELECT id, UC, Mes_Ref, fichas_aplicadas, ia_status, deletado
        FROM fichas_anomalias_cache
        LIMIT 10
    """)
    for row in cur.fetchall():
        print(f"\nID: {row['id']}")
        print(f"  UC: {row['UC']}")
        print(f"  Mes_Ref: {row['Mes_Ref']}")
        print(f"  Fichas: {row['fichas_aplicadas']}")
        print(f"  IA Status: {row['ia_status']}")
        print(f"  Deletado: {row['deletado']}")

    # Status distribution
    print("\n" + "=" * 80)
    print("DISTRIBUIÇÃO POR STATUS IA")
    print("=" * 80)
    cur.execute("""
        SELECT ia_status, COUNT(*) as qtd
        FROM fichas_anomalias_cache
        WHERE deletado = 0
        GROUP BY ia_status
        ORDER BY qtd DESC
    """)
    for row in cur.fetchall():
        print(f"  {row['ia_status']:<20} : {row['qtd']:>6} registros")

    cur.close()
    conn.close()

except Exception as e:
    print(f"[ERRO] {e}")
    import traceback
    traceback.print_exc()
