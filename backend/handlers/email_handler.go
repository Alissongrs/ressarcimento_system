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

const maxEmailAnexoBytes int64 = 10 * 1024 * 1024

// EnviarEmailProcesso envia um e-mail e registra o evento no banco e no histórico.
// EnviarEmailProcesso godoc
// @Summary      Envia e-mail do processo
// @Tags         EmailProcesso
// @Param        id   path   int  true  "ID do processo"
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      403  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/processos/{id}/emails [post]
func EnviarEmailProcesso(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}

	userID, _ := c.Get("userID")
	remetenteID, _ := userID.(int64)
	remetenteEmailFromUser, err := getUserEmail(remetenteID)
	if err != nil {
		log.Printf("Erro ao buscar e-mail do usuário %d: %v", remetenteID, err)
		c.JSON(http.StatusForbidden, gin.H{"error": "Usuário sem permissão para enviar e-mail"})
		return
	}
	if !isAllowedEmailSender(remetenteEmailFromUser) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Usuário não autorizado a enviar e-mail"})
		return
	}
	remetenteEmail := os.Getenv("MAIL_SENDER")
	if strings.TrimSpace(remetenteEmail) == "" {
		remetenteEmail = os.Getenv("SMTP_USER")
	}

	var input struct {
		Para    string `json:"para"`
		Cc      string `json:"cc"`
		Cco     string `json:"cco"`
		Assunto string `json:"assunto"`
		Corpo   string `json:"corpo"`
	}

	attachments := make([]services.EmailAttachment, 0)
	ct := c.GetHeader("Content-Type")
	if strings.Contains(ct, "multipart/form-data") {
		input.Para = c.PostForm("para")
		input.Cc = c.PostForm("cc")
		input.Cco = c.PostForm("cco")
		input.Assunto = c.PostForm("assunto")
		input.Corpo = c.PostForm("corpo")

		if form, err := c.MultipartForm(); err == nil && form != nil {
			files := form.File["anexos"]
			for _, fh := range files {
				filename, data, mimeType, sizeBytes, err := readAnexoFile(fh)
				if err != nil {
					log.Printf("Erro ao ler anexo %s: %v", fh.Filename, err)
					c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "Arquivo excede o tamanho maximo permitido (10MB)"})
					return
				}
				if sizeBytes > maxEmailAnexoBytes {
					c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "Arquivo excede o tamanho maximo permitido (10MB)"})
					return
				}
				attachments = append(attachments, services.EmailAttachment{
					Name:        filename,
					ContentType: mimeType,
					Data:        data,
				})
			}
		}
	} else {
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Dados de entrada inválidos"})
			return
		}
	}

	// Lógica de envio de e-mail real
	input.Corpo = appendEmailProcessSignature(input.Corpo)
	err = services.SendEmailDetailedWithAttachments(input.Para, input.Cc, input.Cco, input.Assunto, input.Corpo, attachments)
	if err != nil {
		log.Printf("Erro ao enviar e-mail para o processo %d: %v", processoID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao enviar o e-mail"})
		return
	}

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		log.Printf("Erro ao iniciar transação para salvar e-mail e histórico: %v", tx.Error)
		c.JSON(http.StatusOK, gin.H{"message": "E-mail enviado, mas falha ao registrar no banco."})
		return
	}
	defer tx.Rollback()

	// 1. Salva o e-mail enviado no banco de dados
	_, err = execGorm(tx, `
        INSERT INTO FT_EMAILS_PROCESSO 
        (id_processo, id_usuario_remetente, de_email, para_email, cc_email, cco_email, assunto, corpo, tipo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'enviado')`,
		processoID, remetenteID, remetenteEmail,
		input.Para, input.Cc, input.Cco, input.Assunto, input.Corpo,
	)
	if err != nil {
		log.Printf("Erro ao salvar registro do e-mail para o processo %d: %v", processoID, err)
	}

	// 1.1 Salva anexos no banco de arquivos
	for _, a := range attachments {
		if len(a.Data) == 0 {
			continue
		}
		if int64(len(a.Data)) > maxEmailAnexoBytes {
			log.Printf("Anexo excede o tamanho maximo (10MB) para o processo %d: %s", processoID, a.Name)
			continue
		}
		pseudoPath := buildAnexoPath(processoID, 0, a.Name)
		if _, err := execGorm(tx, 
			`INSERT INTO FT_ANEXOS
			  (id_requisicao, nome_arquivo, caminho_arquivo, enviado_por, data_upload, mime_type, tamanho_bytes, arquivo_blob)
			  VALUES (?, ?, ?, ?, NOW(), ?, ?, ?)`,
			processoID, a.Name, pseudoPath, remetenteEmailFromUser, a.ContentType, len(a.Data), a.Data,
		); err != nil {
			log.Printf("Erro ao salvar anexo %s para o processo %d: %v", a.Name, processoID, err)
		}
	}
	// 2. Cria um registro no histórico de movimentações (inclui status/etapas atuais)
	headerHTML := fmt.Sprintf(
		`<p><strong>De:</strong> %s<br><strong>Para:</strong> %s%s<br><strong>Assunto:</strong> %s</p><hr>`,
		remetenteEmailFromUser,
		input.Para,
		func() string {
			if strings.TrimSpace(input.Cc) != "" {
				return "<br><strong>Cc:</strong> " + input.Cc
			}
			return ""
		}(),
		input.Assunto,
	)
	comentarioHistorico := headerHTML + input.Corpo

	var etapaAtual, subAtual sql.NullString
	_ = queryRowGorm(tx, `
        SELECT e.etapa, p.sub_etapa
          FROM FT_PROCESSOS p
          JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
         WHERE p.id_processo = ?`, processoID).Scan(&etapaAtual, &subAtual)

	etapaTxt := strings.TrimSpace(etapaAtual.String)
	if etapaTxt == "" {
		etapaTxt = "Distribuidora" // fallback sensato
	}
	subTxt := strings.TrimSpace(subAtual.String)
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
		processoID, remetenteID,
		statusNome, statusNome,
		etapaTxt, etapaTxt, subTxt,
		comentarioHistorico, time.Now(),
	)
	if err != nil {
		log.Printf("Erro ao salvar o envio de e-mail no histórico do processo %d: %v", processoID, err)
	}

	// 2.1 Regra: se estiver em Distribuidora + "Primeira reclamação da etapa - Em elaboração",
	// ao enviar e-mail, mover para "Primeira reclamação - Aguardando resposta".
	const subEmElaboracao = "Primeira reclamação da etapa - Em elaboração"
	const subAguardando = "Primeira reclamação - Aguardando resposta"
	if strings.EqualFold(strings.TrimSpace(etapaTxt), "Distribuidora") &&
		strings.EqualFold(strings.TrimSpace(subTxt), subEmElaboracao) {
		subID, _ := resolveSubEtapaIDGorm(tx, subAguardando)
		if _, err := execGorm(tx, `
			UPDATE FT_PROCESSOS
			   SET etapa = 'Distribuidora',
			       id_etapa_processo = 1,
			       sub_etapa = ?,
			       id_sub_etapa_processo = ?
			 WHERE id_processo = ?`,
			subAguardando, nullIntToIface(subID), processoID,
		); err != nil {
			log.Printf("Erro ao atualizar subetapa após envio de e-mail (proc %d): %v", processoID, err)
		} else {
			_, _ = execGorm(tx, `
				INSERT INTO FT_HISTORICO_MOVIMENTACOES
				(id_requisicao, id_usuario_gestor,
				 status_anterior, status_novo,
				 etapa_anterior, etapa_nova, sub_etapa,
				 comentario, data_movimentacao)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				processoID, remetenteID,
				"Distribuidora - "+subEmElaboracao, "Distribuidora - "+subAguardando,
				"Distribuidora", "Distribuidora", subAguardando,
				"Sub-etapa movida automaticamente após envio de e-mail",
				time.Now(),
			)
		}
	}

	// 3. Finaliza a transação
	if err := tx.Commit().Error; err != nil {
		log.Printf("Erro ao fazer commit da transação de e-mail e histórico: %v", err)
	}

	c.JSON(http.StatusOK, gin.H{"message": "E-mail enviado e registrado com sucesso!"})
}

func appendEmailProcessSignature(body string) string {
	raw := strings.TrimSpace(body)
	if strings.Contains(raw, "assinatura_complaint.png") {
		return body
	}
	baseURL := strings.TrimSpace(os.Getenv("MAIL_SIGNATURE_URL"))
	if baseURL == "" {
		baseURL = "/assinatura_complaint.png"
	}
	sig := `<br/><br/><img src="` + baseURL + `" alt="assinatura" style="max-width:260px;height:auto;" />`
	if raw == "" {
		return sig
	}
	return body + sig
}

func isAllowedEmailSender(email string) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	allowed := map[string]bool{
		"alisson.rodrigues@amee.com.br": true,
		"luana.nascimento@amee.com.br": true,
		"eliane.araujo@amee.com.br": true,
		"paulo.passos@amee.com.br": true,
		"eduardo.navarro@amee.com.br": true,
	}
	return allowed[email]
}

func getUserEmail(userID int64) (string, error) {
	if userID == 0 {
		return "", fmt.Errorf("userID inválido")
	}
	var email string
	err := queryRowGorm(database.GormDB_App, "SELECT email FROM DM_USUARIO WHERE id_usuario = ?", userID).Scan(&email)
	if err != nil {
		return "", err
	}
	email = strings.TrimSpace(email)
	if email == "" {
		return "", fmt.Errorf("email vazio")
	}
	return email, nil
}

// GetEmailsByProcessoID busca todos os e-mails de um processo.
// GetEmailsByProcessoID godoc
// @Summary      Lista e-mails do processo
// @Tags         EmailProcesso
// @Param        id   path   int  true  "ID do processo"
// @Produce      json
// @Success      200  {array}   map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/processos/{id}/emails [get]
func GetEmailsByProcessoID(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}

	var emails []models.EmailProcesso
	rows, err := queryGorm(database.GormDB_App, `
		SELECT e.id_email, e.id_processo, e.id_usuario_remetente,
		       COALESCE(u.nome_usuario, u.email, '') AS usuario_remetente,
		       e.de_email, e.para_email, e.cc_email, e.cco_email,
		       e.assunto, e.corpo, e.data_envio, e.tipo
		  FROM FT_EMAILS_PROCESSO e
		  LEFT JOIN DM_USUARIO u ON u.id_usuario = e.id_usuario_remetente
		 WHERE e.id_processo = ?
		 ORDER BY e.data_envio DESC`, processoID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar e-mails"})
		return
	}
	defer rows.Close()

	emailIDs := make([]int64, 0)
	for rows.Next() {
		var email models.EmailProcesso
		if err := rows.Scan(
			&email.ID,
			&email.ProcessoID,
			&email.UsuarioRemetenteID,
			&email.UsuarioRemetente,
			&email.DeEmail,
			&email.ParaEmail,
			&email.CcEmail,
			&email.CcoEmail,
			&email.Assunto,
			&email.Corpo,
			&email.DataEnvio,
			&email.Tipo,
		); err != nil {
			continue
		}
		emails = append(emails, email)
		emailIDs = append(emailIDs, email.ID)
	}

	if emails == nil {
		emails = make([]models.EmailProcesso, 0)
	}

	if len(emailIDs) > 0 {
		readByMap := lookupProcessoEmailReads(emailIDs)
		for i := range emails {
			if users, ok := readByMap[emails[i].ID]; ok {
				emails[i].ReadBy = users
			}
		}
	}

	c.JSON(http.StatusOK, emails)
}

// POST /api/v1/processos/:id/emails/:emailId/read
// MarkEmailProcessoRead godoc
// @Summary      Marca e-mail do processo como lido (usuário atual)
// @Tags         EmailProcesso
// @Param        id       path   int  true  "ID do processo"
// @Param        emailId  path   int  true  "ID do e-mail"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/processos/{id}/emails/{emailId}/read [post]
func MarkEmailProcessoRead(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}
	emailID, err := strconv.Atoi(c.Param("emailId"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do e-mail inválido"})
		return
	}
	userIDAny, _ := c.Get("userID")
	userID, _ := userIDAny.(int64)
	if userID <= 0 {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return
	}

	var exists int
	if err := queryRowGorm(database.GormDB_App, 
		`SELECT COUNT(1) FROM FT_EMAILS_PROCESSO WHERE id_email = ? AND id_processo = ?`,
		emailID, processoID,
	).Scan(&exists); err != nil || exists == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "E-mail não encontrado para este processo"})
		return
	}

	if _, err := execGorm(database.GormDB_App, 
		`INSERT INTO FT_EMAILS_LEITURAS (id_email, id_usuario, data_leitura)
		 VALUES (?, ?, NOW())
		 ON DUPLICATE KEY UPDATE data_leitura = VALUES(data_leitura)`,
		emailID, userID,
	); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao marcar leitura"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func lookupProcessoEmailReads(emailIDs []int64) map[int64][]string {
	out := map[int64][]string{}
	if len(emailIDs) == 0 {
		return out
	}
	placeholders := strings.Repeat("?,", len(emailIDs))
	placeholders = strings.TrimSuffix(placeholders, ",")
	args := make([]any, 0, len(emailIDs))
	for _, id := range emailIDs {
		args = append(args, id)
	}
	query := fmt.Sprintf(`
		SELECT l.id_email, COALESCE(u.nome_usuario, u.email, '') AS nome
		  FROM FT_EMAILS_LEITURAS l
		  LEFT JOIN DM_USUARIO u ON u.id_usuario = l.id_usuario
		 WHERE l.id_email IN (%s)
		 ORDER BY l.data_leitura ASC`, placeholders)
	rows, err := queryGorm(database.GormDB_App, query, args...)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var nome string
		if err := rows.Scan(&id, &nome); err != nil {
			continue
		}
		nome = strings.TrimSpace(nome)
		if nome == "" {
			nome = "Usuário"
		}
		out[id] = append(out[id], nome)
	}
	return out
}









