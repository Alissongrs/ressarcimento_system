// handlers/faturamento_handler.go
package handlers

import (
	"database/sql"
	"io"
	"log"
	"net/http"
	"ressarcimento-backend/database"
	"ressarcimento-backend/utils"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/sse"

	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
)

// FaturamentoItem representa um item de faturamento
type FaturamentoItem struct {
	ID             int    `json:"id" db:"id_faturamento"`
	IDProcesso     int    `json:"id_processo" db:"id_processo"`
	NumeroNF       string `json:"numero_nf" db:"numero_nf"`
	DataEmissao    string `json:"data_emissao" db:"data_emissao"`
	DataVencimento string `json:"data_vencimento" db:"data_vencimento"`
	DataPagamento  string `json:"data_pagamento" db:"data_pagamento"`
	Valor          string `json:"valor" db:"valor"` // Recebe como string, converte no handler
	CreatedAt      string `json:"created_at" db:"created_at"`
}

// FaturamentoRequest representa a requisiÃ§ão para salvar dados do faturamento
type FaturamentoRequest struct {
	Itens      []FaturamentoItem `json:"itens"`
	Comentario string            `json:"comentario"`
	SubEtapa   string            `json:"sub_etapa,omitempty"`
}

// SalvarFaturamento salva os dados do faturamento para um processo
// SalvarFaturamento godoc
// @Summary      Salva faturamento do processo
// @Tags         Faturamento
// @Param        id    path   int  true  "ID do processo"
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/faturamento/{id} [post]
func SalvarFaturamento(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}

	var request FaturamentoRequest
	// DEBUG: loga corpo RAW
	if bodyBytes, err2 := io.ReadAll(c.Request.Body); err2 == nil {
		log.Printf("[DEBUG-FAT-RAW] proc=%d raw=%s", processoID, strings.TrimSpace(string(bodyBytes)))
		c.Request.Body = io.NopCloser(strings.NewReader(string(bodyBytes)))
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		log.Printf("Erro ao fazer bind do JSON: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados de entrada inválidos: " + err.Error()})
		return
	}

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao iniciar transação"})
		return
	}
	defer tx.Rollback()

	// Upsert: carregar IDs existentes, atualizar/inserir e remover os ausentes
	existing := make(map[int]bool)
	rows, err := queryGorm(tx, "SELECT id_faturamento FROM FT_FATURAMENTO WHERE id_processo = ?", processoID)
	if err != nil {
		log.Printf("Erro ao buscar IDs existentes do faturamento: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro interno"})
		return
	}
	defer rows.Close()
	for rows.Next() {
		var idFat int
		if err := rows.Scan(&idFat); err == nil {
			existing[idFat] = true
		}
	}

	for _, item := range request.Itens {
		// Converter valor para decimal
		valorDec, err := utils.ParseBrazilianCurrency(item.Valor)
		if err != nil && item.Valor != "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Valor inválido: " + err.Error()})
			return
		}

		// Converter datas para o formato correto se Não estiverem vazias
		var dataEmissao, dataVencimento, dataPagamento sql.NullString

		if item.DataEmissao != "" {
			dataEmissao = sql.NullString{String: item.DataEmissao, Valid: true}
		}
		if item.DataVencimento != "" {
			dataVencimento = sql.NullString{String: item.DataVencimento, Valid: true}
		}
		if item.DataPagamento != "" {
			dataPagamento = sql.NullString{String: item.DataPagamento, Valid: true}
		}

		if item.ID == 0 {
			if _, err := execGorm(tx, `
                INSERT INTO FT_FATURAMENTO
                (id_processo, numero_nf, data_emissao, data_vencimento, data_pagamento, valor)
                VALUES (?, ?, ?, ?, ?, ?)`,
				processoID, item.NumeroNF, dataEmissao, dataVencimento, dataPagamento, valorDec,
			); err != nil {
				log.Printf("Erro ao inserir item do faturamento: %v", err)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar item do faturamento"})
				return
			}
		} else {
			delete(existing, item.ID)
			if _, err := execGorm(tx, `
                UPDATE FT_FATURAMENTO SET
                numero_nf = ?, data_emissao = ?, data_vencimento = ?, data_pagamento = ?, valor = ?
                WHERE id_faturamento = ? AND id_processo = ?`,
				item.NumeroNF, dataEmissao, dataVencimento, dataPagamento, valorDec, item.ID, processoID,
			); err != nil {
				log.Printf("Erro ao atualizar item de faturamento %d: %v", item.ID, err)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar item do faturamento"})
				return
			}
		}
	}

	// Excluir itens não enviados
	for idFat := range existing {
		if _, err := execGorm(tx, "DELETE FROM FT_FATURAMENTO WHERE id_faturamento = ?", idFat); err != nil {
			log.Printf("Erro ao excluir item do faturamento %d: %v", idFat, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao excluir item do faturamento"})
			return
		}
	}

	// Registrar no histórico (inclui status e etapas, mesmo sem mudanÃ§a de etapa)
	gestorIDValue, _ := c.Get("userID")
	gestorID, _ := gestorIDValue.(int64)

	histComment := strings.TrimSpace(request.Comentario)
	if histComment == "" {
		histComment = "Dados do faturamento foram atualizados"
	}

	// Resolve sub_etapa: aceita override vindo do JSON e persiste no processo
	var subAtual sql.NullString
	_ = queryRowGorm(tx, "SELECT sub_etapa FROM FT_PROCESSOS WHERE id_processo = ?", processoID).Scan(&subAtual)
	subTxt := strings.TrimSpace(subAtual.String)
	if s := strings.TrimSpace(request.SubEtapa); s != "" {
		subTxt = s
		subID, _ := resolveSubEtapaIDGorm(tx, subTxt)
		if _, err := execGorm(tx, "UPDATE FT_PROCESSOS SET sub_etapa = ?, id_sub_etapa_processo = ?, ultima_atualizacao = NOW() WHERE id_processo = ?", subTxt, nullIntToIface(subID), processoID); err != nil {
			log.Printf("Erro ao atualizar sub_etapa do processo %d no faturamento: %v", processoID, err)
		}
	}

	statusNome := strings.TrimSpace(getStatusNomeByRequisicaoGorm(tx, int64(processoID)))
	if statusNome == "" {
		statusNome = "Em andamento"
	}
	_, err = execGorm(tx, `
        INSERT INTO FT_HISTORICO_MOVIMENTACOES 
        (id_requisicao, id_usuario_gestor,
         status_anterior, status_novo,
         etapa_anterior, etapa_nova, sub_etapa,
         comentario, data_movimentacao) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		processoID, gestorID,
		statusNome, statusNome,
		"Faturamento", "Faturamento", subTxt,
		histComment, time.Now())

	if err != nil {
		log.Printf("Erro ao registrar no histórico: %v", err)
		// Não falha a operaÃ§ão por causa do histórico
	}

	// Notificar imediato para atualizar histórico na UI
	go func(pid int, sub string) {
		defer func() { recover() }()
		payload := map[string]interface{}{"sub_etapa": strings.TrimSpace(sub)}
		sse.Broadcast(pid, sse.Event{Type: "processo_update", ProcessoID: pid, Payload: payload})
	}(processoID, subTxt)

	if err := updateColunaByData(tx, processoID, gestorID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar coluna do processo"})
		return
	}

	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao finalizar a transacao"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Dados do faturamento salvos com sucesso!", "sub_etapa": subTxt})

	// Notificar ouvintes SSE (histórico e estado)
	go func(pid int) {
		defer func() { recover() }()
		sse.Broadcast(pid, sse.Event{Type: "processo_update", ProcessoID: pid})
	}(processoID)
}

// BuscarFaturamento busca os dados do faturamento para um processo
// BuscarFaturamento godoc
// @Summary      Busca faturamento do processo
// @Tags         Faturamento
// @Param        id   path   int  true  "ID do processo"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/faturamento/{id} [get]
func BuscarFaturamento(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}

	rows, err := queryGorm(database.GormDB_App, `
		SELECT id_faturamento, id_processo, 
		       COALESCE(numero_nf, '') as numero_nf,
		       COALESCE(data_emissao, '') as data_emissao,
		       COALESCE(data_vencimento, '') as data_vencimento,
		       COALESCE(data_pagamento, '') as data_pagamento,
		       COALESCE(valor, 0) as valor,
		       created_at
		FROM FT_FATURAMENTO 
		WHERE id_processo = ? 
		ORDER BY created_at ASC`, processoID)

	if err != nil {
		log.Printf("Erro ao buscar dados do faturamento: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar dados do faturamento"})
		return
	}
	defer rows.Close()

	var itens []FaturamentoItem
	for rows.Next() {
		var item FaturamentoItem
		var createdAt time.Time
		var valorDec decimal.Decimal

		err := rows.Scan(&item.ID, &item.IDProcesso, &item.NumeroNF,
			&item.DataEmissao, &item.DataVencimento, &item.DataPagamento,
			&valorDec, &createdAt)

		if err != nil {
			log.Printf("Erro ao escanear item: %v", err)
			continue
		}

		// Formata o valor para o frontend (formato brasileiro)
		item.Valor = utils.FormatBrazilianCurrency(valorDec)
		item.CreatedAt = createdAt.Format("2006-01-02 15:04:05")
		itens = append(itens, item)
	}

	// Se Não há itens, retorna array vazio
	if itens == nil {
		itens = make([]FaturamentoItem, 0)
	}

	c.JSON(http.StatusOK, gin.H{"itens": itens})
}

// DeletarItemFaturamento deleta um item especÀÂ­fico do faturamento
// DeletarItemFaturamento godoc
// @Summary      Deleta item do faturamento
// @Tags         Faturamento
// @Param        itemId  path   int  true  "ID do item"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/faturamento/item/{itemId} [delete]
func DeletarItemFaturamento(c *gin.Context) {
	itemID, err := strconv.Atoi(c.Param("itemId"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do item inválido"})
		return
	}

	_, err = execGorm(database.GormDB_App, "DELETE FROM FT_FATURAMENTO WHERE id_faturamento = ?", itemID)
	if err != nil {
		log.Printf("Erro ao deletar item do faturamento: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao deletar item"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Item deletado com sucesso!"})
}

// GetFaturamentoStats retorna estatísticas do faturamento para um processo
// GetFaturamentoStats godoc
// @Summary      Estatísticas de faturamento
// @Tags         Faturamento
// @Param        id   path   int  true  "ID do processo"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/faturamento/{id}/stats [get]
func GetFaturamentoStats(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}

	var stats struct {
		TotalItens    int    `json:"total_itens"`
		ValorTotal    string `json:"valor_total"` // Formato brasileiro
		ItensPagos    int    `json:"itens_pagos"`
		ItensVencidos int    `json:"itens_vencidos"`
	}

	var valorTotalDec decimal.Decimal

	// Buscar estatísticas
	err = queryRowGorm(database.GormDB_App, `
		SELECT
			COUNT(*) as total_itens,
			COALESCE(SUM(valor), 0) as valor_total,
			SUM(CASE WHEN data_pagamento IS NOT NULL AND data_pagamento != '' THEN 1 ELSE 0 END) as itens_pagos,
			SUM(CASE WHEN data_vencimento IS NOT NULL AND data_vencimento != '' AND data_vencimento < CURDATE() AND (data_pagamento IS NULL OR data_pagamento = '') THEN 1 ELSE 0 END) as itens_vencidos
		FROM FT_FATURAMENTO
		WHERE id_processo = ?`, processoID).Scan(&stats.TotalItens, &valorTotalDec, &stats.ItensPagos, &stats.ItensVencidos)

	// Formata o valor total para o frontend
	stats.ValorTotal = utils.FormatBrazilianCurrency(valorTotalDec)

	if err != nil {
		log.Printf("Erro ao buscar estatísticas do faturamento: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar estatísticas"})
		return
	}

	c.JSON(http.StatusOK, stats)
}







