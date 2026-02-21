// handlers/fluxo_ressarcimento_handler.go
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

// FluxoRessarcimentoItem representa um item de devoluÃ§ão no fluxo de ressarcimento
type FluxoRessarcimentoItem struct {
	ID                  int    `json:"id" db:"id_fluxo"`
	IDProcesso          int    `json:"id_processo" db:"id_processo"`
	FormaDevolucao      string `json:"forma_devolucao" db:"forma_devolucao"`
	Valor               string `json:"valor" db:"valor"` // Recebe como string, converte no handler
	Simples             int    `json:"simples" db:"simples"`
	Dobro               int    `json:"dobro" db:"dobro"`
	SimplesDobro        int    `json:"simples_dobro" db:"simples_dobro"`
	DataDevolucao       string `json:"data_devolucao" db:"data_devolucao"`
	DataEnvioFinanceiro string `json:"data_envio_financeiro" db:"data_envio_financeiro"`
	CreatedAt           string `json:"created_at" db:"created_at"`
}

// FluxoRessarcimentoRequest representa a requisiÃ§ão para salvar dados do fluxo
type FluxoRessarcimentoRequest struct {
	Itens      []FluxoRessarcimentoItem `json:"itens"`
	Comentario string                   `json:"comentario"`
	SubEtapa   string                   `json:"sub_etapa,omitempty"`
}

// SalvarFluxoRessarcimento salva os dados do fluxo de ressarcimento para um processo
// SalvarFluxoRessarcimento godoc
// @Summary      Salva fluxo de ressarcimento
// @Tags         FluxoRessarcimento
// @Param        id    path   int  true  "ID do processo"
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/fluxo-ressarcimento/{id} [post]
func SalvarFluxoRessarcimento(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}

	var request FluxoRessarcimentoRequest
	// DEBUG: loga corpo RAW
	if bodyBytes, err2 := io.ReadAll(c.Request.Body); err2 == nil {
		log.Printf("[DEBUG-FLUXO-RAW] proc=%d raw=%s", processoID, strings.TrimSpace(string(bodyBytes)))
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

	// Upsert: coletar IDs existentes, atualizar/inserir e remover os ausentes
	existing := make(map[int]bool)
	rows, err := queryGorm(tx, "SELECT id_fluxo FROM FT_FLUXO_RESSARCIMENTO WHERE id_processo = ?", processoID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro interno"})
		return
	}
	for rows.Next() {
		var idFluxo int
		if err := rows.Scan(&idFluxo); err == nil {
			existing[idFluxo] = true
		}
	}
	rows.Close()

	for _, item := range request.Itens {
		// Validar forma de devoluÃ§ão
		item.FormaDevolucao = strings.TrimSpace(item.FormaDevolucao)
		if item.FormaDevolucao == "Depósito" {
			item.FormaDevolucao = "Deposito"
		}
		if item.FormaDevolucao != "Fatura" && item.FormaDevolucao != "GD" && item.FormaDevolucao != "Deposito" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Forma de devoluÃ§ão inválida: " + item.FormaDevolucao})
			return
		}
		if item.Simples != 0 && item.Dobro != 0 {
			item.SimplesDobro = 1
		}
		if item.SimplesDobro != 0 {
			item.Simples = 0
			item.Dobro = 0
		}

		// Converter valor para decimal
		valorDec, err := utils.ParseBrazilianCurrency(item.Valor)
		if err != nil && item.Valor != "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Valor inválido: " + err.Error()})
			return
		}

		// Converter datas para o formato correto se Não estiverem vazias
		var dataDevolucao, dataEnvioFinanceiro sql.NullString
		if item.DataDevolucao != "" {
			dataDevolucao = sql.NullString{String: item.DataDevolucao, Valid: true}
		}
		if item.DataEnvioFinanceiro != "" {
			dataEnvioFinanceiro = sql.NullString{String: item.DataEnvioFinanceiro, Valid: true}
		}

		if item.ID == 0 {
			if _, err := execGorm(tx, `
                INSERT INTO FT_FLUXO_RESSARCIMENTO
                (id_processo, forma_devolucao, valor, simples, dobro, simples_dobro, data_devolucao, data_envio_financeiro)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				processoID, item.FormaDevolucao, valorDec, item.Simples, item.Dobro, item.SimplesDobro, dataDevolucao, dataEnvioFinanceiro,
			); err != nil {
				log.Printf("Erro ao inserir item do fluxo: %v", err)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar item do fluxo de ressarcimento"})
				return
			}
		} else {
			delete(existing, item.ID)
			if _, err := execGorm(tx, `
                UPDATE FT_FLUXO_RESSARCIMENTO SET
                forma_devolucao = ?, valor = ?, simples = ?, dobro = ?, simples_dobro = ?, data_devolucao = ?, data_envio_financeiro = ?
                WHERE id_fluxo = ? AND id_processo = ?`,
				item.FormaDevolucao, valorDec, item.Simples, item.Dobro, item.SimplesDobro, dataDevolucao, dataEnvioFinanceiro, item.ID, processoID,
			); err != nil {
				log.Printf("Erro ao atualizar item do fluxo %d: %v", item.ID, err)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar item do fluxo"})
				return
			}
		}
	}

	// Excluir itens não enviados
	for idFluxo := range existing {
		if _, err := execGorm(tx, "DELETE FROM FT_FLUXO_RESSARCIMENTO WHERE id_fluxo = ?", idFluxo); err != nil {
			log.Printf("Erro ao excluir item do fluxo %d: %v", idFluxo, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao excluir item do fluxo"})
			return
		}
	}

	// Registrar no histórico (inclui status e etapas, mesmo sem mudanÃ§a de etapa)
	gestorIDValue, _ := c.Get("userID")
	gestorID, _ := gestorIDValue.(int64)

	histComment := strings.TrimSpace(request.Comentario)
	if histComment == "" {
		histComment = "Dados do fluxo de ressarcimento foram atualizados"
	}

	// Resolve sub_etapa: aceita override vindo do JSON e persiste no processo
	var subAtual sql.NullString
	_ = queryRowGorm(tx, "SELECT sub_etapa FROM FT_PROCESSOS WHERE id_processo = ?", processoID).Scan(&subAtual)
	subTxt := strings.TrimSpace(subAtual.String)
	if s := strings.TrimSpace(request.SubEtapa); s != "" {
		subTxt = s
		subID, _ := resolveSubEtapaIDGorm(tx, subTxt)
		if _, err := execGorm(tx, "UPDATE FT_PROCESSOS SET sub_etapa = ?, id_sub_etapa_processo = ?, ultima_atualizacao = NOW() WHERE id_processo = ?", subTxt, nullIntToIface(subID), processoID); err != nil {
			log.Printf("Erro ao atualizar sub_etapa do processo %d no fluxo: %v", processoID, err)
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
		"Fluxo de Ressarcimento", "Fluxo de Ressarcimento", subTxt,
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

	if err := updateColunaByData(tx, processoID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar coluna do processo"})
		return
	}

	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao finalizar a transacao"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Dados do fluxo de ressarcimento salvos com sucesso!", "sub_etapa": subTxt})

	// Notificar ouvintes SSE (histórico e estado)
	go func(pid int) {
		defer func() { recover() }()
		sse.Broadcast(pid, sse.Event{Type: "processo_update", ProcessoID: pid})
	}(processoID)
}

// BuscarFluxoRessarcimento busca os dados do fluxo de ressarcimento para um processo
// BuscarFluxoRessarcimento godoc
// @Summary      Busca fluxo de ressarcimento
// @Tags         FluxoRessarcimento
// @Param        id   path   int  true  "ID do processo"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/fluxo-ressarcimento/{id} [get]
func BuscarFluxoRessarcimento(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}

	rows, err := queryGorm(database.GormDB_App, `
		SELECT id_fluxo, id_processo, forma_devolucao, 
		       COALESCE(valor, 0) as valor,
		       COALESCE(simples, 0) as simples,
		       COALESCE(dobro, 0) as dobro,
		       COALESCE(simples_dobro, 0) as simples_dobro,
		       COALESCE(data_devolucao, '') as data_devolucao,
		       COALESCE(data_envio_financeiro, '') as data_envio_financeiro,
		       created_at
		FROM FT_FLUXO_RESSARCIMENTO 
		WHERE id_processo = ? 
		ORDER BY created_at ASC`, processoID)

	if err != nil {
		log.Printf("Erro ao buscar dados do fluxo: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar dados do fluxo de ressarcimento"})
		return
	}
	defer rows.Close()

	var itens []FluxoRessarcimentoItem
	for rows.Next() {
		var item FluxoRessarcimentoItem
		var createdAt time.Time
		var valorDec decimal.Decimal

		err := rows.Scan(&item.ID, &item.IDProcesso, &item.FormaDevolucao,
			&valorDec, &item.Simples, &item.Dobro, &item.SimplesDobro, &item.DataDevolucao, &item.DataEnvioFinanceiro, &createdAt)

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
		itens = make([]FluxoRessarcimentoItem, 0)
	}

	c.JSON(http.StatusOK, gin.H{"itens": itens})
}

// DeletarItemFluxoRessarcimento deleta um item especÀÂ­fico do fluxo
// DeletarItemFluxoRessarcimento godoc
// @Summary      Deleta item do fluxo de ressarcimento
// @Tags         FluxoRessarcimento
// @Param        itemId  path   int  true  "ID do item"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/fluxo-ressarcimento/item/{itemId} [delete]
func DeletarItemFluxoRessarcimento(c *gin.Context) {
	itemID, err := strconv.Atoi(c.Param("itemId"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do item inválido"})
		return
	}

	_, err = execGorm(database.GormDB_App, "DELETE FROM FT_FLUXO_RESSARCIMENTO WHERE id_fluxo = ?", itemID)
	if err != nil {
		log.Printf("Erro ao deletar item do fluxo: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao deletar item"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Item deletado com sucesso!"})
}









