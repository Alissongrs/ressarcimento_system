-- migration_FATURA_DADOS_EXTRAIDOS.sql
-- Executar no banco db_ressarcimento (user com permissão DDL)
-- Cria a tabela de dados padronizados das faturas

CREATE TABLE IF NOT EXISTS FATURA_DADOS_EXTRAIDOS (
  id                              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  fatura_id                       BIGINT UNSIGNED NOT NULL,

  -- Identificação
  codigo_uc                       VARCHAR(50)   DEFAULT NULL,
  numero_instalacao               VARCHAR(50)   DEFAULT NULL,
  numero_fatura                   VARCHAR(80)   DEFAULT NULL,
  nome_cliente                    VARCHAR(255)  DEFAULT NULL,
  cpf_cnpj                        VARCHAR(30)   DEFAULT NULL,
  classe_consumidor               VARCHAR(100)  DEFAULT NULL,
  subgrupo_tarifario              VARCHAR(20)   DEFAULT NULL,
  modalidade_tarifaria            VARCHAR(50)   DEFAULT NULL,
  distribuidora                   VARCHAR(100)  DEFAULT NULL,
  grupo_tarifario                 VARCHAR(10)   DEFAULT NULL,
  tensao_fornecimento             VARCHAR(30)   DEFAULT NULL,

  -- Período de faturamento
  data_leitura_anterior           DATE          DEFAULT NULL,
  data_leitura_atual              DATE          DEFAULT NULL,
  dias_faturados                  INT           DEFAULT NULL,
  mes_referencia                  VARCHAR(10)   DEFAULT NULL,

  -- Leituras energia ativa
  leit_ant_ativa_ponta            DOUBLE        DEFAULT NULL,
  leit_atu_ativa_ponta            DOUBLE        DEFAULT NULL,
  leit_ant_ativa_fponta           DOUBLE        DEFAULT NULL,
  leit_atu_ativa_fponta           DOUBLE        DEFAULT NULL,

  -- Leituras energia reativa
  leit_ant_reativa                DOUBLE        DEFAULT NULL,
  leit_atu_reativa                DOUBLE        DEFAULT NULL,

  -- Leituras demanda
  leit_demanda_ponta              DOUBLE        DEFAULT NULL,
  leit_demanda_fponta             DOUBLE        DEFAULT NULL,

  -- Constantes e relações do medidor
  constante_k                     DOUBLE        DEFAULT NULL,
  fator_multiplicacao             DOUBLE        DEFAULT NULL,
  constante_eletronica_ke         DOUBLE        DEFAULT NULL,
  rtc_relacao_transformacao_corrente DOUBLE     DEFAULT NULL,
  rtp_relacao_transformacao_potencial DOUBLE    DEFAULT NULL,

  -- Medidor
  numero_medidor                  VARCHAR(50)   DEFAULT NULL,
  tipo_medicao                    VARCHAR(50)   DEFAULT NULL,
  historico_troca_medidor         TEXT          DEFAULT NULL,

  -- Consumo e demanda
  consumo_ativo_ponta_kwh         DOUBLE        DEFAULT NULL,
  consumo_ativo_fponta_kwh        DOUBLE        DEFAULT NULL,
  consumo_reativo_kvarh           DOUBLE        DEFAULT NULL,
  consumo_reativo_excedente_kvarh DOUBLE        DEFAULT NULL,
  demanda_reativa_excedente_kvar  DOUBLE        DEFAULT NULL,
  demanda_faturada_ponta_kw       DOUBLE        DEFAULT NULL,
  demanda_faturada_fponta_kw      DOUBLE        DEFAULT NULL,
  demanda_contratada_ponta_kw     DOUBLE        DEFAULT NULL,
  demanda_contratada_fponta_kw    DOUBLE        DEFAULT NULL,

  -- Fatores
  fator_carga                     DOUBLE        DEFAULT NULL,
  fator_potencia                  DOUBLE        DEFAULT NULL,

  -- Histórico 12 meses (JSON: [{"mes":1,"ano":2024,"kwh":1200.0}, ...])
  historico_consumo_12_meses      JSON          DEFAULT NULL,
  historico_demanda_12_meses      JSON          DEFAULT NULL,

  -- Tipo de leitura
  tipo_leitura                    VARCHAR(50)   DEFAULT NULL,
  indicador_leitura_real          TINYINT(1)    DEFAULT NULL,
  indicador_leitura_estimativa    TINYINT(1)    DEFAULT NULL,

  -- Observações e indicadores operacionais
  observacoes_fatura              TEXT          DEFAULT NULL,
  informacoes_operacionais        TEXT          DEFAULT NULL,
  indicacao_troca_medidor         TINYINT(1)    DEFAULT NULL,
  indicacao_revisao_faturamento   TINYINT(1)    DEFAULT NULL,
  indicacao_impedimento_leitura   TINYINT(1)    DEFAULT NULL,

  -- Tarifas unitárias (R$/kWh ou R$/kW, sem impostos)
  tarifa_te                       DOUBLE        DEFAULT NULL,
  tarifa_tusd                     DOUBLE        DEFAULT NULL,
  tarifa_demanda                  DOUBLE        DEFAULT NULL,

  -- Valores financeiros principais (R$)
  valor_energia_ativa             DOUBLE        DEFAULT NULL,
  valor_energia_reativa           DOUBLE        DEFAULT NULL,
  valor_demanda                   DOUBLE        DEFAULT NULL,
  valor_bandeira                  DOUBLE        DEFAULT NULL,
  valor_encargos                  DOUBLE        DEFAULT NULL,
  valor_cip_cosip                 DOUBLE        DEFAULT NULL,
  valor_outros_itens              DOUBLE        DEFAULT NULL,
  valor_total_fatura              DOUBLE        DEFAULT NULL,
  valor_total_itens               DOUBLE        DEFAULT NULL,

  -- Bandeira tarifária
  tipo_bandeira_tarifaria         VARCHAR(30)   DEFAULT NULL,
  valor_bandeira_tarifaria        DOUBLE        DEFAULT NULL,
  periodo_bandeira                VARCHAR(30)   DEFAULT NULL,

  -- Encargos setoriais
  valor_cde                       DOUBLE        DEFAULT NULL,
  valor_proinfa                   DOUBLE        DEFAULT NULL,
  valor_ess                       DOUBLE        DEFAULT NULL,
  valor_outros_encargos           DOUBLE        DEFAULT NULL,

  -- Tributos
  icms_base_calculo               DOUBLE        DEFAULT NULL,
  icms_aliquota                   DOUBLE        DEFAULT NULL,
  icms_valor                      DOUBLE        DEFAULT NULL,
  pis_aliquota                    DOUBLE        DEFAULT NULL,
  pis_valor                       DOUBLE        DEFAULT NULL,
  cofins_aliquota                 DOUBLE        DEFAULT NULL,
  cofins_valor                    DOUBLE        DEFAULT NULL,
  composicao_base_icms            TEXT          DEFAULT NULL,
  composicao_base_pis_cofins      TEXT          DEFAULT NULL,

  -- Benefícios e indicadores tarifários
  indicador_tarifa_social         TINYINT(1)    DEFAULT NULL,
  indicador_cliente_rural         TINYINT(1)    DEFAULT NULL,
  indicador_beneficio_fiscal      TINYINT(1)    DEFAULT NULL,
  desconto_tusd                   DOUBLE        DEFAULT NULL,
  indicador_mercado_livre         TINYINT(1)    DEFAULT NULL,

  -- Geração distribuída (GD/compensação)
  energia_injetada_kwh            DOUBLE        DEFAULT NULL,
  energia_compensada_kwh          DOUBLE        DEFAULT NULL,
  saldo_credito_energia           DOUBLE        DEFAULT NULL,
  indicador_geracao_distribuida   TINYINT(1)    DEFAULT NULL,

  -- Eventos cadastrais
  evento_troca_medidor            TINYINT(1)    DEFAULT NULL,
  evento_mudanca_titularidade     TINYINT(1)    DEFAULT NULL,
  evento_ligacao_nova             TINYINT(1)    DEFAULT NULL,
  evento_encerramento             TINYINT(1)    DEFAULT NULL,

  -- Reativos excedentes e teste
  valor_energia_reativa_excedente DOUBLE        DEFAULT NULL,
  valor_demanda_reativa_excedente DOUBLE        DEFAULT NULL,
  informacao_teste_reativo        TEXT          DEFAULT NULL,
  periodo_teste_reativo           VARCHAR(30)   DEFAULT NULL,
  dados_leitura_reativa_kvarh     DOUBLE        DEFAULT NULL,
  dados_demanda_reativa_kvar      DOUBLE        DEFAULT NULL,

  -- Perdas de transformação
  perda_transformacao_percentual  DOUBLE        DEFAULT NULL,

  -- Metadados da extração
  fonte_extracao                  VARCHAR(20)   DEFAULT 'regex'
                                    COMMENT 'regex | gpt | ia',
  extraido_em                     DATETIME      DEFAULT CURRENT_TIMESTAMP,
  atualizado_em                   DATETIME      DEFAULT CURRENT_TIMESTAMP
                                    ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_fatura_id (fatura_id),
  KEY        idx_fatura_id (fatura_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='Dados padronizados extraídos das faturas — independente da concessionária';
