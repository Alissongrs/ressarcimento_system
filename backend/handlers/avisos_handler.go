package handlers

// Sininho de avisos do topo: "Meus avisos" = notificações pessoais (FT_ALERTAS do próprio usuário, sem data de
// calendário — ex.: "Nova tarefa: Protocolo ANEEL … concluído", que vai só para quem cuida do protocolo), com
// bolinha vermelha até a pessoa apertar "Ciente" em cada um; "Histórico" = todas as movimentações de protocolo ANEEL que viraram tarefa,
// visível para toda a equipe (quem recebeu, quando, situação). No Histórico, quem recebeu a tarefa dá "Ciente" ali
// mesmo, e a tarefa sem responsável tem "Assumir": quem apertar vira o responsável.

import (
	"net/http"
	"strconv"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/protocolos"
	"ressarcimento-backend/sse"
	"ressarcimento-backend/whatsapp"

	"github.com/gin-gonic/gin"
)

type avisoPessoal struct {
	ID          int64     `json:"id"`
	Mensagem    string    `json:"mensagem"`
	Lido        bool       `json:"lido"`
	DataCriacao time.Time  `json:"data_criacao"`
	CienteEm    *time.Time `json:"ciente_em"`
}

type avisoHistorico struct {
	IDTarefa     int64      `json:"id_tarefa"`
	Titulo       string     `json:"titulo"`
	IDProcesso   *int64     `json:"id_processo"`
	ProtocoloNum string     `json:"protocolo_num"`
	Responsavel  string     `json:"responsavel"`
	IDResp       *int64     `json:"id_responsavel"`
	CienteEm     *time.Time `json:"ciente_em"`
	Status       string     `json:"status"`
	CriadoEm     time.Time  `json:"criado_em"`
	ConcluidaEm  *time.Time `json:"concluida_em"`
}

func avisosNaoLidos(userID int64) int64 {
	var n int64
	_ = database.GormDB_App.Raw(`SELECT COUNT(*) FROM FT_ALERTAS WHERE id_usuario = ? AND data_alerta IS NULL AND lido = 0`,
		userID).Row().Scan(&n)
	return n
}

// GET /avisos → { meus, nao_lidos, historico }
func GetAvisos(c *gin.Context) {
	userID, _ := c.Get("userID")
	uid, _ := userID.(int64)
	if uid <= 0 || database.GormDB_App == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "usuário não autenticado"})
		return
	}
	meus := []avisoPessoal{}
	database.GormDB_App.Raw(`SELECT id_alerta AS id, COALESCE(mensagem,'') AS mensagem, COALESCE(lido,0) AS lido, data_criacao, ciente_em
		FROM FT_ALERTAS WHERE id_usuario = ? AND data_alerta IS NULL
		ORDER BY COALESCE(lido,0), data_criacao DESC LIMIT 60`, uid).Scan(&meus)
	hist := []avisoHistorico{}
	database.GormDB_App.Raw(`SELECT t.id_tarefa, t.titulo, t.id_processo, COALESCE(t.protocolo_num,'') AS protocolo_num,
		COALESCE(u.nome_usuario,'') AS responsavel, t.id_usuario_responsavel AS id_resp, t.ciente_em, t.status, t.criado_em, t.concluida_em
		FROM FT_TAREFAS t LEFT JOIN DM_USUARIO u ON u.id_usuario = t.id_usuario_responsavel
		WHERE t.tipo LIKE 'protocolo\_%'
		ORDER BY t.criado_em DESC LIMIT 100`).Scan(&hist)
	c.JSON(http.StatusOK, gin.H{"meus": meus, "nao_lidos": avisosNaoLidos(uid), "historico": hist, "eu": uid})
}

// tarefaDoHistorico lê a tarefa de protocolo do Histórico (título e nº do protocolo, para achar os avisos dela).
func tarefaDoHistorico(id string) (titulo, protocolo string, resp *int64, status string, ok bool) {
	var t struct {
		Titulo       string
		ProtocoloNum string
		Resp         *int64
		Status       string
	}
	if database.GormDB_App.Raw(`SELECT titulo, COALESCE(protocolo_num,'') AS protocolo_num, id_usuario_responsavel AS resp, status
		FROM FT_TAREFAS WHERE id_tarefa = ? AND tipo LIKE 'protocolo\_%'`, id).Scan(&t).RowsAffected == 0 {
		return "", "", nil, "", false
	}
	return t.Titulo, t.ProtocoloNum, t.Resp, t.Status, true
}

// darCienteAvisosDaTarefa apaga a bolinha dos avisos da pessoa que falam deste protocolo (o aviso em "Meus avisos"
// e o da tarefa são a mesma notícia).
func darCienteAvisosDaTarefa(uid int64, protocolo string) {
	if protocolo == "" {
		return
	}
	database.GormDB_App.Exec(`UPDATE FT_ALERTAS SET lido = 1, acknowledged = 1, ciente_em = NOW()
		WHERE id_usuario = ? AND data_alerta IS NULL AND lido = 0 AND mensagem LIKE ?`,
		uid, "%"+protocolos.Formatar(protocolo)+"%")
}

// POST /avisos/tarefas/:id/ciente — só quem recebeu a tarefa confirma que tomou ciência.
func TarefaCiente(c *gin.Context) {
	userID, _ := c.Get("userID")
	uid, _ := userID.(int64)
	if uid <= 0 || database.GormDB_App == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "usuário não autenticado"})
		return
	}
	_, protocolo, resp, _, ok := tarefaDoHistorico(c.Param("id"))
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "tarefa não encontrada"})
		return
	}
	if resp == nil || *resp != uid {
		c.JSON(http.StatusForbidden, gin.H{"error": "só quem recebeu a tarefa pode dar ciente"})
		return
	}
	database.GormDB_App.Exec(`UPDATE FT_TAREFAS SET ciente_em = NOW() WHERE id_tarefa = ? AND id_usuario_responsavel = ? AND ciente_em IS NULL`,
		c.Param("id"), uid)
	darCienteAvisosDaTarefa(uid, protocolo)
	sse.BroadcastUser(uid, sse.Event{Type: "alerta_lido", Payload: map[string]any{}})
	c.JSON(http.StatusOK, gin.H{"ok": true, "nao_lidos": avisosNaoLidos(uid)})
}

// POST /avisos/tarefas/:id/assumir — tarefa sem responsável: quem apertar vira o responsável (já com ciente).
// Os avisos "Tarefa sem responsável para direcionar" dessa tarefa param de alertar para os administradores.
func TarefaAssumir(c *gin.Context) {
	userID, _ := c.Get("userID")
	uid, _ := userID.(int64)
	if uid <= 0 || database.GormDB_App == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "usuário não autenticado"})
		return
	}
	titulo, protocolo, _, _, ok := tarefaDoHistorico(c.Param("id"))
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "tarefa não encontrada"})
		return
	}
	db := database.GormDB_App
	res := db.Exec(`UPDATE FT_TAREFAS SET id_usuario_responsavel = ?, direcionado_por = ?, direcionado_em = NOW(), ciente_em = NOW()
		WHERE id_tarefa = ? AND id_usuario_responsavel IS NULL AND status <> 'concluida'`, uid, uid, c.Param("id"))
	if res.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": res.Error.Error()})
		return
	}
	if res.RowsAffected == 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "essa tarefa já tem responsável"})
		return
	}
	if protocolo != "" {
		db.Exec(`UPDATE FT_ALERTAS SET lido = 1 WHERE data_alerta IS NULL AND lido = 0
			AND mensagem LIKE 'Tarefa sem responsável para direcionar:%' AND mensagem LIKE ?`, "%"+protocolos.Formatar(protocolo)+"%")
	}
	darCienteAvisosDaTarefa(uid, protocolo)
	var nome string
	_ = db.Raw("SELECT COALESCE(nome_usuario,'') FROM DM_USUARIO WHERE id_usuario = ?", uid).Row().Scan(&nome)
	whatsapp.AvisarGrupo("Tarefa assumida por *" + nome + "*: " + titulo)
	sse.BroadcastUser(uid, sse.Event{Type: "alerta_lido", Payload: map[string]any{}})
	c.JSON(http.StatusOK, gin.H{"ok": true, "nao_lidos": avisosNaoLidos(uid)})
}

// POST /avisos/:id/ciente — a pessoa confirma que tomou ciência do aviso; só assim ele para de alertar.
// Um aviso por vez (não existe "marcar todos"), e só o próprio dono do aviso pode dar ciente.
func AvisoCiente(c *gin.Context) {
	userID, _ := c.Get("userID")
	uid, _ := userID.(int64)
	if uid <= 0 || database.GormDB_App == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "usuário não autenticado"})
		return
	}
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "aviso inválido"})
		return
	}
	res := database.GormDB_App.Exec(`UPDATE FT_ALERTAS SET lido = 1, acknowledged = 1, ciente_em = NOW()
		WHERE id_alerta = ? AND id_usuario = ? AND data_alerta IS NULL AND lido = 0`, id, uid)
	if res.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": res.Error.Error()})
		return
	}
	n := avisosNaoLidos(uid)
	sse.BroadcastUser(uid, sse.Event{Type: "alerta_lido", Payload: map[string]any{}})
	c.JSON(http.StatusOK, gin.H{"ok": true, "nao_lidos": n})
}
