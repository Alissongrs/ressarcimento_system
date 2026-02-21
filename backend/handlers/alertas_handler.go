package handlers

import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

type alertaDTO struct {
	ID          int64      `json:"id_alerta"`
	ProcessoID  *int64     `json:"id_processo,omitempty"`
	Mensagem    string     `json:"mensagem"`
	Lido        bool       `json:"lido"`
	Ack         bool       `json:"acknowledged"`
	DataCriacao time.Time  `json:"data_criacao"`
	DataAlerta  *time.Time `json:"data_alerta,omitempty"`
}

// GET /api/alertas?overdue=1&unread=1
// @Summary Listar alertas
// @Tags Alertas
// @Produce json
// @Param overdue query bool false "Somente vencidos"
// @Param unread query bool false "Somente nao lidos"
// @Param due query string false "Filtro por data (today|tomorrow|yesterday)"
// @Success 200 {array} alertaDTO
// @Failure 401 {object} map[string]string
// @Router /api/v1/alertas [get]
func GetAlertas(c *gin.Context) {
	userIDVal, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return
	}
	userID, _ := userIDVal.(int64)

	var (
		where  = []string{"id_usuario = ?"}
		args   = []interface{}{userID}
		overdu = strings.TrimSpace(c.Query("overdue")) == "1"
		unread = strings.TrimSpace(c.Query("unread")) == "1"
		due    = strings.ToLower(strings.TrimSpace(c.Query("due"))) // today|tomorrow|yesterday
	)

	if due != "" {
		switch due {
		case "today":
			where = append(where, "data_alerta IS NOT NULL AND DATE(data_alerta) = CURDATE()")
		case "tomorrow":
			where = append(where, "data_alerta IS NOT NULL AND DATE(data_alerta) = DATE_ADD(CURDATE(), INTERVAL 1 DAY)")
		case "yesterday":
			where = append(where, "data_alerta IS NOT NULL AND DATE(data_alerta) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)")
		default:
			// ignora valor inválido
		}
	} else if overdu {
		where = append(where, "data_alerta IS NOT NULL AND data_alerta < CURDATE() AND lido = 0")
	}
	if unread {
		where = append(where, "lido = 0")
	}

	q := `
		SELECT id_alerta, id_processo, mensagem, lido, acknowledged, data_criacao, data_alerta
		  FROM FT_ALERTAS
		 WHERE ` + strings.Join(where, " AND ") + `
		 ORDER BY 
		   CASE WHEN data_alerta IS NULL THEN 1 ELSE 0 END,
		   data_alerta ASC, data_criacao DESC`

	rows, err := queryGorm(database.GormDB_App, q, args...)
	if err != nil {
		// Fallback em dev: retorna lista vazia
		c.JSON(http.StatusOK, []alertaDTO{})
		return
	}
	defer rows.Close()

	var out []alertaDTO
	for rows.Next() {
		var (
			id, procID sql.NullInt64
			msg        sql.NullString
			lido, ack  sql.NullBool
			criacao    time.Time
			dtA        sql.NullTime
		)
		if err := rows.Scan(&id, &procID, &msg, &lido, &ack, &criacao, &dtA); err != nil {
			continue
		}
		item := alertaDTO{
			ID:          id.Int64,
			Mensagem:    strings.TrimSpace(msg.String),
			Lido:        lido.Bool,
			Ack:         ack.Bool,
			DataCriacao: criacao,
		}
		if procID.Valid {
			v := procID.Int64
			item.ProcessoID = &v
		}
		if dtA.Valid {
			t := dtA.Time
			item.DataAlerta = &t
		}
		out = append(out, item)
	}
	if out == nil {
		out = []alertaDTO{}
	}
	c.JSON(http.StatusOK, out)
}

// POST /api/alertas  { mensagem, data_alerta (YYYY-MM-DD opcional), id_processo (opcional) }
// @Summary Criar alerta
// @Tags Alertas
// @Accept json
// @Produce json
// @Param body body map[string]any true "Dados do alerta"
// @Success 201 {object} map[string]string
// @Failure 400 {object} map[string]string
// @Failure 401 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/alertas [post]
func CreateAlerta(c *gin.Context) {
	userIDVal, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return
	}
	userID, _ := userIDVal.(int64)

	var body struct {
		Mensagem   string  `json:"mensagem"`
		DataAlerta *string `json:"data_alerta"` // YYYY-MM-DD
		ProcID     *int64  `json:"id_processo"` // opcional
	}
	if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.Mensagem) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Corpo inválido (mensagem é obrigatória)."})
		return
	}

	var driverData interface{}
	if body.DataAlerta != nil && strings.TrimSpace(*body.DataAlerta) != "" {
		val := strings.TrimSpace(*body.DataAlerta)
		// aceita YYYY-MM-DD
		if _, err := time.Parse("2006-01-02", val); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "data_alerta inválida"})
			return
		}
		driverData = val
	}

	_, err := execGorm(database.GormDB_App, `
		INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, acknowledged, data_criacao, data_alerta)
		VALUES (?, ?, ?, 0, 0, NOW(), ?)`,
		userID, body.ProcID, strings.TrimSpace(body.Mensagem), driverData,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao criar alerta"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"message": "Alerta criado"})
}

// PUT /api/alertas/:id  { mensagem?, data_alerta?, lido?, acknowledged? }
// @Summary Atualizar alerta
// @Tags Alertas
// @Accept json
// @Produce json
// @Param id path string true "ID do alerta"
// @Param body body map[string]any true "Campos do alerta"
// @Success 200 {object} map[string]string
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/alertas/{id} [put]
func UpdateAlerta(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID inválido"})
		return
	}
	var body struct {
		Mensagem     *string `json:"mensagem"`
		DataAlerta   *string `json:"data_alerta"`
		Lido         *bool   `json:"lido"`
		Acknowledged *bool   `json:"acknowledged"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Corpo inválido"})
		return
	}

	set := []string{}
	args := []interface{}{}

	if body.Mensagem != nil {
		set = append(set, "mensagem = ?")
		args = append(args, strings.TrimSpace(*body.Mensagem))
	}
	if body.DataAlerta != nil {
		val := strings.TrimSpace(*body.DataAlerta)
		if val == "" {
			set = append(set, "data_alerta = NULL")
		} else {
			if _, err := time.Parse("2006-01-02", val); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "data_alerta inválida"})
				return
			}
			set = append(set, "data_alerta = ?")
			args = append(args, val)
		}
	}
	if body.Lido != nil {
		set = append(set, "lido = ?")
		args = append(args, *body.Lido)
	}
	if body.Acknowledged != nil {
		set = append(set, "acknowledged = ?")
		args = append(args, *body.Acknowledged)
	}

	if len(set) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Nada para atualizar"})
		return
	}

	args = append(args, id)
	q := `UPDATE FT_ALERTAS SET ` + strings.Join(set, ", ") + ` WHERE id_alerta = ?`
	if _, err := execGorm(database.GormDB_App, q, args...); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar alerta"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Alerta atualizado"})
}

// POST /api/alertas/ack  { alerta_ids: [ ... ] }
// @Summary Confirmar alertas
// @Tags Alertas
// @Accept json
// @Produce json
// @Param body body map[string][]int true "IDs dos alertas"
// @Success 200 {object} map[string]string
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/alertas/ack [post]
func AckAlertas(c *gin.Context) {
	var body struct {
		AlertaIDs []int `json:"alerta_ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.AlertaIDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "alerta_ids obrigatório"})
		return
	}
	args := make([]interface{}, len(body.AlertaIDs))
	for i, id := range body.AlertaIDs {
		args[i] = id
	}
	q := "UPDATE FT_ALERTAS SET acknowledged = 1 WHERE id_alerta IN (" + strings.Repeat("?,", len(args)-1) + "?)"
	if _, err := execGorm(database.GormDB_App, q, args...); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao confirmar alertas"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Alertas confirmados"})
}

