// handlers/deferimento_handler.go
package handlers

//
// ATENÇÀO: Este ficheiro está obsoleto e causa erros de compilação.
// A sua lógica foi movida para o ficheiro 'processo_handler.go'.
// Comentei todo o código para resolver o erro. Recomendo que apague este ficheiro do seu projeto.
//

/*
	import (
		"net/http"
		"ressarcimento-backend/database"
		"ressarcimento-backend/models"
		"strconv"

		"github.com/gin-gonic/gin"
	)

	func SalvarDeferimento(c *gin.Context) {
		processoID, err := strconv.Atoi(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
			return
		}

		var input models.Deferimento
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Dados de entrada inválidos: " + err.Error()})
			return
		}

		query := `
			INSERT INTO Deferimentos (processo_id, status_analise, data_procedencia, credito_simples, credito_dobro, precisa_contestacao, observacoes)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE
			status_analise = VALUES(status_analise), data_procedencia = VALUES(data_procedencia), credito_simples = VALUES(credito_simples),
			credito_dobro = VALUES(credito_dobro), precisa_contestacao = VALUES(precisa_contestacao), observacoes = VALUES(observacoes)
		`
		_, err = database.DB_App.Exec(query, processoID, input.StatusAnalise, input.DataProcedencia, input.CreditoSimples, input.CreditoDobro, input.PrecisaContestacao, input.Observacoes)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar o deferimento: " + err.Error()})
			return
		}

		gestorNome, _ := c.Get("userName")
		_, err = database.DB_App.Exec(`
			INSERT INTO Historico_Movimentacoes (requisicao_id, nome_gestor, comentario)
			VALUES (?, ?, ?)`,
			processoID, gestorNome, "Detalhes do deferimento foram salvos/atualizados.",
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao registrar o deferimento no histórico: " + err.Error()})
			return
		}

		c.JSON(http.StatusOK, gin.H{"message": "Deferimento salvo com sucesso!"})
	}
*/
