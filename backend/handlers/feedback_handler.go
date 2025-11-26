package handlers

import (
	"net/http"
	"strings"

	"ressarcimento-backend/database"
	"ressarcimento-backend/sse"

	"github.com/gin-gonic/gin"
)

type feedbackIn struct {
	Mensagem string `json:"mensagem"`
}

// POST /api/feedback
// Requer usuário autenticado; gestores e admins usarão via UI.
func CreateFeedback(c *gin.Context) {
	var uid int64
	if v, ok := c.Get("userID"); ok {
		if id, ok2 := v.(int64); ok2 {
			uid = id
		}
	}
	if uid == 0 {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "não autenticado"})
		return
	}

	var in feedbackIn
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
		return
	}
	msg := strings.TrimSpace(in.Mensagem)
	if msg == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "mensagem vazia"})
		return
	}

	if _, err := database.DB_App.Exec(`INSERT INTO FEEDBACKS (id_usuario, mensagem) VALUES (?, ?)`, uid, msg); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao salvar feedback"})
		return
	}

	// Notifica administradores via ALERTAS (sino) e SSE
	// 1) Seleciona admins ativos
	rows, err := database.DB_App.Query(`SELECT id_usuario FROM DM_USUARIO WHERE usuario_ativo = TRUE AND perfil = 'admin'`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var adminID int64
			if err := rows.Scan(&adminID); err != nil {
				continue
			}
			// 2) Insere um alerta para cada admin
			_, _ = database.DB_App.Exec("INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, acknowledged, data_criacao, data_alerta) VALUES (?, NULL, ?, 0, 0, NOW(), NULL)", adminID, "Novo feedback recebido")
			// 3) Atualiza contagem e emite evento de novo alerta para o sino
			notifyUnread(adminID)
			sse.BroadcastUser(adminID, sse.Event{
				Type:    "alerta_novo",
				Payload: gin.H{"from_user": uid},
			})
		}
	}

	c.JSON(http.StatusCreated, gin.H{"ok": true})
}

type feedbackDTO struct {
	ID        int64  `json:"id_feedback"`
	UsuarioID int64  `json:"id_usuario"`
	Usuario   string `json:"usuario_nome"`
	Mensagem  string `json:"mensagem"`
	Quando    string `json:"created_at"`
}

// GET /api/admin/feedbacks
// Apenas admins. Lista feedbacks recentes com nome do usuário.
func ListFeedbacks(c *gin.Context) {
	rows, err := database.DB_App.Query(`
        SELECT f.id_feedback, f.id_usuario, COALESCE(u.nome_usuario,''), f.mensagem,
               DATE_FORMAT(f.created_at, '%Y-%m-%d %H:%i:%s')
        FROM FEEDBACKS f
        LEFT JOIN DM_USUARIO u ON u.id_usuario = f.id_usuario
        ORDER BY f.created_at DESC, f.id_feedback DESC
        LIMIT 500`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao listar feedbacks"})
		return
	}
	defer rows.Close()

	var out []feedbackDTO
	for rows.Next() {
		var it feedbackDTO
		if err := rows.Scan(&it.ID, &it.UsuarioID, &it.Usuario, &it.Mensagem, &it.Quando); err == nil {
			out = append(out, it)
		}
	}
	if out == nil {
		out = []feedbackDTO{}
	}
	c.JSON(http.StatusOK, out)
}
