#!/usr/bin/env python3
import mysql.connector

print("Testando conexao ao banco...")
try:
    conn = mysql.connector.connect(
        host="db-acesso-ressarcimento.cvicxzrqb58o.us-east-2.rds.amazonaws.com",
        port=3306,
        user="super_user_ressarcimento",
        password="qZ8YbD3GxK9uN4RmV2sAeT7LwBjCp5X0",
        database="db_ressarcimento",
    )
    print("[OK] Conectado!")
    cur = conn.cursor()
    cur.execute("SELECT 1")
    print("[OK] Query basica funcionou")
    cur.close()
    conn.close()
except Exception as e:
    print(f"[ERRO] {type(e).__name__}: {e}")
