package handlers

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"ressarcimento-backend/database"
)

// desvio_sgeeasy_gap_handler.go — Aba "Lacunas do sgeeasy".
//
// Roda a query unificada F01–F05 sobre a Faturas_Registradas_Cache (sgeeasy,
// conexão database.GormDB_Faturas) e devolve SÓ os apontamentos que o sgeeasy
// pega e o motor sobre a FATURA_DADOS_EXTRAIDOS NÃO pega. Casamento por `uid`
// (chave comum origem↔FDE). As constantes @... foram embutidas pra a query rodar
// em uma única instrução (evita depender de variáveis de sessão no pool).

const sqlSgeeasyGapUnificada = `
WITH
base_raw AS (
  SELECT
    f.id, f.uid, f.UC, f.Cod_Empresa, f.Concessionaria, f.Mes_Ref,
    f.Tp_Tensao, f.Modalidade_Tarifaria, f.NroMedidor,
    f.Link, f.RS_Total_Fatura,
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
  WHERE f.Cod_Empresa IN (205, 224, 206, 370, 369, 199, 371, 374, 366, 144, 145, 210, 14, 22, 4, 32, 135)
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
  SELECT
    id,
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
    MAX(NroMedidor)                    AS NroMedidor,
    MAX(med_ant)                       AS nro_medidor_ant,
    ROUND(MAX(dif_pct) * 100, 1)       AS desvio_pct_max,
    MAX(eh_f02)                        AS flag_f02,
    MAX(eh_f03)                        AS flag_f03,
    MAX(eh_f04)                        AS flag_f04,
    MAX(eh_f05)                        AS flag_f05
  FROM seg_alerta
  GROUP BY id, UC, Cod_Empresa, Concessionaria, Mes_Ref, Tp_Tensao, Link, RS_Total_Fatura
)
SELECT
  b.id, b.uid, b.UC, b.Cod_Empresa, b.Concessionaria, b.Mes_Ref,
  b.Tp_Tensao, b.NroMedidor, b.Link, b.RS_Total_Fatura,
  ROUND(b.kwh_p + b.kwh_fp + b.kwh_r, 2) AS consumo_sgeeasy,
  TRIM(BOTH ' | ' FROM CONCAT_WS(' | ',
    CASE WHEN COALESCE(f1.flag_f01,  0) = 1 THEN 'F01' END,
    CASE WHEN COALESCE(f25.flag_f02, 0) = 1 THEN 'F02' END,
    CASE WHEN COALESCE(f25.flag_f03, 0) = 1 THEN 'F03' END,
    CASE WHEN COALESCE(f25.flag_f04, 0) = 1 THEN 'F04' END,
    CASE WHEN COALESCE(f25.flag_f05, 0) = 1 THEN 'F05' END
  )) AS fichas_aplicadas,
  (COALESCE(f1.flag_f01,0) + COALESCE(f25.flag_f02,0) + COALESCE(f25.flag_f03,0)
   + COALESCE(f25.flag_f04,0) + COALESCE(f25.flag_f05,0)) AS qtd_regras,
  COALESCE(f1.flag_f01,0)  AS flag_f01,
  COALESCE(f25.flag_f02,0) AS flag_f02,
  COALESCE(f25.flag_f03,0) AS flag_f03,
  COALESCE(f25.flag_f04,0) AS flag_f04,
  COALESCE(f25.flag_f05,0) AS flag_f05,
  f25.desvio_pct_max,
  CASE WHEN COALESCE(f25.flag_f04,0) = 1
       THEN CONCAT(COALESCE(f25.nro_medidor_ant,''), ' | ', COALESCE(f25.NroMedidor,''))
       ELSE NULL END AS troca_medidor,
  CASE WHEN f25.desvio_pct_max > 150 THEN 'OUTLIER'
       WHEN f25.desvio_pct_max > 80  THEN 'DESVIO_ALTO'
       ELSE NULL END AS categoria_desvio
FROM base_raw b
LEFT JOIN f01_resultado f1 ON f1.id = b.id
LEFT JOIN f02_f05_por_fatura f25 ON f25.id = b.id
-- Só desvio alto (>80%) e outlier (>150%). Desvios menores e apontamentos
-- sem magnitude de desvio (ex.: F01 formula) ficam de fora.
WHERE COALESCE(f25.desvio_pct_max, 0) > 80
ORDER BY COALESCE(f25.desvio_pct_max, 0) DESC
LIMIT 400000`

// Cache do resultado bruto do sgeeasy (query pesada). TTL curto; a subtração
// contra a FDE é refeita a cada request (barata).
var (
	sgeeasyGapMu    sync.Mutex
	sgeeasyGapCache []map[string]interface{}
	sgeeasyGapAt    time.Time
)

const sgeeasyGapTTL = 5 * time.Minute

// GetDesvioSgeeasyGap — GET /api/v1/faturas/fde-analise/sgeeasy-gap
// Apontamentos do sgeeasy (F01–F05) cujo `uid` NÃO está entre os apontados pelo
// motor da FATURA_DADOS_EXTRAIDOS. É a "lacuna": o que a extração perdeu.
func GetDesvioSgeeasyGap(c *gin.Context) {
	if database.GormDB_Faturas == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "conexão FRC (sgeeasy) indisponível"})
		return
	}
	appDB := database.GormDB_App
	if appDB == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco do app indisponível"})
		return
	}
	appSQL, err := appDB.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão app"})
		return
	}

	// 1) motor da FDE (apontados) + detalhes por id (uid/uc/mês/empresa/consumo/sefaz)
	apont, mErr := motorApontamentosCached(appSQL, "", true)
	if mErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro no motor: " + mErr.Error()})
		return
	}
	fdeUids := map[string]bool{}                       // uids apontados pelo motor
	fdeApontados := []map[string]interface{}{}         // detalhes dos apontados FDE (p/ reverso)
	if len(apont) > 0 {
		ids := make([]string, 0, len(apont))
		for id := range apont {
			ids = append(ids, strconv.FormatInt(id, 10))
		}
		q := `SELECT id, COALESCE(uid,''), COALESCE(codigo_uc,''), COALESCE(cod_empresa,0),
		             COALESCE(mes_referencia,''), COALESCE(kwh_total,0),
		             COALESCE(consumo_ativo_sefaz_kwh,0), COALESCE(link_fatura,'')
		      FROM FATURA_DADOS_EXTRAIDOS WHERE id IN (` + strings.Join(ids, ",") + `)`
		if ur, e := appSQL.Query(q); e == nil {
			for ur.Next() {
				var (
					id, cod          int64
					u, uc, mes, link string
					kwhTot, sefaz    float64
				)
				if ur.Scan(&id, &u, &uc, &cod, &mes, &kwhTot, &sefaz, &link) != nil {
					continue
				}
				if u != "" {
					fdeUids[u] = true
				}
				mr := apont[id]
				fdeApontados = append(fdeApontados, map[string]interface{}{
					"id": id, "uid": u, "UC": uc, "cod_empresa": cod, "mes_ref": mes,
					"consumo_fde": kwhTot, "consumo_sefaz": sefaz,
					"link":             link,
					"desvio_pct_max":   mr.DesvioPctMax,
					"fichas_aplicadas": strings.Join(mr.FichasAplicadas, " | "),
				})
			}
			ur.Close()
		}
	}

	// 2) apontamentos do sgeeasy (com cache)
	sgeeasyGapMu.Lock()
	fresh := sgeeasyGapCache != nil && time.Since(sgeeasyGapAt) < sgeeasyGapTTL
	cached := sgeeasyGapCache
	sgeeasyGapMu.Unlock()

	var sgeeasy []map[string]interface{}
	if fresh {
		sgeeasy = cached
	} else {
		frcSQL, e := database.GormDB_Faturas.DB()
		if e != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão sgeeasy"})
			return
		}
		rows, qe := frcSQL.Query(sqlSgeeasyGapUnificada)
		if qe != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "erro na query sgeeasy: " + qe.Error()})
			return
		}
		defer rows.Close()
		sgeeasy = []map[string]interface{}{}
		for rows.Next() {
			var (
				id                                       int64
				uid, uc, conc, mes, tensao, medidor, link sql.NullString
				cod                                       sql.NullInt64
				rsTotal                                   sql.NullString
				consSg                                    sql.NullFloat64
				fichas                                    sql.NullString
				qtd                                       sql.NullInt64
				f01, f02, f03, f04, f05                   int
				desvio                                    sql.NullFloat64
				troca, categoria                          sql.NullString
			)
			if rows.Scan(&id, &uid, &uc, &cod, &conc, &mes, &tensao, &medidor, &link, &rsTotal,
				&consSg, &fichas, &qtd, &f01, &f02, &f03, &f04, &f05, &desvio, &troca, &categoria) != nil {
				continue
			}
			sgeeasy = append(sgeeasy, map[string]interface{}{
				"id":               id,
				"uid":              nsStr(uid),
				"UC":               nsStr(uc),
				"cod_empresa":      niInt(cod),
				"concessionaria":   nsStr(conc),
				"mes_ref":          nsStr(mes),
				"tp_tensao":        nsStr(tensao),
				"nro_medidor":      nsStr(medidor),
				"link":             nsStr(link),
				"rs_total_fatura":  nsStr(rsTotal),
				"consumo_sgeeasy":  nfFloat(consSg),
				"fichas_aplicadas": nsStr(fichas),
				"qtd_regras":       niInt(qtd),
				"flag_f01":         f01,
				"flag_f02":         f02,
				"flag_f03":         f03,
				"flag_f04":         f04,
				"flag_f05":         f05,
				"desvio_pct_max":   nfFloat(desvio),
				"troca_medidor":    nsStr(troca),
				"categoria_desvio": nsStr(categoria),
			})
		}
		sgeeasyGapMu.Lock()
		sgeeasyGapCache = sgeeasy
		sgeeasyGapAt = time.Now()
		sgeeasyGapMu.Unlock()
	}

	// índice uid → consumo do sgeeasy (p/ enriquecer o reverso) + set de uids sgeeasy
	sgUids := map[string]bool{}
	for _, r := range sgeeasy {
		if u, _ := r["uid"].(string); u != "" {
			sgUids[u] = true
		}
	}

	// 3) fdeByUid — existência + consumo/sefaz na FDE para TODOS os uids do sgeeasy
	//    (pra dizer o MOTIVO da lacuna: não extraída vs consumo divergente vs algoritmo)
	type fdeInfo struct {
		id     int64
		kwhTot float64
		sefaz  float64
	}
	fdeByUid := map[string]fdeInfo{}
	{
		uids := make([]string, 0, len(sgeeasy))
		for _, r := range sgeeasy {
			if u, _ := r["uid"].(string); u != "" {
				uids = append(uids, u)
			}
		}
		for i := 0; i < len(uids); i += 5000 { // chunk pra não estourar a query
			end := i + 5000
			if end > len(uids) {
				end = len(uids)
			}
			chunk := uids[i:end]
			ph := strings.TrimRight(strings.Repeat("?,", len(chunk)), ",")
			args := make([]interface{}, len(chunk))
			for j, u := range chunk {
				args[j] = u
			}
			q := "SELECT COALESCE(id,0), COALESCE(uid,''), COALESCE(kwh_total,0), COALESCE(consumo_ativo_sefaz_kwh,0) FROM FATURA_DADOS_EXTRAIDOS WHERE uid IN (" + ph + ")"
			if fr, e := appSQL.Query(q, args...); e == nil {
				for fr.Next() {
					var fid int64
					var u string
					var k, s float64
					if fr.Scan(&fid, &u, &k, &s) == nil && u != "" {
						fdeByUid[u] = fdeInfo{id: fid, kwhTot: k, sefaz: s}
					}
				}
				fr.Close()
			}
		}
	}

	// 4) LACUNAS (sgeeasy → falta na FDE) enriquecidas com motivo + consumos
	lacunas := make([]map[string]interface{}, 0, len(sgeeasy))
	// uids rejeitados manualmente (sgeeasy, via /sgeeasy/rejeitar-apontamento) não
	// reaparecem na lista de Inconclusivos.
	rejUids := map[string]bool{}
	if rr, re := appSQL.Query("SELECT DISTINCT uid FROM FATURA_REANALISES WHERE recomendacao='REJEITADO' AND uid IS NOT NULL AND uid<>''"); re == nil {
		for rr.Next() {
			var ru string
			if rr.Scan(&ru) == nil {
				rejUids[ru] = true
			}
		}
		rr.Close()
	}
	semUid := 0
	for _, r := range sgeeasy {
		u, _ := r["uid"].(string)
		if u == "" {
			semUid++
			continue
		}
		if fdeUids[u] {
			continue // já apontado pela FDE → não é lacuna
		}
		if rejUids[u] {
			continue // rejeitado manualmente pelo analista
		}
		item := map[string]interface{}{}
		for k, v := range r {
			item[k] = v
		}
		consSg, _ := r["consumo_sgeeasy"].(float64)
		fi, existe := fdeByUid[u]
		if !existe {
			item["motivo"] = "nao_extraida"
			item["consumo_fde"] = nil
			item["consumo_sefaz"] = nil
			item["fde_id"] = nil
		} else {
			// aponta para a fatura do FDE (mesmo uid) — vira apontamento fonte FDE
			item["fde_id"] = fi.id
			item["consumo_fde"] = fi.kwhTot
			item["consumo_sefaz"] = fi.sefaz
			switch {
			case fi.kwhTot <= 0:
				item["motivo"] = "fde_sem_consumo"
			case consSg > 0 && (absF(fi.kwhTot-consSg)/consSg) > 0.10:
				item["motivo"] = "consumo_divergente"
			default:
				item["motivo"] = "so_algoritmo"
			}
		}
		lacunas = append(lacunas, item)
	}

	// 5) REVERSO (FDE → falta no sgeeasy): apontados pela FDE cujo uid não está entre os do sgeeasy
	reverso := make([]map[string]interface{}, 0)
	for _, r := range fdeApontados {
		u, _ := r["uid"].(string)
		if u == "" || sgUids[u] {
			continue
		}
		item := map[string]interface{}{}
		for k, v := range r {
			item[k] = v
		}
		item["motivo"] = "so_fde" // FDE apontou; sgeeasy não pegou (consumo/histórico diferente)
		reverso = append(reverso, item)
	}

	c.JSON(http.StatusOK, gin.H{
		"total_sgeeasy":       len(sgeeasy),
		"total_fde_apontados": len(fdeApontados),
		"sem_uid":             semUid,
		"lacunas":             gin.H{"total": len(lacunas), "items": lacunas},
		"reverso":             gin.H{"total": len(reverso), "items": reverso},
	})
}

func absF(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

// helpers de conversão de sql.Null* → valor/nil (nomes curtos, exclusivos deste arquivo)
func nsStr(v sql.NullString) interface{} {
	if v.Valid {
		return v.String
	}
	return nil
}
func niInt(v sql.NullInt64) interface{} {
	if v.Valid {
		return v.Int64
	}
	return nil
}
func nfFloat(v sql.NullFloat64) interface{} {
	if v.Valid {
		return v.Float64
	}
	return nil
}

// GetUCHistoricoLocal — GET /api/v1/faturas/uc-historico-local?uc=
// Histórico mensal da UC lido do ESPELHO local (db_ressarcimento.Faturas_Registradas_Cache),
// não do sgeeasy remoto. Mesma forma de saída do GetUCFaturas (gráfico do modal).
func GetUCHistoricoLocal(c *gin.Context) {
	uc := strings.TrimSpace(c.Query("uc"))
	if uc == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "uc obrigatório"})
		return
	}
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
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
		        RS_Total_Fatura, Status_Fatura, Link
		 FROM Faturas_Registradas_Cache WHERE UC = ? ORDER BY Mes_Ref DESC LIMIT 200`, uc)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao consultar espelho: " + err.Error()})
		return
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := []map[string]any{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if rows.Scan(ptrs...) != nil {
			continue
		}
		m := make(map[string]any, len(cols))
		for i, col := range cols {
			v := vals[i]
			if b, ok := v.([]byte); ok {
				m[col] = string(b)
			} else {
				m[col] = v
			}
		}
		out = append(out, m)
	}
	c.JSON(http.StatusOK, out)
}

// ressEstimadoDesvio — ressarcimento estimado pela mesma fórmula do resto do sistema:
// base_energia × d/(1+d) × fator (fator=1.0 hoje). d = desvio%/100. Sem energia → 0.
func ressEstimadoDesvio(energia, desvioPct float64) float64 {
	d := desvioPct / 100.0
	if energia > 0 && d > 0 {
		return energia * (d / (1 + d)) * FatorRetencaoRessarcimento
	}
	return 0
}

// GetConvergenciaFDEAnalise — GET /api/v1/faturas/fde-analise/convergencia
// União de TODOS os apontamentos (FDE ∪ sgeeasy), 1 linha por fatura, com:
//   • fonte: "fde" | "sgeeasy" | "ambos"
//   • ressarcimento estimado pelo desvio (base energia da FDE quando existe)
// FDE → dados da FATURA_DADOS_EXTRAIDOS; sgeeasy-only → dados da Faturas_Registradas_Cache.
func GetConvergenciaFDEAnalise(c *gin.Context) {
	if database.GormDB_Faturas == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "conexão FRC (sgeeasy) indisponível"})
		return
	}
	appDB := database.GormDB_App
	if appDB == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco do app indisponível"})
		return
	}
	appSQL, err := appDB.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão app"})
		return
	}

	// 1) FDE apontados (motor) + detalhes (com valor_energia_ativa p/ ressarcimento)
	apont, mErr := motorApontamentosCached(appSQL, "", true)
	if mErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro no motor: " + mErr.Error()})
		return
	}
	fdeUids := map[string]bool{}
	items := []map[string]interface{}{}
	if len(apont) > 0 {
		ids := make([]string, 0, len(apont))
		for id := range apont {
			ids = append(ids, strconv.FormatInt(id, 10))
		}
		q := `SELECT id, COALESCE(uid,''), COALESCE(codigo_uc,''), COALESCE(cod_empresa,0),
		             COALESCE(mes_referencia,''), COALESCE(distribuidora,''),
		             COALESCE(valor_energia_ativa,0), COALESCE(valor_total_fatura,0),
		             COALESCE(kwh_total,0), COALESCE(consumo_ativo_sefaz_kwh,0), COALESCE(link_fatura,'')
		      FROM FATURA_DADOS_EXTRAIDOS WHERE id IN (` + strings.Join(ids, ",") + `)`
		if r, e := appSQL.Query(q); e == nil {
			for r.Next() {
				var (
					id, cod                          int64
					u, uc, mes, dist, link           string
					energia, vtot, kwhTot, sefaz     float64
				)
				if r.Scan(&id, &u, &uc, &cod, &mes, &dist, &energia, &vtot, &kwhTot, &sefaz, &link) != nil {
					continue
				}
				if u != "" {
					fdeUids[u] = true
				}
				mr := apont[id]
				items = append(items, map[string]interface{}{
					"id": id, "uid": u, "UC": uc, "cod_empresa": cod, "mes_ref": mes,
					"distribuidora": dist, "fonte": "fde",
					"consumo": kwhTot, "consumo_sefaz": sefaz,
					"valor_energia_ativa": energia, "valor_total_fatura": vtot,
					"desvio_pct_max":   mr.DesvioPctMax,
					"fichas_aplicadas": strings.Join(mr.FichasAplicadas, " | "),
					"link":             link,
					"ressarcimento":    ressEstimadoDesvio(energia, mr.DesvioPctMax),
				})
			}
			r.Close()
		}
	}

	// 2) sgeeasy apontados (cache compartilhado com /sgeeasy-gap)
	sgeeasyGapMu.Lock()
	fresh := sgeeasyGapCache != nil && time.Since(sgeeasyGapAt) < sgeeasyGapTTL
	sgeeasy := sgeeasyGapCache
	sgeeasyGapMu.Unlock()
	if !fresh {
		frcSQL, e := database.GormDB_Faturas.DB()
		if e != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão sgeeasy"})
			return
		}
		rows, qe := frcSQL.Query(sqlSgeeasyGapUnificada)
		if qe != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "erro na query sgeeasy: " + qe.Error()})
			return
		}
		defer rows.Close()
		sgeeasy = []map[string]interface{}{}
		for rows.Next() {
			var (
				id                                        int64
				uid, uc, conc, mes, tensao, medidor, link sql.NullString
				cod                                       sql.NullInt64
				rsTotal                                   sql.NullString
				consSg                                    sql.NullFloat64
				fichas                                    sql.NullString
				qtd                                       sql.NullInt64
				f01, f02, f03, f04, f05                   int
				desvio                                    sql.NullFloat64
				troca, categoria                          sql.NullString
			)
			if rows.Scan(&id, &uid, &uc, &cod, &conc, &mes, &tensao, &medidor, &link, &rsTotal,
				&consSg, &fichas, &qtd, &f01, &f02, &f03, &f04, &f05, &desvio, &troca, &categoria) != nil {
				continue
			}
			sgeeasy = append(sgeeasy, map[string]interface{}{
				"id": id, "uid": nsStr(uid), "UC": nsStr(uc), "cod_empresa": niInt(cod),
				"concessionaria": nsStr(conc), "mes_ref": nsStr(mes), "link": nsStr(link),
				"rs_total_fatura": nsStr(rsTotal), "consumo_sgeeasy": nfFloat(consSg),
				"fichas_aplicadas": nsStr(fichas), "desvio_pct_max": nfFloat(desvio),
			})
		}
		sgeeasyGapMu.Lock()
		sgeeasyGapCache = sgeeasy
		sgeeasyGapAt = time.Now()
		sgeeasyGapMu.Unlock()
	}

	// marca fonte "ambos" nos FDE que também estão no sgeeasy
	sgByUid := map[string]bool{}
	for _, r := range sgeeasy {
		if u, _ := r["uid"].(string); u != "" {
			sgByUid[u] = true
		}
	}
	for _, it := range items {
		if u, _ := it["uid"].(string); u != "" && sgByUid[u] {
			it["fonte"] = "ambos"
		}
	}

	// 3) energia por uid p/ ressarcimento dos sgeeasy-only (fatura pode existir na FDE com energia)
	energiaByUid := map[string]float64{}
	{
		uids := []string{}
		for _, r := range sgeeasy {
			if u, _ := r["uid"].(string); u != "" && !fdeUids[u] {
				uids = append(uids, u)
			}
		}
		for i := 0; i < len(uids); i += 5000 {
			end := i + 5000
			if end > len(uids) {
				end = len(uids)
			}
			chunk := uids[i:end]
			ph := strings.TrimRight(strings.Repeat("?,", len(chunk)), ",")
			args := make([]interface{}, len(chunk))
			for j, u := range chunk {
				args[j] = u
			}
			if fr, e := appSQL.Query("SELECT COALESCE(uid,''), COALESCE(valor_energia_ativa,0) FROM FATURA_DADOS_EXTRAIDOS WHERE uid IN ("+ph+")", args...); e == nil {
				for fr.Next() {
					var u string
					var en float64
					if fr.Scan(&u, &en) == nil && u != "" {
						energiaByUid[u] = en
					}
				}
				fr.Close()
			}
		}
	}

	// 4) adiciona os sgeeasy-only (lacunas) — dados do sgeeasy
	for _, r := range sgeeasy {
		u, _ := r["uid"].(string)
		if u == "" || fdeUids[u] {
			continue // já entrou como fde/ambos
		}
		desvio, _ := r["desvio_pct_max"].(float64)
		consSg, _ := r["consumo_sgeeasy"].(float64)
		energia := energiaByUid[u] // pode ser 0 (sgeeasy não tem energia)
		items = append(items, map[string]interface{}{
			"id": r["id"], "uid": u, "UC": r["UC"], "cod_empresa": r["cod_empresa"],
			"mes_ref": r["mes_ref"], "distribuidora": r["concessionaria"], "fonte": "sgeeasy",
			"consumo": consSg, "consumo_sefaz": nil,
			"valor_energia_ativa": energia, "valor_total_fatura": r["rs_total_fatura"],
			"desvio_pct_max": desvio, "fichas_aplicadas": r["fichas_aplicadas"],
			"link":          r["link"],
			"ressarcimento": ressEstimadoDesvio(energia, desvio),
		})
	}

	c.JSON(http.StatusOK, gin.H{"total": len(items), "items": items})
}
