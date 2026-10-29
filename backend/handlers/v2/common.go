// Package v2 contém os handlers HTTP para a UI v2 de Controle de Processos.
// Esses endpoints leem/escrevem no banco refatorado db_ressarcimento_v2 (via database.DB_V2)
// — totalmente isolados do banco produtivo (database.DB_App).
//
// Convenções:
//   - Response shape obedece o contrato em protótipos/banco_novo_local/API_V2_CONTRATO.md
//   - Erros padronizados via apiError() — {error: {code, message, details}}
//   - Todo handler deve chamar requireDB() na entrada — retorna 503 se DB_V2 não inicializou
package v2

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// ─── DB helpers ─────────────────────────────────────────────────────────────

// requireDB devolve a conexão DB_V2 ou aborta a requisição com 503 se não estiver disponível.
func requireDB(c *gin.Context) *sql.DB {
	db := database.DB_V2
	if db == nil {
		apiError(c, http.StatusServiceUnavailable, "DB_V2_INDISPONIVEL",
			"Banco v2 não está conectado. Configure DB_APP_URL no .env e reinicie.", nil)
		return nil
	}
	return db
}

// ─── Erro padronizado ──────────────────────────────────────────────────────

type apiErrPayload struct {
	Code    string      `json:"code"`
	Message string      `json:"message"`
	Details interface{} `json:"details,omitempty"`
}

func apiError(c *gin.Context, status int, code, message string, details interface{}) {
	c.AbortWithStatusJSON(status, gin.H{
		"error": apiErrPayload{Code: code, Message: message, Details: details},
	})
}

// ─── Parsers de query ──────────────────────────────────────────────────────

// queryInt lê ?key=N. Retorna 0 se ausente/inválido.
func queryInt(c *gin.Context, key string) int {
	v := c.Query(key)
	if v == "" {
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0
	}
	return n
}

// queryIntList lê ?key=1,2,3 (CSV) ou múltiplos ?key=1&key=2.
// Retorna lista deduplicada e ordenada estavelmente (mantém ordem do input).
func queryIntList(c *gin.Context, key string) []int {
	raw := c.QueryArray(key) // ?key=1&key=2 → ["1","2"]
	if v := c.Query(key); v != "" && len(raw) == 1 {
		raw = []string{v} // pega ?key=1,2,3 (CSV) — vamos splitar abaixo
	}
	seen := map[int]bool{}
	out := []int{}
	for _, item := range raw {
		for _, tok := range splitCSV(item) {
			n, err := strconv.Atoi(tok)
			if err != nil || n <= 0 || seen[n] {
				continue
			}
			seen[n] = true
			out = append(out, n)
		}
	}
	return out
}

// splitCSV divide "1,2, 3" em ["1","2","3"], trim em cada item.
func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := []string{}
	cur := ""
	for _, r := range s {
		if r == ',' {
			if t := trimSpace(cur); t != "" {
				parts = append(parts, t)
			}
			cur = ""
		} else {
			cur += string(r)
		}
	}
	if t := trimSpace(cur); t != "" {
		parts = append(parts, t)
	}
	return parts
}

func trimSpace(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}

// queryBool lê ?key=true. Retorna (valor, definida).
func queryBool(c *gin.Context, key string) (bool, bool) {
	v := c.Query(key)
	if v == "" {
		return false, false
	}
	switch v {
	case "1", "true", "TRUE", "True", "t":
		return true, true
	case "0", "false", "FALSE", "False", "f":
		return false, true
	}
	return false, false
}

// pathInt lê :key. Retorna (n, ok=false) se inválido (e já escreve 400 no response).
func pathInt(c *gin.Context, key string) (int, bool) {
	raw := c.Param(key)
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		apiError(c, http.StatusBadRequest, "ID_INVALIDO",
			"Parâmetro :"+key+" deve ser inteiro positivo", gin.H{"raw": raw})
		return 0, false
	}
	return n, true
}

// ─── Tipos base de resposta (referência cruzada de dimensões) ──────────────

// RefID encapsula um par id+nome para FKs (ex: etapa, instância, status).
type RefID struct {
	ID   int    `json:"id"`
	Nome string `json:"nome"`
}

// nilableRef devolve *RefID ou nil quando id for 0/NULL.
func nilableRef(id int, nome string) *RefID {
	if id == 0 {
		return nil
	}
	return &RefID{ID: id, Nome: nome}
}
