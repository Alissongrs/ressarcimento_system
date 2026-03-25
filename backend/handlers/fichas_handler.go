package handlers

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// fichaUnificadaSQL é a query principal com todas as regras F01–F05 inlined.
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
func filtroFicha(ficha string) string {
	switch ficha {
	case "f01":
		return " AND flag_f01 = 1"
	case "f02":
		return " AND flag_f02 = 1"
	case "f03":
		return " AND flag_f03 = 1"
	case "f04":
		return " AND flag_f04 = 1"
	case "f05":
		return " AND flag_f05 = 1"
	case "combinados":
		return " AND qtd_regras > 1"
	default:
		return ""
	}
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
	base := "FROM fichas_anomalias_cache WHERE 1=1" + filtro

	// Contagem total
	var total int64
	_ = sqlDB.QueryRow("SELECT COUNT(*) " + base).Scan(&total)

	// Dados paginados
	dataSQL := "SELECT * " + base +
		" ORDER BY qtd_regras DESC, COALESCE(desvio_pct_max,0) DESC LIMIT ? OFFSET ?"
	rows, err := sqlDB.Query(dataSQL, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao consultar: " + err.Error()})
		return
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao ler colunas"})
		return
	}

	var result []map[string]interface{}
	for rows.Next() {
		vals := make([]interface{}, len(cols))
		ptrs := make([]interface{}, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			continue
		}
		row := make(map[string]interface{}, len(cols))
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
		result = []map[string]interface{}{}
	}

	c.JSON(http.StatusOK, gin.H{
		"columns": cols,
		"rows":    result,
		"total":   total,
		"limit":   limit,
		"offset":  offset,
	})
}

func ListFicha01(c *gin.Context)        { queryFichaSQL(c, "f01") }
func ListFicha02(c *gin.Context)        { queryFichaSQL(c, "f02") }
func ListFicha03(c *gin.Context)        { queryFichaSQL(c, "f03") }
func ListFicha04(c *gin.Context)        { queryFichaSQL(c, "f04") }
func ListFicha05(c *gin.Context)        { queryFichaSQL(c, "f05") }
func ListFichaCombinados(c *gin.Context) { queryFichaSQL(c, "combinados") }

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

	var total, f01, f02, f03, f04, f05, comb int64
	err = sqlDB.QueryRow(`
		SELECT
		  COUNT(*),
		  SUM(flag_f01),
		  SUM(flag_f02),
		  SUM(flag_f03),
		  SUM(flag_f04),
		  SUM(flag_f05),
		  SUM(CASE WHEN qtd_regras > 1 THEN 1 ELSE 0 END)
		FROM fichas_anomalias_cache`).Scan(&total, &f01, &f02, &f03, &f04, &f05, &comb)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao consultar resumo"})
		return
	}

	resumo := []gin.H{
		{"key": "f01",       "nome": "F01 – Divergência de Fórmula", "total": f01},
		{"key": "f02",       "nome": "F02 – Desvio de Média",        "total": f02},
		{"key": "f03",       "nome": "F03 – Acúmulo de Consumo",     "total": f03},
		{"key": "f04",       "nome": "F04 – Troca de Medidor",       "total": f04},
		{"key": "f05",       "nome": "F05 – Quebra de Leitura",      "total": f05},
		{"key": "combinados","nome": "Combinados (2+ fichas)",        "total": comb},
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
		 LIMIT 60`, uc)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao consultar: " + err.Error()})
		return
	}
	defer rows.Close()

	cols, _ := rows.Columns()
	var result []map[string]interface{}
	for rows.Next() {
		vals := make([]interface{}, len(cols))
		ptrs := make([]interface{}, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if rows.Scan(ptrs...) != nil {
			continue
		}
		row := make(map[string]interface{}, len(cols))
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
		result = []map[string]interface{}{}
	}
	c.JSON(http.StatusOK, gin.H{"columns": cols, "rows": result})
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
