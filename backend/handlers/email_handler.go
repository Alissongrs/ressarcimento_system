// backend/handlers/email_handler.go
// Package handlers contém os controladores HTTP da aplicação.
package handlers

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"ressarcimento-backend/database"
	"ressarcimento-backend/models"
	"ressarcimento-backend/services"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// EnviarEmailProcesso envia um e-mail e registra o evento no banco e no histórico.
func EnviarEmailProcesso(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}

	userID, _ := c.Get("userID")
	remetenteID, _ := userID.(int64)
	remetenteEmail := os.Getenv("SMTP_USER")

	var input struct {
		Para    string `json:"para"`
		Cc      string `json:"cc"`
		Cco     string `json:"cco"`
		Assunto string `json:"assunto"`
		Corpo   string `json:"corpo"`
	}

	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados de entrada inválidos"})
		return
	}

	// LÀ³gica de envio de e-mail real
	err = services.SendEmail(input.Para, input.Assunto, input.Corpo)
	if err != nil {
		log.Printf("Erro ao enviar e-mail para o processo %d: %v", processoID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao enviar o e-mail"})
		return
	}

	tx, err := database.DB_App.Begin()
	if err != nil {
		log.Printf("Erro ao iniciar transaÀ§ão para salvar e-mail e histÀ³rico: %v", err)
		c.JSON(http.StatusOK, gin.H{"message": "E-mail enviado, mas falha ao registrar no banco."})
		return
	}
	defer tx.Rollback()

	// 1. Salva o e-mail enviado no banco de dados
	_, err = tx.Exec(`
        INSERT INTO FT_EMAILS_PROCESSO 
        (id_processo, id_usuario_remetente, de_email, para_email, cc_email, cco_email, assunto, corpo, tipo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'enviado')`,
		processoID, remetenteID, remetenteEmail,
		input.Para, input.Cc, input.Cco, input.Assunto, input.Corpo,
	)
	if err != nil {
		log.Printf("Erro ao salvar registro do e-mail para o processo %d: %v", processoID, err)
	}

	// 2. Cria um registro no histÀ³rico de movimentaÀ§Àµes (inclui status/etapas atuais)
	comentarioHistorico := fmt.Sprintf("E-mail enviado para %s com o assunto: '%s'", input.Para, input.Assunto)

	var etapaAtual, subAtual sql.NullString
	_ = tx.QueryRow(`
        SELECT e.etapa, p.sub_etapa
          FROM FT_PROCESSOS p
          JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
         WHERE p.id_processo = ?`, processoID).Scan(&etapaAtual, &subAtual)

	etapaTxt := strings.TrimSpace(etapaAtual.String)
	if etapaTxt == "" {
		etapaTxt = "Distribuidora" // fallback sensato
	}
	subTxt := strings.TrimSpace(subAtual.String)
	statusTxt := etapaTxt
	if subTxt != "" {
		statusTxt = statusTxt + " - " + subTxt
	}

	_, err = tx.Exec(`
        INSERT INTO FT_HISTORICO_MOVIMENTACOES
        (id_requisicao, id_usuario_gestor,
         status_anterior, status_novo,
         etapa_anterior, etapa_nova, sub_etapa,
         comentario, data_movimentacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		processoID, remetenteID,
		statusTxt, statusTxt,
		etapaTxt, etapaTxt, subTxt,
		comentarioHistorico, time.Now(),
	)
	if err != nil {
		log.Printf("Erro ao salvar o envio de e-mail no histÀ³rico do processo %d: %v", processoID, err)
	}

	// 3. Finaliza a transaÀ§ão
	if err := tx.Commit(); err != nil {
		log.Printf("Erro ao fazer commit da transaÀ§ão de e-mail e histÀ³rico: %v", err)
	}

	c.JSON(http.StatusOK, gin.H{"message": "E-mail enviado e registrado com sucesso!"})
}

// GetEmailsByProcessoID busca todos os e-mails de um processo.
func GetEmailsByProcessoID(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}

	var emails []models.EmailProcesso
	rows, err := database.DB_App.Query("SELECT id_email, id_processo, de_email, para_email, assunto, corpo, data_envio, tipo FROM FT_EMAILS_PROCESSO WHERE id_processo = ? ORDER BY data_envio DESC", processoID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar e-mails"})
		return
	}
	defer rows.Close()

	for rows.Next() {
		var email models.EmailProcesso
		if err := rows.Scan(&email.ID, &email.ProcessoID, &email.DeEmail, &email.ParaEmail, &email.Assunto, &email.Corpo, &email.DataEnvio, &email.Tipo); err != nil {
			continue
		}
		emails = append(emails, email)
	}

	if emails == nil {
		emails = make([]models.EmailProcesso, 0)
	}

	c.JSON(http.StatusOK, emails)
}
