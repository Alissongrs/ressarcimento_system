-- ============================================================================
-- ESQUEMA COMPLETO — SISTEMA DE RESSARCIMENTO (db_ressarcimento)
-- Gerado em 2026-05-29
--
-- Fluxo lógico:
--
--   PDF FATURA (upload)
--        |
--        v
--   FATURA_DADOS_EXTRAIDOS  <-- 260+ colunas, JSON aninhado, audit trail
--        |
--        +--> FATURA_REANALISES        (histórico de reanálise IA)
--        +--> EXTRACAO_DIVERGENCIAS    (audit de divergências regex vs GPT)
--        |
--        v
--   FT_REQUISICOES         <-- triagem inicial / cadastro do pleito
--        |
--        +--> FT_ANEXOS               (PDFs, ofícios, e-mails como anexo)
--        |
--        v
--   FT_PROCESSOS           <-- processo formal (1:1 com requisição)
--        |
--        +--> FT_HISTORICO_MOVIMENTACOES  (linha do tempo do processo)
--        +--> FT_DEFERIMENTOS             (decisão judicial/administrativa)
--        +--> FT_FATURAMENTO              (NF emitida pra cliente)
--        +--> FT_FLUXO_RESSARCIMENTO      (Devolução: Fatura/GD/Depósito)
--        |
--        +--ref-> DM_ETAPAS_PROCESSO      (1=Distribuidora, 2=Ouvidoria, 3=ANEEL, 4=SMA, ..., 13=Suspenso)
--        +--ref-> DM_SUBETAPA_PROCESSOS   ("Aguardando retorno", "Em contestação"...)
--        +--ref-> DM_KANBAN_COLUNAS       (Ativos/Suspensos/Concluídos no UI)
--        +--ref-> DM_TIPO_IRREGULARIDADE  + DM_SUBTIPO
--        +--ref-> DM_INSTANCIA_DEFERIMENTO
--        +--ref-> DM_USUARIO (responsável)
--
-- Views temáticas (camada de leitura):
--   vw_fatura_grupo_a / vw_fatura_gd / vw_fatura_fiscal / vw_fatura_ressarcimento
--   vw_fichas_acumulo        <-- detector Art. 86 REN 1.000 (acúmulo pós-média)
--   vw_fichas_sefaz_divergencia  <-- cross-check XML SEFAZ vs cobrado
--
-- ============================================================================


-- ============================================================================
-- 1. FATURA_DADOS_EXTRAIDOS — coração do sistema (260+ colunas)
-- ============================================================================
CREATE TABLE `FATURA_DADOS_EXTRAIDOS` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `uid` varchar(200) DEFAULT NULL,
  `link_fatura` varchar(250) DEFAULT NULL,
  `cod_empresa` int DEFAULT NULL,
  `codigo_uc` varchar(50) DEFAULT NULL,
  `numero_instalacao` varchar(50) DEFAULT NULL,
  `numero_fatura` varchar(80) DEFAULT NULL,
  `nome_cliente` varchar(255) DEFAULT NULL,
  `cpf_cnpj` varchar(30) DEFAULT NULL,
  `classe_consumidor` varchar(100) DEFAULT NULL,
  `subgrupo_tarifario` varchar(20) DEFAULT NULL,
  `modalidade_tarifaria` varchar(50) DEFAULT NULL,
  `distribuidora` varchar(100) DEFAULT NULL,
  `grupo_tarifario` varchar(10) DEFAULT NULL,
  `tensao_fornecimento` varchar(30) DEFAULT NULL,
  -- Leituras
  `data_leitura_anterior` date DEFAULT NULL,
  `data_leitura_atual` date DEFAULT NULL,
  `dias_faturados` int DEFAULT NULL,
  `mes_referencia` varchar(10) DEFAULT NULL,
  `leit_ant_ativa_ponta` double DEFAULT NULL,
  `leit_atu_ativa_ponta` double DEFAULT NULL,
  `leit_ant_ativa_fponta` double DEFAULT NULL,
  `leit_atu_ativa_fponta` double DEFAULT NULL,
  `leit_ant_reativa` double DEFAULT NULL,
  `leit_atu_reativa` double DEFAULT NULL,
  `leit_demanda_ponta` double DEFAULT NULL,
  `leit_demanda_fponta` double DEFAULT NULL,
  `constante_k` double DEFAULT NULL,
  `rtp_relacao_transformacao_potencial` double DEFAULT NULL,
  `numero_medidor` varchar(50) DEFAULT NULL,
  `tipo_medicao` varchar(50) DEFAULT NULL,
  -- Consumo
  `consumo_ativo_ponta_kwh` double DEFAULT NULL,
  `consumo_ativo_fponta_kwh` double DEFAULT NULL,
  `consumo_reativo_kvarh` double DEFAULT NULL,
  `consumo_reativo_excedente_kvarh` double DEFAULT NULL,
  `demanda_reativa_excedente_kvar` double DEFAULT NULL,
  `demanda_faturada_ponta_kw` double DEFAULT NULL,
  `demanda_faturada_fponta_kw` double DEFAULT NULL,
  `demanda_contratada_ponta_kw` double DEFAULT NULL,
  `demanda_contratada_fponta_kw` double DEFAULT NULL,
  `fator_carga` double DEFAULT NULL,
  `fator_potencia` double DEFAULT NULL,
  `historico_consumo_12_meses` json DEFAULT NULL,
  `indicador_leitura_real` tinyint(1) DEFAULT NULL,
  `indicador_leitura_estimativa` tinyint(1) DEFAULT NULL,
  `observacoes_fatura` text,
  `informacoes_operacionais` text,
  `indicacao_troca_medidor` tinyint(1) DEFAULT NULL,
  `indicacao_impedimento_leitura` tinyint(1) DEFAULT NULL,
  -- Tarifas / Valores
  `tarifa_te` double DEFAULT NULL,
  `tarifa_tusd` double DEFAULT NULL,
  `tarifa_demanda` double DEFAULT NULL,
  `valor_energia_ativa` double DEFAULT NULL,
  `valor_energia_reativa` double DEFAULT NULL,
  `valor_demanda` double DEFAULT NULL,
  `valor_bandeira` double DEFAULT NULL,
  `valor_encargos` double DEFAULT NULL,
  `valor_cip_cosip` double DEFAULT NULL,
  `valor_outros_itens` double DEFAULT NULL,
  `valor_total_fatura` double DEFAULT NULL,
  `valor_total_itens` double DEFAULT NULL,
  `tipo_bandeira_tarifaria` varchar(30) DEFAULT NULL,
  `periodo_bandeira` varchar(30) DEFAULT NULL,
  `valor_cde` double DEFAULT NULL,
  `valor_proinfa` double DEFAULT NULL,
  `valor_ess` double DEFAULT NULL,
  -- Impostos
  `icms_base_calculo` double DEFAULT NULL,
  `icms_aliquota` double DEFAULT NULL,
  `icms_valor` double DEFAULT NULL,
  `pis_aliquota` double DEFAULT NULL,
  `pis_valor` double DEFAULT NULL,
  `cofins_aliquota` double DEFAULT NULL,
  `cofins_valor` double DEFAULT NULL,
  `composicao_base_icms` text,
  `composicao_base_pis_cofins` text,
  -- Flags
  `indicador_tarifa_social` tinyint(1) DEFAULT NULL,
  `indicador_cliente_rural` tinyint(1) DEFAULT NULL,
  `indicador_beneficio_fiscal` tinyint(1) DEFAULT NULL,
  `desconto_tusd` double DEFAULT NULL,
  `indicador_mercado_livre` tinyint(1) DEFAULT NULL,
  -- GD
  `energia_injetada_kwh` double DEFAULT NULL,
  `energia_compensada_kwh` double DEFAULT NULL,
  `saldo_credito_energia` double DEFAULT NULL,
  `indicador_geracao_distribuida` tinyint(1) DEFAULT NULL,
  `valor_energia_reativa_excedente` double DEFAULT NULL,
  `valor_demanda_reativa_excedente` double DEFAULT NULL,
  `perda_transformacao_percentual` double DEFAULT NULL,
  -- Audit
  `fonte_extracao` varchar(20) DEFAULT 'regex' COMMENT 'regex | gpt | ia',
  `extraido_em` datetime DEFAULT CURRENT_TIMESTAMP,
  `atualizado_em` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Textos extraídos
  `texto_plumber` mediumtext,
  `plumber_gerado_em` datetime DEFAULT NULL,
  `texto_markdown` mediumtext,
  `markdown_gerado_em` datetime DEFAULT NULL,
  `texto_ocr` mediumtext,
  `ocr_gerado_em` datetime DEFAULT NULL,
  `texto_bbox` longtext COMMENT 'PyMuPDF reordenado por bbox (linha-real)',
  `texto_bbox_gerado_em` datetime DEFAULT NULL,
  `analise_ia` mediumtext,
  `ia_analisado_em` datetime DEFAULT NULL,
  `resultado_analises_final` mediumtext,
  `resultado_em` datetime DEFAULT NULL,
  `fichas_apontadas` text,
  -- Histórico estruturado
  `historico_consumo_json` json DEFAULT NULL COMMENT 'Tabela 12-13 meses do rodapé da fatura: [{mes,kwh,tipo}]',
  -- Bandeira / Reativo
  `tipo_bandeira` varchar(80) DEFAULT NULL,
  `valor_bandeira_rs` decimal(12,2) DEFAULT NULL,
  `reativo_excedente_rs` decimal(12,2) DEFAULT NULL COMMENT 'UFER/DMCR — penalidade fator potência (A4)',
  -- Art. 323 (parcelamento)
  `parcela_art323_x` int DEFAULT NULL,
  `parcela_art323_y` int DEFAULT NULL,
  `parcela_art323_valor_unitario_rs` decimal(12,2) DEFAULT NULL,
  `parcela_art323_valor_unitario_efetivo_rs` decimal(12,2) DEFAULT NULL,
  `parcela_art323_encargos_extras_rs` decimal(12,2) DEFAULT NULL,
  `parcela_art323_total_estimado_rs` decimal(12,2) DEFAULT NULL,
  `parcela_art323_fatura_origem` varchar(10) DEFAULT NULL,
  `parcela_art323_alerta` varchar(40) DEFAULT NULL COMMENT 'NORMAL/LONGO/ABUSIVO/EXTREMO/FORA_DA_LEI/etc',
  `parcela_art323_regime_norma` varchar(15) DEFAULT NULL COMMENT 'REN_414, REN_414/2, REN_1000, REN_1000/2',
  `parcela_art323_juros_embutidos_pct` decimal(6,2) DEFAULT NULL,
  -- Compensação / Indícios
  `compensacao_ja_aplicada` tinyint(1) DEFAULT '0',
  `compensacao_valor_origem_real_rs` decimal(12,2) DEFAULT NULL,
  `devolucao_em_dobro_ativa` tinyint(1) DEFAULT '0' COMMENT 'CDC Art.42',
  `ciclos_min_max_consecutivos` int DEFAULT NULL,
  `ciclos_med_max_consecutivos` int DEFAULT NULL,
  `ciclo_infinito_art113` tinyint(1) DEFAULT '0',
  `min_prolongado_falso_positivo` tinyint(1) DEFAULT '0',
  `status_leitura_mes_atual` varchar(15) DEFAULT NULL COMMENT 'LID/MED/MIN/Não Exec',
  `uc_publica_operada_por_terceiro` tinyint(1) DEFAULT '0',
  `mercado_livre_acl` tinyint(1) DEFAULT '0',
  `determinacao_judicial_processo` varchar(60) DEFAULT NULL,
  `dividas_anteriores_mesma_uc_count` int DEFAULT '0',
  -- Aritmética / Qualidade
  `aritmetica_total_calculado_rs` decimal(12,2) DEFAULT NULL,
  `aritmetica_diff_pct` decimal(12,4) DEFAULT NULL,
  `aritmetica_ok` tinyint(1) DEFAULT NULL,
  `extracao_score_confianca` tinyint DEFAULT NULL,
  `extracao_revisada_por_gpt` tinyint(1) DEFAULT '0',
  `extracao_modelo_revisor` varchar(30) DEFAULT NULL,
  `extracao_hash` char(32) DEFAULT NULL,
  `extracao_revisao_em` datetime DEFAULT NULL,
  `extracao_versao` varchar(20) DEFAULT NULL,
  `extracao_raw_json` json DEFAULT NULL COMMENT 'Output bruto LLM + estendidos — audit trail',
  `extracao_confidence_score` decimal(5,4) DEFAULT NULL,
  -- Itens / Metadados
  `itens_cobrados` json DEFAULT NULL,
  `itens_extraido_em` datetime DEFAULT NULL,
  `metadados_fatura` json DEFAULT NULL,
  -- NF / Fiscal
  `cnpj_distribuidora_filial` varchar(20) DEFAULT NULL,
  `uf_distribuidora` char(2) DEFAULT NULL,
  `tipo_emissao` enum('PRIMEIRA_VIA','SEGUNDA_VIA','CONTINGENCIA') DEFAULT 'PRIMEIRA_VIA',
  `status_nfe` enum('AUTORIZADA','CONTINGENCIA','REJEITADA') DEFAULT 'AUTORIZADA',
  `chave_nfe` varchar(50) DEFAULT NULL COMMENT 'Chave NF3e 44 dígitos',
  `protocolo_autorizacao` varchar(80) DEFAULT NULL,
  `data_emissao_nf` date DEFAULT NULL,
  `data_apresentacao` date DEFAULT NULL,
  `serie_nf` varchar(10) DEFAULT NULL,
  `roteiro_leitura` varchar(40) DEFAULT NULL,
  `matricula_cliente` varchar(40) DEFAULT NULL,
  `domicilio_bancario` varchar(60) DEFAULT NULL,
  `ie_cliente` varchar(30) DEFAULT NULL,
  `tipo_via` varchar(20) DEFAULT NULL,
  -- ST / Bônus
  `st_credito_rs` decimal(12,2) DEFAULT NULL,
  `st_debito_rs` decimal(12,2) DEFAULT NULL,
  `bonus_credito_rs` decimal(12,2) DEFAULT NULL,
  `demanda_ultrapassagem_rs` decimal(12,2) DEFAULT NULL,
  -- Qualidade tensão (REN 956)
  `tensao_contratada_v` decimal(10,2) DEFAULT NULL,
  `tensao_minima_v` decimal(10,2) DEFAULT NULL,
  `tensao_maxima_v` decimal(10,2) DEFAULT NULL,
  `limite_adequado_min_v` decimal(10,2) DEFAULT NULL,
  `limite_adequado_max_v` decimal(10,2) DEFAULT NULL,
  -- GD avançado
  `saldo_gd_a_expirar` decimal(12,2) DEFAULT NULL,
  `saldo_gd_ponta_kwh` decimal(12,2) DEFAULT NULL,
  `saldo_gd_fponta_kwh` decimal(12,2) DEFAULT NULL,
  -- Distribuidora
  `ie_distribuidora` varchar(30) DEFAULT NULL,
  `cep_distribuidora` varchar(15) DEFAULT NULL,
  `endereco_distribuidora` varchar(255) DEFAULT NULL,
  `cidade_uf_distribuidora` varchar(80) DEFAULT NULL,
  -- Audit fiscal / score
  `audit_confianca` enum('verde_auditavel','verde_tarifa_aneel','verde_dispensada','amarelo','vermelho','anomalo') DEFAULT NULL,
  `dec_anual_horas` decimal(6,2) DEFAULT NULL,
  `fec_anual_vezes` decimal(6,2) DEFAULT NULL,
  `subtotal_faturamento_rs` decimal(12,2) DEFAULT NULL,
  `subtotal_outros_rs` decimal(12,2) DEFAULT NULL,
  `grandezas_contratadas_json` json DEFAULT NULL,
  -- Validador / Gate
  `validador_gate` varchar(20) DEFAULT NULL COMMENT 'aprovado/revisao/reprovado/scaneada',
  `layout_template_id` varchar(150) DEFAULT NULL,
  -- Vencimento / endereço UC
  `data_vencimento` date DEFAULT NULL,
  `endereco_uc` varchar(255) DEFAULT NULL,
  `cep_uc` varchar(15) DEFAULT NULL,
  `conjunto_uc` varchar(80) DEFAULT NULL,
  `dicri_horas` decimal(8,2) DEFAULT NULL,
  `dmic_horas` decimal(8,2) DEFAULT NULL,
  -- Energisa MT específicos
  `perda_ramal_kwh` decimal(10,2) DEFAULT NULL,
  `subvencao_subsidio_rs` decimal(12,2) DEFAULT NULL,
  `data_pagamento` date DEFAULT NULL,
  `status_pagamento` varchar(20) DEFAULT NULL,
  `flag_telemetria_perda` tinyint(1) DEFAULT NULL,
  -- ICMS TE vs TUSD (LC 194/2022)
  `icms_base_te` decimal(12,2) DEFAULT NULL,
  `icms_base_tusd` decimal(12,2) DEFAULT NULL,
  -- Flags de qualidade
  `flag_fonte_incompleta` tinyint(1) DEFAULT NULL,
  `flag_arquivo_invalido` tinyint(1) DEFAULT NULL,
  `motivo_arquivo_invalido` varchar(64) DEFAULT NULL,
  `flag_menciona_perda_transf` tinyint(1) DEFAULT NULL,
  -- CIP/COSIP
  `cip_iluminacao_publica_rs` decimal(12,2) DEFAULT NULL,
  -- ========== SEFAZ NF3e (10 colunas por CCI + 7 metadados) ==========
  `cci_codigos_sefaz` json DEFAULT NULL,
  `classificacao_cci_sefaz` json DEFAULT NULL,
  `valor_total_sefaz` decimal(12,2) DEFAULT NULL,
  `qtd_itens_sefaz` smallint DEFAULT NULL,
  `cnpj_emissor_sefaz` varchar(18) DEFAULT NULL,
  `ie_emissor_sefaz` varchar(32) DEFAULT NULL,
  `protocolo_autorizacao_sefaz` varchar(32) DEFAULT NULL,
  `data_emissao_sefaz` datetime DEFAULT NULL,
  `flag_divergencia_valor_sefaz` tinyint(1) DEFAULT NULL,
  `flag_divergencia_qtd_itens_sefaz` tinyint(1) DEFAULT NULL,
  `sefaz_consultado_em` datetime DEFAULT NULL,
  `consumo_ativo_sefaz_kwh` decimal(12,2) DEFAULT NULL COMMENT 'CCI 0601xxx',
  `energia_compensada_sefaz_kwh` decimal(12,2) DEFAULT NULL COMMENT 'CCI 5603xxx (GD)',
  `demanda_sefaz_kw` decimal(12,2) DEFAULT NULL COMMENT 'CCI 0621/0631',
  `reativo_excedente_sefaz_kvarh` decimal(12,2) DEFAULT NULL COMMENT 'CCI 0611xxx',
  `cip_sefaz_rs` decimal(12,2) DEFAULT NULL COMMENT 'CCI 0801xxx',
  `bandeira_sefaz_rs` decimal(12,2) DEFAULT NULL COMMENT 'CCI 5901/5905/5906',
  `encargos_sefaz_rs` decimal(12,2) DEFAULT NULL COMMENT 'CCI 0821/0841/0842/0843',
  `subsidio_sefaz_rs` decimal(12,2) DEFAULT NULL COMMENT 'CCI 0604',
  `fio_b_sefaz_rs` decimal(12,2) DEFAULT NULL COMMENT 'CCI 0640xxx (TUSD Fio B)',
  `custo_disponib_sefaz_rs` decimal(12,2) DEFAULT NULL COMMENT 'CCI 0605xxx',
  `valor_total_origem` varchar(16) DEFAULT NULL,
  `qtd_itens_origem` varchar(16) DEFAULT NULL,
  -- GD detalhado (mUC vs oUC)
  `energia_compensada_muc_kwh` decimal(12,2) DEFAULT NULL,
  `energia_compensada_ouc_kwh` decimal(12,2) DEFAULT NULL,
  -- Consumo reservado (Equatorial GO)
  `consumo_ativo_reservado_kwh` decimal(12,2) DEFAULT NULL,
  -- Débitos vencidos
  `debitos_vencidos_qtd` smallint DEFAULT NULL,
  `debitos_vencidos_periodo` varchar(32) DEFAULT NULL,
  `debitos_vencidos_valor_rs` decimal(14,2) DEFAULT NULL,
  `data_prevista_suspensao` date DEFAULT NULL,
  -- VRC / CFOP
  `vrc_indicador_continuidade` varchar(32) DEFAULT NULL,
  `cfop` varchar(8) DEFAULT NULL,
  `cfop_descricao` varchar(120) DEFAULT NULL,
  -- Pagamento canhoto pág3
  `data_pagamento_canhoto` date DEFAULT NULL,
  `valor_pago_canhoto` decimal(12,2) DEFAULT NULL,
  -- Validação determinística
  `validacao_deterministica` json DEFAULT NULL,
  -- Medição estruturada
  `medicao_grandezas_json` json DEFAULT NULL,
  -- ========== Propagações sessão 29/05/2026 ==========
  `flag_legado_pre_2023` tinyint(1) NOT NULL DEFAULT '0',
  `fator_potencia_status` enum('abaixo_092','acima_092','desconhecido') DEFAULT NULL,
  `tarifa_fio_b` decimal(12,6) DEFAULT NULL,
  `tarifa_cosip` decimal(12,6) DEFAULT NULL,
  `tarifa_te_ponta` decimal(12,6) DEFAULT NULL,
  `tarifa_tusd_ponta` decimal(12,6) DEFAULT NULL,
  `tarifa_demanda_ponta` decimal(12,6) DEFAULT NULL,
  `tarifa_demanda_fponta` decimal(12,6) DEFAULT NULL,
  `flag_faturamento_media` tinyint(1) NOT NULL DEFAULT '0',
  `flag_acumulo_pos_media` tinyint(1) NOT NULL DEFAULT '0',
  `acumulo_ratio_pico_media` decimal(8,2) DEFAULT NULL,
  `acumulo_media_12m_kwh` decimal(12,2) DEFAULT NULL,
  `acumulo_validacao_futura` enum('confirmado','reclassificado_novo_padrao','inconclusivo','sem_dados_futuros','nao_aplicavel') DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_uid` (`uid`),
  KEY `idx_cod_empresa` (`cod_empresa`),
  KEY `idx_parcela_art323_alerta` (`parcela_art323_alerta`),
  KEY `idx_parcela_art323_y` (`parcela_art323_y`),
  KEY `idx_parcela_art323_regime` (`parcela_art323_regime_norma`),
  KEY `idx_compensacao_ja_aplicada` (`compensacao_ja_aplicada`),
  KEY `idx_ciclo_infinito` (`ciclo_infinito_art113`),
  KEY `idx_min_prolongado_fp` (`min_prolongado_falso_positivo`),
  KEY `idx_uc_publica` (`uc_publica_operada_por_terceiro`),
  KEY `idx_acl` (`mercado_livre_acl`),
  KEY `idx_extracao_score` (`extracao_score_confianca`),
  KEY `idx_extracao_revisada` (`extracao_revisada_por_gpt`),
  KEY `idx_emp_parcel_alerta` (`cod_empresa`,`parcela_art323_alerta`),
  KEY `idx_layout_template_id` (`layout_template_id`)
) ENGINE=InnoDB AUTO_INCREMENT=75761 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Dados padronizados extraídos das faturas — independente da concessionária';


-- ============================================================================
-- 2. FATURA_REANALISES — histórico/audit trail de cada reanálise IA
-- ============================================================================
CREATE TABLE `FATURA_REANALISES` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `fatura_id` bigint unsigned NOT NULL,
  `decisao_final` varchar(20) DEFAULT NULL,
  `ficha_principal` varchar(10) DEFAULT NULL,
  `fichas_confirmadas` json DEFAULT NULL,
  `confianca_final` tinyint unsigned DEFAULT NULL,
  `percentual_ressarcimento` decimal(5,2) DEFAULT NULL,
  `justificativa` text,
  `recomendacao` text,
  `modelo` varchar(40) DEFAULT 'gpt-5.4',
  `pdf_anexado` tinyint(1) NOT NULL DEFAULT '0',
  `resposta_crua` longtext,
  `v19_score_confianca` tinyint DEFAULT NULL,
  `v19_parcela_alerta` varchar(40) DEFAULT NULL,
  `v19_total_estimado` decimal(12,2) DEFAULT NULL,
  `v19_status_passibilidade` varchar(40) DEFAULT NULL,
  `usuario_id` bigint unsigned DEFAULT NULL,
  `usuario_nome` varchar(120) DEFAULT NULL,
  `criado_em` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_fatura` (`fatura_id`),
  KEY `idx_criado` (`criado_em`),
  KEY `idx_decisao` (`decisao_final`),
  CONSTRAINT `fk_reanalise_fatura` FOREIGN KEY (`fatura_id`)
    REFERENCES `FATURA_DADOS_EXTRAIDOS` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Histórico/audit trail de cada reanálise IA';


-- ============================================================================
-- 3. EXTRACAO_DIVERGENCIAS — audit regex vs GPT vs banco
-- ============================================================================
CREATE TABLE `EXTRACAO_DIVERGENCIAS` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `fatura_id` bigint unsigned NOT NULL,
  `campo` varchar(80) NOT NULL,
  `valor_banco` text,
  `valor_extracao` text,
  `valor_gpt` text,
  `valor_aplicado` text,
  `origem` varchar(40) NOT NULL COMMENT 'pdf_pipeline / pipeline_decisao / manual',
  `modelo` varchar(30) DEFAULT NULL,
  `motivo` varchar(200) DEFAULT NULL,
  `detectado_em` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `aplicado` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_fatura` (`fatura_id`),
  KEY `idx_campo` (`campo`),
  KEY `idx_origem` (`origem`),
  KEY `idx_detectado` (`detectado_em`),
  CONSTRAINT `fk_div_fatura` FOREIGN KEY (`fatura_id`)
    REFERENCES `FATURA_DADOS_EXTRAIDOS` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Auditoria de divergências entre banco, extração e GPT';


-- ============================================================================
-- 4. FT_REQUISICOES — triagem inicial do pleito (1:1 com FT_PROCESSOS)
-- ============================================================================
CREATE TABLE `FT_REQUISICOES` (
  `id_requisicao` int NOT NULL AUTO_INCREMENT,
  `id_usuario` int DEFAULT NULL,
  `id_prioridade` int DEFAULT NULL,
  `id_status` int DEFAULT NULL,
  `uc` varchar(100) DEFAULT NULL,
  `cliente` varchar(255) DEFAULT NULL,
  `razao_social_fatura` varchar(255) DEFAULT NULL,
  `concessionaria` varchar(255) DEFAULT NULL,
  `cnpj` varchar(20) DEFAULT NULL,
  `endereco_completo` varchar(500) DEFAULT NULL,
  `numero_protocolo` varchar(50) DEFAULT NULL,
  `ressarcimento_estimado` decimal(15,2) DEFAULT NULL,
  `periodos_irregularidade` json DEFAULT NULL,
  `descricao_irregularidade` text,
  `link_fatura` varchar(512) DEFAULT NULL,
  `processo_criado` tinyint(1) DEFAULT '0',
  `data_criacao` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `data_mudanca_status` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `justificativa_atraso_triagem` text,
  `id_tipo_irregularidade` int DEFAULT NULL,
  `id_subtipo_irregularidade` int DEFAULT NULL,
  `triagem` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id_requisicao`),
  UNIQUE KEY `numero_protocolo` (`numero_protocolo`),
  KEY `id_prioridade` (`id_prioridade`),
  KEY `fk_req_tipo_irr` (`id_tipo_irregularidade`),
  KEY `fk_req_subtipo_irr` (`id_subtipo_irregularidade`),
  KEY `idx_requisicoes_data_criacao` (`data_criacao` DESC),
  KEY `idx_requisicoes_status` (`id_status`),
  KEY `idx_requisicoes_usuario` (`id_usuario`),
  CONSTRAINT `fk_req_subtipo_irr` FOREIGN KEY (`id_subtipo_irregularidade`)
    REFERENCES `DM_SUBTIPO_IRREGULARIDADE` (`id_subtipo`),
  CONSTRAINT `fk_req_tipo_irr` FOREIGN KEY (`id_tipo_irregularidade`)
    REFERENCES `DM_TIPO_IRREGULARIDADE` (`id_tipo`),
  CONSTRAINT `FT_REQUISICOES_ibfk_1` FOREIGN KEY (`id_usuario`) REFERENCES `DM_USUARIO` (`id_usuario`),
  CONSTRAINT `FT_REQUISICOES_ibfk_2` FOREIGN KEY (`id_prioridade`) REFERENCES `DM_PRIORIDADE` (`id_prioridade`),
  CONSTRAINT `FT_REQUISICOES_ibfk_3` FOREIGN KEY (`id_status`) REFERENCES `DM_STATUS` (`id_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ============================================================================
-- 5. FT_PROCESSOS — processo formal (PK=id_processo == FT_REQUISICOES.id_requisicao)
-- ============================================================================
CREATE TABLE `FT_PROCESSOS` (
  `uc` varchar(100) DEFAULT NULL,
  `id_processo` int NOT NULL,
  `cliente` varchar(255) DEFAULT NULL,
  `concessionaria` varchar(255) DEFAULT NULL,
  `id_coluna` int DEFAULT NULL COMMENT 'Coluna kanban (Ativos/Suspensos/Concluídos)',
  `nome_coluna` varchar(50) DEFAULT NULL,
  `id_etapa_processo` int DEFAULT NULL,
  `etapa` varchar(50) DEFAULT NULL,
  `sub_etapa` varchar(50) DEFAULT NULL,
  `id_responsavel` int DEFAULT NULL,
  `id_sub_etapa_processo` int DEFAULT NULL,
  `relevancia` tinyint(1) DEFAULT '0',
  `data_alerta` datetime DEFAULT NULL,
  `ultima_atualizacao` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `data_movimentacao` datetime DEFAULT NULL,
  `ressarcimento_estimado` decimal(15,2) DEFAULT NULL,
  `data_procedencia` date DEFAULT NULL,
  `credito_simples` decimal(15,2) DEFAULT NULL,
  `credito_dobro` decimal(15,2) DEFAULT NULL,
  `data_credito_dobro` date DEFAULT NULL,
  `repasse_simples` decimal(15,2) DEFAULT NULL,
  `repasse_dobro` decimal(15,2) DEFAULT NULL,
  `suspenso` tinyint(1) NOT NULL DEFAULT '0',
  `periodos_irregularidade` text,
  `descricao_irregularidade` text,
  `id_tipo_irregularidade` int DEFAULT NULL,
  `nome_tipo_irregularidade` varchar(255) DEFAULT NULL,
  `id_subtipo_irregularidade` int DEFAULT NULL,
  `nome_subtipo_irregularidade` varchar(255) DEFAULT NULL,
  `data_criacao` datetime DEFAULT NULL,
  `score_percentual` float DEFAULT NULL,
  `instancia_deferimento` int DEFAULT NULL,
  PRIMARY KEY (`id_processo`),
  KEY `id_responsavel` (`id_responsavel`),
  KEY `idx_proc_ultima_atualizacao` (`ultima_atualizacao` DESC),
  KEY `idx_proc_suspenso` (`suspenso`),
  KEY `idx_proc_data_alerta` (`data_alerta`),
  KEY `idx_processos_etapa` (`id_etapa_processo`),
  KEY `idx_ft_processos_id_sub_etapa` (`id_sub_etapa_processo`),
  KEY `idx_ft_processos_etapa` (`etapa`),
  KEY `idx_ft_processos_id_coluna` (`id_coluna`),
  KEY `idx_pr_tipo_subtipo` (`id_tipo_irregularidade`,`id_subtipo_irregularidade`),
  KEY `fk_proc_instancia` (`instancia_deferimento`),
  CONSTRAINT `fk_ft_processos_kanban_coluna` FOREIGN KEY (`id_coluna`)
    REFERENCES `DM_KANBAN_COLUNAS` (`id_coluna`) ON DELETE SET NULL,
  CONSTRAINT `fk_ft_processos_subetapa` FOREIGN KEY (`id_sub_etapa_processo`)
    REFERENCES `DM_SUBETAPA_PROCESSOS` (`id_subetapa`) ON DELETE SET NULL,
  CONSTRAINT `fk_proc_instancia` FOREIGN KEY (`instancia_deferimento`)
    REFERENCES `DM_INSTANCIA_DEFERIMENTO` (`id_instancia`) ON DELETE SET NULL,
  CONSTRAINT `FT_PROCESSOS_ibfk_1` FOREIGN KEY (`id_processo`)
    REFERENCES `FT_REQUISICOES` (`id_requisicao`) ON DELETE CASCADE,
  CONSTRAINT `FT_PROCESSOS_ibfk_2` FOREIGN KEY (`id_etapa_processo`)
    REFERENCES `DM_ETAPAS_PROCESSO` (`id_etapa_processo`),
  CONSTRAINT `FT_PROCESSOS_ibfk_3` FOREIGN KEY (`id_responsavel`)
    REFERENCES `DM_USUARIO` (`id_usuario`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ============================================================================
-- 6. FT_HISTORICO_MOVIMENTACOES — linha do tempo de cada processo
-- ============================================================================
CREATE TABLE `FT_HISTORICO_MOVIMENTACOES` (
  `id_historico` int NOT NULL AUTO_INCREMENT,
  `id_requisicao` int DEFAULT NULL COMMENT 'FK -> FT_PROCESSOS.id_processo',
  `id_usuario_gestor` int DEFAULT NULL,
  `status_anterior` varchar(50) DEFAULT NULL,
  `status_novo` varchar(50) DEFAULT NULL,
  `etapa_anterior` varchar(50) DEFAULT NULL,
  `etapa_nova` varchar(50) DEFAULT NULL,
  `sub_etapa` varchar(50) DEFAULT NULL,
  `relevancia_anterior` varchar(10) DEFAULT NULL,
  `relevancia_nova` varchar(10) DEFAULT NULL,
  `comentario` text,
  `justificativa_atraso` text,
  `tipo_movimentacao` varchar(32) DEFAULT NULL,
  `data_movimentacao` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `tipo_irregularidade` varchar(255) DEFAULT NULL,
  `subtipo_irregularidade` varchar(255) DEFAULT NULL,
  `mail_graph_message_id` varchar(200) DEFAULT NULL,
  PRIMARY KEY (`id_historico`),
  KEY `idx_hist_requisicao_data` (`id_requisicao`,`data_movimentacao` DESC),
  KEY `idx_hist_data` (`data_movimentacao`),
  KEY `idx_hist_usuario` (`id_usuario_gestor`),
  KEY `idx_hm_etapas` (`etapa_nova`,`etapa_anterior`),
  CONSTRAINT `FT_HISTORICO_MOVIMENTACOES_ibfk_1` FOREIGN KEY (`id_requisicao`)
    REFERENCES `FT_REQUISICOES` (`id_requisicao`) ON DELETE CASCADE,
  CONSTRAINT `FT_HISTORICO_MOVIMENTACOES_ibfk_2` FOREIGN KEY (`id_usuario_gestor`)
    REFERENCES `DM_USUARIO` (`id_usuario`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ============================================================================
-- 7. FT_DEFERIMENTOS — decisão judicial/administrativa do processo
-- ============================================================================
CREATE TABLE `FT_DEFERIMENTOS` (
  `id_deferimento` int NOT NULL AUTO_INCREMENT,
  `id_processo` int NOT NULL,
  `status_analise` varchar(100) DEFAULT NULL,
  `instancia_deferimento` int DEFAULT NULL,
  `data_procedencia` date DEFAULT NULL,
  `credito_simples` decimal(12,2) DEFAULT '0.00',
  `credito_dobro` decimal(12,2) DEFAULT '0.00',
  `data_credito_dobro` date DEFAULT NULL,
  `tipo_irregularidade` varchar(255) DEFAULT NULL,
  `subtipo_irregularidade` varchar(255) DEFAULT NULL,
  `repasse_simples` decimal(15,2) DEFAULT NULL,
  `repasse_dobro` decimal(15,2) DEFAULT NULL,
  PRIMARY KEY (`id_deferimento`),
  UNIQUE KEY `id_processo` (`id_processo`),
  KEY `fk_def_instancia` (`instancia_deferimento`),
  CONSTRAINT `fk_def_instancia` FOREIGN KEY (`instancia_deferimento`)
    REFERENCES `DM_INSTANCIA_DEFERIMENTO` (`id_instancia`) ON DELETE SET NULL,
  CONSTRAINT `FT_DEFERIMENTOS_ibfk_1` FOREIGN KEY (`id_processo`)
    REFERENCES `FT_PROCESSOS` (`id_processo`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ============================================================================
-- 8. FT_FLUXO_RESSARCIMENTO — devolução ao cliente (1:N por processo)
-- ============================================================================
CREATE TABLE `FT_FLUXO_RESSARCIMENTO` (
  `id_fluxo` int NOT NULL AUTO_INCREMENT,
  `id_processo` int NOT NULL,
  `forma_devolucao` enum('Fatura','GD','Deposito') NOT NULL,
  `valor` decimal(15,2) DEFAULT '0.00',
  `data_devolucao` date DEFAULT NULL,
  `data_envio_financeiro` date DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `simples` tinyint(1) NOT NULL DEFAULT '0',
  `dobro` tinyint(1) NOT NULL DEFAULT '0',
  `simples_dobro` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id_fluxo`),
  KEY `idx_fluxo_processo` (`id_processo`),
  CONSTRAINT `FT_FLUXO_RESSARCIMENTO_ibfk_1` FOREIGN KEY (`id_processo`)
    REFERENCES `FT_PROCESSOS` (`id_processo`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Fluxo de Ressarcimento';


-- ============================================================================
-- 9. FT_FATURAMENTO — NF emitida ao cliente após procedência
-- ============================================================================
CREATE TABLE `FT_FATURAMENTO` (
  `id_faturamento` int NOT NULL AUTO_INCREMENT,
  `id_processo` int NOT NULL,
  `numero_nf` varchar(50) DEFAULT NULL,
  `data_emissao` date DEFAULT NULL,
  `data_vencimento` date DEFAULT NULL,
  `data_pagamento` date DEFAULT NULL,
  `valor` decimal(10,2) DEFAULT '0.00',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id_faturamento`),
  KEY `idx_faturamento_processo` (`id_processo`),
  CONSTRAINT `FT_FATURAMENTO_ibfk_1` FOREIGN KEY (`id_processo`)
    REFERENCES `FT_PROCESSOS` (`id_processo`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Faturamento';


-- ============================================================================
-- 10. FT_ANEXOS — PDFs, ofícios, e-mails anexados ao processo
-- ============================================================================
CREATE TABLE `FT_ANEXOS` (
  `id_anexo` int NOT NULL AUTO_INCREMENT,
  `id_requisicao` int DEFAULT NULL,
  `nome_arquivo` varchar(255) DEFAULT NULL,
  `caminho_arquivo` varchar(512) DEFAULT NULL,
  `enviado_por` enum('usuario','gestor') DEFAULT NULL,
  `data_upload` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `mime_type` varchar(120) DEFAULT NULL,
  `tamanho_bytes` bigint DEFAULT NULL,
  `arquivo_blob` mediumblob,
  PRIMARY KEY (`id_anexo`),
  KEY `idx_anx_id_requisicao` (`id_requisicao`),
  CONSTRAINT `FT_ANEXOS_ibfk_1` FOREIGN KEY (`id_requisicao`)
    REFERENCES `FT_REQUISICOES` (`id_requisicao`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ============================================================================
-- DIMENSÕES (DM_*) — tabelas de referência
-- ============================================================================

-- Etapas do processo (1=Distribuidora, 2=Ouvidoria, 3=ANEEL, 4=SMA, 5=Pendente,
-- 6=Em Conciliação, 7=Em Contestação, 9=Repasse Amee, 10=Concluído, 11=Indeferido,
-- 12=Rejeitado, 13=Suspenso (criado 29/05/2026), 14=Enviado ao Financeiro)
CREATE TABLE `DM_ETAPAS_PROCESSO` (
  `id_etapa_processo` int NOT NULL AUTO_INCREMENT,
  `etapa` varchar(50) NOT NULL,
  `etapa_descricao` text,
  `id_coluna_kanban` int DEFAULT NULL,
  PRIMARY KEY (`id_etapa_processo`),
  UNIQUE KEY `etapa` (`etapa`),
  CONSTRAINT `DM_ETAPAS_PROCESSO_ibfk_1` FOREIGN KEY (`id_coluna_kanban`)
    REFERENCES `DM_KANBAN_COLUNAS` (`id_coluna`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `DM_SUBETAPA_PROCESSOS` (
  `id_subetapa` int NOT NULL AUTO_INCREMENT,
  `nome_subetapa` varchar(100) NOT NULL,
  `Obs` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id_subetapa`),
  UNIQUE KEY `nome_subetapa` (`nome_subetapa`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `DM_KANBAN_COLUNAS` (
  `id_coluna` int NOT NULL AUTO_INCREMENT,
  `nome_coluna` varchar(50) NOT NULL,
  `ordem` int NOT NULL,
  PRIMARY KEY (`id_coluna`),
  UNIQUE KEY `nome_coluna` (`nome_coluna`),
  UNIQUE KEY `ordem` (`ordem`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `DM_TIPO_IRREGULARIDADE` (
  `id_tipo` int NOT NULL,
  `nome` varchar(100) NOT NULL,
  PRIMARY KEY (`id_tipo`),
  UNIQUE KEY `nome` (`nome`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `DM_SUBTIPO_IRREGULARIDADE` (
  `id_subtipo` int NOT NULL,
  `id_tipo` int NOT NULL,
  `nome` varchar(100) NOT NULL,
  PRIMARY KEY (`id_subtipo`),
  UNIQUE KEY `uq_subtipo_por_tipo` (`id_tipo`,`nome`),
  CONSTRAINT `DM_SUBTIPO_IRREGULARIDADE_ibfk_1` FOREIGN KEY (`id_tipo`)
    REFERENCES `DM_TIPO_IRREGULARIDADE` (`id_tipo`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Demais dimensões (estrutura simples):
-- DM_USUARIO            — usuários do sistema (gestores)
-- DM_STATUS             — status do FT_REQUISICOES
-- DM_PRIORIDADE         — prioridade do FT_REQUISICOES
-- DM_INSTANCIA_DEFERIMENTO  — instância (Administrativa, Judicial 1ª, etc)
-- DM_ALARMES, DM_CANAIS_COMUNICACAO, DM_DEPARTAMENTO, DM_PRAZOS_*


-- ============================================================================
-- VIEW vw_fichas_acumulo — Detector Art. 86 REN 1.000 (acúmulo pós-média)
-- ============================================================================
CREATE OR REPLACE VIEW `vw_fichas_acumulo` AS
SELECT
  id, cod_empresa, distribuidora, codigo_uc, mes_referencia,
  consumo_ativo_fponta_kwh         AS consumo_atual_kwh,
  acumulo_media_12m_kwh            AS media_12m_kwh,
  acumulo_ratio_pico_media         AS ratio_pico_media,
  ROUND((acumulo_ratio_pico_media - 1) * 100, 1) AS pct_acima_media,
  flag_faturamento_media,
  acumulo_validacao_futura,
  CASE
    WHEN acumulo_ratio_pico_media >= 10 THEN 'CRITICO'
    WHEN acumulo_ratio_pico_media >= 5  THEN 'ALTO'
    WHEN acumulo_ratio_pico_media >= 3  THEN 'MEDIO'
    WHEN acumulo_ratio_pico_media >= 1.80 THEN 'LEVE'
    ELSE 'BAIXO' END             AS severidade,
  CASE acumulo_validacao_futura
    WHEN 'confirmado'                 THEN 'CONFIRMADO — media 3 proximas <= 30% do pico (acumulo real)'
    WHEN 'reclassificado_novo_padrao' THEN 'FALSO POSITIVO — cliente novo / mudanca real (media 3 proximas >= 50% do pico)'
    WHEN 'inconclusivo'               THEN 'INCONCLUSIVO — media 3 proximas entre 30-50% do pico (REVISAO HUMANA)'
    WHEN 'sem_dados_futuros'          THEN 'AGUARDANDO — UC sem 3 faturas posteriores no banco'
    ELSE                                   'NAO VALIDADO — re-rodar validar_acumulo_com_futuras'
  END                              AS observacao_apontamento,
  energia_compensada_kwh,
  indicador_geracao_distribuida,
  valor_total_fatura,
  data_vencimento,
  validador_gate
FROM FATURA_DADOS_EXTRAIDOS
WHERE flag_acumulo_pos_media = 1
ORDER BY acumulo_ratio_pico_media DESC;


-- ============================================================================
-- VIEW vw_fichas_sefaz_divergencia — Cross-check SEFAZ XML vs cobrado
-- ============================================================================
CREATE OR REPLACE VIEW `vw_fichas_sefaz_divergencia` AS
SELECT
  id, cod_empresa, distribuidora, subgrupo_tarifario, mes_referencia,
  valor_bandeira_rs               AS bandeira_cobrado_rs,
  bandeira_sefaz_rs,
  ROUND(COALESCE(valor_bandeira_rs,0) - COALESCE(bandeira_sefaz_rs,0), 2) AS diff_bandeira_rs,
  cip_iluminacao_publica_rs       AS cip_cobrado_rs,
  cip_sefaz_rs,
  ROUND(COALESCE(cip_iluminacao_publica_rs,0) - COALESCE(cip_sefaz_rs,0), 2) AS diff_cip_rs,
  subvencao_subsidio_rs           AS subsidio_cobrado_rs,
  subsidio_sefaz_rs,
  ROUND(COALESCE(subvencao_subsidio_rs,0) - COALESCE(subsidio_sefaz_rs,0), 2) AS diff_subsidio_rs,
  tarifa_fio_b                    AS tarifa_fio_b_cobrado,
  fio_b_sefaz_rs,
  demanda_faturada_fponta_kw      AS demanda_cobrado_kw,
  demanda_sefaz_kw,
  ROUND(COALESCE(demanda_faturada_fponta_kw,0) - COALESCE(demanda_sefaz_kw,0), 2) AS diff_demanda_kw,
  energia_compensada_kwh          AS compensada_cobrado_kwh,
  energia_compensada_sefaz_kwh,
  ROUND(COALESCE(energia_compensada_kwh,0) - COALESCE(energia_compensada_sefaz_kwh,0), 2) AS diff_compensada_kwh,
  consumo_reativo_excedente_kvarh AS reat_cobrado_kvarh,
  reativo_excedente_sefaz_kvarh,
  ROUND(COALESCE(consumo_reativo_excedente_kvarh,0) - COALESCE(reativo_excedente_sefaz_kvarh,0), 2) AS diff_reat_kvarh,
  valor_encargos                  AS encargos_cobrado_rs,
  encargos_sefaz_rs,
  valor_total_fatura, valor_total_sefaz, flag_divergencia_valor_sefaz,
  sefaz_consultado_em
FROM FATURA_DADOS_EXTRAIDOS
WHERE sefaz_consultado_em IS NOT NULL;


-- ============================================================================
-- OUTRAS VIEWS TEMÁTICAS (definidas no banco):
--   vw_fatura_grupo_a         — só Grupo A (subgrupo A1-A4)
--   vw_fatura_gd              — só com indicador_geracao_distribuida=1
--   vw_fatura_fiscal          — campos NF/SEFAZ
--   vw_fatura_ressarcimento   — campos pra cálculo de ressarcimento (Art.113/323)
--   VW_PROCESSO_ULTIMO_HIST   — última movimentação por processo
--   VW_RESUMO_PROCESSOS       — agregado por etapa/sub_etapa
--   VW_PRAZOS_VENCIDOS        — processos com SLA estourado
--   VW_UC_OVERVIEW            — visão consolidada por UC
--   VW_RESUMO_FATURAMENTO     — agregado FT_FATURAMENTO
--   VW_RESUMO_FLUXO           — agregado FT_FLUXO_RESSARCIMENTO
-- ============================================================================
