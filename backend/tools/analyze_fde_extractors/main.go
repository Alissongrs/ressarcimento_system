package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

	_ "github.com/go-sql-driver/mysql"
	"github.com/joho/godotenv"
)

type extractor struct {
	Name string
	Col  string
}

type fieldRule struct {
	Name       string
	DBCol      string
	Kind       string
	Patterns   []*regexp.Regexp
	NeedsTable bool
}

type fieldStats struct {
	Field          string `json:"field"`
	DBCol          string `json:"db_col"`
	Kind           string `json:"kind"`
	Rows           int    `json:"rows"`
	DBFilled       int    `json:"db_filled"`
	DBMissing      int    `json:"db_missing"`
	FoundWhenMiss  int    `json:"found_when_missing"`
	Plumber        int    `json:"plumber"`
	Markdown       int    `json:"markdown"`
	OCR            int    `json:"ocr"`
	BBox           int    `json:"bbox"`
	NeedsTable     bool   `json:"needs_table"`
	OpportunityPct string `json:"opportunity_pct"`
}

type textStats struct {
	Col        string `json:"col"`
	Filled     int    `json:"filled"`
	AvgLen     int    `json:"avg_len"`
	MaxLen     int    `json:"max_len"`
	HasNFKey   int    `json:"has_nf_key"`
	HasDates   int    `json:"has_dates"`
	HasTribute int    `json:"has_tribute_labels"`
	HasItems   int    `json:"has_item_labels"`
}

var extractors = []extractor{
	{Name: "plumber", Col: "texto_plumber"},
	{Name: "markdown", Col: "texto_markdown"},
	{Name: "ocr", Col: "texto_ocr"},
	{Name: "bbox", Col: "texto_bbox"},
}

var rules = []fieldRule{
	{Name: "chave_nfe", DBCol: "chave_nfe", Kind: "label_adjacent", Patterns: rx(`(?i)(?:chave\s+(?:de\s+)?acesso|reservado\s+ao\s+fisco|chave\s+nf\w*)\D{0,80}([0-9][0-9 .-]{42,70})`)},
	{Name: "data_vencimento", DBCol: "data_vencimento", Kind: "header_value", NeedsTable: true, Patterns: rx(`(?i)data\s+de\s+vencimento.{0,120}?([0-3]?\d/[01]?\d/\d{2,4})`, `(?i)vencimento.{0,80}?([0-3]?\d/[01]?\d/\d{2,4})`)},
	{Name: "data_emissao", DBCol: "data_emissao", Kind: "header_value", NeedsTable: true, Patterns: rx(`(?i)data\s+de\s+emiss[aã]o.{0,120}?([0-3]?\d/[01]?\d/\d{2,4})`, `(?i)emiss[aã]o.{0,80}?([0-3]?\d/[01]?\d/\d{2,4})`)},
	{Name: "numero_fatura", DBCol: "numero_fatura", Kind: "label_adjacent", Patterns: rx(`(?i)(?:n[ºo.]?\s*(?:da\s*)?(?:fatura|conta)|nota\s+fiscal\s+n[ºo.]?)\D{0,50}([0-9][0-9./-]{3,40})`)},
	{Name: "codigo_uc", DBCol: "codigo_uc", Kind: "label_adjacent", Patterns: rx(`(?i)(?:unidade\s+consumidora|c[oó]digo\s+(?:da\s+)?(?:uc|instala[cç][aã]o)|instala[cç][aã]o)\D{0,50}([0-9]{4,20})`)},
	{Name: "cpf_cnpj", DBCol: "cpf_cnpj", Kind: "label_adjacent", Patterns: rx(`(?i)(?:cnpj|cpf)\D{0,30}([0-9]{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}|[0-9]{3}\.?\d{3}\.?\d{3}-?\d{2})`)},
	{Name: "cep", DBCol: "cep", Kind: "label_adjacent", Patterns: rx(`(?i)(?:cep)\D{0,20}([0-9]{5}-?\d{3})`)},
	{Name: "valor_total_fatura", DBCol: "valor_total_fatura", Kind: "label_adjacent", Patterns: rx(`(?i)(?:total\s+a\s+pagar|valor\s+(?:total\s+)?(?:da\s+)?fatura|total\s+da\s+nota)\D{0,80}(?:r\$\s*)?([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2}|[0-9]+,[0-9]{2})`)},
	{Name: "consumo_ativo_ponta_kwh", DBCol: "consumo_ativo_ponta_kwh", Kind: "item_table", NeedsTable: true, Patterns: rx(`(?i)consumo\s+ativo.{0,30}ponta.{0,80}?([0-9]{1,3}(?:\.[0-9]{3})*,\d{2,6}|[0-9]+,\d{2,6}|[0-9]{2,8})`)},
	{Name: "consumo_ativo_fponta_kwh", DBCol: "consumo_ativo_fponta_kwh", Kind: "item_table", NeedsTable: true, Patterns: rx(`(?i)consumo\s+ativo.{0,40}(?:fora\s*[- ]?ponta|fponta|f\s*ponta).{0,80}?([0-9]{1,3}(?:\.[0-9]{3})*,\d{2,6}|[0-9]+,\d{2,6}|[0-9]{2,8})`)},
	{Name: "tarifa_te", DBCol: "tarifa_te", Kind: "item_table", NeedsTable: true, Patterns: rx(`(?i)(?:tarifa\s+te|-\s*te\b|te\s+r\$/kwh).{0,80}?([0-9]+,[0-9]{4,8})`)},
	{Name: "tarifa_tusd", DBCol: "tarifa_tusd", Kind: "item_table", NeedsTable: true, Patterns: rx(`(?i)(?:tarifa\s+tusd|-\s*tusd\b|tusd\s+r\$/kwh).{0,80}?([0-9]+,[0-9]{4,8})`)},
	{Name: "icms_valor", DBCol: "icms_valor", Kind: "tax_table", NeedsTable: true, Patterns: rx(`(?i)icms.{0,120}?([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2}|[0-9]+,[0-9]{2})`)},
	{Name: "pis_valor", DBCol: "pis_valor", Kind: "tax_table", NeedsTable: true, Patterns: rx(`(?i)\bpis\b.{0,120}?([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2}|[0-9]+,[0-9]{2})`)},
	{Name: "cofins_valor", DBCol: "cofins_valor", Kind: "tax_table", NeedsTable: true, Patterns: rx(`(?i)cofins.{0,120}?([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2}|[0-9]+,[0-9]{2})`)},
}

func rx(patterns ...string) []*regexp.Regexp {
	out := make([]*regexp.Regexp, 0, len(patterns))
	for _, p := range patterns {
		out = append(out, regexp.MustCompile(p))
	}
	return out
}

func main() {
	_ = godotenv.Load(".env")
	dsn := strings.TrimSpace(os.Getenv("DB_APP_URL"))
	if dsn == "" {
		log.Fatal("DB_APP_URL nao encontrado no .env")
	}
	if !strings.Contains(dsn, "?") {
		dsn += "?parseTime=true&charset=utf8mb4"
	} else {
		dsn += "&parseTime=true&charset=utf8mb4"
	}

	limit := 300
	if len(os.Args) > 1 {
		if n, err := strconv.Atoi(os.Args[1]); err == nil && n > 0 {
			limit = n
		}
	}

	db, err := sql.Open("mysql", dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		log.Fatal(err)
	}

	cols := columns(db)
	selectCols := []string{"id", "cod_empresa", "distribuidora"}
	for _, r := range rules {
		if cols[r.DBCol] {
			selectCols = append(selectCols, r.DBCol)
		}
	}
	for _, e := range extractors {
		if cols[e.Col] {
			selectCols = append(selectCols, e.Col)
		}
	}

	q := fmt.Sprintf("SELECT %s FROM FATURA_DADOS_EXTRAIDOS WHERE cod_empresa = 4 ORDER BY id DESC LIMIT ?", joinBacktick(selectCols))
	rows, err := db.Query(q, limit)
	if err != nil {
		log.Fatal(err)
	}
	defer rows.Close()

	colNames, _ := rows.Columns()
	fieldAgg := map[string]*fieldStats{}
	textAgg := map[string]*textStats{}
	distRows := map[string]int{}
	for _, r := range rules {
		fieldAgg[r.Name] = &fieldStats{Field: r.Name, DBCol: r.DBCol, Kind: r.Kind, NeedsTable: r.NeedsTable}
	}
	for _, e := range extractors {
		textAgg[e.Name] = &textStats{Col: e.Col}
	}

	rowCount := 0
	for rows.Next() {
		vals := make([]sql.NullString, len(colNames))
		ptrs := make([]any, len(colNames))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			log.Fatal(err)
		}
		rec := map[string]string{}
		for i, c := range colNames {
			if vals[i].Valid {
				rec[c] = vals[i].String
			}
		}
		rowCount++
		distRows[rec["distribuidora"]]++
		texts := map[string]string{}
		for _, e := range extractors {
			texts[e.Name] = rec[e.Col]
			updateTextStats(textAgg[e.Name], rec[e.Col])
		}
		for _, r := range rules {
			fs := fieldAgg[r.Name]
			fs.Rows++
			dbFilled := strings.TrimSpace(rec[r.DBCol]) != "" && strings.TrimSpace(rec[r.DBCol]) != "0"
			if dbFilled {
				fs.DBFilled++
				continue
			}
			fs.DBMissing++
			foundAny := false
			for _, e := range extractors {
				if findAny(r.Patterns, texts[e.Name]) {
					foundAny = true
					switch e.Name {
					case "plumber":
						fs.Plumber++
					case "markdown":
						fs.Markdown++
					case "ocr":
						fs.OCR++
					case "bbox":
						fs.BBox++
					}
				}
			}
			if foundAny {
				fs.FoundWhenMiss++
			}
		}
	}

	out := map[string]any{
		"sample_rows":    rowCount,
		"distribuidoras": topMap(distRows, 25),
		"text_stats":     sortedTextStats(textAgg),
		"field_stats":    sortedFieldStats(fieldAgg),
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	fmt.Println(string(b))
}

func columns(db *sql.DB) map[string]bool {
	rows, err := db.Query("SHOW COLUMNS FROM FATURA_DADOS_EXTRAIDOS")
	if err != nil {
		log.Fatal(err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var field, typ, null, key, def, extra sql.NullString
		_ = rows.Scan(&field, &typ, &null, &key, &def, &extra)
		if field.Valid {
			out[field.String] = true
		}
	}
	return out
}

func joinBacktick(cols []string) string {
	parts := make([]string, len(cols))
	for i, c := range cols {
		parts[i] = "`" + c + "`"
	}
	return strings.Join(parts, ", ")
}

func findAny(patterns []*regexp.Regexp, text string) bool {
	if strings.TrimSpace(text) == "" {
		return false
	}
	for _, p := range patterns {
		if p.MatchString(text) {
			return true
		}
	}
	return false
}

func updateTextStats(s *textStats, text string) {
	if strings.TrimSpace(text) == "" {
		return
	}
	s.Filled++
	l := len([]rune(text))
	s.AvgLen += l
	if l > s.MaxLen {
		s.MaxLen = l
	}
	if regexp.MustCompile(`[0-9][0-9 .-]{42,70}`).MatchString(text) {
		s.HasNFKey++
	}
	if regexp.MustCompile(`(?i)data\s+de\s+vencimento|data\s+de\s+emiss[aã]o|leitura\s+anterior`).MatchString(text) {
		s.HasDates++
	}
	if regexp.MustCompile(`(?i)\bicms\b|\bpis\b|cofins|base\s+de\s+c[aá]lculo`).MatchString(text) {
		s.HasTribute++
	}
	if regexp.MustCompile(`(?i)consumo\s+ativo|demanda|tusd|te\b|descri[cç][aã]o`).MatchString(text) {
		s.HasItems++
	}
}

func sortedTextStats(m map[string]*textStats) []textStats {
	out := make([]textStats, 0, len(m))
	for _, v := range m {
		if v.Filled > 0 {
			v.AvgLen = v.AvgLen / v.Filled
		}
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Col < out[j].Col })
	return out
}

func sortedFieldStats(m map[string]*fieldStats) []fieldStats {
	out := make([]fieldStats, 0, len(m))
	for _, v := range m {
		if v.DBMissing > 0 {
			v.OpportunityPct = fmt.Sprintf("%.1f", 100*float64(v.FoundWhenMiss)/float64(v.DBMissing))
		} else {
			v.OpportunityPct = "0.0"
		}
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].FoundWhenMiss == out[j].FoundWhenMiss {
			return out[i].Field < out[j].Field
		}
		return out[i].FoundWhenMiss > out[j].FoundWhenMiss
	})
	return out
}

func topMap(m map[string]int, n int) []map[string]any {
	type kv struct {
		K string
		V int
	}
	var arr []kv
	for k, v := range m {
		arr = append(arr, kv{k, v})
	}
	sort.Slice(arr, func(i, j int) bool { return arr[i].V > arr[j].V })
	if len(arr) > n {
		arr = arr[:n]
	}
	out := make([]map[string]any, 0, len(arr))
	for _, x := range arr {
		out = append(out, map[string]any{"name": x.K, "rows": x.V})
	}
	return out
}
