package handlers

// Protocolos ANEEL (ver backend/protocolos): lista, consulta, vínculo com processo, analista
// responsável e as tarefas geradas pelas mudanças. Equipe interna; direcionar tarefa e confirmar
// vínculo duplicado são do admin.

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/protocolos"
	"ressarcimento-backend/rotinas"
	"ressarcimento-backend/services"
	"ressarcimento-backend/whatsapp"

	"github.com/gin-gonic/gin"
)

// remetentes da ANEEL cujos e-mails chegam na caixa
var remetentesAneel = []string{"naoresponda@aneel.gov.br", "sistema.sicnet2@aneel.gov.br",
	"consultaprocessual@aneel.gov.br", "protocologeral@aneel.gov.br"}

var caixaAneelCompleta bool // já leu a caixa inteira desde que o backend subiu

func init() {
	// antes de cada rodada traz da caixa (todas as pastas) os e-mails da ANEEL e guarda em mail_messages.
	// Na 1ª rodada depois que o backend sobe, lê a caixa inteira (pega o que escapou); depois, só os últimos 7 dias.
	protocolos.AtualizarCaixa = func() {
		desde := time.Now().UTC().Add(-7 * 24 * time.Hour).Format("2006-01-02T15:04:05Z")
		if !caixaAneelCompleta {
			desde = ""
		}
		completa := true
		var aneel []services.GraphMessage
		for _, r := range remetentesAneel {
			msgs, err := services.ListMailFrom(r, desde)
			if err != nil {
				completa = false
			}
			aneel = append(aneel, msgs...)
		}
		// grava só o que ainda não está em mail_messages: regravar os já existentes refaz a vinculação
		// automática de cada um (buscas pesadas no histórico) e deixava a 1ª rodada levando horas
		if upsertMailMessages(soNovas(aneel)) == nil && completa {
			caixaAneelCompleta = true
		}
	}
}

// soNovas tira as mensagens cujo id do Graph já está em mail_messages (comparação exata: a coluna é utf8mb4_bin).
func soNovas(msgs []services.GraphMessage) []services.GraphMessage {
	ja := map[string]bool{}
	for i := 0; i < len(msgs); i += 500 {
		fim := i + 500
		if fim > len(msgs) {
			fim = len(msgs)
		}
		ids := make([]string, 0, fim-i)
		for _, m := range msgs[i:fim] {
			ids = append(ids, m.ID)
		}
		var existentes []string
		database.GormDB_App.Raw("SELECT graph_message_id FROM mail_messages WHERE graph_message_id IN ?", ids).Scan(&existentes)
		for _, id := range existentes {
			ja[id] = true
		}
	}
	out := make([]services.GraphMessage, 0, len(msgs))
	for _, m := range msgs {
		if m.ID != "" && !ja[m.ID] {
			out = append(out, m)
		}
	}
	return out
}

type protLinha struct {
	ID              int64      `json:"id"`
	Protocolo       string     `json:"protocolo"`
	ProtocoloNum    string     `json:"protocolo_num"`
	IDProcesso      *int64     `json:"id_processo"`
	StatusVinculo   string     `json:"status_vinculo"`
	Origem          string     `json:"origem"`
	IDResponsavel   *int64     `json:"id_responsavel"`
	Responsavel     string     `json:"responsavel"`
	Situacao        string     `json:"situacao"`
	UltimoAndamento string     `json:"ultimo_andamento"`
	UltimaMudanca   *time.Time `json:"ultima_mudanca_em"`
	UltimaVerif     *time.Time `json:"ultima_verificacao_em"`
	Cliente         string     `json:"cliente"`
	Concessionaria  string     `json:"concessionaria"`
	UC              string     `json:"uc"`
}

const selProt = `SELECT p.id, p.protocolo, p.protocolo_num, p.id_processo, p.status_vinculo, p.origem,
	p.id_usuario_responsavel AS id_responsavel, COALESCE(u.nome_usuario,'') AS responsavel,
	COALESCE(p.situacao,'') AS situacao, COALESCE(p.ultimo_andamento,'') AS ultimo_andamento,
	p.ultima_mudanca_em AS ultima_mudanca, p.ultima_verificacao_em AS ultima_verif,
	COALESCE(pr.cliente,'') AS cliente, COALESCE(pr.concessionaria,'') AS concessionaria, COALESCE(pr.uc,'') AS uc
	FROM FT_PROTOCOLOS_ANEEL p
	LEFT JOIN FT_PROCESSOS pr ON pr.id_processo = p.id_processo
	LEFT JOIN DM_USUARIO u ON u.id_usuario = p.id_usuario_responsavel`

// mesma regra das rotinas: só a equipe interna (solicitante não vê)
func protUsuario(c *gin.Context) (rotCtx, bool) { return rotUsuario(c) }

// GET /protocolos-aneel?q=&situacao=&vinculo=&mudou_dias=
func ListarProtocolosAneel(c *gin.Context) {
	if _, ok := protUsuario(c); !ok {
		return
	}
	where := []string{"p.ativo = 1"}
	args := []any{}
	if q := strings.TrimSpace(c.Query("q")); q != "" {
		if num := protocolos.Normalizar(q); num != "" {
			where = append(where, "p.protocolo_num = ?")
			args = append(args, num)
		} else {
			where = append(where, "(CAST(p.id_processo AS CHAR) = ? OR pr.cliente LIKE ? OR pr.uc = ? OR p.protocolo LIKE ?)")
			args = append(args, q, "%"+q+"%", q, "%"+q+"%")
		}
	}
	if s := c.Query("situacao"); s == "sem" {
		where = append(where, "p.situacao IS NULL")
	} else if s != "" {
		where = append(where, "p.situacao = ?")
		args = append(args, s)
	}
	if v := c.Query("vinculo"); v != "" {
		where = append(where, "p.status_vinculo = ?")
		args = append(args, v)
	}
	if d, _ := strconv.Atoi(c.Query("mudou_dias")); d > 0 {
		where = append(where, "p.ultima_mudanca_em >= NOW() - INTERVAL ? DAY")
		args = append(args, d)
	}
	var out []protLinha
	if err := database.GormDB_App.Raw(selProt+" WHERE "+strings.Join(where, " AND ")+
		" ORDER BY p.ultima_mudanca_em IS NULL, p.ultima_mudanca_em DESC, p.id DESC LIMIT 1500", args...).Scan(&out).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	var tot struct {
		Total       int        `gorm:"column:total" json:"total"`
		Processos   int        `gorm:"column:processos" json:"processos"`
		Mudou24h    int        `gorm:"column:mudou24h" json:"mudou_24h"`
		SemProcesso int        `gorm:"column:sem_processo" json:"sem_processo"`
		Confirmar   int        `gorm:"column:confirmar" json:"confirmar"`
		UltimaVerif *time.Time `gorm:"column:ultima_verif" json:"ultima_verificacao_em"`
	}
	database.GormDB_App.Raw(`SELECT COUNT(DISTINCT protocolo_num) AS total, COUNT(DISTINCT id_processo) AS processos,
		COUNT(DISTINCT CASE WHEN ultima_mudanca_em >= NOW() - INTERVAL 1 DAY THEN protocolo_num END) AS mudou24h,
		COUNT(DISTINCT CASE WHEN status_vinculo = 'sem_processo' THEN protocolo_num END) AS sem_processo,
		COUNT(DISTINCT CASE WHEN status_vinculo = 'confirmar' THEN protocolo_num END) AS confirmar,
		MAX(ultima_verificacao_em) AS ultima_verif
		FROM FT_PROTOCOLOS_ANEEL WHERE ativo = 1`).Scan(&tot)
	c.JSON(http.StatusOK, gin.H{"itens": out, "resumo": tot, "site_disponivel": protocolos.SiteDisponivel()})
}

// GET /protocolos-aneel/resumo-processos → { id_processo: {protocolo, situacao, ultima_mudanca_em, qtd} }
// (colunas "Protocolo ANEEL" e "Situação na ANEEL" do Controle de Processos)
func ResumoProtocolosPorProcesso(c *gin.Context) {
	if _, ok := protUsuario(c); !ok {
		return
	}
	var rows []struct {
		IDProcesso    int64
		Protocolo     string
		Situacao      string
		UltimaMudanca *time.Time
		Qtd           int
	}
	// por processo: o protocolo com a mudança mais recente
	database.GormDB_App.Raw(`SELECT x.id_processo, x.protocolo, COALESCE(x.situacao,'') AS situacao, x.ultima_mudanca_em AS ultima_mudanca, t.qtd
		FROM FT_PROTOCOLOS_ANEEL x
		JOIN (SELECT id_processo, COUNT(*) qtd,
		             SUBSTRING_INDEX(GROUP_CONCAT(id ORDER BY ultima_mudanca_em IS NULL, ultima_mudanca_em DESC, id DESC), ',', 1) AS top_id
		        FROM FT_PROTOCOLOS_ANEEL WHERE ativo = 1 AND id_processo IS NOT NULL GROUP BY id_processo) t
		  ON t.top_id = x.id`).Scan(&rows)
	out := make(map[string]gin.H, len(rows))
	for _, r := range rows {
		out[strconv.FormatInt(r.IDProcesso, 10)] = gin.H{"protocolo": r.Protocolo, "situacao": r.Situacao, "ultima_mudanca_em": r.UltimaMudanca, "qtd": r.Qtd}
	}
	c.JSON(http.StatusOK, out)
}

type protEvento struct {
	ID               int64      `json:"id"`
	ProtocoloNum     string     `json:"protocolo_num"`
	Fonte            string     `json:"fonte"`
	SituacaoAnterior string     `json:"situacao_anterior"`
	SituacaoNova     string     `json:"situacao_nova"`
	Andamento        string     `json:"andamento"`
	Assunto          string     `json:"assunto"`
	OcorridoEm       *time.Time `json:"ocorrido_em"`
}

func eventosDe(nums []string) []protEvento {
	out := []protEvento{}
	if len(nums) == 0 {
		return out
	}
	database.GormDB_App.Raw(`SELECT e.id, e.protocolo_num, e.fonte, COALESCE(e.situacao_anterior,'') AS situacao_anterior,
		COALESCE(e.situacao_nova,'') AS situacao_nova, COALESCE(e.andamento,'') AS andamento, COALESCE(m.subject,'') AS assunto, e.ocorrido_em
		FROM FT_PROTOCOLO_EVENTOS e LEFT JOIN mail_messages m ON m.id = e.id_mail_message
		WHERE e.protocolo_num IN ? ORDER BY e.ocorrido_em DESC, e.id DESC LIMIT 200`, nums).Scan(&out)
	return out
}

// GET /protocolos-aneel/processo/:id → protocolos do processo + linha do tempo
func ProtocolosDoProcesso(c *gin.Context) {
	if _, ok := protUsuario(c); !ok {
		return
	}
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	var itens []protLinha
	database.GormDB_App.Raw(selProt+" WHERE p.ativo = 1 AND p.id_processo = ? ORDER BY p.ultima_mudanca_em DESC, p.id DESC", id).Scan(&itens)
	nums := []string{}
	for _, i := range itens {
		nums = append(nums, i.ProtocoloNum)
	}
	c.JSON(http.StatusOK, gin.H{"itens": itens, "eventos": eventosDe(nums)})
}

// GET /protocolos-aneel/consulta?protocolo= → o que o sistema sabe + sugestão de processo
func ConsultarProtocoloAneel(c *gin.Context) {
	if _, ok := protUsuario(c); !ok {
		return
	}
	num := protocolos.Normalizar(c.Query("protocolo"))
	if num == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "protocolo inválido — são 13 números começando com 010 (ex.: 010.665.84026-55)"})
		return
	}
	var itens []protLinha
	database.GormDB_App.Raw(selProt+" WHERE p.ativo = 1 AND p.protocolo_num = ?", num).Scan(&itens)
	// sugestões: processos aos quais algum e-mail da ANEEL com este protocolo já foi anexado
	var sug []struct {
		IDProcesso     int64  `json:"id_processo"`
		Cliente        string `json:"cliente"`
		Concessionaria string `json:"concessionaria"`
		UC             string `json:"uc"`
		Motivo         string `json:"motivo"`
	}
	fmtP := protocolos.Formatar(num)
	database.GormDB_App.Raw(`SELECT DISTINCT pr.id_processo, COALESCE(pr.cliente,'') AS cliente, COALESCE(pr.concessionaria,'') AS concessionaria,
		COALESCE(pr.uc,'') AS uc, 'e-mail da ANEEL com este protocolo já está neste processo' AS motivo
		FROM FT_EMAILS_PROCESSO e JOIN FT_PROCESSOS pr ON pr.id_processo = e.id_processo
		WHERE (e.assunto LIKE ? OR e.assunto LIKE ?) LIMIT 5`, "%"+num+"%", "%"+fmtP+"%").Scan(&sug)
	c.JSON(http.StatusOK, gin.H{
		"protocolo":       fmtP,
		"protocolo_num":   num,
		"itens":           itens,
		"eventos":         eventosDe([]string{num}),
		"sugestoes":       sug,
		"site_disponivel": protocolos.SiteDisponivel(),
		"aviso_site":      "A consulta direta no site da ANEEL ainda não está liberada (o site bloqueia acesso automático). Mostramos o que chegou pelos e-mails da ANEEL e pelo histórico.",
	})
}

// POST /protocolos-aneel/vincular {protocolo, id_processo (0 = só acompanhar), id_responsavel}
func VincularProtocoloAneel(c *gin.Context) {
	u, ok := protUsuario(c)
	if !ok {
		return
	}
	var b struct {
		Protocolo     string `json:"protocolo"`
		IDProcesso    int64  `json:"id_processo"`
		IDResponsavel int64  `json:"id_responsavel"`
	}
	_ = c.ShouldBindJSON(&b)
	num := protocolos.Normalizar(b.Protocolo)
	if num == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "protocolo inválido"})
		return
	}
	db := database.GormDB_App
	if b.IDProcesso > 0 {
		var n int
		db.Raw("SELECT COUNT(*) FROM FT_PROCESSOS WHERE id_processo = ?", b.IDProcesso).Row().Scan(&n)
		if n == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "processo não encontrado"})
			return
		}
		agora := time.Now()
		protocolos.VincularSeNovo(db, num, b.IDProcesso, "manual", nil, u.id, &agora)
		db.Exec("UPDATE FT_PROTOCOLOS_ANEEL SET ativo = 1, criado_por = COALESCE(criado_por, ?) WHERE protocolo_num = ? AND id_processo = ?", u.id, num, b.IDProcesso)
	} else {
		var n int
		db.Raw("SELECT COUNT(*) FROM FT_PROTOCOLOS_ANEEL WHERE protocolo_num = ? AND ativo = 1", num).Row().Scan(&n)
		if n == 0 {
			db.Exec(`INSERT INTO FT_PROTOCOLOS_ANEEL (protocolo, protocolo_num, id_processo, status_vinculo, origem, criado_por)
				VALUES (?, ?, NULL, 'sem_processo', 'manual', ?)`, protocolos.Formatar(num), num, u.id)
		}
	}
	if b.IDResponsavel > 0 {
		q := "UPDATE FT_PROTOCOLOS_ANEEL SET id_usuario_responsavel = ? WHERE protocolo_num = ? AND ativo = 1"
		args := []any{b.IDResponsavel, num}
		if b.IDProcesso > 0 {
			q += " AND id_processo = ?"
			args = append(args, b.IDProcesso)
		}
		db.Exec(q, args...)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /protocolos-aneel/:id/responsavel {id_usuario} (0 = tirar)
func ResponsavelProtocoloAneel(c *gin.Context) {
	if _, ok := protUsuario(c); !ok {
		return
	}
	var b struct {
		IDUsuario int64 `json:"id_usuario"`
	}
	_ = c.ShouldBindJSON(&b)
	var v any
	if b.IDUsuario > 0 {
		v = b.IDUsuario
	}
	database.GormDB_App.Exec("UPDATE FT_PROTOCOLOS_ANEEL SET id_usuario_responsavel = ? WHERE id = ?", v, c.Param("id"))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /protocolos-aneel/:id/confirmar {manter} — protocolo em mais de um processo: admin decide.
// manter=false desliga o vínculo (ativo=0), nunca apaga.
func ConfirmarVinculoProtocoloAneel(c *gin.Context) {
	u, ok := protUsuario(c)
	if !ok {
		return
	}
	if !u.isAdmin {
		c.JSON(http.StatusForbidden, gin.H{"error": "só o administrador"})
		return
	}
	var b struct {
		Manter bool `json:"manter"`
	}
	_ = c.ShouldBindJSON(&b)
	db := database.GormDB_App
	var num string
	db.Raw("SELECT protocolo_num FROM FT_PROTOCOLOS_ANEEL WHERE id = ?", c.Param("id")).Row().Scan(&num)
	if b.Manter {
		db.Exec("UPDATE FT_PROTOCOLOS_ANEEL SET status_vinculo = 'vinculado' WHERE id = ?", c.Param("id"))
	} else {
		db.Exec("UPDATE FT_PROTOCOLOS_ANEEL SET ativo = 0 WHERE id = ?", c.Param("id"))
	}
	// sobrou um só vínculo ativo → deixa de ser "confirmar"
	var n int
	db.Raw("SELECT COUNT(*) FROM FT_PROTOCOLOS_ANEEL WHERE protocolo_num = ? AND ativo = 1", num).Row().Scan(&n)
	if n == 1 {
		db.Exec("UPDATE FT_PROTOCOLOS_ANEEL SET status_vinculo = 'vinculado' WHERE protocolo_num = ? AND ativo = 1 AND status_vinculo = 'confirmar'", num)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /protocolos-aneel/sincronizar — "Atualizar agora" (admin)
func SincronizarProtocolosAneel(c *gin.Context) {
	u, ok := protUsuario(c)
	if !ok {
		return
	}
	if !u.isAdmin {
		c.JSON(http.StatusForbidden, gin.H{"error": "só o administrador"})
		return
	}
	r, err := protocolos.Sincronizar()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"ok": false, "erro": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "resultado": r})
}

// GET /protocolos-aneel/site/abertos[?todos=1] → protocolos ainda não concluídos (todos=1: todos, só admin),
// para a extensão consultar no site
func AbertosSiteAneel(c *gin.Context) {
	u, ok := protUsuario(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"protocolos": protocolos.AbertosNoSite(u.isAdmin && c.Query("todos") == "1")})
}

// POST /protocolos-aneel/site/importar {itens:[{protocolo,status,ultima_mov,entrada,resposta}]}
// — resultado que a extensão leu no site da ANEEL, na sessão aberta pelo próprio usuário.
func ImportarSiteAneel(c *gin.Context) {
	if _, ok := protUsuario(c); !ok {
		return
	}
	var body struct {
		Itens []protocolos.ItemSite `json:"itens"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.Itens) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nenhum protocolo recebido"})
		return
	}
	if len(body.Itens) > 3000 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "lote grande demais"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "resultado": protocolos.ImportarSite(body.Itens)})
}

// GET /protocolos-aneel/analistas → equipe interna ativa (para escolher responsável)
func AnalistasProtocolosAneel(c *gin.Context) {
	if _, ok := protUsuario(c); !ok {
		return
	}
	var out []struct {
		ID   int64  `json:"id"`
		Nome string `json:"nome"`
	}
	database.GormDB_App.Raw(`SELECT id_usuario AS id, nome_usuario AS nome FROM DM_USUARIO
		WHERE usuario_ativo = 1 AND COALESCE(perfil,'') <> 'solicitante' AND COALESCE(nome_usuario,'') <> ''
		  AND LOWER(nome_usuario) <> 'sistema'
		ORDER BY nome_usuario`).Scan(&out)
	c.JSON(http.StatusOK, out)
}

// ── tarefas ────────────────────────────────────────────────────────────────

type tarefaLinha struct {
	ID             int64      `json:"id_tarefa"`
	Tipo           string     `json:"tipo"`
	Titulo         string     `json:"titulo"`
	Descricao      string     `json:"descricao"`
	IDProcesso     *int64     `json:"id_processo"`
	ProtocoloNum   string     `json:"protocolo_num"`
	SitAnterior    string     `json:"situacao_anterior"`
	SitNova        string     `json:"situacao_nova"`
	IDResponsavel  *int64     `json:"id_responsavel"`
	Responsavel    string     `json:"responsavel"`
	Status         string     `json:"status"`
	CriadoEm       *time.Time `json:"criado_em"`
	ConcluidaEm    *time.Time `json:"concluida_em"`
	Comentario     string     `json:"comentario_conclusao"`
	Cliente        string     `json:"cliente"`
	Concessionaria string     `json:"concessionaria"`
}

// GET /tarefas?status=abertas|concluidas&minhas=1
func ListarTarefas(c *gin.Context) {
	u, ok := protUsuario(c)
	if !ok {
		return
	}
	where := []string{"1=1"}
	args := []any{}
	if c.Query("status") == "concluidas" {
		where = append(where, "t.status = 'concluida' AND t.concluida_em >= NOW() - INTERVAL 30 DAY")
	} else {
		where = append(where, "t.status <> 'concluida'")
	}
	if c.Query("minhas") == "1" || !u.isAdmin {
		where = append(where, "t.id_usuario_responsavel = ?")
		args = append(args, u.id)
	}
	var out []tarefaLinha
	database.GormDB_App.Raw(`SELECT t.id_tarefa AS id, t.tipo, t.titulo, COALESCE(t.descricao,'') AS descricao, t.id_processo,
		COALESCE(t.protocolo_num,'') AS protocolo_num, COALESCE(e.situacao_anterior,'') AS sit_anterior, COALESCE(e.situacao_nova,'') AS sit_nova,
		t.id_usuario_responsavel AS id_responsavel, COALESCE(u.nome_usuario,'') AS responsavel, t.status, t.criado_em, t.concluida_em,
		COALESCE(t.comentario_conclusao,'') AS comentario, COALESCE(pr.cliente,'') AS cliente, COALESCE(pr.concessionaria,'') AS concessionaria
		FROM FT_TAREFAS t
		LEFT JOIN FT_PROTOCOLO_EVENTOS e ON e.id = t.id_evento
		LEFT JOIN DM_USUARIO u ON u.id_usuario = t.id_usuario_responsavel
		LEFT JOIN FT_PROCESSOS pr ON pr.id_processo = t.id_processo
		WHERE `+strings.Join(where, " AND ")+` ORDER BY t.id_usuario_responsavel IS NOT NULL, t.criado_em DESC LIMIT 500`, args...).Scan(&out)
	c.JSON(http.StatusOK, out)
}

// POST /tarefas/:id/direcionar {id_usuario} — admin
func DirecionarTarefa(c *gin.Context) {
	u, ok := protUsuario(c)
	if !ok {
		return
	}
	if !u.isAdmin {
		c.JSON(http.StatusForbidden, gin.H{"error": "só o administrador direciona tarefas"})
		return
	}
	var b struct {
		IDUsuario int64 `json:"id_usuario"`
	}
	_ = c.ShouldBindJSON(&b)
	if b.IDUsuario <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "escolha o analista"})
		return
	}
	db := database.GormDB_App
	if err := db.Exec(`UPDATE FT_TAREFAS SET id_usuario_responsavel = ?, direcionado_por = ?, direcionado_em = NOW(), ciente_em = NULL, status = 'aberta'
		WHERE id_tarefa = ? AND status <> 'concluida'`, b.IDUsuario, u.id, c.Param("id")).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	var t struct {
		Titulo       string
		ProtocoloNum string
		IDProcesso   *int64
	}
	db.Raw("SELECT titulo, COALESCE(protocolo_num,'') AS protocolo_num, id_processo FROM FT_TAREFAS WHERE id_tarefa = ?", c.Param("id")).Scan(&t)
	msg := "Nova tarefa para você: " + t.Titulo
	if t.ProtocoloNum != "" {
		msg += " — protocolo ANEEL " + protocolos.Formatar(t.ProtocoloNum)
	}
	if t.IDProcesso != nil {
		msg += " (processo #" + strconv.FormatInt(*t.IDProcesso, 10) + ")"
	}
	rotinas.NotificarNoSistema(db, b.IDUsuario, msg)
	var nome string
	_ = db.Raw("SELECT COALESCE(nome_usuario,'') FROM DM_USUARIO WHERE id_usuario = ?", b.IDUsuario).Row().Scan(&nome)
	// *texto* = negrito no WhatsApp: o nome de quem recebeu fica em destaque
	whatsapp.AvisarGrupo("Tarefa direcionada para *" + nome + "*: " + strings.TrimPrefix(msg, "Nova tarefa para você: "))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /tarefas/:id/concluir {comentario} — o responsável ou o admin
func ConcluirTarefa(c *gin.Context) {
	u, ok := protUsuario(c)
	if !ok {
		return
	}
	var b struct {
		Comentario string `json:"comentario"`
	}
	_ = c.ShouldBindJSON(&b)
	q := "UPDATE FT_TAREFAS SET status = 'concluida', concluida_em = NOW(), comentario_conclusao = ? WHERE id_tarefa = ? AND status <> 'concluida'"
	args := []any{strings.TrimSpace(b.Comentario), c.Param("id")}
	if !u.isAdmin {
		q += " AND id_usuario_responsavel = ?"
		args = append(args, u.id)
	}
	res := database.GormDB_App.Exec(q, args...)
	if res.Error != nil || res.RowsAffected == 0 {
		c.JSON(http.StatusOK, gin.H{"ok": false, "erro": "tarefa não encontrada ou não é sua"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GET /tarefas/regras → cada tipo de mudança e o analista que recebe a tarefa (nil = admin direciona)
func ListarRegrasTarefa(c *gin.Context) {
	if _, ok := protUsuario(c); !ok {
		return
	}
	var salvas []struct {
		Chave         string
		IDResponsavel *int64
		Responsavel   string
	}
	// tabela ainda não criada (antes do deploy) → todas sem analista
	database.GormDB_App.Raw(`SELECT r.chave, r.id_usuario_responsavel AS id_responsavel, COALESCE(u.nome_usuario,'') AS responsavel
		FROM FT_TAREFAS_REGRAS r LEFT JOIN DM_USUARIO u ON u.id_usuario = r.id_usuario_responsavel`).Scan(&salvas)
	type regra struct {
		Chave         string `json:"chave"`
		Rotulo        string `json:"rotulo"`
		IDResponsavel *int64 `json:"id_responsavel"`
		Responsavel   string `json:"responsavel"`
	}
	out := make([]regra, 0, len(protocolos.RegrasTarefa))
	for _, r := range protocolos.RegrasTarefa {
		item := regra{Chave: r.Chave, Rotulo: r.Rotulo}
		for _, s := range salvas {
			if s.Chave == r.Chave {
				item.IDResponsavel, item.Responsavel = s.IDResponsavel, s.Responsavel
			}
		}
		out = append(out, item)
	}
	c.JSON(http.StatusOK, out)
}

// POST /tarefas/regras {chave, id_usuario} — admin; id_usuario 0 = volta para "admin direciona"
func SalvarRegraTarefa(c *gin.Context) {
	u, ok := protUsuario(c)
	if !ok {
		return
	}
	if !u.isAdmin {
		c.JSON(http.StatusForbidden, gin.H{"error": "só o administrador muda as regras"})
		return
	}
	var b struct {
		Chave     string `json:"chave"`
		IDUsuario int64  `json:"id_usuario"`
	}
	_ = c.ShouldBindJSON(&b)
	valida := false
	for _, r := range protocolos.RegrasTarefa {
		valida = valida || r.Chave == b.Chave
	}
	if !valida {
		c.JSON(http.StatusBadRequest, gin.H{"error": "regra desconhecida"})
		return
	}
	var resp any
	if b.IDUsuario > 0 {
		resp = b.IDUsuario
	}
	if err := database.GormDB_App.Exec(`INSERT INTO FT_TAREFAS_REGRAS (chave, id_usuario_responsavel, atualizado_por) VALUES (?, ?, ?)
		ON DUPLICATE KEY UPDATE id_usuario_responsavel = VALUES(id_usuario_responsavel), atualizado_por = VALUES(atualizado_por)`,
		b.Chave, resp, u.id).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
