-- migration_add_uid_link.sql
-- Executar no banco db_ressarcimento
-- Estado atual: uid e link_fatura já existem (MUL), fatura_id ainda existe (UNI).
-- Esta migration:
--   1. Adiciona cod_empresa (nova)
--   2. Remove fatura_id e seus índices
--   3. Promove uid de MUL para UNIQUE KEY

ALTER TABLE FATURA_DADOS_EXTRAIDOS
  ADD COLUMN cod_empresa INT DEFAULT NULL AFTER link_fatura,
  DROP INDEX  uk_fatura_id,
  DROP INDEX  idx_fatura_id,
  DROP COLUMN fatura_id,
  DROP INDEX  idx_uid,
  ADD UNIQUE KEY uk_uid (uid),
  ADD INDEX  idx_cod_empresa (cod_empresa);
