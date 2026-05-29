package handlers

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
)

// AdminEditPayload consolida campos para criação/edição completa de um processo
type AdminEditPayload struct {
	// Identificação
	ProcessoID *int    `json:"processo_id,omitempty"`
	CriarNovo  bool    `json:"criar_novo"`
	Coluna     *string `json:"coluna,omitempty"`

	// Requisição (FT_REQUISICOES)
	UC                    *string  `json:"uc,omitempty"`
	Cliente               *string  `json:"cliente,omitempty"`
	Concessionaria        *string  `json:"concessionaria,omitempty"`
	CNPJ                  *string  `json:"cnpj,omitempty"`
	EnderecoCompleto      *string  `json:"endereco_completo,omitempty"`
	RazaoSocialFatura     *string  `json:"razao_social_fatura,omitempty"`
	RessarcimentoEstimado *float64 `json:"ressarcimento_estimado,omitempty"`
	LinkFatura            *string  `json:"link_fatura,omitempty"`
	DataCriacaoReq        *string  `json:"data_criacao_requisicao,omitempty"` // YYYY-MM-DD HH:mm:ss
	DataMudancaStatus     *string  `json:"data_mudanca_status,omitempty"`

	// Processo (FT_PROCESSOS)
	Etapa       *string `json:"etapa,omitempty"` // nome da etapa
	SubEtapa    *string `json:"sub_etapa,omitempty"`
	Relevancia  *bool   `json:"relevancia,omitempty"`
	DataAlerta  *string `json:"data_alerta,omitempty"`
	UltimaAtual *string `json:"ultima_atualizacao,omitempty"`

	// Deferimento
	Deferimento json.RawMessage `json:"deferimento,omitempty"`

	// Fluxo / Faturamento (formatos compatíveis com handlers existentes)
	FluxoRessarcimento json.RawMessage `json:"fluxo_ressarcimento,omitempty"`
	Faturamento        json.RawMessage `json:"faturamento,omitempty"`

	// Histórico manual
	Historico []struct {
		IDHistorico         int     `json:"id_historico,omitempty"`
		Data                string  `json:"data"` // YYYY-MM-DD HH:mm:ss
		Comentario          string  `json:"comentario"`
		StatusAnterior      *string `json:"status_anterior,omitempty"`
		StatusNovo          *string `json:"status_novo,omitempty"`
		EtapaAnterior       *string `json:"etapa_anterior,omitempty"`
		EtapaNova           *string `json:"etapa_nova,omitempty"`
		SubEtapa            *string `json:"sub_etapa,omitempty"`
		RelevanciaAnterior  *bool   `json:"relevancia_anterior,omitempty"`
		RelevanciaNova      *bool   `json:"relevancia_nova,omitempty"`
		JustificativaAtraso *string `json:"justificativa_atraso,omitempty"`
		TipoMovimentacao    *string `json:"tipo_movimentacao,omitempty"`
	} `json:"historico,omitempty"`

	HistoricoDeleteIDs []int `json:"historico_delete_ids,omitempty"`
}

// AdminEditProcesso: cria ou edita um processo e seus Módulos. Acesso: admin.
// AdminEditProcesso godoc
// @Summary      Edita processo (admin)
// @Tags         Admin
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/admin/editor/processo [post]
func AdminEditProcesso(c *gin.Context) {
	var body AdminEditPayload
	// Log do corpo bruto para depuração de 400/500
	if raw, errRead := io.ReadAll(c.Request.Body); errRead == nil {
		// reponha o body para o bind
		c.Request.Body = io.NopCloser(strings.NewReader(string(raw)))
		if err := c.ShouldBindJSON(&body); err != nil {
			// inclui um trecho do corpo para facilitar debug
			snippet := string(raw)
			if len(snippet) > 400 {
				snippet = snippet[:400] + "..."
			}
			_ = snippet // usado apenas em log interno
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
			return
		}
	} else {
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
			return
		}
	}

	userIDVal, _ := c.Get("userID")
	var userIDNull sql.NullInt64
	switch v := userIDVal.(type) {
	case int64:
		if v > 0 {
			userIDNull = sql.NullInt64{Int64: v, Valid: true}
		}
	case float64:
		if v > 0 {
			userIDNull = sql.NullInt64{Int64: int64(v), Valid: true}
		}
	}
	var err error
	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": tx.Error.Error()})
		return
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback().Error
		}
	}()

	var pid int
	createdProcess := false

	// Criação ou validação do processo
	if body.CriarNovo {
		// Inserir FT_REQUISICOES (mínimo: cliente/uc opcional)
		res, err2 := execGorm(tx, `INSERT INTO FT_REQUISICOES (cliente, uc, concessionaria, cnpj, endereco_completo, razao_social_fatura, ressarcimento_estimado, link_fatura, data_criacao, data_mudanca_status)
                               VALUES (?,?,?,?,?,?,?,?, COALESCE(?, NOW()), COALESCE(?, NOW()))`,
			valOrNull(body.Cliente), valOrNull(body.UC), valOrNull(body.Concessionaria), valOrNull(body.CNPJ), valOrNull(body.EnderecoCompleto), valOrNull(body.RazaoSocialFatura), valOrNull(body.RessarcimentoEstimado), valOrNull(body.LinkFatura), valOrNull(body.DataCriacaoReq), valOrNull(body.DataMudancaStatus))
		if err2 != nil {
			err = err2
			c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao criar requisição: " + err.Error()})
			return
		}
		lastID, _ := res.LastInsertId()
		pid = int(lastID)
		// Criar FT_PROCESSOS (etapa id=1, sub_etapa "Primeira reclamação da etapa - Em elaboração")
		etapaID := sql.NullInt64{Int64: 1, Valid: true}
		subEtapa := "Primeira reclamação da etapa - Em elaboração"
		subEtapaID, _ := resolveSubEtapaIDGorm(tx, subEtapa)
		var colID sql.NullInt64
		var colNome sql.NullString
		_ = queryRowGorm(tx, `
			SELECT k.id_coluna, k.nome_coluna
			  FROM DM_ETAPAS_PROCESSO e
			  JOIN DM_KANBAN_COLUNAS k ON k.id_coluna = e.id_coluna_kanban
			 WHERE e.id_etapa_processo = ?`,
			etapaID.Int64,
		).Scan(&colID, &colNome)
		_, err = execGorm(tx, `INSERT INTO FT_PROCESSOS (id_processo, id_etapa_processo, sub_etapa, id_sub_etapa_processo, id_coluna, nome_coluna, relevancia, data_alerta, ultima_atualizacao)
                          VALUES (?, ?, ?, ?, ?, ?, COALESCE(?,0), NULLIF(?, ''), COALESCE(NULLIF(?, ''), NOW()))`,
			pid, etapaID.Int64, subEtapa, nullIntToIface(subEtapaID), nullIntToIface(colID), func() interface{} {
				if colNome.Valid {
					return colNome.String
				}
				return nil
			}(), boolToTiny(body.Relevancia), valOrEmpty(body.DataAlerta), valOrEmpty(body.UltimaAtual))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao criar processo: " + err.Error()})
			return
		}
		createdProcess = true
	} else {
		if body.ProcessoID == nil || *body.ProcessoID <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "processo_id obrigatório ou use criar_novo"})
			return
		}
		pid = *body.ProcessoID
	}

	// Atualizar FT_REQUISICOES quando ID fornecido
	if !body.CriarNovo {
		set := make([]string, 0, 12)
		args := make([]interface{}, 0, 12)
		addStr := func(p *string, clause string) {
			if p != nil {
				set = append(set, clause)
				args = append(args, strings.TrimSpace(*p))
			}
		}
		addF64 := func(p *float64, clause string) {
			if p != nil {
				set = append(set, clause)
				args = append(args, *p)
			}
		}
		addStr(body.UC, "uc = ?")
		addStr(body.Cliente, "cliente = ?")
		addStr(body.Concessionaria, "concessionaria = ?")
		addStr(body.CNPJ, "cnpj = ?")
		addStr(body.EnderecoCompleto, "endereco_completo = ?")
		addStr(body.RazaoSocialFatura, "razao_social_fatura = ?")
		addF64(body.RessarcimentoEstimado, "ressarcimento_estimado = ?")
		addStr(body.LinkFatura, "link_fatura = ?")
		addStr(body.DataCriacaoReq, "data_criacao = ?")
		addStr(body.DataMudancaStatus, "data_mudanca_status = ?")
		if len(set) > 0 {
			q := "UPDATE FT_REQUISICOES SET " + strings.Join(set, ", ") + " WHERE id_requisicao = ?"
			args = append(args, pid)
			if _, err = execGorm(tx, q, args...); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao atualizar requisição: " + err.Error()})
				return
			}
		}
	}

	// Atualizar FT_PROCESSOS
	if body.Coluna != nil || body.Etapa != nil || body.SubEtapa != nil || body.Relevancia != nil || body.DataAlerta != nil || body.UltimaAtual != nil {
		set := make([]string, 0, 6)
		args := make([]interface{}, 0, 6)
		colunaLabel := ""
		if body.Coluna != nil {
			colunaLabel = strings.TrimSpace(*body.Coluna)
		}
		isSuspensos := strings.EqualFold(colunaLabel, "Suspensos") || strings.EqualFold(colunaLabel, "Suspenso")

		if body.Coluna != nil && strings.TrimSpace(*body.Coluna) != "" {
			colLabel := strings.TrimSpace(*body.Coluna)
			var colID sql.NullInt64
			var colNome sql.NullString
			_ = queryRowGorm(tx, `SELECT id_coluna, nome_coluna FROM DM_KANBAN_COLUNAS WHERE nome_coluna = ? LIMIT 1`, colLabel).Scan(&colID, &colNome)
			if colID.Valid {
				set = append(set, "id_coluna = ?")
				args = append(args, colID.Int64)
				set = append(set, "nome_coluna = ?")
				if colNome.Valid {
					args = append(args, colNome.String)
				} else {
					args = append(args, colLabel)
				}
			}
		}
		if body.Etapa != nil {
			var etapaID int
			if err = queryRowGorm(tx, "SELECT id_etapa_processo FROM DM_ETAPAS_PROCESSO WHERE etapa = ?", strings.TrimSpace(*body.Etapa)).Scan(&etapaID); err == nil {
				set = append(set, "id_etapa_processo = ?")
				args = append(args, etapaID)
				// Só sobrescreve a coluna quando o usuário NÃO definiu explicitamente a coluna
				if body.Coluna == nil || strings.TrimSpace(*body.Coluna) == "" {
					var colID sql.NullInt64
					var colNome sql.NullString
					_ = queryRowGorm(tx, `
						SELECT k.id_coluna, k.nome_coluna
						  FROM DM_ETAPAS_PROCESSO e
						  JOIN DM_KANBAN_COLUNAS k ON k.id_coluna = e.id_coluna_kanban
						 WHERE e.id_etapa_processo = ?`,
						etapaID,
					).Scan(&colID, &colNome)
					set = append(set, "id_coluna = ?")
					args = append(args, nullIntToIface(colID))
					set = append(set, "nome_coluna = ?")
					if colNome.Valid {
						args = append(args, colNome.String)
					} else {
						args = append(args, nil)
					}
				}
			}
		}
		if body.SubEtapa != nil {
			set = append(set, "sub_etapa = ?")
			args = append(args, strings.TrimSpace(*body.SubEtapa))
			subID, _ := resolveSubEtapaIDGorm(tx, strings.TrimSpace(*body.SubEtapa))
			set = append(set, "id_sub_etapa_processo = ?")
			args = append(args, nullIntToIface(subID))
		}
		// Suspensos: força flag/coluna/sub_etapa mesmo que sub_etapa venha vazio
		if isSuspensos {
			set = append(set, "suspenso = 1")
			// garante coluna Suspensos
			set = append(set, "id_coluna = 99")
			set = append(set, "nome_coluna = 'Suspensos'")
			set = append(set, "sub_etapa = 'Suspenso'")
			set = append(set, "id_sub_etapa_processo = NULL")
		}
		if body.Relevancia != nil {
			set = append(set, "relevancia = ?")
			args = append(args, boolToTiny(body.Relevancia))
		}
		if body.DataAlerta != nil {
			set = append(set, "data_alerta = NULLIF(?, '')")
			args = append(args, strings.TrimSpace(*body.DataAlerta))
		}
		if body.UltimaAtual != nil {
			set = append(set, "ultima_atualizacao = NULLIF(?, '')")
			args = append(args, strings.TrimSpace(*body.UltimaAtual))
		}
		if len(set) > 0 {
			q := "UPDATE FT_PROCESSOS SET " + strings.Join(set, ", ") + " WHERE id_processo = ?"
			args = append(args, pid)
			if _, err = execGorm(tx, q, args...); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao atualizar processo: " + err.Error()})
				return
			}
		}
	}

	// Deferimento (somente se houver pelo menos um campo significativo)
	if len(body.Deferimento) > 0 {
		var input struct {
			DataProcedencia      *string          `json:"data_procedencia"`
			CreditoSimples       *decimal.Decimal `json:"credito_simples"`
			CreditoDobro         *decimal.Decimal `json:"credito_dobro"`
			DataCreditoDobro     *string          `json:"data_credito_dobro"`
			RepasseSimples       *decimal.Decimal `json:"repasse_simples"`
			RepasseDobro         *decimal.Decimal `json:"repasse_dobro"`
			InstanciaDeferimento *int             `json:"instancia_deferimento"` // FK DM_INSTANCIA_DEFERIMENTO
		}
		if err2 := json.Unmarshal(body.Deferimento, &input); err2 == nil {
			hasData := (input.DataProcedencia != nil && strings.TrimSpace(*input.DataProcedencia) != "") ||
				(input.DataCreditoDobro != nil && strings.TrimSpace(*input.DataCreditoDobro) != "") ||
				(input.CreditoSimples != nil && input.CreditoSimples.Sign() != 0) ||
				(input.CreditoDobro != nil && input.CreditoDobro.Sign() != 0) ||
				(input.RepasseSimples != nil && input.RepasseSimples.Sign() != 0) ||
				(input.RepasseDobro != nil && input.RepasseDobro.Sign() != 0) ||
				(input.InstanciaDeferimento != nil)
			if hasData {
				_, err = execGorm(tx, `INSERT INTO FT_DEFERIMENTOS (id_processo, data_procedencia, credito_simples, credito_dobro, data_credito_dobro, repasse_simples, repasse_dobro, instancia_deferimento)
				   VALUES (?, NULLIF(?, ''), ?, ?, NULLIF(?, ''), ?, ?, ?)
                                   ON DUPLICATE KEY UPDATE data_procedencia=VALUES(data_procedencia), credito_simples=VALUES(credito_simples), credito_dobro=VALUES(credito_dobro), data_credito_dobro=VALUES(data_credito_dobro), repasse_simples=VALUES(repasse_simples), repasse_dobro=VALUES(repasse_dobro), instancia_deferimento=VALUES(instancia_deferimento)`,
					pid,
					valOrEmpty(input.DataProcedencia),
					decimalOrNull(input.CreditoSimples),
					decimalOrNull(input.CreditoDobro),
					valOrEmpty(input.DataCreditoDobro),
					decimalOrNull(input.RepasseSimples),
					decimalOrNull(input.RepasseDobro),
					intPtrOrNull(input.InstanciaDeferimento),
				)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao salvar deferimento: " + err.Error()})
					return
				}
				// Propaga a instância também para FT_PROCESSOS, para queries
				// que listam o processo terem a instância sem precisar JOIN.
				if input.InstanciaDeferimento != nil {
					if _, err = execGorm(tx, `UPDATE FT_PROCESSOS SET instancia_deferimento = ? WHERE id_processo = ?`,
						*input.InstanciaDeferimento, pid); err != nil {
						c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao atualizar instância no processo: " + err.Error()})
						return
					}
				}
			}
		}
	}

	// Fluxo & Faturamento (reuso das funções internas)
	if len(body.FluxoRessarcimento) > 0 {
		if err = salvarFluxoRessarcimentoInterno(pid, string(body.FluxoRessarcimento), tx); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao salvar fluxo: " + err.Error()})
			return
		}
	}
	if len(body.Faturamento) > 0 {
		if err = salvarFaturamentoInterno(pid, string(body.Faturamento), tx); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao salvar faturamento: " + err.Error()})
			return
		}
	}

	// Histórico: delete espec?ficos
	if len(body.HistoricoDeleteIDs) > 0 {
		// constr?i placeholders
		qs := make([]string, 0, len(body.HistoricoDeleteIDs))
		args := make([]interface{}, 0, len(body.HistoricoDeleteIDs)+1)
		for range body.HistoricoDeleteIDs {
			qs = append(qs, "?")
		}
		// segurança: garanta que pertence ao processo
		q := "DELETE FROM FT_HISTORICO_MOVIMENTACOES WHERE id_historico IN (" + strings.Join(qs, ",") + ") AND id_requisicao = ?"
		for _, id := range body.HistoricoDeleteIDs {
			args = append(args, id)
		}
		args = append(args, pid)
		if _, err = execGorm(tx, q, args...); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao deletar histórico: " + err.Error()})
			return
		}
	}

	// Histórico: upsert b?sico (update se vier id, senão insert)
	if len(body.Historico) > 0 {
		for _, h := range body.Historico {
			if h.IDHistorico > 0 {
				// Update
				_, err = execGorm(tx, `UPDATE FT_HISTORICO_MOVIMENTACOES SET 
                                    status_anterior = ?, status_novo = ?, etapa_anterior = ?, etapa_nova = ?, sub_etapa = ?,
                                    relevancia_anterior = ?, relevancia_nova = ?, comentario = ?, justificativa_atraso = ?, tipo_movimentacao = ?, data_movimentacao = ?
                                  WHERE id_historico = ? AND id_requisicao = ?`,
					adminNullIfEmpty(h.StatusAnterior), adminNullIfEmpty(h.StatusNovo), adminNullIfEmpty(h.EtapaAnterior), adminNullIfEmpty(h.EtapaNova), adminNullIfEmpty(h.SubEtapa),
					adminBoolStrOrNull(h.RelevanciaAnterior), adminBoolStrOrNull(h.RelevanciaNova), strings.TrimSpace(h.Comentario), adminNullIfEmpty(h.JustificativaAtraso), adminNullIfEmpty(h.TipoMovimentacao), h.Data,
					h.IDHistorico, pid,
				)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao atualizar histórico: " + err.Error()})
					return
				}
			} else {
				// Insert
				_, err = execGorm(tx, `INSERT INTO FT_HISTORICO_MOVIMENTACOES (
                                    id_requisicao, id_usuario_gestor, status_anterior, status_novo,
                                    etapa_anterior, etapa_nova, sub_etapa,
                                    relevancia_anterior, relevancia_nova,
                                    comentario, justificativa_atraso, tipo_movimentacao, data_movimentacao)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					pid, userIDNull, adminNullIfEmpty(h.StatusAnterior), adminNullIfEmpty(h.StatusNovo), adminNullIfEmpty(h.EtapaAnterior), adminNullIfEmpty(h.EtapaNova), adminNullIfEmpty(h.SubEtapa),
					adminBoolStrOrNull(h.RelevanciaAnterior), adminBoolStrOrNull(h.RelevanciaNova), strings.TrimSpace(h.Comentario), adminNullIfEmpty(h.JustificativaAtraso), adminNullIfEmpty(h.TipoMovimentacao), h.Data)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao inserir histórico: " + err.Error()})
					return
				}
			}
		}
	}

	if err = updateColunaByData(tx, pid, 0); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao atualizar coluna do processo: " + err.Error()})
		return
	}

	// Sincroniza FT_PROCESSOS com a ultima movimentacao do historico (best-effort).
	// Uma unica chamada apos o loop de upsert de historico (mesma tx, mesmo processo).
	_ = SincronizarStatusProcesso(tx, pid)

	if err = tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if createdProcess {
		syncSnapshotFromOriginal(pid, 0)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "processo_id": pid})
}

// AdminNextProcessID retorna o próximo ID sugerido para criação de processo
// Regra: usa MAX(id_requisicao)+1 de FT_REQUISICOES (id_processo = id_requisicao)
// AdminNextProcessID godoc
// @Summary      Pr?ximo ID de processo
// @Tags         Admin
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/admin/editor/next-id [get]
func AdminNextProcessID(c *gin.Context) {
	var next int
	if err := queryRowGorm(database.GormDB_App, "SELECT COALESCE(MAX(id_requisicao),0)+1 FROM FT_REQUISICOES").Scan(&next); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao obter pr?ximo ID: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"next_id": next})
}

// helpers simples de binding
func valOrNull[T any](p *T) interface{} {
	if p == nil {
		return nil
	}
	return *p
}
func decimalOrNull(d *decimal.Decimal) interface{} {
	if d == nil {
		return nil
	}
	return d
}
func intPtrOrNull(p *int) interface{} {
	if p == nil {
		return nil
	}
	return *p
}
func valOrEmpty(p *string) interface{} {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(*p)
}
func boolToTiny(p *bool) interface{} {
	if p == nil {
		return nil
	}
	if *p {
		return 1
	}
	return 0
}
func adminNullIfEmpty(p *string) interface{} {
	if p == nil {
		return nil
	}
	s := strings.TrimSpace(*p)
	if s == "" {
		return nil
	}
	return s
}
func adminBoolStrOrNull(p *bool) interface{} {
	if p == nil {
		return nil
	}
	if *p {
		return "true"
	}
	return "false"
}
