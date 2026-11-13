package handlers

// WhatsApp do departamento dentro do SURE (ver backend/whatsapp): conectar por QR code, monitorar as
// conversas, responder e escolher o grupo da equipe que recebe os avisos das tarefas. A conexão é uma
// só, do servidor: o admin conecta uma vez e toda a equipe vê e responde. Conectar, desconectar e
// escolher o grupo dos avisos continuam só do admin.

import (
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
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
	// dias=0 (padrão) = tudo o que está gravado, inclusive o histórico importado do celular
	dias, _ := strconv.Atoi(c.DefaultQuery("dias", "0"))
	if dias < 0 || dias > 3650 {
		dias = 0
	}
	args := []any{}
	periodo := ""
	if dias > 0 {
		periodo = " WHERE m.enviada_em >= NOW() - INTERVAL ? DAY"
		args = append(args, dias)
	}
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
		FROM FT_WHATSAPP_MENSAGENS m`+periodo+`
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
	AnexoStatus   string     `json:"anexo_status"`
	AnexoNome     string     `json:"anexo_nome"`
	AnexoMime     string     `json:"anexo_mime"`
	AnexoTamanho  int64      `json:"anexo_tamanho"`
	AnexoErro     string     `json:"anexo_erro"`
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
				COALESCE(u.nome_usuario,'') AS enviado_por,
				COALESCE(m.anexo_status,'') AS anexo_status, COALESCE(m.anexo_nome,'') AS anexo_nome,
				COALESCE(m.anexo_mime,'') AS anexo_mime, COALESCE(m.anexo_tamanho,0) AS anexo_tamanho, COALESCE(m.anexo_erro,'') AS anexo_erro
			FROM FT_WHATSAPP_MENSAGENS m LEFT JOIN DM_USUARIO u ON u.id_usuario = m.enviado_por
			WHERE m.chat = ? ORDER BY m.enviada_em DESC, m.id DESC LIMIT 300) t
		ORDER BY enviada_em, id`, c.Query("chat")).Scan(&out)
	c.JSON(http.StatusOK, out)
}

// POST /whatsapp/enviar-arquivo (multipart: para, legenda, arquivo) — manda um arquivo pela conversa
func WhatsappEnviarArquivo(c *gin.Context) {
	u, ok := waEquipe(c)
	if !ok {
		return
	}
	para := strings.TrimSpace(c.PostForm("para"))
	fh, err := c.FormFile("arquivo")
	if para == "" || err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "informe o número e o arquivo"})
		return
	}
	if fh.Size > whatsapp.LimiteArquivo {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("arquivo maior que %d MB", whatsapp.LimiteArquivo>>20)})
		return
	}
	f, err := fh.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "não consegui ler o arquivo"})
		return
	}
	defer f.Close()
	dados, err := io.ReadAll(io.LimitReader(f, whatsapp.LimiteArquivo+1))
	if err != nil || len(dados) > whatsapp.LimiteArquivo {
		c.JSON(http.StatusBadRequest, gin.H{"error": "não consegui ler o arquivo (ou ele passa do limite)"})
		return
	}
	mimeTipo := strings.TrimSpace(fh.Header.Get("Content-Type"))
	if mimeTipo == "" || mimeTipo == "application/octet-stream" {
		if m := mime.TypeByExtension(strings.ToLower(filepath.Ext(fh.Filename))); m != "" {
			mimeTipo = m
		}
	}
	if err := whatsapp.EnviarArquivo(para, filepath.Base(fh.Filename), mimeTipo, dados, c.PostForm("legenda"), u.id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GET /whatsapp/anexo/:id — o arquivo do anexo (imagem, PDF, áudio…). Aceita cookie, Bearer ou ?token=.
func WhatsappAnexo(c *gin.Context) {
	if _, ok := waEquipe(c); !ok {
		return
	}
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	caminho, mimeTipo, nome, err := whatsapp.ArquivoAnexo(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	disp := "attachment"
	if strings.HasPrefix(mimeTipo, "image/") || strings.HasPrefix(mimeTipo, "audio/") || strings.HasPrefix(mimeTipo, "video/") || mimeTipo == "application/pdf" {
		disp = "inline"
	}
	c.Header("Content-Type", mimeTipo)
	c.Header("Content-Disposition", fmt.Sprintf("%s; filename=%q", disp, nome))
	c.Header("Cache-Control", "private, max-age=86400")
	c.File(caminho)
}

// POST /whatsapp/anexos/retentar — tenta de novo os anexos que não baixaram (admin)
func WhatsappAnexosRetentar(c *gin.Context) {
	if _, ok := waAdmin(c); !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "na_fila": whatsapp.RetentarAnexos()})
}

// POST /whatsapp/contatos/atualizar — grava o nome da agenda do celular nas conversas (admin)
func WhatsappContatosAtualizar(c *gin.Context) {
	if _, ok := waAdmin(c); !ok {
		return
	}
	n, err := whatsapp.AtualizarNomesContatos()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "atualizadas": n})
}

// GET /whatsapp/historico — progresso da busca das conversas inteiras
func WhatsappHistorico(c *gin.Context) {
	if _, ok := waEquipe(c); !ok {
		return
	}
	c.JSON(http.StatusOK, whatsapp.ProgressoHistorico())
}

// POST /whatsapp/historico/puxar {chat?} — pede ao celular as mensagens anteriores às gravadas (admin).
// Sem chat = todas as conversas.
func WhatsappHistoricoPuxar(c *gin.Context) {
	if _, ok := waAdmin(c); !ok {
		return
	}
	var b struct {
		Chat string `json:"chat"`
	}
	_ = c.ShouldBindJSON(&b)
	if err := whatsapp.PuxarHistorico(strings.TrimSpace(b.Chat)); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, whatsapp.ProgressoHistorico())
}

// POST /whatsapp/historico/parar — interrompe a busca (admin)
func WhatsappHistoricoParar(c *gin.Context) {
	if _, ok := waAdmin(c); !ok {
		return
	}
	whatsapp.PararHistorico()
	c.JSON(http.StatusOK, whatsapp.ProgressoHistorico())
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
