package handlers

import (
	"database/sql"
	"fmt"
	"log"
	"strconv"

	"github.com/gin-gonic/gin"
	"ressarcimento-backend/database"
)

// ProcessoSnapshotUpdate representa os dados que podem ser atualizados no snapshot
type ProcessoSnapshotUpdate struct {
	UC                  *string  `json:"uc"`
	Cliente             *string  `json:"cliente"`
	Concessionaria      *string  `json:"concessionaria"`
	StatusClass         *string  `json:"status_class"`
	SubEtapa            *string  `json:"sub_etapa"`
	Suspensao           *int     `json:"suspenso"`
	SuspensaoMotivo     *string  `json:"suspenso_motivo"`
	CreditoSimples      *float64 `json:"credito_simples"`
	CreditoDobro        *float64 `json:"credito_dobro"`
	DataDevolucao       *string  `json:"data_devolucao"`
	DataEnvioFinanceiro *string  `json:"data_envio_financeiro"`
	FormaDevolucao      *string  `json:"forma_devolucao"`
	ValorRessarcimento  *float64 `json:"valor_ressarcimento"`
}

// ProcessoSnapshotResponse é a resposta do snapshot
type ProcessoSnapshotResponse struct {
	Success bool        `json:"success"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

// =============================================================================
// UpdateProcessoSnapshot atualiza um processo no snapshot e sincroniza
// com as tabelas originais
// =============================================================================
// POST /api/v1/processo-snapshot/:id_processo
// UpdateProcessoSnapshot godoc
// @Summary      Atualiza snapshot do processo
// @Tags         ProcessoSnapshot
// @Param        id_processo  path   int  true  "ID do processo"
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/processo-snapshot/{id_processo} [post]
func UpdateProcessoSnapshot(c *gin.Context) {
	// Extrair ID do processo
	idProcessoStr := c.Param("id_processo")
	idProcesso, err := strconv.Atoi(idProcessoStr)
	if err != nil {
		c.JSON(400, ProcessoSnapshotResponse{
			Success: false,
			Message: "ID do processo inválido",
		})
		return
	}

	// Parse do corpo da requisição
	var updateData ProcessoSnapshotUpdate
	if err := c.BindJSON(&updateData); err != nil {
		c.JSON(400, ProcessoSnapshotResponse{
			Success: false,
			Message: "Corpo da requisição inválido: " + err.Error(),
		})
		return
	}

	// Extrair user ID do contexto (já setado pelo middleware de auth)
	userIDInterface, exists := c.Get("userID")
	if !exists {
		c.JSON(401, ProcessoSnapshotResponse{
			Success: false,
			Message: "Usuário não autenticado",
		})
		return
	}

	userID, ok := userIDInterface.(int64)
	if !ok {
		c.JSON(401, ProcessoSnapshotResponse{
			Success: false,
			Message: "Erro ao extrair ID do usuário",
		})
		return
	}

	// Validar os dados
	validationErrors := ValidateProcessoSnapshotUpdate(&updateData)
	if len(validationErrors) > 0 {
		LogValidationErrors(idProcesso, validationErrors)
		c.JSON(400, gin.H{
			"success":           false,
			"message":           "Dados de atualização inválidos",
			"validation_errors": FormatValidationErrors(validationErrors),
		})
		return
	}

	// Chamar a Stored Procedure
	err = syncProcessoSnapshot(idProcesso, int(userID), updateData)
	if err != nil {
		log.Printf("Erro ao sincronizar snapshot do processo: %v", err)
		c.JSON(500, ProcessoSnapshotResponse{
			Success: false,
			Message: "Erro ao sincronizar: " + err.Error(),
		})
		return
	}

	// Recuperar os dados atualizados
	updatedData, err := getProcessoSnapshot(idProcesso)
	if err != nil {
		c.JSON(500, ProcessoSnapshotResponse{
			Success: false,
			Message: "Atualizado mas falha ao recuperar: " + err.Error(),
		})
		return
	}

	c.JSON(200, ProcessoSnapshotResponse{
		Success: true,
		Message: "Processo atualizado e sincronizado com sucesso",
		Data:    updatedData,
	})
}

// =============================================================================
// GetProcessoSnapshot retorna os dados de um processo no snapshot
// =============================================================================
// GET /api/v1/processo-snapshot/:id_processo
// GetProcessoSnapshot godoc
// @Summary      Busca snapshot do processo
// @Tags         ProcessoSnapshot
// @Param        id_processo  path   int  true  "ID do processo"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/processo-snapshot/{id_processo} [get]
func GetProcessoSnapshot(c *gin.Context) {
	idProcessoStr := c.Param("id_processo")
	idProcesso, err := strconv.Atoi(idProcessoStr)
	if err != nil {
		c.JSON(400, ProcessoSnapshotResponse{
			Success: false,
			Message: "ID do processo inválido",
		})
		return
	}

	if !snapshotTableExists() {
		if fallback, fbErr := getProcessoSnapshotFromOriginal(idProcesso); fbErr == nil {
			c.JSON(200, ProcessoSnapshotResponse{
				Success: true,
				Data:    fallback,
			})
			return
		}
	}

	data, err := getProcessoSnapshot(idProcesso)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(404, ProcessoSnapshotResponse{
				Success: false,
				Message: "Snapshot do processo não encontrado",
			})
			return
		}
		c.JSON(500, ProcessoSnapshotResponse{
			Success: false,
			Message: "Erro ao recuperar snapshot: " + err.Error(),
		})
		return
	}

	c.JSON(200, ProcessoSnapshotResponse{
		Success: true,
		Data:    data,
	})
}

func snapshotTableExists() bool {
	var has int
	if err := database.GormDB_App.Raw(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME = 'FT_PROCESSO_SNAPSHOT'`,
	).Row().Scan(&has); err != nil {
		return false
	}
	return has > 0
}

// =============================================================================
// SyncProcessoSnapshot sincroniza um processo com as tabelas originais
// =============================================================================
// POST /api/v1/processo-snapshot/:id_processo/sync
// SyncProcessoSnapshot godoc
// @Summary      Sincroniza snapshot do processo
// @Tags         ProcessoSnapshot
// @Param        id_processo  path   int  true  "ID do processo"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/processo-snapshot/{id_processo}/sync [post]
func SyncProcessoSnapshot(c *gin.Context) {
	idProcessoStr := c.Param("id_processo")
	idProcesso, err := strconv.Atoi(idProcessoStr)
	if err != nil {
		c.JSON(400, ProcessoSnapshotResponse{
			Success: false,
			Message: "ID do processo inválido",
		})
		return
	}

	userIDInterface, exists := c.Get("userID")
	if !exists {
		c.JSON(401, ProcessoSnapshotResponse{
			Success: false,
			Message: "Usuário não autenticado",
		})
		return
	}

	userID, ok := userIDInterface.(int64)
	if !ok {
		c.JSON(401, ProcessoSnapshotResponse{
			Success: false,
			Message: "Erro ao extrair ID do usuário",
		})
		return
	}

	err = callSyncStoredProcedure(idProcesso, int(userID))
	if err != nil {
		c.JSON(500, ProcessoSnapshotResponse{
			Success: false,
			Message: "Erro durante sincronização: " + err.Error(),
		})
		return
	}

	c.JSON(200, ProcessoSnapshotResponse{
		Success: true,
		Message: "Processo sincronizado com sucesso",
	})
}

// =============================================================================
// getProcessoSnapshot recupera os dados do snapshot do banco.
// Usa SELECT * para tolerar diferenças de schema entre ambientes.
func getProcessoSnapshot(idProcesso int) (map[string]interface{}, error) {
	// Fonte oficial: tabelas originais (FT_PROCESSOS + FT_REQUISICOES + etc.)
	if fallback, fbErr := getProcessoSnapshotFromOriginal(idProcesso); fbErr == nil {
		return fallback, nil
	}
	return nil, sql.ErrNoRows
}

func getProcessoSnapshotDynamic(idProcesso int) (map[string]interface{}, error) {
	rows, err := queryGorm(database.GormDB_App, 
		"SELECT * FROM FT_PROCESSO_SNAPSHOT WHERE id_processo = ?",
		idProcesso,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, sql.ErrNoRows
	}

	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	rawVals := make([]interface{}, len(cols))
	for i := range rawVals {
		var v interface{}
		rawVals[i] = &v
	}

	if err := rows.Scan(rawVals...); err != nil {
		return nil, err
	}

	out := make(map[string]interface{}, len(cols))
	for i, col := range cols {
		val := *(rawVals[i].(*interface{}))
		switch t := val.(type) {
		case []byte:
			out[col] = string(t)
		default:
			out[col] = val
		}
	}
	// Normaliza nomes esperados pelo front quando o snapshot usa colunas diferentes.
	if out["data_emissao"] == nil {
		if v, ok := out["emissao_nf"]; ok {
			out["data_emissao"] = v
		}
	}
	if out["data_vencimento"] == nil {
		if v, ok := out["vencimento_nf"]; ok {
			out["data_vencimento"] = v
		}
	}
	return out, nil
}

func getProcessoSnapshotFromOriginal(idProcesso int) (map[string]interface{}, error) {
	queryBase := `
		SELECT
			COALESCE(p.id_processo, r.id_requisicao)     AS id_processo,
			COALESCE(p.uc, r.uc, '')                    AS uc,
			COALESCE(p.cliente, r.cliente, '')          AS cliente,
			COALESCE(p.concessionaria, r.concessionaria, '') AS concessionaria,
			COALESCE(e.etapa, '')                       AS etapa_nome,
			COALESCE(p.sub_etapa, '')                   AS sub_etapa,
			COALESCE(p.suspenso, 0)                     AS suspenso,
			COALESCE(p.suspenso_motivo, '')             AS suspenso_motivo,
			COALESCE(d.credito_simples, 0)              AS credito_simples,
			COALESCE(DATE_FORMAT(d.data_procedencia, '%Y-%m-%d'), '') AS data_simples,
			COALESCE(d.credito_dobro, 0)                AS credito_dobro,
			COALESCE(DATE_FORMAT(d.data_credito_dobro, '%Y-%m-%d'), '') AS data_dobro,
			COALESCE(d.repasse_simples, 0)              AS repasse_simples,
			COALESCE(d.repasse_dobro, 0)                AS repasse_dobro,
			COALESCE(fr.forma_devolucao, '')            AS forma_devolucao,
			COALESCE(fr.valor, 0)                       AS valor_ressarcimento,
			COALESCE(DATE_FORMAT(fr.data_devolucao, '%Y-%m-%d'), '') AS data_devolucao,
			COALESCE(fr.data_envio_financeiro, '')      AS data_envio_financeiro,
			COALESCE(f.numero_nf, '')                   AS numero_nf,
			COALESCE(DATE_FORMAT(f.data_emissao, '%Y-%m-%d'), '') AS data_emissao,
			COALESCE(DATE_FORMAT(f.data_vencimento, '%Y-%m-%d'), '') AS data_vencimento,
			COALESCE(DATE_FORMAT(f.data_pagamento, '%Y-%m-%d'), '') AS data_pagamento,
			COALESCE(f.valor, 0)                        AS valor_nf
		FROM FT_PROCESSOS p
		LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		LEFT JOIN DM_ETAPAS_PROCESSO e ON p.id_etapa_processo = e.id_etapa_processo
		LEFT JOIN FT_DEFERIMENTOS d ON d.id_processo = COALESCE(p.id_processo, r.id_requisicao)
		LEFT JOIN (
			SELECT x.id_processo, x.forma_devolucao, x.valor, x.data_devolucao, x.data_envio_financeiro, x.created_at
			FROM FT_FLUXO_RESSARCIMENTO x
			JOIN (
				SELECT id_processo, MAX(created_at) AS mx
				FROM FT_FLUXO_RESSARCIMENTO
				GROUP BY id_processo
			) ult ON ult.id_processo = x.id_processo AND ult.mx = x.created_at
		) fr ON fr.id_processo = COALESCE(p.id_processo, r.id_requisicao)
		LEFT JOIN (
			SELECT y.id_processo, y.numero_nf, y.data_emissao, y.data_vencimento, y.data_pagamento, y.valor, y.created_at
			FROM FT_FATURAMENTO y
			JOIN (
				SELECT id_processo, MAX(created_at) AS my
				FROM FT_FATURAMENTO
				GROUP BY id_processo
			) uf ON uf.id_processo = y.id_processo AND uf.my = y.created_at
		) f ON f.id_processo = COALESCE(p.id_processo, r.id_requisicao)
		WHERE p.id_processo = ?
		LIMIT 1
	`

	row := queryRowGorm(database.GormDB_App, queryBase, idProcesso)

	var (
		idProc                                                              int
		uc, cliente, concess, etapaNome, subEtapa, suspensoMotivo            sql.NullString
		creditoSimples, creditoDobro, valorRessarc, valorNF                  sql.NullFloat64
		dataSimples, dataDobro, dataDevol, dataEmissao, dataVenc, dataPag    sql.NullString
		formaDevolucao, dataEnvioFinanceiro, numeroNF                        sql.NullString
		suspenso                                                             sql.NullInt64
	)

	scanFull := func(r *sql.Row) error {
		return r.Scan(
			&idProc,
			&uc,
			&cliente,
			&concess,
			&etapaNome,
		&subEtapa,
		&suspenso,
		&suspensoMotivo,
		&creditoSimples,
		&dataSimples,
		&creditoDobro,
		&dataDobro,
		&formaDevolucao,
		&valorRessarc,
		&dataDevol,
		&dataEnvioFinanceiro,
		&numeroNF,
			&dataEmissao,
			&dataVenc,
			&dataPag,
			&valorNF,
		)
	}

	if err := scanFull(row); err != nil {
		if err == sql.ErrNoRows {
			// tentativa 2: base em FT_REQUISICOES
			row2 := queryRowGorm(database.GormDB_App, `
				SELECT
					r.id_requisicao                            AS id_processo,
					COALESCE(r.uc, '')                         AS uc,
					COALESCE(r.cliente, '')                    AS cliente,
					COALESCE(r.concessionaria, '')             AS concessionaria,
					COALESCE(e.etapa, '')                      AS etapa_nome,
					COALESCE(p.sub_etapa, '')                  AS sub_etapa,
					COALESCE(p.suspenso, 0)                    AS suspenso,
					COALESCE(p.suspenso_motivo, '')            AS suspenso_motivo,
					COALESCE(d.credito_simples, 0)             AS credito_simples,
					COALESCE(DATE_FORMAT(d.data_procedencia, '%Y-%m-%d'), '') AS data_simples,
					COALESCE(d.credito_dobro, 0)               AS credito_dobro,
					COALESCE(DATE_FORMAT(d.data_credito_dobro, '%Y-%m-%d'), '') AS data_dobro,
					COALESCE(d.repasse_simples, 0)             AS repasse_simples,
					COALESCE(d.repasse_dobro, 0)               AS repasse_dobro,
					COALESCE(fr.forma_devolucao, '')           AS forma_devolucao,
					COALESCE(fr.valor, 0)                      AS valor_ressarcimento,
					COALESCE(DATE_FORMAT(fr.data_devolucao, '%Y-%m-%d'), '') AS data_devolucao,
					COALESCE(fr.data_envio_financeiro, '')     AS data_envio_financeiro,
					COALESCE(f.numero_nf, '')                  AS numero_nf,
					COALESCE(DATE_FORMAT(f.data_emissao, '%Y-%m-%d'), '') AS data_emissao,
					COALESCE(DATE_FORMAT(f.data_vencimento, '%Y-%m-%d'), '') AS data_vencimento,
					COALESCE(DATE_FORMAT(f.data_pagamento, '%Y-%m-%d'), '') AS data_pagamento,
					COALESCE(f.valor, 0)                       AS valor_nf
				FROM FT_REQUISICOES r
				LEFT JOIN FT_PROCESSOS p ON p.id_processo = r.id_requisicao
				LEFT JOIN DM_ETAPAS_PROCESSO e ON p.id_etapa_processo = e.id_etapa_processo
				LEFT JOIN FT_DEFERIMENTOS d ON d.id_processo = r.id_requisicao
				LEFT JOIN (
					SELECT x.id_processo, x.forma_devolucao, x.valor, x.data_devolucao, x.data_envio_financeiro, x.created_at
					FROM FT_FLUXO_RESSARCIMENTO x
					JOIN (
						SELECT id_processo, MAX(created_at) AS mx
						FROM FT_FLUXO_RESSARCIMENTO
						GROUP BY id_processo
					) ult ON ult.id_processo = x.id_processo AND ult.mx = x.created_at
				) fr ON fr.id_processo = r.id_requisicao
				LEFT JOIN (
					SELECT y.id_processo, y.numero_nf, y.data_emissao, y.data_vencimento, y.data_pagamento, y.valor, y.created_at
					FROM FT_FATURAMENTO y
					JOIN (
						SELECT id_processo, MAX(created_at) AS my
						FROM FT_FATURAMENTO
						GROUP BY id_processo
					) uf ON uf.id_processo = y.id_processo AND uf.my = y.created_at
				) f ON f.id_processo = r.id_requisicao
				WHERE r.id_requisicao = ?
				LIMIT 1
			`, idProcesso)
			if err2 := scanFull(row2); err2 != nil {
				if err2 == sql.ErrNoRows {
					return nil, sql.ErrNoRows
				}
				return nil, err2
			}
		} else {
			// fallback minimal caso o schema não suporte todos os campos
			minRow := queryRowGorm(database.GormDB_App, `
				SELECT
					r.id_requisicao AS id_processo,
					COALESCE(r.uc, '') AS uc,
					COALESCE(r.cliente, '') AS cliente,
					COALESCE(r.concessionaria, '') AS concessionaria,
					COALESCE(p.suspenso, 0) AS suspenso,
					COALESCE(p.suspenso_motivo, '') AS suspenso_motivo
				FROM FT_REQUISICOES r
				LEFT JOIN FT_PROCESSOS p ON p.id_processo = r.id_requisicao
				WHERE r.id_requisicao = ?
				LIMIT 1
			`, idProcesso)
			var (
				idProcMin                                    int
				ucMin, clienteMin, concessMin, suspMotivoMin sql.NullString
				suspMin                                      sql.NullInt64
			)
			if err2 := minRow.Scan(&idProcMin, &ucMin, &clienteMin, &concessMin, &suspMin, &suspMotivoMin); err2 != nil {
				return nil, err
			}
			out := map[string]interface{}{
				"id_processo":     idProcMin,
				"uc":              ucMin.String,
				"cliente":         clienteMin.String,
				"concessionaria":  concessMin.String,
				"suspenso":        suspMin.Int64,
				"suspenso_motivo": suspMotivoMin.String,
			}
			return out, nil
		}
	}

	return map[string]interface{}{
		"id_processo":         idProc,
		"uc":                  uc.String,
		"cliente":             cliente.String,
		"concessionaria":      concess.String,
		"etapa_nome":          etapaNome.String,
		"sub_etapa":           subEtapa.String,
		"suspenso":            suspenso.Int64,
		"suspenso_motivo":     suspensoMotivo.String,
		"credito_simples":     creditoSimples.Float64,
		"data_simples":        dataSimples.String,
		"credito_dobro":       creditoDobro.Float64,
		"data_dobro":          dataDobro.String,
		"repasse_simples":     nil,
		"repasse_dobro":       nil,
		"forma_devolucao":     formaDevolucao.String,
		"valor_ressarcimento": valorRessarc.Float64,
		"data_devolucao":      dataDevol.String,
		"data_envio_financeiro": dataEnvioFinanceiro.String,
		"numero_nf":           numeroNF.String,
		"data_emissao":        dataEmissao.String,
		"data_vencimento":     dataVenc.String,
		"data_pagamento":      dataPag.String,
		"valor_nf":            valorNF.Float64,
	}, nil
}

// syncProcessoSnapshot atualiza o snapshot e sincroniza com tabelas originais
func syncProcessoSnapshot(idProcesso int, userID int, updateData ProcessoSnapshotUpdate) error {
	// Usar a SP: sp_update_processo_snapshot
	query := `
		CALL sp_update_processo_snapshot(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`

	_, err := execGorm(database.GormDB_App, query,
		idProcesso,
		updateData.UC,
		updateData.Cliente,
		updateData.Concessionaria,
		updateData.StatusClass,
		updateData.SubEtapa,
		updateData.Suspensao,
		updateData.SuspensaoMotivo,
		updateData.CreditoSimples,
		updateData.CreditoDobro,
		userID,
	)

	if err != nil {
		log.Printf("Erro ao chamar sp_update_processo_snapshot: %v", err)
		return fmt.Errorf("erro na sincronização: %w", err)
	}

	return nil
}

// callSyncStoredProcedure executa a SP de sincronização
func callSyncStoredProcedure(idProcesso int, userID int) error {
	query := `CALL sp_sync_processo_snapshot(?, ?)`
	_, err := execGorm(database.GormDB_App, query, idProcesso, userID)

	if err != nil {
		log.Printf("Erro ao chamar sp_sync_processo_snapshot: %v", err)
		return fmt.Errorf("erro na sincronização: %w", err)
	}

	return nil
}

// ============================================================================
// SINCRONIZAÇÃO BIDIRECIONAL - De Tabelas Originais para Snapshot
// ============================================================================

// syncFromOriginalTables sincroniza processo das tabelas originais para o snapshot
// Deve ser chamado após atualizar FT_PROCESSOS, FT_REQUISICOES, etc.
func syncFromOriginalTables(idProcesso int, userID int) error {
	query := `CALL sp_sync_from_original_tables(?, ?)`
	_, err := execGorm(database.GormDB_App, query, idProcesso, userID)

	if err != nil {
		log.Printf("Erro ao sincronizar snapshot de tabelas originais: %v", err)
		return fmt.Errorf("erro na sincronização bidirecional: %w", err)
	}

	log.Printf("Snapshot sincronizado com sucesso para processo %d", idProcesso)
	return nil
}

// refreshAllProcessosSnapshot sincroniza TODOS os processos em lote
func refreshAllProcessosSnapshot(userID int) error {
	query := `CALL sp_refresh_all_processos_snapshot(?)`
	_, err := execGorm(database.GormDB_App, query, userID)

	if err != nil {
		log.Printf("Erro ao fazer refresh em lote do snapshot: %v", err)
		return fmt.Errorf("erro no refresh em lote: %w", err)
	}

	log.Printf("Refresh em lote do snapshot concluído por user %d", userID)
	return nil
}

// refreshAllProcessosSnapshotAsync executa refresh em lote de forma assíncrona
func refreshAllProcessosSnapshotAsync(userID int) {
	go func() {
		if err := refreshAllProcessosSnapshot(userID); err != nil {
			log.Printf("Erro no refresh assíncrono: %v", err)
		}
	}()
}
