-- ─────────────────────────────────────────────────────────────────────────────
-- migrar_fichas_apontadas.sql
-- Cria UMA coluna unificada para apontamentos no lugar das múltiplas flags.
--
-- Antes:
--   fichas_anomalias_cache.flag_f01..flag_f14 (incompleto, só F01-F05+F13)
--   resultado_regras (JSON em Faturas_Registradas_Cache, completo mas custoso)
--
-- Depois:
--   Faturas_Registradas_Cache.fichas_apontadas VARCHAR(64) — "F01,F02,F10"
--   Indexada pra filtros rápidos (FIND_IN_SET / LIKE).
--
-- Roda 1x. Idempotente (checa existência da coluna/índice antes de criar).
-- ─────────────────────────────────────────────────────────────────────────────

USE db_ressarcimento;

-- 1. Adiciona a coluna se não existir
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'Faturas_Registradas_Cache'
    AND COLUMN_NAME  = 'fichas_apontadas'
);

SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE Faturas_Registradas_Cache ADD COLUMN fichas_apontadas VARCHAR(64) NULL',
  'SELECT "coluna fichas_apontadas ja existe" AS info'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Cria índice se não existir
SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'Faturas_Registradas_Cache'
    AND INDEX_NAME   = 'idx_fichas_apontadas'
);

SET @ddl := IF(@idx_exists = 0,
  'ALTER TABLE Faturas_Registradas_Cache ADD INDEX idx_fichas_apontadas (fichas_apontadas)',
  'SELECT "index idx_fichas_apontadas ja existe" AS info'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3. Backfill a partir do JSON resultado_regras.fichas_todas
--    Converte ["F01","F02"] -> "F01,F02"
UPDATE Faturas_Registradas_Cache
SET fichas_apontadas = REPLACE(REPLACE(REPLACE(REPLACE(
        JSON_EXTRACT(resultado_regras, '$.fichas_todas'),
        '"', ''), '[', ''), ']', ''), ' ', '')
WHERE resultado_regras IS NOT NULL
  AND resultado_regras != ''
  AND JSON_LENGTH(JSON_EXTRACT(resultado_regras, '$.fichas_todas')) > 0
  AND (fichas_apontadas IS NULL OR fichas_apontadas = '');

-- 4. Verificação (somente leitura)
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN fichas_apontadas IS NOT NULL AND fichas_apontadas != '' THEN 1 ELSE 0 END) AS com_apontamento,
  SUM(CASE WHEN fichas_apontadas LIKE '%F02%' THEN 1 ELSE 0 END) AS apontados_f02,
  SUM(CASE WHEN fichas_apontadas LIKE '%F06%' THEN 1 ELSE 0 END) AS apontados_f06,
  SUM(CASE WHEN fichas_apontadas LIKE '%F10%' THEN 1 ELSE 0 END) AS apontados_f10
FROM Faturas_Registradas_Cache;
