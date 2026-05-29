package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"ressarcimento-backend/database"
)

type FaturaComAnalise struct {
	ID                int64           `json:"id"`
	UC                string          `json:"UC"`
	Valor             float64         `json:"valor"`
	Concessionaria    string          `json:"concessionaria"`
	MesRef            string          `json:"mes_ref"`
	Status            string          `json:"status"`
	CodEmpresa        int64           `json:"Cod_Empresa"`
	Cliente           string          `json:"cliente"`
	ResultadoAnalises json.RawMessage `json:"resultado_analises"`
}

// GET /api/v1/faturas/com-analise
// Lista faturas com resultado_analises preenchido
// Query Params: empresa (int), status (string), limit (int)
func ListFaturasComAnalise(c *gin.Context) {
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

	// Parse query params
	empresa := c.DefaultQuery("empresa", "")
	status := c.DefaultQuery("status", "")
	limitStr := c.DefaultQuery("limit", "1000")
	limit, _ := strconv.Atoi(limitStr)
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}

	// Monta query base — JOIN com Tab_Empresa para trazer Rz_Social do cliente
	query := `
		SELECT
			frc.id,
			frc.UC,
			frc.RS_Total_Fatura                                                                        AS valor,
			frc.Concessionaria,
			frc.Mes_Ref,
			COALESCE(JSON_EXTRACT(frc.resultado_analises, '$.ia_opus_5_4_decisao.decisao_final'), 'PENDENTE') AS status,
			COALESCE(frc.Cod_Empresa, 0)                                                                AS cod_empresa,
			COALESCE((SELECT e.Rz_Social FROM Tab_Empresa e WHERE e.Cod_Empresa = frc.Cod_Empresa LIMIT 1), '') AS cliente,
			frc.resultado_analises
		FROM Faturas_Registradas_Cache frc
		WHERE frc.resultado_analises IS NOT NULL
		  AND LOWER(COALESCE(frc.UC, '')) NOT LIKE '%boleto%'
		  AND LOWER(COALESCE(frc.RAZAO_SOCIAL, '')) NOT LIKE '%boleto%'
		  AND LOWER(COALESCE(frc.Concessionaria, '')) NOT LIKE '%boleto%'
	`

	var args []interface{}

	// Filtro por empresa (Cod_Empresa)
	if empresa != "" && empresa != "0" {
		query += " AND frc.Cod_Empresa = ?"
		args = append(args, empresa)
	}

	// Filtro por status (decisão final da análise)
	if status != "" {
		query += " AND JSON_EXTRACT(frc.resultado_analises, '$.ia_opus_5_4_decisao.decisao_final') = ?"
		args = append(args, status)
	}

	query += " ORDER BY frc.id DESC LIMIT ?"
	args = append(args, limit)

	rows, qErr := sqlDB.Query(query, args...)
	if qErr != nil {
		fmt.Printf("[ListFaturasComAnalise] erro: %v\n", qErr)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar faturas"})
		return
	}
	defer rows.Close()

	var faturas []FaturaComAnalise
	for rows.Next() {
		var f FaturaComAnalise
		var resultado sql.NullString
		var cliente sql.NullString
		err := rows.Scan(
			&f.ID,
			&f.UC,
			&f.Valor,
			&f.Concessionaria,
			&f.MesRef,
			&f.Status,
			&f.CodEmpresa,
			&cliente,
			&resultado,
		)
		if err != nil {
			fmt.Printf("[ListFaturasComAnalise] erro ao escanear: %v\n", err)
			continue
		}
		if resultado.Valid {
			f.ResultadoAnalises = json.RawMessage(resultado.String)
		}
		if cliente.Valid {
			f.Cliente = cliente.String
		}
		faturas = append(faturas, f)
	}

	c.JSON(http.StatusOK, faturas)
}

// GET /api/v1/faturas/{id}/detalhes
// Retorna detalhes completos de uma fatura com resultado_analises
func GetFaturaDetalhes(c *gin.Context) {
	faturaID := c.Param("id")
	if faturaID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id obrigatório"})
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

	query := `
		SELECT
			frc.id,
			frc.UC,
			frc.RS_Total_Fatura                                                                        AS valor,
			frc.Concessionaria,
			frc.Mes_Ref,
			COALESCE(JSON_EXTRACT(frc.resultado_analises, '$.ia_opus_5_4_decisao.decisao_final'), 'PENDENTE') AS status,
			COALESCE(frc.Cod_Empresa, 0)                                                                AS cod_empresa,
			COALESCE((SELECT e.Rz_Social FROM Tab_Empresa e WHERE e.Cod_Empresa = frc.Cod_Empresa LIMIT 1), '') AS cliente,
			frc.resultado_analises
		FROM Faturas_Registradas_Cache frc
		WHERE frc.id = ?
	`

	var f FaturaComAnalise
	var resultado sql.NullString
	var cliente sql.NullString
	err = sqlDB.QueryRow(query, faturaID).Scan(
		&f.ID,
		&f.UC,
		&f.Valor,
		&f.Concessionaria,
		&f.MesRef,
		&f.Status,
		&f.CodEmpresa,
		&cliente,
		&resultado,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "fatura não encontrada"})
			return
		}
		fmt.Printf("[GetFaturaDetalhes] erro: %v\n", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar fatura"})
		return
	}

	if resultado.Valid {
		f.ResultadoAnalises = json.RawMessage(resultado.String)
	}
	if cliente.Valid {
		f.Cliente = cliente.String
	}

	c.JSON(http.StatusOK, f)
}

// POST /api/v1/faturas/{id}/reprocessar-ia
// Reprocessa uma fatura com IA (chama arbitragem)
func ReprocessarFaturaIA(c *gin.Context) {
	faturaID := c.Param("id")
	if faturaID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id obrigatório"})
		return
	}

	// Valida que é um ID válido
	_, err := strconv.ParseInt(faturaID, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}

	// Chama o handler de arbitragem existente
	ArbitrarFaturaHandler(c)
}

// ListFaturasFDEAnalise lista registros de FATURA_DADOS_EXTRAIDOS que têm fichas_apontadas preenchidas
// (resultado do pipeline IA). Retorna os campos no mesmo formato que AnaliseDesvio.jsx espera,
// mantendo compatibilidade com getDecisao() e extractFichas() do frontend.
//
// GET /api/v1/faturas/fde-analise?empresa=14&status=CONFIRMADO&ficha=F02&limit=2000
func ListFaturasFDEAnalise(c *gin.Context) {
	// FATURA_DADOS_EXTRAIDOS fica em db_ressarcimento, conectado via GormDB_App
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

	limitStr := c.DefaultQuery("limit", "2000")
	limit, _ := strconv.Atoi(limitStr)
	if limit <= 0 || limit > 5000 {
		limit = 2000
	}

	empresa := strings.TrimSpace(c.Query("empresa"))
	status := strings.TrimSpace(c.Query("status"))                // CONFIRMADO | INCONCLUSIVO | REFUTADO
	ficha := strings.ToUpper(strings.TrimSpace(c.Query("ficha"))) // F01..F14
	passibilidade := strings.ToUpper(strings.TrimSpace(c.Query("passibilidade"))) // PARCELAMENTO_SOBREPOSTO | PASSIVEL_CICLO_INFINITO | COMPENSADO_NEUTRALIZADO | TEM_PARCELAMENTO
	idFiltro := strings.TrimSpace(c.Query("id"))                   // ⭐ filtro por ID específico (para recarregar 1 fatura)

	conditions := []string{
		"fde.fichas_apontadas IS NOT NULL",
		"fde.fichas_apontadas != ''",
	}
	var args []interface{}

	// ⭐ Filtro por ID: ignora outros filtros se passado (busca direta da fatura)
	if idFiltro != "" {
		conditions = []string{"fde.id = ?"}
		args = []interface{}{idFiltro}
	} else if empresa != "" && empresa != "0" {
		conditions = append(conditions, "fde.cod_empresa = ?")
		args = append(args, empresa)
	}
	if idFiltro == "" && status != "" {
		// decisao_final está direto no JSON de fichas_apontadas
		conditions = append(conditions, "JSON_UNQUOTE(JSON_EXTRACT(fde.fichas_apontadas, '$.decisao_final')) = ?")
		args = append(args, status)
	}
	if idFiltro == "" && ficha != "" {
		// Verifica se a ficha aparece em fichas_apontadas.fichas_confirmadas[]
		conditions = append(conditions, "JSON_SEARCH(fde.fichas_apontadas, 'one', ?, NULL, '$.fichas_confirmadas[*]') IS NOT NULL")
		args = append(args, ficha)
	}
	// Filtro de passibilidade (2026-05-11): removida apenas a categoria
	// PASSIVEL_DOCUMENTAL_ABUSIVO (classificação por Y/REN não existe mais).
	// Adicionada PARCELAMENTO_SOBREPOSTO (Art.323 sobre Art.113 não paga).
	// Mantidas: PASSIVEL_CICLO_INFINITO, COMPENSADO_NEUTRALIZADO,
	// TEM_PARCELAMENTO (antigo PARCELAMENTO_LEGITIMO_REVISAR, agora só informativo).
	if idFiltro == "" && passibilidade != "" {
		switch passibilidade {
		case "PARCELAMENTO_SOBREPOSTO":
			// Art.323 incidindo sobre Art.113 ainda não paga (único caso problemático)
			conditions = append(conditions,
				`COALESCE(fde.parcela_art323_alerta, '') = 'PARCELAMENTO_SOBREPOSTO'`)
		case "PASSIVEL_CICLO_INFINITO":
			conditions = append(conditions,
				`COALESCE(fde.ciclo_infinito_art113, 0) = 1`)
		case "COMPENSADO_NEUTRALIZADO":
			conditions = append(conditions,
				`(COALESCE(fde.compensacao_ja_aplicada, 0) = 1 OR COALESCE(fde.devolucao_em_dobro_ativa, 0) = 1)`)
		case "TEM_PARCELAMENTO", "PARCELAMENTO", "PARCELAMENTO_LEGITIMO_REVISAR":
			// Parcelamento detectado (informativo, sem juízo de abusividade)
			conditions = append(conditions,
				`(COALESCE(fde.parcela_art323_alerta, '') = 'PARCELAMENTO'
				  OR COALESCE(fde.parcela_art323_y, 0) > 0)`)
		}
	}

	// SELECT completo: campos básicos + 34 colunas v19 + analise_ia + leituras
	// Todos os campos que o frontend possa querer exibir na Análise de Desvio.
	query := `
		SELECT
			fde.id,
			COALESCE(fde.uid, '')                          AS uid,
			COALESCE(fde.codigo_uc, '')                    AS codigo_uc,
			COALESCE(fde.valor_total_fatura, 0)            AS valor_total_fatura,
			COALESCE(fde.mes_referencia, '')               AS mes_referencia,
			fde.cod_empresa,
			COALESCE(fde.link_fatura, '')                  AS link_fatura,
			COALESCE(fde.distribuidora, '')                AS distribuidora,
			fde.fichas_apontadas,
			fde.resultado_em,
			COALESCE(CAST(fde.fichas_apontadas->>'$.motor_regras_sql.desvio_pct_max_f02' AS DECIMAL(10,2)), 0) AS desvio_pct_max,
			-- ⭐ TEXTO COMPLETO DA IA (gpt-5.4 / 4.1-mini decisão)
			COALESCE(fde.analise_ia, '')                   AS analise_ia,
			-- ⭐ Identificação completa
			COALESCE(fde.numero_fatura, '')                AS numero_fatura,
			COALESCE(fde.nome_cliente, '')                 AS nome_cliente,
			COALESCE(fde.modalidade_tarifaria, '')         AS modalidade_tarifaria,
			COALESCE(fde.tensao_fornecimento, '')          AS tensao_fornecimento,
			COALESCE(fde.grupo_tarifario, '')              AS grupo_tarifario,
			COALESCE(fde.numero_medidor, '')               AS numero_medidor,
			-- ⭐ Leituras e consumo
			fde.consumo_ativo_ponta_kwh,
			fde.consumo_ativo_fponta_kwh,
			fde.leit_ant_ativa_ponta,
			fde.leit_atu_ativa_ponta,
			fde.leit_ant_ativa_fponta,
			fde.leit_atu_ativa_fponta,
			fde.constante_k,
			-- ⭐ Colunas v19 — Parcelamento Art.113/323
			fde.parcela_art323_x,
			fde.parcela_art323_y,
			fde.parcela_art323_alerta,
			fde.parcela_art323_regime_norma,
			fde.parcela_art323_valor_unitario_rs,
			fde.parcela_art323_valor_unitario_efetivo_rs,
			fde.parcela_art323_total_estimado_rs,
			fde.parcela_art323_fatura_origem,
			fde.parcela_art323_encargos_extras_rs,
			fde.parcela_art323_juros_embutidos_pct,
			-- ⭐ Compensações
			fde.compensacao_ja_aplicada,
			fde.compensacao_valor_origem_real_rs,
			fde.devolucao_em_dobro_ativa,
			-- ⭐ Histórico Art.113
			fde.ciclos_min_max_consecutivos,
			fde.ciclos_med_max_consecutivos,
			fde.ciclo_infinito_art113,
			fde.min_prolongado_falso_positivo,
			fde.status_leitura_mes_atual,
			-- ⭐ Cliente / regulação
			fde.uc_publica_operada_por_terceiro,
			fde.mercado_livre_acl,
			fde.determinacao_judicial_processo,
			fde.dividas_anteriores_mesma_uc_count,
			-- ⭐ Bandeira e reativos
			fde.tipo_bandeira,
			fde.valor_bandeira_rs,
			fde.reativo_excedente_rs,
			-- ⭐ Validação aritmética
			fde.aritmetica_total_calculado_rs,
			fde.aritmetica_diff_pct,
			fde.aritmetica_ok,
			-- ⭐ Histórico de consumo extraído (12-13 meses)
			fde.historico_consumo_json,
			-- ⭐ Score de extração + auditoria
			fde.extracao_score_confianca,
			fde.extracao_revisada_por_gpt,
			fde.extracao_modelo_revisor,
			fde.extracao_hash,
			fde.extracao_revisao_em,
			-- ⭐ Status de passibilidade (2026-05-11):
			--    Removida apenas PASSIVEL_DOCUMENTAL_ABUSIVO (classificação por Y/REN
			--    descontinuada). Adicionada PARCELAMENTO_SOBREPOSTO (Art.323 sobre
			--    Art.113 não paga — único realmente problemático). Mantidas as demais.
			CASE
				-- 🆕 Único caso realmente problemático: Art.323 sobre Art.113 não paga
				WHEN COALESCE(fde.parcela_art323_alerta, '') = 'PARCELAMENTO_SOBREPOSTO'
					THEN 'PARCELAMENTO_SOBREPOSTO'
				-- Compensação ativa: cliente já está sendo restituído (descartar)
				WHEN COALESCE(fde.compensacao_ja_aplicada, 0) = 1
				  OR COALESCE(fde.devolucao_em_dobro_ativa, 0) = 1
					THEN 'COMPENSADO_NEUTRALIZADO'
				-- Ciclo infinito Art.113
				WHEN COALESCE(fde.ciclo_infinito_art113, 0) = 1
					THEN 'PASSIVEL_CICLO_INFINITO'
				-- Parcelamento detectado (informativo — sem juízo de abusividade)
				WHEN COALESCE(fde.parcela_art323_alerta, '') = 'PARCELAMENTO'
				  OR COALESCE(fde.parcela_art323_y, 0) > 0
					THEN 'TEM_PARCELAMENTO'
				ELSE NULL
			END AS status_passibilidade
		FROM FATURA_DADOS_EXTRAIDOS fde
		WHERE ` + strings.Join(conditions, " AND ") + `
		ORDER BY
			CASE
				WHEN COALESCE(fde.parcela_art323_alerta, '') = 'PARCELAMENTO_SOBREPOSTO' THEN 0
				WHEN COALESCE(fde.ciclo_infinito_art113, 0) = 1 THEN 1
				WHEN COALESCE(fde.parcela_art323_alerta, '') = 'PARCELAMENTO' THEN 2
				ELSE 9
			END,
			COALESCE(fde.parcela_art323_total_estimado_rs, 0) DESC,
			fde.id DESC
		LIMIT ?`
	args = append(args, limit)

	rows, err := sqlDB.Query(query, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar análises FDE: " + err.Error()})
		return
	}
	defer rows.Close()

	var result []map[string]interface{}
	for rows.Next() {
		var (
			id              int64
			uid             string
			codigoUC        string
			totalRS         sql.NullFloat64
			mesRef          string
			codEmpresa      sql.NullInt64
			linkFatura      string
			distribuidora   string
			fichasApontadas sql.NullString
			resultadoEm     sql.NullTime
			desvioPctMax    sql.NullFloat64
			// ⭐ Texto completo da IA
			analiseIA       string
			// ⭐ Identificação
			numeroFatura       string
			nomeCliente        string
			modalidadeTarifa   string
			tensaoForn         string
			grupoTarif         string
			numeroMedidor      string
			// ⭐ Leituras / consumo
			consumoP           sql.NullFloat64
			consumoFP          sql.NullFloat64
			leitAntP           sql.NullFloat64
			leitAtuP           sql.NullFloat64
			leitAntFP          sql.NullFloat64
			leitAtuFP          sql.NullFloat64
			constanteK         sql.NullFloat64
			// ⭐ v19 — Parcelamento
			pcX             sql.NullInt64
			pcY             sql.NullInt64
			pcAlerta        sql.NullString
			pcRegime        sql.NullString
			pcValorUnit     sql.NullFloat64
			pcValorEfetivo  sql.NullFloat64
			pcTotalEstim    sql.NullFloat64
			pcOrigem        sql.NullString
			pcEncargos      sql.NullFloat64
			pcJurosPct      sql.NullFloat64
			// ⭐ Compensações
			compAplicada    sql.NullInt64
			compValorReal   sql.NullFloat64
			dobroAtiva      sql.NullInt64
			// ⭐ Histórico Art.113
			ciclosMin       sql.NullInt64
			ciclosMed       sql.NullInt64
			cicloInfinito   sql.NullInt64
			minFP           sql.NullInt64
			statusLeitura   sql.NullString
			// ⭐ Cliente / regulação
			ucPublica       sql.NullInt64
			mercadoACL      sql.NullInt64
			detJudicial     sql.NullString
			dividasAnt      sql.NullInt64
			// ⭐ Bandeira / reativos
			tipoBandeira    sql.NullString
			valorBandeira   sql.NullFloat64
			reativoExc      sql.NullFloat64
			// ⭐ Aritmética
			aritmTotalCalc  sql.NullFloat64
			aritmDiff       sql.NullFloat64
			aritmOk         sql.NullInt64
			// ⭐ Histórico de consumo (JSON)
			historicoJSON   sql.NullString
			// ⭐ Score / auditoria
			scoreExtracao   sql.NullInt64
			revisadaGPT     sql.NullInt64
			modeloRevisor   sql.NullString
			extracaoHash    sql.NullString
			revisaoEm       sql.NullTime
			// ⭐ Status v2
			statusPassib    sql.NullString
		)
		if err := rows.Scan(
			&id, &uid, &codigoUC, &totalRS, &mesRef, &codEmpresa, &linkFatura, &distribuidora,
			&fichasApontadas, &resultadoEm, &desvioPctMax,
			&analiseIA,
			&numeroFatura, &nomeCliente, &modalidadeTarifa, &tensaoForn, &grupoTarif, &numeroMedidor,
			&consumoP, &consumoFP, &leitAntP, &leitAtuP, &leitAntFP, &leitAtuFP, &constanteK,
			&pcX, &pcY, &pcAlerta, &pcRegime, &pcValorUnit, &pcValorEfetivo, &pcTotalEstim,
			&pcOrigem, &pcEncargos, &pcJurosPct,
			&compAplicada, &compValorReal, &dobroAtiva,
			&ciclosMin, &ciclosMed, &cicloInfinito, &minFP, &statusLeitura,
			&ucPublica, &mercadoACL, &detJudicial, &dividasAnt,
			&tipoBandeira, &valorBandeira, &reativoExc,
			&aritmTotalCalc, &aritmDiff, &aritmOk,
			&historicoJSON,
			&scoreExtracao, &revisadaGPT, &modeloRevisor, &extracaoHash, &revisaoEm,
			&statusPassib,
		); err != nil {
			continue
		}

		// Parse do JSON de decisão armazenado em fichas_apontadas
		var decisaoMap map[string]interface{}
		fichasStr := ""
		if fichasApontadas.Valid && fichasApontadas.String != "" {
			if json.Unmarshal([]byte(fichasApontadas.String), &decisaoMap) == nil {
				if fcs, ok := decisaoMap["fichas_confirmadas"]; ok {
					if fcsArr, ok := fcs.([]interface{}); ok {
						parts := make([]string, 0, len(fcsArr))
						for _, f := range fcsArr {
							parts = append(parts, fmt.Sprint(f))
						}
						fichasStr = strings.Join(parts, ",")
					}
				}
			}
		}

		rsTotal := 0.0
		if totalRS.Valid {
			rsTotal = totalRS.Float64
		}
		codEmp := int64(0)
		if codEmpresa.Valid {
			codEmp = codEmpresa.Int64
		}

		// resultado_em em ISO-8601 (compatível com new Date() no JS)
		var resultadoEmStr interface{} = nil
		if resultadoEm.Valid {
			resultadoEmStr = resultadoEm.Time.Format("2006-01-02T15:04:05Z07:00")
		}

		// Helpers para converter sql.Null* em valores limpos pro JSON
		nf := func(n sql.NullFloat64) interface{} { if n.Valid { return n.Float64 }; return nil }
		ni := func(n sql.NullInt64) interface{} { if n.Valid { return n.Int64 }; return nil }
		ns := func(n sql.NullString) interface{} { if n.Valid && n.String != "" { return n.String }; return nil }
		nb := func(n sql.NullInt64) interface{} { if n.Valid { return n.Int64 == 1 }; return nil }
		nt := func(n sql.NullTime) interface{} {
			if n.Valid { return n.Time.Format("2006-01-02T15:04:05Z07:00") }
			return nil
		}
		njson := func(n sql.NullString) interface{} {
			if !n.Valid || n.String == "" { return nil }
			var v interface{}
			if json.Unmarshal([]byte(n.String), &v) == nil { return v }
			return n.String
		}

		// Wrapper que mantém compatibilidade com getDecisao() do frontend:
		// getDecisao lê row.resultado_analises.ia_opus_5_4_decisao
		row := map[string]interface{}{
			"id":              id,
			"uid":             uid,
			"UC":              codigoUC,
			"RS_Total_Fatura": rsTotal,
			"Mes_Ref":         mesRef,
			"Cod_Empresa":     codEmp,
			"cod_empresa":     codEmp,
			"Link":            linkFatura,
			"Concessionaria":  distribuidora,
			"distribuidora":   distribuidora,
			"RAZAO_SOCIAL":    nomeCliente,
			"desvio_pct_max":  func() interface{} { if desvioPctMax.Valid { return desvioPctMax.Float64 }; return 0.0 }(),
			"peso_alerta_max": 1,
			"fichas_aplicadas": fichasStr,
			"resultado_em":     resultadoEmStr,
			"resultado_analises": map[string]interface{}{
				"ia_opus_5_4_decisao": decisaoMap,
				"analise_ia_texto":    analiseIA, // ⭐ texto cru completo da IA
			},

			// ⭐ Identificação completa da fatura
			"identificacao": map[string]interface{}{
				"numero_fatura":        numeroFatura,
				"nome_cliente":         nomeCliente,
				"modalidade_tarifaria": modalidadeTarifa,
				"tensao_fornecimento":  tensaoForn,
				"grupo_tarifario":      grupoTarif,
				"numero_medidor":       numeroMedidor,
			},

			// ⭐ Medição (leituras + consumo + constante)
			"medicao": map[string]interface{}{
				"consumo_ponta_kwh":   nf(consumoP),
				"consumo_fponta_kwh":  nf(consumoFP),
				"leit_ant_ponta":      nf(leitAntP),
				"leit_atu_ponta":      nf(leitAtuP),
				"leit_ant_fponta":     nf(leitAntFP),
				"leit_atu_fponta":     nf(leitAtuFP),
				"constante_k":         nf(constanteK),
			},

			// ⭐ v19 — Parcelamento Art.113/323 (cluster mais importante)
			"parcelamento": map[string]interface{}{
				"x":                     ni(pcX),
				"y":                     ni(pcY),
				"alerta":                ns(pcAlerta),
				"regime_norma":          ns(pcRegime),
				"valor_unitario_rs":     nf(pcValorUnit),
				"valor_unitario_efetivo_rs": nf(pcValorEfetivo),
				"total_estimado_rs":     nf(pcTotalEstim),
				"fatura_origem":         ns(pcOrigem),
				"encargos_extras_rs":    nf(pcEncargos),
				"juros_embutidos_pct":   nf(pcJurosPct),
			},

			// ⭐ Compensações (anti-dupla-devolução)
			"compensacao": map[string]interface{}{
				"ja_aplicada":           nb(compAplicada),
				"valor_origem_real_rs":  nf(compValorReal),
				"devolucao_em_dobro":    nb(dobroAtiva),
			},

			// ⭐ Histórico Art.113 (violação prolongada)
			"historico_art113": map[string]interface{}{
				"ciclos_min_max_consecutivos":  ni(ciclosMin),
				"ciclos_med_max_consecutivos":  ni(ciclosMed),
				"ciclo_infinito":               nb(cicloInfinito),
				"min_prolongado_falso_positivo": nb(minFP),
				"status_leitura_mes_atual":     ns(statusLeitura),
			},

			// ⭐ Cliente / regulação
			"regulacao": map[string]interface{}{
				"uc_publica_operada_por_terceiro": nb(ucPublica),
				"mercado_livre_acl":               nb(mercadoACL),
				"determinacao_judicial_processo":  ns(detJudicial),
				"dividas_anteriores_mesma_uc":     ni(dividasAnt),
			},

			// ⭐ Bandeira e reativos
			"bandeira": map[string]interface{}{
				"tipo":              ns(tipoBandeira),
				"valor_rs":          nf(valorBandeira),
				"reativo_excedente_rs": nf(reativoExc),
			},

			// ⭐ Validação aritmética independente
			"aritmetica": map[string]interface{}{
				"total_calculado_rs": nf(aritmTotalCalc),
				"diff_pct":           nf(aritmDiff),
				"ok":                 nb(aritmOk),
			},

			// ⭐ Histórico de consumo (12-13 meses do rodapé da fatura)
			"historico_consumo": njson(historicoJSON),

			// ⭐ Score de extração + auditoria (Estratégia B + D)
			"extracao": map[string]interface{}{
				"score_confianca":   ni(scoreExtracao),
				"revisada_por_gpt":  nb(revisadaGPT),
				"modelo_revisor":    ns(modeloRevisor),
				"hash":              ns(extracaoHash),
				"revisao_em":        nt(revisaoEm),
			},

			// ⭐ Status final de passibilidade (computado)
			"status_passibilidade": ns(statusPassib),
		}
		result = append(result, row)
	}

	if result == nil {
		result = []map[string]interface{}{}
	}
	c.JSON(http.StatusOK, result)
}

// ListEmpresasFDEAnalise retorna a lista de empresas que têm faturas no
// status pedido (param `status`), com nome e quantidade. Usado pra montar
// sub-abas dinâmicas na tela de Análise de Desvio. Quando o usuário cadastra
// uma empresa nova com faturas, ela aparece automaticamente na próxima
// requisição — sem precisar mudar código.
//
// GET /api/v1/faturas/fde-analise/empresas?status=CONFIRMADO
func ListEmpresasFDEAnalise(c *gin.Context) {
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

	conditions := []string{
		"fde.fichas_apontadas IS NOT NULL",
		"fde.fichas_apontadas != ''",
		"fde.cod_empresa IS NOT NULL",
	}
	args := []interface{}{}

	status := strings.TrimSpace(c.Query("status"))
	if status != "" {
		conditions = append(conditions,
			"JSON_UNQUOTE(JSON_EXTRACT(fde.fichas_apontadas, '$.decisao_final')) = ?")
		args = append(args, status)
	}

	// Filtro de candidatos: só faz sentido em CONFIRMADO (mostrar onde a IA
	// confirmou alguma ficha ou onde o motor SQL apontou desvio relevante).
	// Em REFUTADO/INCONCLUSIVO, a IA já decidiu sobre o caso — todo registro
	// com decisao_final preenchida deve aparecer, independente das flags do
	// motor (que muitas vezes vêm zeradas porque o pipeline regrava o JSON).
	if status == "CONFIRMADO" || status == "" {
		conditions = append(conditions, `(
			CAST(COALESCE(fde.fichas_apontadas->>'$.motor_regras_sql.desvio_pct_max_f02', '0') AS DECIMAL(10,2)) >= 80
			OR JSON_SEARCH(fde.fichas_apontadas->'$.fichas_confirmadas', 'one', 'F02') IS NOT NULL
			OR JSON_SEARCH(fde.fichas_apontadas->'$.fichas_confirmadas', 'one', 'F03') IS NOT NULL
			OR JSON_SEARCH(fde.fichas_apontadas->'$.fichas_confirmadas', 'one', 'F04') IS NOT NULL
			OR JSON_SEARCH(fde.fichas_apontadas->'$.fichas_confirmadas', 'one', 'F05') IS NOT NULL
			OR CAST(COALESCE(fde.fichas_apontadas->>'$.motor_regras_sql.flag_f02', '0') AS UNSIGNED) = 1
			OR CAST(COALESCE(fde.fichas_apontadas->>'$.motor_regras_sql.flag_f03', '0') AS UNSIGNED) = 1
			OR CAST(COALESCE(fde.fichas_apontadas->>'$.motor_regras_sql.flag_f04', '0') AS UNSIGNED) = 1
			OR CAST(COALESCE(fde.fichas_apontadas->>'$.motor_regras_sql.flag_f05', '0') AS UNSIGNED) = 1
		)`)
	}

	query := `
		SELECT fde.cod_empresa,
		       COALESCE(e.Rz_Social, CONCAT('Empresa ', fde.cod_empresa)) AS nome,
		       COUNT(*) AS qtd
		FROM FATURA_DADOS_EXTRAIDOS fde
		LEFT JOIN Tab_Empresa e ON e.Cod_Empresa = fde.cod_empresa
		WHERE ` + strings.Join(conditions, " AND ") + `
		GROUP BY fde.cod_empresa, e.Rz_Social
		ORDER BY qtd DESC, nome ASC
	`

	rows, err := sqlDB.Query(query, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao listar empresas: " + err.Error()})
		return
	}
	defer rows.Close()

	type empresa struct {
		CodEmpresa int64  `json:"cod_empresa"`
		Nome       string `json:"nome"`
		Qtd        int64  `json:"qtd"`
	}
	result := []empresa{}
	for rows.Next() {
		var e empresa
		if err := rows.Scan(&e.CodEmpresa, &e.Nome, &e.Qtd); err == nil {
			result = append(result, e)
		}
	}
	c.JSON(http.StatusOK, result)
}
