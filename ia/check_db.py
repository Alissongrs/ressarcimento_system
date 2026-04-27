#!/usr/bin/env python3
import mysql.connector

print("Testando conexao...")
try:
    conn = mysql.connector.connect(
        host="db-acesso-ressarcimento.cvicxzrqb58o.us-east-2.rds.amazonaws.com",
        port=3306,
        user="super_user_ressarcimento",
        password="qZ8YbD3GxK9uN4RmV2sAeT7LwBjCp5X0",
        database="db_ressarcimento",
        ssl_disabled=True,
        use_pure=True,
    )
    print("[OK] Conectado!")
    cur = conn.cursor(dictionary=True)

    # Tabela fichas_anomalias_cache
    cur.execute("SELECT COUNT(*) as total FROM fichas_anomalias_cache")
    result = cur.fetchone()
    print(f"\n[fichas_anomalias_cache] Total: {result['total']}")

    cur.execute("SELECT ia_status, COUNT(*) as qtd FROM fichas_anomalias_cache WHERE deletado=0 GROUP BY ia_status")
    print("\nDistribuicao por status:")
    for row in cur.fetchall():
        print(f"  {row['ia_status']}: {row['qtd']}")

    cur.close()
    conn.close()
except Exception as e:
    print(f"[ERRO] {type(e).__name__}: {e}")
    import traceback
    traceback.print_exc()
