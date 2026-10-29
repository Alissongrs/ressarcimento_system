package handlers

// WhatsApp do departamento dentro do SURE (ver backend/whatsapp): conectar por QR code, monitorar as
// conversas, responder e escolher o grupo da equipe que recebe os avisos das tarefas. A conexão é uma
// só, do servidor: o admin conecta uma vez e toda a equipe vê e responde. Conectar, desconectar e
// escolher o grupo dos avisos continuam só do admin.

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/whatsapp"

	"github.com/gin-gonic/gin"
)

// waEquipe: qualquer usuário da equipe interna (rotUsuario já barra o solicitante).
func waEquipe(c *gin.Context) (rotCtx, bool) {
	return rotUsuario(c)
}

func waAdmin(c *gin.Context) (rotCtx, bool) {
	u, ok := rotUsuario(c)
	if !ok {
		return u, false
	}
	if !u.isAdmin {
		c.JSON(http.StatusForbidden, gin.H{"error": "o WhatsApp da empresa é só do administrador"})
		return u, false
	}
	return u, true
}

// GET /whatsapp/estado
func WhatsappEstado(c *gin.Context) {
	if _, ok := waEquipe(c); !ok {
		return
	}
	c.JSON(http.StatusOK, whatsapp.ObterEstado())
}

// POST /whatsapp/conectar → gera o QR code (ou reconecta o aparelho já vinculado)
func WhatsappConectar(c *gin.Context) {
	if _, ok := waAdmin(c); !ok {
		return
	}
	if err := whatsapp.Conectar(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, whatsapp.ObterEstado())
}

// POST /whatsapp/desconectar → desvincula o aparelho
func WhatsappDesconectar(c *gin.Context) {
	if _, ok := waAdmin(c); !ok {
		return
	}
	if err := whatsapp.Desconectar(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, whatsapp.ObterEstado())
}

type waConversa struct {
	Chat        string     `json:"chat"`
	Nome        string     `json:"nome"`
	Grupo       bool       `json:"grupo"`
	UltimaEm    *time.Time `json:"ultima_em"`
	UltimoTexto string     `json:"ultimo_texto"`
	UltimoTipo  string     `json:"ultimo_tipo"`
	UltimaDeMim bool       `json:"ultima_de_mim"`
	Total       int        `json:"total"`
	Erros       int        `json:"erros"`
}

// GET /whatsapp/conversas?q=&dias=
func WhatsappConversas(c *gin.Context) {
	if _, ok := waEquipe(c); !ok {
		return
	}
	dias, _ := strconv.Atoi(c.DefaultQuery("dias", "30"))
	if dias <= 0 || dias > 365 {
		dias = 30
	}
	args := []any{dias}
	filtro := ""
	if q := strings.TrimSpace(c.Query("q")); q != "" {
		filtro = " HAVING nome LIKE ? OR chat LIKE ?"
		like := "%" + q + "%"
		args = append(args, like, like)
	}
	var out []waConversa
	database.GormDB_App.Raw(`SELECT m.chat,
			COALESCE(MAX(m.chat_nome), '') AS nome, MAX(m.grupo) = 1 AS grupo,
			MAX(m.enviada_em) AS ultima_em, COUNT(*) AS total, SUM(m.status_envio = 'erro') AS erros,
			(SELECT COALESCE(x.texto,'') FROM FT_WHATSAPP_MENSAGENS x WHERE x.chat = m.chat ORDER BY x.enviada_em DESC, x.id DESC LIMIT 1) AS ultimo_texto,
			(SELECT x.tipo FROM FT_WHATSAPP_MENSAGENS x WHERE x.chat = m.chat ORDER BY x.enviada_em DESC, x.id DESC LIMIT 1) AS ultimo_tipo,
			(SELECT x.de_mim FROM FT_WHATSAPP_MENSAGENS x WHERE x.chat = m.chat ORDER BY x.enviada_em DESC, x.id DESC LIMIT 1) = 1 AS ultima_de_mim
		FROM FT_WHATSAPP_MENSAGENS m
		WHERE m.enviada_em >= NOW() - INTERVAL ? DAY
		GROUP BY m.chat`+filtro+`
		ORDER BY ultima_em DESC LIMIT 300`, args...).Scan(&out)
	// grupos do número que ainda não têm mensagem gravada também aparecem na lista
	if gs, err := whatsapp.Grupos(); err == nil {
		tem := map[string]bool{}
		for _, cv := range out {
			tem[cv.Chat] = true
		}
		q := strings.ToLower(strings.TrimSpace(c.Query("q")))
		for _, g := range gs {
			if !tem[g.JID] && (q == "" || strings.Contains(strings.ToLower(g.Nome), q)) {
				out = append(out, waConversa{Chat: g.JID, Nome: g.Nome, Grupo: true})
			}
		}
	}
	c.JSON(http.StatusOK, out)
}

type waMensagem struct {
	ID            int64      `json:"id"`
	DeMim         bool       `json:"de_mim"`
	Origem        string     `json:"origem"`
	Tipo          string     `json:"tipo"`
	Texto         string     `json:"texto"`
	Remetente     string     `json:"remetente"`
	RemetenteNome string     `json:"remetente_nome"`
	EnviadaEm     *time.Time `json:"enviada_em"`
	StatusEnvio   string     `json:"status_envio"`
	Erro          string     `json:"erro"`
	EnviadoPor    string     `json:"enviado_por"`
}

// GET /whatsapp/mensagens?chat=
func WhatsappMensagens(c *gin.Context) {
	if _, ok := waEquipe(c); !ok {
		return
	}
	var out []waMensagem
	database.GormDB_App.Raw(`SELECT * FROM (
			SELECT m.id, m.de_mim, m.origem, m.tipo, COALESCE(m.texto,'') AS texto, COALESCE(m.remetente,'') AS remetente,
				COALESCE(m.remetente_nome,'') AS remetente_nome, m.enviada_em, m.status_envio, COALESCE(m.erro,'') AS erro,
				COALESCE(u.nome_usuario,'') AS enviado_por
			FROM FT_WHATSAPP_MENSAGENS m LEFT JOIN DM_USUARIO u ON u.id_usuario = m.enviado_por
			WHERE m.chat = ? ORDER BY m.enviada_em DESC, m.id DESC LIMIT 300) t
		ORDER BY enviada_em, id`, c.Query("chat")).Scan(&out)
	c.JSON(http.StatusOK, out)
}

// POST /whatsapp/enviar {para, texto} — para = telefone ou o "chat" de uma conversa
func WhatsappEnviar(c *gin.Context) {
	u, ok := waEquipe(c)
	if !ok {
		return
	}
	var b struct {
		Para  string `json:"para"`
		Texto string `json:"texto"`
	}
	_ = c.ShouldBindJSON(&b)
	b.Texto = strings.TrimSpace(b.Texto)
	if b.Para == "" || b.Texto == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "informe o número e a mensagem"})
		return
	}
	if err := whatsapp.Enviar(b.Para, b.Texto, 0, u.id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GET /whatsapp/grupos → grupos do número do departamento + o escolhido para os avisos
func WhatsappGrupos(c *gin.Context) {
	if _, ok := waEquipe(c); !ok {
		return
	}
	atual := whatsapp.GrupoAvisos()
	gs, err := whatsapp.Grupos()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"grupos": []whatsapp.Grupo{}, "grupo_avisos": atual, "erro": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"grupos": gs, "grupo_avisos": atual})
}

// POST /whatsapp/grupo-avisos {jid} — "" desliga os avisos no WhatsApp
func WhatsappDefinirGrupo(c *gin.Context) {
	u, ok := waAdmin(c)
	if !ok {
		return
	}
	var b struct {
		JID string `json:"jid"`
	}
	_ = c.ShouldBindJSON(&b)
	if err := whatsapp.DefinirGrupoAvisos(strings.TrimSpace(b.JID), u.id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
