-- ════════════════════════════════════════════════════════════════════
-- DIAGNÓSTICO: Verificar resultado do motor_regras.py
-- ════════════════════════════════════════════════════════════════════

-- 1. Verificar se as tabelas existem
SELECT TABLE_NAME, TABLE_ROWS
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'db_ressarcimento'
  AND TABLE_NAME IN ('fichas_anomalias_cache', 'fichas_f06_f14_cache');

-- 2. Estrutura de fichas_anomalias_cache
DESCRIBE fichas_anomalias_cache;

-- 3. Estrutura de fichas_f06_f14_cache (se existir)
DESCRIBE fichas_f06_f14_cache;

-- 4. Total de registros por empresa
SELECT Cod_Empresa, COUNT(*) as total
FROM fichas_anomalias_cache
GROUP BY Cod_Empresa;

-- 5. Amostra de dados da empresa 14 em fichas_anomalias_cache
SELECT * FROM fichas_anomalias_cache
WHERE Cod_Empresa = 14
LIMIT 5;

-- 6. Total de faturas CONFIRMADO na empresa 14
SELECT COUNT(*) as total
FROM Faturas_Registradas_Cache f
WHERE Cod_Empresa = 14
  AND JSON_EXTRACT(f.analise_IA, '$.resultado.ia_status') = 'CONFIRMADO';

-- 7. Ver se há colunas de resultado em Faturas_Registradas_Cache
SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'db_ressarcimento'
  AND TABLE_NAME = 'Faturas_Registradas_Cache'
  AND COLUMN_NAME LIKE '%resultado%';
