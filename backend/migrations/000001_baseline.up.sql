-- Baseline placeholder.
-- O schema histórico foi criado por DDL ad-hoc antes do uso de migrations.
-- Para popular este arquivo com o schema real, executar:
--
--   docker exec ressarcimento_system-db-1 \
--     mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" \
--     --no-data --routines --triggers --events --no-tablespaces \
--     appdb > backend/migrations/000001_baseline.up.sql
--
-- E em seguida marcar a versão sem reaplicar:
--
--   migrate ... force 1
--
-- A partir da migration 000002 todas as mudanças de schema devem
-- passar por arquivos versionados aqui.

SELECT 1;
