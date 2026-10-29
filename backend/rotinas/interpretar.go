package rotinas

// Interpretação determinística (sem IA) do texto do chat:
//   #rotina quero que todos os e-mails do dia anterior sejam vinculados aos processos às 14:00 e às 18:00
//   sincronize os e-mails desta semana            (rodada única)
//   inclua um lembrete para a Luana Nascimento amanhã às 10:00 sobre o processo 18228
// O chat sempre mostra o Resumo e pede confirmação antes de gravar.

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"
)

type Plano struct {
	Op       string         `json:"op"`
	Tipo     string         `json:"tipo"` // recorrente | unica
	Horarios []string       `json:"horarios"`
	Dias     string         `json:"dias"`
	Params   map[string]any `json:"params"`
	Resumo   string         `json:"resumo"`
}

type PlanoLembrete struct {
	DestinoID   int64        `json:"id_usuario_destino"`
	NomeDestino string       `json:"nome_destino"`
	Data        string       `json:"data"` // YYYY-MM-DD
	Hora        string       `json:"hora"` // HH:MM
	Mensagem    string       `json:"mensagem"`
	IDProcesso  *int64       `json:"id_processo,omitempty"`
	Resumo      string       `json:"resumo"`
	Candidatos  []UsuarioMin `json:"candidatos,omitempty"`
}

type UsuarioMin struct {
	ID    int64  `json:"id_usuario"`
	Nome  string `json:"nome"`
	Email string `json:"email"`
}

var semAcento = strings.NewReplacer(
	"á", "a", "à", "a", "â", "a", "ã", "a", "ä", "a", "é", "e", "ê", "e", "è", "e", "í", "i", "î", "i",
	"ó", "o", "ô", "o", "õ", "o", "ö", "o", "ú", "u", "ü", "u", "ç", "c",
	"Á", "a", "À", "a", "Â", "a", "Ã", "a", "É", "e", "Ê", "e", "Í", "i", "Ó", "o", "Ô", "o", "Õ", "o", "Ú", "u", "Ç", "c",
)

func norm(s string) string { return strings.ToLower(semAcento.Replace(s)) }

var (
	reHoraHM    = regexp.MustCompile(`\b([01]?\d|2[0-3])\s*(?::|h)\s*([0-5]\d)?\b`)
	reHoraAs    = regexp.MustCompile(`\b(?:as|a partir das|ate as)\s+([01]?\d|2[0-3])\b(?:\s*(?:horas|hrs|hs))?`)
	reHoraHoras = regexp.MustCompile(`\b([01]?\d|2[0-3])\s*(?:horas|hrs|hs)\b`)
	reEmails    = regexp.MustCompile(`\be-?mails?\b`)
	reVincular  = regexp.MustCompile(`vincul|sincroniz|associ|relacion|ligar|ligue|anex`)
	reLembr     = regexp.MustCompile(`lembr|avis[ae]r? (a|o|ao)\b`)
	reUltDias   = regexp.MustCompile(`ultimos?\s+(\d{1,2})\s+dias`)
	reDataBR    = `(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?`
	reDesde     = regexp.MustCompile(`desde\s+(?:o\s+dia\s+)?` + reDataBR)
	reEntre     = regexp.MustCompile(`(?:de|entre)\s+(?:o\s+dia\s+)?` + reDataBR + `\s+(?:a|ate|e)\s+` + reDataBR)
	reDiaUnico  = regexp.MustCompile(`\bd[oe]\s+dia\s+` + reDataBR)
	reData      = regexp.MustCompile(`\b` + reDataBR + `\b`)
	reProcesso  = regexp.MustCompile(`(?i)processo\s*(?:n[ºo°.]*\s*)?#?\s*(\d{4,6})\b`)
	reMensagem  = regexp.MustCompile(`(?i)(?:\bsobre\b|\breferente\s+a[o]?\b|\blembrar\s+de\b|\blembrando\s+de\b|\bdizendo\b|\bcom\s+o\s+texto\b|:)\s*(.+)$`)
	diasSemana  = []string{"domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"}
)

// horarios extrai os horários HH:MM citados, em ordem e sem repetição.
func horarios(n string) []string {
	set := map[string]bool{}
	add := func(h, m string) {
		hh, _ := strconv.Atoi(h)
		mm := 0
		if m != "" {
			mm, _ = strconv.Atoi(m)
		}
		set[fmt.Sprintf("%02d:%02d", hh, mm)] = true
	}
	for _, m := range reHoraHM.FindAllStringSubmatch(n, -1) {
		add(m[1], m[2])
	}
	for _, ix := range reHoraAs.FindAllStringSubmatchIndex(n, -1) {
		// "às 14:30" já foi pego acima — aqui só "às 14" sem minutos
		if rest := strings.TrimLeft(n[ix[1]:], " "); strings.HasPrefix(rest, ":") || strings.HasPrefix(rest, "h") {
			continue
		}
		add(n[ix[2]:ix[3]], "")
	}
	for _, m := range reHoraHoras.FindAllStringSubmatch(n, -1) {
		add(m[1], "")
	}
	out := make([]string, 0, len(set))
	for h := range set {
		out = append(out, h)
	}
	sort.Strings(out)
	return out
}

func diasDaSemana(n string) (string, string) {
	switch {
	case strings.Contains(n, "dias uteis") || strings.Contains(n, "segunda a sexta"):
		return "1,2,3,4,5", "de segunda a sexta"
	case strings.Contains(n, "fim de semana") || strings.Contains(n, "fins de semana"):
		return "0,6", "nos fins de semana"
	}
	var ds []string
	var nomes []string
	for i, d := range diasSemana {
		if regexp.MustCompile(`\b(?:toda|todo|todas|todos|as|aos|nas|nos)\s+(?:as\s+|os\s+)?` + d + `s?\b`).MatchString(n) {
			ds = append(ds, strconv.Itoa(i))
			nomes = append(nomes, d)
		}
	}
	if len(ds) > 0 {
		return strings.Join(ds, ","), "toda(s) " + strings.Join(nomes, ", ")
	}
	return "*", "todo dia"
}

func juntarHorarios(h []string) string {
	if len(h) == 1 {
		return h[0]
	}
	return strings.Join(h[:len(h)-1], ", ") + " e " + h[len(h)-1]
}

func dataBR(d, m, a string, ref time.Time) (time.Time, bool) {
	dd, _ := strconv.Atoi(d)
	mm, _ := strconv.Atoi(m)
	aa := ref.Year()
	if a != "" {
		aa, _ = strconv.Atoi(a)
		if aa < 100 {
			aa += 2000
		}
	}
	t := time.Date(aa, time.Month(mm), dd, 0, 0, 0, 0, Loc)
	if t.Day() != dd || int(t.Month()) != mm {
		return t, false
	}
	return t, true
}

// InterpretarRotina monta o plano de uma rotina (#rotina) ou de uma rodada única
// ("sincronize os e-mails desta semana"). recorrente=true quando veio de #rotina.
func InterpretarRotina(db *gorm.DB, texto string, deRotina bool, userID int64, userName string) (*Plano, error) {
	n := norm(texto)
	n = strings.TrimSpace(strings.TrimPrefix(n, "#rotina"))
	ref := time.Now().In(Loc)
	hs := horarios(n)
	dias, diasTxt := diasDaSemana(n)

	tipo := "unica"
	if deRotina || regexp.MustCompile(`\btod[oa]s?\b|diariamente|sempre|cada dia|dias uteis|semanalmente`).MatchString(n) && len(hs) > 0 {
		tipo = "recorrente"
	}
	if regexp.MustCompile(`uma vez|so hoje|apenas hoje|agora`).MatchString(n) && !deRotina {
		tipo = "unica"
	}
	if tipo == "recorrente" && len(hs) == 0 {
		return nil, fmt.Errorf("faltou o horário. Diga, por exemplo: \"às 14:00 e às 18:00\"")
	}

	switch {
	case reEmails.MatchString(n) && reVincular.MatchString(n):
		p := &Plano{Op: "sincronizar_emails", Tipo: tipo, Horarios: hs, Dias: dias, Params: map[string]any{}}
		var janTxt string
		switch {
		case reEntre.MatchString(n):
			m := reEntre.FindStringSubmatch(n)
			de, ok1 := dataBR(m[1], m[2], m[3], ref)
			ate, ok2 := dataBR(m[4], m[5], m[6], ref)
			if !ok1 || !ok2 {
				return nil, fmt.Errorf("data inválida")
			}
			p.Params["janela"], p.Params["de"], p.Params["ate"] = "periodo", de.Format("2006-01-02"), ate.Format("2006-01-02")
			janTxt = fmt.Sprintf("de %s a %s", de.Format("02/01/2006"), ate.Format("02/01/2006"))
		case reDesde.MatchString(n):
			m := reDesde.FindStringSubmatch(n)
			de, ok := dataBR(m[1], m[2], m[3], ref)
			if !ok {
				return nil, fmt.Errorf("data inválida")
			}
			p.Params["janela"], p.Params["de"], p.Params["ate"] = "periodo", de.Format("2006-01-02"), ref.Format("2006-01-02")
			janTxt = "desde " + de.Format("02/01/2006")
		case reDiaUnico.MatchString(n):
			m := reDiaUnico.FindStringSubmatch(n)
			d, ok := dataBR(m[1], m[2], m[3], ref)
			if !ok {
				return nil, fmt.Errorf("data inválida")
			}
			p.Params["janela"], p.Params["de"], p.Params["ate"] = "periodo", d.Format("2006-01-02"), d.Format("2006-01-02")
			janTxt = "do dia " + d.Format("02/01/2006")
		case reUltDias.MatchString(n):
			k, _ := strconv.Atoi(reUltDias.FindStringSubmatch(n)[1])
			p.Params["janela"], p.Params["dias"] = "dias", k
			janTxt = fmt.Sprintf("dos últimos %d dias", k)
		case strings.Contains(n, "semana"):
			p.Params["janela"] = "semana"
			janTxt = "desta semana (desde segunda 00:00)"
		case regexp.MustCompile(`somente (do dia anterior|de ontem)|apenas (do dia anterior|de ontem)|so (do dia anterior|de ontem)`).MatchString(n):
			p.Params["janela"] = "ontem"
			janTxt = "somente do dia anterior (00:00 às 23:59)"
		case regexp.MustCompile(`dia anterior|ontem`).MatchString(n):
			p.Params["janela"] = "desde_ontem"
			janTxt = "desde o dia anterior (ontem 00:00 até a hora da rodada)"
		case regexp.MustCompile(`\bhoje\b|\bdo dia\b`).MatchString(n):
			p.Params["janela"] = "hoje"
			janTxt = "de hoje"
		default:
			p.Params["janela"] = "desde_ontem"
			janTxt = "desde o dia anterior (ontem 00:00 até a hora da rodada)"
		}
		p.Params["janela_txt"] = janTxt
		quando := "uma vez, assim que for aprovada"
		if userID > 0 && tipo == "unica" {
			quando = "uma vez (em até 1 minuto após a aprovação)"
		}
		if tipo == "recorrente" {
			quando = fmt.Sprintf("%s às %s", diasTxt, juntarHorarios(hs))
		}
		p.Resumo = fmt.Sprintf("Vincular aos processos os e-mails sem vínculo %s — só quando o próprio e-mail traz prova que aponta para UM processo (protocolo do histórico, nº do processo ou UC); os demais ficam numa lista para revisão. Quando: %s.", janTxt, quando)
		return p, nil

	case reLembr.MatchString(n):
		if tipo != "recorrente" {
			return nil, fmt.Errorf("para um lembrete único use: \"lembrete para <pessoa> <dia> às <hora> sobre <assunto>\"")
		}
		pl, err := InterpretarLembrete(db, texto, userID, userName)
		if err != nil {
			return nil, err
		}
		if len(pl.Candidatos) > 0 {
			return nil, fmt.Errorf("encontrei mais de uma pessoa com esse nome: %s — escreva o nome completo", nomesCandidatos(pl.Candidatos))
		}
		p := &Plano{Op: "lembrete", Tipo: "recorrente", Horarios: hs, Dias: dias, Params: map[string]any{
			"id_usuario_destino": pl.DestinoID, "nome_destino": pl.NomeDestino, "mensagem": pl.Mensagem,
		}}
		p.Resumo = fmt.Sprintf("Lembrete para %s (no calendário do SURE e por e-mail), %s às %s: \"%s\".",
			pl.NomeDestino, diasTxt, juntarHorarios(hs), pl.Mensagem)
		return p, nil
	}
	return nil, fmt.Errorf("por enquanto sei criar rotinas de: (1) vincular e-mails aos processos e (2) lembretes. Exemplo: \"vincular os e-mails do dia anterior às 14:00 e às 18:00\"")
}

func nomesCandidatos(c []UsuarioMin) string {
	n := []string{}
	for _, u := range c {
		n = append(n, u.Nome)
	}
	return strings.Join(n, ", ")
}

// EhLembrete / EhSincronizacao: o chat usa para decidir o caminho sem #rotina.
func EhLembrete(texto string) bool {
	n := norm(texto)
	return regexp.MustCompile(`\blembrete\b|\blembre(-me)?\b|\blembrar\b`).MatchString(n) &&
		regexp.MustCompile(`\b(para|pra|me|a|o)\b`).MatchString(n)
}

func EhSincronizacao(texto string) bool {
	n := norm(texto)
	return reEmails.MatchString(n) && regexp.MustCompile(`sincroniz|vincul`).MatchString(n)
}

// InterpretarLembrete acha destinatário (pelo nome, entre usuários ativos), dia, hora e texto.
func InterpretarLembrete(db *gorm.DB, texto string, userID int64, userName string) (*PlanoLembrete, error) {
	n := norm(texto)
	ref := time.Now().In(Loc)
	pl := &PlanoLembrete{}

	// destinatário
	if regexp.MustCompile(`\b(me lembr|lembre-me|me avis|para mim|pra mim)\b`).MatchString(n) {
		pl.DestinoID, pl.NomeDestino = userID, userName
	} else {
		cands, err := acharUsuarios(db, n, userID)
		if err != nil {
			return nil, err
		}
		switch len(cands) {
		case 0:
			return nil, fmt.Errorf("não achei a pessoa do lembrete entre os usuários ativos do SURE. Escreva o nome como está no sistema (ex.: \"lembrete para a Luana Nascimento ...\")")
		case 1:
			pl.DestinoID, pl.NomeDestino = cands[0].ID, cands[0].Nome
		default:
			pl.Candidatos = cands
			pl.Resumo = "Encontrei mais de uma pessoa: " + nomesCandidatos(cands) + ". Escreva o nome completo."
			return pl, nil
		}
	}

	// dia
	hoje := time.Date(ref.Year(), ref.Month(), ref.Day(), 0, 0, 0, 0, Loc)
	dia := time.Time{}
	switch {
	case strings.Contains(n, "depois de amanha"):
		dia = hoje.AddDate(0, 0, 2)
	case strings.Contains(n, "amanha"):
		dia = hoje.AddDate(0, 0, 1)
	case regexp.MustCompile(`\bhoje\b`).MatchString(n):
		dia = hoje
	case reData.MatchString(n):
		m := reData.FindStringSubmatch(n)
		if d, ok := dataBR(m[1], m[2], m[3], ref); ok {
			if m[3] == "" && d.Before(hoje) {
				d = d.AddDate(1, 0, 0)
			}
			dia = d
		}
	default:
		for i, d := range diasSemana {
			if regexp.MustCompile(`\b` + d + `(-feira)?\b`).MatchString(n) {
				delta := (i - int(hoje.Weekday()) + 7) % 7
				if delta == 0 {
					delta = 7
				}
				dia = hoje.AddDate(0, 0, delta)
				break
			}
		}
	}

	// hora
	hora := "09:00"
	if hs := horarios(n); len(hs) > 0 {
		hora = hs[0]
	}
	if dia.IsZero() {
		dia = hoje
		if t, _ := time.ParseInLocation("2006-01-02 15:04", hoje.Format("2006-01-02")+" "+hora, Loc); !t.After(ref) {
			dia = hoje.AddDate(0, 0, 1)
		}
	}
	quando, _ := time.ParseInLocation("2006-01-02 15:04", dia.Format("2006-01-02")+" "+hora, Loc)
	if !quando.After(ref.Add(-time.Minute)) {
		return nil, fmt.Errorf("a data/hora do lembrete (%s) já passou", quando.Format("02/01/2006 15:04"))
	}
	pl.Data, pl.Hora = dia.Format("2006-01-02"), hora

	// processo citado
	if m := reProcesso.FindStringSubmatch(texto); m != nil {
		if v, err := strconv.ParseInt(m[1], 10, 64); err == nil {
			var ok int
			_ = db.Raw("SELECT COUNT(*) FROM FT_PROCESSOS WHERE id_processo = ?", v).Row().Scan(&ok)
			if ok > 0 {
				pl.IDProcesso = &v
			}
		}
	}

	// texto: o que vem depois de "sobre/:/lembrar de"; senão, o pedido inteiro
	msg := strings.TrimSpace(texto)
	if m := reMensagem.FindStringSubmatch(texto); m != nil && strings.TrimSpace(m[1]) != "" {
		msg = strings.TrimSpace(m[1])
	}
	msg = strings.TrimSpace(strings.TrimPrefix(msg, "#rotina"))
	pl.Mensagem = msg

	extra := ""
	if pl.IDProcesso != nil {
		extra = fmt.Sprintf(" (processo %d)", *pl.IDProcesso)
	}
	pl.Resumo = fmt.Sprintf("Lembrete para %s em %s às %s%s: \"%s\". Fica no calendário do SURE dela(e) e o e-mail sai na hora marcada.",
		pl.NomeDestino, dia.Format("02/01/2006"), hora, extra, msg)
	return pl, nil
}

// acharUsuarios: usuários ativos cujo primeiro nome aparece no texto; desempata pelo nº de
// partes do nome citadas (ex.: "Luana Nascimento" ganha de "Luana Silva").
func acharUsuarios(db *gorm.DB, n string, userID int64) ([]UsuarioMin, error) {
	rows, err := db.Raw(`SELECT id_usuario, COALESCE(nome_usuario,''), COALESCE(email,'') FROM DM_USUARIO
		WHERE usuario_ativo = 1 AND COALESCE(nome_usuario,'') <> ''`).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var lista []UsuarioMin
	for rows.Next() {
		var u UsuarioMin
		if rows.Scan(&u.ID, &u.Nome, &u.Email) == nil {
			lista = append(lista, u)
		}
	}
	return escolherUsuarios(lista, n, userID), nil
}

// palavra: p aparece em n como palavra inteira.
func palavra(n, p string) bool {
	return regexp.MustCompile(`\b` + regexp.QuoteMeta(p) + `\b`).MatchString(n)
}

func escolherUsuarios(lista []UsuarioMin, n string, userID int64) []UsuarioMin {
	type sc struct {
		u UsuarioMin
		p int
	}
	var todos []sc
	melhor := 0
	for _, u := range lista {
		partes := strings.Fields(norm(u.Nome))
		if len(partes) == 0 || len(partes[0]) < 3 {
			continue
		}
		if !palavra(n, partes[0]) {
			continue
		}
		p := 0
		for _, pt := range partes {
			if len(pt) >= 3 && palavra(n, pt) {
				p++
			}
		}
		todos = append(todos, sc{u, p})
		if p > melhor {
			melhor = p
		}
	}
	out := []UsuarioMin{}
	for _, s := range todos {
		if s.p == melhor {
			out = append(out, s.u)
		}
	}
	// se sobrou o próprio criador junto com outra pessoa, fica com a outra
	if len(out) > 1 {
		f := out[:0]
		for _, u := range out {
			if u.ID != userID {
				f = append(f, u)
			}
		}
		out = f
	}
	return out
}
