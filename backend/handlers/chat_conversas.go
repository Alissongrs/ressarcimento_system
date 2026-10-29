package handlers

import (
	"database/sql"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// ─── Conversas com a SURE (histórico de conversas, estilo Claude web) ─────────
// FT_CHAT_CONVERSAS guarda CADA mensagem (pessoa e SURE) com a sessão em que foi dita.
// Fica disponível por chatConversasDias dias e permite listar as conversas e retomar
// ou excluir uma delas no chat.
//   POST   /api/v1/chat/conversas/msg      {sessao, role, conteudo, modo}
//   GET    /api/v1/chat/conversas          → sessões do usuário logado
//   GET    /api/v1/chat/conversas/:sessao  → mensagens da sessão
//   DELETE /api/v1/chat/conversas/:sessao  → exclui a conversa

// retenção do histórico de conversas (dias). Default 90; ajustável por SURE_CHAT_DIAS.
func chatConvDias() int {
	if v := strings.TrimSpace(os.Getenv("SURE_CHAT_DIAS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 90
}

var (
	convTblOnce   sync.Once
	convUltLimpar time.Time
	convLimparMu  sync.Mutex
)

func conversasDB(c *gin.Context) *sql.DB {
	sqlDB, err := database.GormDB_App.DB()
	if err != nil || sqlDB == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return nil
	}
	convTblOnce.Do(func() {
		_, _ = sqlDB.Exec(`
CREATE TABLE IF NOT EXISTS FT_CHAT_CONVERSAS (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_usuario BIGINT       NOT NULL,
  sessao     VARCHAR(40)  NOT NULL,
  role       VARCHAR(12)  NOT NULL,      -- user | assistant
  conteudo   MEDIUMTEXT   NOT NULL,
  modo       VARCHAR(10)  NULL,          -- texto | voz | conversa
  criado_em  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY k_usuario_data (id_usuario, criado_em),
  KEY k_sessao (sessao)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
		// título da conversa (auto=1 → heurístico/IA; auto=0 → renomeado à mão pelo usuário)
		_, _ = sqlDB.Exec(`
CREATE TABLE IF NOT EXISTS FT_CHAT_CONVERSA_TITULO (
  id_usuario    BIGINT       NOT NULL,
  sessao        VARCHAR(40)  NOT NULL,
  titulo        VARCHAR(160) NOT NULL,
  auto          TINYINT      NOT NULL DEFAULT 1,
  atualizado_em DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_usuario, sessao)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	})
	// retenção: limpa as mais antigas no máximo 1x por hora
	convLimparMu.Lock()
	if time.Since(convUltLimpar) > time.Hour {
		convUltLimpar = time.Now()
		dias := chatConvDias()
		go func() {
			_, _ = sqlDB.Exec(`DELETE FROM FT_CHAT_CONVERSAS WHERE criado_em < NOW() - INTERVAL ? DAY`, dias)
		}()
	}
	convLimparMu.Unlock()
	return sqlDB
}

// SalvarMsgConversa — POST /api/v1/chat/conversas/msg
func SalvarMsgConversa(c *gin.Context) {
	db := conversasDB(c)
	if db == nil {
		return
	}
	uid, _ := usuarioIA(c)
	if uid == 0 {
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}
	var b struct {
		Sessao   string `json:"sessao"`
		Role     string `json:"role"`
		Conteudo string `json:"conteudo"`
		Modo     string `json:"modo"`
	}
	if err := c.ShouldBindJSON(&b); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}
	b.Sessao, b.Conteudo = strings.TrimSpace(b.Sessao), strings.TrimSpace(b.Conteudo)
	if b.Sessao == "" || len(b.Sessao) > 40 || b.Conteudo == "" || (b.Role != "user" && b.Role != "assistant") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "dados inválidos"})
		return
	}
	if len(b.Conteudo) > 60000 {
		b.Conteudo = b.Conteudo[:60000]
	}
	if _, err := db.Exec(`INSERT INTO FT_CHAT_CONVERSAS (id_usuario, sessao, role, conteudo, modo) VALUES (?,?,?,?,?)`,
		uid, b.Sessao, b.Role, b.Conteudo, nullIfEmpty(b.Modo)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// título automático (heurístico) na 1ª pergunta do usuário, se ainda não houver título.
	// Fica marcado auto=1 → o worker (claude -p) pode refinar depois para um título melhor.
	if b.Role == "user" {
		_, _ = db.Exec(`INSERT IGNORE INTO FT_CHAT_CONVERSA_TITULO (id_usuario, sessao, titulo, auto)
		                VALUES (?,?,?,1)`, uid, b.Sessao, tituloHeuristico(b.Conteudo))
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// tituloHeuristico monta um título curto a partir da 1ª mensagem (fallback instantâneo, sem IA).
func tituloHeuristico(s string) string {
	s = strings.TrimSpace(s)
	s = strings.NewReplacer("#sistema", "", "@sistema", "", "\n", " ", "\r", " ").Replace(s)
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "Nova conversa"
	}
	r := []rune(s)
	if len(r) > 48 {
		s = strings.TrimSpace(string(r[:48])) + "…"
	}
	return s
}

func nullIfEmpty(s string) interface{} {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

// SetTituloConversa — PUT /api/v1/chat/conversas/:sessao/titulo  { titulo }
// Renomeia a conversa à mão (auto=0, não é mais sobrescrito pelo título automático/IA).
func SetTituloConversa(c *gin.Context) {
	db := conversasDB(c)
	if db == nil {
		return
	}
	uid, _ := usuarioIA(c)
	sessao := strings.TrimSpace(c.Param("sessao"))
	var b struct {
		Titulo string `json:"titulo"`
	}
	if err := c.ShouldBindJSON(&b); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}
	t := strings.Join(strings.Fields(strings.TrimSpace(b.Titulo)), " ")
	if t == "" || sessao == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "título inválido"})
		return
	}
	if r := []rune(t); len(r) > 160 {
		t = string(r[:160])
	}
	_, err := db.Exec(`INSERT INTO FT_CHAT_CONVERSA_TITULO (id_usuario, sessao, titulo, auto)
	                   VALUES (?,?,?,0)
	                   ON DUPLICATE KEY UPDATE titulo=VALUES(titulo), auto=0, atualizado_em=NOW()`, uid, sessao, t)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "titulo": t})
}

// ListarConversas — GET /api/v1/chat/conversas (últimos 3 dias, mais recentes primeiro)
func ListarConversas(c *gin.Context) {
	db := conversasDB(c)
	if db == nil {
		return
	}
	uid, _ := usuarioIA(c)
	rows, err := db.Query(`
SELECT cc.sessao,
       DATE_FORMAT(CONVERT_TZ(MIN(cc.criado_em),'+00:00','-03:00'),'%d/%m %H:%i') AS inicio,
       DATE_FORMAT(CONVERT_TZ(MAX(cc.criado_em),'+00:00','-03:00'),'%d/%m %H:%i') AS fim,
       COUNT(*) AS qtd,
       SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN cc.role='user' THEN LEFT(cc.conteudo,120) END ORDER BY cc.id SEPARATOR '\n'), '\n', 1) AS primeira,
       COALESCE(t.titulo,'') AS titulo
  FROM FT_CHAT_CONVERSAS cc
  LEFT JOIN FT_CHAT_CONVERSA_TITULO t ON t.id_usuario=cc.id_usuario AND t.sessao=cc.sessao
 WHERE cc.id_usuario = ? AND cc.criado_em >= NOW() - INTERVAL ? DAY
 GROUP BY cc.sessao, t.titulo
 ORDER BY MAX(cc.id) DESC
 LIMIT 200`, uid, chatConvDias())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var sessao, ini, fim string
		var qtd int
		var primeira, titulo sql.NullString
		if rows.Scan(&sessao, &ini, &fim, &qtd, &primeira, &titulo) == nil {
			out = append(out, gin.H{"sessao": sessao, "inicio": ini, "fim": fim, "qtd": qtd,
				"primeira": primeira.String, "titulo": titulo.String})
		}
	}
	c.JSON(http.StatusOK, gin.H{"conversas": out, "dias": chatConvDias()})
}

// ExcluirConversa — DELETE /api/v1/chat/conversas/:sessao → apaga a conversa do usuário logado.
func ExcluirConversa(c *gin.Context) {
	db := conversasDB(c)
	if db == nil {
		return
	}
	uid, _ := usuarioIA(c)
	sessao := strings.TrimSpace(c.Param("sessao"))
	if sessao == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "sessão inválida"})
		return
	}
	r, err := db.Exec(`DELETE FROM FT_CHAT_CONVERSAS WHERE id_usuario=? AND sessao=?`, uid, sessao)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	_, _ = db.Exec(`DELETE FROM FT_CHAT_CONVERSA_TITULO WHERE id_usuario=? AND sessao=?`, uid, sessao)
	n, _ := r.RowsAffected()
	c.JSON(http.StatusOK, gin.H{"ok": true, "removidas": n})
}

// MensagensConversa — GET /api/v1/chat/conversas/:sessao
func MensagensConversa(c *gin.Context) {
	db := conversasDB(c)
	if db == nil {
		return
	}
	uid, _ := usuarioIA(c)
	rows, err := db.Query(`SELECT id, role, conteudo FROM FT_CHAT_CONVERSAS
 WHERE id_usuario = ? AND sessao = ? AND criado_em >= NOW() - INTERVAL ? DAY ORDER BY id`, uid, c.Param("sessao"), chatConvDias())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id int64
		var role, conteudo string
		if rows.Scan(&id, &role, &conteudo) == nil {
			out = append(out, gin.H{"id": id, "role": role, "content": conteudo})
		}
	}
	c.JSON(http.StatusOK, gin.H{"mensagens": out})
}
