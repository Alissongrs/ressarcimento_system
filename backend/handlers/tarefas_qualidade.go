package handlers

// Qualidade dos dados por AMOSTRAGEM (tela Tarefas do sistema, só admin) — 03/11/2026.
// Sorteia N faturas que entraram no período (água: FATURA_AGUA_DADOS.criado_em; energia:
// FATURA_DADOS_EXTRAIDOS.extraido_em) e passa cada uma por checagens simples de completude e coerência.
// Só LÊ o banco. "erro" = dado de que as regras/requisição dependem está faltando; "alerta" = vale conferir.
//
// GET /api/v1/tarefas-vps/qualidade?base=agua|energia&dias=7&n=30&semente=123

import (
	"database/sql"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type qualCheck struct {
	ID     string  `json:"id"`
	Rotulo string  `json:"rotulo"`
	Nivel  string  `json:"nivel"` // erro | alerta
	Porque string  `json:"porque"`
	Falhas int     `json:"falhas"`
	Pct    float64 `json:"pct_ok"`
}

type qualLinha struct {
	ID        int64    `json:"id"`
	Empresa   int64    `json:"cod_empresa"`
	UC        string   `json:"uc"`
	Origem    string   `json:"origem"` // concessionária / distribuidora
	Mes       string   `json:"mes"`
	Link      string   `json:"link"`
	Problemas []string `json:"problemas"`
	Resumo    string   `json:"resumo"`
}

var qualChecksAgua = []qualCheck{
	{ID: "mes", Rotulo: "Mês de referência", Nivel: "erro", Porque: "sem mês a fatura não entra no histórico da UC"},
	{ID: "consumo", Rotulo: "Consumo em m³", Nivel: "erro", Porque: "sem m³ as regras de pico e de cobrança sem medição não avaliam a fatura"},
	{ID: "valor", Rotulo: "Valor da fatura", Nivel: "erro", Porque: "sem valor não há ressarcimento estimado"},
	{ID: "leituras", Rotulo: "Datas de leitura", Nivel: "erro", Porque: "sem datas o pico é calculado com 30 dias (aproximado)"},
	{ID: "ciclo", Rotulo: "Ciclo entre 15 e 60 dias", Nivel: "alerta", Porque: "ciclo fora disso costuma ser data trocada ou fatura acumulada"},
	{ID: "link", Rotulo: "Link da fatura (PDF)", Nivel: "erro", Porque: "sem PDF não há conferência visual nem dossiê"},
	{ID: "tarifa", Rotulo: "Valor por m³ na faixa usual (R$ 2 a R$ 80)", Nivel: "alerta", Porque: "fora da faixa costuma ser m³ ou valor lido errado"},
	{ID: "hidrometro", Rotulo: "Número do hidrômetro", Nivel: "alerta", Porque: "ajuda a provar troca de hidrômetro; a origem nem sempre traz"},
}

var qualChecksEnergia = []qualCheck{
	{ID: "mes", Rotulo: "Mês de referência", Nivel: "erro", Porque: "sem mês a fatura não entra no histórico da UC"},
	{ID: "instalacao", Rotulo: "Número da instalação/UC", Nivel: "erro", Porque: "sem UC a fatura não é agrupada com as outras"},
	{ID: "distribuidora", Rotulo: "Distribuidora", Nivel: "erro", Porque: "as regras por distribuidora (ICMS, tarifas, prazos) dependem dela"},
	{ID: "valor", Rotulo: "Valor total da fatura", Nivel: "erro", Porque: "sem valor não há ressarcimento estimado"},
	{ID: "leituras", Rotulo: "Datas de leitura", Nivel: "erro", Porque: "as regras de ciclo e de leitura (F33/F34/F06) não avaliam"},
	{ID: "link", Rotulo: "Link da fatura (PDF)", Nivel: "erro", Porque: "sem PDF não há conferência visual nem dossiê"},
	{ID: "consumo", Rotulo: "Consumo em kWh", Nivel: "alerta", Porque: "zero pode ser GD/compensação, mas também consumo não lido"},
	{ID: "ciclo", Rotulo: "Dias faturados entre 15 e 60", Nivel: "alerta", Porque: "fora disso costuma ser data lida errada"},
	{ID: "itens", Rotulo: "Itens da fatura fecham com o total (±2%)", Nivel: "alerta", Porque: "diferença costuma ser item faltando ou duplicado na extração"},
	{ID: "medidor", Rotulo: "Número do medidor", Nivel: "alerta", Porque: "necessário para provar troca de medidor (F08)"},
	{ID: "confianca", Rotulo: "Confiança da extração ≥ 70", Nivel: "alerta", Porque: "abaixo disso a própria extração marcou dúvida"},
}

func qualNum(v float64, dec int) string {
	s := strconv.FormatFloat(v, 'f', dec, 64)
	inteiro, frac, _ := strings.Cut(s, ".")
	neg := strings.HasPrefix(inteiro, "-")
	inteiro = strings.TrimPrefix(inteiro, "-")
	var b strings.Builder
	for i, r := range inteiro {
		if i > 0 && (len(inteiro)-i)%3 == 0 {
			b.WriteByte('.')
		}
		b.WriteRune(r)
	}
	out := b.String()
	if frac != "" {
		out += "," + frac
	}
	if neg {
		out = "-" + out
	}
	return out
}

var reSoDigitos = regexp.MustCompile(`^\d+$`)

// GET /api/v1/tarefas-vps/qualidade
func QualidadeAmostraTarefas(c *gin.Context) {
	db := solicDB(c)
	if db == nil {
		return
	}
	base := c.DefaultQuery("base", "agua")
	dias, _ := strconv.Atoi(c.DefaultQuery("dias", "7"))
	if dias < 1 || dias > 365 {
		dias = 7
	}
	n, _ := strconv.Atoi(c.DefaultQuery("n", "30"))
	if n < 5 || n > 200 {
		n = 30
	}
	semente := c.Query("semente")
	if !reSoDigitos.MatchString(semente) {
		semente = strconv.FormatInt(time.Now().UnixNano()%1000000, 10)
	}
	desde := time.Now().AddDate(0, 0, -dias).Format("2006-01-02")

	var checks []qualCheck
	var total int64
	var linhas []qualLinha
	var err error
	switch base {
	case "agua":
		checks = append([]qualCheck(nil), qualChecksAgua...)
		_ = db.QueryRow("SELECT COUNT(*) FROM FATURA_AGUA_DADOS WHERE criado_em >= ?", desde).Scan(&total)
		linhas, err = amostraAgua(db, desde, n, semente, checks)
	case "energia":
		checks = append([]qualCheck(nil), qualChecksEnergia...)
		_ = db.QueryRow("SELECT COUNT(*) FROM FATURA_DADOS_EXTRAIDOS WHERE extraido_em >= ?", desde).Scan(&total)
		linhas, err = amostraEnergia(db, desde, n, semente, checks)
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "base: agua ou energia"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// percentuais
	idx := map[string]int{}
	for i := range checks {
		idx[checks[i].Rotulo] = i
	}
	semProblema := 0
	comErro := 0
	for _, l := range linhas {
		if len(l.Problemas) == 0 {
			semProblema++
		}
		temErro := false
		for _, p := range l.Problemas {
			if i, ok := idx[p]; ok {
				checks[i].Falhas++
				if checks[i].Nivel == "erro" {
					temErro = true
				}
			}
		}
		if temErro {
			comErro++
		}
	}
	for i := range checks {
		if len(linhas) > 0 {
			checks[i].Pct = math.Round(float64(len(linhas)-checks[i].Falhas)/float64(len(linhas))*1000) / 10
		}
	}
	nota := 0.0
	if len(linhas) > 0 {
		nota = math.Round(float64(len(linhas)-comErro)/float64(len(linhas))*1000) / 10
	}
	// só devolve as linhas com problema (as boas viram contagem)
	comProblema := []qualLinha{}
	for _, l := range linhas {
		if len(l.Problemas) > 0 {
			comProblema = append(comProblema, l)
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"base": base, "desde": desde, "dias": dias, "semente": semente,
		"total_no_periodo": total, "amostra": len(linhas), "sem_problema": semProblema,
		"pct_sem_erro": nota, "checagens": checks, "faturas_com_problema": comProblema,
	})
}

func amostraAgua(db *sql.DB, desde string, n int, semente string, checks []qualCheck) ([]qualLinha, error) {
	rows, err := db.Query(`SELECT id, COALESCE(cod_empresa,0), COALESCE(uc,''), COALESCE(concessionaria,''),
		COALESCE(DATE_FORMAT(mes_referencia,'%Y-%m'),''), COALESCE(consumo_m3,0), COALESCE(rs_total_fat,0), COALESCE(valor_total,0),
		dt_leitura_anterior, dt_leitura_atual, COALESCE(TRIM(link_fatura),''), COALESCE(TRIM(hidrometro),'')
		FROM FATURA_AGUA_DADOS WHERE criado_em >= ? ORDER BY RAND(`+semente+`) LIMIT ?`, desde, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rot := map[string]string{}
	for _, ck := range checks {
		rot[ck.ID] = ck.Rotulo
	}
	out := []qualLinha{}
	for rows.Next() {
		var l qualLinha
		var cons, rs, vt float64
		var ant, atu sql.NullTime
		var hid string
		if rows.Scan(&l.ID, &l.Empresa, &l.UC, &l.Origem, &l.Mes, &cons, &rs, &vt, &ant, &atu, &l.Link, &hid) != nil {
			continue
		}
		valor := rs
		if valor <= 0 {
			valor = vt
		}
		p := []string{}
		add := func(id string) { p = append(p, rot[id]) }
		if l.Mes == "" {
			add("mes")
		}
		if cons <= 0 {
			add("consumo")
		}
		if valor <= 0 {
			add("valor")
		}
		if !ant.Valid || !atu.Valid {
			add("leituras")
		} else if d := atu.Time.Sub(ant.Time).Hours() / 24; d < 15 || d > 60 {
			add("ciclo")
		}
		if l.Link == "" || !linkHostOK(l.Link, aguaPDFHosts) {
			add("link")
		}
		if cons > 0 && valor > 0 {
			if t := valor / cons; t < 2 || t > 80 {
				add("tarifa")
			}
		}
		if hid == "" {
			add("hidrometro")
		}
		l.Problemas = p
		l.Resumo = qualNum(cons, 0) + " m³ · R$ " + qualNum(valor, 2)
		out = append(out, l)
	}
	return out, rows.Err()
}

func amostraEnergia(db *sql.DB, desde string, n int, semente string, checks []qualCheck) ([]qualLinha, error) {
	rows, err := db.Query(`SELECT id, COALESCE(cod_empresa,0), COALESCE(numero_instalacao,''), COALESCE(distribuidora,''),
		COALESCE(DATE_FORMAT(mes_referencia,'%Y-%m'),''), COALESCE(valor_total_fatura,0), COALESCE(kwh_total,0),
		data_leitura_anterior, data_leitura_atual, COALESCE(dias_faturados,0), COALESCE(TRIM(link_fatura),''),
		COALESCE(valor_total_itens,0), COALESCE(TRIM(numero_medidor),''), COALESCE(extracao_score_confianca,-1)
		FROM FATURA_DADOS_EXTRAIDOS WHERE extraido_em >= ? ORDER BY RAND(`+semente+`) LIMIT ?`, desde, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rot := map[string]string{}
	for _, ck := range checks {
		rot[ck.ID] = ck.Rotulo
	}
	out := []qualLinha{}
	for rows.Next() {
		var l qualLinha
		var valor, kwh, itens float64
		var ant, atu sql.NullTime
		var diasF, score int
		var med string
		if rows.Scan(&l.ID, &l.Empresa, &l.UC, &l.Origem, &l.Mes, &valor, &kwh, &ant, &atu, &diasF, &l.Link, &itens, &med, &score) != nil {
			continue
		}
		p := []string{}
		add := func(id string) { p = append(p, rot[id]) }
		if l.Mes == "" {
			add("mes")
		}
		if strings.TrimSpace(l.UC) == "" {
			add("instalacao")
		}
		if strings.TrimSpace(l.Origem) == "" {
			add("distribuidora")
		}
		if valor <= 0 {
			add("valor")
		}
		if !ant.Valid || !atu.Valid {
			add("leituras")
		}
		if l.Link == "" {
			add("link")
		}
		if kwh <= 0 {
			add("consumo")
		}
		if diasF < 15 || diasF > 60 {
			add("ciclo")
		}
		if itens > 0 && valor > 0 && math.Abs(itens-valor) > 0.02*valor+1 {
			add("itens")
		}
		if med == "" {
			add("medidor")
		}
		if score >= 0 && score < 70 {
			add("confianca")
		}
		l.Problemas = p
		l.Resumo = qualNum(kwh, 0) + " kWh · R$ " + qualNum(valor, 2)
		out = append(out, l)
	}
	return out, rows.Err()
}

func linkHostOK(link string, hosts map[string]bool) bool {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil || u.Host == "" {
		return false
	}
	return hosts[strings.ToLower(u.Hostname())]
}
