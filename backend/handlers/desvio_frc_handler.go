package handlers

// =============================================================================
// desvio_frc_handler.go — Análise de Desvio sobre Faturas_Registradas_Cache (FRC)
//
// FONTE TEMPORÁRIA: enquanto a FATURA_DADOS_EXTRAIDOS (FDE) ainda está sendo
// configurada, o front aponta para a FRC (sgeeasy, GormDB_Faturas) e aplica a
// regra F01-F05 via a SQL nativa da FRC (postos P/FP/R separados, base 8 meses,
// F02 bloqueada por F04/F05, exclui Reservado, validação forward). F03 é
// SUPRIMIDO (gerava ~94% de falso positivo — removido do front em 08/06/2026).
//
// Empresas liberadas via env FRC_ALLOWED_EMPRESAS (CSV). Vazio = todas.
//
// A linha devolvida espelha o shape do /fde-analise em MOTOR MODE, então a
// tela de Análise de Desvio consome sem alteração no pipeline de normalização.
//
//   GET /api/v1/desvio/frc?empresa=144
// =============================================================================

import (
	"database/sql"
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
	"ressarcimento-backend/database"
)

// empresaFRCPermitida — allow-list configurável via env FRC_ALLOWED_EMPRESAS
// (CSV, ex: "144,189,4"). Vazio = todas as empresas liberadas.
func empresaFRCPermitida(cod string) bool {
	cod = strings.TrimSpace(cod)
	if cod == "" {
		return false
	}
	raw := strings.TrimSpace(os.Getenv("FRC_ALLOWED_EMPRESAS"))
	if raw == "" {
		return true // sem allow-list configurada → libera todas
	}
	for _, e := range strings.Split(raw, ",") {
		if strings.TrimSpace(e) == cod {
			return true
		}
	}
	return false
}

// sqlDesvioFRC — a regra F01-F05 sobre a FRC. Constantes inlined (session @vars
// não persistem no pool do database/sql) e empresa parametrizada (?). F03
// suprimido apenas na PROJEÇÃO final e no WHERE — toda a computação interna
// (inclusive eh_f03, que exclui esses segmentos do F02) é preservada.
// {{FILTRO_EMPRESA}} — placeholder substituído em runtime por:
//   "AND f.Cod_Empresa = ?"     quando empresa específica
//   ""                          quando "todos"
const sqlDesvioFRC = `
WITH
base_raw AS (
  SELECT
    f.id, f.UC, f.Cod_Empresa, f.Concessionaria, f.Mes_Ref,
    f.Tp_Tensao, f.Modalidade_Tarifaria, f.NroMedidor,
    f.Link, f.RS_Total_Fatura,
    CASE WHEN UPPER(TRIM(f.Tp_Tensao)) IN ('ACR BT','GD') THEN 'B' ELSE 'A' END AS grupo_tarifario,
    CASE WHEN COALESCE(f.KWH_Ponta,0)     > 1000000000 THEN 0 ELSE COALESCE(f.KWH_Ponta,0)     END AS kwh_p,
    CASE WHEN COALESCE(f.KWH_FPonta,0)    > 1000000000 THEN 0 ELSE COALESCE(f.KWH_FPonta,0)    END AS kwh_fp,
    CASE WHEN COALESCE(f.KWH_Reservado,0) > 1000000000 THEN 0 ELSE COALESCE(f.KWH_Reservado,0) END AS kwh_r,
    TRIM(CAST(f.Leitura_Anterior_KWH_P  AS CHAR)) AS la_p_raw,
    TRIM(CAST(f.Leitura_Anterior_KWH_FP AS CHAR)) AS la_fp_raw,
    TRIM(CAST(f.Leitura_Anterior_KWH_R  AS CHAR)) AS la_r_raw,
    COALESCE(CAST(REPLACE(f.Leitura_Anterior_KWH_P,'.','') AS DECIMAL(18,3)),0) AS la_p,
    COALESCE(CAST(REPLACE(f.Leitura_Atual_KWH_P,'.','') AS DECIMAL(18,3)),0) AS lc_p,
    COALESCE(CAST(REPLACE(f.Leitura_Anterior_KWH_FP,'.','') AS DECIMAL(18,3)),0) AS la_fp,
    COALESCE(CAST(REPLACE(f.Leitura_Atual_KWH_FP,'.','') AS DECIMAL(18,3)),0) AS lc_fp,
    COALESCE(CAST(REPLACE(f.Leitura_Anterior_KWH_R,'.','') AS DECIMAL(18,3)),0) AS la_r,
    COALESCE(CAST(REPLACE(f.Leitura_Atual_KWH_R,'.','') AS DECIMAL(18,3)),0) AS lc_r,
    COALESCE(NULLIF(f.Constante_KWH_P,0),1)  AS const_p,
    COALESCE(NULLIF(f.Constante_KWH_FP,0),1) AS const_fp,
    COALESCE(NULLIF(f.Constante_KWH_R,0),1)  AS const_r
  FROM Faturas_Registradas_Cache f
  WHERE 1=1 {{FILTRO_EMPRESA}}
    AND UPPER(TRIM(f.Tp_Tensao)) IN ('ACR BT','GD','ACR MT','ACR AT','ACR MB')
    AND f.Mes_Ref >= DATE_SUB(CURDATE(), INTERVAL 36 MONTH)
),
f01_calc AS (
  SELECT id,
    (lc_p - la_p) * const_p    AS calc_p,  (lc_p - la_p) * const_p *1.025 AS calc_p_aj,
    (lc_fp - la_fp) * const_fp AS calc_fp, (lc_fp - la_fp) * const_fp *1.025 AS calc_fp_aj,
    (lc_r - la_r) * const_r    AS calc_r,  (lc_r - la_r) * const_r *1.025 AS calc_r_aj,
    kwh_p, kwh_fp, kwh_r, la_p, lc_p, la_fp, lc_fp, la_r, lc_r
  FROM base_raw
),
f01 AS (
  SELECT id,
    CASE WHEN (la_p>0 OR lc_p>0) AND kwh_p>0 AND kwh_p NOT IN (30,50,100)
      AND ABS(kwh_p-ROUND(calc_p,6))>0.01 AND ABS(kwh_p-ROUND(calc_p_aj,6))>0.01
      THEN 1 ELSE 0 END AS flag_p,
    CASE WHEN (la_fp>0 OR lc_fp>0) AND kwh_fp>0 AND kwh_fp NOT IN (30,50,100)
      AND ABS(kwh_fp-ROUND(calc_fp,6))>0.01 AND ABS(kwh_fp-ROUND(calc_fp_aj,6))>0.01
      THEN 1 ELSE 0 END AS flag_fp,
    CASE WHEN (la_r>0 OR lc_r>0) AND kwh_r>0 AND kwh_r NOT IN (30,50,100)
      AND ABS(kwh_r-ROUND(calc_r,6))>0.01 AND ABS(kwh_r-ROUND(calc_r_aj,6))>0.01
      THEN 1 ELSE 0 END AS flag_r
  FROM f01_calc
),
f01_resultado AS (
  SELECT id,
    CASE WHEN flag_p=1 OR flag_fp=1 OR flag_r=1 THEN 1 ELSE 0 END AS flag_f01,
    TRIM(BOTH ' | ' FROM CONCAT_WS(' | ', IF(flag_p=1,'P',NULL), IF(flag_fp=1,'FP',NULL), IF(flag_r=1,'R',NULL))) AS seg_f01
  FROM f01
),
base_seg AS (
  SELECT id, UC, Cod_Empresa, Concessionaria, Mes_Ref, Tp_Tensao, Modalidade_Tarifaria,
         grupo_tarifario, Link, RS_Total_Fatura, NroMedidor,
         'P'  AS seg, kwh_p  AS v, la_p  AS leitura_ant, lc_p  AS leitura_atu, la_p_raw  AS la_raw, const_p  AS const
  FROM base_raw
  UNION ALL
  SELECT id, UC, Cod_Empresa, Concessionaria, Mes_Ref, Tp_Tensao, Modalidade_Tarifaria,
         grupo_tarifario, Link, RS_Total_Fatura, NroMedidor,
         'FP' AS seg, kwh_fp AS v, la_fp AS leitura_ant, lc_fp AS leitura_atu, la_fp_raw AS la_raw, const_fp AS const
  FROM base_raw
  UNION ALL
  SELECT id, UC, Cod_Empresa, Concessionaria, Mes_Ref, Tp_Tensao, Modalidade_Tarifaria,
         grupo_tarifario, Link, RS_Total_Fatura, NroMedidor,
         'R'  AS seg, kwh_r  AS v, la_r  AS leitura_ant, lc_r  AS leitura_atu, la_r_raw  AS la_raw, const_r  AS const
  FROM base_raw
),
com_stats AS (
  SELECT bs.*,
    AVG(CASE WHEN bs.v > 50 THEN bs.v END) OVER (
      PARTITION BY bs.UC, bs.Concessionaria, bs.seg ORDER BY bs.Mes_Ref, bs.id
      ROWS BETWEEN 12 PRECEDING AND 1 PRECEDING) AS media,
    COUNT(CASE WHEN bs.v > 50 THEN 1 END) OVER (
      PARTITION BY bs.UC, bs.Concessionaria, bs.seg ORDER BY bs.Mes_Ref, bs.id
      ROWS BETWEEN 12 PRECEDING AND 1 PRECEDING) AS base_len,
    COUNT(CASE WHEN (bs.grupo_tarifario='B' AND bs.v IN (30,50,100)) OR (bs.grupo_tarifario='A' AND bs.v=0) THEN 1 END) OVER (
      PARTITION BY bs.UC, bs.Concessionaria, bs.seg ORDER BY bs.Mes_Ref, bs.id
      ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) AS prev_fixos_5m,
    LAG(bs.NroMedidor) OVER (PARTITION BY bs.UC, bs.Concessionaria, bs.seg ORDER BY bs.Mes_Ref, bs.id) AS med_ant,
    LAG(bs.leitura_atu) OVER (PARTITION BY bs.UC, bs.Concessionaria, bs.seg ORDER BY bs.Mes_Ref, bs.id) AS leit_atu_ant,
    LAG(bs.v,1) OVER (PARTITION BY bs.UC, bs.Concessionaria, bs.seg ORDER BY bs.Mes_Ref, bs.id) AS lag1,
    LAG(bs.v,2) OVER (PARTITION BY bs.UC, bs.Concessionaria, bs.seg ORDER BY bs.Mes_Ref, bs.id) AS lag2,
    LAG(bs.v,3) OVER (PARTITION BY bs.UC, bs.Concessionaria, bs.seg ORDER BY bs.Mes_Ref, bs.id) AS lag3,
    LEAD(bs.v,1) OVER (PARTITION BY bs.UC, bs.Concessionaria, bs.seg ORDER BY bs.Mes_Ref, bs.id) AS lead1,
    LEAD(bs.v,2) OVER (PARTITION BY bs.UC, bs.Concessionaria, bs.seg ORDER BY bs.Mes_Ref, bs.id) AS lead2,
    LEAD(bs.v,3) OVER (PARTITION BY bs.UC, bs.Concessionaria, bs.seg ORDER BY bs.Mes_Ref, bs.id) AS lead3,
    CASE WHEN (bs.grupo_tarifario='B' AND bs.v IN (30,50,100)) OR (bs.grupo_tarifario='A' AND bs.v=0)
      THEN CAST(bs.v AS CHAR) ELSE NULL END AS fixed_key
  FROM base_seg bs
),
classificado AS (
  SELECT cs.*,
    CASE WHEN cs.media > 0 THEN (cs.v - cs.media) / cs.media ELSE NULL END AS dif_pct,
    CASE
      WHEN cs.v IS NULL OR cs.v < 0                          THEN 'INVALIDO'
      WHEN cs.v IN (0, 1)                                    THEN 'PLACEHOLDER'
      WHEN COALESCE(cs.base_len, 0) = 0                      THEN 'SEM_BASE'
      WHEN cs.base_len < 8 THEN
        CASE WHEN cs.media>0 AND (cs.v-cs.media)/cs.media>=1.0  THEN 'DESVIO_ALTO'
             WHEN cs.media>0 AND (cs.v-cs.media)/cs.media<=-1.0 THEN 'DESVIO_BAIXO'
             ELSE 'AMOSTRA_PEQUENA' END
      WHEN cs.media>0 AND (cs.v-cs.media)/cs.media >= 2.0  THEN 'PICO_OUTLIER'
      WHEN cs.media>0 AND (cs.v-cs.media)/cs.media >= 1.0  THEN 'DESVIO_ALTO'
      WHEN cs.media>0 AND (cs.v-cs.media)/cs.media <= -1.0 THEN 'MUITO_BAIXO'
      WHEN cs.media>0 AND (cs.v-cs.media)/cs.media < -0.5 THEN 'DESVIO_BAIXO'
      ELSE 'NORMAL'
    END AS status
  FROM com_stats cs
),
seg_flags AS (
  SELECT cl.*,
    LAG(cl.fixed_key) OVER (PARTITION BY cl.UC, cl.Concessionaria, cl.seg ORDER BY cl.Mes_Ref, cl.id) AS prev_fixed_key,
    CASE WHEN cl.prev_fixos_5m>=4 AND cl.status IN ('PICO_OUTLIER','DESVIO_ALTO') AND COALESCE(cl.dif_pct,0)>=1.0
      THEN 1 ELSE 0 END AS eh_f03,
    CASE WHEN cl.med_ant IS NOT NULL AND LOWER(TRIM(cl.med_ant)) NOT IN ('nan','null','')
      AND cl.med_ant <> cl.NroMedidor AND cl.status IN ('PICO_OUTLIER','DESVIO_ALTO','MUITO_BAIXO','DESVIO_BAIXO')
      THEN 1 ELSE 0 END AS eh_f04,
    CASE WHEN cl.med_ant IS NOT NULL AND cl.med_ant = cl.NroMedidor
      AND cl.leit_atu_ant IS NOT NULL AND cl.leitura_ant IS NOT NULL
      AND cl.leit_atu_ant > 0 AND cl.leitura_ant > 0
      AND UPPER(TRIM(COALESCE(cl.la_raw,''))) NOT IN ('MED','0','')
      AND cl.v > 0
      AND ABS(ABS(cl.leitura_atu - cl.leitura_ant)*cl.const - cl.v) <= 0.05*cl.v
      AND NOT (
        ABS(cl.leit_atu_ant - cl.leitura_ant) <= 2
        OR ABS(cl.leit_atu_ant - cl.leitura_ant*10) <= 2
        OR ABS(cl.leit_atu_ant - cl.leitura_ant*100) <= 2
        OR ABS(cl.leit_atu_ant - cl.leitura_ant*1000) <= 2)
      THEN 1 ELSE 0 END AS eh_f05,
    CASE WHEN cl.status NOT IN ('NORMAL','INVALIDO','PLACEHOLDER','SEM_BASE','AMOSTRA_PEQUENA') THEN 1 ELSE 0 END AS eh_f02_segmento_raw,
    CASE
      WHEN cl.status NOT IN ('PICO_OUTLIER','DESVIO_ALTO') THEN NULL
      WHEN cl.lead1 IS NULL OR cl.lead2 IS NULL OR cl.lead3 IS NULL THEN 'INFORMAR'
      WHEN (cl.lead1+cl.lead2+cl.lead3)/3.0 >= (cl.media + cl.v)/2.0 THEN 'ATIVACAO'
      ELSE 'ANOMALIA'
    END AS veredito_seg
  FROM classificado cl
),
agregado AS (
  SELECT s.id,
    MAX(s.NroMedidor) AS NroMedidor, MAX(s.med_ant) AS nro_medidor_ant,
    MAX(CASE WHEN s.eh_f04=1 THEN 1 ELSE 0 END) AS tem_f04_fatura,
    MAX(CASE WHEN s.eh_f05=1 THEN 1 ELSE 0 END) AS tem_f05_fatura,
    MAX(CASE WHEN s.eh_f02_segmento_raw=1 AND s.eh_f03=0 THEN s.dif_pct END) AS max_dif_pct_f02,
    MAX(CASE WHEN s.eh_f02_segmento_raw=1 AND s.eh_f03=0 AND s.seg='R' THEN 1 ELSE 0 END) AS alerta_em_r,
    TRIM(BOTH ' | ' FROM CONCAT_WS(' | ',
      MAX(CASE WHEN s.eh_f02_segmento_raw=1 AND s.eh_f03=0 AND s.seg='P'  THEN 'P'  END),
      MAX(CASE WHEN s.eh_f02_segmento_raw=1 AND s.eh_f03=0 AND s.seg='FP' THEN 'FP' END),
      MAX(CASE WHEN s.eh_f02_segmento_raw=1 AND s.eh_f03=0 AND s.seg='R'  THEN 'R'  END))) AS segmentos_alerta_f02,
    MAX(CASE WHEN s.eh_f02_segmento_raw=1 AND s.eh_f03=0 THEN s.v END)     AS consumo_atual_f02,
    MAX(CASE WHEN s.eh_f02_segmento_raw=1 AND s.eh_f03=0 THEN s.media END) AS media_f02,
    MAX(CASE WHEN s.eh_f02_segmento_raw=1 AND s.eh_f03=0 THEN s.lag3 END)  AS lag3_f02,
    MAX(CASE WHEN s.eh_f02_segmento_raw=1 AND s.eh_f03=0 THEN s.lag2 END)  AS lag2_f02,
    MAX(CASE WHEN s.eh_f02_segmento_raw=1 AND s.eh_f03=0 THEN s.lag1 END)  AS lag1_f02,
    MAX(CASE WHEN s.eh_f02_segmento_raw=1 AND s.eh_f03=0 THEN s.lead1 END) AS lead1_f02,
    MAX(CASE WHEN s.eh_f02_segmento_raw=1 AND s.eh_f03=0 THEN s.lead2 END) AS lead2_f02,
    MAX(CASE WHEN s.eh_f02_segmento_raw=1 AND s.eh_f03=0 THEN s.lead3 END) AS lead3_f02,
    MAX(CASE WHEN s.eh_f02_segmento_raw=1 AND s.eh_f03=0 THEN
          CASE s.veredito_seg WHEN 'ANOMALIA' THEN 3 WHEN 'INFORMAR' THEN 2 WHEN 'ATIVACAO' THEN 1 ELSE 0 END END) AS vrank,
    MAX(CASE WHEN s.eh_f04=1 THEN 1 ELSE 0 END) AS flag_f04,
    MAX(CASE WHEN s.eh_f05=1 THEN 1 ELSE 0 END) AS flag_f05,
    GROUP_CONCAT(CASE WHEN s.eh_f05=1 THEN CONCAT(s.seg,': esperado=',ROUND(s.leit_atu_ant,3),', encontrado=',ROUND(s.leitura_ant,3)) END
      ORDER BY FIELD(s.seg,'P','FP','R') SEPARATOR ' | ') AS detalhe_f05,
    GROUP_CONCAT(CASE WHEN s.eh_f04=1 THEN CONCAT(s.seg,': ',COALESCE(s.med_ant,''),' > ',COALESCE(s.NroMedidor,'')) END
      ORDER BY FIELD(s.seg,'P','FP','R') SEPARATOR ' | ') AS detalhe_f04
  FROM seg_flags s
  GROUP BY s.id
)
SELECT
  b.id, b.UC, b.Cod_Empresa, b.Concessionaria, b.Mes_Ref,
  b.Tp_Tensao, b.Modalidade_Tarifaria, b.NroMedidor, b.Link, b.RS_Total_Fatura,
  COALESCE(f1.flag_f01,0) AS flag_f01,
  x.flag_f02_calc         AS flag_f02,
  COALESCE(ag.flag_f04,0) AS flag_f04,
  COALESCE(ag.flag_f05,0) AS flag_f05,
  COALESCE(f1.seg_f01,'')                 AS segmentos_f01,
  COALESCE(ag.segmentos_alerta_f02,'')    AS segmentos_alerta_f02,
  ROUND(COALESCE(ag.max_dif_pct_f02,0)*100,1) AS desvio_pct_max,
  ROUND(COALESCE(ag.media_f02,0),0)           AS media_f02,
  ROUND(COALESCE(ag.consumo_atual_f02,0),0)   AS consumo_atual_f02,
  CONCAT_WS(' ', ROUND(ag.lag3_f02,0), ROUND(ag.lag2_f02,0), ROUND(ag.lag1_f02,0),
            CONCAT('[',ROUND(ag.consumo_atual_f02,0),']'),
            ROUND(ag.lead1_f02,0), ROUND(ag.lead2_f02,0), ROUND(ag.lead3_f02,0)) AS serie_f02,
  CASE WHEN x.flag_f02_calc=1 THEN
    CASE ag.vrank WHEN 3 THEN 'ANOMALIA' WHEN 2 THEN 'INFORMAR' WHEN 1 THEN 'ATIVACAO' ELSE 'REVISAR' END
    ELSE NULL END AS veredito_f02,
  COALESCE(ag.detalhe_f04,'') AS detalhe_f04,
  COALESCE(ag.detalhe_f05,'') AS detalhe_f05
FROM base_raw b
LEFT JOIN f01_resultado f1 ON f1.id = b.id
LEFT JOIN (
  SELECT ag.*,
    CASE WHEN COALESCE(ag.segmentos_alerta_f02,'')<>'' AND COALESCE(ag.max_dif_pct_f02,0)>1.0
      AND COALESCE(ag.alerta_em_r,0)=0 AND COALESCE(ag.tem_f04_fatura,0)=0 AND COALESCE(ag.tem_f05_fatura,0)=0
      THEN 1 ELSE 0 END AS flag_f02_calc
  FROM agregado ag
) x ON x.id = b.id
LEFT JOIN agregado ag ON ag.id = b.id
WHERE COALESCE(f1.flag_f01,0)=1 OR x.flag_f02_calc=1
   OR COALESCE(ag.flag_f04,0)=1 OR COALESCE(ag.flag_f05,0)=1
ORDER BY
  CASE WHEN x.flag_f02_calc=1 THEN ag.vrank ELSE 0 END DESC,
  COALESCE(ag.max_dif_pct_f02,0) DESC,
  b.Mes_Ref DESC, b.id DESC`

// GetDesvioFRC — GET /api/v1/desvio/frc?empresa=144
// Roda a regra F01-F05 (sem F03) sobre a FRC para UMA empresa do allow-list e
// devolve as faturas apontadas no shape consumido pela tela de Análise de Desvio.
func GetDesvioFRC(c *gin.Context) {
	empresa := strings.TrimSpace(c.Query("empresa"))
	todas := empresa == "" || empresa == "todos"
	if !todas && !empresaFRCPermitida(empresa) {
		c.JSON(http.StatusForbidden, gin.H{
			"error": "empresa não habilitada (config FRC_ALLOWED_EMPRESAS)",
		})
		return
	}

	if database.GormDB_Faturas == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "conexão FRC (sgeeasy) indisponível"})
		return
	}
	sqlDB, err := database.GormDB_Faturas.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão FRC"})
		return
	}

	// Substitui placeholder do filtro de empresa. Params escapados via ? — SQL
	// injection só possível se a string trocada tiver ?, que aqui é hard-code.
	var (
		sqlFinal string
		rows     *sql.Rows
	)
	if todas {
		sqlFinal = strings.Replace(sqlDesvioFRC, "{{FILTRO_EMPRESA}}", "", 1)
		rows, err = sqlDB.Query(sqlFinal)
	} else {
		sqlFinal = strings.Replace(sqlDesvioFRC, "{{FILTRO_EMPRESA}}", "AND f.Cod_Empresa = ?", 1)
		rows, err = sqlDB.Query(sqlFinal, empresa)
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao consultar FRC: " + err.Error()})
		return
	}
	defer rows.Close()

	result := []map[string]interface{}{}
	for rows.Next() {
		var (
			id, codEmp                                      sql.NullInt64
			uc, conc, mesRef, tpTensao, modalidade, medidor sql.NullString
			link, segF01, segF02, serie, veredito           sql.NullString
			detF04, detF05                                  sql.NullString
			valor, desvioPct, mediaF02, consumoF02          sql.NullFloat64
			flagF01, flagF02, flagF04, flagF05              sql.NullInt64
		)
		if err := rows.Scan(
			&id, &uc, &codEmp, &conc, &mesRef,
			&tpTensao, &modalidade, &medidor, &link, &valor,
			&flagF01, &flagF02, &flagF04, &flagF05,
			&segF01, &segF02, &desvioPct, &mediaF02, &consumoF02, &serie, &veredito,
			&detF04, &detF05,
		); err != nil {
			continue
		}

		// Lista de fichas confirmadas (F03 já não existe nesta visão).
		fichas := []string{}
		if flagF01.Int64 == 1 {
			fichas = append(fichas, "F01")
		}
		if flagF02.Int64 == 1 {
			fichas = append(fichas, "F02")
		}
		if flagF04.Int64 == 1 {
			fichas = append(fichas, "F04")
		}
		if flagF05.Int64 == 1 {
			fichas = append(fichas, "F05")
		}

		// classe de desvio a partir do percentual (≥200% pico, ≥100% alto)
		classe := ""
		if flagF02.Int64 == 1 {
			if desvioPct.Float64 >= 200 {
				classe = "PICO_OUTLIER"
			} else if desvioPct.Float64 >= 100 {
				classe = "DESVIO_ALTO"
			}
		}

		// veredito_f02 → f02_validacao (vocabulário do front)
		f02Val := ""
		switch veredito.String {
		case "ANOMALIA":
			f02Val = "CONFIRMADO"
		case "ATIVACAO":
			f02Val = "ATIVACAO"
		case "INFORMAR":
			f02Val = "SEM_3_PROXIMAS"
		}

		row := map[string]interface{}{
			// Identificação (chaves capitalizadas = as que o front filtra/ordena)
			"id":             id.Int64,
			"UC":             uc.String,
			"Cod_Empresa":    codEmp.Int64,
			"Concessionaria": conc.String,
			"distribuidora":  conc.String,
			"Mes_Ref":        mesRef.String,
			"mes_referencia": mesRef.String,
			"Tp_Tensao":      tpTensao.String,
			"tensao_fornecimento":  tpTensao.String,
			"Modalidade_Tarifaria": modalidade.String,
			"modalidade_tarifaria": modalidade.String,
			"numero_medidor":       medidor.String,
			"Link":                 link.String,
			"link_fatura":          link.String,
			"RS_Total_Fatura":      valor.Float64,
			"valor_total_fatura":   valor.Float64,

			// Apontamentos do motor (espelha /fde-analise em MOTOR MODE)
			"fichas_aplicadas":  strings.Join(fichas, ","),
			"desvio_pct_max":    desvioPct.Float64,
			"classe_desvio":     classe,
			"f02_validacao":     f02Val,
			"segmentos_f01":     segF01.String,
			"segmentos_alerta_f02": segF02.String,
			"media_f02":         mediaF02.Float64,
			"consumo_atual_f02": consumoF02.Float64,
			"serie_f02":         serie.String,
			"detalhe_f04":       detF04.String,
			"detalhe_f05":       detF05.String,
			"status_passibilidade": nil, // N/A na visão FRC

			// Decisão sintética p/ getDecisao()/flags do front funcionarem
			"resultado_analises": map[string]interface{}{
				"ia_opus_5_4_decisao": map[string]interface{}{
					"decisao_final":      "APONTADO",
					"fichas_confirmadas": fichas,
					"origem":             "motor_regras_frc",
				},
			},
		}
		result = append(result, row)
	}

	c.JSON(http.StatusOK, result)
}
