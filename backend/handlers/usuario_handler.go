package handlers

import (
	"database/sql"
	"log"
	"net/http"
	"strings"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

type usuarioMencao struct {
	ID    int64  `json:"id"`
	Nome  string `json:"nome"`
	Email string `json:"email"`
}

// GET /api/usuarios/mencoes?q=termo
func GetUsuariosMencoes(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	like := "%" + q + "%"

	// usa DM_USUARIO (singular) e nome_usuario / usuario_ativo
	var rows *sql.Rows
	var err error
	if q == "" {
		rows, err = database.DB_App.Query(`
			SELECT id_usuario, nome_usuario, email
			FROM DM_USUARIO
			WHERE usuario_ativo = 1
			ORDER BY nome_usuario ASC
			LIMIT 20`)
	} else {
		rows, err = database.DB_App.Query(`
			SELECT id_usuario, nome_usuario, email
			FROM DM_USUARIO
			WHERE usuario_ativo = 1
			  AND (nome_usuario LIKE ? OR email LIKE ?)
			ORDER BY nome_usuario ASC
			LIMIT 20`, like, like)
	}
	if err != nil {
		log.Printf("GetUsuariosMencoes query error (q=%q): %v", q, err)
		c.JSON(http.StatusOK, []usuarioMencao{}) // não quebra o front
		return
	}
	defer rows.Close()

	lista := make([]usuarioMencao, 0, 20)
	for rows.Next() {
		var u usuarioMencao
		if scanErr := rows.Scan(&u.ID, &u.Nome, &u.Email); scanErr != nil {
			log.Printf("GetUsuariosMencoes scan error: %v", scanErr)
			continue
		}
		lista = append(lista, u)
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		log.Printf("GetUsuariosMencoes rows error: %v", rowsErr)
	}

	c.JSON(http.StatusOK, lista)
}
