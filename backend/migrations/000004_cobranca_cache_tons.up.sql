-- Adiciona os 2 tons novos (Amigavel, Firme) ao cache de cobranca. Os 2 tons originais
-- continuam nas colunas existentes: opcao1 = Formal, opcao2 = Direto (sem renomear, pra
-- nao invalidar cache ja gravado).
ALTER TABLE PROCESSO_COBRANCA_CACHE
  ADD COLUMN amigavel MEDIUMTEXT DEFAULT NULL AFTER opcao2,
  ADD COLUMN firme     MEDIUMTEXT DEFAULT NULL AFTER amigavel;
