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
print("ESTADO DO BANCO")
print("="*80)

# Faturas_Registradas_Cache
cur.execute("SELECT COUNT(*) as total FROM Faturas_Registradas_Cache")
total_frc = cur.fetchone()['total']
print(f"\n[Faturas_Registradas_Cache] Total: {total_frc}")

# Com dados extraídos
cur.execute("""
    SELECT COUNT(*) as total
    FROM Faturas_Registradas_Cache
    WHERE texto_plumber IS NOT NULL OR texto_markitdown IS NOT NULL OR texto_ocr IS NOT NULL
""")
com_texto = cur.fetchone()['total']
print(f"  ├─ Com texto extraído: {com_texto}")

# Com resultado_ia
cur.execute("SELECT COUNT(*) as total FROM Faturas_Registradas_Cache WHERE resultado_ia IS NOT NULL")
com_ia = cur.fetchone()['total']
print(f"  └─ Com resultado_ia preenchido: {com_ia}")

# fichas_anomalias_cache
cur.execute("SELECT COUNT(*) as total FROM fichas_anomalias_cache")
total_fac = cur.fetchone()['total']
print(f"\n[fichas_anomalias_cache] Total: {total_fac}")

# Verificar se há tabela Anotacoes_Campo_IA
try:
    cur.execute("SELECT COUNT(*) as total FROM Anotacoes_Campo_IA")
    total_aca = cur.fetchone()['total']
    print(f"\n[Anotacoes_Campo_IA] Total: {total_aca}")
except:
    print("\n[Anotacoes_Campo_IA] Tabela nao existe ou inacessivel")

print("\n" + "="*80)
print("AMOSTRA RECENTE (10 últimas faturas com texto)")
print("="*80)
cur.execute("""
    SELECT id, UC, Mes_Ref,
           IF(texto_plumber IS NOT NULL, 'SIM', 'NAO') as tem_plumber,
           IF(texto_markitdown IS NOT NULL, 'SIM', 'NAO') as tem_markdown,
           IF(texto_ocr IS NOT NULL, 'SIM', 'NAO') as tem_ocr,
           IF(resultado_ia IS NOT NULL, 'SIM', 'NAO') as tem_resultado
    FROM Faturas_Registradas_Cache
    WHERE texto_plumber IS NOT NULL OR texto_markitdown IS NOT NULL OR texto_ocr IS NOT NULL
    ORDER BY id DESC
    LIMIT 10
""")
for row in cur.fetchall():
    print(f"\nID: {row['id']} | UC: {row['UC']} | Mês: {row['Mes_Ref']}")
    print(f"  Plumber: {row['tem_plumber']} | Markdown: {row['tem_markdown']} | OCR: {row['tem_ocr']} | IA: {row['tem_resultado']}")

cur.close()
conn.close()
