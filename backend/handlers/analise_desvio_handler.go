package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
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
	// Paginação server-side (08/07/2026): offset opcional. Se o front paginar
	// com PAGE_SIZE=100, envia offset = (page-1)*100. Sem offset = página 1.
	offsetStr := c.DefaultQuery("offset", "0")
	offset, _ := strconv.Atoi(offsetStr)
	if offset < 0 {
		offset = 0
	}

	empresa := strings.TrimSpace(c.Query("empresa"))
	status := strings.TrimSpace(c.Query("status"))                // CONFIRMADO | INCONCLUSIVO | REFUTADO
	ficha := strings.ToUpper(strings.TrimSpace(c.Query("ficha"))) // F01..F14
	passibilidade := strings.ToUpper(strings.TrimSpace(c.Query("passibilidade"))) // PARCELAMENTO_SOBREPOSTO | PASSIVEL_CICLO_INFINITO | COMPENSADO_NEUTRALIZADO | TEM_PARCELAMENTO
	idFiltro := strings.TrimSpace(c.Query("id"))                   // ⭐ filtro por ID específico (para recarregar 1 fatura)
	auditadoFiltro := c.Query("auditado") == "1"                   // ⭐ aba Auditados: só verificados; filtra no servidor e BYPASSA score/status (set curado)
	triagemFiltro := c.Query("triagem") == "1"                     // ⭐ aba Inconclusivos (repurposada): fila de triagem (motor apontou, fora de Auditados); BYPASSA score/status
	instalacaoFiltro := strings.TrimSpace(c.Query("instalacao"))   // ⭐ OCR-lote "cruzar FDE": todas as faturas de 1 UC (numero_instalacao); BYPASSA score/status

	// ⭐ MOTOR MODE (motor=1): a fonte dos apontamentos passa a ser o motor NOVO
	// (regras_desvio.go rodado ao vivo sobre as colunas da FDE), e NÃO a coluna
	// fichas_apontadas (populada pelo pipeline IA antigo e hoje vazia → 0 casos).
	// Mantém todo o resto do payload (medição, parcelamento, etc.) intacto.
	motorMode := c.Query("motor") == "1"
	var motorRes map[int64]ResultadoDesvio

	conditions := []string{
		"fde.fichas_apontadas IS NOT NULL",
		"fde.fichas_apontadas != ''",
		// REZEK (emp 14) e VTAL (emp 2025) removidos de Auditoria de Faturas a pedido —
		// nao trabalhamos mais com esses clientes.
		"COALESCE(fde.cod_empresa,0) NOT IN (14, 2025)",
	}
	var args []interface{}

	if motorMode {
		// roda o motor (gold = aprovado/revisao) e restringe aos ids apontados
		res, mErr := motorApontamentosCached(sqlDB, empresa, true)
		if mErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "erro no motor de desvio: " + mErr.Error()})
			return
		}
		motorRes = res
		if idFiltro != "" {
			conditions = []string{"fde.id = ?"}
			args = []interface{}{idFiltro}
		} else if len(motorRes) == 0 {
			c.JSON(http.StatusOK, []map[string]interface{}{})
			return
		} else {
			ids := make([]string, 0, len(motorRes))
			for id := range motorRes {
				ids = append(ids, strconv.FormatInt(id, 10))
			}
			conditions = []string{"fde.id IN (" + strings.Join(ids, ",") + ")"}
			// ⭐ o motor não conhece cod_empresa; a substituição acima descartou a
			// exclusão base (linha ~269), então re-aplica aqui: REZEK (14) e VTAL (2025)
			// removidos da Auditoria de Faturas em TODAS as abas do modo motor.
			conditions = append(conditions, "COALESCE(fde.cod_empresa,0) NOT IN (14, 2025)")
			args = nil
			// filtro por ficha (ex F01) aplicado em memória depois do scan
		}
	} else if idFiltro != "" {
		// ⭐ Filtro por ID: ignora outros filtros se passado (busca direta da fatura)
		conditions = []string{"fde.id = ?"}
		args = []interface{}{idFiltro}
	} else if empresa != "" && empresa != "0" {
		conditions = append(conditions, "fde.cod_empresa = ?")
		args = append(args, empresa)
	}
	if !motorMode && idFiltro == "" && status != "" {
		// decisao_final está direto no JSON de fichas_apontadas
		conditions = append(conditions, "JSON_UNQUOTE(JSON_EXTRACT(fde.fichas_apontadas, '$.decisao_final')) = ?")
		args = append(args, status)
	}
	if !motorMode && idFiltro == "" && ficha != "" {
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

	// ⭐ Aba Auditados: filtra o set verificado no SERVIDOR (evita o teto de 2000 da
	// paginação do motor cortar linhas auditadas de alto ressarcimento, ex.: 310460).
	if auditadoFiltro {
		conditions = append(conditions, "COALESCE(fde.auditado,0) = 1")
	}
	if triagemFiltro {
		conditions = append(conditions, "COALESCE(fde.triagem_inconclusivo,0) = 1")
		// ⭐ Inconclusivos que já foram promovidos a Auditados (auditado=1) saem da aba
		// Inconclusivos — senão apareceriam nas duas abas (342 faturas com os 2 flags).
		conditions = append(conditions, "COALESCE(fde.auditado,0) <> 1")
	}
	// ⭐ Filtro por distribuidora (LIKE, sanitizado) — usado p/ coletar apontados por
	// dist (ex.: triagem Equatorial/Celesc) sem depender de cod_empresa.
	if distFiltro := strings.TrimSpace(c.Query("dist")); distFiltro != "" {
		safe := strings.Map(func(r rune) rune {
			if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == ' ' || r == '%' {
				return r
			}
			return -1
		}, distFiltro)
		if safe != "" {
			conditions = append(conditions, "UPPER(fde.distribuidora) LIKE UPPER('%"+safe+"%')")
		}
	}

	// ⭐ Cruzar FDE (OCR em lote): todas as faturas de uma UC pelo numero_instalacao.
	// Sanitiza (dígitos, ponto, hífen, barra) e bypassa score/status (set específico).
	if instalacaoFiltro != "" {
		safe := strings.Map(func(r rune) rune {
			if (r >= '0' && r <= '9') || r == '.' || r == '-' || r == '/' {
				return r
			}
			return -1
		}, instalacaoFiltro)
		if safe != "" {
			conditions = append(conditions, "fde.numero_instalacao = '"+safe+"'")
		}
	}

	// Filtros de recorte do parque (aplicados na tabela; espelham o /resumo).
	if c.Query("excluir_gd") == "1" {
		conditions = append(conditions,
			"NOT (COALESCE(fde.indicador_geracao_distribuida,0)=1 OR COALESCE(fde.energia_compensada_kwh,0)>0 OR COALESCE(fde.energia_injetada_kwh,0)>0)")
	}
	if c.Query("excluir_grupo_a") == "1" {
		conditions = append(conditions, "UPPER(COALESCE(fde.grupo_tarifario,'')) NOT LIKE 'A%'")
	}
	if c.Query("excluir_branca") == "1" {
		conditions = append(conditions, "UPPER(COALESCE(fde.modalidade_tarifaria,'')) NOT LIKE '%BRANCA%'")
	}

	// Classificação por aba (motor mode). O status vem do front (STATUS_POR_TAB):
	//   • REFUTADO   (Rejeitados)   → SÓ apontamentos rejeitados pelo analista.
	//   • CONFIRMADO (Apontamentos) → extração alta (score>=90), fora rejeitados/já-em-processo.
	//   • INCONCLUSIVO             → extração baixa (score<90), fora rejeitados/já-em-processo.
	// Rejeição/JÁ-EM-PROCESSO ficam em FATURA_REANALISES (sem coluna nova). Busca por ID
	// (idFiltro) ignora estes filtros pra sempre conseguir recarregar 1 fatura.
	if idFiltro == "" && !auditadoFiltro && !triagemFiltro && instalacaoFiltro == "" {
		if status == "REFUTADO" {
			conditions = append(conditions,
				"EXISTS (SELECT 1 FROM FATURA_REANALISES r WHERE r.fatura_id = fde.id AND r.recomendacao = 'REJEITADO')")
		} else {
			conditions = append(conditions,
				"NOT EXISTS (SELECT 1 FROM FATURA_REANALISES r WHERE r.fatura_id = fde.id AND r.recomendacao IN ('REJEITADO','JA_EM_PROCESSO'))")
			// ⭐ Inbox (Apontamentos): esconde o que já foi classificado — promovido a
			// Energia (auditado=1) ou enviado a Inconclusivos (triagem=1). Assim, ao
			// classificar cada caso (real→Energia, ambíguo→Inconclusivos, falso→Rejeitar),
			// ele SAI do inbox e a lista Apontamentos zera conforme a triagem avança.
			conditions = append(conditions,
				"COALESCE(fde.auditado,0) <> 1",
				"COALESCE(fde.triagem_inconclusivo,0) <> 1")
			if motorMode {
				switch status {
				case "CONFIRMADO":
					conditions = append(conditions, "COALESCE(fde.extracao_score_confianca,0) >= 90")
				case "INCONCLUSIVO":
					conditions = append(conditions, "COALESCE(fde.extracao_score_confianca,0) < 90")
				}
			}
		}
	}

	// Inconclusivos (triagem): também esconde os apontamentos JÁ rejeitados/em-processo.
	// Antes a exclusão só valia fora do triagem/auditados, então o apontamento rejeitado
	// pelo analista REAPARECIA ao recarregar a página. Busca por ID (idFiltro) e a aba
	// Rejeitados (REFUTADO) continuam ignorando isto de propósito.
	if idFiltro == "" && triagemFiltro && status != "REFUTADO" {
		conditions = append(conditions,
			"NOT EXISTS (SELECT 1 FROM FATURA_REANALISES r WHERE r.fatura_id = fde.id AND r.recomendacao IN ('REJEITADO','JA_EM_PROCESSO'))")
	}

	// Auditados (Energia): idem — esconde os apontamentos rejeitados/em-processo. O branch
	// auditadoFiltro bypassa a exclusão geral (linha ~396), então sem isto o apontamento
	// rejeitado pelo analista REAPARECE na aba Energia ao recarregar. Busca por ID e a aba
	// Rejeitados (REFUTADO) continuam ignorando de propósito.
	if idFiltro == "" && auditadoFiltro && status != "REFUTADO" {
		conditions = append(conditions,
			"NOT EXISTS (SELECT 1 FROM FATURA_REANALISES r WHERE r.fatura_id = fde.id AND r.recomendacao IN ('REJEITADO','JA_EM_PROCESSO'))")
	}

	// Filtro de SEGMENTO (seleciona SÓ um): gd | grupo_a | branca | mercado_livre | demais.
	const condGD = "(COALESCE(fde.indicador_geracao_distribuida,0)=1 OR COALESCE(fde.energia_compensada_kwh,0)>0 OR COALESCE(fde.energia_injetada_kwh,0)>0)"
	const condA = "UPPER(COALESCE(fde.grupo_tarifario,'')) LIKE 'A%'"
	const condBranca = "UPPER(COALESCE(fde.modalidade_tarifaria,'')) LIKE '%BRANCA%'"
	const condML = "(COALESCE(fde.indicador_mercado_livre,0)=1 OR COALESCE(fde.mercado_livre_acl,0)=1)"
	switch strings.ToLower(strings.TrimSpace(c.Query("segmento"))) {
	case "gd":
		conditions = append(conditions, condGD)
	case "grupo_a":
		conditions = append(conditions, condA)
	case "branca":
		conditions = append(conditions, condBranca)
	case "mercado_livre":
		conditions = append(conditions, condML)
	case "demais":
		conditions = append(conditions, "NOT "+condGD, "NOT ("+condA+")", "NOT ("+condBranca+")", "NOT "+condML)
	}

	// SELECT completo: campos básicos + 34 colunas v19 + analise_ia + leituras
	// Todos os campos que o frontend possa querer exibir na Análise de Desvio.
	query := `
		SELECT
			fde.id,
			COALESCE(fde.uid, '')                          AS uid,
			COALESCE(fde.codigo_uc, '')                    AS codigo_uc,
			COALESCE(fde.numero_instalacao, '')            AS numero_instalacao,
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
			END AS status_passibilidade,
			-- ⭐ base do ressarcimento (energia ativa em R$) — alinha tabela/KPI ao modal
			COALESCE(fde.valor_energia_ativa, 0) AS valor_energia_ativa,
			COALESCE(fde.auditado, 0) AS auditado,
			COALESCE(aa.ressarcimento_estimado, 0) AS ressarcimento_estimado,
			COALESCE(aa.base_ressarcimento, 0) AS ressarcimento_base,
			COALESCE(aa.observacao, '') AS observacao_auditado,
			COALESCE(fde.observacoes_fatura, '') AS observacoes_fatura,
			COALESCE(fde.triagem_explicacao, '') AS triagem_explicacao,
			DATE_FORMAT(fde.extraido_em, '%Y-%m-%d') AS data_processamento
		FROM FATURA_DADOS_EXTRAIDOS fde
		LEFT JOIN FATURA_APONTAMENTOS_AUDITADOS aa ON aa.id = fde.id
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
		LIMIT ? OFFSET ?`
	args = append(args, limit, offset)

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
			numeroInstalacao string
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
			// ⭐ base do ressarcimento (energia ativa R$)
			valorEnergiaAtiva sql.NullFloat64
			// ⭐ flag de auditado (verificado contra a fatura) — aba "Auditados"
			auditadoFlag sql.NullInt64
			// ⭐ ressarcimento estimado canônico (tabela FATURA_APONTAMENTOS_AUDITADOS)
			ressAuditado sql.NullFloat64
			baseRessAud  sql.NullFloat64
			obsAuditado  sql.NullString
			obsFatura    sql.NullString // parecer gravado na FDE (fallback do modal qdo nao esta no snapshot)
			triagemExpl  sql.NullString
			dataProcess  sql.NullString // dia que processamos a fatura (extraido_em, YYYY-MM-DD)
		)
		if err := rows.Scan(
			&id, &uid, &codigoUC, &numeroInstalacao, &totalRS, &mesRef, &codEmpresa, &linkFatura, &distribuidora,
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
			&valorEnergiaAtiva,
			&auditadoFlag,
			&ressAuditado,
			&baseRessAud,
			&obsAuditado,
			&obsFatura,
			&triagemExpl,
			&dataProcess,
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
			"numero_instalacao": numeroInstalacao,
			"RS_Total_Fatura": rsTotal,
			"Mes_Ref":         mesRef,
			"Cod_Empresa":     codEmp,
			"cod_empresa":     codEmp,
			"Link":            linkFatura,
			"Concessionaria":  distribuidora,
			"distribuidora":   distribuidora,
			"auditado":        func() interface{} { if auditadoFlag.Valid { return auditadoFlag.Int64 }; return int64(0) }(),
			"ressarcimento_estimado": func() interface{} { if ressAuditado.Valid { return ressAuditado.Float64 }; return 0.0 }(),
			"ressarcimento_base": func() interface{} { if baseRessAud.Valid { return baseRessAud.Float64 }; return 0.0 }(),
			"observacao_auditado": func() interface{} { if obsAuditado.Valid { return obsAuditado.String }; return "" }(),
			"observacoes_fatura": func() interface{} { if obsFatura.Valid { return obsFatura.String }; return "" }(),
			"triagem_explicacao": func() interface{} { if triagemExpl.Valid { return triagemExpl.String }; return "" }(),
			"data_processamento": func() interface{} { if dataProcess.Valid { return dataProcess.String }; return "" }(), // dia que processamos (extraido_em)
			"RAZAO_SOCIAL":    nomeCliente,
			"desvio_pct_max":  func() interface{} { if desvioPctMax.Valid { return desvioPctMax.Float64 }; return 0.0 }(),
			"valor_energia_ativa": func() interface{} { if valorEnergiaAtiva.Valid { return valorEnergiaAtiva.Float64 }; return 0.0 }(),
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

		// ⭐ MOTOR MODE: sobrescreve os campos de apontamento com o resultado do
		// motor novo (F01-F05 ao vivo). Sintetiza ia_opus_5_4_decisao.fichas_confirmadas
		// pra getDecisao()/filtros do front funcionarem sem o pipeline IA.
		if motorMode {
			mr, ok := motorRes[id]
			if !ok {
				continue // só por segurança; conditions já restringe aos apontados
			}
			// filtro por ficha em memória (ex.: aba F01 só mostra quem tem F01)
			if ficha != "" {
				temFicha := false
				for _, f := range mr.FichasAplicadas {
					if f == ficha {
						temFicha = true
						break
					}
				}
				if !temFicha {
					continue
				}
			}
			row["fichas_aplicadas"] = strings.Join(mr.FichasAplicadas, ",")
			row["desvio_pct_max"] = mr.DesvioPctMax
			row["classe_desvio"] = mr.ClasseDesvio
			row["f02_validacao"] = mr.F02Validacao // CONFIRMADO|ATIVACAO|SEM_3_PROXIMAS
			row["classificacao_historico"] = mr.ClassificacaoHistorico // advisory: ELEVADO_REAL|DENTRO_DO_HISTORICO|SAZONAL
			row["detalhes_f01"] = mr.DetalhesF01      // a "conta" da fórmula (front mostra + oferece print)
			row["leitura_suspeita"] = mr.LeituraSuspeita
			row["detalhamento_motor"] = mr.Detalhamento
			row["tem_parcelamento"] = mr.TemParcelamento
			row["resultado_analises"] = map[string]interface{}{
				"ia_opus_5_4_decisao": map[string]interface{}{
					"decisao_final":      "APONTADO",
					"fichas_confirmadas": mr.FichasAplicadas,
					"origem":             "motor_regras_desvio",
				},
				"analise_ia_texto": strings.Join(mr.Detalhamento, " | "),
			}
			row["status_passibilidade"] = nil // passibilidade é do pipeline IA — N/A no motor
		}

		// ⭐ PERF: na LISTA (sem id específico) remove o detalhe PESADO por linha — só o
		// modal precisa, e ele rebusca por ?id= (que cai fora deste corte). historico_consumo
		// sozinho era ~3,6 MB de ~10,7 MB. Corta o payload ~10,7 MB → ~2 MB → carrega rápido.
		if idFiltro == "" {
			for _, k := range []string{
				"historico_consumo", "identificacao", "medicao", "parcelamento",
				"compensacao", "historico_art113", "regulacao", "bandeira",
				"aritmetica", "extracao",
			} {
				delete(row, k)
			}
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
// GetResumoFDEAnalise — GET /api/v1/faturas/fde-analise/resumo?empresa=&motor=1
// Agregado GLOBAL (não paginado) dos apontamentos do motor: total de faturas,
// soma dos valores e do ressarcimento estimado de TODO o escopo — todas as
// empresas quando `empresa` vazio, só a empresa quando informada. Usa a MESMA
// fórmula do front (valor × d/(1+d), d = desvio_pct_max_f02/100) e a MESMA fonte
// de desvio (coluna fichas_apontadas), pra o KPI bater com a coluna "Ressarc." da
// tabela. Reaproveita o cache do motor (motorApontamentosCached) → barato.
func GetResumoFDEAnalise(c *gin.Context) {
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

	empresa := strings.TrimSpace(c.Query("empresa"))
	// Filtros de exclusão (opcionais) — pra recortar o parque:
	excGD := c.Query("excluir_gd") == "1"
	excGrupoA := c.Query("excluir_grupo_a") == "1"
	excBranca := c.Query("excluir_branca") == "1"
	fichaSel := strings.ToUpper(strings.TrimSpace(c.Query("ficha"))) // "" = todas; F01/F02/F04/F05
	seg := strings.ToLower(strings.TrimSpace(c.Query("segmento")))   // "" | gd | grupo_a | branca | mercado_livre | demais
	status := strings.ToUpper(strings.TrimSpace(c.Query("status")))  // CONFIRMADO | INCONCLUSIVO | REFUTADO ("" = todas as abas)

	// Totais globais do FATURA_DADOS_EXTRAIDOS (independem de empresa/ficha/status):
	// total de faturas analisadas (linhas) e UCs distintas. Sempre presentes.
	var totalFaturas, totalUCs int64
	_ = sqlDB.QueryRow(`SELECT COUNT(*), COUNT(DISTINCT NULLIF(TRIM(codigo_uc),'')) FROM FATURA_DADOS_EXTRAIDOS`).
		Scan(&totalFaturas, &totalUCs)

	apont, mErr := motorApontamentosCached(sqlDB, empresa, true)
	if mErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro no motor: " + mErr.Error()})
		return
	}
	if len(apont) == 0 {
		c.JSON(http.StatusOK, gin.H{"total": 0, "valor": 0, "ressarcimento": 0,
			"total_faturas_analisadas": totalFaturas, "total_ucs": totalUCs})
		return
	}
	ids := make([]string, 0, len(apont))
	for id := range apont {
		ids = append(ids, strconv.FormatInt(id, 10))
	}

	// Puxa os atributos por id e agrega em Go usando o DESVIO DO MOTOR (mr.DesvioPctMax)
	// — a coluna fichas_apontadas está vazia, o desvio real é o do motor ao vivo.
	// ress = base ENERGIA ATIVA × d/(1+d) (mesma base do modal; cai pro total quando ausente).
	q := `SELECT fde.id,
	             COALESCE(fde.valor_energia_ativa, 0),
	             COALESCE(fde.valor_total_fatura, 0),
	             COALESCE(TRIM(fde.grupo_tarifario), ''),
	             COALESCE(TRIM(fde.modalidade_tarifaria), ''),
	             (CASE WHEN COALESCE(fde.indicador_geracao_distribuida,0)=1
	                    OR COALESCE(fde.energia_compensada_kwh,0)>0
	                    OR COALESCE(fde.energia_injetada_kwh,0)>0 THEN 1 ELSE 0 END) AS gd,
	             (CASE WHEN COALESCE(fde.indicador_mercado_livre,0)=1
	                    OR COALESCE(fde.mercado_livre_acl,0)=1 THEN 1 ELSE 0 END) AS ml,
	             COALESCE(fde.extracao_score_confianca, 0) AS score
	      FROM FATURA_DADOS_EXTRAIDOS fde
	      WHERE fde.id IN (` + strings.Join(ids, ",") + `)
	        AND COALESCE(fde.cod_empresa,0) NOT IN (14, 2025)` // REZEK e VTAL removidos de Auditoria
	rows, qErr := sqlDB.Query(q)
	if qErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao agregar: " + qErr.Error()})
		return
	}
	defer rows.Close()

	// Conjunto de faturas a EXCLUIR do ressarcimento: (a) rejeitadas manualmente,
	// (b) marcadas 'JA_EM_PROCESSO' em FATURA_REANALISES, ou (c) o par (UC, mês)
	// da fatura coincide com algum processo em FT_PROCESSOS (cobre uc + uc_atual).
	// Evita double-count entre KPI/tabela e processos já em andamento.
	// rejeitadas = aba Rejeitados (REFUTADO). exclRessarc = já-em-processo/cobertos → fora
	// das abas de apontamento (nem Apontamentos, nem Inconclusivo, nem Rejeitados).
	rejeitadas := map[int64]bool{}
	exclRessarc := map[int64]bool{}
	if er, e := sqlDB.Query("SELECT fatura_id, recomendacao FROM FATURA_REANALISES WHERE recomendacao IN ('REJEITADO','JA_EM_PROCESSO') AND fatura_id IN (" + strings.Join(ids, ",") + ")"); e == nil {
		for er.Next() {
			var fid int64
			var rec string
			if er.Scan(&fid, &rec) == nil {
				if rec == "REJEITADO" {
					rejeitadas[fid] = true
				} else {
					exclRessarc[fid] = true
				}
			}
		}
		er.Close()
	}
	// (c) cross-check via FT_PROCESSOS — mesmo filtro estrutural que motorApontamentos aplica.
	if cobertura, e := carregarProcessosCobertos(sqlDB); e == nil && len(cobertura) > 0 {
		q2 := "SELECT id, COALESCE(numero_instalacao,''), COALESCE(codigo_uc,''), COALESCE(mes_referencia,'') FROM FATURA_DADOS_EXTRAIDOS WHERE id IN (" + strings.Join(ids, ",") + ")"
		if pr, pe := sqlDB.Query(q2); pe == nil {
			for pr.Next() {
				var fid int64
				var numInst, codUC, mes string
				if pr.Scan(&fid, &numInst, &codUC, &mes) != nil {
					continue
				}
				if jaExisteProcesso(cobertura, numInst, mes) || jaExisteProcesso(cobertura, codUC, mes) {
					exclRessarc[fid] = true
				}
			}
			pr.Close()
		}
	}

	var total, estimadas, naoEstimadas int64
	var valor, ress float64
	var desvios []float64 // p/ MEDIANA (a média é puxada por outliers gigantes)
	fichaCount := map[string]int64{}
	for rows.Next() {
		var id int64
		var energia, vfat float64
		var grupo, modalidade string
		var gd, ml, score int
		if rows.Scan(&id, &energia, &vfat, &grupo, &modalidade, &gd, &ml, &score) != nil {
			continue
		}
		// Classifica a fatura na aba (mesma regra do list handler):
		//   rejeitada → REFUTADO · já-em-processo/coberta → fora · score>=90 → CONFIRMADO · <90 → INCONCLUSIVO
		var bucket string
		if rejeitadas[id] {
			bucket = "REFUTADO"
		} else if exclRessarc[id] {
			continue // já vinculada a processo — fora das abas de apontamento
		} else if score >= 90 {
			bucket = "CONFIRMADO"
		} else {
			bucket = "INCONCLUSIVO"
		}
		// NÃO pula por aba aqui: o ressarcimento estimado TOTAL soma confirmados+inconclusivos
		// (independe da aba). Os contadores por aba são gated por `naAba` mais abaixo.
		naAba := status == "" || bucket == status
		isA := strings.HasPrefix(strings.ToUpper(grupo), "A")
		isBranca := strings.Contains(strings.ToUpper(modalidade), "BRANCA")
		// exclusões (compat)
		if excGD && gd == 1 {
			continue
		}
		if excGrupoA && isA {
			continue
		}
		if excBranca && isBranca {
			continue
		}
		// segmento (seleciona SÓ um)
		switch seg {
		case "gd":
			if gd != 1 { continue }
		case "grupo_a":
			if !isA { continue }
		case "branca":
			if !isBranca { continue }
		case "mercado_livre":
			if ml != 1 { continue }
		case "demais":
			if gd == 1 || isA || isBranca || ml == 1 { continue }
		}
		mr, ok := apont[id]
		if !ok {
			continue
		}
		// filtro por ficha (F01/F02/F04/F05) — separa os tipos de apontamento
		if fichaSel != "" {
			tem := false
			for _, ff := range mr.FichasAplicadas {
				if ff == fichaSel {
					tem = true
					break
				}
			}
			if !tem {
				continue
			}
		}
		// Base do ressarcimento = valor de ENERGIA da fatura (nunca o valor_total).
		base := energia
		d := mr.DesvioPctMax / 100.0

		// ⭐ RESSARCIMENTO ESTIMADO TOTAL = confirmados + inconclusivos, 100% (valor cheio).
		// Retenção de 42% REMOVIDA por decisão do usuário (tudo 100%).
		if (bucket == "CONFIRMADO" || bucket == "INCONCLUSIVO") && d > 0 && base > 0 {
			ress += base * (d / (1 + d))
		}

		// Contadores/KPIs por aba (só a aba selecionada).
		if naAba {
			total++
			valor += vfat
			desvios = append(desvios, mr.DesvioPctMax)
			for _, ff := range mr.FichasAplicadas {
				fichaCount[ff]++
			}
			if d > 0 && base > 0 {
				estimadas++
			} else if base <= 0 {
				naoEstimadas++
			}
		}
	}
	ticket := 0.0
	if total > 0 {
		ticket = ress / float64(total) // ressarcimento estimado médio por fatura apontada
	}
	// Desvio "típico" = MEDIANA (a média é distorcida por poucos desvios enormes, ex.: +28.000%).
	desvioMediano := 0.0
	if n := len(desvios); n > 0 {
		sort.Float64s(desvios)
		if n%2 == 1 {
			desvioMediano = desvios[n/2]
		} else {
			desvioMediano = (desvios[n/2-1] + desvios[n/2]) / 2
		}
	}
	c.JSON(http.StatusOK, gin.H{"total": total, "valor": valor, "ressarcimento": ress,
		"estimadas": estimadas, "nao_estimadas": naoEstimadas,
		"ticket_medio": ticket, "desvio_medio": desvioMediano, "fichas": fichaCount,
		"total_faturas_analisadas": totalFaturas, "total_ucs": totalUCs})
}

// GetRankingsFDEAnalise — GET /api/v1/faturas/fde-analise/rankings?motor=1
// Rankings globais (overview de BI) da Auditoria de Faturas:
//   • top_ressarcimento: 5 clientes (empresas) com maior ressarcimento estimado.
//   • top_processos:     5 clientes (empresas) com mais apontamentos do FDE (motor),
//                        NÃO usa FT_PROCESSOS — conta os casos apontados pela Auditoria.
// Ressarcimento usa a MESMA base/fórmula/exclusões do KPI (energia × d/(1+d) × fator,
// fora rejeitadas / já-em-processo / cobertas por processo).
func GetRankingsFDEAnalise(c *gin.Context) {
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

	type rankRess struct {
		CodEmpresa int64   `json:"cod_empresa"`
		Nome       string  `json:"nome"`
		Valor      float64 `json:"valor"`
	}
	type rankProc struct {
		CodEmpresa int64  `json:"cod_empresa"`
		Nome       string `json:"nome"`
		Qtd        int64  `json:"qtd"`
	}
	topRess := []rankRess{}
	topProc := []rankProc{}

	// ── Ranking por ressarcimento (motor) ─────────────────────────────────────
	if apont, mErr := motorApontamentosCached(sqlDB, "", true); mErr == nil && len(apont) > 0 {
		ids := make([]string, 0, len(apont))
		for id := range apont {
			ids = append(ids, strconv.FormatInt(id, 10))
		}
		idList := strings.Join(ids, ",")
		// exclusões: rejeitadas / já-em-processo / cobertas por processo
		excl := map[int64]bool{}
		if er, e := sqlDB.Query("SELECT DISTINCT fatura_id FROM FATURA_REANALISES WHERE recomendacao IN ('REJEITADO','JA_EM_PROCESSO') AND fatura_id IN (" + idList + ")"); e == nil {
			for er.Next() {
				var fid int64
				if er.Scan(&fid) == nil {
					excl[fid] = true
				}
			}
			er.Close()
		}
		if cobertura, e := carregarProcessosCobertos(sqlDB); e == nil && len(cobertura) > 0 {
			if pr, pe := sqlDB.Query("SELECT id, COALESCE(numero_instalacao,''), COALESCE(codigo_uc,''), COALESCE(mes_referencia,'') FROM FATURA_DADOS_EXTRAIDOS WHERE id IN (" + idList + ")"); pe == nil {
				for pr.Next() {
					var fid int64
					var numInst, codUC, mes string
					if pr.Scan(&fid, &numInst, &codUC, &mes) == nil &&
						(jaExisteProcesso(cobertura, numInst, mes) || jaExisteProcesso(cobertura, codUC, mes)) {
						excl[fid] = true
					}
				}
				pr.Close()
			}
		}
		acc := map[int64]float64{}     // cod_empresa → ressarcimento
		cntProc := map[int64]int64{}   // cod_empresa → nº de apontamentos do FDE
		nomes := map[int64]string{}    // cod_empresa → nome
		q := `SELECT fde.id, COALESCE(fde.cod_empresa,0),
		             COALESCE(e.Rz_Social, CONCAT('Empresa ', fde.cod_empresa)),
		             COALESCE(fde.valor_energia_ativa,0)
		      FROM FATURA_DADOS_EXTRAIDOS fde
		      LEFT JOIN Tab_Empresa e ON e.Cod_Empresa = fde.cod_empresa
		      WHERE fde.id IN (` + idList + `) AND fde.cod_empresa IS NOT NULL
		        AND COALESCE(fde.cod_empresa,0) NOT IN (14, 2025)` // REZEK e VTAL removidos
		if rows, qErr := sqlDB.Query(q); qErr == nil {
			for rows.Next() {
				var id, cod int64
				var nome string
				var energia float64
				if rows.Scan(&id, &cod, &nome, &energia) != nil || excl[id] || cod == 0 {
					continue
				}
				mr, ok := apont[id]
				if !ok {
					continue
				}
				// Ranking de "processos apontados pelo FDE": conta o caso apontado
				// pelo motor por empresa (independe do ressarcimento ser > 0).
				cntProc[cod]++
				nomes[cod] = nome
				d := mr.DesvioPctMax / 100.0
				if d > 0 && energia > 0 {
					acc[cod] += energia * (d / (1 + d)) // 100% (retenção -42% removida)
				}
			}
			rows.Close()
		}
		for cod, v := range acc {
			topRess = append(topRess, rankRess{CodEmpresa: cod, Nome: nomes[cod], Valor: v})
		}
		sort.Slice(topRess, func(i, j int) bool { return topRess[i].Valor > topRess[j].Valor })
		if len(topRess) > 5 {
			topRess = topRess[:5]
		}
		// Ranking por nº de apontamentos do FDE (não usa FT_PROCESSOS).
		for cod, q := range cntProc {
			topProc = append(topProc, rankProc{CodEmpresa: cod, Nome: nomes[cod], Qtd: q})
		}
		sort.Slice(topProc, func(i, j int) bool { return topProc[i].Qtd > topProc[j].Qtd })
		if len(topProc) > 5 {
			topProc = topProc[:5]
		}
	}

	c.JSON(http.StatusOK, gin.H{"top_ressarcimento": topRess, "top_processos": topProc})
}

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

	// ⭐ MOTOR MODE: conta as empresas pelos apontamentos do motor novo (F01-F05
	// ao vivo), não pela coluna fichas_apontadas (vazia).
	if c.Query("motor") == "1" {
		apont, mErr := motorApontamentosCached(sqlDB, "", true)
		if mErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "erro no motor: " + mErr.Error()})
			return
		}
		type empresa struct {
			CodEmpresa int64  `json:"cod_empresa"`
			Nome       string `json:"nome"`
			Qtd        int64  `json:"qtd"`
		}
		// Mesma classificação por aba do list/resumo, pra a contagem por empresa
		// ser REAL (bater com o que a aba mostra), não o total bruto de apontados.
		st := strings.ToUpper(strings.TrimSpace(c.Query("status")))
		classCond := ""
		if st == "REFUTADO" {
			classCond = " AND EXISTS (SELECT 1 FROM FATURA_REANALISES r WHERE r.fatura_id = fde.id AND r.recomendacao = 'REJEITADO')"
		} else {
			classCond = " AND NOT EXISTS (SELECT 1 FROM FATURA_REANALISES r WHERE r.fatura_id = fde.id AND r.recomendacao IN ('REJEITADO','JA_EM_PROCESSO'))"
			if st == "CONFIRMADO" {
				classCond += " AND COALESCE(fde.extracao_score_confianca,0) >= 90"
			} else if st == "INCONCLUSIVO" {
				classCond += " AND COALESCE(fde.extracao_score_confianca,0) < 90"
			}
		}
		result := []empresa{}
		if len(apont) > 0 {
			ids := make([]string, 0, len(apont))
			for id := range apont {
				ids = append(ids, strconv.FormatInt(id, 10))
			}
			q := `SELECT fde.cod_empresa,
			             COALESCE(e.Rz_Social, CONCAT('Empresa ', fde.cod_empresa)) AS nome,
			             COUNT(*) AS qtd
			      FROM FATURA_DADOS_EXTRAIDOS fde
			      LEFT JOIN Tab_Empresa e ON e.Cod_Empresa = fde.cod_empresa
			      WHERE fde.id IN (` + strings.Join(ids, ",") + `) AND fde.cod_empresa IS NOT NULL
			        AND COALESCE(fde.cod_empresa,0) NOT IN (14, 2025)` + classCond + ` -- REZEK e VTAL removidos
			      GROUP BY fde.cod_empresa, e.Rz_Social
			      ORDER BY qtd DESC, nome ASC`
			rows, qErr := sqlDB.Query(q)
			if qErr == nil {
				defer rows.Close()
				for rows.Next() {
					var e empresa
					if rows.Scan(&e.CodEmpresa, &e.Nome, &e.Qtd) == nil {
						result = append(result, e)
					}
				}
			}
		}
		c.JSON(http.StatusOK, result)
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
