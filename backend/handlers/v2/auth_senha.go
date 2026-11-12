package v2

// Definir/alterar a própria senha (12/11/2026). O login padrão passou a ser senha + código do
// autenticador; quem entrou só pelo link por e-mail não tem senha e define uma aqui (Minha conta).
//
//   POST /api/v2/auth/senha { senha_atual, nova } → { ok }
//   - sem senha cadastrada: senha_atual não é exigida
//   - com senha: senha_atual precisa conferir

import (
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

type definirSenhaReq struct {
	SenhaAtual string `json:"senha_atual"`
	Nova       string `json:"nova"`
}

func DefinirSenha(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	uid, ok := userIDDoContexto(c)
	if !ok {
		apiError(c, http.StatusUnauthorized, "NAO_AUTENTICADO", "Token ausente ou inválido", nil)
		return
	}
	var in definirSenhaReq
	if !bindJSON(c, &in) {
		return
	}
	nova := in.Nova
	if len(nova) < 8 || len(nova) > 128 {
		apiError(c, http.StatusBadRequest, "SENHA_FRACA", "A senha precisa ter entre 8 e 128 caracteres.", nil)
		return
	}
	if strings.TrimSpace(nova) != nova {
		apiError(c, http.StatusBadRequest, "SENHA_FRACA", "A senha não pode começar nem terminar com espaço.", nil)
		return
	}
	var hashAtual sql.NullString
	err := db.QueryRowContext(c.Request.Context(), `SELECT senha_hash FROM DM_USUARIO WHERE id_usuario = ?`, uid).Scan(&hashAtual)
	if errors.Is(err, sql.ErrNoRows) {
		apiError(c, http.StatusNotFound, "USUARIO_NAO_ENCONTRADO", "Usuário não existe", nil)
		return
	}
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	temSenha := hashAtual.Valid && strings.TrimSpace(hashAtual.String) != ""
	if temSenha {
		okAtual, err := verifyPasswordV2(db, in.SenhaAtual, hashAtual.String, uid)
		if err != nil || !okAtual {
			apiError(c, http.StatusUnauthorized, "SENHA_ATUAL_INVALIDA", "A senha atual não confere.", nil)
			return
		}
	}
	hashed, err := hashPasswordBcrypt(nova)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "HASH_ERR", "Erro ao guardar a senha", nil)
		return
	}
	if _, err := db.ExecContext(c.Request.Context(), `UPDATE DM_USUARIO SET senha_hash = ? WHERE id_usuario = ?`, hashed, uid); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	log.Printf("[auth v2] senha %s pelo usuário %d", map[bool]string{true: "alterada", false: "definida"}[temSenha], uid)
	c.JSON(http.StatusOK, gin.H{"ok": true, "tinha_senha": temSenha})
}

// TemSenha — usado por GET /auth/me para a tela Minha conta saber se mostra "definir" ou "alterar".
func temSenha(c *gin.Context, db *sql.DB, uid int64) bool {
	var h sql.NullString
	_ = db.QueryRowContext(c.Request.Context(), `SELECT senha_hash FROM DM_USUARIO WHERE id_usuario = ?`, uid).Scan(&h)
	return h.Valid && strings.TrimSpace(h.String) != ""
}
