package handlers

// Rotinas (#rotina no chat) e lembretes entre usuários — ver backend/rotinas.
// Só o admin aprova/rejeita/reativa e vê todas; o dono vê as próprias e pode pausar/desativar.

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"ressarcimento-backend/database"
	"ressarcimento-backend/rotinas"

	"github.com/gin-gonic/gin"
)

type rotCtx struct {
	id      int64
	nome    string
	role    string
	isAdmin bool
}

func rotUsuario(c *gin.Context) (rotCtx, bool) {
	v, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "não autenticado"})
		return rotCtx{}, false
	}
	u := rotCtx{}
	switch x := v.(type) {
	case int64:
		u.id = x
	case int:
		u.id = int64(x)
	case float64:
		u.id = int64(x)
	}
	u.nome = c.GetString("userName")
	u.role = c.GetString("role")
	u.isAdmin = c.GetBool("isAdmin")
	if u.nome == "" {
		_ = database.GormDB_App.Raw("SELECT COALESCE(nome_usuario,'') FROM DM_USUARIO WHERE id_usuario = ?", u.id).Row().Scan(&u.nome)
	}
	if u.role == "solicitante" {
		c.JSON(http.StatusForbidden, gin.H{"error": "rotinas e lembretes são da equipe interna"})
		return u, false
	}
	return u, true
}

// POST /rotinas/interpretar {texto, de_rotina} → prévia em linguagem simples (não grava nada)
func InterpretarRotinaHandler(c *gin.Context) {
	u, ok := rotUsuario(c)
	if !ok {
		return
	}
	var b struct {
		Texto    string `json:"texto"`
		DeRotina bool   `json:"de_rotina"`
	}
	_ = c.ShouldBindJSON(&b)
	if strings.TrimSpace(b.Texto) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "erro": "descreva a rotina"})
		return
	}
	p, err := rotinas.InterpretarRotina(database.GormDB_App, b.Texto, b.DeRotina, u.id, u.nome)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"ok": false, "erro": err.Error()})
		return
	}
	aviso := "Vai para aprovação do administrador antes de começar."
	if u.isAdmin {
		aviso = "Como você é administrador, ela já começa aprovada."
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "plano": p, "resumo": p.Resumo, "aviso": aviso})
}

// POST /rotinas {texto, de_rotina} — reinterpreta no servidor (não confia no plano do front) e grava.
func CriarRotinaHandler(c *gin.Context) {
	u, ok := rotUsuario(c)
	if !ok {
		return
	}
	var b struct {
		Texto    string `json:"texto"`
		DeRotina bool   `json:"de_rotina"`
	}
	_ = c.ShouldBindJSON(&b)
	p, err := rotinas.InterpretarRotina(database.GormDB_App, b.Texto, b.DeRotina, u.id, u.nome)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	id, status, err := rotinas.Criar(database.GormDB_App, p, b.Texto, u.id, u.nome, u.isAdmin)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao gravar a rotina"})
		return
	}
	msg := fmt.Sprintf("Rotina #%d criada e enviada para aprovação do administrador.", id)
	if status == rotinas.StatusAtiva {
		if p.Tipo == "unica" {
			msg = fmt.Sprintf("Rotina #%d aprovada — roda em até 1 minuto; o resultado chega nos seus alertas.", id)
		} else {
			msg = fmt.Sprintf("Rotina #%d criada e já ativa.", id)
		}
	}
	c.JSON(http.StatusCreated, gin.H{"id_rotina": id, "status": status, "resumo": p.Resumo, "mensagem": msg})
}

// GET /rotinas?status=&id_usuario=  (admin vê todas; demais, só as próprias)
func ListarRotinasHandler(c *gin.Context) {
	u, ok := rotUsuario(c)
	if !ok {
		return
	}
	alvo := u.id
	if u.isAdmin {
		alvo, _ = strconv.ParseInt(c.Query("id_usuario"), 10, 64)
	}
	l, err := rotinas.Listar(database.GormDB_App, alvo, c.Query("status"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao listar rotinas"})
		return
	}
	c.JSON(http.StatusOK, l)
}

// POST /rotinas/:id/acao {acao: aprovar|rejeitar|pausar|reativar|desativar, motivo}
func AcaoRotinaHandler(c *gin.Context) {
	u, ok := rotUsuario(c)
	if !ok {
		return
	}
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	var b struct {
		Acao   string `json:"acao"`
		Motivo string `json:"motivo"`
	}
	_ = c.ShouldBindJSON(&b)
	r, err := rotinas.Obter(database.GormDB_App, id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	soAdmin := b.Acao == "aprovar" || b.Acao == "rejeitar" || b.Acao == "reativar"
	if !u.isAdmin && (soAdmin || r.IDUsuario != u.id) {
		c.JSON(http.StatusForbidden, gin.H{"error": "só o administrador pode " + b.Acao + " esta rotina"})
		return
	}
	nr, err := rotinas.MudarStatus(database.GormDB_App, id, b.Acao, u.id, u.nome, strings.TrimSpace(b.Motivo))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, nr)
}

// POST /rotinas/usuario/:id/desativar-todas {motivo} — pessoa desligada: desativa, não apaga.
func DesativarRotinasUsuarioHandler(c *gin.Context) {
	u, ok := rotUsuario(c)
	if !ok {
		return
	}
	if !u.isAdmin {
		c.JSON(http.StatusForbidden, gin.H{"error": "só o administrador"})
		return
	}
	alvo, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	var b struct {
		Motivo string `json:"motivo"`
	}
	_ = c.ShouldBindJSON(&b)
	if strings.TrimSpace(b.Motivo) == "" {
		b.Motivo = "desativadas pelo administrador"
	}
	n, err := rotinas.DesativarTodasDoUsuario(database.GormDB_App, alvo, u.id, u.nome, b.Motivo)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"desativadas": n})
}

// GET /rotinas/:id/execucoes
func ExecucoesRotinaHandler(c *gin.Context) {
	u, ok := rotUsuario(c)
	if !ok {
		return
	}
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	r, err := rotinas.Obter(database.GormDB_App, id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if !u.isAdmin && r.IDUsuario != u.id {
		c.JSON(http.StatusForbidden, gin.H{"error": "sem acesso"})
		return
	}
	l, err := rotinas.ListarExecucoes(database.GormDB_App, id, 100)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, l)
}

// POST /rotinas/execucoes/:id/desfazer (admin)
func DesfazerExecucaoHandler(c *gin.Context) {
	u, ok := rotUsuario(c)
	if !ok {
		return
	}
	if !u.isAdmin {
		c.JSON(http.StatusForbidden, gin.H{"error": "só o administrador"})
		return
	}
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	n, err := rotinas.DesfazerExecucao(database.GormDB_App, id, u.id, u.nome)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"desfeitos": n})
}

// GET /rotinas/historico/:id_usuario — "documento" do usuário (admin, ou o próprio)
func HistoricoRotinasUsuarioHandler(c *gin.Context) {
	u, ok := rotUsuario(c)
	if !ok {
		return
	}
	alvo, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	if !u.isAdmin && alvo != u.id {
		c.JSON(http.StatusForbidden, gin.H{"error": "sem acesso"})
		return
	}
	ev, err := rotinas.HistoricoUsuario(database.GormDB_App, alvo, 500)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	rs, _ := rotinas.Listar(database.GormDB_App, alvo, "")
	c.JSON(http.StatusOK, gin.H{"rotinas": rs, "eventos": ev})
}

// GET /rotinas/usuarios (admin) — usuários com contagem de rotinas
func UsuariosRotinasHandler(c *gin.Context) {
	u, ok := rotUsuario(c)
	if !ok {
		return
	}
	if !u.isAdmin {
		c.JSON(http.StatusForbidden, gin.H{"error": "só o administrador"})
		return
	}
	rows, err := database.GormDB_App.Raw(`
		SELECT u.id_usuario, COALESCE(u.nome_usuario,''), COALESCE(u.email,''), COALESCE(u.perfil,''), COALESCE(u.usuario_ativo,0),
		       COUNT(r.id_rotina),
		       COALESCE(SUM(r.status = 'ativa'),0),
		       COALESCE(SUM(r.status = 'aguardando_aprovacao'),0),
		       (SELECT COUNT(*) FROM FT_ROTINA_EVENTOS e WHERE e.id_usuario_dono = u.id_usuario OR e.id_usuario_ator = u.id_usuario)
		  FROM DM_USUARIO u
		  LEFT JOIN FT_ROTINAS r ON r.id_usuario = u.id_usuario
		 WHERE COALESCE(u.perfil,'') <> 'solicitante'
		 GROUP BY u.id_usuario, u.nome_usuario, u.email, u.perfil, u.usuario_ativo
		 ORDER BY u.usuario_ativo DESC, u.nome_usuario`).Rows()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id int64
		var nome, email, perfil string
		var ativo, total, ativas, aguard, eventos int
		if rows.Scan(&id, &nome, &email, &perfil, &ativo, &total, &ativas, &aguard, &eventos) != nil {
			continue
		}
		out = append(out, gin.H{"id_usuario": id, "nome": nome, "email": email, "perfil": perfil, "ativo": ativo == 1,
			"rotinas": total, "ativas": ativas, "aguardando": aguard, "eventos": eventos})
	}
	c.JSON(http.StatusOK, out)
}

// POST /lembretes/interpretar {texto} — prévia (não grava)
func InterpretarLembreteHandler(c *gin.Context) {
	u, ok := rotUsuario(c)
	if !ok {
		return
	}
	var b struct {
		Texto string `json:"texto"`
	}
	_ = c.ShouldBindJSON(&b)
	pl, err := rotinas.InterpretarLembrete(database.GormDB_App, b.Texto, u.id, u.nome)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"ok": false, "erro": err.Error()})
		return
	}
	if len(pl.Candidatos) > 0 {
		c.JSON(http.StatusOK, gin.H{"ok": false, "erro": pl.Resumo, "candidatos": pl.Candidatos})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "lembrete": pl, "resumo": pl.Resumo})
}

// POST /lembretes {texto} — reinterpreta e grava no calendário do destinatário.
func CriarLembreteHandler(c *gin.Context) {
	u, ok := rotUsuario(c)
	if !ok {
		return
	}
	var b struct {
		Texto string `json:"texto"`
	}
	_ = c.ShouldBindJSON(&b)
	pl, err := rotinas.InterpretarLembrete(database.GormDB_App, b.Texto, u.id, u.nome)
	if err != nil || len(pl.Candidatos) > 0 {
		msg := "não entendi o lembrete"
		if err != nil {
			msg = err.Error()
		} else {
			msg = pl.Resumo
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": msg})
		return
	}
	id, err := rotinas.CriarLembrete(database.GormDB_App, u.id, u.nome, pl.DestinoID, pl.Data, pl.Hora, pl.Mensagem, pl.IDProcesso)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao gravar o lembrete"})
		return
	}
	rotinas.RegistrarEvento(database.GormDB_App, nil, u.id, u.id, u.nome, "lembrete_criado",
		fmt.Sprintf("lembrete #%d para %s em %s %s: %s", id, pl.NomeDestino, pl.Data, pl.Hora, pl.Mensagem))
	c.JSON(http.StatusCreated, gin.H{"id_alerta": id, "mensagem": "Lembrete criado. " + pl.Resumo})
}
