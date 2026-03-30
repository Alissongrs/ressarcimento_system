-- ============================================================
-- VIEWS DE ANÁLISE DE ANOMALIAS — sgeeasy_clientes_novo
-- Executar conectado ao banco sgeeasy_clientes_novo
-- ============================================================

-- ------------------------------------------------------------
-- F01 – Divergência de Fórmula
-- Detecta quando o KWH cobrado na fatura difere do valor
-- calculado pelas leituras × constante do medidor (> 5%)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_ficha_01_divergencia_formula AS
SELECT
  id,
  UC,
  RAZAO_SOCIAL,
  Concessionaria,
  Empresa,
  Mes_Ref,
  Tp_Tensao,
  UF,
  Cidade,
  NroMedidor,
  Qtd_Dias,

  -- Valores cobrados
  KWH_FPonta                                                          AS KWH_FP_Cobrado,
  KWH_Ponta                                                           AS KWH_P_Cobrado,
  KWH_Total                                                           AS KWH_Total_Cobrado,

  -- Leituras e constantes
  Leitura_Anterior_KWH_FP,
  Leitura_Atual_KWH_FP,
  Constante_KWH_FP,
  Leitura_Anterior_KWH_P,
  Leitura_Atual_KWH_P,
  Constante_KWH_P,

  -- KWH calculado pelas leituras
  ROUND((Leitura_Atual_KWH_FP - Leitura_Anterior_KWH_FP) * Constante_KWH_FP, 2) AS KWH_FP_Calculado,
  ROUND((Leitura_Atual_KWH_P  - Leitura_Anterior_KWH_P)  * Constante_KWH_P,  2) AS KWH_P_Calculado,

  -- Divergência absoluta e percentual
  ROUND(
    KWH_FPonta - ((Leitura_Atual_KWH_FP - Leitura_Anterior_KWH_FP) * Constante_KWH_FP)
  , 2) AS Divergencia_FP_KWH,

  ROUND(
    ABS(KWH_FPonta - ((Leitura_Atual_KWH_FP - Leitura_Anterior_KWH_FP) * Constante_KWH_FP))
    / NULLIF(KWH_FPonta, 0) * 100
  , 1) AS Divergencia_FP_Pct,

  RS_Total_Fatura,
  Status_Fatura,
  Mes_Ref AS Periodo

FROM Faturas_Registradas_Cache
WHERE
  Leitura_Anterior_KWH_FP IS NOT NULL
  AND Leitura_Atual_KWH_FP  IS NOT NULL
  AND Constante_KWH_FP IS NOT NULL AND Constante_KWH_FP > 0
  AND KWH_FPonta > 0
  AND (Leitura_Atual_KWH_FP - Leitura_Anterior_KWH_FP) >= 0
  AND ABS(KWH_FPonta - ((Leitura_Atual_KWH_FP - Leitura_Anterior_KWH_FP) * Constante_KWH_FP))
      / NULLIF(KWH_FPonta, 0) > 0.05
ORDER BY Divergencia_FP_Pct DESC;


-- ------------------------------------------------------------
-- F02 – Desvio de Média
-- Detecta consumo muito acima ou abaixo da média histórica
-- registrada no campo Media_Consumo (> 80% acima ou < 40% abaixo)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_ficha_02_desvio_media AS
SELECT
  id,
  UC,
  RAZAO_SOCIAL,
  Concessionaria,
  Empresa,
  Mes_Ref,
  Tp_Tensao,
  UF,
  Cidade,
  NroMedidor,
  Qtd_Dias,

  KWH_Total,
  Media_Consumo,

  ROUND(KWH_Total - Media_Consumo, 2)                              AS Diferenca_KWH,
  ROUND((KWH_Total - Media_Consumo) / NULLIF(Media_Consumo, 0) * 100, 1) AS Desvio_Pct,

  CASE
    WHEN KWH_Total > Media_Consumo * 1.8 THEN 'ALTO — acima de 80% da média'
    WHEN KWH_Total < Media_Consumo * 0.6 THEN 'BAIXO — abaixo de 40% da média'
  END AS Tipo_Desvio,

  RS_Total_Fatura,
  RS_KWH_Total,
  Status_Fatura

FROM Faturas_Registradas_Cache
WHERE
  Media_Consumo IS NOT NULL AND Media_Consumo > 0
  AND KWH_Total  IS NOT NULL AND KWH_Total  > 0
  AND (
    KWH_Total > Media_Consumo * 1.8
    OR KWH_Total < Media_Consumo * 0.6
  )
ORDER BY ABS(KWH_Total - Media_Consumo) DESC;


-- ------------------------------------------------------------
-- F03 – Acúmulo de Consumo
-- Detecta faturas com período de leitura muito longo (> 45 dias)
-- indicando possível acumulação de meses sem leitura real
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_ficha_03_acumulo_consumo AS
SELECT
  id,
  UC,
  RAZAO_SOCIAL,
  Concessionaria,
  Empresa,
  Mes_Ref,
  Tp_Tensao,
  UF,
  Cidade,
  NroMedidor,

  Dt_Leitura_Anterior,
  Dt_Leitura_Atual,
  Qtd_Dias,
  DATEDIFF(Dt_Leitura_Atual, Dt_Leitura_Anterior) AS Dias_Calculado,

  KWH_Total,
  Media_Consumo,
  ROUND(KWH_Total / NULLIF(Qtd_Dias, 0), 2) AS KWH_Por_Dia,
  ROUND(Media_Consumo / 30, 2)              AS KWH_Por_Dia_Medio,

  RS_Total_Fatura,
  Status_Fatura

FROM Faturas_Registradas_Cache
WHERE
  Qtd_Dias IS NOT NULL
  AND Qtd_Dias > 45
  AND Dt_Leitura_Anterior IS NOT NULL
  AND Dt_Leitura_Atual    IS NOT NULL
ORDER BY Qtd_Dias DESC;


-- ------------------------------------------------------------
-- F04 – Troca de Medidor
-- Detecta quando a leitura atual é menor que a anterior,
-- indicando reset do medidor por troca (sem registro formal)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_ficha_04_troca_medidor AS
SELECT
  id,
  UC,
  RAZAO_SOCIAL,
  Concessionaria,
  Empresa,
  Mes_Ref,
  Tp_Tensao,
  UF,
  Cidade,
  NroMedidor,
  Qtd_Dias,

  Dt_Leitura_Anterior,
  Dt_Leitura_Atual,

  Leitura_Anterior_KWH_FP,
  Leitura_Atual_KWH_FP,
  ROUND(Leitura_Atual_KWH_FP - Leitura_Anterior_KWH_FP, 2) AS Diferenca_Leitura_FP,

  Leitura_Anterior_KWH_P,
  Leitura_Atual_KWH_P,
  ROUND(Leitura_Atual_KWH_P - Leitura_Anterior_KWH_P, 2)   AS Diferenca_Leitura_P,

  KWH_Total,
  RS_Total_Fatura,
  Status_Fatura,

  CASE
    WHEN Leitura_Atual_KWH_FP < Leitura_Anterior_KWH_FP THEN 'Leitura FP regressou'
    WHEN Leitura_Atual_KWH_P  < Leitura_Anterior_KWH_P  THEN 'Leitura P regressou'
  END AS Motivo

FROM Faturas_Registradas_Cache
WHERE
  (
    (Leitura_Atual_KWH_FP IS NOT NULL AND Leitura_Anterior_KWH_FP IS NOT NULL
     AND Leitura_Atual_KWH_FP < Leitura_Anterior_KWH_FP)
    OR
    (Leitura_Atual_KWH_P IS NOT NULL AND Leitura_Anterior_KWH_P IS NOT NULL
     AND Leitura_Atual_KWH_P < Leitura_Anterior_KWH_P)
  )
ORDER BY Mes_Ref DESC;


-- ------------------------------------------------------------
-- F05 – Quebra de Leitura
-- Detecta leituras zeradas, nulas ou com salto extremo
-- enquanto a fatura tem consumo cobrado
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_ficha_05_quebra_leitura AS
SELECT
  id,
  UC,
  RAZAO_SOCIAL,
  Concessionaria,
  Empresa,
  Mes_Ref,
  Tp_Tensao,
  UF,
  Cidade,
  NroMedidor,
  Qtd_Dias,

  Leitura_Anterior_KWH_FP,
  Leitura_Atual_KWH_FP,
  Leitura_Anterior_KWH_P,
  Leitura_Atual_KWH_P,
  Constante_KWH_FP,
  Constante_KWH_P,

  KWH_Total,
  KWH_FPonta,
  KWH_Ponta,
  RS_Total_Fatura,
  Status_Fatura,

  CASE
    WHEN Leitura_Atual_KWH_FP = 0 AND KWH_FPonta > 0 THEN 'Leitura FP zerada com consumo cobrado'
    WHEN Leitura_Atual_KWH_FP IS NULL AND KWH_FPonta > 0 THEN 'Leitura FP ausente com consumo cobrado'
    WHEN Leitura_Atual_KWH_FP = Leitura_Anterior_KWH_FP AND KWH_FPonta > 100 THEN 'Leitura FP igual à anterior — possível estimativa'
    WHEN (Leitura_Atual_KWH_FP - Leitura_Anterior_KWH_FP) * COALESCE(Constante_KWH_FP,1) > Media_Consumo * 3 THEN 'Salto extremo de leitura (> 3× média)'
  END AS Tipo_Quebra

FROM Faturas_Registradas_Cache
WHERE
  (
    (Leitura_Atual_KWH_FP = 0 AND KWH_FPonta > 0)
    OR (Leitura_Atual_KWH_FP IS NULL AND KWH_FPonta > 0)
    OR (Leitura_Atual_KWH_FP = Leitura_Anterior_KWH_FP AND KWH_FPonta > 100)
    OR (
      (Leitura_Atual_KWH_FP - Leitura_Anterior_KWH_FP) * COALESCE(Constante_KWH_FP,1)
      > COALESCE(Media_Consumo, 0) * 3
      AND Media_Consumo > 0
    )
  )
ORDER BY Mes_Ref DESC;
