#!/usr/bin/env python3
import mysql.connector

conn = mysql.connector.connect(
    host="db-acesso-ressarcimento.cvicxzrqb58o.us-east-2.rds.amazonaws.com",
    port=3306,
    user="super_user_ressarcimento",
    password="qZ8YbD3GxK9uN4RmV2sAeT7LwBjCp5X0",
    database="db_ressarcimento",
    ssl_disabled=True,
    use_pure=True,
)
cur = conn.cursor(dictionary=True)

print("\n" + "="*80)
print("ESTRUTURA: Faturas_Registradas_Cache")
print("="*80)
cur.execute("DESCRIBE Faturas_Registradas_Cache")
for row in cur.fetchall():
    field = row['Field']
    tipo = row['Type']
    null = row['Null']
    print(f"  {field:<40} {tipo:<30} {null}")

print("\n" + "="*80)
print("ESTRUTURA: fichas_anomalias_cache")
print("="*80)
cur.execute("DESCRIBE fichas_anomalias_cache")
for row in cur.fetchall():
    field = row['Field']
    tipo = row['Type']
    null = row['Null']
    print(f"  {field:<40} {tipo:<30} {null}")

cur.close()
conn.close()
