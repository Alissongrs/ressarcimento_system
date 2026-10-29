-- Baseline (version 1) — 2026-07-05
--
-- Esta migração é um NO-OP intencional. Ela existe apenas para registrar a
-- versão inicial em `schema_migrations` a partir do schema PROD atual (que
-- foi bootstrap via V2 migration em 27-28/06/2026 + blob legado do
-- runLegacyMigrationsUnsafe).
--
-- Todo DDL futuro entra como nova migração incremental (000002_..., etc).
-- Se precisar reconstruir o schema do zero, use um dump SQL desta versão
-- (mysqldump --no-data --no-tablespaces db_ressarcimento) como referência
-- externa — não é carregado por este arquivo.

SELECT 1;
