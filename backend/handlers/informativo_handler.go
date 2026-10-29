package handlers

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// ============================================================================
// Informativo do sistema — "janelinha" que explica o funcionamento e divulga
// avisos. A parte fixa (como funciona + ilustrações) mora no front; aqui fica a
// parte EDITÁVEL (título + aviso + ativo), versionada: ao publicar um aviso novo,
// `versao` incrementa → o "não exibir mais" dos usuários é resetado (veem de novo).
// Guardado em DM_INFORMATIVO (linha única id=1), auto-criada.
// ============================================================================

func ensureInformativoTable(db *sql.DB) {
	_, _ = db.Exec(`
CREATE TABLE IF NOT EXISTS DM_INFORMATIVO (
  id            INT PRIMARY KEY,
  versao        INT NOT NULL DEFAULT 1,
  titulo        VARCHAR(255) NULL,
  aviso         TEXT NULL,
  ativo         TINYINT NOT NULL DEFAULT 1,
  atualizado_em DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	_, _ = db.Exec(
		`INSERT IGNORE INTO DM_INFORMATIVO (id, versao, titulo, aviso, ativo, atualizado_em)
		 VALUES (1, 1, ?, ?, 1, NOW())`,
		"Novidades na SURE 🎉",
		"Já disponível:\n"+
			"• Histórico de pedidos e do chat — reabra tudo pela aba Histórico.\n"+
			"• Metas por empresa e por ano — clique num mês ou no ano na barra de metas.\n"+
			"• Página de Regras — criar, editar e \"passar ao banco\".\n"+
			"• Resumo de prazos pelo chat — é só pedir à SURE.\n\n"+
			"Em breve:\n"+
			"• Chat personalizado com informações dos seus e-mails e sugestões baseadas no histórico de tratativas por e-mail com cada concessionária.\n"+
			"• Mais automações serão entregues nas próximas atualizações.")
}

func informativoDB(c *gin.Context) *sql.DB {
	if database.GormDB_App == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return nil
	}
	db, err := database.GormDB_App.DB()
	if err != nil || db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return nil
	}
	ensureInformativoTable(db)
	return db
}

// GET /api/v1/informativo — conteúdo editável do informativo (qualquer usuário).
func GetInformativo(c *gin.Context) {
	db := informativoDB(c)
	if db == nil {
		return
	}
	var versao int
	var titulo, aviso sql.NullString
	var ativo int
	err := db.QueryRow(`SELECT versao, titulo, aviso, ativo FROM DM_INFORMATIVO WHERE id=1`).
		Scan(&versao, &titulo, &aviso, &ativo)
	if err != nil {
		// degrada: informativo padrão
		c.JSON(http.StatusOK, gin.H{"versao": 1, "titulo": "Bem-vindo à SURE", "aviso": "", "ativo": true})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"versao": versao, "titulo": titulo.String, "aviso": aviso.String, "ativo": ativo == 1,
	})
}

type informativoIn struct {
	Titulo *string `json:"titulo"`
	Aviso  *string `json:"aviso"`
	Ativo  *bool   `json:"ativo"`
}

// PUT /api/v1/informativo — publica/edita o aviso (ADMIN). Incrementa a versão
// quando o conteúdo muda, p/ reexibir a todos.
func AtualizarInformativo(c *gin.Context) {
	db := informativoDB(c)
	if db == nil {
		return
	}
	var in informativoIn
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}
	sets := []string{}
	args := []interface{}{}
	if in.Titulo != nil {
		sets = append(sets, "titulo=?")
		args = append(args, strings.TrimSpace(*in.Titulo))
	}
	if in.Aviso != nil {
		sets = append(sets, "aviso=?")
		args = append(args, strings.TrimSpace(*in.Aviso))
	}
	if in.Ativo != nil {
		a := 0
		if *in.Ativo {
			a = 1
		}
		sets = append(sets, "ativo=?")
		args = append(args, a)
	}
	if len(sets) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nada para atualizar"})
		return
	}
	// versão sobe sempre que há mudança → reexibe mesmo a quem marcou "não exibir"
	sets = append(sets, "versao=versao+1", "atualizado_em=NOW()")
	if _, err := db.Exec("UPDATE DM_INFORMATIVO SET "+strings.Join(sets, ", ")+" WHERE id=1", args...); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	var versao int
	_ = db.QueryRow(`SELECT versao FROM DM_INFORMATIVO WHERE id=1`).Scan(&versao)
	c.JSON(http.StatusOK, gin.H{"ok": true, "versao": versao})
}
