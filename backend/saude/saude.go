package saude

// ─────────────────────────────────────────────────────────────────────────────
// Saúde das rotinas (melhoria 5, 13/11/2026).
//
// Cada rotina — do cron da VPS (worker/*.sh, via registrar_execucao.py) ou do agendador
// do backend (Ping/Executar/ComPing aqui) — deixa dois sinais no banco:
//   FT_ROTINAS_HEARTBEAT  rotina → último ping ("rodei agora"), um por rotina
//   FT_ROTINAS_EXECUCOES  uma linha por trabalho feito (inicio, fim, ok/erro, resumo)
//
// O Catalogo diz o que se espera de cada uma (cadência e tolerância). Avaliar é pura:
// dado o catálogo e os sinais, devolve o estado. Monitorar roda a cada 15 min, avalia
// tudo e avisa UMA pessoa (configurada em Tarefas do sistema → Rotinas): alerta na tela
// (FT_ALERTAS) e, se houver celular e o WhatsApp do departamento estiver conectado,
// mensagem no WhatsApp. Repete o aviso de um mesmo problema só a cada 24 h e avisa
// quando a rotina volta ao normal. Nada aqui altera dado de negócio.
// ─────────────────────────────────────────────────────────────────────────────

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"strings"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/rotinas"
	"ressarcimento-backend/whatsapp"
)

// Tipo diz como a rotina sinaliza: só ping (roda toda hora, raramente "faz" algo) ou execuções.
type Tipo string

const (
	TipoPing     Tipo = "ping"
	TipoExecucao Tipo = "execucao"
)

// Estados possíveis de uma rotina.
const (
	EstadoOK        = "ok"
	EstadoAtrasada  = "atrasada"
	EstadoErro      = "erro"
	EstadoRodando   = "rodando"
	EstadoTravada   = "travada"
	EstadoNunca     = "nunca"
	EstadoDesligada = "desligada"
)

// Rotina é uma entrada do catálogo.
type Rotina struct {
	Nome       string        `json:"rotina"`
	Titulo     string        `json:"titulo"`
	Onde       string        `json:"onde"`     // "VPS" (cron) | "backend"
	Cadencia   string        `json:"cadencia"` // texto para a tela
	Tipo       Tipo          `json:"tipo"`
	Opcional   bool          `json:"opcional"` // sem sinal nunca = "desligada" (não é problema)
	Tolerancia time.Duration `json:"-"`        // sem sinal/sem OK por mais que isso = atrasada
	MaxDuracao time.Duration `json:"-"`        // "rodando" há mais que isso = travada
}

// Catalogo: o que se espera de cada rotina (nomes = os usados nos scripts e no main.go).
var Catalogo = []Rotina{
	{Nome: "executor", Titulo: "Executor dos pedidos do chat", Onde: "VPS", Cadencia: "a cada minuto", Tipo: TipoPing, Tolerancia: 5 * time.Minute, MaxDuracao: 30 * time.Minute},
	{Nome: "jobs", Titulo: "Tarefas pedidas pela tela e pelo chat", Onde: "VPS", Cadencia: "a cada minuto", Tipo: TipoPing, Tolerancia: 5 * time.Minute, MaxDuracao: 12 * time.Hour},
	{Nome: "testes_regras", Titulo: "Testes de regras (página Regras)", Onde: "VPS", Cadencia: "a cada minuto", Tipo: TipoPing, Tolerancia: 5 * time.Minute, MaxDuracao: time.Hour},
	{Nome: "worker", Titulo: "Fila do chat (IA)", Onde: "VPS", Cadencia: "a cada 3 min", Tipo: TipoPing, Tolerancia: 10 * time.Minute, MaxDuracao: 30 * time.Minute},
	{Nome: "titular_conversas", Titulo: "Títulos das conversas (IA)", Onde: "VPS", Cadencia: "a cada 5 min", Tipo: TipoPing, Tolerancia: 15 * time.Minute, MaxDuracao: 30 * time.Minute},
	{Nome: "drive_sync_anexos", Titulo: "Anexos dos pedidos para o Drive", Onde: "VPS", Cadencia: "a cada 5 min", Tipo: TipoPing, Tolerancia: 15 * time.Minute, MaxDuracao: time.Hour},
	{Nome: "backup", Titulo: "Backup diário do banco", Onde: "VPS", Cadencia: "todo dia 03:00", Tipo: TipoExecucao, Tolerancia: 26 * time.Hour, MaxDuracao: 3 * time.Hour},
	{Nome: "backup_semanal", Titulo: "Backup semanal", Onde: "VPS", Cadencia: "sextas 03:00", Tipo: TipoExecucao, Tolerancia: 8 * 24 * time.Hour, MaxDuracao: 3 * time.Hour},
	{Nome: "pdf_pipeline", Titulo: "Extração de faturas", Onde: "VPS", Cadencia: "segunda e quinta 02:00", Tipo: TipoExecucao, Tolerancia: 5 * 24 * time.Hour, MaxDuracao: 20 * time.Hour},
	{Nome: "agua", Titulo: "Faturas de água", Onde: "VPS", Cadencia: "terça e quinta 02:00", Tipo: TipoExecucao, Tolerancia: 6 * 24 * time.Hour, MaxDuracao: 6 * time.Hour},
	{Nome: "regras", Titulo: "Regras agendadas", Onde: "VPS", Cadencia: "todo dia 00:00", Tipo: TipoExecucao, Tolerancia: 26 * time.Hour, MaxDuracao: time.Hour},
	{Nome: "aneel", Titulo: "Tarifas e bandeiras da ANEEL", Onde: "VPS", Cadencia: "todo dia 05:30", Tipo: TipoExecucao, Tolerancia: 26 * time.Hour, MaxDuracao: time.Hour},
	{Nome: "backend_agendador", Titulo: "Agendador do backend", Onde: "backend", Cadencia: "a cada minuto", Tipo: TipoPing, Tolerancia: 5 * time.Minute, MaxDuracao: time.Hour},
	{Nome: "protocolos_aneel", Titulo: "Protocolos ANEEL (e-mails e tarefas)", Onde: "backend", Cadencia: "a cada 15 min", Tipo: TipoPing, Tolerancia: 45 * time.Minute, MaxDuracao: time.Hour},
	{Nome: "rotinas_chat", Titulo: "Rotinas do chat e lembretes", Onde: "backend", Cadencia: "a cada minuto", Tipo: TipoPing, Tolerancia: 5 * time.Minute, MaxDuracao: time.Hour},
	{Nome: "prazos", Titulo: "Prazos dos processos", Onde: "backend", Cadencia: "a cada hora", Tipo: TipoPing, Tolerancia: 3 * time.Hour, MaxDuracao: time.Hour},
	{Nome: "divergencias_status", Titulo: "Status × histórico", Onde: "backend", Cadencia: "todo dia 06:30", Tipo: TipoExecucao, Tolerancia: 26 * time.Hour, MaxDuracao: time.Hour},
	{Nome: "emails", Titulo: "Leitura de e-mails (IMAP)", Onde: "backend", Cadencia: "a cada minuto", Tipo: TipoPing, Opcional: true, Tolerancia: 5 * time.Minute, MaxDuracao: time.Hour},
}

// Execucao é uma linha de FT_ROTINAS_EXECUCOES.
type Execucao struct {
	ID     int64      `json:"id"`
	Rotina string     `json:"rotina"`
	Inicio time.Time  `json:"inicio"`
	Fim    *time.Time `json:"fim"`
	Status string     `json:"status"` // rodando | ok | erro
	RC     *int       `json:"rc"`
	Resumo string     `json:"resumo"`
	Host   string     `json:"host"`
}

// Sinal é o que o banco sabe de uma rotina.
type Sinal struct {
	UltimoPing *time.Time `json:"ultimo_ping"`
	Ultima     *Execucao  `json:"ultima_execucao"` // a mais recente, qualquer status
	UltimaOK   *time.Time `json:"ultima_ok"`       // fim da última execução ok
}

// Avaliacao é uma rotina do catálogo com o estado calculado.
type Avaliacao struct {
	Rotina
	Sinal
	Estado string `json:"estado"`
	Motivo string `json:"motivo"`
}

var problemas = map[string]bool{EstadoAtrasada: true, EstadoErro: true, EstadoTravada: true}

// Problema diz se o estado merece aviso.
func Problema(estado string) bool { return problemas[estado] }

func fmtHora(t time.Time) string { return t.Local().Format("02/01 15:04") }

func humano(d time.Duration) string {
	switch {
	case d < time.Hour:
		return fmt.Sprintf("%d min", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d h", int(d.Hours()))
	default:
		return fmt.Sprintf("%d dias", int(d.Hours()/24))
	}
}

// Avaliar é pura: dado o que se espera (r) e o que o banco sabe (s), diz o estado.
func Avaliar(r Rotina, s Sinal, agora time.Time) (estado, motivo string) {
	// execução aberta: rodando ou travada
	if s.Ultima != nil && s.Ultima.Status == EstadoRodando {
		if agora.Sub(s.Ultima.Inicio) > r.MaxDuracao {
			return EstadoTravada, fmt.Sprintf("começou %s e não terminou (limite %s)", fmtHora(s.Ultima.Inicio), humano(r.MaxDuracao))
		}
		return EstadoRodando, "começou " + fmtHora(s.Ultima.Inicio)
	}
	// último sinal de vida de qualquer natureza
	var ultimo *time.Time
	if s.UltimoPing != nil {
		ultimo = s.UltimoPing
	}
	if s.Ultima != nil {
		t := s.Ultima.Inicio
		if s.Ultima.Fim != nil {
			t = *s.Ultima.Fim
		}
		if ultimo == nil || t.After(*ultimo) {
			ultimo = &t
		}
	}
	if ultimo == nil {
		if r.Opcional {
			return EstadoDesligada, "nunca deu sinal (rotina opcional)"
		}
		return EstadoNunca, "ainda não deu sinal desde que o painel existe"
	}
	// última execução terminou em erro e não houve OK depois
	if s.Ultima != nil && s.Ultima.Status == EstadoErro && (s.UltimaOK == nil || !s.UltimaOK.After(s.Ultima.Inicio)) {
		m := "terminou com erro em " + fmtHora(s.Ultima.Inicio)
		if s.Ultima.Resumo != "" {
			m += ": " + s.Ultima.Resumo
		}
		return EstadoErro, m
	}
	switch r.Tipo {
	case TipoPing:
		if agora.Sub(*ultimo) > r.Tolerancia {
			return EstadoAtrasada, fmt.Sprintf("sem sinal desde %s (esperado %s)", fmtHora(*ultimo), r.Cadencia)
		}
		return EstadoOK, "último sinal " + fmtHora(*ultimo)
	default:
		if s.UltimaOK == nil {
			return EstadoNunca, "ainda não terminou nenhuma vez com sucesso"
		}
		if agora.Sub(*s.UltimaOK) > r.Tolerancia {
			return EstadoAtrasada, fmt.Sprintf("último OK em %s (esperado %s)", fmtHora(*s.UltimaOK), r.Cadencia)
		}
		return EstadoOK, "último OK em " + fmtHora(*s.UltimaOK)
	}
}

// ── sinais no banco ──────────────────────────────────────────────────────────

func appDB() *sql.DB {
	if database.GormDB_App != nil {
		if db, err := database.GormDB_App.DB(); err == nil {
			return db
		}
	}
	return database.DB_App
}

// Sinais lê pings e últimas execuções de todas as rotinas.
func Sinais(ctx context.Context, db *sql.DB) (map[string]*Sinal, error) {
	out := map[string]*Sinal{}
	get := func(n string) *Sinal {
		if out[n] == nil {
			out[n] = &Sinal{}
		}
		return out[n]
	}
	rows, err := db.QueryContext(ctx, `SELECT rotina, ultimo_ping FROM FT_ROTINAS_HEARTBEAT`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var n string
		var t time.Time
		if rows.Scan(&n, &t) == nil {
			tt := t
			get(n).UltimoPing = &tt
		}
	}
	rows.Close()

	rows, err = db.QueryContext(ctx, `
		SELECT e.id, e.rotina, e.inicio, e.fim, e.status, e.rc, COALESCE(e.resumo,''), COALESCE(e.host,'')
		  FROM FT_ROTINAS_EXECUCOES e
		  JOIN (SELECT rotina, MAX(id) id FROM FT_ROTINAS_EXECUCOES GROUP BY rotina) m ON m.id = e.id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		e, err := scanExec(rows)
		if err == nil {
			get(e.Rotina).Ultima = e
		}
	}
	rows.Close()

	rows, err = db.QueryContext(ctx, `SELECT rotina, MAX(fim) FROM FT_ROTINAS_EXECUCOES WHERE status = 'ok' GROUP BY rotina`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var n string
		var t sql.NullTime
		if rows.Scan(&n, &t) == nil && t.Valid {
			tt := t.Time
			get(n).UltimaOK = &tt
		}
	}
	rows.Close()
	return out, nil
}

type scanner interface{ Scan(dest ...any) error }

func scanExec(r scanner) (*Execucao, error) {
	var e Execucao
	var fim sql.NullTime
	var rc sql.NullInt64
	if err := r.Scan(&e.ID, &e.Rotina, &e.Inicio, &fim, &e.Status, &rc, &e.Resumo, &e.Host); err != nil {
		return nil, err
	}
	if fim.Valid {
		t := fim.Time
		e.Fim = &t
	}
	if rc.Valid {
		v := int(rc.Int64)
		e.RC = &v
	}
	return &e, nil
}

// Avaliacoes devolve o catálogo inteiro avaliado.
func Avaliacoes(ctx context.Context, db *sql.DB, agora time.Time) ([]Avaliacao, error) {
	sin, err := Sinais(ctx, db)
	if err != nil {
		return nil, err
	}
	out := make([]Avaliacao, 0, len(Catalogo))
	for _, r := range Catalogo {
		s := sin[r.Nome]
		if s == nil {
			s = &Sinal{}
		}
		a := Avaliacao{Rotina: r, Sinal: *s}
		a.Estado, a.Motivo = Avaliar(r, *s, agora)
		out = append(out, a)
	}
	return out, nil
}

// Execucoes lista as últimas n execuções (de uma rotina ou de todas).
func Execucoes(ctx context.Context, db *sql.DB, rotina string, n int) ([]Execucao, error) {
	if n <= 0 || n > 500 {
		n = 50
	}
	q := `SELECT id, rotina, inicio, fim, status, rc, COALESCE(resumo,''), COALESCE(host,'') FROM FT_ROTINAS_EXECUCOES`
	args := []any{}
	if rotina != "" {
		q += ` WHERE rotina = ?`
		args = append(args, rotina)
	}
	q += ` ORDER BY id DESC LIMIT ?`
	args = append(args, n)
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Execucao{}
	for rows.Next() {
		if e, err := scanExec(rows); err == nil {
			out = append(out, *e)
		}
	}
	return out, nil
}

// ── registro pelas rotinas do próprio backend ────────────────────────────────

const hostBackend = "backend"

// Ping marca que a rotina rodou agora.
func Ping(nome string) {
	db := appDB()
	if db == nil {
		return
	}
	_, err := db.Exec(`INSERT INTO FT_ROTINAS_HEARTBEAT (rotina, ultimo_ping, host) VALUES (?, NOW(), ?)
		ON DUPLICATE KEY UPDATE ultimo_ping = NOW(), host = VALUES(host)`, nome, hostBackend)
	if err != nil {
		log.Printf("[saude] ping %s: %v", nome, err)
	}
}

// Inicio abre uma execução; devolve o id (0 se não deu).
func Inicio(nome, resumo string) int64 {
	db := appDB()
	if db == nil {
		return 0
	}
	res, err := db.Exec(`INSERT INTO FT_ROTINAS_EXECUCOES (rotina, inicio, status, resumo, host) VALUES (?, NOW(), 'rodando', ?, ?)`,
		nome, nullStr(limitar(resumo, 500)), hostBackend)
	if err != nil {
		log.Printf("[saude] inicio %s: %v", nome, err)
		return 0
	}
	Ping(nome)
	id, _ := res.LastInsertId()
	return id
}

// Fim fecha a execução: err nil = ok.
func Fim(id int64, err error, resumo string) {
	db := appDB()
	if db == nil || id <= 0 {
		return
	}
	status, rc := EstadoOK, 0
	if err != nil {
		status, rc = EstadoErro, 1
		if resumo == "" {
			resumo = err.Error()
		}
	}
	if _, e := db.Exec(`UPDATE FT_ROTINAS_EXECUCOES SET fim = NOW(), status = ?, rc = ?, resumo = COALESCE(?, resumo) WHERE id = ?`,
		status, rc, nullStr(limitar(resumo, 500)), id); e != nil {
		log.Printf("[saude] fim %d: %v", id, e)
	}
}

// Executar embrulha uma tarefa do agendador que "faz algo" (uma execução por rodada).
// Pânico vira execução com erro (e não derruba o agendador).
func Executar(nome string, fn func()) func() {
	return func() {
		id := Inicio(nome, "")
		var err error
		func() {
			defer func() {
				if r := recover(); r != nil {
					err = fmt.Errorf("pânico: %v", r)
					log.Printf("[saude] %s: %v", nome, err)
				}
			}()
			fn()
		}()
		Fim(id, err, "")
	}
}

// ComPing embrulha uma tarefa do agendador que roda o tempo todo (só sinal de vida).
func ComPing(nome string, fn func()) func() {
	return func() {
		Ping(nome)
		fn()
	}
}

// ── quem recebe os avisos ────────────────────────────────────────────────────

// Aviso é a pessoa configurada para receber os avisos das rotinas.
type Aviso struct {
	IDUsuario int64  `json:"id_usuario"`
	Nome      string `json:"nome"`
	Celular   string `json:"celular"`
}

// ObterAviso lê a configuração (FT_WHATSAPP_CONFIG, chaves rotinas_aviso_*).
func ObterAviso(ctx context.Context, db *sql.DB) Aviso {
	var a Aviso
	rows, err := db.QueryContext(ctx, `SELECT chave, COALESCE(valor,'') FROM FT_WHATSAPP_CONFIG WHERE chave IN ('rotinas_aviso_usuario','rotinas_aviso_celular')`)
	if err != nil {
		return a
	}
	for rows.Next() {
		var k, v string
		if rows.Scan(&k, &v) == nil {
			switch k {
			case "rotinas_aviso_usuario":
				fmt.Sscan(v, &a.IDUsuario)
			case "rotinas_aviso_celular":
				a.Celular = v
			}
		}
	}
	rows.Close()
	if a.IDUsuario > 0 {
		_ = db.QueryRowContext(ctx, `SELECT COALESCE(nome_usuario,'') FROM DM_USUARIO WHERE id_usuario = ?`, a.IDUsuario).Scan(&a.Nome)
	}
	return a
}

// DefinirAviso grava quem recebe (0/"" desliga). O celular é normalizado como o WhatsApp espera.
func DefinirAviso(ctx context.Context, db *sql.DB, idUsuario int64, celular string, por int64) error {
	celular = strings.TrimSpace(celular)
	if celular != "" {
		celular = whatsapp.NormalizarCelular(celular)
		if len(celular) < 10 {
			return fmt.Errorf("celular inválido: informe DDD e número")
		}
	}
	if idUsuario > 0 {
		var n int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(1) FROM DM_USUARIO WHERE id_usuario = ? AND usuario_ativo = 1`, idUsuario).Scan(&n); err != nil || n == 0 {
			return fmt.Errorf("usuário não encontrado ou inativo")
		}
	}
	up := func(k, v string) error {
		_, err := db.ExecContext(ctx, `INSERT INTO FT_WHATSAPP_CONFIG (chave, valor, atualizado_por) VALUES (?, ?, ?)
			ON DUPLICATE KEY UPDATE valor = VALUES(valor), atualizado_por = VALUES(atualizado_por)`, k, nullStr(v), nullInt(por))
		return err
	}
	u := ""
	if idUsuario > 0 {
		u = fmt.Sprint(idUsuario)
	}
	if err := up("rotinas_aviso_usuario", u); err != nil {
		return err
	}
	return up("rotinas_aviso_celular", celular)
}

// Avisar manda a mensagem para a pessoa configurada: alerta na tela e, se der, WhatsApp.
// Devolve por quais canais foi.
func Avisar(ctx context.Context, db *sql.DB, msg string) []string {
	a := ObterAviso(ctx, db)
	canais := []string{}
	if a.IDUsuario > 0 && database.GormDB_App != nil {
		rotinas.NotificarNoSistema(database.GormDB_App, a.IDUsuario, msg)
		canais = append(canais, "tela")
	}
	if a.Celular != "" && whatsapp.ObterEstado().Conectado {
		if err := whatsapp.Enviar(a.Celular, "🔔 SURE — "+msg, a.IDUsuario, 0); err != nil {
			log.Printf("[saude] whatsapp para o responsável: %v", err)
		} else {
			canais = append(canais, "whatsapp")
		}
	}
	if len(canais) == 0 {
		log.Printf("[saude] aviso sem destinatário configurado: %s", msg)
	}
	return canais
}

// ── monitor (a cada 15 min no agendador) ─────────────────────────────────────

const repetirAvisoApos = 24 * time.Hour

// Monitorar avalia o catálogo e avisa o responsável sobre o que atrasou, falhou ou travou.
// Um mesmo problema é repetido só depois de 24 h; a volta ao normal também é avisada.
func Monitorar() {
	db := appDB()
	if db == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	agora := time.Now()
	itens, err := Avaliacoes(ctx, db, agora)
	if err != nil {
		log.Printf("[saude] monitor: %v", err)
		return
	}
	type ultimo struct {
		estado string
		em     time.Time
	}
	prev := map[string]ultimo{}
	rows, err := db.QueryContext(ctx, `SELECT rotina, ultimo_estado, ultimo_aviso FROM FT_ROTINAS_AVISOS`)
	if err == nil {
		for rows.Next() {
			var n, e string
			var t time.Time
			if rows.Scan(&n, &e, &t) == nil {
				prev[n] = ultimo{e, t}
			}
		}
		rows.Close()
	}
	grava := func(nome, estado string) {
		_, _ = db.ExecContext(ctx, `INSERT INTO FT_ROTINAS_AVISOS (rotina, ultimo_estado, ultimo_aviso) VALUES (?, ?, NOW())
			ON DUPLICATE KEY UPDATE ultimo_estado = VALUES(ultimo_estado), ultimo_aviso = NOW()`, nome, estado)
	}
	nProb := 0
	for _, it := range itens {
		p, tem := prev[it.Nome]
		switch {
		case Problema(it.Estado):
			nProb++
			if tem && p.estado == it.Estado && agora.Sub(p.em) < repetirAvisoApos {
				continue
			}
			Avisar(ctx, db, fmt.Sprintf("Rotina «%s» %s: %s. Veja Tarefas do sistema → Rotinas.", it.Titulo, it.Estado, it.Motivo))
			grava(it.Nome, it.Estado)
		case it.Estado == EstadoOK && tem && Problema(p.estado):
			Avisar(ctx, db, fmt.Sprintf("Rotina «%s» voltou ao normal (%s).", it.Titulo, it.Motivo))
			grava(it.Nome, EstadoOK)
		}
	}
	log.Printf("[saude] monitor: %d rotina(s), %d com problema", len(itens), nProb)
}

func limitar(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > n {
		return string(r[:n])
	}
	return string(r)
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullInt(n int64) any {
	if n <= 0 {
		return nil
	}
	return n
}
