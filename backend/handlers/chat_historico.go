package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// ============================================================================
// Histórico do chat de PERGUNTAS (Q&A com a SURE) por usuário, no servidor.
// Guarda a transcrição como um blob JSON por usuário (1 linha), para o chat voltar
// em qualquer dispositivo. NÃO confundir com FT_SOLICITACOES (pedidos #sistema, que
// já são duráveis) nem com FT_SOLICITACOES_MSGS (thread de correção de um pedido).
// ============================================================================

const (
	chatMaxMsgs  = 200     // guarda só as últimas N mensagens
	chatMaxBytes = 400_000 // teto de segurança do blob (~400 KB)
)

func ensureChatHistTable(sqlDB *sql.DB) {
	_, _ = sqlDB.Exec(`
CREATE TABLE IF NOT EXISTS FT_CHAT_HIST (
  id_usuario    BIGINT PRIMARY KEY,
  conteudo      MEDIUMTEXT NULL,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

func chatDB(c *gin.Context) *sql.DB {
	sqlDB, err := database.GormDB_App.DB()
	if err != nil || sqlDB == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return nil
	}
	ensureChatHistTable(sqlDB)
	return sqlDB
}

type chatMsg struct {
	ID      interface{} `json:"id"`
	Role    string      `json:"role"`
	Content string      `json:"content"`
}

// GetChatHistorico — GET /api/v1/chat/historico → { mensagens: [...] } do usuário logado.
func GetChatHistorico(c *gin.Context) {
	sqlDB := chatDB(c)
	if sqlDB == nil {
		return
	}
	uid, _ := usuarioIA(c)
	if uid == 0 {
		c.JSON(http.StatusOK, gin.H{"mensagens": []chatMsg{}})
		return
	}
	var conteudo sql.NullString
	err := sqlDB.QueryRow(`SELECT conteudo FROM FT_CHAT_HIST WHERE id_usuario=?`, uid).Scan(&conteudo)
	if err == sql.ErrNoRows || !conteudo.Valid || strings.TrimSpace(conteudo.String) == "" {
		c.JSON(http.StatusOK, gin.H{"mensagens": []chatMsg{}})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	var msgs []chatMsg
	if e := json.Unmarshal([]byte(conteudo.String), &msgs); e != nil {
		msgs = []chatMsg{}
	}
	c.JSON(http.StatusOK, gin.H{"mensagens": msgs})
}

// SaveChatHistorico — PUT /api/v1/chat/historico  { mensagens: [...] }
// Substitui a transcrição do usuário (as últimas chatMaxMsgs).
func SaveChatHistorico(c *gin.Context) {
	sqlDB := chatDB(c)
	if sqlDB == nil {
		return
	}
	uid, _ := usuarioIA(c)
	if uid == 0 {
		c.JSON(http.StatusOK, gin.H{"ok": true}) // sem usuário: nada a persistir no servidor
		return
	}
	var body struct {
		Mensagens []chatMsg `json:"mensagens"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}
	msgs := body.Mensagens
	if len(msgs) > chatMaxMsgs {
		msgs = msgs[len(msgs)-chatMaxMsgs:]
	}
	blob, err := json.Marshal(msgs)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "não foi possível serializar"})
		return
	}
	// teto de segurança: se passar, descarta as mais antigas até caber
	for len(blob) > chatMaxBytes && len(msgs) > 1 {
		msgs = msgs[len(msgs)/2:]
		blob, _ = json.Marshal(msgs)
	}
	_, err = sqlDB.Exec(`
INSERT INTO FT_CHAT_HIST (id_usuario, conteudo, atualizado_em) VALUES (?, ?, NOW())
ON DUPLICATE KEY UPDATE conteudo=VALUES(conteudo), atualizado_em=NOW()`, uid, string(blob))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ClearChatHistorico — DELETE /api/v1/chat/historico  → limpa a transcrição do usuário.
func ClearChatHistorico(c *gin.Context) {
	sqlDB := chatDB(c)
	if sqlDB == nil {
		return
	}
	uid, _ := usuarioIA(c)
	if uid == 0 {
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}
	_, _ = sqlDB.Exec(`DELETE FROM FT_CHAT_HIST WHERE id_usuario=?`, uid)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
