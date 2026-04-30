-- migration_add_textos_analise.sql
-- Executar no banco db_ressarcimento
-- Adiciona colunas de textos brutos dos extratores, análise IA e resultado final

ALTER TABLE FATURA_DADOS_EXTRAIDOS
  ADD COLUMN texto_plumber          MEDIUMTEXT   DEFAULT NULL AFTER atualizado_em,
  ADD COLUMN plumber_gerado_em      DATETIME     DEFAULT NULL AFTER texto_plumber,
  ADD COLUMN texto_markdown         MEDIUMTEXT   DEFAULT NULL AFTER plumber_gerado_em,
  ADD COLUMN markdown_gerado_em     DATETIME     DEFAULT NULL AFTER texto_markdown,
  ADD COLUMN texto_ocr              MEDIUMTEXT   DEFAULT NULL AFTER markdown_gerado_em,
  ADD COLUMN ocr_gerado_em          DATETIME     DEFAULT NULL AFTER texto_ocr,
  ADD COLUMN analise_ia             MEDIUMTEXT   DEFAULT NULL AFTER ocr_gerado_em,
  ADD COLUMN ia_analisado_em        DATETIME     DEFAULT NULL AFTER analise_ia,
  ADD COLUMN resultado_analises_final MEDIUMTEXT DEFAULT NULL AFTER ia_analisado_em,
  ADD COLUMN resultado_em           DATETIME     DEFAULT NULL AFTER resultado_analises_final,
  ADD COLUMN fichas_apontadas       TEXT         DEFAULT NULL AFTER resultado_em;
