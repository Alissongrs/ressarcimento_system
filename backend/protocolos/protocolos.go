// Package protocolos — acompanhamento dos protocolos da Ouvidoria ANEEL (pedido do Alisson, 25/10/2026).
//
// De onde vêm os protocolos (FT_PROTOCOLOS_ANEEL):
//   - histórico do processo: quem escreve "Protocolo 010.665.84026-55" numa movimentação já vincula;
//   - cadastro manual (tela Consultar protocolo / gaveta do processo);
//   - e-mail da ANEEL de protocolo ainda desconhecido (fica "sem_processo" até alguém vincular).
//
// Mudanças (FT_PROTOCOLO_EVENTOS) vêm hoje dos e-mails de naoresponda@aneel.gov.br. A consulta direta
// no site da ANEEL depende de a ANEEL liberar o acesso automatizado (o login tem verificação
// anti-robô, que NÃO deve ser contornada) — por isso SiteDisponivel() é false.
//
// Cada mudança nova vira uma tarefa (FT_TAREFAS) + alerta: vai para quem fez a última alteração no processo
// (movimentação no histórico ou edição do processo); sem processo ou sem ninguém, o admin direciona
// (regra do Alisson, 27/10/2026).
// Na primeira rodada (sem nenhum evento de e-mail gravado) só registra a situação, sem tarefas,
// para não gerar centenas de tarefas de e-mails antigos.
package protocolos

import (
	"fmt"
	"html"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/rotinas"
	"ressarcimento-backend/services"
	"ressarcimento-backend/whatsapp"

	"gorm.io/gorm"
)

const (
	SitRegistrado    = "Registrado na ANEEL"
	SitRespostaANEEL = "Resposta da ANEEL"
	SitPrazoDistrib  = "Prazo da distribuidora encerrado"
)

// reProtocolo: 13 dígitos começando em 010, com ou sem pontuação ("010.665.84026-55" / "0106654802655").
// Também aceita o zero inicial esquecido, só na forma pontuada ("10.631.88126-01"), para não pegar outros números.
var reProtocolo = regexp.MustCompile(`(?:^|[^\d.])(?:010\.?(\d{3})\.?(\d{5})-?(\d{2})|10\.(\d{3})\.(\d{5})-(\d{2}))(?:[^\d]|$)`)

// AtualizarCaixa é preenchido pelo pacote handlers: traz da caixa (Graph) os e-mails recentes para
// mail_messages antes de cada rodada. Nil → usa só o que já está em mail_messages.
var AtualizarCaixa func()

var mu sync.Mutex

func gdb() *gorm.DB { return database.GormDB_App }

// SiteDisponivel: consulta direta no site da ANEEL. Fica false até a ANEEL liberar o acesso.
func SiteDisponivel() bool { return false }

// Extrair devolve os protocolos (só dígitos, sem repetir) citados no texto, na ordem.
func Extrair(texto string) []string {
	var out []string
	vistos := map[string]bool{}
	// o regex consome o caractere vizinho; repete a busca a partir de cada achado para pegar vizinhos colados
	for resto := texto; ; {
		loc := reProtocolo.FindStringSubmatchIndex(resto)
		if loc == nil {
			break
		}
		g := 2 // grupos 1-3: forma com 010; grupos 4-6: forma sem o zero inicial
		if loc[2] < 0 {
			g = 8
		}
		num := "010" + resto[loc[g]:loc[g+1]] + resto[loc[g+2]:loc[g+3]] + resto[loc[g+4]:loc[g+5]]
		if !vistos[num] {
			vistos[num] = true
			out = append(out, num)
		}
		resto = resto[loc[g+5]:]
	}
	return out
}

// Normalizar aceita o protocolo digitado de qualquer jeito e devolve só os dígitos ("" se inválido).
func Normalizar(s string) string {
	d := regexp.MustCompile(`\D`).ReplaceAllString(s, "")
	if len(d) == 13 && strings.HasPrefix(d, "010") {
		return d
	}
	return ""
}

func Formatar(num string) string {
	if len(num) != 13 {
		return num
	}
	return num[0:3] + "." + num[3:6] + "." + num[6:11] + "-" + num[11:13]
}

var (
	reTags     = regexp.MustCompile(`(?s)<[^>]+>`)
	reStyle    = regexp.MustCompile(`(?is)<(script|style)[^>]*>.*?</(script|style)>`)
	reQuebra   = regexp.MustCompile(`(?i)<br\s*/?>|</p>|</div>|</tr>`)
	reEspacos  = regexp.MustCompile(`[ \t\r]+`)
	reLinhasVz = regexp.MustCompile(`\n\s*\n+`)
)

func textoLimpo(h string) string {
	t := reStyle.ReplaceAllString(h, " ")
	t = reQuebra.ReplaceAllString(t, "\n")
	t = html.UnescapeString(reTags.ReplaceAllString(t, " "))
	// linha em branco entre parágrafos fica (texto da ANEEL legível, como no e-mail)
	return strings.TrimSpace(reLinhasVz.ReplaceAllString(reEspacos.ReplaceAllString(t, " "), "\n\n"))
}

var (
	reDesfavoravel = regexp.MustCompile(`(?i)ratifica|seguiu devidamente|esfera judicial|improcedente|foi feita da maneira correta|não identificamos irregularidade|não há elementos`)
	reFavoravel    = regexp.MustCompile(`(?i)necessidade de revis|procedente|dever[áa] (revisar|devolver|ressarcir|creditar|refaturar)|devolu[çc][ãa]o|em dobro`)
)

// Classificar diz o tipo do e-mail da ANEEL: "registro", "resposta", "prazo" ou "" (ignorar).
func Classificar(assunto string) string {
	a := strings.ToLower(assunto)
	switch {
	case strings.Contains(a, "registro da solicita"):
		return "registro"
	case strings.Contains(a, "avalie a ouvidoria"):
		return "prazo"
	case strings.Contains(a, "solicitação de ouvidoria") || strings.Contains(a, "solicitacao de ouvidoria"):
		return "resposta"
	}
	return ""
}

// Leitura é uma leitura automática do texto da resposta — só indício, quem decide é o analista.
func Leitura(corpo string) string {
	// "desfavorável" primeiro: "improcedente" contém "procedente"
	switch {
	case reDesfavoravel.MatchString(corpo):
		return "parece desfavorável"
	case reFavoravel.MatchString(corpo):
		return "parece favorável"
	}
	return ""
}

// trechoResposta: a comunicação inteira da ANEEL, com parágrafos (pedido do Alisson, 26/10/2026:
// "sempre completo"); o limite só protege a coluna de um e-mail fora do padrão.
func trechoResposta(t string) string {
	r := []rune(strings.TrimSpace(t))
	if len(r) > 20000 {
		r = r[:20000]
	}
	return string(r)
}

// ── importação do histórico ─────────────────────────────────────────────────

// CapturarDoHistorico vincula protocolos escritos em movimentações novas (posteriores à última já lida).
// Protocolo que já está em OUTRO processo entra como "confirmar" nos dois (o admin decide).
func CapturarDoHistorico(db *gorm.DB) int {
	var ultimo int64
	_ = db.Raw("SELECT COALESCE(MAX(id_historico_origem),0) FROM FT_PROTOCOLOS_ANEEL").Row().Scan(&ultimo)
	rows, err := db.Raw(`SELECT h.id_historico, h.id_processo, h.comentario, h.data_movimentacao
		FROM FT_HISTORICO_MOVIMENTACOES h JOIN FT_PROCESSOS p ON p.id_processo = h.id_processo
		WHERE h.id_historico > ? AND h.comentario LIKE '%010%' ORDER BY h.id_historico`, ultimo).Rows()
	if err != nil {
		log.Printf("[protocolos] histórico: %v", err)
		return 0
	}
	type mov struct {
		idH, idP int64
		com      string
		dt       *time.Time
	}
	var movs []mov
	for rows.Next() {
		var m mov
		if rows.Scan(&m.idH, &m.idP, &m.com, &m.dt) == nil {
			movs = append(movs, m)
		}
	}
	rows.Close()
	n := 0
	for _, m := range movs {
		for _, num := range Extrair(m.com) {
			if VincularSeNovo(db, num, m.idP, "historico", &m.idH, 0, m.dt) {
				n++
			}
		}
	}
	return n
}

// VincularSeNovo cria o vínculo protocolo↔processo se ainda não existir. Retorna true se criou.
// Se o protocolo estava "sem_processo", passa a ser deste processo.
func VincularSeNovo(db *gorm.DB, num string, idProcesso int64, origem string, idHist *int64, criadoPor int64, quando *time.Time) bool {
	var existe int
	_ = db.Raw("SELECT COUNT(*) FROM FT_PROTOCOLOS_ANEEL WHERE protocolo_num = ? AND id_processo = ?", num, idProcesso).Row().Scan(&existe)
	if existe > 0 {
		db.Exec("UPDATE FT_PROTOCOLOS_ANEEL SET ativo = 1 WHERE protocolo_num = ? AND id_processo = ? AND ativo = 0 AND ? <> 'historico'", num, idProcesso, origem)
		return false
	}
	// herda situação/responsável de outra linha do mesmo protocolo (se houver)
	var semProc int64
	_ = db.Raw("SELECT COALESCE(MIN(id),0) FROM FT_PROTOCOLOS_ANEEL WHERE protocolo_num = ? AND id_processo IS NULL", num).Row().Scan(&semProc)
	if semProc > 0 {
		db.Exec(`UPDATE FT_PROTOCOLOS_ANEEL SET id_processo = ?, status_vinculo = 'vinculado', origem = ?, id_historico_origem = COALESCE(?, id_historico_origem)
			WHERE id = ?`, idProcesso, origem, idHist, semProc)
		db.Exec(`UPDATE FT_TAREFAS SET id_processo = ?, status = 'concluida', concluida_em = NOW(),
				comentario_conclusao = CONCAT('Vinculado ao processo #', ?)
			WHERE protocolo_num = ? AND tipo = 'protocolo_registro' AND status <> 'concluida'`, idProcesso, idProcesso, num)
		db.Exec("UPDATE FT_TAREFAS SET id_processo = ? WHERE protocolo_num = ? AND id_processo IS NULL", idProcesso, num)
		return true
	}
	var outros int
	_ = db.Raw("SELECT COUNT(*) FROM FT_PROTOCOLOS_ANEEL WHERE protocolo_num = ? AND ativo = 1", num).Row().Scan(&outros)
	status := "vinculado"
	if outros > 0 {
		status = "confirmar"
		db.Exec("UPDATE FT_PROTOCOLOS_ANEEL SET status_vinculo = 'confirmar' WHERE protocolo_num = ? AND ativo = 1", num)
	}
	criado := time.Now()
	if quando != nil {
		criado = *quando
	}
	var cp any
	if criadoPor > 0 {
		cp = criadoPor
	}
	err := db.Exec(`INSERT INTO FT_PROTOCOLOS_ANEEL (protocolo, protocolo_num, id_processo, status_vinculo, origem, id_historico_origem,
			id_usuario_responsavel, situacao, ultimo_andamento, ultima_mudanca_em, ultima_verificacao_em, ultima_fonte, criado_por, criado_em)
		SELECT ?, ?, ?, ?, ?, ?, x.id_usuario_responsavel, x.situacao, x.ultimo_andamento, x.ultima_mudanca_em, x.ultima_verificacao_em, x.ultima_fonte, ?, ?
		FROM (SELECT 1) d LEFT JOIN (SELECT * FROM FT_PROTOCOLOS_ANEEL WHERE protocolo_num = ? ORDER BY ultima_mudanca_em DESC LIMIT 1) x ON 1=1`,
		Formatar(num), num, idProcesso, status, origem, idHist, cp, criado, num).Error
	if err != nil {
		log.Printf("[protocolos] vincular %s→%d: %v", num, idProcesso, err)
		return false
	}
	return true
}

// ── e-mails da ANEEL ────────────────────────────────────────────────────────

type emailANEEL struct {
	id       int64
	graphID  string
	assunto  string
	snippet  string
	recebido time.Time
}

// corpoEmail: primeiro tenta a cópia já guardada em FT_EMAILS_PROCESSO; senão busca na caixa (Graph).
func corpoEmail(db *gorm.DB, e emailANEEL) string {
	var corpo string
	_ = db.Raw(`SELECT COALESCE(corpo,'') FROM FT_EMAILS_PROCESSO WHERE assunto = ?
		AND data_envio BETWEEN ? - INTERVAL 1 DAY AND ? + INTERVAL 1 DAY AND corpo <> '' LIMIT 1`,
		e.assunto, e.recebido, e.recebido).Row().Scan(&corpo)
	if corpo == "" && e.graphID != "" {
		if d, err := services.GetMailMessage(e.graphID); err == nil && d != nil {
			corpo = d.BodyContent
		}
	}
	if corpo == "" {
		return e.snippet
	}
	return textoLimpo(corpo)
}

type linhaProt struct {
	id          int64
	idProcesso  *int64
	responsavel *int64
	situacao    string
	mudanca     *time.Time
}

func linhasDo(db *gorm.DB, num string) []linhaProt {
	rows, err := db.Raw(`SELECT id, id_processo, id_usuario_responsavel, COALESCE(situacao,''), ultima_mudanca_em
		FROM FT_PROTOCOLOS_ANEEL WHERE protocolo_num = ? AND ativo = 1`, num).Rows()
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []linhaProt
	for rows.Next() {
		var l linhaProt
		if rows.Scan(&l.id, &l.idProcesso, &l.responsavel, &l.situacao, &l.mudanca) == nil {
			out = append(out, l)
		}
	}
	return out
}

func temProcesso(db *gorm.DB, num string) bool {
	for _, l := range linhasDo(db, num) {
		if l.idProcesso != nil {
			return true
		}
	}
	return false
}

// reProtDistrib: protocolo da ouvidoria da distribuidora citado pela ANEEL
// ("Protocolo Aberto pela Ouvidoria da Distribuidora: 1671755100", "sob o protocolo nº 391136657").
var reProtDistrib = regexp.MustCompile(`(?i)protocolo[^0-9]{0,45}?([0-9][0-9.\-]{6,24}[0-9])`)

// procurarProcesso tenta achar o processo de um protocolo que está sem processo, pelo texto dos e-mails dele:
//  1. o e-mail cita outro protocolo ANEEL que já está num processo (resposta a recurso cita a SO original);
//  2. o e-mail cita o protocolo da ouvidoria da distribuidora, e esse número está no histórico de um processo.
//
// Vincula a todos os processos achados (mais de um → "confirmar", o admin decide). Retorna true se vinculou.
func procurarProcesso(db *gorm.DB, num, texto string, quando *time.Time) bool {
	achou := false
	for _, ref := range Extrair(texto) {
		if ref == num {
			continue
		}
		for _, l := range linhasDo(db, ref) {
			if l.idProcesso != nil && VincularSeNovo(db, num, *l.idProcesso, "email", nil, 0, quando) {
				achou = true
			}
		}
	}
	if achou {
		return true
	}
	for _, m := range reProtDistrib.FindAllStringSubmatch(texto, -1) {
		d := regexp.MustCompile(`\D`).ReplaceAllString(m[1], "")
		if len(d) < 8 || strings.HasPrefix(d, "010") {
			continue
		}
		var procs []int64
		_ = db.Raw(`SELECT DISTINCT id_processo FROM FT_HISTORICO_MOVIMENTACOES
			WHERE REPLACE(REPLACE(REPLACE(comentario, '.', ''), ' ', ''), '-', '') LIKE ? LIMIT 5`, "%"+d+"%").Scan(&procs).Error
		if len(procs) > 3 { // número que aparece em muitos processos não identifica nada
			continue
		}
		for _, p := range procs {
			if VincularSeNovo(db, num, p, "email", nil, 0, quando) {
				achou = true
			}
		}
	}
	return achou
}

// ProcurarSemProcesso repassa os protocolos ainda sem processo (o histórico pode ter ganhado o nº da
// distribuidora depois do e-mail). Lê o corpo das respostas guardadas; retorna quantos vinculou.
func ProcurarSemProcesso(db *gorm.DB) int {
	var nums []string
	_ = db.Raw(`SELECT DISTINCT protocolo_num FROM FT_PROTOCOLOS_ANEEL p WHERE ativo = 1 AND id_processo IS NULL
		AND NOT EXISTS (SELECT 1 FROM FT_PROTOCOLOS_ANEEL q WHERE q.protocolo_num = p.protocolo_num AND q.id_processo IS NOT NULL AND q.ativo = 1)`).Scan(&nums).Error
	n := 0
	for _, num := range nums {
		rows, err := db.Raw(`SELECT m.id, COALESCE(m.graph_message_id,''), COALESCE(m.subject,''), COALESCE(m.snippet,''), m.received_at
			FROM FT_PROTOCOLO_EVENTOS e JOIN mail_messages m ON m.id = e.id_mail_message
			WHERE e.protocolo_num = ? ORDER BY m.received_at`, num).Rows()
		if err != nil {
			continue
		}
		var emails []emailANEEL
		for rows.Next() {
			var e emailANEEL
			if rows.Scan(&e.id, &e.graphID, &e.assunto, &e.snippet, &e.recebido) == nil {
				emails = append(emails, e)
			}
		}
		rows.Close()
		for _, e := range emails {
			texto := e.assunto + "\n" + e.snippet
			if Classificar(e.assunto) == "resposta" {
				texto = e.assunto + "\n" + corpoEmail(db, e)
			}
			if procurarProcesso(db, num, texto, &e.recebido) {
				n++
				break
			}
		}
	}
	return n
}

// Resultado de uma rodada.
type Resultado struct {
	Emails         int `json:"emails"`
	Eventos        int `json:"eventos"`
	Tarefas        int `json:"tarefas"`
	NovosHistorico int `json:"novos_do_historico"`
	SemProcesso    int `json:"protocolos_sem_processo"`
	// protocolos que estavam sem processo e foram achados nesta rodada
	AchadosSemProcesso int  `json:"achados_sem_processo"`
	PrimeiraRodada     bool `json:"primeira_rodada"`
}

// Sincronizar — rodada completa (agendada a cada 15 min e pelo botão "Atualizar agora").
func Sincronizar() (Resultado, error) {
	var r Resultado
	db := gdb()
	if db == nil {
		return r, fmt.Errorf("banco indisponível")
	}
	if !mu.TryLock() {
		return r, fmt.Errorf("já existe uma atualização em andamento")
	}
	defer mu.Unlock()

	r.NovosHistorico = CapturarDoHistorico(db)
	r.AchadosSemProcesso = ProcurarSemProcesso(db)
	if AtualizarCaixa != nil {
		AtualizarCaixa()
	}
	var jaTem int
	_ = db.Raw("SELECT COUNT(*) FROM FT_PROTOCOLO_EVENTOS WHERE fonte = 'email'").Row().Scan(&jaTem)
	r.PrimeiraRodada = jaTem == 0

	rows, err := db.Raw(`SELECT m.id, COALESCE(m.graph_message_id,''), COALESCE(m.subject,''), COALESCE(m.snippet,''), m.received_at
		FROM mail_messages m
		WHERE m.from_email LIKE '%@aneel.gov.br'
		  AND NOT EXISTS (SELECT 1 FROM FT_PROTOCOLO_EVENTOS e WHERE e.id_mail_message = m.id)
		ORDER BY m.received_at, m.id`).Rows()
	if err != nil {
		return r, err
	}
	var emails []emailANEEL
	for rows.Next() {
		var e emailANEEL
		if rows.Scan(&e.id, &e.graphID, &e.assunto, &e.snippet, &e.recebido) == nil {
			emails = append(emails, e)
		}
	}
	rows.Close()

	for _, e := range emails {
		tipo := Classificar(e.assunto)
		if tipo == "" {
			continue
		}
		r.Emails++
		texto := e.assunto + "\n" + e.snippet
		var corpo string
		if tipo == "resposta" {
			corpo = corpoEmail(db, e)
			texto = e.assunto + "\n" + corpo
		}
		nums := Extrair(texto)
		if len(nums) == 0 {
			continue
		}
		principal := nums[0] // o do assunto
		if !temProcesso(db, principal) {
			procurarProcesso(db, principal, texto, &e.recebido)
		}
		if len(linhasDo(db, principal)) == 0 {
			db.Exec(`INSERT INTO FT_PROTOCOLOS_ANEEL (protocolo, protocolo_num, id_processo, status_vinculo, origem, criado_em)
				VALUES (?, ?, NULL, 'sem_processo', 'email', ?)`, Formatar(principal), principal, e.recebido)
			r.SemProcesso++
		}

		situacao, andamento := "", ""
		switch tipo {
		case "registro":
			situacao, andamento = SitRegistrado, "A ANEEL registrou a solicitação de ouvidoria."
		case "prazo":
			situacao, andamento = SitPrazoDistrib, "Acabou o prazo da ouvidoria da distribuidora para responder (aviso da ANEEL)."
		case "resposta":
			// o e-mail de resposta da ANEEL é a conclusão da solicitação (no site ela aparece "CONCLUÍDA");
			// texto como veio, sem interpretação automática (pedido do Alisson, 26/10/2026)
			situacao = SitConcluidaSite
			andamento = trechoResposta(corpo)
		}
		linhas := linhasDo(db, principal)
		anterior := ""
		if len(linhas) > 0 {
			anterior = linhas[0].situacao
		}
		res := db.Exec(`INSERT IGNORE INTO FT_PROTOCOLO_EVENTOS (protocolo_num, fonte, situacao_anterior, situacao_nova, andamento, id_mail_message, ocorrido_em)
			VALUES (?, 'email', ?, ?, ?, ?, ?)`, principal, nullSe(anterior), situacao, andamento, e.id, e.recebido)
		if res.Error != nil || res.RowsAffected == 0 {
			continue
		}
		r.Eventos++
		var idEvento int64
		_ = db.Raw("SELECT id FROM FT_PROTOCOLO_EVENTOS WHERE protocolo_num = ? AND id_mail_message = ?", principal, e.id).Row().Scan(&idEvento)

		// só avança a situação se o e-mail for o mais recente do protocolo, e nunca tira um protocolo
		// de "Concluída" (o site grava só a data, então um e-mail do mesmo dia parecia mais novo)
		db.Exec(`UPDATE FT_PROTOCOLOS_ANEEL SET situacao = ?, ultimo_andamento = ?, ultima_mudanca_em = ?, ultima_fonte = 'email', ultima_verificacao_em = NOW()
			WHERE protocolo_num = ? AND ativo = 1 AND (ultima_mudanca_em IS NULL OR ultima_mudanca_em <= ?)
			  AND NOT (COALESCE(situacao,'') = ? AND ? <> ?)`,
			situacao, andamento, e.recebido, principal, e.recebido, SitConcluidaSite, situacao, SitConcluidaSite)

		// e-mail antigo (rodada inicial interrompida, backend parado muitos dias) só registra, sem tarefa
		if r.PrimeiraRodada || time.Since(e.recebido) > 72*time.Hour {
			continue
		}
		for _, l := range linhas {
			if tipo == "registro" && l.idProcesso != nil {
				continue // registro de protocolo já vinculado: nada a fazer
			}
			if tarefaDaMudanca(db, tipo, principal, l, idEvento) {
				r.Tarefas++
			}
		}
	}
	db.Exec("UPDATE FT_PROTOCOLOS_ANEEL SET ultima_verificacao_em = NOW() WHERE ativo = 1")
	log.Printf("[protocolos] rodada: %+v", r)
	return r, nil
}

func nullSe(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// RegrasTarefa: tipos de mudança que o admin pode mandar direto para um analista (FT_TAREFAS_REGRAS).
// Ordem de quem recebe a tarefa: responsável do protocolo → analista da regra → admin direciona.
var RegrasTarefa = []struct {
	Chave  string `json:"chave"`
	Rotulo string `json:"rotulo"`
}{
	{"registro_sem_processo", "Protocolo novo que não está em nenhum processo"},
	{"resposta_favoravel", "Resposta da ANEEL que parece favorável"},
	{"resposta_desfavoravel", "Resposta da ANEEL que parece desfavorável"},
	{"resposta_outra", "Outra resposta da ANEEL (pede documentos, encaminhou à distribuidora…)"},
	{"prazo", "Prazo da distribuidora encerrado"},
}

// ChaveRegra devolve a chave de RegrasTarefa para um e-mail do tipo dado e a leitura automática do texto.
func ChaveRegra(tipo, leitura string) string {
	switch {
	case tipo == "registro":
		return "registro_sem_processo"
	case tipo == "resposta" && leitura == "parece favorável":
		return "resposta_favoravel"
	case tipo == "resposta" && leitura == "parece desfavorável":
		return "resposta_desfavoravel"
	case tipo == "resposta":
		return "resposta_outra"
	}
	return tipo
}

// analistaDaRegra: analista configurado para a chave (nil = admin direciona, ou tabela ainda não criada).
func analistaDaRegra(db *gorm.DB, chave string) *int64 {
	var id int64
	if err := db.Raw(`SELECT COALESCE(r.id_usuario_responsavel, 0) FROM FT_TAREFAS_REGRAS r
		JOIN DM_USUARIO u ON u.id_usuario = r.id_usuario_responsavel AND u.usuario_ativo = 1
		WHERE r.chave = ?`, chave).Row().Scan(&id); err != nil || id <= 0 {
		return nil
	}
	return &id
}

// ResponsavelDoProtocolo: quem cuida DESTE protocolo — só o que é do protocolo conta, não quem mexeu em
// outras coisas do processo. Ordem: responsável marcado no protocolo; senão quem fez a movimentação mais
// recente do histórico que cita o nº do protocolo (formatado ou só dígitos). Só usuário ativo e de verdade
// (o "sistema" da migração não conta); nil se ninguém — aí os admins direcionam.
func ResponsavelDoProtocolo(db *gorm.DB, idProcesso int64, num string, responsavel *int64) *int64 {
	var id int64
	if responsavel != nil && *responsavel > 0 {
		if db.Raw(`SELECT id_usuario FROM DM_USUARIO WHERE id_usuario = ? AND usuario_ativo = 1 AND nome_usuario <> 'sistema'`,
			*responsavel).Row().Scan(&id) == nil && id > 0 {
			return &id
		}
	}
	err := db.Raw(`SELECT h.id_usuario_gestor FROM FT_HISTORICO_MOVIMENTACOES h
		JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor AND u.usuario_ativo = 1 AND u.nome_usuario <> 'sistema'
		WHERE h.id_processo = ? AND (h.comentario LIKE ? OR h.comentario LIKE ?)
		ORDER BY h.data_movimentacao DESC LIMIT 1`, idProcesso, "%"+Formatar(num)+"%", "%"+num+"%").Row().Scan(&id)
	if err != nil || id <= 0 {
		return nil
	}
	return &id
}

// tarefaDaMudanca cria a tarefa da mudança do protocolo e avisa quem recebeu. Responsável = quem cuida do
// protocolo (ResponsavelDoProtocolo); sem processo (ou sem ninguém) a tarefa fica sem responsável e os admins
// são avisados para direcionar. A conclusão também vai para o grupo da equipe no WhatsApp.
func tarefaDaMudanca(db *gorm.DB, tipo, num string, l linhaProt, idEvento int64) bool {
	var titulo string
	switch tipo {
	case "resposta":
		titulo = fmt.Sprintf("Protocolo ANEEL %s concluído pela ANEEL", Formatar(num))
	case "prazo":
		titulo = fmt.Sprintf("Protocolo ANEEL %s: prazo da distribuidora encerrado", Formatar(num))
	case "registro":
		titulo = fmt.Sprintf("Protocolo ANEEL %s registrado e ainda sem processo", Formatar(num))
	default:
		return false
	}
	if idEvento > 0 {
		var ja int64
		_ = db.Raw("SELECT COUNT(*) FROM FT_TAREFAS WHERE protocolo_num = ? AND id_evento = ?", num, idEvento).Row().Scan(&ja)
		if ja > 0 {
			return false
		}
	}
	var resp *int64
	if l.idProcesso != nil {
		resp = ResponsavelDoProtocolo(db, *l.idProcesso, num, l.responsavel)
	}
	var evento any
	if idEvento > 0 {
		evento = idEvento
	}
	if err := db.Exec(`INSERT INTO FT_TAREFAS (tipo, titulo, descricao, id_processo, protocolo_num, id_evento, id_usuario_responsavel, direcionado_em)
		VALUES (?, ?, ?, ?, ?, ?, ?, IF(? IS NULL, NULL, NOW()))`,
		"protocolo_"+tipo, titulo, "Responsável: quem cuida do protocolo (marcado no protocolo ou última movimentação que o cita).", l.idProcesso, num, evento, resp, resp).Error; err != nil {
		log.Printf("[protocolos] tarefa %s: %v", num, err)
		return false
	}
	msg := titulo
	if l.idProcesso != nil {
		msg += fmt.Sprintf(" (processo #%d)", *l.idProcesso)
	}
	if resp != nil {
		rotinas.NotificarNoSistema(db, *resp, "Nova tarefa para você: "+msg)
	} else {
		AvisarAdmins(db, "Tarefa sem responsável para direcionar: "+msg)
	}
	if tipo == "resposta" {
		// no grupo, quem recebeu a tarefa vai em negrito (*texto* no WhatsApp)
		para := " — *sem responsável* (admin direciona)"
		if resp != nil {
			var nome string
			_ = db.Raw("SELECT COALESCE(nome_usuario,'') FROM DM_USUARIO WHERE id_usuario = ?", *resp).Row().Scan(&nome)
			if nome != "" {
				para = " — para *" + nome + "*"
			}
		}
		whatsapp.AvisarGrupo(msg + para)
	}
	return true
}

// AvisarAdmins manda o alerta na tela para todos os administradores ativos.
func AvisarAdmins(db *gorm.DB, msg string) {
	var ids []int64
	_ = db.Raw("SELECT id_usuario FROM DM_USUARIO WHERE usuario_ativo = 1 AND perfil = 'admin' AND nome_usuario <> 'sistema'").Scan(&ids).Error
	for _, id := range ids {
		rotinas.NotificarNoSistema(db, id, msg)
	}
}

// RodarAgendado é chamado pelo gocron a cada 15 min.
func RodarAgendado() {
	if _, err := Sincronizar(); err != nil {
		log.Printf("[protocolos] %v", err)
	}
}
