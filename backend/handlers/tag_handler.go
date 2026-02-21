package handlers

import (
	"database/sql"
	"log"
	"net/http"
	"ressarcimento-backend/database"
	"ressarcimento-backend/models"
	"strconv"

	"github.com/gin-gonic/gin"
)

// CreateTag cria uma nova tag, verificando se ela já existe.
// CreateTag godoc
// @Summary      Cria tag
// @Tags         Tags
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/tags [post]
func CreateTag(c *gin.Context) {
	var newTag models.Tag
	if err := c.ShouldBindJSON(&newTag); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Corpo da requisiÃ§ão inválido"})
		return
	}

	if newTag.Nome == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "O nome da tag é obrigatório"})
		return
	}

	var existenteID int
	err := queryRowGorm(database.GormDB_App, "SELECT id_tag FROM DM_TAGS WHERE nome = ?", newTag.Nome).Scan(&existenteID)

	if err != sql.ErrNoRows {
		c.JSON(http.StatusConflict, gin.H{"error": "A tag '" + newTag.Nome + "' já existe."})
		return
	}

	query := "INSERT INTO DM_TAGS (nome, cor) VALUES (?, ?)"
	result, err := execGorm(database.GormDB_App, query, newTag.Nome, newTag.Cor)
	if err != nil {
		log.Printf("Erro ao criar a tag no banco: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro interno ao criar a tag"})
		return
	}

	id, err := result.LastInsertId()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao obter ID da nova tag"})
		return
	}

	newTag.ID = id
	c.JSON(http.StatusCreated, newTag)
}

// GetAllTags busca todas as tags disponíveis.
// GetAllTags godoc
// @Summary      Lista tags
// @Tags         Tags
// @Produce      json
// @Success      200  {array}   map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/tags [get]
func GetAllTags(c *gin.Context) {
	var tags []models.Tag
	query := "SELECT id_tag, nome, cor FROM DM_TAGS ORDER BY nome ASC"

	rows, err := queryGorm(database.GormDB_App, query)
	if err != nil {
		log.Printf("ERRO AO EXECUTAR CONSULTA DE TAGS: %v", err)
		// Fallback em dev: retorna lista vazia
		c.JSON(http.StatusOK, []models.Tag{})
		return
	}
	defer rows.Close()

	for rows.Next() {
		var tag models.Tag
		if err := rows.Scan(&tag.ID, &tag.Nome, &tag.Cor); err != nil {
			log.Printf("Erro ao escanear tag: %v", err)
			continue
		}
		tags = append(tags, tag)
	}

	if tags == nil {
		tags = make([]models.Tag, 0)
	}

	c.JSON(http.StatusOK, tags)
}

// UpdateProcessoTags atualiza as tags de um processo.
// UpdateProcessoTags godoc
// @Summary      Atualiza tags do processo
// @Tags         Tags
// @Param        id   path   int  true  "ID do processo"
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/processos/{id}/tags [put]
func UpdateProcessoTags(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}

	var tagIDs []int
	if err := c.ShouldBindJSON(&tagIDs); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Corpo da requisiÃ§ão inválido, esperando um array de IDs"})
		return
	}

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao iniciar transação"})
		return
	}
	defer tx.Rollback()

	if _, err := execGorm(tx, "DELETE FROM FT_PROCESSO_TAGS WHERE id_processo = ?", processoID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao limpar tags antigas"})
		return
	}

	if len(tagIDs) > 0 {
		for _, tagID := range tagIDs {
			if _, err := execGorm(tx, "INSERT INTO FT_PROCESSO_TAGS (id_processo, id_tag) VALUES (?, ?)", processoID, tagID); err != nil {
				log.Printf("Erro ao associar tag %d ao processo %d: %v", tagID, processoID, err)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao associar nova tag. Verifique se todas as tags existem."})
				return
			}
		}
	}

	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao finalizar a transaÃ§ão"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Tags atualizadas com sucesso!"})
}

