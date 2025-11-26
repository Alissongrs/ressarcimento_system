// handlers/fluxo_ressarcimento_handler.go
package handlers

import (
	"database/sql"
	"io"
	"log"
	"net/http"
	"ressarcimento-backend/database"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/sse"

	"github.com/gin-gonic/gin"
)

// FluxoRessarcimentoItem representa um item de devolução no fluxo de ressarcimento
type FluxoRessarcimentoItem struct {
	ID                  int     `json:"id" db:"id_fluxo"`
	IDProcesso          int     `json:"id_processo" db:"id_processo"`
	FormaDevolucao      string  `json:"forma_devolucao" db:"forma_devolucao"`
	Valor               float64 `json:"valor" db:"valor"`
	DataDevolucao       string  `json:"data_devolucao" db:"data_devolucao"`
	DataEnvioFinanceiro string  `json:"data_envio_financeiro" db:"data_envio_financeiro"`
	CreatedAt           string  `json:"created_at" db:"created_at"`
}

// FluxoRessarcimentoRequest representa a requisição para salvar dados do fluxo
type FluxoRessarcimentoRequest struct {
	Itens      []FluxoRessarcimentoItem `json:"itens"`
	Comentario string                   `json:"comentario"`
	SubEtapa   string                   `json:"sub_etapa,omitempty"`
}

// SalvarFluxoRessarcimento salva os dados do fluxo de ressarcimento para um processo
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

	tx, err := database.DB_App.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao iniciar transação"})
		return
	}
	defer tx.Rollback()

	// Upsert: coletar IDs existentes, atualizar/inserir e remover os ausentes
	existing := make(map[int]bool)
	rows, err := tx.Query("SELECT id_fluxo FROM FT_FLUXO_RESSARCIMENTO WHERE id_processo = ?", processoID)
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
		// Validar forma de devolução
		if item.FormaDevolucao != "Fatura" && item.FormaDevolucao != "GD" && item.FormaDevolucao != "Deposito" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Forma de devolução inválida: " + item.FormaDevolucao})
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
			if _, err := tx.Exec(`
                INSERT INTO FT_FLUXO_RESSARCIMENTO 
                (id_processo, forma_devolucao, valor, data_devolucao, data_envio_financeiro) 
                VALUES (?, ?, ?, ?, ?)`,
				processoID, item.FormaDevolucao, item.Valor, dataDevolucao, dataEnvioFinanceiro,
			); err != nil {
				log.Printf("Erro ao inserir item do fluxo: %v", err)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar item do fluxo de ressarcimento"})
				return
			}
		} else {
			delete(existing, item.ID)
			if _, err := tx.Exec(`
                UPDATE FT_FLUXO_RESSARCIMENTO SET
                forma_devolucao = ?, valor = ?, data_devolucao = ?, data_envio_financeiro = ?
                WHERE id_fluxo = ? AND id_processo = ?`,
				item.FormaDevolucao, item.Valor, dataDevolucao, dataEnvioFinanceiro, item.ID, processoID,
			); err != nil {
				log.Printf("Erro ao atualizar item do fluxo %d: %v", item.ID, err)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar item do fluxo"})
				return
			}
		}
	}

	// Excluir itens não enviados
	for idFluxo := range existing {
		if _, err := tx.Exec("DELETE FROM FT_FLUXO_RESSARCIMENTO WHERE id_fluxo = ?", idFluxo); err != nil {
			log.Printf("Erro ao excluir item do fluxo %d: %v", idFluxo, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao excluir item do fluxo"})
			return
		}
	}

	// Registrar no histórico (inclui status e etapas, mesmo sem mudança de etapa)
	gestorIDValue, _ := c.Get("userID")
	gestorID, _ := gestorIDValue.(int64)

	histComment := strings.TrimSpace(request.Comentario)
	if histComment == "" {
		histComment = "Dados do fluxo de ressarcimento foram atualizados"
	}

	// Resolve sub_etapa: aceita override vindo do JSON e persiste no processo
	var subAtual sql.NullString
	_ = tx.QueryRow("SELECT sub_etapa FROM FT_PROCESSOS WHERE id_processo = ?", processoID).Scan(&subAtual)
	subTxt := strings.TrimSpace(subAtual.String)
	if s := strings.TrimSpace(request.SubEtapa); s != "" {
		subTxt = s
		if _, err := tx.Exec("UPDATE FT_PROCESSOS SET sub_etapa = ?, ultima_atualizacao = NOW() WHERE id_processo = ?", subTxt, processoID); err != nil {
			log.Printf("Erro ao atualizar sub_etapa do processo %d no fluxo: %v", processoID, err)
		}
	}

	_, err = tx.Exec(`
        INSERT INTO FT_HISTORICO_MOVIMENTACOES 
        (id_requisicao, id_usuario_gestor,
         status_anterior, status_novo,
         etapa_anterior, etapa_nova, sub_etapa,
         comentario, data_movimentacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		processoID, gestorID,
		"Fluxo de Ressarcimento", "Fluxo de Ressarcimento",
		"Fluxo de Ressarcimento", "Fluxo de Ressarcimento", subTxt,
		histComment, time.Now())

	if err != nil {
		log.Printf("Erro ao registrar no histórico: %v", err)
		// Não falha a operação por causa do histórico
	}

	// Notificar imediato para atualizar histórico na UI
	go func(pid int, sub string) {
		defer func() { recover() }()
		payload := map[string]interface{}{"sub_etapa": strings.TrimSpace(sub)}
		sse.Broadcast(pid, sse.Event{Type: "processo_update", ProcessoID: pid, Payload: payload})
	}(processoID, subTxt)

	if err := tx.Commit(); err != nil {
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
func BuscarFluxoRessarcimento(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}

	rows, err := database.DB_App.Query(`
		SELECT id_fluxo, id_processo, forma_devolucao, 
		       COALESCE(valor, 0) as valor,
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

		err := rows.Scan(&item.ID, &item.IDProcesso, &item.FormaDevolucao,
			&item.Valor, &item.DataDevolucao, &item.DataEnvioFinanceiro, &createdAt)

		if err != nil {
			log.Printf("Erro ao escanear item: %v", err)
			continue
		}

		item.CreatedAt = createdAt.Format("2006-01-02 15:04:05")
		itens = append(itens, item)
	}

	// Se Não há itens, retorna array vazio
	if itens == nil {
		itens = make([]FluxoRessarcimentoItem, 0)
	}

	c.JSON(http.StatusOK, gin.H{"itens": itens})
}

// DeletarItemFluxoRessarcimento deleta um item especÀ­fico do fluxo
func DeletarItemFluxoRessarcimento(c *gin.Context) {
	itemID, err := strconv.Atoi(c.Param("itemId"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do item inválido"})
		return
	}

	_, err = database.DB_App.Exec("DELETE FROM FT_FLUXO_RESSARCIMENTO WHERE id_fluxo = ?", itemID)
	if err != nil {
		log.Printf("Erro ao deletar item do fluxo: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao deletar item"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Item deletado com sucesso!"})
}
