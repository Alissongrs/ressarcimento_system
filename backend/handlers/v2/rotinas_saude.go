package v2

// Saúde das rotinas (melhoria 5): painel "Rotinas" em Tarefas do sistema. Só administradores.
//
//   GET  /api/v2/rotinas/saude                 → { agora, itens: [...], aviso: {...}, whatsapp_conectado, usuarios: [...] }
//   GET  /api/v2/rotinas/saude/execucoes       ?rotina=&n= → { itens: [...] }
//   POST /api/v2/rotinas/saude/aviso           { id_usuario, celular } → { ok, aviso }
//   POST /api/v2/rotinas/saude/aviso/testar    → { ok, canais }

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/saude"
	"ressarcimento-backend/whatsapp"
)

func exigeAdminRotinas(c *gin.Context) bool {
	if adm, _ := c.Get("isAdmin"); adm == true {
		return true
	}
	apiError(c, http.StatusForbidden, "SEM_PERMISSAO", "Só administradores veem a saúde das rotinas.", nil)
	return false
}

type usuarioResumo struct {
	ID   int64  `json:"id_usuario"`
	Nome string `json:"nome"`
}

func RotinasSaude(c *gin.Context) {
	db := requireDB(c)
	if db == nil || !exigeAdminRotinas(c) {
		return
	}
	ctx := c.Request.Context()
	agora := time.Now()
	itens, err := saude.Avaliacoes(ctx, db, agora)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	usuarios := []usuarioResumo{}
	if rows, err := db.QueryContext(ctx, `SELECT id_usuario, COALESCE(nome_usuario, email) FROM DM_USUARIO WHERE usuario_ativo = 1 ORDER BY nome_usuario`); err == nil {
		for rows.Next() {
			var u usuarioResumo
			if rows.Scan(&u.ID, &u.Nome) == nil {
				usuarios = append(usuarios, u)
			}
		}
		rows.Close()
	}
	c.JSON(http.StatusOK, gin.H{
		"agora":              agora,
		"itens":              itens,
		"aviso":              saude.ObterAviso(ctx, db),
		"whatsapp_conectado": whatsapp.ObterEstado().Conectado,
		"usuarios":           usuarios,
	})
}

func RotinasSaudeExecucoes(c *gin.Context) {
	db := requireDB(c)
	if db == nil || !exigeAdminRotinas(c) {
		return
	}
	n, _ := strconv.Atoi(c.Query("n"))
	itens, err := saude.Execucoes(c.Request.Context(), db, c.Query("rotina"), n)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"itens": itens})
}

type avisoReq struct {
	IDUsuario int64  `json:"id_usuario"`
	Celular   string `json:"celular"`
}

func RotinasSaudeDefinirAviso(c *gin.Context) {
	db := requireDB(c)
	if db == nil || !exigeAdminRotinas(c) {
		return
	}
	var in avisoReq
	if !bindJSON(c, &in) {
		return
	}
	ctx := c.Request.Context()
	if err := saude.DefinirAviso(ctx, db, in.IDUsuario, in.Celular, int64(resolverUsuarioV2(c, db))); err != nil {
		apiError(c, http.StatusBadRequest, "AVISO_INVALIDO", err.Error(), nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "aviso": saude.ObterAviso(ctx, db)})
}

func RotinasSaudeTestarAviso(c *gin.Context) {
	db := requireDB(c)
	if db == nil || !exigeAdminRotinas(c) {
		return
	}
	canais := saude.Avisar(c.Request.Context(), db, "Teste do painel de rotinas: os avisos vão chegar por aqui.")
	if len(canais) == 0 {
		apiError(c, http.StatusBadRequest, "SEM_DESTINO", "Nenhum destinatário configurado (escolha o usuário e, se quiser, o celular).", nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "canais": canais})
}
