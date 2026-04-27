-- Migração: Converter analise_IA de texto para JSON estruturado
-- Executa a migração em batches para evitar bloqueios

-- Passo 1: Verificar quantos registros precisam migrar
SELECT COUNT(*) as total_para_migrar
FROM Faturas_Registradas_Cache frc
WHERE frc.analise_IA IS NOT NULL
  AND frc.analise_IA NOT LIKE '{%'
  AND frc.Cod_Empresa = 14;

-- Passo 2: Fazer backup dos dados originais (opcional)
-- CREATE TABLE Faturas_Registradas_Cache_backup AS
-- SELECT * FROM Faturas_Registradas_Cache WHERE Cod_Empresa = 14 AND analise_IA IS NOT NULL;

-- Passo 3: Migração em batches (100 de uma vez para não travar)
-- Execute este comando várias vezes até que nenhum registro seja atualizado

UPDATE Faturas_Registradas_Cache frc
SET analise_IA = JSON_OBJECT(
    'modelo', 'gpt-4.1-mini',
    'observacao', 'Analisado com OpenAI 4.1-mini',
    'resultado', JSON_OBJECT(
        'ia_status',
        CASE
            WHEN frc.analise_IA LIKE '%Fichas Confirmadas:%0%' OR
                 frc.analise_IA LIKE '%Fichas Confirmadas: nenhuma%' OR
                 frc.anomalia_encontrada = 0
            THEN 'FALSO_POSITIVO'
            WHEN (frc.analise_IA LIKE '%F01%' OR
                  frc.analise_IA LIKE '%F02%' OR
                  frc.analise_IA LIKE '%F03%' OR
                  frc.analise_IA LIKE '%F04%' OR
                  frc.analise_IA LIKE '%F05%' OR
                  frc.analise_IA LIKE '%Anomalia Confirmada%' OR
                  frc.anomalia_encontrada = 1) AND
                 NOT (frc.analise_IA LIKE '%Fichas Confirmadas:%0%' OR
                      frc.analise_IA LIKE '%Fichas Confirmadas: nenhuma%')
            THEN 'CONFIRMADO'
            ELSE 'PENDENTE'
        END,
        'ia_fichas_confirmadas', JSON_ARRAY(),
        'valor_ressarcimento_estimado', 0
    )
)
WHERE frc.Cod_Empresa = 14
  AND frc.analise_IA IS NOT NULL
  AND frc.analise_IA NOT LIKE '{%'
LIMIT 100;

-- Passo 4: Verificar resultado
SELECT COUNT(*) as ja_migrado
FROM Faturas_Registradas_Cache
WHERE Cod_Empresa = 14
  AND analise_IA IS NOT NULL
  AND analise_IA LIKE '{%';

-- Passo 5: Quando terminar, rodar o relatório:
-- python relatorio_confirmados.py --empresa 14 --csv resultado_corrigido.csv
