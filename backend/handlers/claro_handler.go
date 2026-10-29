package handlers

// Consulta (SOMENTE LEITURA) das faturas Claro extraídas.
// Fonte: FATURA_CLARO_DADOS_EXTRAIDOS (RDS db_ressarcimento, ~695k linhas). A coluna
// `link` (populada a partir do Google Drive) alimenta o botão "abrir PDF" no front.
// NÃO há escrita aqui — é uma camada de consulta pura.
//
//   GET /api/v1/claro/resumo   -> cards (total, com_link, soma valor, UCs, período, por distribuidora)
//   GET /api/v1/claro/faturas  -> lista paginada + filtros (uc, cnpj, cliente, distribuidora, mês, valor, texto)

import (
	"database/sql"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

const claroTabela = "FATURA_CLARO_DADOS_EXTRAIDOS"

// monta o WHERE dinâmico a partir dos filtros da query (compartilhado por lista e count).
func claroFiltros(c *gin.Context) (string, []interface{}) {
	var conds []string
	var args []interface{}
	add := func(cond string, vals ...interface{}) { conds = append(conds, cond); args = append(args, vals...) }

	// Filtros de campo específico usam PREFIXO (LIKE 'v%') p/ aproveitar os índices
	// (wildcard no início — '%v%' — não usa índice). A busca livre `q` e `cliente`
	// seguem "contém" (varredura), como fallback amplo.
	if v := strings.TrimSpace(c.Query("uc")); v != "" {
		// casa tambem pelo numero relacionado (de/para 2026): busca por qualquer um dos numeros
		// (novo ou antigo) encontra a fatura. PREFIXO nos tres -> usa indice (rapido em 1,5M linhas).
		add("(numero_instalacao LIKE ? OR codigo_uc LIKE ? OR numero_instalacao_relacionado LIKE ?)", v+"%", v+"%", v+"%")
	}
	if v := strings.TrimSpace(c.Query("cnpj")); v != "" {
		add("cnpj_cliente LIKE ?", v+"%")
	}
	if v := strings.TrimSpace(c.Query("cliente")); v != "" {
		add("nome_cliente LIKE ?", "%"+v+"%")
	}
	if v := strings.TrimSpace(c.Query("distribuidora")); v != "" {
		add("distribuidora LIKE ?", v+"%")
	}
	if v := strings.TrimSpace(c.Query("mes")); v != "" {
		add("mes_referencia LIKE ?", v+"%")
	}
	if v := strings.TrimSpace(c.Query("valor_min")); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			add("valor_total >= ?", f)
		}
	}
	if v := strings.TrimSpace(c.Query("valor_max")); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			add("valor_total <= ?", f)
		}
	}
	if v := strings.TrimSpace(c.Query("q")); v != "" {
		add("(arquivo_origem LIKE ? OR nome_cliente LIKE ? OR numero_instalacao LIKE ? OR codigo_uc LIKE ? OR numero_instalacao_relacionado LIKE ?)",
			"%"+v+"%", "%"+v+"%", "%"+v+"%", "%"+v+"%", "%"+v+"%")
	}
	if strings.TrimSpace(c.Query("com_link")) == "1" {
		add("link IS NOT NULL")
	}
	if v := strings.TrimSpace(c.Query("status")); v != "" {
		add("status = ?", v)
	}
	if len(conds) == 0 {
		return "", args
	}
	return " WHERE " + strings.Join(conds, " AND "), args
}

// GET /api/v1/claro/resumo — cards agregados (tabela inteira, carregado uma vez).
func GetClaroResumo(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	var total, comLink, ucs int64
	var somaValor float64
	var mesMin, mesMax sql.NullString
	_ = sqlDB.QueryRow(`
		SELECT COUNT(*),
		       COALESCE(SUM(CASE WHEN link IS NOT NULL THEN 1 ELSE 0 END),0),
		       COUNT(DISTINCT NULLIF(TRIM(numero_instalacao),'')),
		       COALESCE(SUM(valor_total),0),
		       MIN(NULLIF(TRIM(mes_referencia),'')),
		       MAX(NULLIF(TRIM(mes_referencia),''))
		  FROM ` + claroTabela).
		Scan(&total, &comLink, &ucs, &somaValor, &mesMin, &mesMax)

	type distItem struct {
		Distribuidora string `json:"distribuidora"`
		Qtd           int64  `json:"qtd"`
	}
	var dists []distItem
	rows, qErr := sqlDB.Query(`
		SELECT COALESCE(NULLIF(TRIM(distribuidora),''),'(sem distribuidora)') d, COUNT(*) n
		  FROM ` + claroTabela + `
		 GROUP BY d ORDER BY n DESC LIMIT 15`)
	if qErr == nil {
		defer rows.Close()
		for rows.Next() {
			var it distItem
			if rows.Scan(&it.Distribuidora, &it.Qtd) == nil {
				dists = append(dists, it)
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"total_faturas":  total,
		"com_link":       comLink,
		"sem_link":       total - comLink,
		"ucs":            ucs,
		"soma_valor":     somaValor,
		"mes_min":        mesMin.String,
		"mes_max":        mesMax.String,
		"por_distribuidora": dists,
	})
}

// GET /api/v1/claro/faturas — lista paginada (server-side) + filtros.
func GetClaroFaturas(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	if offset < 0 {
		offset = 0
	}
	where, args := claroFiltros(c)

	// total do filtro (pra paginação)
	var total int64
	_ = sqlDB.QueryRow("SELECT COUNT(*) FROM "+claroTabela+where, args...).Scan(&total)

	q := `
		SELECT id, COALESCE(uid,''), COALESCE(arquivo_origem,''),
		       COALESCE(distribuidora,''), COALESCE(numero_instalacao,''), COALESCE(codigo_uc,''),
		       COALESCE(numero_instalacao_relacionado,''),
		       COALESCE(mes_referencia,''), COALESCE(nome_cliente,''), COALESCE(cnpj_cliente,''),
		       COALESCE(consumo_kwh,0), COALESCE(valor_total,0),
		       COALESCE(fichas,''), COALESCE(status,''), COALESCE(gd,0), link
		  FROM ` + claroTabela + where + `
		 ORDER BY id DESC LIMIT ? OFFSET ?`
	rows, qErr := sqlDB.Query(q, append(args, limit, offset)...)
	if qErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro na consulta: " + qErr.Error()})
		return
	}
	defer rows.Close()

	type faturaRow struct {
		ID              int64   `json:"id"`
		UID             string  `json:"uid"`
		ArquivoOrigem   string  `json:"arquivo_origem"`
		Distribuidora   string  `json:"distribuidora"`
		NumeroInstalacao string `json:"numero_instalacao"`
		CodigoUC        string  `json:"codigo_uc"`
		NumeroRelacionado string `json:"numero_instalacao_relacionado"`
		MesReferencia   string  `json:"mes_referencia"`
		NomeCliente     string  `json:"nome_cliente"`
		CnpjCliente     string  `json:"cnpj_cliente"`
		ConsumoKwh      float64 `json:"consumo_kwh"`
		ValorTotal      float64 `json:"valor_total"`
		Fichas          string  `json:"fichas"`
		Status          string  `json:"status"`
		GD              int     `json:"gd"`
		Link            *string `json:"link"`
	}
	out := make([]faturaRow, 0, limit)
	for rows.Next() {
		var r faturaRow
		if rows.Scan(&r.ID, &r.UID, &r.ArquivoOrigem, &r.Distribuidora, &r.NumeroInstalacao,
			&r.CodigoUC, &r.NumeroRelacionado, &r.MesReferencia, &r.NomeCliente, &r.CnpjCliente, &r.ConsumoKwh,
			&r.ValorTotal, &r.Fichas, &r.Status, &r.GD, &r.Link) == nil {
			out = append(out, r)
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"faturas": out,
		"total":   total,
		"limit":   limit,
		"offset":  offset,
	})
}

// ── Cobertura por UC: meses que a UC TEM (com link) + meses que FALTAM (gaps) ──
// GET /api/v1/claro/uc-cobertura?uc=<uc>
// Normaliza mes_referencia p/ AAAA-MM (aceita "MM/AAAA" e "DD/MM/AAAA"), monta a série
// mensal da UC e aponta os buracos entre o 1º e o último mês. Casa também o número
// antigo/novo (de/para 2026) e variações de zero à esquerda.
var reMesFull = regexp.MustCompile(`^\d{2}/(\d{2})/(\d{4})$`) // DD/MM/AAAA
var reMesMY = regexp.MustCompile(`^(\d{1,2})/(\d{4})$`)       // M/AAAA

func normMesClaro(s string) string {
	s = strings.TrimSpace(s)
	if m := reMesFull.FindStringSubmatch(s); m != nil {
		return m[2] + "-" + m[1]
	}
	if m := reMesMY.FindStringSubmatch(s); m != nil {
		mm := m[1]
		if len(mm) == 1 {
			mm = "0" + mm
		}
		return m[2] + "-" + mm
	}
	return ""
}

func GetClaroCoberturaUC(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}
	uc := strings.TrimSpace(c.Query("uc"))
	if uc == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "informe ?uc="})
		return
	}
	// variações: como está, sem zeros à esquerda, e com 00 à frente (formato do banco varia)
	ucStrip := strings.TrimLeft(uc, "0")
	if ucStrip == "" {
		ucStrip = uc
	}
	vars := map[string]bool{uc: true, ucStrip: true, "00" + ucStrip: true, "000" + ucStrip: true, "0" + ucStrip: true}
	conds := make([]string, 0, len(vars)*3)
	args := make([]interface{}, 0, len(vars)*3)
	for v := range vars {
		conds = append(conds, "numero_instalacao=? OR codigo_uc=? OR numero_instalacao_relacionado=?")
		args = append(args, v, v, v)
	}
	q := "SELECT COALESCE(mes_referencia,''), link, COALESCE(numero_instalacao,''), COALESCE(distribuidora,''), COALESCE(nome_cliente,'') FROM " +
		claroTabela + " WHERE " + strings.Join(conds, " OR ")
	rows, qErr := sqlDB.Query(q, args...)
	if qErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro na consulta: " + qErr.Error()})
		return
	}
	defer rows.Close()

	type mesInfo struct {
		Mes   string  `json:"mes"`   // AAAA-MM
		Label string  `json:"label"` // MM/AAAA
		Orig  string  `json:"origem"`
		Link  *string `json:"link"`
	}
	byMes := map[string]*mesInfo{}
	total := 0
	dist, cliente, niReal := "", "", ""
	for rows.Next() {
		var mesOrig, di, cli, ni string
		var link *string
		if rows.Scan(&mesOrig, &link, &ni, &di, &cli) != nil {
			continue
		}
		total++
		if di != "" {
			dist = di
		}
		if cli != "" {
			cliente = cli
		}
		if ni != "" {
			niReal = ni
		}
		norm := normMesClaro(mesOrig)
		if norm == "" {
			continue
		}
		cur, ok := byMes[norm]
		// mantém a que tem link (prioriza fatura acessível)
		if !ok || (cur.Link == nil && link != nil) {
			byMes[norm] = &mesInfo{Mes: norm, Label: norm[5:] + "/" + norm[:4], Orig: mesOrig, Link: link}
		}
	}

	presentes := make([]*mesInfo, 0, len(byMes))
	for _, v := range byMes {
		presentes = append(presentes, v)
	}
	sort.Slice(presentes, func(i, j int) bool { return presentes[i].Mes < presentes[j].Mes })

	faltantes := []string{}
	if len(presentes) >= 2 {
		toN := func(m string) int { y, _ := strconv.Atoi(m[:4]); mo, _ := strconv.Atoi(m[5:]); return y*12 + (mo - 1) }
		fromN := func(n int) string {
			y := n / 12
			mo := n%12 + 1
			return strconv.Itoa(y) + "-" + func() string {
				if mo < 10 {
					return "0" + strconv.Itoa(mo)
				}
				return strconv.Itoa(mo)
			}()
		}
		have := map[string]bool{}
		for _, p := range presentes {
			have[p.Mes] = true
		}
		lo, hi := toN(presentes[0].Mes), toN(presentes[len(presentes)-1].Mes)
		for n := lo + 1; n < hi; n++ {
			mm := fromN(n)
			if !have[mm] {
				faltantes = append(faltantes, mm[5:]+"/"+mm[:4])
			}
		}
	}

	var periodo gin.H
	if len(presentes) > 0 {
		periodo = gin.H{"primeiro": presentes[0].Label, "ultimo": presentes[len(presentes)-1].Label}
	}
	c.JSON(http.StatusOK, gin.H{
		"uc":            uc,
		"numero_real":   niReal,
		"distribuidora": dist,
		"cliente":       cliente,
		"total_faturas": total,
		"periodo":       periodo,
		"presentes":     presentes,
		"faltantes":     faltantes,
	})
}
