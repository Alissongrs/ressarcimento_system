// Package rotinas — tarefas agendadas criadas no chat (#rotina) e lembretes entre usuários.
//
// Regras (pedido do Alisson, 21/10/2026):
//   - qualquer usuário interno descreve a rotina no chat; ela nasce "aguardando_aprovacao";
//   - SÓ o administrador aprova (a aprovação é a autorização para a rotina gravar no banco);
//     rotina criada pelo próprio admin já nasce aprovada;
//   - usuário desligado (DM_USUARIO.usuario_ativo=0) → rotinas DESATIVADAS, nunca apagadas;
//   - tudo fica registrado: FT_ROTINAS (cadastro), FT_ROTINA_EXECUCOES (cada rodada, com o que
//     mudou → dá para desfazer) e FT_ROTINA_EVENTOS (histórico por usuário).
//
// Operações suportadas: sincronizar_emails (vincula e-mail órfão a processo só com PROVA única —
// repositories.FindProcessByEvidencia) e lembrete (alerta no calendário do SURE + e-mail na hora).
package rotinas

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"html"
	"log"
	"regexp"
	"strings"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/repositories"
	"ressarcimento-backend/services"
	"ressarcimento-backend/sse"

	"gorm.io/gorm"
)

const (
	StatusAguardando = "aguardando_aprovacao"
	StatusAtiva      = "ativa"
	StatusPausada    = "pausada"
	StatusDesativada = "desativada"
	StatusRejeitada  = "rejeitada"
	StatusConcluida  = "concluida"
)

// Loc: horários das rotinas são sempre de Brasília, independente do TZ do container.
var Loc = func() *time.Location {
	if l, err := time.LoadLocation("America/Sao_Paulo"); err == nil {
		return l
	}
	return time.FixedZone("BRT", -3*3600)
}()

type Rotina struct {
	ID            int64          `json:"id_rotina"`
	IDUsuario     int64          `json:"id_usuario"`
	NomeUsuario   string         `json:"nome_usuario"`
	TextoOriginal string         `json:"texto_original"`
	Op            string         `json:"op"`
	Params        map[string]any `json:"params"`
	Tipo          string         `json:"tipo"` // recorrente | unica
	Horarios      string         `json:"horarios"`
	Dias          string         `json:"dias"`
	Resumo        string         `json:"resumo"`
	Status        string         `json:"status"`
	AprovadoPor   *int64         `json:"aprovado_por,omitempty"`
	AprovadoEm    *time.Time     `json:"aprovado_em,omitempty"`
	MotivoStatus  string         `json:"motivo_status,omitempty"`
	UltimaExec    *time.Time     `json:"ultima_execucao,omitempty"`
	CriadoEm      time.Time      `json:"criado_em"`
	UsuarioAtivo  bool           `json:"usuario_ativo"`
}

func gdb() *gorm.DB { return database.GormDB_App }

// ── eventos (histórico por usuário) ───────────────────────────────────────

func RegistrarEvento(db *gorm.DB, idRotina *int64, dono, ator int64, nomeAtor, evento, detalhe string) {
	if len([]rune(detalhe)) > 500 {
		detalhe = string([]rune(detalhe)[:500])
	}
	if err := db.Exec(`INSERT INTO FT_ROTINA_EVENTOS (id_rotina, id_usuario_dono, id_usuario_ator, nome_ator, evento, detalhe)
		VALUES (?, ?, ?, ?, ?, ?)`, idRotina, dono, ator, nomeAtor, evento, detalhe).Error; err != nil {
		log.Printf("[rotinas] evento %s: %v", evento, err)
	}
}

// ── cadastro ──────────────────────────────────────────────────────────────

// Criar grava a rotina interpretada. Admin → já ativa; demais → aguardando aprovação
// (e os admins recebem um alerta no sistema).
func Criar(db *gorm.DB, p *Plano, texto string, userID int64, userName string, isAdmin bool) (int64, string, error) {
	params, _ := json.Marshal(p.Params)
	status := StatusAguardando
	var aprovPor any
	var aprovEm any
	if isAdmin {
		status = StatusAtiva
		aprovPor = userID
		aprovEm = time.Now().In(Loc).Format("2006-01-02 15:04:05")
	}
	var id int64
	err := db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`INSERT INTO FT_ROTINAS (id_usuario, nome_usuario, texto_original, op, params_json, tipo, horarios, dias,
				resumo, status, aprovado_por, aprovado_em)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			userID, userName, texto, p.Op, string(params), p.Tipo, strings.Join(p.Horarios, ","), p.Dias,
			p.Resumo, status, aprovPor, aprovEm).Error; err != nil {
			return err
		}
		return tx.Raw("SELECT LAST_INSERT_ID()").Row().Scan(&id) // mesma conexão (transação)
	})
	if err != nil {
		return 0, "", err
	}
	RegistrarEvento(db, &id, userID, userID, userName, "criada", p.Resumo)
	if isAdmin {
		RegistrarEvento(db, &id, userID, userID, userName, "aprovada", "criada pelo administrador (aprovação automática)")
	} else {
		avisarAdmins(db, fmt.Sprintf("Rotina #%d de %s aguardando sua aprovação: %s", id, userName, p.Resumo))
	}
	return id, status, nil
}

func avisarAdmins(db *gorm.DB, msg string) {
	rows, err := db.Raw(`SELECT id_usuario FROM DM_USUARIO WHERE usuario_ativo = 1 AND perfil = 'admin'`).Rows()
	if err != nil {
		return
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		NotificarNoSistema(db, id, msg)
	}
}

// NotificarNoSistema: alerta só na tela (data_alerta NULL → não gera e-mail).
func NotificarNoSistema(db *gorm.DB, userID int64, msg string) {
	if len([]rune(msg)) > 255 {
		msg = string([]rune(msg)[:252]) + "..."
	}
	if err := db.Exec(`INSERT INTO FT_ALERTAS (id_usuario, mensagem, lido, acknowledged, data_criacao, para_todos)
		VALUES (?, ?, 0, 0, NOW(), 0)`, userID, msg).Error; err != nil {
		log.Printf("[rotinas] notificar %d: %v", userID, err)
		return
	}
	sse.BroadcastUser(userID, sse.Event{Type: "alerta_novo", Payload: map[string]any{"mensagem": msg, "aviso": true}})
	notificarNaoLidos(db, userID)
}

func notificarNaoLidos(db *gorm.DB, userID int64) {
	var n int
	_ = db.Raw("SELECT COUNT(*) FROM FT_ALERTAS WHERE id_usuario=? AND lido=0", userID).Row().Scan(&n)
	sse.BroadcastUser(userID, sse.Event{Type: "alerta_unread", Payload: map[string]any{"unread": n}})
}

const selRotina = `SELECT r.id_rotina, r.id_usuario, COALESCE(r.nome_usuario,''), COALESCE(r.texto_original,''), r.op,
	COALESCE(r.params_json,'{}'), r.tipo, COALESCE(r.horarios,''), COALESCE(r.dias,'*'), COALESCE(r.resumo,''), r.status,
	r.aprovado_por, r.aprovado_em, COALESCE(r.motivo_status,''), r.ultima_execucao, r.criado_em,
	COALESCE(u.usuario_ativo,0)
	FROM FT_ROTINAS r LEFT JOIN DM_USUARIO u ON u.id_usuario = r.id_usuario `

func scanRotinas(rows *sql.Rows) []Rotina {
	out := []Rotina{}
	for rows.Next() {
		var r Rotina
		var params string
		var aprovPor sql.NullInt64
		var aprovEm, ult sql.NullTime
		var ativo int
		if err := rows.Scan(&r.ID, &r.IDUsuario, &r.NomeUsuario, &r.TextoOriginal, &r.Op, &params, &r.Tipo, &r.Horarios,
			&r.Dias, &r.Resumo, &r.Status, &aprovPor, &aprovEm, &r.MotivoStatus, &ult, &r.CriadoEm, &ativo); err != nil {
			log.Printf("[rotinas] scan: %v", err)
			continue
		}
		_ = json.Unmarshal([]byte(params), &r.Params)
		if aprovPor.Valid {
			v := aprovPor.Int64
			r.AprovadoPor = &v
		}
		if aprovEm.Valid {
			r.AprovadoEm = &aprovEm.Time
		}
		if ult.Valid {
			r.UltimaExec = &ult.Time
		}
		r.UsuarioAtivo = ativo == 1
		out = append(out, r)
	}
	return out
}

// Listar: idUsuario 0 = todas (admin).
func Listar(db *gorm.DB, idUsuario int64, status string) ([]Rotina, error) {
	q := selRotina + " WHERE 1=1"
	args := []any{}
	if idUsuario > 0 {
		q += " AND r.id_usuario = ?"
		args = append(args, idUsuario)
	}
	if status != "" {
		q += " AND r.status = ?"
		args = append(args, status)
	}
	q += " ORDER BY FIELD(r.status,'aguardando_aprovacao','ativa','pausada','concluida','rejeitada','desativada'), r.id_rotina DESC"
	rows, err := db.Raw(q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRotinas(rows), nil
}

func Obter(db *gorm.DB, id int64) (*Rotina, error) {
	rows, err := db.Raw(selRotina+" WHERE r.id_rotina = ?", id).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	l := scanRotinas(rows)
	if len(l) == 0 {
		return nil, fmt.Errorf("rotina %d não encontrada", id)
	}
	return &l[0], nil
}

// MudarStatus aplica aprovar/rejeitar/pausar/reativar/desativar com a transição válida.
func MudarStatus(db *gorm.DB, id int64, acao string, ator int64, nomeAtor, motivo string) (*Rotina, error) {
	r, err := Obter(db, id)
	if err != nil {
		return nil, err
	}
	var novo string
	ok := false
	switch acao {
	case "aprovar":
		novo, ok = StatusAtiva, r.Status == StatusAguardando
	case "rejeitar":
		novo, ok = StatusRejeitada, r.Status == StatusAguardando
	case "pausar":
		novo, ok = StatusPausada, r.Status == StatusAtiva
	case "reativar":
		novo, ok = StatusAtiva, r.Status == StatusPausada || r.Status == StatusDesativada
	case "desativar":
		novo, ok = StatusDesativada, r.Status != StatusDesativada
	default:
		return nil, fmt.Errorf("ação inválida")
	}
	if !ok {
		return nil, fmt.Errorf("não é possível %s uma rotina com status %q", acao, r.Status)
	}
	if acao == "reativar" && !r.UsuarioAtivo {
		return nil, fmt.Errorf("o usuário dono desta rotina está desativado")
	}
	q := "UPDATE FT_ROTINAS SET status = ?, motivo_status = ?"
	args := []any{novo, motivo}
	switch acao {
	case "aprovar":
		q += ", aprovado_por = ?, aprovado_em = ?"
		args = append(args, ator, time.Now().In(Loc).Format("2006-01-02 15:04:05"))
	case "desativar":
		q += ", desativado_por = ?, desativado_em = ?"
		args = append(args, ator, time.Now().In(Loc).Format("2006-01-02 15:04:05"))
	}
	q += " WHERE id_rotina = ?"
	args = append(args, id)
	if err := db.Exec(q, args...).Error; err != nil {
		return nil, err
	}
	evento := map[string]string{"aprovar": "aprovada", "rejeitar": "rejeitada", "pausar": "pausada",
		"reativar": "reativada", "desativar": "desativada"}[acao]
	RegistrarEvento(db, &id, r.IDUsuario, ator, nomeAtor, evento, motivo)
	if ator != r.IDUsuario && (acao == "aprovar" || acao == "rejeitar") {
		NotificarNoSistema(db, r.IDUsuario, fmt.Sprintf("Sua rotina #%d foi %s: %s", id, evento, r.Resumo))
	}
	return Obter(db, id)
}

// DesativarTodasDoUsuario — usado quando a pessoa sai da empresa (nada é apagado).
func DesativarTodasDoUsuario(db *gorm.DB, idUsuario, ator int64, nomeAtor, motivo string) (int, error) {
	l, err := Listar(db, idUsuario, "")
	if err != nil {
		return 0, err
	}
	n := 0
	for _, r := range l {
		if r.Status == StatusDesativada || r.Status == StatusRejeitada || r.Status == StatusConcluida {
			continue
		}
		if _, err := MudarStatus(db, r.ID, "desativar", ator, nomeAtor, motivo); err == nil {
			n++
		}
	}
	return n, nil
}

// ── execuções ─────────────────────────────────────────────────────────────

type Execucao struct {
	ID          int64      `json:"id_execucao"`
	IDRotina    int64      `json:"id_rotina"`
	Slot        time.Time  `json:"slot"`
	IniciadoEm  *time.Time `json:"iniciado_em,omitempty"`
	TerminadoEm *time.Time `json:"terminado_em,omitempty"`
	Status      string     `json:"status"`
	Resumo      string     `json:"resumo"`
	Detalhe     any        `json:"detalhe,omitempty"`
	DesfeitoEm  *time.Time `json:"desfeito_em,omitempty"`
}

func ListarExecucoes(db *gorm.DB, idRotina int64, limite int) ([]Execucao, error) {
	rows, err := db.Raw(`SELECT id_execucao, id_rotina, slot, iniciado_em, terminado_em, status, COALESCE(resumo,''),
			COALESCE(detalhe_json,''), desfeito_em
		FROM FT_ROTINA_EXECUCOES WHERE id_rotina = ? ORDER BY slot DESC LIMIT ?`, idRotina, limite).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Execucao{}
	for rows.Next() {
		var e Execucao
		var ini, fim, desf sql.NullTime
		var det string
		if rows.Scan(&e.ID, &e.IDRotina, &e.Slot, &ini, &fim, &e.Status, &e.Resumo, &det, &desf) != nil {
			continue
		}
		if ini.Valid {
			e.IniciadoEm = &ini.Time
		}
		if fim.Valid {
			e.TerminadoEm = &fim.Time
		}
		if desf.Valid {
			e.DesfeitoEm = &desf.Time
		}
		if det != "" {
			var v any
			if json.Unmarshal([]byte(det), &v) == nil {
				e.Detalhe = v
			}
		}
		out = append(out, e)
	}
	return out, nil
}

// DesfazerExecucao devolve ao estado anterior os e-mails que AQUELA rodada vinculou
// (só os que continuam no processo que a rotina pôs — mudança manual posterior é respeitada).
func DesfazerExecucao(db *gorm.DB, idExec, ator int64, nomeAtor string) (int, error) {
	var idRot int64
	var status, det string
	if err := db.Raw(`SELECT id_rotina, status, COALESCE(detalhe_json,'') FROM FT_ROTINA_EXECUCOES WHERE id_execucao = ?`, idExec).
		Row().Scan(&idRot, &status, &det); err != nil {
		return 0, fmt.Errorf("execução não encontrada")
	}
	if status == "desfeita" {
		return 0, fmt.Errorf("esta execução já foi desfeita")
	}
	var d ResultadoSync
	if err := json.Unmarshal([]byte(det), &d); err != nil || len(d.Vinculados) == 0 {
		return 0, fmt.Errorf("esta execução não tem vínculos para desfazer")
	}
	n := 0
	for _, v := range d.Vinculados {
		res := db.Exec(`UPDATE FT_EMAILS_PROCESSO SET id_processo = NULL WHERE id_email = ? AND id_processo = ?`, v.IDEmail, v.IDProcesso)
		if res.Error == nil {
			n += int(res.RowsAffected)
		}
	}
	db.Exec(`UPDATE FT_ROTINA_EXECUCOES SET status='desfeita', desfeito_por=?, desfeito_em=? WHERE id_execucao=?`,
		ator, time.Now().In(Loc).Format("2006-01-02 15:04:05"), idExec)
	r, _ := Obter(db, idRot)
	dono := ator
	if r != nil {
		dono = r.IDUsuario
	}
	RegistrarEvento(db, &idRot, dono, ator, nomeAtor, "execucao_desfeita", fmt.Sprintf("execução #%d: %d vínculo(s) desfeito(s)", idExec, n))
	return n, nil
}

// ── agendador ─────────────────────────────────────────────────────────────

// RodarDevidas é chamada a cada minuto pelo gocron do backend. Janela de 10 min para não perder
// horário se o backend reiniciou; UNIQUE(id_rotina, slot) garante uma só rodada por horário,
// mesmo com mais de uma instância.
func RodarDevidas() {
	db := gdb()
	if db == nil {
		return
	}
	// dono desligado → desativa (não apaga)
	if l, err := Listar(db, 0, ""); err == nil {
		for _, r := range l {
			if !r.UsuarioAtivo && (r.Status == StatusAtiva || r.Status == StatusAguardando || r.Status == StatusPausada) {
				_, _ = MudarStatus(db, r.ID, "desativar", 0, "sistema", "usuário desativado no sistema")
			}
		}
	}
	ativas, err := Listar(db, 0, StatusAtiva)
	if err != nil {
		return
	}
	agora := time.Now().In(Loc).Truncate(time.Minute)
	for _, r := range ativas {
		r := r
		if r.Tipo == "unica" {
			slot := agora
			if r.AprovadoEm != nil {
				slot = r.AprovadoEm.In(Loc).Truncate(time.Minute)
			}
			if reservar(db, r.ID, slot) {
				executar(db, &r, slot)
				db.Exec("UPDATE FT_ROTINAS SET status = ? WHERE id_rotina = ? AND status = ?", StatusConcluida, r.ID, StatusAtiva)
			}
			continue
		}
		for m := 0; m < 10; m++ {
			slot := agora.Add(-time.Duration(m) * time.Minute)
			if !horarioBate(r.Horarios, r.Dias, slot) {
				continue
			}
			if r.AprovadoEm != nil && slot.Before(r.AprovadoEm.In(Loc).Truncate(time.Minute)) {
				continue
			}
			if reservar(db, r.ID, slot) {
				executar(db, &r, slot)
			}
		}
	}
	DespacharLembretes()
}

func horarioBate(horarios, dias string, t time.Time) bool {
	hm := t.Format("15:04")
	achou := false
	for _, h := range strings.Split(horarios, ",") {
		if strings.TrimSpace(h) == hm {
			achou = true
			break
		}
	}
	if !achou {
		return false
	}
	dias = strings.TrimSpace(dias)
	if dias == "" || dias == "*" {
		return true
	}
	wd := fmt.Sprint(int(t.Weekday())) // 0=domingo
	for _, d := range strings.Split(dias, ",") {
		if strings.TrimSpace(d) == wd {
			return true
		}
	}
	return false
}

func reservar(db *gorm.DB, idRotina int64, slot time.Time) bool {
	res := db.Exec(`INSERT IGNORE INTO FT_ROTINA_EXECUCOES (id_rotina, slot, iniciado_em, status) VALUES (?, ?, ?, 'rodando')`,
		idRotina, slot.Format("2006-01-02 15:04:05"), time.Now().In(Loc).Format("2006-01-02 15:04:05"))
	return res.Error == nil && res.RowsAffected == 1
}

func executar(db *gorm.DB, r *Rotina, slot time.Time) {
	status, resumo, detalhe := "ok", "", any(nil)
	func() {
		defer func() {
			if p := recover(); p != nil {
				status, resumo = "erro", fmt.Sprint("falha: ", p)
			}
		}()
		switch r.Op {
		case "sincronizar_emails":
			de, ate := JanelaEmails(r.Params, slot)
			res := SincronizarEmails(db, de, ate)
			resumo = res.Texto(de, ate)
			detalhe = res
			if len(res.Vinculados) > 0 || len(res.ParaRevisar) > 0 {
				NotificarNoSistema(db, r.IDUsuario, fmt.Sprintf("Rotina #%d: %s", r.ID, resumo))
			}
		case "lembrete":
			dest := int64(numParam(r.Params, "id_usuario_destino"))
			msg, _ := r.Params["mensagem"].(string)
			if dest == 0 || strings.TrimSpace(msg) == "" {
				status, resumo = "erro", "lembrete sem destinatário ou sem mensagem"
				return
			}
			id, err := CriarLembrete(db, r.IDUsuario, r.NomeUsuario, dest, slot.Format("2006-01-02"), slot.Format("15:04"), msg, nil)
			if err != nil {
				status, resumo = "erro", err.Error()
				return
			}
			resumo = fmt.Sprintf("lembrete #%d criado para %v", id, r.Params["nome_destino"])
		default:
			status, resumo = "erro", "operação desconhecida: "+r.Op
		}
	}()
	det, _ := json.Marshal(detalhe)
	if len([]rune(resumo)) > 500 {
		resumo = string([]rune(resumo)[:500])
	}
	agora := time.Now().In(Loc).Format("2006-01-02 15:04:05")
	db.Exec(`UPDATE FT_ROTINA_EXECUCOES SET terminado_em = ?, status = ?, resumo = ?, detalhe_json = ?
		WHERE id_rotina = ? AND slot = ?`, agora, status, resumo, string(det), r.ID, slot.Format("2006-01-02 15:04:05"))
	db.Exec(`UPDATE FT_ROTINAS SET ultima_execucao = ? WHERE id_rotina = ?`, agora, r.ID)
	RegistrarEvento(db, &r.ID, r.IDUsuario, 0, "sistema", "executada", resumo)
	log.Printf("[rotinas] #%d %s %s: %s", r.ID, r.Op, status, resumo)
}

func numParam(p map[string]any, k string) float64 {
	switch v := p[k].(type) {
	case float64:
		return v
	case int64:
		return float64(v)
	case int:
		return float64(v)
	}
	return 0
}

// ── sincronizar e-mails ───────────────────────────────────────────────────

// JanelaEmails converte o parâmetro da rotina no período [de, ate) em Brasília.
func JanelaEmails(p map[string]any, ref time.Time) (time.Time, time.Time) {
	ref = ref.In(Loc)
	hoje := time.Date(ref.Year(), ref.Month(), ref.Day(), 0, 0, 0, 0, Loc)
	j, _ := p["janela"].(string)
	switch j {
	case "ontem":
		return hoje.AddDate(0, 0, -1), hoje
	case "hoje":
		return hoje, ref.Add(time.Minute)
	case "semana":
		wd := int(hoje.Weekday())
		if wd == 0 {
			wd = 7
		}
		return hoje.AddDate(0, 0, -(wd - 1)), ref.Add(time.Minute)
	case "dias":
		n := int(numParam(p, "dias"))
		if n <= 0 {
			n = 1
		}
		return hoje.AddDate(0, 0, -n), ref.Add(time.Minute)
	case "periodo":
		de, _ := time.ParseInLocation("2006-01-02", fmt.Sprint(p["de"]), Loc)
		ate, err := time.ParseInLocation("2006-01-02", fmt.Sprint(p["ate"]), Loc)
		if err != nil {
			return de, ref.Add(time.Minute)
		}
		return de, ate.AddDate(0, 0, 1)
	}
	// padrão: desde ontem 00:00
	return hoje.AddDate(0, 0, -1), ref.Add(time.Minute)
}

type Vinculo struct {
	IDEmail    int64  `json:"id_email"`
	IDProcesso int64  `json:"id_processo"`
	Motivo     string `json:"motivo"`
	Assunto    string `json:"assunto"`
}

type Pendente struct {
	IDEmail int64  `json:"id_email"`
	De      string `json:"de"`
	Assunto string `json:"assunto"`
}

type ResultadoSync struct {
	Analisados  int        `json:"analisados"`
	Avisos      int        `json:"avisos_automaticos"`
	Vinculados  []Vinculo  `json:"vinculados"`
	ParaRevisar []Pendente `json:"para_revisar"`
	SemRevisar  int        `json:"para_revisar_total"`
}

func (r ResultadoSync) Texto(de, ate time.Time) string {
	return fmt.Sprintf("e-mails de %s a %s: %d vinculado(s) a processo com prova única; %d sem prova única para revisão; %d aviso(s) automático(s) ignorado(s) (%d analisados)",
		de.Format("02/01 15:04"), ate.Add(-time.Minute).Format("02/01 15:04"), len(r.Vinculados), r.SemRevisar, r.Avisos, r.Analisados)
}

var (
	reScript   = regexp.MustCompile(`(?is)<script[^>]*>.*?</script>`)
	reStyle    = regexp.MustCompile(`(?is)<style[^>]*>.*?</style>`)
	reBr       = regexp.MustCompile(`(?i)<br\s*/?>|</p>|</div>|</tr>`)
	reTag      = regexp.MustCompile(`(?s)<[^>]+>`)
	reCitado1  = regexp.MustCompile(`\n\s*(De|From):\s.{0,120}\n?\s*(Enviado|Enviada|Sent|Data|Date)\s*(em)?\s*:`)
	reCitado2  = regexp.MustCompile(`(?i)Em .{5,80} escreveu:|-----Original Message-----|________________`)
	reAvisoRem = regexp.MustCompile(`(?i)pagamentos@cemig|quarantine@|comunicacao@light|contato@lightvirtual|essencialcc|faturaporemail|newsletter|feedback@id-cx|pesquisa|experiencia\.energisa|comunicacao\.grandecliente|contaporemail`)
	reGenerico = regexp.MustCompile(`(?i)aviso importante|newsletter|leitura do medidor|regularize|d[ée]bito|fatura digital|conta de luz|pesquisa de satisfa|boleto|promo|avalie|quer ouvir|sua fatura|fatura .{0,20}chegou|lembrete de vencimento|bandeira tarif|comunicado vistoria|liga[çc][ãa]o nova|resposta autom|automatic reply|undeliverable|n[ãa]o foi poss[íi]vel entregar|sua experi[êe]ncia`)
)

// TextoLimpo: HTML → texto, sem a parte citada ("De: ... Enviado:"), igual à revisão manual.
func TextoLimpo(h string) string {
	t := reScript.ReplaceAllString(h, " ")
	t = reStyle.ReplaceAllString(t, " ")
	t = reBr.ReplaceAllString(t, "\n")
	t = html.UnescapeString(reTag.ReplaceAllString(t, " "))
	if loc := reCitado1.FindStringIndex(t); loc != nil {
		t = t[:loc[0]]
	}
	if loc := reCitado2.FindStringIndex(t); loc != nil {
		t = t[:loc[0]]
	}
	return strings.TrimSpace(t)
}

// SincronizarEmails vincula e-mails ÓRFÃOS do período que têm prova apontando para UM processo.
// Nunca mexe em e-mail que já tem vínculo. O que mudou volta no resultado (para desfazer).
func SincronizarEmails(db *gorm.DB, de, ate time.Time) ResultadoSync {
	res := ResultadoSync{Vinculados: []Vinculo{}, ParaRevisar: []Pendente{}}
	rows, err := db.Raw(`SELECT id_email, COALESCE(de_email,''), COALESCE(assunto,''), COALESCE(corpo,'')
		FROM FT_EMAILS_PROCESSO
		WHERE id_processo IS NULL AND data_envio >= ? AND data_envio < ?
		ORDER BY data_envio, id_email LIMIT 3000`,
		de.Format("2006-01-02 15:04:05"), ate.Format("2006-01-02 15:04:05")).Rows()
	if err != nil {
		log.Printf("[rotinas] sync e-mails: %v", err)
		return res
	}
	type em struct {
		id               int64
		de, assunto, txt string
	}
	var lista []em
	for rows.Next() {
		var e em
		if rows.Scan(&e.id, &e.de, &e.assunto, &e.txt) == nil {
			lista = append(lista, e)
		}
	}
	rows.Close()
	for _, e := range lista {
		res.Analisados++
		if reAvisoRem.MatchString(e.de) || reGenerico.MatchString(e.assunto) {
			res.Avisos++
			continue
		}
		texto := e.assunto + "\n" + TextoLimpo(e.txt)
		pid, motivo, ok := repositories.FindProcessByEvidencia(db, texto)
		if !ok {
			res.SemRevisar++
			if len(res.ParaRevisar) < 50 {
				res.ParaRevisar = append(res.ParaRevisar, Pendente{IDEmail: e.id, De: e.de, Assunto: e.assunto})
			}
			continue
		}
		up := db.Exec(`UPDATE FT_EMAILS_PROCESSO SET id_processo = ? WHERE id_email = ? AND id_processo IS NULL`, pid, e.id)
		if up.Error == nil && up.RowsAffected == 1 {
			res.Vinculados = append(res.Vinculados, Vinculo{IDEmail: e.id, IDProcesso: pid, Motivo: motivo, Assunto: e.assunto})
		}
	}
	return res
}

// ── lembretes (calendário do SURE + e-mail na hora marcada) ───────────────

// CriarLembrete grava no calendário do destinatário (FT_ALERTAS com data + hora). O e-mail sai
// pelo DespacharLembretes quando chegar a hora — não na criação.
func CriarLembrete(db *gorm.DB, criadorID int64, criadorNome string, destinoID int64, data, hora, mensagem string, idProcesso *int64) (int64, error) {
	if _, err := time.ParseInLocation("2006-01-02 15:04", data+" "+hora, Loc); err != nil {
		return 0, fmt.Errorf("data/hora inválida")
	}
	msg := strings.TrimSpace(mensagem)
	if criadorID != destinoID && criadorNome != "" {
		msg = "Lembrete de " + primeiroNome(criadorNome) + ": " + msg
	}
	if len([]rune(msg)) > 255 {
		msg = string([]rune(msg)[:252]) + "..."
	}
	var id int64
	err := db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, acknowledged, data_criacao, data_alerta,
				para_todos, hora_alerta, criado_por)
			VALUES (?, ?, ?, 0, 0, NOW(), ?, 0, ?, ?)`, destinoID, idProcesso, msg, data, hora, criadorID).Error; err != nil {
			return err
		}
		return tx.Raw("SELECT LAST_INSERT_ID()").Row().Scan(&id)
	})
	if err != nil {
		return 0, err
	}
	sse.BroadcastUser(destinoID, sse.Event{Type: "alerta_novo", Payload: map[string]any{"id_processo": idProcesso}})
	notificarNaoLidos(db, destinoID)
	return id, nil
}

func primeiroNome(n string) string {
	f := strings.Fields(n)
	if len(f) == 0 {
		return n
	}
	return f[0]
}

// DespacharLembretes: a cada minuto, manda o e-mail dos lembretes com hora marcada que já chegou.
func DespacharLembretes() {
	db := gdb()
	if db == nil {
		return
	}
	agora := time.Now().In(Loc)
	hoje := agora.Format("2006-01-02")
	ontem := agora.AddDate(0, 0, -1).Format("2006-01-02")
	rows, err := db.Raw(`SELECT id_alerta, id_usuario, mensagem, DATE_FORMAT(data_alerta,'%Y-%m-%d')
		FROM FT_ALERTAS
		WHERE para_todos = 0 AND COALESCE(hora_alerta,'') <> '' AND email_enviado_em IS NULL
		  AND (data_alerta = ? OR (data_alerta = ? AND hora_alerta <= ?))`, ontem, hoje, agora.Format("15:04")).Rows()
	if err != nil {
		return
	}
	type p struct {
		id, uid   int64
		msg, data string
	}
	var l []p
	for rows.Next() {
		var x p
		if rows.Scan(&x.id, &x.uid, &x.msg, &x.data) == nil {
			l = append(l, x)
		}
	}
	rows.Close()
	for _, x := range l {
		// marca antes de enviar: se o e-mail falhar, não fica reenviando a cada minuto; e só quem
		// conseguiu marcar envia (backend local + VPS apontando p/ o mesmo banco não duplicam)
		up := db.Exec("UPDATE FT_ALERTAS SET email_enviado_em = NOW() WHERE id_alerta = ? AND email_enviado_em IS NULL", x.id)
		if up.Error != nil || up.RowsAffected != 1 {
			continue
		}
		services.EnviarAlertaPessoal(x.uid, x.msg, x.data)
		sse.BroadcastUser(x.uid, sse.Event{Type: "alerta_novo", Payload: map[string]any{"lembrete": x.id}})
		notificarNaoLidos(db, x.uid)
	}
}

// ── histórico por usuário ─────────────────────────────────────────────────

type Evento struct {
	ID       int64     `json:"id"`
	IDRotina *int64    `json:"id_rotina,omitempty"`
	Dono     int64     `json:"id_usuario_dono"`
	Ator     int64     `json:"id_usuario_ator"`
	NomeAtor string    `json:"nome_ator"`
	Evento   string    `json:"evento"`
	Detalhe  string    `json:"detalhe"`
	CriadoEm time.Time `json:"criado_em"`
}

func HistoricoUsuario(db *gorm.DB, idUsuario int64, limite int) ([]Evento, error) {
	rows, err := db.Raw(`SELECT id, id_rotina, id_usuario_dono, COALESCE(id_usuario_ator,0), COALESCE(nome_ator,''), evento,
			COALESCE(detalhe,''), criado_em
		FROM FT_ROTINA_EVENTOS WHERE id_usuario_dono = ? OR id_usuario_ator = ?
		ORDER BY id DESC LIMIT ?`, idUsuario, idUsuario, limite).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Evento{}
	for rows.Next() {
		var e Evento
		var idr sql.NullInt64
		if rows.Scan(&e.ID, &idr, &e.Dono, &e.Ator, &e.NomeAtor, &e.Evento, &e.Detalhe, &e.CriadoEm) != nil {
			continue
		}
		if idr.Valid {
			v := idr.Int64
			e.IDRotina = &v
		}
		out = append(out, e)
	}
	return out, nil
}
