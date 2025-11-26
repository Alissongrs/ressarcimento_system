package handlers

import (
	"log"
	"net/http"
	"ressarcimento-backend/database"
	"ressarcimento-backend/models" // Usaremos o model de Departamento

	"github.com/gin-gonic/gin"
)

// Departamento é a struct para o retorno JSON.
// Ela é definida aqui e não em 'models'
type Departamento struct {
	ID   int64  `json:"id_departamento"`
	Nome string `json:"nome"`
}

// GetDepartamentos busca e retorna a lista de todos os departamentos.
func GetDepartamentos(c *gin.Context) {
	var departamentos []models.Departamento
	rows, err := database.DB_App.Query("SELECT id_departamento, nome FROM DM_DEPARTAMENTO ORDER BY nome ASC")
	if err != nil {
		log.Printf("Erro ao buscar departamentos: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar departamentos"})
		return
	}
	defer rows.Close()

	for rows.Next() {
		var d models.Departamento
		if err := rows.Scan(&d.ID, &d.Nome); err != nil {
			log.Printf("Erro ao escanear departamento: %v", err)
			continue
		}
		departamentos = append(departamentos, d)
	}

	if len(departamentos) == 0 {
		// Retorna um array vazio em vez de nulo para consistência no frontend
		c.JSON(http.StatusOK, []models.Departamento{})
		return
	}

	c.JSON(http.StatusOK, departamentos)
}
