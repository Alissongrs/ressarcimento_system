package handlers

// Validação comparativa — o analista escolhe qual fonte (FDE/SGE/IA) tem o valor
// correto para cada campo. As decisões viram UPDATE direto na FATURA_DADOS_EXTRAIDOS
// (a "verdade" oficial passa a ser o que o analista validou) + INSERT em
// FATURA_REANALISES pro audit trail (quem, quando, com que valores).
//
//   POST /api/v1/faturas/:id/validar-comparativo
//     body: {
//       "campos_validados": [
//         {"campo":"consumo_ativo_fponta_kwh","valor_escolhido":22922,"fonte":"SGE"},
//         {"campo":"valor_total_fatura","valor_escolhido":8088.69,"fonte":"FDE"},
//         {"campo":"numero_medidor","valor_escolhido":"ABC12345","fonte":"MANUAL"}
//       ],
//       "observacao": "conferido no PDF; consumo real 22922"
//     }

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// camposValidaveis — whitelist de colunas que o endpoint pode escrever na FDE.
// Cada entrada: (coluna real, tipo aceito). Bloqueia SQL injection e limita o
// escopo do update ao que aparece no modal comparativo.
var camposValidaveis = map[string]string{
	"consumo_ativo_ponta_kwh":     "num",
	"consumo_ativo_fponta_kwh":    "num",
	"consumo_ativo_reservado_kwh": "num",
	"valor_total_fatura":          "num",
	"icms_valor":                  "num",
	"pis_valor":                   "num",
	"cofins_valor":                "num",
	"modalidade_tarifaria":        "str",
	"numero_medidor":              "str",
	// Nota: tp_tensao não existe direto — pipeline usa "grupo_tarifario"/"subgrupo_tarifario".
	// Adicionar aqui depois de mapear (fica de fora do V1).
}

type campoValidado struct {
	Campo          string      `json:"campo"`
	ValorEscolhido interface{} `json:"valor_escolhido"`
	Fonte          string      `json:"fonte"` // "FDE" | "SGE" | "IA" | "MANUAL"
}

type reqValidarComparativo struct {
	CamposValidados []campoValidado `json:"campos_validados"`
	Observacao      string          `json:"observacao"`
}

// ValidarComparativoFatura — POST /api/v1/faturas/:id/validar-comparativo
func ValidarComparativoFatura(c *gin.Context) {
	id := c.Param("id")
	if _, err := strconv.ParseInt(id, 10, 64); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}
	var body reqValidarComparativo
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido: " + err.Error()})
		return
	}
	if len(body.CamposValidados) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nenhum campo enviado"})
		return
	}
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha na conexão"})
		return
	}

	// Filtra apenas campos da whitelist. Ignora silenciosamente os fora do escopo.
	sets := []string{}
	args := []interface{}{}
	aceitos := []campoValidado{}
	for _, cv := range body.CamposValidados {
		tipo, ok := camposValidaveis[cv.Campo]
		if !ok {
			continue
		}
		var arg interface{}
		if tipo == "num" {
			f, ok := paraFloatCV(cv.ValorEscolhido)
			if !ok {
				continue
			}
			arg = f
		} else {
			s := strings.TrimSpace(fmt.Sprintf("%v", cv.ValorEscolhido))
			if s == "" || s == "<nil>" {
				continue
			}
			arg = s
		}
		// SEGURO: cv.Campo é chave do map camposValidaveis (whitelist estático,
		// sem input do usuário chegar direto no SQL).
		sets = append(sets, "`"+cv.Campo+"` = ?")
		args = append(args, arg)
		aceitos = append(aceitos, campoValidado{Campo: cv.Campo, ValorEscolhido: arg, Fonte: cv.Fonte})
	}
	if len(sets) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nenhum campo válido pra atualizar"})
		return
	}

	// 1. UPDATE na FDE
	tx, err := sqlDB.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao iniciar transação"})
		return
	}
	defer func() { _ = tx.Rollback() }()

	q := "UPDATE FATURA_DADOS_EXTRAIDOS SET " + strings.Join(sets, ", ") + " WHERE id = ?"
	args = append(args, id)
	res, err := tx.Exec(q, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro no UPDATE: " + err.Error()})
		return
	}
	afetadas, _ := res.RowsAffected()
	if afetadas == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "fatura não encontrada"})
		return
	}

	// 2. audit trail em FATURA_REANALISES
	uid, uname := usuarioIA(c)
	auditPayload := map[string]interface{}{
		"campos_validados": aceitos,
		"observacao":       body.Observacao,
		"data":             time.Now().Format(time.RFC3339),
	}
	auditJSON, _ := json.Marshal(auditPayload)
	_, _ = tx.Exec(`INSERT INTO FATURA_REANALISES
		(fatura_id, modelo, justificativa, recomendacao, resposta_crua, confianca_final, pdf_anexado, usuario_id, usuario_nome, criado_em)
		VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NOW())`,
		id, "validacao_comparativa", truncarIA(string(auditJSON), 4000),
		"VALIDADO_MANUAL", truncarIA(string(auditJSON), 8000), 95, uid, uname)

	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro no commit: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"ok":               true,
		"campos_aplicados": len(aceitos),
		"linhas_afetadas":  afetadas,
	})
}

func paraFloatCV(v interface{}) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case string:
		s := strings.TrimSpace(x)
		s = strings.ReplaceAll(s, "R$", "")
		s = strings.ReplaceAll(s, " ", "")
		s = strings.ReplaceAll(s, ".", "")
		s = strings.ReplaceAll(s, ",", ".")
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return 0, false
		}
		return f, true
	}
	// prevent unused import warning
	_ = sql.ErrNoRows
	return 0, false
}
