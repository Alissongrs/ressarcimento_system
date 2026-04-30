package handlers

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// fichaUnificadaSQL é a query principal com todas as regras F01—F05 inlined.
// Variáveis @session foram substituídas por literais.
const fichaUnificadaSQL = `
WITH
base_raw AS (
  SELECT
    f.id, f.UC, f.Cod_Empresa, f.Concessionaria, f.Mes_Ref,
    f.Tp_Tensao, f.Modalidade_Tarifaria, f.NroMedidor,
    f.RAZAO_SOCIAL, f.Link, f.RS_Total_Fatura,
    CAST(REPLACE(COALESCE(NULLIF(TRIM(CAST(f.KWH_Ponta     AS CHAR)),''),'0'),',','.') AS DECIMAL(18,6)) AS kwh_p,
    CAST(REPLACE(COALESCE(NULLIF(TRIM(CAST(f.KWH_FPonta    AS CHAR)),''),'0'),',','.') AS DECIMAL(18,6)) AS kwh_fp,
    CAST(REPLACE(COALESCE(NULLIF(TRIM(CAST(f.KWH_Reservado AS CHAR)),''),'0'),',','.') AS DECIMAL(18,6)) AS kwh_r,
    CAST(REPLACE(COALESCE(NULLIF(TRIM(CAST(f.Leitura_Anterior_KWH_P  AS CHAR)),''),'0'),',','.') AS DECIMAL(18,6)) AS la_p,
    CAST(REPLACE(COALESCE(NULLIF(TRIM(CAST(f.Leitura_Atual_KWH_P     AS CHAR)),''),'0'),',','.') AS DECIMAL(18,6)) AS lc_p,
    CAST(REPLACE(COALESCE(NULLIF(TRIM(CAST(f.Leitura_Anterior_KWH_FP AS CHAR)),''),'0'),',','.') AS DECIMAL(18,6)) AS la_fp,
    CAST(REPLACE(COALESCE(NULLIF(TRIM(CAST(f.Leitura_Atual_KWH_FP    AS CHAR)),''),'0'),',','.') AS DECIMAL(18,6)) AS lc_fp,
    CAST(REPLACE(COALESCE(NULLIF(TRIM(CAST(f.Leitura_Anterior_KWH_R  AS CHAR)),''),'0'),',','.') AS DECIMAL(18,6)) AS la_r,
    CAST(REPLACE(COALESCE(NULLIF(TRIM(CAST(f.Leitura_Atual_KWH_R     AS CHAR)),''),'0'),',','.') AS DECIMAL(18,6)) AS lc_r,
    COALESCE(NULLIF(CAST(REPLACE(COALESCE(NULLIF(TRIM(CAST(f.Constante_KWH_P  AS CHAR)),''),'0'),',','.') AS DECIMAL(18,6)),0),1) AS const_p,
    COALESCE(NULLIF(CAST(REPLACE(COALESCE(NULLIF(TRIM(CAST(f.Constante_KWH_FP AS CHAR)),''),'0'),',','.') AS DECIMAL(18,6)),0),1) AS const_fp,
    COALESCE(NULLIF(CAST(REPLACE(COALESCE(NULLIF(TRIM(CAST(f.Constante_KWH_R  AS CHAR)),''),'0'),',','.') AS DECIMAL(18,6)),0),1) AS const_r
  FROM Faturas_Registradas_Cache f
  WHERE f.Tp_Tensao IN ('ACR BT','GD','ACR MT','ACR AT','ACR MB')
    AND f.Cod_Empresa IN (4,14,32,33,69,70,80,120,135,144,145,176,180,181,183,189,191,199,202,203,204,205,206,209,210,211,212,213,214,216,217,218,219,223,224,226,227,359,362,366,367,368,369,370,374)
),
f01_calc AS (
  SELECT id,
    ROUND((lc_p  - la_p)  * const_p,  6) AS calc_p,
    ROUND((lc_fp - la_fp) * const_fp, 6) AS calc_fp,
    ROUND((lc_r  - la_r)  * const_r,  6) AS calc_r,
    kwh_p, kwh_fp, kwh_r
  FROM base_raw
),
f01_ajustado AS (
  SELECT id,
    CASE WHEN ABS(kwh_p  - calc_p)  > 0.01 THEN ROUND(calc_p  * 1.025,6) ELSE calc_p  END AS adj_p,
    CASE WHEN ABS(kwh_fp - calc_fp) > 0.01 THEN ROUND(calc_fp * 1.025,6) ELSE calc_fp END AS adj_fp,
    CASE WHEN ABS(kwh_r  - calc_r)  > 0.01 THEN ROUND(calc_r  * 1.025,6) ELSE calc_r  END AS adj_r,
    kwh_p, kwh_fp, kwh_r
  FROM f01_calc
),
f01_flags AS (
  SELECT id,
    CASE WHEN ABS(kwh_p  - adj_p)  > 0.01 THEN 1 ELSE 0 END AS flag_p,
    CASE WHEN ABS(kwh_fp - adj_fp) > 0.01 THEN 1 ELSE 0 END AS flag_fp,
    CASE WHEN ABS(kwh_r  - adj_r)  > 0.01 THEN 1 ELSE 0 END AS flag_r,
    CASE WHEN kwh_fp IN (30,50,100)
          AND (ABS(kwh_p  - adj_p)  > 0.01
            OR ABS(kwh_fp - adj_fp) > 0.01
            OR ABS(kwh_r  - adj_r)  > 0.01)
         THEN 1 ELSE 0 END AS excecao
  FROM f01_ajustado
),
f01_resultado AS (
  SELECT id,
    CASE WHEN excecao = 0 AND (flag_p = 1 OR flag_fp = 1 OR flag_r = 1) THEN 1 ELSE 0 END AS flag_f01,
    TRIM(BOTH ' | ' FROM CONCAT_WS(' | ',
      CASE WHEN excecao = 0 AND flag_p  = 1 THEN 'P'  END,
      CASE WHEN excecao = 0 AND flag_fp = 1 THEN 'FP' END,
      CASE WHEN excecao = 0 AND flag_r  = 1 THEN 'R'  END
    )) AS seg_f01
  FROM f01_flags
),
base_seg AS (
  SELECT id, UC, Cod_Empresa, Concessionaria, Mes_Ref, Tp_Tensao, Link,
    RS_Total_Fatura, NroMedidor,
    'P'  AS seg, kwh_p  AS v, la_p  AS leitura_ant, lc_p  AS leitura_atu
  FROM base_raw
  UNION ALL
  SELECT id, UC, Cod_Empresa, Concessionaria, Mes_Ref, Tp_Tensao, Link,
    RS_Total_Fatura, NroMedidor,
    'FP' AS seg, kwh_fp AS v, la_fp AS leitura_ant, lc_fp AS leitura_atu
  FROM base_raw
  UNION ALL
  SELECT id, UC, Cod_Empresa, Concessionaria, Mes_Ref, Tp_Tensao, Link,
    RS_Total_Fatura, NroMedidor,
    'R'  AS seg, kwh_r  AS v, la_r  AS leitura_ant, lc_r  AS leitura_atu
  FROM base_raw
),
com_media AS (
  SELECT *,
    AVG(CASE WHEN v > 50 THEN v ELSE NULL END) OVER (
      PARTITION BY UC,Concessionaria,seg ORDER BY Mes_Ref ROWS BETWEEN 12 PRECEDING AND 1 PRECEDING
    ) AS media,
    COUNT(CASE WHEN v > 50 THEN v ELSE NULL END) OVER (
      PARTITION BY UC,Concessionaria,seg ORDER BY Mes_Ref ROWS BETWEEN 12 PRECEDING AND 1 PRECEDING
    ) AS base_len
  FROM base_seg
),
com_mad AS (
  SELECT *,
    GREATEST(AVG(CASE WHEN v > 50 THEN ABS(v - media) ELSE NULL END) OVER (
      PARTITION BY UC,Concessionaria,seg ORDER BY Mes_Ref ROWS BETWEEN 12 PRECEDING AND 1 PRECEDING
    ), 1) AS mad
  FROM com_media
  WHERE media IS NOT NULL AND media >= 50 AND base_len >= 1
),
classificado AS (
  SELECT *,
    CASE WHEN media > 0 THEN (v - media) / media ELSE NULL END AS dif_pct,
    MIN(v)   OVER (PARTITION BY UC,Concessionaria,seg ORDER BY Mes_Ref ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING) AS min_4,
    MAX(v)   OVER (PARTITION BY UC,Concessionaria,seg ORDER BY Mes_Ref ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING) AS max_4,
    COUNT(v) OVER (PARTITION BY UC,Concessionaria,seg ORDER BY Mes_Ref ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING) AS cnt_4,
    LAG(NroMedidor)  OVER (PARTITION BY UC,Concessionaria,seg ORDER BY Mes_Ref) AS med_ant,
    LAG(leitura_atu) OVER (PARTITION BY UC,Concessionaria,seg ORDER BY Mes_Ref) AS leit_atu_ant,
    CASE
      WHEN v IS NULL OR v < 0 THEN 'INVALIDO'
      WHEN v IN (0,1)         THEN 'PLACEHOLDER'
      WHEN base_len IS NULL   THEN 'SEM_BASE'
      WHEN base_len < 8 THEN
        CASE WHEN media > 0 AND (v-media)/media >= 1.0  THEN 'DESVIO_ALTO'
             WHEN media > 0 AND (v-media)/media <= -1.0 THEN 'DESVIO_BAIXO'
             ELSE 'AMOSTRA_PEQUENA' END
      WHEN v > (media + (3.0 * mad)) THEN 'PICO_OUTLIER'
      WHEN v < (media - (3.0 * mad)) THEN 'MUITO_BAIXO'
      ELSE 'NORMAL'
    END AS status
  FROM com_mad
),
com_flags AS (
  SELECT *,
    CASE WHEN cnt_4 = 4 AND min_4 = max_4                                           THEN 1 ELSE 0 END AS eh_f03,
    CASE WHEN med_ant IS NOT NULL AND med_ant <> NroMedidor
          AND leit_atu_ant IS NOT NULL AND leit_atu_ant <> leitura_ant               THEN 1 ELSE 0 END AS eh_f04,
    CASE WHEN med_ant IS NOT NULL AND med_ant  = NroMedidor
          AND leit_atu_ant IS NOT NULL AND leit_atu_ant <> leitura_ant               THEN 1 ELSE 0 END AS eh_f05,
    CASE WHEN status IN ('PICO_OUTLIER','DESVIO_ALTO','MUITO_BAIXO','DESVIO_BAIXO') THEN 1 ELSE 0 END AS eh_estouro
  FROM classificado
),
reincidencia AS (
  SELECT id, seg,
    COALESCE(SUM(eh_estouro) OVER (
      PARTITION BY UC,Concessionaria,seg ORDER BY Mes_Ref ROWS BETWEEN 11 PRECEDING AND 1 PRECEDING
    ), 0) AS estouros_prev
  FROM com_flags
),
seg_alerta AS (
  SELECT
    c.id, c.UC, c.Cod_Empresa, c.Concessionaria, c.Mes_Ref,
    c.Tp_Tensao, c.Link, c.RS_Total_Fatura, c.NroMedidor,
    c.med_ant, c.seg, c.dif_pct, c.eh_f03, c.eh_f04, c.eh_f05,
    CASE WHEN c.eh_f03 = 0 AND c.eh_f04 = 0 AND c.eh_f05 = 0
          AND c.dif_pct * 100 > 100.0
          AND c.status IN ('PICO_OUTLIER','DESVIO_ALTO')
         THEN 1 ELSE 0 END AS eh_f02
  FROM com_flags c
  JOIN reincidencia r ON r.id = c.id AND r.seg = c.seg
  WHERE c.status NOT IN ('NORMAL','INVALIDO','PLACEHOLDER','SEM_BASE','AMOSTRA_PEQUENA')
     OR c.eh_f04 = 1 OR c.eh_f05 = 1
),
f02_f05_por_fatura AS (
  SELECT
    id, UC, Cod_Empresa, Concessionaria, Mes_Ref, Tp_Tensao, Link, RS_Total_Fatura,
    MAX(NroMedidor)              AS NroMedidor,
    MAX(med_ant)                 AS nro_medidor_ant,
    ROUND(MAX(dif_pct) * 100, 1) AS desvio_pct_max,
    MAX(eh_f02)                  AS flag_f02,
    MAX(eh_f03)                  AS flag_f03,
    MAX(eh_f04)                  AS flag_f04,
    MAX(eh_f05)                  AS flag_f05,
    TRIM(BOTH ' | ' FROM CONCAT_WS(' | ',
      MAX(CASE WHEN (eh_f02=1 OR eh_f03=1 OR eh_f04=1 OR eh_f05=1) AND seg='P'  THEN 'P'  END),
      MAX(CASE WHEN (eh_f02=1 OR eh_f03=1 OR eh_f04=1 OR eh_f05=1) AND seg='FP' THEN 'FP' END),
      MAX(CASE WHEN (eh_f02=1 OR eh_f03=1 OR eh_f04=1 OR eh_f05=1) AND seg='R'  THEN 'R'  END)
    )) AS seg_f02_f05
  FROM seg_alerta
  GROUP BY id, UC, Cod_Empresa, Concessionaria, Mes_Ref, Tp_Tensao, Link, RS_Total_Fatura
)
SELECT
  b.id, b.UC, b.Cod_Empresa, b.Concessionaria, b.Mes_Ref, b.Tp_Tensao, b.NroMedidor,
  b.RAZAO_SOCIAL, b.Link, b.RS_Total_Fatura,
  COALESCE(f1.flag_f01,  0) AS flag_f01,
  COALESCE(f25.flag_f02, 0) AS flag_f02,
  COALESCE(f25.flag_f03, 0) AS flag_f03,
  COALESCE(f25.flag_f04, 0) AS flag_f04,
  COALESCE(f25.flag_f05, 0) AS flag_f05,
  (COALESCE(f1.flag_f01,0) + COALESCE(f25.flag_f02,0) + COALESCE(f25.flag_f03,0)
   + COALESCE(f25.flag_f04,0) + COALESCE(f25.flag_f05,0)) AS qtd_regras,
  TRIM(BOTH ' | ' FROM CONCAT_WS(' | ',
    CASE WHEN COALESCE(f1.flag_f01,  0) = 1 THEN 'F01' END,
    CASE WHEN COALESCE(f25.flag_f02, 0) = 1 THEN 'F02' END,
    CASE WHEN COALESCE(f25.flag_f03, 0) = 1 THEN 'F03' END,
    CASE WHEN COALESCE(f25.flag_f04, 0) = 1 THEN 'F04' END,
    CASE WHEN COALESCE(f25.flag_f05, 0) = 1 THEN 'F05' END
  )) AS fichas_aplicadas,
  f25.desvio_pct_max,
  CASE WHEN COALESCE(f25.flag_f04, 0) = 1
       THEN CONCAT(COALESCE(f25.nro_medidor_ant,''), ' > ', COALESCE(f25.NroMedidor,''))
       ELSE NULL END AS troca_medidor,
  TRIM(BOTH ' | ' FROM CONCAT_WS(' | ',
    CASE WHEN COALESCE(f1.flag_f01,  0) = 1
         THEN CONCAT('F01 - Divergencia formula (', COALESCE(f1.seg_f01,''), ')') END,
    CASE WHEN COALESCE(f25.flag_f02, 0) = 1
         THEN CONCAT('F02 - Desvio ', COALESCE(CAST(f25.desvio_pct_max AS CHAR),''), '% acima da media') END,
    CASE WHEN COALESCE(f25.flag_f03, 0) = 1
         THEN 'F03 - Acumulo: 4 faturas anteriores com valor identico' END,
    CASE WHEN COALESCE(f25.flag_f04, 0) = 1
         THEN CONCAT('F04 - Troca medidor: ', COALESCE(f25.nro_medidor_ant,''), ' > ', COALESCE(f25.NroMedidor,'')) END,
    CASE WHEN COALESCE(f25.flag_f05, 0) = 1
         THEN 'F05 - Quebra de continuidade de leitura' END
  )) AS detalhamento
FROM base_raw b
LEFT JOIN f01_resultado   f1  ON f1.id  = b.id
LEFT JOIN f02_f05_por_fatura f25 ON f25.id = b.id
WHERE COALESCE(f1.flag_f01,  0) = 1
   OR COALESCE(f25.flag_f02, 0) = 1
   OR COALESCE(f25.flag_f03, 0) = 1
   OR COALESCE(f25.flag_f04, 0) = 1
   OR COALESCE(f25.flag_f05, 0) = 1`

// filtroFicha retorna a cláusula WHERE adicional para filtrar por ficha.
// Agora usa Faturas_Registradas_Cache.fichas_apontadas (CSV unificado, F01-F14).
func filtroFicha(ficha string) string {
	upper := strings.ToUpper(strings.TrimSpace(ficha))
	if len(upper) != 3 || upper[0] != 'F' {
		return ""
	}
	// FIND_IN_SET é mais preciso que LIKE pra evitar match parcial (F01 vs F010)
	return " AND FIND_IN_SET('" + upper + "', f.fichas_apontadas) > 0"
}

func escapeLike(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(value)
}

func buildFichaFilters(c *gin.Context) (string, []any) {
	var sb strings.Builder
	args := make([]any, 0, 12)

	if fichaList := strings.TrimSpace(c.Query("fichas")); fichaList != "" {
		parts := strings.Split(fichaList, ",")
		valid := make([]string, 0, len(parts))
		for _, part := range parts {
			normalized := strings.ToUpper(strings.TrimSpace(part))
			if len(normalized) == 3 && normalized[0] == 'F' {
				valid = append(valid, "FIND_IN_SET('"+normalized+"', fichas_apontadas) > 0")
			}
		}
		if len(valid) > 0 {
			sb.WriteString(" AND (")
			sb.WriteString(strings.Join(valid, " OR "))
			sb.WriteString(")")
		}
	}

	if uc := strings.TrimSpace(c.Query("uc")); uc != "" {
		sb.WriteString(" AND LOWER(COALESCE(UC, '')) LIKE ? ESCAPE '\\\\'")
		args = append(args, "%"+strings.ToLower(escapeLike(uc))+"%")
	}

	if cliente := strings.TrimSpace(c.Query("cliente")); cliente != "" {
		sb.WriteString(" AND LOWER(COALESCE(RAZAO_SOCIAL, '')) LIKE ? ESCAPE '\\\\'")
		args = append(args, "%"+strings.ToLower(escapeLike(cliente))+"%")
	}

	if distribuidora := strings.TrimSpace(c.Query("distribuidora")); distribuidora != "" {
		sb.WriteString(" AND Concessionaria = ?")
		args = append(args, distribuidora)
	}

	if periodoInicio := strings.TrimSpace(c.Query("periodo_inicio")); periodoInicio != "" {
		sb.WriteString(" AND COALESCE(Mes_Ref, '') >= ?")
		args = append(args, periodoInicio)
	}

	if periodoFim := strings.TrimSpace(c.Query("periodo_fim")); periodoFim != "" {
		sb.WriteString(" AND COALESCE(Mes_Ref, '') <= ?")
		args = append(args, periodoFim)
	}

	if valorMin := strings.TrimSpace(c.Query("valor_min")); valorMin != "" {
		if parsed, err := strconv.ParseFloat(valorMin, 64); err == nil {
			sb.WriteString(" AND COALESCE(RS_Total_Fatura, 0) >= ?")
			args = append(args, parsed)
		}
	}

	if valorMax := strings.TrimSpace(c.Query("valor_max")); valorMax != "" {
		if parsed, err := strconv.ParseFloat(valorMax, 64); err == nil {
			sb.WriteString(" AND COALESCE(RS_Total_Fatura, 0) <= ?")
			args = append(args, parsed)
		}
	}

	if desvioMin := strings.TrimSpace(c.Query("desvio_min")); desvioMin != "" {
		if parsed, err := strconv.ParseFloat(desvioMin, 64); err == nil {
			sb.WriteString(" AND COALESCE(desvio_pct_max, 0) >= ?")
			args = append(args, parsed)
		}
	}

	if busca := strings.TrimSpace(c.Query("search")); busca != "" {
		pattern := "%" + strings.ToLower(escapeLike(busca)) + "%"
		sb.WriteString(" AND (")
		sb.WriteString(strings.Join([]string{
			"LOWER(COALESCE(CAST(UC AS CHAR), '')) LIKE ? ESCAPE '\\\\'",
			"LOWER(COALESCE(RAZAO_SOCIAL, '')) LIKE ? ESCAPE '\\\\'",
			"LOWER(COALESCE(Concessionaria, '')) LIKE ? ESCAPE '\\\\'",
			"LOWER(COALESCE(Mes_Ref, '')) LIKE ? ESCAPE '\\\\'",
			"LOWER(COALESCE(fichas_aplicadas, '')) LIKE ? ESCAPE '\\\\'",
			"LOWER(COALESCE(detalhamento, '')) LIKE ? ESCAPE '\\\\'",
		}, " OR "))
		sb.WriteString(")")
		for i := 0; i < 6; i++ {
			args = append(args, pattern)
		}
	}

	return sb.String(), args
}

// queryFichaSQL lê de fichas_anomalias_cache no db_ressarcimento (cache local).
func queryFichaSQL(c *gin.Context, ficha string) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco local não disponível"})
		return
	}

	limitStr := c.DefaultQuery("limit", "2000")
	offsetStr := c.DefaultQuery("offset", "0")
	limit, _ := strconv.Atoi(limitStr)
	offset, _ := strconv.Atoi(offsetStr)
	if limit <= 0 || limit > 10000 {
		limit = 2000
	}
	if offset < 0 {
		offset = 0
	}

	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	filtro := filtroFicha(ficha)
	filtroExtra, filtroArgs := buildFichaFilters(c)
	// Fonte nova: Faturas_Registradas_Cache.fichas_apontadas (CSV F01-F14, populado pelo motor SQL via pipeline.py)
	base := "FROM Faturas_Registradas_Cache f WHERE f.fichas_apontadas IS NOT NULL AND f.fichas_apontadas != '' AND LOWER(COALESCE(f.UC,'')) NOT LIKE '%boleto%' AND LOWER(COALESCE(f.RAZAO_SOCIAL,'')) NOT LIKE '%boleto%' AND LOWER(COALESCE(f.Concessionaria,'')) NOT LIKE '%boleto%'" + filtro + filtroExtra

	// Contagem total
	var total int64
	countQuery := "SELECT COUNT(*) " + base
	countRow := sqlDB.QueryRow(countQuery, filtroArgs...)
	_ = countRow.Scan(&total)

	// Dados paginados — cliente via Tab_Empresa.Rz_Social (join por Cod_Empresa)
	// Extrai desvio_pct_max e fichas_aplicadas do JSON resultado_regras pra manter compatibilidade
	dataSQL := `SELECT
		f.id, f.UC, f.RAZAO_SOCIAL, f.Cod_Empresa, f.Concessionaria, f.Mes_Ref,
		f.RS_Total_Fatura, f.Link, f.fichas_apontadas AS fichas_aplicadas,
		COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(f.resultado_regras, '$.f01_f05.desvio_pct_max')) AS DECIMAL(8,2)), 0) AS desvio_pct_max,
		COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(f.resultado_regras, '$.f01_f05.qtd_regras')) AS UNSIGNED), 0) AS qtd_regras,
		COALESCE(JSON_UNQUOTE(JSON_EXTRACT(f.resultado_regras, '$.f01_f05.detalhamento')), '') AS detalhamento,
		f.resultado_analises,
		(SELECT e.Rz_Social FROM Tab_Empresa e WHERE e.Cod_Empresa = f.Cod_Empresa LIMIT 1) AS cliente
		` + base +
		" ORDER BY f.RS_Total_Fatura DESC LIMIT ? OFFSET ?"
	queryArgs := append(append([]any{}, filtroArgs...), limit, offset)
	rows, err := sqlDB.Query(dataSQL, queryArgs...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("erro ao consultar: %v", err)})
		return
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao ler colunas"})
		return
	}

	var result []map[string]any
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			continue
		}
		row := make(map[string]any, len(cols))
		for i, col := range cols {
			v := vals[i]
			if b, ok := v.([]byte); ok {
				row[col] = string(b)
			} else if v == nil {
				row[col] = nil
			} else {
				row[col] = v
			}
		}
		result = append(result, row)
	}
	if result == nil {
		result = []map[string]any{}
	}

	c.JSON(http.StatusOK, gin.H{
		"columns": cols,
		"rows":    result,
		"total":   total,
		"limit":   limit,
		"offset":  offset,
	})
}

func ListFicha01(c *gin.Context) { queryFichaSQL(c, "f01") }
func ListFicha02(c *gin.Context) { queryFichaSQL(c, "f02") }
func ListFicha03(c *gin.Context) { queryFichaSQL(c, "f03") }
func ListFicha04(c *gin.Context) { queryFichaSQL(c, "f04") }
func ListFicha05(c *gin.Context) { queryFichaSQL(c, "f05") }
func ListFicha13(c *gin.Context) { queryFichaSQL(c, "f13") }
// GetAnotacoesCampo retorna os registros de Anotacoes_Campo_IA para uma fatura.
func GetAnotacoesCampo(c *gin.Context) {
	idStr := c.Query("id_fatura")
	if idStr == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id_fatura obrigatório"})
		return
	}
	idFatura, err := strconv.Atoi(idStr)
	if err != nil || idFatura <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id_fatura inválido"})
		return
	}
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco não disponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}
	rows, err := sqlDB.Query(
		`SELECT campo, COALESCE(valor_extraido,'') AS valor_extraido,
		        COALESCE(confianca, 0) AS confianca,
		        COALESCE(motivo,'') AS motivo
		 FROM Anotacoes_Campo_IA
		 WHERE id_fatura = ?
		 ORDER BY confianca ASC, campo ASC`,
		idFatura,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	type Item struct {
		Campo         string  `json:"campo"`
		ValorExtraido string  `json:"valor_extraido"`
		Confianca     float64 `json:"confianca"`
		Motivo        string  `json:"motivo"`
	}
	var items []Item
	for rows.Next() {
		var it Item
		if err := rows.Scan(&it.Campo, &it.ValorExtraido, &it.Confianca, &it.Motivo); err == nil {
			items = append(items, it)
		}
	}
	if items == nil {
		items = []Item{}
	}
	c.JSON(http.StatusOK, gin.H{"anotacoes": items, "total": len(items)})
}

func ListFicha06(c *gin.Context) { queryFichaSQL(c, "f06") }
func ListFicha07(c *gin.Context) { queryFichaSQL(c, "f07") }
func ListFicha08(c *gin.Context) { queryFichaSQL(c, "f08") }
func ListFicha09(c *gin.Context) { queryFichaSQL(c, "f09") }
func ListFicha10(c *gin.Context) { queryFichaSQL(c, "f10") }
func ListFicha11(c *gin.Context) { queryFichaSQL(c, "f11") }
func ListFicha12(c *gin.Context) { queryFichaSQL(c, "f12") }
func ListFicha14(c *gin.Context) { queryFichaSQL(c, "f14") }

type salvarResultadoIAReq struct {
	ID                         int64    `json:"id"`
	IaStatus                   string   `json:"ia_status"`             // CONFIRMADO | FALSO_POSITIVO | INCONCLUSIVO
	IaFichasConfirmadas        string   `json:"ia_fichas_confirmadas"` // ex: "F02 | F04"
	ResultadoIA                string   `json:"resultado_ia"`          // texto completo do parecer
	ValorRessarcimentoEstimado *float64 `json:"valor_ressarcimento_estimado"`
}

var statusPermitidos = map[string]bool{
	"CONFIRMADO":     true,
	"FALSO_POSITIVO": true,
	"PENDENTE":       true,
}

func SalvarResultadoIAFicha(c *gin.Context) {
	var in salvarResultadoIAReq
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
		return
	}
	if in.ID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id obrigatório"})
		return
	}

	resultado := strings.TrimSpace(in.ResultadoIA)
	iaStatus := strings.ToUpper(strings.TrimSpace(in.IaStatus))

	if resultado == "" && in.ValorRessarcimentoEstimado == nil && iaStatus == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "informe ao menos resultado_ia, ia_status ou valor_ressarcimento_estimado"})
		return
	}

	// Valida ia_status se fornecido
	if iaStatus != "" && !statusPermitidos[iaStatus] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ia_status inválido — use: CONFIRMADO, FALSO_POSITIVO ou PENDENTE"})
		return
	}

	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco local não disponível"})
		return
	}

	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	_, err = sqlDB.Exec(`
		UPDATE fichas_anomalias_cache
		   SET resultado_ia                  = ?,
		       ia_status                     = CASE WHEN ? != '' THEN ? ELSE ia_status END,
		       ia_fichas_confirmadas         = CASE WHEN ? != '' THEN ? ELSE ia_fichas_confirmadas END,
		       valor_ressarcimento_estimado  = COALESCE(?, valor_ressarcimento_estimado),
		       resultado_salvo_em            = NOW()
		 WHERE id = ?`,
		resultado,
		iaStatus, iaStatus,
		strings.TrimSpace(in.IaFichasConfirmadas), strings.TrimSpace(in.IaFichasConfirmadas),
		in.ValorRessarcimentoEstimado,
		in.ID,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("erro ao salvar resultado: %v", err)})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"ok":                           true,
		"id":                           in.ID,
		"ia_status":                    iaStatus,
		"ia_fichas_confirmadas":        in.IaFichasConfirmadas,
		"resultado_ia":                 resultado,
		"valor_ressarcimento_estimado": in.ValorRessarcimentoEstimado,
		"resultado_salvo_em":           time.Now(),
	})
}

// ListFichaResumo retorna contagem de anomalias por ficha a partir do cache local.
func ListFichaResumo(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco local não disponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	// Conta de Faturas_Registradas_Cache.fichas_apontadas (fonte unificada F01-F14)
	var total, f01, f02, f03, f04, f05, f06, f07, f08, f09, f10, f11, f12, f13, f14 int64
	err = sqlDB.QueryRow(`
		SELECT
		  COUNT(*),
		  SUM(CASE WHEN FIND_IN_SET('F01', fichas_apontadas) > 0 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN FIND_IN_SET('F02', fichas_apontadas) > 0 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN FIND_IN_SET('F03', fichas_apontadas) > 0 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN FIND_IN_SET('F04', fichas_apontadas) > 0 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN FIND_IN_SET('F05', fichas_apontadas) > 0 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN FIND_IN_SET('F06', fichas_apontadas) > 0 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN FIND_IN_SET('F07', fichas_apontadas) > 0 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN FIND_IN_SET('F08', fichas_apontadas) > 0 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN FIND_IN_SET('F09', fichas_apontadas) > 0 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN FIND_IN_SET('F10', fichas_apontadas) > 0 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN FIND_IN_SET('F11', fichas_apontadas) > 0 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN FIND_IN_SET('F12', fichas_apontadas) > 0 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN FIND_IN_SET('F13', fichas_apontadas) > 0 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN FIND_IN_SET('F14', fichas_apontadas) > 0 THEN 1 ELSE 0 END)
		FROM Faturas_Registradas_Cache
		WHERE fichas_apontadas IS NOT NULL AND fichas_apontadas != ''`).
		Scan(&total, &f01, &f02, &f03, &f04, &f05, &f06, &f07, &f08, &f09, &f10, &f11, &f12, &f13, &f14)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao consultar resumo"})
		return
	}

	resumo := []gin.H{
		{"key": "f01", "nome": "F01 — Divergência de Fórmula", "total": f01},
		{"key": "f02", "nome": "F02 — Desvio de Média", "total": f02},
		{"key": "f03", "nome": "F03 — Acúmulo de Consumo", "total": f03},
		{"key": "f04", "nome": "F04 — Troca de Medidor", "total": f04},
		{"key": "f05", "nome": "F05 — Quebra de Leitura", "total": f05},
		{"key": "f06", "nome": "F06 — Ausência de Leituras", "total": f06},
		{"key": "f07", "nome": "F07 — Rollover de Medidor", "total": f07},
		{"key": "f08", "nome": "F08 — Troca sem Zeramento", "total": f08},
		{"key": "f09", "nome": "F09 — Leitura Estimada", "total": f09},
		{"key": "f10", "nome": "F10 — Tarifa Incorreta", "total": f10},
		{"key": "f11", "nome": "F11 — Demanda Contratada", "total": f11},
		{"key": "f12", "nome": "F12 — Ausência de Medição", "total": f12},
		{"key": "f13", "nome": "F13 — Consumo Zero com Demanda/Reativo", "total": f13},
		{"key": "f14", "nome": "F14 — Outros Erros IA", "total": f14},
	}

	c.JSON(http.StatusOK, gin.H{"fichas": resumo, "total_detectadas": total})
}

// GetUCFaturas retorna todas as faturas de uma UC no banco de faturas.
func GetUCFaturas(c *gin.Context) {
	uc := c.Query("uc")
	if uc == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "parâmetro uc obrigatório"})
		return
	}
	db := database.GormDB_Faturas
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco de faturas não disponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	rows, err := sqlDB.Query(
		`SELECT id, UC, RAZAO_SOCIAL, Concessionaria, Mes_Ref, Tp_Tensao, NroMedidor,
		        KWH_Ponta, KWH_FPonta, KWH_Reservado, KWH_Total, Media_Consumo,
		        Leitura_Anterior_KWH_FP, Leitura_Atual_KWH_FP,
		        RS_Total_Fatura, Status_Fatura, Link
		 FROM Faturas_Registradas_Cache
		 WHERE UC = ?
		 ORDER BY Mes_Ref DESC
		 LIMIT 200`, uc)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao consultar: " + err.Error()})
		return
	}
	defer rows.Close()

	cols, _ := rows.Columns()
	var result []map[string]any
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if rows.Scan(ptrs...) != nil {
			continue
		}
		row := make(map[string]any, len(cols))
		for i, col := range cols {
			v := vals[i]
			if b, ok := v.([]byte); ok {
				row[col] = string(b)
			} else if v == nil {
				row[col] = nil
			} else {
				row[col] = v
			}
		}
		result = append(result, row)
	}
	if result == nil {
		result = []map[string]any{}
	}
	c.JSON(http.StatusOK, gin.H{"columns": cols, "rows": result})
}

// GetUCConsumoChart retorna dados estruturados para o gráfico de consumo F02.
// Query: ?uc=E5041338872&mes_ref=2022-11
// Retorna pontos com tipo: "historico", "auditado", "posterior"
// GetUCsResumo retorna 1 linha por UC com dados agregados: qtd faturas, erros, % erros, última fatura.
func GetUCsResumo(c *gin.Context) {
	empresa := c.Query("empresa") // cod_empresa opcional
	busca   := c.Query("busca")   // filtro livre por UC/cliente

	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	where := "WHERE frc.UC IS NOT NULL AND frc.UC != '' AND TRIM(frc.UC) != ''"
	args  := []interface{}{}
	if empresa != "" {
		where += " AND frc.Cod_Empresa = ?"
		args = append(args, empresa)
	}
	if busca != "" {
		where += " AND (frc.UC LIKE ? OR frc.RAZAO_SOCIAL LIKE ?)"
		like := "%" + busca + "%"
		args = append(args, like, like)
	}

	query := fmt.Sprintf(`
		SELECT
			frc.UC,
			COALESCE(MAX(frc.RAZAO_SOCIAL), '')                        AS cliente,
			COALESCE(MAX(frc.Concessionaria), '')                       AS distribuidora,
			COALESCE(MAX(frc.Cod_Empresa), 0)                           AS cod_empresa,
			COUNT(DISTINCT frc.id)                                      AS quantidade_faturas,
			COUNT(DISTINCT fac.id)                                      AS quantidade_erros,
			ROUND(COUNT(DISTINCT fac.id) * 100.0 / COUNT(DISTINCT frc.id), 1) AS percentual_erros,
			MAX(DATE_FORMAT(frc.Mes_Ref, '%%Y-%%m'))                    AS ultima_fatura,
			COALESCE(MAX(fac.desvio_pct_max), 0)                        AS max_desvio,
			COALESCE(SUM(CASE WHEN fac.ia_status = 'CONFIRMADO'
				THEN COALESCE(fac.valor_ressarcimento_estimado, 0) ELSE 0 END), 0) AS ressarcimento_confirmado,
			MAX(CASE WHEN fac.fichas_aplicadas LIKE '%%F01%%' THEN 1 ELSE 0 END) AS tem_f01,
			MAX(CASE WHEN fac.fichas_aplicadas LIKE '%%F02%%' THEN 1 ELSE 0 END) AS tem_f02,
			MAX(CASE WHEN fac.fichas_aplicadas LIKE '%%F03%%' THEN 1 ELSE 0 END) AS tem_f03,
			MAX(CASE WHEN fac.fichas_aplicadas LIKE '%%F04%%' THEN 1 ELSE 0 END) AS tem_f04,
			MAX(CASE WHEN fac.fichas_aplicadas LIKE '%%F05%%' THEN 1 ELSE 0 END) AS tem_f05,
			MAX(CASE WHEN fac.fichas_aplicadas LIKE '%%F06%%' THEN 1 ELSE 0 END) AS tem_f06,
			MAX(CASE WHEN fac.fichas_aplicadas LIKE '%%F07%%' THEN 1 ELSE 0 END) AS tem_f07,
			MAX(CASE WHEN fac.fichas_aplicadas LIKE '%%F08%%' THEN 1 ELSE 0 END) AS tem_f08,
			MAX(CASE WHEN fac.fichas_aplicadas LIKE '%%F09%%' THEN 1 ELSE 0 END) AS tem_f09,
			MAX(CASE WHEN fac.fichas_aplicadas LIKE '%%F10%%' THEN 1 ELSE 0 END) AS tem_f10,
			MAX(CASE WHEN fac.fichas_aplicadas LIKE '%%F11%%' THEN 1 ELSE 0 END) AS tem_f11,
			MAX(CASE WHEN fac.fichas_aplicadas LIKE '%%F12%%' THEN 1 ELSE 0 END) AS tem_f12,
			MAX(CASE WHEN fac.fichas_aplicadas LIKE '%%F13%%' THEN 1 ELSE 0 END) AS tem_f13,
			MAX(CASE WHEN fac.fichas_aplicadas LIKE '%%F14%%' THEN 1 ELSE 0 END) AS tem_f14
		FROM Faturas_Registradas_Cache frc
		LEFT JOIN fichas_anomalias_cache fac ON fac.id = frc.id AND fac.deletado = 0
		%s
		GROUP BY frc.UC
		ORDER BY quantidade_erros DESC, quantidade_faturas DESC
		LIMIT 1000
	`, where)

	rows, err := sqlDB.Query(query, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	type UCResumo struct {
		UC                      string   `json:"uc"`
		Cliente                 string   `json:"cliente"`
		Distribuidora           string   `json:"distribuidora"`
		CodEmpresa              int      `json:"cod_empresa"`
		QuantidadeFaturas       int      `json:"quantidade_faturas"`
		QuantidadeErros         int      `json:"quantidade_erros"`
		PercentualErros         float64  `json:"percentual_erros"`
		UltimaFatura            string   `json:"ultima_fatura"`
		MaxDesvio               float64  `json:"max_desvio"`
		RessarcimentoConfirmado float64  `json:"ressarcimento_confirmado"`
		Fichas                  []string `json:"fichas"` // ex: ["F01","F02"]
	}

	var ucs []UCResumo
	for rows.Next() {
		var u UCResumo
		var temF01, temF02, temF03, temF04, temF05, temF06, temF07, temF08, temF09, temF10, temF11, temF12, temF13, temF14 int
		if err := rows.Scan(
			&u.UC, &u.Cliente, &u.Distribuidora, &u.CodEmpresa,
			&u.QuantidadeFaturas, &u.QuantidadeErros, &u.PercentualErros,
			&u.UltimaFatura, &u.MaxDesvio, &u.RessarcimentoConfirmado,
			&temF01, &temF02, &temF03, &temF04, &temF05,
			&temF06, &temF07, &temF08, &temF09, &temF10, &temF11, &temF12,
			&temF13, &temF14,
		); err == nil {
			fichas := []string{}
			if temF01 == 1 { fichas = append(fichas, "F01") }
			if temF02 == 1 { fichas = append(fichas, "F02") }
			if temF03 == 1 { fichas = append(fichas, "F03") }
			if temF04 == 1 { fichas = append(fichas, "F04") }
			if temF05 == 1 { fichas = append(fichas, "F05") }
			if temF06 == 1 { fichas = append(fichas, "F06") }
			if temF07 == 1 { fichas = append(fichas, "F07") }
			if temF08 == 1 { fichas = append(fichas, "F08") }
			if temF09 == 1 { fichas = append(fichas, "F09") }
			if temF10 == 1 { fichas = append(fichas, "F10") }
			if temF11 == 1 { fichas = append(fichas, "F11") }
			if temF12 == 1 { fichas = append(fichas, "F12") }
			if temF13 == 1 { fichas = append(fichas, "F13") }
			if temF14 == 1 { fichas = append(fichas, "F14") }
			u.Fichas = fichas
			ucs = append(ucs, u)
		}
	}
	if ucs == nil {
		ucs = []UCResumo{}
	}
	c.JSON(http.StatusOK, gin.H{"ucs": ucs, "total": len(ucs)})
}

func GetUCConsumoChart(c *gin.Context) {
	uc     := c.Query("uc")
	mesRef := c.Query("mes_ref") // "YYYY-MM"
	if uc == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "parâmetro uc obrigatório"})
		return
	}
	// fichas_anomalias_cache só existe em db_ressarcimento (GormDB_App).
	// Faturas_Registradas_Cache também existe lá (espelhada pelo pipeline).
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco não disponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Verifica se a tabela FATURA_DADOS_EXTRAIDOS existe para usar valores enriquecidos da IA.
	var fdeExists int
	_ = sqlDB.QueryRow(`SELECT COUNT(*) FROM information_schema.TABLES
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'FATURA_DADOS_EXTRAIDOS'`).Scan(&fdeExists)

	// Busca todos os registros com consumo real + NroMedidor para detectar troca.
	// A classificação historico/auditado/posterior é feita em Go pelo mesRef.
	// Quando FATURA_DADOS_EXTRAIDOS existe, usa seus valores (extraídos da fatura pelo OCR/IA)
	// via COALESCE — fonte mais confiável que os campos sumarizados de Faturas_Registradas_Cache.
	var baseQuery string
	if fdeExists > 0 {
		baseQuery = `
		SELECT DATE_FORMAT(frc.Mes_Ref, '%Y-%m') AS mes,
		       COALESCE(fde.consumo_ativo_fponta_kwh, frc.KWH_FPonta,    0) AS kwh_fp,
		       COALESCE(fde.consumo_ativo_ponta_kwh,  frc.KWH_Ponta,     0) AS kwh_p,
		       COALESCE(frc.KWH_Reservado, 0) AS kwh_r,
		       COALESCE(fde.consumo_ativo_fponta_kwh, frc.KWH_FPonta, 0)
		         + COALESCE(fde.consumo_ativo_ponta_kwh, frc.KWH_Ponta, 0)
		         + COALESCE(frc.KWH_Reservado, 0) AS kwh_total,
		       COALESCE(fde.valor_total_fatura, frc.RS_Total_Fatura, 0) AS rs_total,
		       COALESCE(frc.NroMedidor, '') AS nro_medidor,
		       COALESCE(frc.Link, '') AS link,
		       CASE WHEN fac.id IS NOT NULL THEN 1 ELSE 0 END AS anomalia,
		       COALESCE(fac.fichas_aplicadas, '') AS fichas,
		       COALESCE(NULLIF(fac.ia_status,''),
		           CASE WHEN frc.analise_IA IS NOT NULL AND frc.analise_IA != ''
		                THEN CASE WHEN frc.anomalia_encontrada = 1 THEN 'CONFIRMADO' ELSE 'FALSO_POSITIVO' END
		                ELSE '' END
		       ) AS ia_status_fac,
		       COALESCE(fac.id, 0) AS fac_id,
		       frc.id AS fatura_id,
		       COALESCE(fac.detalhamento, '') AS detalhamento,
		       COALESCE(frc.RAZAO_SOCIAL, '') AS razao_social,
		       COALESCE(frc.Concessionaria, '') AS concessionaria,
		       COALESCE(fac.aprovado, 0) AS aprovado,
		       COALESCE(NULLIF(fac.resultado_ia,''), frc.analise_IA, '') AS resultado_ia,
		       COALESCE(fac.valor_ressarcimento_estimado, 0) AS valor_ressarcimento,
		       COALESCE(fac.ia_fichas_confirmadas, '') AS ia_fichas_confirmadas
		FROM Faturas_Registradas_Cache frc
		LEFT JOIN FATURA_DADOS_EXTRAIDOS fde ON fde.fatura_id = frc.id
		LEFT JOIN fichas_anomalias_cache fac ON fac.id = frc.id AND fac.deletado = 0
		WHERE frc.UC = ?
		  AND (COALESCE(fde.consumo_ativo_fponta_kwh, frc.KWH_FPonta, 0)
		         + COALESCE(fde.consumo_ativo_ponta_kwh, frc.KWH_Ponta, 0)
		         + COALESCE(frc.KWH_Reservado, 0) > 0
		       OR COALESCE(frc.KWH_Total, 0) > 0
		       OR DATE_FORMAT(frc.Mes_Ref, '%Y-%m') = ?)
		ORDER BY frc.Mes_Ref ASC`
	} else {
		baseQuery = `
		SELECT DATE_FORMAT(frc.Mes_Ref, '%Y-%m') AS mes,
		       COALESCE(frc.KWH_FPonta,    0) AS kwh_fp,
		       COALESCE(frc.KWH_Ponta,     0) AS kwh_p,
		       COALESCE(frc.KWH_Reservado, 0) AS kwh_r,
		       COALESCE(frc.KWH_FPonta, 0) + COALESCE(frc.KWH_Ponta, 0) + COALESCE(frc.KWH_Reservado, 0) AS kwh_total,
		       COALESCE(frc.RS_Total_Fatura, 0) AS rs_total,
		       COALESCE(frc.NroMedidor, '') AS nro_medidor,
		       COALESCE(frc.Link, '') AS link,
		       CASE WHEN fac.id IS NOT NULL THEN 1 ELSE 0 END AS anomalia,
		       COALESCE(fac.fichas_aplicadas, '') AS fichas,
		       COALESCE(NULLIF(fac.ia_status,''),
		           CASE WHEN frc.analise_IA IS NOT NULL AND frc.analise_IA != ''
		                THEN CASE WHEN frc.anomalia_encontrada = 1 THEN 'CONFIRMADO' ELSE 'FALSO_POSITIVO' END
		                ELSE '' END
		       ) AS ia_status_fac,
		       COALESCE(fac.id, 0) AS fac_id,
		       frc.id AS fatura_id,
		       COALESCE(fac.detalhamento, '') AS detalhamento,
		       COALESCE(frc.RAZAO_SOCIAL, '') AS razao_social,
		       COALESCE(frc.Concessionaria, '') AS concessionaria,
		       COALESCE(fac.aprovado, 0) AS aprovado,
		       COALESCE(NULLIF(fac.resultado_ia,''), frc.analise_IA, '') AS resultado_ia,
		       COALESCE(fac.valor_ressarcimento_estimado, 0) AS valor_ressarcimento,
		       COALESCE(fac.ia_fichas_confirmadas, '') AS ia_fichas_confirmadas
		FROM Faturas_Registradas_Cache frc
		LEFT JOIN fichas_anomalias_cache fac ON fac.id = frc.id AND fac.deletado = 0
		WHERE frc.UC = ?
		  AND (COALESCE(frc.KWH_FPonta, 0) + COALESCE(frc.KWH_Ponta, 0) + COALESCE(frc.KWH_Reservado, 0) > 0
		       OR COALESCE(frc.KWH_Total, 0) > 0
		       OR DATE_FORMAT(frc.Mes_Ref, '%Y-%m') = ?)
		ORDER BY frc.Mes_Ref ASC`
	}
	rows, err := sqlDB.Query(baseQuery, uc, mesRef)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	type rawPonto struct {
		Mes               string
		KwhFP             float64
		KwhP              float64
		KwhR              float64
		KwhTotal          float64
		RsTotal           float64
		NroMedidor        string
		Link              string
		Anomalia          int
		Fichas            string
		IAStatus          string
		FacID             int64
		FaturaID          int64
		Detalhamento      string
		RazaoSocial       string
		Concessionaria    string
		Aprovado          int
		ResultadoIA       string
		ValorRessarcimento float64
		IAFichasConfirmadas string
	}

	var raw []rawPonto
	var somaHist float64
	var cntHist  int

	for rows.Next() {
		var p rawPonto
		if err := rows.Scan(&p.Mes, &p.KwhFP, &p.KwhP, &p.KwhR, &p.KwhTotal, &p.RsTotal, &p.NroMedidor, &p.Link, &p.Anomalia, &p.Fichas, &p.IAStatus, &p.FacID, &p.FaturaID, &p.Detalhamento, &p.RazaoSocial, &p.Concessionaria, &p.Aprovado, &p.ResultadoIA, &p.ValorRessarcimento, &p.IAFichasConfirmadas); err != nil {
			continue
		}
		if mesRef == "" || p.Mes < mesRef {
			somaHist += p.KwhTotal
			cntHist++
		}
		raw = append(raw, p)
	}

	media := 0.0
	if cntHist > 0 {
		media = somaHist / float64(cntHist)
	}

	// Calcular MAD (Median Absolute Deviation) sobre os pontos históricos
	mad := 0.0
	if cntHist > 1 {
		// Coleta valores históricos para calcular MAD
		histVals := make([]float64, 0, cntHist)
		for _, p := range raw {
			if mesRef == "" || p.Mes < mesRef {
				histVals = append(histVals, p.KwhTotal)
			}
		}
		// MAD = median(|xi - median(x)|)
		// Usamos média como aproximação (mais simples, sem sort completo)
		var somaAbsDev float64
		for _, v := range histVals {
			diff := v - media
			if diff < 0 {
				diff = -diff
			}
			somaAbsDev += diff
		}
		mad = somaAbsDev / float64(len(histVals))
	}

	type Ponto struct {
		Mes                 string   `json:"mes"`
		KwhFP               float64  `json:"kwh_fp"`
		KwhP                float64  `json:"kwh_p"`
		KwhR                float64  `json:"kwh_r"`
		KwhTotal            float64  `json:"kwh_total"`
		RsTotal             float64  `json:"rs_total"`
		Tipo                string   `json:"tipo"`
		DifPct              *float64 `json:"dif_pct"`
		TrocaMedidor        bool     `json:"troca_medidor"`
		Link                string   `json:"link"`
		Anomalia            bool     `json:"anomalia"`
		Fichas              string   `json:"fichas"`
		IAStatus            string   `json:"ia_status"`
		FacID               int64    `json:"fac_id"`
		FaturaID            int64    `json:"fatura_id"`
		Detalhamento        string   `json:"detalhamento"`
		RazaoSocial         string   `json:"razao_social"`
		Concessionaria      string   `json:"concessionaria"`
		Aprovado            bool     `json:"aprovado"`
		ResultadoIA         string   `json:"resultado_ia"`
		ValorRessarcimento  float64  `json:"valor_ressarcimento"`
		IAFichasConfirmadas string   `json:"ia_fichas_confirmadas"`
	}

	var pontos []Ponto
	prevMedidor := ""
	for _, r := range raw {
		var tipo string
		if mesRef == "" || r.Mes < mesRef {
			tipo = "historico"
		} else if r.Mes == mesRef {
			tipo = "auditado"
		} else {
			tipo = "posterior"
		}

		var difPct *float64
		if media > 0 {
			v := (r.KwhTotal - media) / media * 100.0
			difPct = &v
		}

		troca := prevMedidor != "" && r.NroMedidor != "" && r.NroMedidor != prevMedidor
		if r.NroMedidor != "" {
			prevMedidor = r.NroMedidor
		}

		pontos = append(pontos, Ponto{
			Mes:                 r.Mes,
			KwhFP:               r.KwhFP,
			KwhP:                r.KwhP,
			KwhR:                r.KwhR,
			KwhTotal:            r.KwhTotal,
			RsTotal:             r.RsTotal,
			Tipo:                tipo,
			DifPct:              difPct,
			TrocaMedidor:        troca,
			Link:                r.Link,
			Anomalia:            r.Anomalia == 1,
			Fichas:              r.Fichas,
			IAStatus:            r.IAStatus,
			FacID:               r.FacID,
			FaturaID:            r.FaturaID,
			Detalhamento:        r.Detalhamento,
			RazaoSocial:         r.RazaoSocial,
			Concessionaria:      r.Concessionaria,
			Aprovado:            r.Aprovado == 1,
			ResultadoIA:         r.ResultadoIA,
			ValorRessarcimento:  r.ValorRessarcimento,
			IAFichasConfirmadas: r.IAFichasConfirmadas,
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"uc":      uc,
		"mes_ref": mesRef,
		"media":   media,
		"mad":     mad,
		"pontos":  pontos,
	})
}

// processoVinculadoItem representa um processo vinculado a uma UC.
type processoVinculadoItem struct {
	IDProcesso              int64  `json:"id_processo"`
	Etapa                   string `json:"etapa"`
	SubEtapa                string `json:"sub_etapa"`
	UltimaMovimentacao      string `json:"ultima_movimentacao"`
	PeriosIrregularidade    string `json:"periodos_irregularidade"`
	DescricaoIrregularidade string `json:"descricao_irregularidade"`
}

// GET /api/v1/faturas/ficha/processo-vinculado?uc=XXXX
// GetProcessoVinculado busca processos vinculados a uma UC no banco principal.
func GetProcessoVinculado(c *gin.Context) {
	uc := strings.TrimSpace(c.Query("uc"))
	if uc == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "uc obrigatório"})
		return
	}
	dbApp := database.GormDB_App
	if dbApp == nil {
		c.JSON(http.StatusOK, gin.H{"processos": []processoVinculadoItem{}})
		return
	}
	sqlDB, err := dbApp.DB()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"processos": []processoVinculadoItem{}})
		return
	}

	query := `
		SELECT
			p.id_processo,
			COALESCE(e.etapa, '') AS etapa,
			COALESCE(p.sub_etapa, '') AS sub_etapa,
			COALESCE(
				(SELECT DATE_FORMAT(MAX(h.data_movimentacao), '%d/%m/%Y %H:%i')
				 FROM FT_HISTORICO_MOVIMENTACOES h
				 WHERE h.id_requisicao = p.id_processo),
				''
			) AS ultima_movimentacao,
			COALESCE(p.periodos_irregularidade, '') AS periodos_irregularidade,
			COALESCE(p.descricao_irregularidade, '') AS descricao_irregularidade
		FROM FT_PROCESSOS p
		LEFT JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
		WHERE TRIM(p.uc) = TRIM(?)
		ORDER BY p.data_criacao DESC
	`
	rows, err := sqlDB.QueryContext(c.Request.Context(), query, uc)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"processos": []processoVinculadoItem{}})
		return
	}
	defer rows.Close()

	var processos []processoVinculadoItem
	for rows.Next() {
		var item processoVinculadoItem
		if err := rows.Scan(
			&item.IDProcesso,
			&item.Etapa,
			&item.SubEtapa,
			&item.UltimaMovimentacao,
			&item.PeriosIrregularidade,
			&item.DescricaoIrregularidade,
		); err == nil {
			processos = append(processos, item)
		}
	}
	if processos == nil {
		processos = []processoVinculadoItem{}
	}

	// Busca links das faturas por período (GormDB_Faturas)
	faturaLinks := map[string]string{}
	if dbFat := database.GormDB_Faturas; dbFat != nil {
		if sqlFat, err2 := dbFat.DB(); err2 == nil {
			fatRows, err2 := sqlFat.QueryContext(c.Request.Context(),
				`SELECT DATE_FORMAT(Mes_Ref, '%Y-%m') AS periodo, MAX(Link) AS link
				 FROM fichas_anomalias_cache
				 WHERE TRIM(UC) = TRIM(?) AND Link IS NOT NULL AND Link != ''
				 GROUP BY periodo`,
				uc,
			)
			if err2 == nil {
				defer fatRows.Close()
				for fatRows.Next() {
					var periodo, link string
					if fatRows.Scan(&periodo, &link) == nil && periodo != "" {
						faturaLinks[periodo] = link
					}
				}
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{"processos": processos, "fatura_links": faturaLinks})
}

// GetFaturasAnalisadas retorna todas as faturas analisadas pela IA,
// com JOIN em fichas_anomalias_cache para puxar valor ressarcimento e fichas confirmadas.
func GetFaturasAnalisadas(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "DB indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// suporta tanto page/per_page quanto limit/offset
	pageStr   := c.DefaultQuery("page",     "1")
	perPage   := c.DefaultQuery("per_page", "")
	limitStr  := c.DefaultQuery("limit",    "50")
	offsetStr := c.DefaultQuery("offset",   "0")
	limit, _  := strconv.Atoi(limitStr)
	offset, _ := strconv.Atoi(offsetStr)
	if perPage != "" {
		pp, _ := strconv.Atoi(perPage)
		pg, _ := strconv.Atoi(pageStr)
		if pp > 0 && pp <= 5000 { limit = pp }
		if pg > 0 { offset = (pg - 1) * limit }
	}
	if limit <= 0 || limit > 5000 { limit = 50 }
	if offset < 0 { offset = 0 }

	empresa    := strings.TrimSpace(c.Query("empresa"))
	anomalia   := strings.TrimSpace(c.Query("anomalia"))   // "1" | "0" | ""
	search     := strings.TrimSpace(c.Query("search"))
	distribuidora := strings.TrimSpace(c.Query("distribuidora"))
	periodoInicio := strings.TrimSpace(c.Query("periodo_inicio"))
	periodoFim    := strings.TrimSpace(c.Query("periodo_fim"))
	fichasFiltro  := strings.TrimSpace(c.Query("fichas"))  // "F02" | "F01,F03" | ""
	decisaoFiltro := strings.TrimSpace(c.Query("decisao")) // "PENDENTE"|"CONFIRMADO"|"FALSO_POSITIVO"|"INCONCLUSIVO"
	sortParam     := strings.TrimSpace(c.Query("sort"))    // "valor_desc"|"score_desc"|"recente"

	where := "WHERE frc.analise_IA IS NOT NULL"
	args  := []interface{}{}

	if empresa != "" {
		where += " AND frc.Cod_Empresa = ?"
		args = append(args, empresa)
	}
	if anomalia == "1" {
		where += " AND frc.anomalia_encontrada = 1"
	} else if anomalia == "0" {
		where += " AND (frc.anomalia_encontrada = 0 OR frc.anomalia_encontrada IS NULL)"
	}
	if distribuidora != "" {
		where += " AND frc.Concessionaria = ?"
		args = append(args, distribuidora)
	}
	if periodoInicio != "" {
		where += " AND frc.Mes_Ref >= ?"
		args = append(args, periodoInicio)
	}
	if periodoFim != "" {
		where += " AND frc.Mes_Ref <= ?"
		args = append(args, periodoFim)
	}
	if search != "" {
		pattern := "%" + strings.ToLower(escapeLike(search)) + "%"
		where += " AND (LOWER(COALESCE(CAST(frc.UC AS CHAR),'')) LIKE ? ESCAPE '\\\\'" +
			" OR LOWER(COALESCE(frc.RAZAO_SOCIAL,'')) LIKE ? ESCAPE '\\\\'" +
			" OR LOWER(COALESCE(frc.Concessionaria,'')) LIKE ? ESCAPE '\\\\')"
		args = append(args, pattern, pattern, pattern)
	}
	if fichasFiltro != "" {
		parts := strings.Split(fichasFiltro, ",")
		var conds []string
		for _, f := range parts {
			f = strings.ToUpper(strings.TrimSpace(f))
			if f == "F01" || f == "F02" || f == "F03" || f == "F04" || f == "F05" {
				conds = append(conds, "UPPER(COALESCE(fa.ia_fichas_confirmadas,'')) LIKE '%"+f+"%'")
			}
		}
		if len(conds) > 0 {
			where += " AND (" + strings.Join(conds, " OR ") + ")"
		}
	}
	allowed := map[string]bool{"PENDENTE": true, "CONFIRMADO": true, "FALSO_POSITIVO": true, "INCONCLUSIVO": true}
	if allowed[decisaoFiltro] {
		where += " AND fa.ia_status = ?"
		args = append(args, decisaoFiltro)
	}

	orderBy := "frc.ia_analisado_em DESC"
	switch sortParam {
	case "valor_desc":
		orderBy = "fa.valor_ressarcimento_estimado DESC, frc.ia_analisado_em DESC"
	case "score_desc":
		orderBy = "frc.ia_analisado_em DESC" // score calculado em Go; mantém recente como proxy
	}

	countSQL := "SELECT COUNT(*) FROM Faturas_Registradas_Cache frc " +
		"LEFT JOIN fichas_anomalias_cache fa ON fa.id = frc.id AND COALESCE(fa.deletado,0) = 0 " + where
	var total int64
	_ = sqlDB.QueryRow(countSQL, args...).Scan(&total)

	dataSQL := `SELECT
		frc.id,
		COALESCE(CAST(frc.UC AS CHAR), '')           AS uc,
		COALESCE(frc.RAZAO_SOCIAL, '')               AS razao_social,
		COALESCE(frc.Concessionaria, '')             AS concessionaria,
		DATE_FORMAT(frc.Mes_Ref, '%Y-%m')            AS mes_ref,
		COALESCE(frc.Tp_Tensao, '')                  AS tp_tensao,
		COALESCE(frc.RS_Total_Fatura, 0)             AS rs_total_fatura,
		COALESCE(frc.Link, '')                       AS link,
		COALESCE(frc.anomalia_encontrada, 0)         AS anomalia_encontrada,
		frc.ia_analisado_em,
		LEFT(COALESCE(frc.analise_IA, ''), 500)      AS analise_resumo,
		COALESCE(fa.valor_ressarcimento_estimado, 0) AS valor_ressarcimento_estimado,
		COALESCE(fa.ia_fichas_confirmadas, '')       AS ia_fichas_confirmadas,
		COALESCE(fa.ia_status, '')                   AS ia_status,
		COALESCE(fa.aprovado, 0)                     AS aprovado,
		fa.aprovado_em,
		COALESCE(fa.desvio_pct_max, 0)              AS desvio_pct_max,
		COALESCE(fa.qtd_regras, 0)                  AS qtd_regras,
		CASE WHEN fa.troca_medidor IS NOT NULL
		          AND fa.troca_medidor != ''
		          AND fa.troca_medidor != '0'
		     THEN 1 ELSE 0 END                      AS troca_medidor,
		COALESCE(fa.modelo_ia, '')                  AS modelo_ia
	FROM Faturas_Registradas_Cache frc
	LEFT JOIN fichas_anomalias_cache fa ON fa.id = frc.id AND COALESCE(fa.deletado,0) = 0
	` + where + `
	ORDER BY ` + orderBy + `
	LIMIT ? OFFSET ?`

	queryArgs := append(append([]interface{}{}, args...), limit, offset)
	rows, err := sqlDB.Query(dataSQL, queryArgs...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	type FaturaAnalisada struct {
		ID                         int64    `json:"id"`
		UC                         string   `json:"UC"`
		RazaoSocial                string   `json:"RAZAO_SOCIAL"`
		Concessionaria             string   `json:"Concessionaria"`
		MesRef                     string   `json:"Mes_Ref"`
		TpTensao                   string   `json:"Tp_Tensao"`
		RSTotalFatura              float64  `json:"RS_Total_Fatura"`
		Link                       string   `json:"Link"`
		AnomaliaEncontrada         int      `json:"anomalia_encontrada"`
		IAAnalisadoEm              *string  `json:"ia_analisado_em"`
		AnaliseResumo              string   `json:"analise_resumo"`
		ValorRessarcimentoEstimado float64  `json:"valor_ressarcimento_estimado"`
		IAFichasConfirmadas        string   `json:"ia_fichas_confirmadas"`
		IAStatus                   string   `json:"ia_status"`
		Aprovado                   int      `json:"aprovado"`
		AprovadoEm                 *string  `json:"aprovado_em"`
		DesvioMax                  float64  `json:"desvio_pct_max"`
		QtdRegras                  int      `json:"qtd_regras"`
		TrocaMedidor               int      `json:"troca_medidor"`
		ModeloIA                   string   `json:"modelo_ia"`
		ScoreAnomalia              int      `json:"score_anomalia"`
	}

	var result []FaturaAnalisada
	for rows.Next() {
		var f FaturaAnalisada
		var analisadoEm, aprovadoEm *time.Time
		if err := rows.Scan(
			&f.ID, &f.UC, &f.RazaoSocial, &f.Concessionaria,
			&f.MesRef, &f.TpTensao, &f.RSTotalFatura, &f.Link,
			&f.AnomaliaEncontrada, &analisadoEm, &f.AnaliseResumo,
			&f.ValorRessarcimentoEstimado, &f.IAFichasConfirmadas,
			&f.IAStatus, &f.Aprovado, &aprovadoEm,
			&f.DesvioMax, &f.QtdRegras, &f.TrocaMedidor, &f.ModeloIA,
		); err == nil {
			if analisadoEm != nil { s := analisadoEm.Format("2006-01-02 15:04"); f.IAAnalisadoEm = &s }
			if aprovadoEm  != nil { s := aprovadoEm.Format("2006-01-02 15:04");  f.AprovadoEm   = &s }
			f.ScoreAnomalia = calcScoreAnomalia(f.DesvioMax, f.IAStatus, f.QtdRegras, f.ValorRessarcimentoEstimado, f.TrocaMedidor)
			result = append(result, f)
		}
	}
	if result == nil { result = []FaturaAnalisada{} }

	c.JSON(http.StatusOK, gin.H{
		"rows":   result,
		"total":  total,
		"limit":  limit,
		"offset": offset,
	})
}

// calcScoreAnomalia computa score composto de anomalia (0–100).
// Dimensões: desvio %, confirmação IA, qtd fichas ativas, valor financeiro, troca de medidor.
func calcScoreAnomalia(desvio float64, iaStatus string, qtdRegras int, valor float64, trocaMedidor int) int {
	score := 0

	// 1. Desvio de consumo (0–40 pts)
	abs := desvio
	if abs < 0 { abs = -abs }
	switch {
	case abs >= 200:
		score += 40
	case abs >= 100:
		score += 30
	case abs >= 50:
		score += 20
	case abs >= 30:
		score += 10
	}
	// Bonus negativo (consumo muito abaixo também é grave)
	if desvio <= -100 && score < 30 {
		score += 30
	} else if desvio <= -50 && score < 15 {
		score += 15
	}

	// 2. Confirmação IA (−20 a +30 pts)
	switch iaStatus {
	case "CONFIRMADO":
		score += 30
	case "PENDENTE":
		score += 5
	case "FALSO_POSITIVO":
		score -= 20
	}

	// 3. Quantidade de fichas/regras ativas (0–15 pts)
	switch {
	case qtdRegras >= 4:
		score += 15
	case qtdRegras == 3:
		score += 10
	case qtdRegras == 2:
		score += 7
	case qtdRegras == 1:
		score += 3
	}

	// 4. Valor financeiro estimado (0–10 pts)
	switch {
	case valor > 10000:
		score += 10
	case valor > 5000:
		score += 7
	case valor > 1000:
		score += 5
	case valor > 0:
		score += 3
	}

	// 5. Troca de medidor (0–5 pts)
	if trocaMedidor > 0 {
		score += 5
	}

	// Clamp [0, 100]
	if score < 0  { score = 0 }
	if score > 100 { score = 100 }
	return score
}

// AprovarFicha marca uma anomalia como aprovada (irregularidade confirmada).
func AprovarFicha(c *gin.Context) {
	var body struct {
		ID int64 `json:"id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.ID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "DB indisponível"})
		return
	}
	sqlDB, _ := db.DB()
	_, err := sqlDB.Exec(`
		UPDATE fichas_anomalias_cache
		   SET aprovado    = 1,
		       aprovado_em = NOW()
		 WHERE id = ?`, body.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// DeletarFicha faz soft-delete de uma anomalia (não aparece mais nas listagens).
func DeletarFicha(c *gin.Context) {
	var body struct {
		ID int64 `json:"id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.ID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "DB indisponível"})
		return
	}
	sqlDB, _ := db.DB()
	_, err := sqlDB.Exec(`
		UPDATE fichas_anomalias_cache
		   SET deletado    = 1,
		       deletado_em = NOW()
		 WHERE id = ?`, body.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// PATCHFaturaDecisao atualiza o ia_status de uma ficha para refletir a decisão do analista.
// Aceita: {"id": N, "decisao": "CONFIRMADO"|"FALSO_POSITIVO"|"INCONCLUSIVO"|"PENDENTE"}
func PATCHFaturaDecisao(c *gin.Context) {
	var body struct {
		ID      int64  `json:"id"`
		Decisao string `json:"decisao"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.ID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}
	allowed := map[string]bool{"CONFIRMADO": true, "FALSO_POSITIVO": true, "INCONCLUSIVO": true, "PENDENTE": true}
	if !allowed[body.Decisao] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "decisao inválida"})
		return
	}
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "DB indisponível"})
		return
	}
	sqlDB, _ := db.DB()
	_, err := sqlDB.Exec(`
		UPDATE fichas_anomalias_cache
		   SET ia_status     = ?,
		       atualizado_em = NOW()
		 WHERE id = ?`, body.Decisao, body.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": body.ID, "decisao": body.Decisao})
}

// ResetFaturaIA limpa o resultado de análise IA de uma ou mais faturas,
// devolvendo-as à fila de processamento do pipeline.
// Aceita: {"id": N}, {"ids": [N,...]}, ou {"empresa": N}.
func ResetFaturaIA(c *gin.Context) {
	var body struct {
		ID      int64   `json:"id"`
		IDs     []int64 `json:"ids"`
		Empresa int64   `json:"empresa"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}

	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "DB indisponível"})
		return
	}
	sqlDB, _ := db.DB()

	// Monta lista de IDs alvo
	var ids []int64
	switch {
	case body.Empresa > 0:
		rows, err := sqlDB.Query(
			"SELECT id FROM Faturas_Registradas_Cache WHERE Cod_Empresa = ? AND analise_IA IS NOT NULL",
			body.Empresa)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		defer rows.Close()
		for rows.Next() {
			var id int64
			if rows.Scan(&id) == nil {
				ids = append(ids, id)
			}
		}
	case len(body.IDs) > 0:
		ids = body.IDs
	case body.ID > 0:
		ids = []int64{body.ID}
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "informe id, ids ou empresa"})
		return
	}

	if len(ids) == 0 {
		c.JSON(http.StatusOK, gin.H{"ok": true, "resetados": 0})
		return
	}

	// Monta placeholders para IN (?)
	ph := make([]string, len(ids))
	args := make([]interface{}, len(ids))
	for i, id := range ids {
		ph[i] = "?"
		args[i] = id
	}
	inClause := strings.Join(ph, ",")

	// 1. Limpa Faturas_Registradas_Cache
	_, err := sqlDB.Exec(
		"UPDATE Faturas_Registradas_Cache SET analise_IA = NULL, anomalia_encontrada = NULL, ia_analisado_em = NULL WHERE id IN ("+inClause+")",
		args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "FRC: " + err.Error()})
		return
	}

	// 2. Volta fichas_anomalias_cache para PENDENTE
	_, _ = sqlDB.Exec(
		"UPDATE fichas_anomalias_cache SET ia_status = 'PENDENTE', ia_fichas_confirmadas = NULL, valor_ressarcimento_estimado = 0, aprovado = 0, aprovado_em = NULL WHERE id IN ("+inClause+")",
		args...)

	c.JSON(http.StatusOK, gin.H{"ok": true, "resetados": len(ids)})
}

// GetResumoClientes retorna lista de clientes com contagem de faturas auditadas e anomalias.
func GetResumoClientes(c *gin.Context) {
	empresa := c.Query("empresa")

	dbApp := database.GormDB_App
	if dbApp == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "DB indisponível"})
		return
	}
	sqlDB, err := dbApp.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	where := "WHERE frc.RAZAO_SOCIAL IS NOT NULL AND frc.RAZAO_SOCIAL != ''"
	args := []interface{}{}
	if empresa != "" {
		where += " AND frc.Cod_Empresa = ?"
		args = append(args, empresa)
	}

	query := fmt.Sprintf(`
		SELECT
			frc.RAZAO_SOCIAL,
			frc.Cod_Empresa,
			COUNT(*)                                                                        AS total_faturas,
			SUM(CASE WHEN frc.analise_IA IS NOT NULL THEN 1 ELSE 0 END)                    AS faturas_analisadas,
			SUM(CASE WHEN frc.analise_IA IS NULL     THEN 1 ELSE 0 END)                    AS nao_analisadas,
			SUM(CASE WHEN frc.anomalia_encontrada = 1 THEN 1 ELSE 0 END)                   AS anomalias_encontradas,
			SUM(CASE WHEN fac.ia_status = 'CONFIRMADO'    THEN 1 ELSE 0 END)               AS casos_confirmados,
			SUM(CASE WHEN fac.ia_status = 'FALSO_POSITIVO' THEN 1 ELSE 0 END)              AS casos_descartados,
			COALESCE(SUM(
				CASE WHEN fac.ia_status = 'CONFIRMADO'
				THEN COALESCE(fac.valor_ressarcimento_estimado, 0) ELSE 0 END
			), 0)                                                                           AS ressarcimento_estimado
		FROM Faturas_Registradas_Cache frc
		LEFT JOIN fichas_anomalias_cache fac ON fac.id = frc.id
		%s
		GROUP BY frc.RAZAO_SOCIAL, frc.Cod_Empresa
		ORDER BY casos_confirmados DESC, anomalias_encontradas DESC, total_faturas DESC
	`, where)

	rows, err := sqlDB.Query(query, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	type ClienteResumo struct {
		RazaoSocial           string  `json:"razao_social"`
		CodEmpresa            *int    `json:"cod_empresa"`
		TotalFaturas          int     `json:"total_faturas"`
		FaturasAnalisadas     int     `json:"faturas_analisadas"`
		NaoAnalisadas         int     `json:"nao_analisadas"`
		AnomaliaEncontradas   int     `json:"anomalias_encontradas"`
		CasosConfirmados      int     `json:"casos_confirmados"`
		CasosDescartados      int     `json:"casos_descartados"`
		RessarcimentoEstimado float64 `json:"ressarcimento_estimado"`
		PctAnalisadas         float64 `json:"pct_analisadas"`
		PctNaoAnalisadas      float64 `json:"pct_nao_analisadas"`
	}

	var clientes []ClienteResumo
	for rows.Next() {
		var cl ClienteResumo
		if err := rows.Scan(
			&cl.RazaoSocial, &cl.CodEmpresa,
			&cl.TotalFaturas, &cl.FaturasAnalisadas, &cl.NaoAnalisadas,
			&cl.AnomaliaEncontradas, &cl.CasosConfirmados, &cl.CasosDescartados,
			&cl.RessarcimentoEstimado,
		); err == nil {
			if cl.TotalFaturas > 0 {
				cl.PctAnalisadas    = float64(cl.FaturasAnalisadas) / float64(cl.TotalFaturas) * 100
				cl.PctNaoAnalisadas = float64(cl.NaoAnalisadas) / float64(cl.TotalFaturas) * 100
			}
			clientes = append(clientes, cl)
		}
	}
	if clientes == nil {
		clientes = []ClienteResumo{}
	}
	c.JSON(http.StatusOK, gin.H{"clientes": clientes})
}

// GetClienteIAFaturas retorna faturas de um cliente específico com resultado da análise IA.
func GetClienteIAFaturas(c *gin.Context) {
	empresa    := c.Query("empresa")
	razaoSocial := c.Query("razao_social")

	if razaoSocial == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "razao_social obrigatório"})
		return
	}

	dbApp := database.GormDB_App
	if dbApp == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "DB indisponível"})
		return
	}
	sqlDB, err := dbApp.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	args := []interface{}{razaoSocial}
	empresaWhere := ""
	if empresa != "" {
		empresaWhere = " AND Cod_Empresa = ?"
		args = append(args, empresa)
	}

	query := fmt.Sprintf(`
		SELECT
			frc.id, frc.UC, frc.Cod_Empresa, frc.Concessionaria,
			DATE_FORMAT(frc.Mes_Ref, '%%Y-%%m') AS mes_ref,
			frc.Tp_Tensao, frc.RS_Total_Fatura, frc.Link,
			frc.anomalia_encontrada,
			frc.ia_analisado_em,
			LEFT(COALESCE(frc.analise_IA, ''), 500) AS analise_resumo,
			COALESCE(fac.ia_status, '')                         AS ia_status,
			COALESCE(fac.valor_ressarcimento_estimado, 0)       AS valor_ressarcimento_estimado
		FROM Faturas_Registradas_Cache frc
		LEFT JOIN fichas_anomalias_cache fac ON fac.id = frc.id
		WHERE frc.RAZAO_SOCIAL = ?
		  AND frc.analise_IA IS NOT NULL
		  %s
		ORDER BY frc.Mes_Ref DESC
		LIMIT 500
	`, empresaWhere)

	rows, err := sqlDB.Query(query, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	type FaturaIA struct {
		ID                         int64    `json:"id"`
		UC                         string   `json:"uc"`
		CodEmpresa                 *int     `json:"cod_empresa"`
		Concessionaria             *string  `json:"concessionaria"`
		MesRef                     string   `json:"mes_ref"`
		TpTensao                   *string  `json:"tp_tensao"`
		RSTotalFatura              *float64 `json:"rs_total_fatura"`
		Link                       *string  `json:"link"`
		AnomaliaEncontrada         *int     `json:"anomalia_encontrada"`
		IAAnalisadoEm              *string  `json:"ia_analisado_em"`
		AnaliseResumo              *string  `json:"analise_resumo"`
		IAStatus                   string   `json:"ia_status"`
		ValorRessarcimentoEstimado float64  `json:"valor_ressarcimento_estimado"`
	}

	var faturas []FaturaIA
	for rows.Next() {
		var f FaturaIA
		var analisadoEm *time.Time
		if err := rows.Scan(&f.ID, &f.UC, &f.CodEmpresa, &f.Concessionaria,
			&f.MesRef, &f.TpTensao, &f.RSTotalFatura, &f.Link,
			&f.AnomaliaEncontrada, &analisadoEm, &f.AnaliseResumo,
			&f.IAStatus, &f.ValorRessarcimentoEstimado); err == nil {
			if analisadoEm != nil {
				s := analisadoEm.Format("2006-01-02 15:04")
				f.IAAnalisadoEm = &s
			}
			faturas = append(faturas, f)
		}
	}
	if faturas == nil {
		faturas = []FaturaIA{}
	}
	c.JSON(http.StatusOK, gin.H{"faturas": faturas, "razao_social": razaoSocial})
}

// ListUCsEmProcesso retorna todas as UCs que possuem requisições no banco principal.
func ListUCsEmProcesso(c *gin.Context) {
	dbApp := database.GormDB_App
	if dbApp == nil {
		c.JSON(http.StatusOK, gin.H{"ucs": []string{}})
		return
	}
	sqlDB, err := dbApp.DB()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"ucs": []string{}})
		return
	}
	rows, err := sqlDB.Query(
		"SELECT DISTINCT uc FROM FT_REQUISICOES WHERE uc IS NOT NULL AND uc != '' ORDER BY uc",
	)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"ucs": []string{}})
		return
	}
	defer rows.Close()

	var ucs []string
	for rows.Next() {
		var uc string
		if rows.Scan(&uc) == nil {
			ucs = append(ucs, uc)
		}
	}
	if ucs == nil {
		ucs = []string{}
	}
	c.JSON(http.StatusOK, gin.H{"ucs": ucs})
}
