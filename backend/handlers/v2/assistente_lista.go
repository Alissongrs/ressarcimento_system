package v2

// ─────────────────────────────────────────────────────────────────────────────
// Assistente do SOLICITANTE — LISTA de processos (para baixar em Excel no chat).
//
//   GET /assistente/lista?q=<frase do usuário>
//
// Recebe a frase inteira ("relatório em excel de todos processos da claro que
// tiveram deferimento no ano de 2026") e interpreta no servidor:
//   • cliente  → o nome de cliente cadastrado que aparece na frase (o mais longo);
//   • ano      → primeiro 20xx da frase;
//   • deferidos → frase fala em deferimento/deferido/procedente.
// Com deferimento, o ano filtra a DATA DO DEFERIMENTO (FT_DEFERIMENTOS.data_procedencia);
// sem, filtra a data de criação do processo. Valor só sai de processo deferido
// (mesma regra de liberação do resto do assistente).
// ─────────────────────────────────────────────────────────────────────────────

import (
	"context"
	"database/sql"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"golang.org/x/text/unicode/norm"
)

var (
	reAnoAssist   = regexp.MustCompile(`\b(20\d{2})\b`)
	reDeferAssist = regexp.MustCompile(`defer|procedente|proced[êe]ncia`)
	reNaoLetra    = regexp.MustCompile(`[^a-z0-9]+`)
)

// normTxt: minúsculo, sem acento, só letras/dígitos separados por 1 espaço.
func normTxt(s string) string {
	var b strings.Builder
	for _, r := range norm.NFD.String(strings.ToLower(s)) {
		if r >= 0x300 && r <= 0x36f { // marcas de acento
			continue
		}
		b.WriteRune(r)
	}
	return strings.TrimSpace(reNaoLetra.ReplaceAllString(b.String(), " "))
}

// resolveClienteNaFrase acha, entre os clientes cadastrados, o que aparece na frase
// (palavra inteira; o nome mais longo vence). "" se nenhum.
func resolveClienteNaFrase(ctx context.Context, db *sql.DB, frase string) string {
	rows, err := db.QueryContext(ctx, `
SELECT DISTINCT TRIM(COALESCE(NULLIF(p.cliente,''), r.cliente))
  FROM FT_PROCESSOS p
  LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
 WHERE COALESCE(NULLIF(p.cliente,''), r.cliente) IS NOT NULL`)
	if err != nil {
		return ""
	}
	defer rows.Close()
	f := " " + normTxt(frase) + " "
	var nomes []string
	for rows.Next() {
		var n sql.NullString
		if rows.Scan(&n) == nil && strings.TrimSpace(n.String) != "" {
			nomes = append(nomes, n.String)
		}
	}
	sort.Slice(nomes, func(i, j int) bool { return len(nomes[i]) > len(nomes[j]) })
	for _, n := range nomes {
		k := normTxt(n)
		if len(k) >= 3 && strings.Contains(f, " "+k+" ") {
			return strings.TrimSpace(n)
		}
	}
	return ""
}

type listaLinha struct {
	Processo        string   `json:"processo"`
	UC              string   `json:"uc"`
	Cliente         string   `json:"cliente"`
	Concessionaria  string   `json:"concessionaria"`
	Irregularidade  string   `json:"irregularidade"`
	Etapa           string   `json:"etapa"`
	Instancia       string   `json:"instancia"`
	DataDeferimento string   `json:"data_deferimento"`
	Valor           *float64 `json:"valor"`
}

// AssistenteLista — GET /assistente/lista?q=
func AssistenteLista(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		apiError(c, http.StatusBadRequest, "SEM_Q", "Diga de qual cliente é a lista.", nil)
		return
	}
	ctx := c.Request.Context()
	cliente := resolveClienteNaFrase(ctx, db, q)
	if cliente == "" {
		c.JSON(http.StatusOK, gin.H{"encontrado": false, "motivo": "cliente", "consulta": q})
		return
	}
	nq := normTxt(q)
	soDeferidos := reDeferAssist.MatchString(nq)
	ano := ""
	if m := reAnoAssist.FindStringSubmatch(nq); m != nil {
		ano = m[1]
	}

	where := "LOWER(COALESCE(NULLIF(p.cliente,''), r.cliente)) LIKE ?"
	args := []interface{}{"%" + strings.ToLower(cliente) + "%"}
	join := "LEFT JOIN FT_DEFERIMENTOS d ON d.id_processo = p.id_processo"
	if soDeferidos {
		join = "JOIN FT_DEFERIMENTOS d ON d.id_processo = p.id_processo AND d.data_procedencia IS NOT NULL"
		if ano != "" {
			where += " AND YEAR(d.data_procedencia) = ?"
			args = append(args, ano)
		}
	} else if ano != "" {
		where += " AND YEAR(p.data_criacao) = ?"
		args = append(args, ano)
	}

	rows, err := db.QueryContext(ctx, `
SELECT COALESCE(NULLIF(p.codigo_publico,''), CAST(p.id_processo AS CHAR)),
       COALESCE(NULLIF(p.uc_atual,''), p.uc, ''),
       COALESCE(NULLIF(p.cliente,''), r.cliente, ''),
       COALESCE(NULLIF(r.concessionaria,''), p.concessionaria, ''),
       COALESCE(p.nome_tipo_irregularidade, ''),
       COALESCE(e.nome, ''),
       COALESCE(i.nome, ''),
       DATE_FORMAT(d.data_procedencia,'%Y-%m-%d'),
       CASE WHEN d.data_procedencia IS NOT NULL
            THEN COALESCE(d.credito_simples,0) + COALESCE(d.credito_dobro,0) END
  FROM FT_PROCESSOS p
  LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
  `+join+`
  LEFT JOIN DM_ETAPAS e ON e.id_etapa = p.id_etapa_atual
  LEFT JOIN DM_INSTANCIAS i ON i.id_instancia = d.instancia_deferimento
 WHERE `+where+`
 ORDER BY d.data_procedencia DESC, p.id_processo DESC
 LIMIT 5000`, args...)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer rows.Close()

	linhas := []listaLinha{}
	total := 0.0
	for rows.Next() {
		var l listaLinha
		var dt sql.NullString
		var v sql.NullFloat64
		if err := rows.Scan(&l.Processo, &l.UC, &l.Cliente, &l.Concessionaria, &l.Irregularidade,
			&l.Etapa, &l.Instancia, &dt, &v); err != nil {
			continue
		}
		l.DataDeferimento = dt.String
		if v.Valid && v.Float64 > 0 {
			x := v.Float64
			l.Valor = &x
			total += x
		}
		linhas = append(linhas, l)
	}
	c.JSON(http.StatusOK, gin.H{
		"encontrado":   true,
		"cliente":      cliente,
		"ano":          ano,
		"so_deferidos": soDeferidos,
		"total":        len(linhas),
		"valor_total":  total,
		"linhas":       linhas,
	})
}
