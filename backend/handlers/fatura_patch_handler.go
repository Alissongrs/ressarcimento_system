package handlers

import (
	"database/sql"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// Whitelist de campos que o analista pode corrigir a mão no modal de Auditoria.
// Qualquer outra coluna é rejeitada — não mexemos em campos técnicos (uid, extração
// raw, etc) sem uma via muito mais controlada.
//
// Tipo: "string" | "number" | "date" (YYYY-MM-DD)
var patchWhitelist = map[string]string{
	// Identificação
	"distribuidora":              "string",
	"grupo_tarifario":            "string",
	"subgrupo_tarifario":         "string",
	"modalidade_tarifaria":       "string",
	"classe_consumidor":          "string",
	"razao_social":               "string",
	"nome_cliente":               "string",
	"endereco_uc":                "string",
	"cep_uc":                     "string",
	"cnpj_distribuidora_filial":  "string",
	"uf_distribuidora":           "string",

	// Consumos (kWh)
	"consumo_ativo_ponta_kwh":     "number",
	"consumo_ativo_fponta_kwh":    "number",
	"consumo_ativo_reservado_kwh": "number",
	"kwh_total":                   "number",

	// Datas
	"mes_referencia":         "date",
	"data_leitura_anterior":  "date",
	"data_leitura_atual":     "date",

	// Fatura
	"valor_total_fatura": "number",
	"numero_fatura":      "string",
	"numero_medidor":     "string",
}

type fdePatchRequest struct {
	Campos map[string]interface{} `json:"campos"`
	Motivo string                 `json:"motivo"`
}

// PatchFatura — PATCH /api/v1/faturas/:id
//
// Corrige a mão campos da FATURA_DADOS_EXTRAIDOS. Toda alteração é gravada em
// FT_AUDIT_EDICAO (uma linha por campo alterado) com o usuário autor + motivo.
func PatchFatura(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}

	var req fdePatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido: " + err.Error()})
		return
	}
	if len(req.Campos) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nenhum campo para atualizar"})
		return
	}

	// Rejeita campos fora da whitelist antes de tocar no banco.
	campos := map[string]interface{}{}
	for k, v := range req.Campos {
		if _, ok := patchWhitelist[k]; !ok {
			c.JSON(http.StatusForbidden, gin.H{"error": "campo não editável: " + k})
			return
		}
		campos[k] = v
	}

	if database.DB_App == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}

	// Autor da edição (id do usuário logado, se disponível).
	var idUsuario sql.NullInt64
	if v, exists := c.Get("user_id"); exists {
		if n, ok := v.(int); ok && n > 0 {
			idUsuario = sql.NullInt64{Int64: int64(n), Valid: true}
		} else if n64, ok := v.(int64); ok && n64 > 0 {
			idUsuario = sql.NullInt64{Int64: n64, Valid: true}
		} else if s, ok := v.(string); ok {
			if n, err := strconv.ParseInt(s, 10, 64); err == nil && n > 0 {
				idUsuario = sql.NullInt64{Int64: n, Valid: true}
			}
		}
	}

	// Lê valores atuais dos campos que vão mudar.
	cols := make([]string, 0, len(campos))
	for k := range campos {
		cols = append(cols, "`"+k+"`")
	}
	selectSQL := fmt.Sprintf("SELECT %s FROM FATURA_DADOS_EXTRAIDOS WHERE id = ?", strings.Join(cols, ", "))
	row := database.DB_App.QueryRow(selectSQL, id)
	dest := make([]interface{}, len(campos))
	destPtrs := make([]interface{}, len(campos))
	keysOrdered := make([]string, 0, len(campos))
	for k := range campos {
		keysOrdered = append(keysOrdered, k)
	}
	for i := range dest {
		var v sql.NullString
		dest[i] = &v
		destPtrs[i] = &v
	}
	if err := row.Scan(destPtrs...); err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "fatura não encontrada"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	valorAnterior := map[string]string{}
	for i, k := range keysOrdered {
		if ns, ok := destPtrs[i].(*sql.NullString); ok && ns.Valid {
			valorAnterior[k] = ns.String
		} else {
			valorAnterior[k] = ""
		}
	}

	// Aplica UPDATE + auditoria em transação.
	tx, err := database.DB_App.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer func() { _ = tx.Rollback() }()

	setParts := make([]string, 0, len(campos))
	setArgs := make([]interface{}, 0, len(campos))
	for _, k := range keysOrdered {
		setParts = append(setParts, "`"+k+"` = ?")
		setArgs = append(setArgs, campos[k])
	}
	setArgs = append(setArgs, id)
	updateSQL := "UPDATE FATURA_DADOS_EXTRAIDOS SET " + strings.Join(setParts, ", ") + " WHERE id = ?"
	if _, err := tx.Exec(updateSQL, setArgs...); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "update: " + err.Error()})
		return
	}

	// Auditoria — 1 INSERT por campo, ignorando quando o valor não mudou.
	alteracoes := 0
	for _, k := range keysOrdered {
		novo := fmt.Sprintf("%v", campos[k])
		antigo := valorAnterior[k]
		if novo == antigo {
			continue
		}
		if _, err := tx.Exec(`
INSERT INTO FT_AUDIT_EDICAO (entidade, id_entidade, campo, valor_anterior, valor_novo, observacao, id_usuario)
VALUES ('FATURA_DADOS_EXTRAIDOS', ?, ?, ?, ?, ?, ?)`,
			id, k, antigo, novo, req.Motivo, idUsuario); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "audit: " + err.Error()})
			return
		}
		alteracoes++
	}

	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "commit: " + err.Error()})
		return
	}

	// Correção manual altera consumo/valor → recalcula o motor na próxima carga.
	InvalidarMotorCache()

	c.JSON(http.StatusOK, gin.H{
		"ok":             true,
		"id":             id,
		"alteracoes":     alteracoes,
		"valores_antes":  valorAnterior,
		"valores_depois": campos,
	})
}
