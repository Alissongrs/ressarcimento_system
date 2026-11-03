package handlers

// Regras do catálogo aplicáveis às faturas das USINAS (aba ⚡ Usinas da Auditoria de Faturas).
//
// Botão "Regras": escolhe quais regras do catálogo (DM_FICHAS_REGRAS / seed F01–F61) valem para um conjunto
// de faturas ("usinas"). A escolha fica em DM_REGRAS_CONJUNTO (criada só quando alguém salva; sem ela vale o
// padrão = F01–F05). Cada regra tem uma situação:
//   motor      F01–F05 — o motor da Auditoria (desvio_handler.go)
//   fatura     dá para concluir só com a fatura (F13 F14 F15 F17 F27 F35 F36 F52) — implementadas aqui
//   historico  precisa do histórico da UC, que está no banco (F53 F54 F55) — implementadas aqui
//   aneel      usa a tarifa/bandeira homologada importada da ANEEL (F28 F41 F42 F58) — aneel_parametros.go
//   pares      compara com as outras UCs do mesmo município/classe/mês (F51 — CIP/COSIP)
//   parametro  precisa de valor de fora ainda sem fonte (alíquota, CIP do município...) — cadastro por planilha
//   pendente   ainda não implementada
// Critérios: os do texto da regra no catálogo (ERRO / ALERTA), com as tolerâncias que ele fixa.

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

var regrasSituacao = map[string]string{
	"F01": "motor", "F02": "motor", "F03": "motor", "F04": "motor", "F05": "motor",
	"F13": "fatura", "F14": "fatura", "F15": "fatura", "F17": "fatura", "F27": "fatura", "F35": "fatura",
	"F36": "fatura", "F52": "fatura",
	"F53": "historico", "F54": "historico", "F55": "historico",
	"F28": "aneel", "F41": "aneel", "F42": "aneel", "F58": "aneel", "F31": "parametro", "F32": "parametro", "F39": "parametro", "F40": "parametro",
	"F43": "parametro", "F44": "parametro", "F45": "parametro",
	"F46": "parametro", "F51": "pares", "F56": "parametro",
}

// o que falta para as regras que dependem de parâmetro (mostrado na lista)
var regrasPrecisa = map[string]string{
	"F28": "tarifa homologada TE/TUSD — importada da ANEEL", "F58": "TUSD G homologada — importada da ANEEL",
	"F41": "bandeira acionada no mês — importada da ANEEL", "F42": "adicional da bandeira — importado da ANEEL",
	"F31": "datas de vigência dos reajustes (ANEEL)", "F32": "tarifas antiga e nova + data do reajuste (ANEEL)",
	"F39": "alíquotas de ICMS por UF/classe e PIS/COFINS", "F40": "isenções/benefícios de ICMS por UF",
	"F43": "dias de cada bandeira no ciclo (rateio por dias)", "F44": "valor da bandeira + alíquotas",
	"F45": "valor homologado da CDE Covid", "F46": "vigência da CDE Escassez Hídrica",
	"F56": "TUSD Fio B e percentual de transição (Lei 14.300)",
}

var padraoUsinas = []string{"F01", "F02", "F03", "F04", "F05"}

type regraConjunto struct {
	Codigo      string `json:"codigo"`
	Nome        string `json:"nome"`
	Grupo       string `json:"grupo"`
	Situacao    string `json:"situacao"`
	Precisa     string `json:"precisa,omitempty"`
	Selecionada bool   `json:"selecionada"`
}

// selecaoRegras — códigos escolhidos para o conjunto (sem tabela ou sem linhas = padrão F01–F05).
func selecaoRegras(db *sql.DB, conjunto string) (map[string]bool, bool) {
	sel := map[string]bool{}
	rows, err := db.Query(`SELECT codigo FROM DM_REGRAS_CONJUNTO WHERE conjunto = ? AND ativa = 1`, conjunto)
	if err == nil {
		for rows.Next() {
			var c string
			if rows.Scan(&c) == nil {
				sel[c] = true
			}
		}
		rows.Close()
		var n int
		_ = db.QueryRow(`SELECT COUNT(*) FROM DM_REGRAS_CONJUNTO WHERE conjunto = ?`, conjunto).Scan(&n)
		if n > 0 {
			return sel, true
		}
	}
	for _, c := range padraoUsinas {
		sel[c] = true
	}
	return sel, false
}

// catálogo: o editado no banco (DM_FICHAS_REGRAS) ou, se a tabela ainda não existe, o seed embutido
func catalogoRegras(db *sql.DB) []fichaRegra {
	var out []fichaRegra
	if rows, err := db.Query(`SELECT codigo, ordem, nome, COALESCE(grupo,'') FROM DM_FICHAS_REGRAS ORDER BY ordem, codigo`); err == nil {
		for rows.Next() {
			var f fichaRegra
			if rows.Scan(&f.Codigo, &f.Ordem, &f.Nome, &f.Grupo) == nil {
				out = append(out, f)
			}
		}
		rows.Close()
	}
	if len(out) == 0 {
		_ = json.Unmarshal(fichasSeedJSON, &out)
	}
	return out
}

// GET /api/v1/regras-conjunto/:conjunto — catálogo com a situação de cada regra e a seleção atual
func GetRegrasConjunto(c *gin.Context) {
	db, err := usinasDB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	conj := c.Param("conjunto")
	sel, salva := selecaoRegras(db, conj)
	base, _ := baseAneel(db)
	var out []regraConjunto
	for _, f := range catalogoRegras(db) {
		s := situacaoConjunto(conj, f.Codigo)
		pr := regrasPrecisa[f.Codigo]
		if s == "nao_ligada" {
			pr = "roda nas usinas; ainda não ligada a esta base"
		}
		if s == "aneel" && base == nil {
			pr += " (aguardando a 1ª importação)"
		}
		out = append(out, regraConjunto{Codigo: f.Codigo, Nome: f.Nome, Grupo: f.Grupo, Situacao: s,
			Precisa: pr, Selecionada: sel[f.Codigo]})
	}
	c.JSON(http.StatusOK, gin.H{"conjunto": conj, "regras": out, "selecao_salva": salva, "aneel_importado": base != nil})
}

// PUT /api/v1/regras-conjunto/:conjunto {"codigos":["F01",...]} — salva a seleção (só regras executáveis)
func SalvarRegrasConjunto(c *gin.Context) {
	db, err := usinasDB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	conj := c.Param("conjunto")
	if !regexp.MustCompile(`^[a-z0-9_]{2,40}$`).MatchString(conj) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "conjunto inválido"})
		return
	}
	var b struct {
		Codigos []string `json:"codigos"`
	}
	if err := c.ShouldBindJSON(&b); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}
	_, uname := usuarioIA(c)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS DM_REGRAS_CONJUNTO (
  conjunto       VARCHAR(40)  NOT NULL,
  codigo         VARCHAR(8)   NOT NULL,
  ativa          TINYINT      NOT NULL DEFAULT 1,
  atualizado_por VARCHAR(255) NULL,
  atualizado_em  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (conjunto, codigo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	tx, err := db.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback()
	// desmarca todas e marca as escolhidas (a linha fica, com ativa=0, como histórico de quem mexeu)
	if _, err := tx.Exec(`UPDATE DM_REGRAS_CONJUNTO SET ativa = 0, atualizado_por = ?, atualizado_em = NOW() WHERE conjunto = ?`, uname, conj); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	n := 0
	for _, cod := range b.Codigos {
		s := situacaoConjunto(conj, cod)
		if s != "motor" && s != "fatura" && s != "historico" && s != "aneel" && s != "pares" {
			continue // parâmetro/pendente ainda não rodam
		}
		if _, err := tx.Exec(`INSERT INTO DM_REGRAS_CONJUNTO (conjunto, codigo, ativa, atualizado_por, atualizado_em)
			VALUES (?,?,1,?,NOW()) ON DUPLICATE KEY UPDATE ativa = 1, atualizado_por = VALUES(atualizado_por), atualizado_em = NOW()`,
			conj, cod, uname); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		n++
	}
	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	usinasCacheMu.Lock()
	usinasCache = nil // próxima leitura recalcula com a seleção nova
	usinasCacheMu.Unlock()
	limparCacheRegras(conj)
	c.JSON(http.StatusOK, gin.H{"ok": true, "ativas": n})
}

// ---------------------------------------------------------------- dados das faturas

type uItem struct {
	desc, comp, posto, unid  string
	qtd, tarifa, valor, tsem sql.NullFloat64
}
type uMed struct {
	grandeza, posto, medidor, unid string
	lant, latu, k, cons, fp        sql.NullFloat64
	arred                          bool
}
type uGD struct {
	tipo, posto string
	kwh         sql.NullFloat64
}
type uFat struct {
	id, chave, mes, grupo, subgrupo, fornecimento string
	cnpj, modalidade, lant, latu                  string
	pisCofins                                     float64 // soma das alíquotas de PIS e COFINS impressas (fração)
	cidade, classe                                string  // município e classe da UC (para a CIP — F51)
	cip                                           float64 // CIP/COSIP cobrada
	kwhRef                                        float64 // consumo total da fatura, quando a base tem (Acer: kwh_total)
	total                                         float64
	grupoInferido                                 bool // grupo/subgrupo deduzido da classe (a base não trazia)
	// extraida: base de extração automática (Energia/Acer) — itens, grupo e leituras às vezes lidos errado;
	// as regras de valor só acusam quando os itens fecham com o total (itensOK)
	extraida, itensOK bool
	totalSefaz        float64 // total da NF3e na SEFAZ (2ª fonte do total), quando a base tem
	itens             []uItem
	meds              []uMed
	gd                []uGD
}

// Achado de uma regra numa fatura
type Achado struct {
	Codigo  string  `json:"codigo"`
	Nivel   string  `json:"nivel"` // ERRO | ALERTA
	Detalhe string  `json:"detalhe"`
	Valor   float64 `json:"valor"` // R$ envolvidos (estimativa), quando faz sentido
	KWh     float64 `json:"kwh,omitempty"`
}

func carregarFaturasUsinas(db *sql.DB) (map[string]*uFat, error) {
	base := `FROM FATURA_USINA f WHERE f.duplicata_de IS NULL
	           AND COALESCE(f.tipo_documento,'fatura_energia') NOT LIKE 'demonstrativo%'
	           AND f.mes_referencia REGEXP '^[0-9]{4}-[0-9]{2}' AND COALESCE(f.uc,'') <> ''`
	fats := map[string]*uFat{}
	rows, err := db.Query(`SELECT f.id_fatura, ` + usinaChaveUC + `, LEFT(f.mes_referencia,7), COALESCE(f.grupo,''),
		COALESCE(f.subgrupo,''), COALESCE(f.total_a_pagar,0),
		COALESCE(JSON_UNQUOTE(JSON_EXTRACT(f.dados_json,'$.unidade_consumidora.tipo_fornecimento')),''),
		REGEXP_REPLACE(COALESCE(f.distribuidora_cnpj,''),'[^0-9]',''), COALESCE(f.modalidade_tarifaria,''),
		COALESCE(DATE_FORMAT(f.leitura_anterior,'%Y-%m-%d'),''), COALESCE(DATE_FORMAT(f.leitura_atual,'%Y-%m-%d'),''),
		COALESCE(JSON_EXTRACT(f.dados_json,'$.tributos'),'[]'),
		UPPER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(f.dados_json,'$.titular.cidade')),''))),
		UPPER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(f.dados_json,'$.unidade_consumidora.classe')),''))),
		COALESCE(f.cosip,0) ` + base)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		f := &uFat{}
		var trib string
		if rows.Scan(&f.id, &f.chave, &f.mes, &f.grupo, &f.subgrupo, &f.total, &f.fornecimento, &f.cnpj, &f.modalidade,
			&f.lant, &f.latu, &trib, &f.cidade, &f.classe, &f.cip) == nil {
			var ts []struct {
				Tributo  string   `json:"tributo"`
				Aliquota *float64 `json:"aliquota"`
			}
			_ = json.Unmarshal([]byte(trib), &ts)
			vistos := map[string]bool{}
			for _, t := range ts {
				n := strings.ToUpper(t.Tributo)
				if t.Aliquota == nil || vistos[n] || !(strings.HasPrefix(n, "PIS") || strings.HasPrefix(n, "COFINS")) {
					continue
				}
				vistos[n] = true
				f.pisCofins += *t.Aliquota / 100
			}
			fats[f.id] = f
		}
	}
	rows.Close()
	ir, err := db.Query(`SELECT i.id_fatura, COALESCE(i.descricao,''), COALESCE(i.componente,''), COALESCE(i.posto,''),
		COALESCE(i.unidade,''), i.quantidade_faturada, i.tarifa_com_tributos, i.valor, i.tarifa_sem_tributos
		FROM FATURA_USINA_ITENS i JOIN FATURA_USINA f ON f.id_fatura = i.id_fatura ` + strings.Replace(base, "FROM FATURA_USINA f ", "", 1) +
		` ORDER BY i.id_fatura, i.ordem`)
	if err != nil {
		return nil, err
	}
	for ir.Next() {
		var id string
		var x uItem
		if ir.Scan(&id, &x.desc, &x.comp, &x.posto, &x.unid, &x.qtd, &x.tarifa, &x.valor, &x.tsem) == nil && fats[id] != nil {
			fats[id].itens = append(fats[id].itens, x)
		}
	}
	ir.Close()
	mr, err := db.Query(`SELECT m.id_fatura, COALESCE(m.grandeza,''), COALESCE(m.posto,''), COALESCE(m.medidor,''),
		COALESCE(m.unidade,''), m.leitura_anterior, m.leitura_atual, m.constante, m.consumo, m.fator_potencia,
		COALESCE(m.leitura_arredondada,0)
		FROM FATURA_USINA_MEDICOES m JOIN FATURA_USINA f ON f.id_fatura = m.id_fatura ` + strings.Replace(base, "FROM FATURA_USINA f ", "", 1) +
		` ORDER BY m.id_fatura, m.ordem`)
	if err != nil {
		return nil, err
	}
	for mr.Next() {
		var id string
		var x uMed
		if mr.Scan(&id, &x.grandeza, &x.posto, &x.medidor, &x.unid, &x.lant, &x.latu, &x.k, &x.cons, &x.fp, &x.arred) == nil && fats[id] != nil {
			fats[id].meds = append(fats[id].meds, x)
		}
	}
	mr.Close()
	gr, err := db.Query(`SELECT g.id_fatura, COALESCE(g.tipo,''), COALESCE(g.posto,''), g.kwh
		FROM FATURA_USINA_GD g JOIN FATURA_USINA f ON f.id_fatura = g.id_fatura ` + strings.Replace(base, "FROM FATURA_USINA f ", "", 1) +
		` AND g.tipo <> 'rateio'`)
	if err != nil {
		return nil, err
	}
	for gr.Next() {
		var id string
		var x uGD
		if gr.Scan(&id, &x.tipo, &x.posto, &x.kwh) == nil && fats[id] != nil {
			fats[id].gd = append(fats[id].gd, x)
		}
	}
	gr.Close()
	return fats, nil
}

func nv(x sql.NullFloat64) float64 {
	if x.Valid {
		return x.Float64
	}
	return 0
}

func grupoB(f *uFat) bool {
	g := strings.ToUpper(f.grupo + f.subgrupo)
	return strings.HasPrefix(g, "B") && !strings.Contains(strings.ToUpper(f.subgrupo), "A")
}

// consumo ativo da fatura (maior quantidade de TUSD/TE/CONSUMO por posto, somada)
func consumoAtivo(f *uFat) float64 {
	por := map[string]float64{}
	for _, it := range f.itens {
		if (it.comp == "TUSD" || it.comp == "TE" || it.comp == "CONSUMO") && nv(it.qtd) > 0 {
			p := it.posto
			if p == "" || p == "UNICO" || p == "TODOS" {
				p = "FORA_PONTA"
			}
			if nv(it.qtd) > por[p] {
				por[p] = nv(it.qtd)
			}
		}
	}
	s := 0.0
	for _, v := range por {
		s += v
	}
	return s
}

func temCompensacao(f *uFat) bool {
	for _, it := range f.itens {
		if it.comp == "CONSUMO_COMPENSADO" || it.comp == "GD_INJETADA" {
			return true
		}
	}
	for _, g := range f.gd {
		if g.tipo == "compensada" && nv(g.kwh) != 0 {
			return true
		}
	}
	return false
}

func somaGD(f *uFat, tipo string) (float64, bool) {
	s, ok := 0.0, false
	for _, g := range f.gd {
		if g.tipo == tipo && g.kwh.Valid {
			s += math.Abs(g.kwh.Float64)
			ok = true
		}
	}
	return s, ok
}

var reRetroativo = regexp.MustCompile(`(?i)retro|parc|anterior|ref\.?\s*\d\d/|\d\d/\d{4}`)

// ---------------------------------------------------------------- regras "só com a fatura"

// conferirItensExtraidos — base extraída: os itens valem para as regras de valor só quando fecham com o total
// (±R$ 0,10), sem o mesmo valor repetido em 3+ linhas (valor de uma coluna copiado em todas) e sem linha maior
// que o próprio total (linha de "Total" lida como item)
func conferirItensExtraidos(f *uFat) {
	f.extraida = true
	if f.total <= 0 || len(f.itens) == 0 {
		return
	}
	soma := 0.0
	rep := map[float64]int{}
	for _, it := range f.itens {
		v := nv(it.valor)
		soma += v
		if v > 0 {
			rep[v]++
			if v > f.total*1.001 && len(f.itens) > 1 {
				return
			}
		}
	}
	for _, n := range rep {
		if n >= 3 {
			return
		}
	}
	f.itensOK = math.Abs(f.total-soma) <= 0.10
}

// potencia10 — a/b perto de 10, 100, 1000 (ou o inverso): separador de milhar/decimal lido errado
func potencia10(a, b float64) bool {
	if a <= 0 || b <= 0 {
		return false
	}
	r := math.Log10(a / b)
	k := math.Round(r)
	return k != 0 && math.Abs(r-k) < 0.01
}

func regrasFatura(f *uFat, sel map[string]bool) []Achado {
	var out []Achado
	soma := 0.0
	for _, it := range f.itens {
		soma += nv(it.valor)
	}
	// base extraída: itens que não fecham com o total não sustentam achado de valor
	valorOK := !f.extraida || f.itensOK
	// F35 (base extraída) — o total impresso acima do total da NF3e na SEFAZ: a soma dos itens extraídos não serve
	// (linha não lida ≠ cobrança a mais)
	if sel["F35"] && f.extraida {
		if d := f.total - f.totalSefaz; f.totalSefaz > 0 && d > 0.10 {
			if d > 0.5*f.total { // diferença do tamanho da fatura: a NF3e consultada pode ser outra nota
				out = append(out, Achado{"F35", "ALERTA", fmt.Sprintf("total a pagar R$ %.2f × total da nota fiscal na SEFAZ R$ %.2f — confira se a NF3e é desta fatura", f.total, f.totalSefaz), 0, 0})
			} else {
				out = append(out, Achado{"F35", "ERRO", fmt.Sprintf("total a pagar R$ %.2f acima do total da nota fiscal na SEFAZ R$ %.2f", f.total, f.totalSefaz),
					rnd2(d), 0})
			}
		}
	}
	// F35 — Total a Pagar − soma dos itens > R$ 0,10
	if sel["F35"] && len(f.itens) > 0 && !f.extraida {
		if d := f.total - soma; d > 0.10 {
			out = append(out, Achado{"F35", "ERRO", fmt.Sprintf("total a pagar R$ %.2f − soma dos itens R$ %.2f = R$ %.2f", f.total, soma, d), rnd2(d), 0})
		} else if d >= 0.01 {
			out = append(out, Achado{"F35", "ALERTA", fmt.Sprintf("diferença de arredondamento R$ %.2f entre total e soma dos itens", d), rnd2(d), 0})
		}
	}
	// F36 — valor do item − quantidade × tarifa (com tributos) > R$ 0,10 (+ arredondamento da tarifa impressa)
	if sel["F36"] && valorOK {
		tot, n, pior := 0.0, 0, ""
		totA, nA := 0.0, 0
		for _, it := range f.itens {
			q, t, v := nv(it.qtd), nv(it.tarifa), nv(it.valor)
			if !it.qtd.Valid || !it.tarifa.Valid || !it.valor.Valid || q <= 0 || t <= 0 || v <= 0 {
				continue
			}
			d := v - q*t
			if d <= 0.10 {
				continue
			}
			// base extraída: casa decimal errada, tarifa SEM tributos no lugar da com tributos (valor ≈ 1,2–1,5 ×
			// quantidade × tarifa) ou coluna trocada — diferença de mais de 5% do item não é cobrança a mais
			if f.extraida && (potencia10(v, q*t) || d > 0.05*v) {
				continue
			}
			if d > 0.001*v { // acima do arredondamento da tarifa impressa
				tot += d
				n++
				if pior == "" {
					pior = fmt.Sprintf("%s: R$ %.2f cobrado × %.3f × %.6f = R$ %.2f", it.desc, v, q, t, q*t)
				}
			} else {
				totA += d
				nA++
			}
		}
		if n > 0 && f.extraida { // descrição de duas linhas coladas, quantidade com a casa errada… — conferir na fatura
			out = append(out, Achado{"F36", "ALERTA", fmt.Sprintf("%d item(ns) acima de quantidade × tarifa (R$ %.2f) — confira na fatura. Ex.: %s", n, tot, pior), 0, 0})
		} else if n > 0 {
			out = append(out, Achado{"F36", "ERRO", fmt.Sprintf("%d item(ns) cobrado(s) acima de quantidade × tarifa (R$ %.2f). Ex.: %s", n, tot, pior), rnd2(tot), 0})
		} else if nA > 0 {
			out = append(out, Achado{"F36", "ALERTA", fmt.Sprintf("%d item(ns) com diferença de R$ %.2f (até 0,1%% do item — pode ser arredondamento da tarifa impressa)", nA, totA), 0, 0})
		}
	}
	// F13 — ativo zero com reativo excedente cobrado ou demanda medida > 0 (GD com compensação afasta)
	if sel["F13"] && valorOK && consumoAtivo(f) == 0 && !temCompensacao(f) && !(f.extraida && f.kwhRef > 0) {
		reat, dem := 0.0, 0.0
		for _, it := range f.itens {
			if it.comp == "REATIVO_EXCEDENTE" && nv(it.valor) > 0 {
				reat += nv(it.valor)
			}
		}
		for _, m := range f.meds {
			g := strings.ToUpper(m.grandeza)
			if (strings.HasPrefix(g, "DEMANDA") || strings.HasPrefix(g, "DN")) && !strings.Contains(g, "GERA") &&
				!strings.Contains(g, "INJ") && nv(m.cons) > dem {
				dem = nv(m.cons)
			}
		}
		temAtivo := false
		for _, it := range f.itens {
			if it.comp == "TUSD" || it.comp == "TE" || it.comp == "CONSUMO" {
				temAtivo = true
			}
		}
		if temAtivo && reat > 0 {
			out = append(out, Achado{"F13", "ERRO", fmt.Sprintf("consumo ativo zero com reativo excedente cobrado R$ %.2f (demanda medida %.2f kW)", reat, dem), rnd2(reat), 0})
		} else if temAtivo && dem > 0 {
			out = append(out, Achado{"F13", "ALERTA", fmt.Sprintf("consumo ativo zero com demanda medida %.2f kW — em usina o registro pode ser da geração", dem), 0, 0})
		}
	}
	// F14 — leitura atual menor que a anterior (mesmo medidor, sem virada)
	if sel["F14"] {
		for _, m := range f.meds {
			g := strings.ToUpper(m.grandeza)
			if strings.EqualFold(m.unid, "kW") || m.arred || !m.lant.Valid || !m.latu.Valid ||
				regexp.MustCompile(`DEMANDA|\bDEM\b|\bDN\b|DMCR|EXCE|EXC|UFER|UFDR|\bKW\b`).MatchString(g) {
				continue // demanda/excedente não são registradores acumulativos
			}
			la, lb := m.lant.Float64, m.latu.Float64
			if f.extraida && la < 100 {
				continue // registrador de 1–2 dígitos: quase sempre outra coluna lida como leitura
			}
			if lb < la {
				dig := math.Pow(10, math.Floor(math.Log10(math.Max(la, 1)))+1)
				if la >= 0.9*dig && lb < 0.1*dig {
					continue // virada do mostrador (F07)
				}
				nivel, obs := "ERRO", ""
				if lb == 0 || lb < 0.5*la || strings.Contains(g, "INJ") || strings.Contains(g, "GERA") || strings.Contains(g, "DATA") {
					nivel, obs = "ALERTA", " — queda grande, leitura zerada ou registrador de geração: pode ser troca de medidor (F08) ou leitura não extraída"
				} else if f.extraida {
					nivel, obs = "ALERTA", " — confira as leituras na fatura (a extração pode ter trocado anterior/atual ou o posto)"
				}
				out = append(out, Achado{"F14", nivel, fmt.Sprintf("%s %s: leitura atual %.0f < anterior %.0f (medidor %s)%s", m.grandeza, m.posto, lb, la, m.medidor, obs), 0, 0})
				break
			}
		}
	}
	// F15 — Grupo A, FP ≥ 0,92 no posto e UFER cobrada (só quando o FP está impresso/extraído)
	if sel["F15"] && valorOK && !grupoB(f) {
		ufer := 0.0
		for _, it := range f.itens {
			if it.comp == "REATIVO_EXCEDENTE" && nv(it.valor) > 0 {
				ufer += nv(it.valor)
			}
		}
		if ufer > 0 {
			for _, m := range f.meds {
				if m.fp.Valid && m.fp.Float64 >= 0.92 && m.fp.Float64 <= 1 {
					if f.extraida { // um FP só por fatura (média do mês/posto); a UFER é apurada hora a hora
						out = append(out, Achado{"F15", "ALERTA", fmt.Sprintf("fator de potência %.3f (≥ 0,92) e UFER cobrada R$ %.2f — confira o FP de cada posto na fatura", m.fp.Float64, ufer), 0, 0})
					} else {
						out = append(out, Achado{"F15", "ERRO", fmt.Sprintf("fator de potência %.3f (≥ 0,92) e UFER cobrada R$ %.2f", m.fp.Float64, ufer), rnd2(ufer), 0})
					}
					break
				}
			}
		}
	}
	// F17 — Grupo B com reativo excedente cobrado
	// base extraída: Grupo B com reativo/demanda quase sempre é o grupo lido errado (UC do Grupo A) — vira alerta
	if sel["F17"] && valorOK && grupoB(f) && !f.grupoInferido {
		v := 0.0
		for _, it := range f.itens {
			if it.comp == "REATIVO_EXCEDENTE" && nv(it.valor) > 0 {
				v += nv(it.valor)
			}
		}
		if v > 0 && f.extraida {
			out = append(out, Achado{"F17", "ALERTA", fmt.Sprintf("Grupo B (%s) com reativo excedente cobrado R$ %.2f — confira o grupo tarifário na fatura (a extração pode ter lido B numa UC do Grupo A)", f.subgrupo, v), 0, 0})
		} else if v > 0 {
			out = append(out, Achado{"F17", "ERRO", fmt.Sprintf("Grupo B (%s) com reativo excedente cobrado R$ %.2f", f.subgrupo, v), rnd2(v), 0})
		}
	}
	// F27 — Grupo B com item de demanda cobrado
	if sel["F27"] && valorOK && grupoB(f) && !f.grupoInferido {
		v, vg := 0.0, 0.0
		for _, it := range f.itens {
			if !strings.HasPrefix(it.comp, "DEMANDA") || nv(it.valor) <= 0 {
				continue
			}
			if strings.HasPrefix(it.comp, "DEMANDA_GERACAO") {
				vg += nv(it.valor)
			} else {
				v += nv(it.valor)
			}
		}
		if v > 0 && f.extraida {
			out = append(out, Achado{"F27", "ALERTA", fmt.Sprintf("Grupo B (%s) com demanda cobrada R$ %.2f — confira o grupo tarifário na fatura (a extração pode ter lido B numa UC do Grupo A)", f.subgrupo, v), 0, 0})
		} else if v > 0 {
			out = append(out, Achado{"F27", "ERRO", fmt.Sprintf("Grupo B (%s) com demanda de consumo cobrada R$ %.2f", f.subgrupo, v), rnd2(v), 0})
		} else if vg > 0 {
			out = append(out, Achado{"F27", "ALERTA", fmt.Sprintf("Grupo B (%s) com uso do sistema pela geração (TUSDg) R$ %.2f — conferir enquadramento", f.subgrupo, vg), 0, 0})
		}
	}
	// F52 — duas ou mais linhas de CIP com valores iguais/próximos no mês
	if sel["F52"] && valorOK {
		var cips []uItem
		for _, it := range f.itens {
			if it.comp == "ILUMINACAO_PUBLICA" && nv(it.valor) > 0 {
				cips = append(cips, it)
			}
		}
		if len(cips) >= 2 {
			a, b := nv(cips[0].valor), nv(cips[1].valor)
			igual := math.Abs(a-b) <= math.Max(0.10, 0.01*math.Max(a, b))
			retro := reRetroativo.MatchString(cips[1].desc) || reRetroativo.MatchString(cips[0].desc)
			if igual && !retro {
				out = append(out, Achado{"F52", "ERRO", fmt.Sprintf("CIP cobrada %d vezes no mês (R$ %.2f e R$ %.2f)", len(cips), a, b), rnd2(math.Min(a, b)), 0})
			} else {
				out = append(out, Achado{"F52", "ALERTA", fmt.Sprintf("%d linhas de CIP (R$ %.2f e R$ %.2f) — pode ser retroativa/parcelada", len(cips), a, b), 0, 0})
			}
		}
	}
	return out
}

func rnd2(v float64) float64 { return math.Round(v*100) / 100 }

// ---------------------------------------------------------------- regras com histórico da UC

func minimoFaturavel(f *uFat) float64 {
	if !grupoB(f) {
		return 0
	}
	t := strings.ToUpper(sem(f.fornecimento))
	switch {
	case strings.Contains(t, "TRI"):
		return 100
	case strings.Contains(t, "BI"):
		return 50
	case strings.Contains(t, "MONO"):
		return 30
	}
	return 100 // sem tipo de ligação: o maior mínimo (e ALERTA)
}

func sem(s string) string {
	r := strings.NewReplacer("Á", "A", "á", "a", "Í", "I", "í", "i", "Ó", "O", "ó", "o", "É", "E", "é", "e")
	return r.Replace(s)
}

func precoEnergia(f *uFat) float64 {
	cons := consumoAtivo(f)
	v := 0.0
	for _, it := range f.itens {
		if (it.comp == "TUSD" || it.comp == "TE" || it.comp == "CONSUMO") && nv(it.valor) > 0 {
			v += nv(it.valor)
		}
	}
	if cons > 0 {
		return v / cons
	}
	return 0
}

func regrasHistorico(fats map[string]*uFat, sel map[string]bool) map[string][]Achado {
	out := map[string][]Achado{}
	porUC := map[string][]*uFat{}
	for _, f := range fats {
		porUC[f.chave] = append(porUC[f.chave], f)
	}
	for _, lst := range porUC {
		sort.Slice(lst, func(i, j int) bool { return lst[i].mes < lst[j].mes })
		inj := make([]float64, len(lst))
		tem := make([]bool, len(lst))
		for i, f := range lst {
			inj[i], tem[i] = somaGD(f, "injetada")
		}
		for i, f := range lst {
			// F53 — injeção ≤ 50% da média (12 meses, mín. 3) e ≤ 50% do mesmo mês do ano anterior
			if sel["F53"] && tem[i] && !(f.extraida && inj[i] <= 0) { // base extraída: injeção 0 = não lida
				var hist []float64
				mesmo := -1.0
				for j := i - 1; j >= 0 && len(hist) < 12; j-- {
					if tem[j] && inj[j] > 0 && lst[j].mes != f.mes {
						hist = append(hist, inj[j])
					}
				}
				for j := i - 1; j >= 0; j-- {
					if tem[j] && lst[j].mes[5:] == f.mes[5:] && lst[j].mes[:4] < f.mes[:4] {
						mesmo = inj[j]
						break
					}
				}
				if len(hist) >= 3 {
					media := 0.0
					for _, h := range hist {
						media += h
					}
					media /= float64(len(hist))
					if inj[i] <= 0.5*media && (mesmo < 0 || inj[i] <= 0.5*mesmo) {
						det := fmt.Sprintf("injeção %.0f kWh ≤ 50%% da média de %d meses (%.0f kWh)", inj[i], len(hist), media)
						if mesmo >= 0 {
							det += fmt.Sprintf(" e do mesmo mês do ano anterior (%.0f kWh)", mesmo)
						} else {
							det += " — sem o mesmo mês do ano anterior para comparar"
						}
						out[f.id] = append(out[f.id], Achado{"F53", "ALERTA", det, 0, rnd2(media - inj[i])})
					}
				}
			}
			// F54 — saldo esperado (anterior + injetada − compensada) × saldo impresso, tolerância 1 kWh
			if sel["F54"] {
				atual, okA := somaGD(f, "saldo_atual")
				ant, okP := somaGD(f, "saldo_anterior")
				daFatura := okP // saldo anterior impresso na própria fatura (senão, vem do saldo da fatura anterior)
				if !okP && i > 0 && lst[i-1].mes < f.mes {
					ant, okP = somaGD(lst[i-1], "saldo_atual")
				}
				injM, okI := somaGD(f, "injetada")
				comp, okC := somaGD(f, "compensada")
				_, transf := somaGD(f, "transferida")
				_, exp := somaGD(f, "expirado")
				// base extraída sem o saldo anterior impresso: o da fatura anterior não fecha (posto, beneficiárias…)
				if okA && okP && okI && okC && !(f.extraida && !daFatura) {
					esperado := ant + injM - comp
					if d := math.Abs(esperado - atual); d > 1 {
						nivel := "ERRO"
						if transf || exp || injM > 0 || !daFatura { // injeção vai p/ beneficiárias sem aparecer; saldo anterior de outra fatura
							nivel = "ALERTA" // transferência/expiração sem discriminação suficiente
						}
						out[f.id] = append(out[f.id], Achado{"F54", nivel, fmt.Sprintf("saldo esperado %.0f (anterior %.0f + injetada %.0f − compensada %.0f) × impresso %.0f kWh", esperado, ant, injM, comp, atual), 0, rnd2(d)})
					}
				}
			}
			// F55 — havia saldo (sobrou crédito) e o consumo líquido ficou acima do mínimo faturável em mais de 1 kWh
			if sel["F55"] && temCompensacao(f) {
				saldo, okS := somaGD(f, "saldo_atual")
				cons := consumoAtivo(f)
				porPosto := map[string]float64{}
				for _, it := range f.itens {
					if (it.comp == "CONSUMO_COMPENSADO" || it.comp == "GD_INJETADA") && it.qtd.Valid {
						p := it.posto
						if p == "" || p == "UNICO" || p == "TODOS" {
							p = "FORA_PONTA"
						}
						porPosto[p] = math.Max(porPosto[p], math.Abs(it.qtd.Float64))
					}
				}
				comp := 0.0
				for _, v := range porPosto {
					comp += v
				}
				if c2, ok := somaGD(f, "compensada"); ok && c2 > comp {
					comp = c2
				}
				minimo := minimoFaturavel(f)
				liq := cons - comp
				if okS && saldo > 1 && cons > 0 && liq > minimo+1 {
					exc := liq - minimo
					if exc > saldo {
						exc = saldo
					}
					nivel := "ERRO"
					if exc <= 0.05*cons { // resíduo pequeno: compensação por posto com fator de ajuste (Grupo A)
						nivel = "ALERTA"
					}
					obs, val := "", rnd2(exc*precoEnergia(f))
					if f.extraida { // o saldo extraído pode ser de outro posto, a expirar ou reservado às beneficiárias
						nivel, obs, val = "ALERTA", " — confira na fatura se o saldo é desta UC e deste posto", 0
					}
					out[f.id] = append(out[f.id], Achado{"F55", nivel, fmt.Sprintf("consumo %.0f − compensado %.0f = %.0f kWh faturados acima do mínimo %.0f, com saldo de %.0f kWh sobrando%s", cons, comp, liq, minimo, saldo, obs), val, rnd2(exc)})
				}
			}
		}
	}
	return out
}

// aplicarRegrasComuns — regras só com a fatura e com o histórico da UC (as mesmas nas três bases: usinas, energia, acer)
func aplicarRegrasComuns(fats map[string]*uFat, sel map[string]bool, out map[string][]Achado) {
	for id, f := range fats {
		if a := regrasFatura(f, sel); len(a) > 0 {
			out[id] = append(out[id], a...)
		}
	}
	for id, a := range regrasHistorico(fats, sel) {
		out[id] = append(out[id], a...)
	}
}

// AplicarRegrasUsinas — achados das regras "fatura"/"historico" selecionadas, por id_fatura
func AplicarRegrasUsinas(db *sql.DB, sel map[string]bool) (map[string][]Achado, error) {
	precisa := false
	for c := range sel {
		if s := regrasSituacao[c]; s == "fatura" || s == "historico" || s == "aneel" || s == "pares" {
			precisa = true
		}
	}
	out := map[string][]Achado{}
	if !precisa {
		return out, nil
	}
	fats, err := carregarFaturasUsinas(db)
	if err != nil {
		return nil, err
	}
	aplicarRegrasComuns(fats, sel, out)
	if sel["F51"] {
		for id, a := range regraCIPPares(fats) {
			out[id] = append(out[id], a...)
		}
	}
	if sel["F28"] || sel["F41"] || sel["F42"] || sel["F58"] {
		base, err := baseAneel(db)
		if err != nil {
			return nil, err
		}
		if base != nil {
			for id, f := range fats {
				if a := regrasAneel(f, base, sel); len(a) > 0 {
					out[id] = append(out[id], a...)
				}
			}
		}
	}
	return out, nil
}

// base da ANEEL: a importada no banco (ou a montada da API pelo cmd de teste — SetAneelBase)
var aneelOverride *aneelBase

func SetAneelBase(b *aneelBase) { aneelOverride = b }

func baseAneel(db *sql.DB) (*aneelBase, error) {
	if aneelOverride != nil {
		return aneelOverride, nil
	}
	return carregarAneelBanco(db)
}

// dataCiclo — data de referência para a vigência (leitura atual; sem ela, dia 15 do mês de referência)
func dataCiclo(f *uFat) string {
	if f.latu != "" {
		return f.latu
	}
	return f.mes + "-15"
}

// mesesCiclo — meses civis cobertos pelo ciclo de leitura ("AAAA-MM")
func mesesCiclo(f *uFat) []string {
	ini, fim := f.lant, f.latu
	if ini == "" || fim == "" {
		return []string{f.mes}
	}
	var out []string
	a, _ := strconv.Atoi(ini[:4])
	m, _ := strconv.Atoi(ini[5:7])
	if ini[8:] >= "28" { // leitura no fim do mês: o consumo começa no mês seguinte
		m++
	}
	for k := 0; k < 14; k++ {
		if m > 12 {
			m, a = 1, a+1
		}
		mm := fmt.Sprintf("%04d-%02d", a, m)
		if mm > fim[:7] {
			break
		}
		out = append(out, mm)
		m++
	}
	if len(out) == 0 {
		out = []string{fim[:7]}
	}
	return out
}

// ---------------------------------------------------------------- regras com parâmetro da ANEEL

// tetoTarifa — maior tarifa "sem tributos" aceitável: a homologada ou ela com o PIS/COFINS da própria fatura
// (algumas distribuidoras, como a Light, imprimem a tarifa só sem ICMS), com 0,5% de folga de arredondamento.
func tetoTarifa(hom, pisCofins float64) float64 {
	t := hom
	if pisCofins > 0 && pisCofins < 0.2 {
		t = hom / (1 - pisCofins)
	}
	return t * 1.005
}

// pisCofinsMax — maior PIS+COFINS efetivo plausível (1,65% + 7,6%); acima de hom/(1−isto) não há tributo que explique
const pisCofinsMax = 0.0925

func regrasAneel(f *uFat, b *aneelBase, sel map[string]bool) []Achado {
	var out []Achado
	if len(f.cnpj) != 14 {
		return nil
	}
	data := dataCiclo(f)
	mod := normModalidade(f.modalidade)
	if mod == "" && grupoB(f) {
		mod = "Convencional"
	}
	// F28 — tarifa sem tributos (TE/TUSD) acima da homologada vigente
	if sel["F28"] && mod != "" && f.subgrupo != "" {
		cruza := f.lant != "" && b.rehMudou(f.cnpj, f.subgrupo, mod, f.lant, f.latu)
		// adicional de bandeira do ciclo (R$/kWh): há distribuidora que soma a bandeira na TE (ex.: Neoenergia PE)
		bandMax := 0.0
		for _, m := range mesesCiclo(f) {
			if bd, ok := b.bandeiras[m]; ok && bd.Valor/1000 > bandMax {
				bandMax = bd.Valor / 1000
			}
		}
		tot, n, ex := 0.0, 0, ""
		nA, exA := 0, ""
		// homologada da linha: TE, TUSD ou as duas (linha que não diz, ex.: Energisa "Consumo em kWh")
		type linhaF28 struct {
			ok, soTE, soTUSD bool
			hom              float64
			reh              string
		}
		homDe := func(it uItem) linhaF28 {
			if (it.comp != "TE" && it.comp != "TUSD") || !it.tsem.Valid || it.tsem.Float64 <= 0 || nv(it.qtd) <= 0 {
				return linhaF28{}
			}
			d := strings.ToUpper(it.desc)
			if strings.Contains(d, "INJ") || strings.Contains(d, "COMP") || strings.Contains(d, "SCEE") {
				return linhaF28{}
			}
			cands := b.tarifasVigentes(f.cnpj, f.subgrupo, mod, postoANEEL(it.posto), "MWh", "Não se aplica", data)
			if len(cands) == 0 && it.posto == "" {
				cands = b.tarifasVigentes(f.cnpj, f.subgrupo, mod, "", "MWh", "Não se aplica", data)
			}
			if len(cands) == 0 {
				return linhaF28{}
			}
			l := linhaF28{soTUSD: strings.Contains(d, "TUSD") || strings.Contains(d, "USD"),
				soTE: regexp.MustCompile(`(^|[^A-Z])TE([^A-Z]|$)`).MatchString(d), reh: cands[0].REH}
			for _, c := range cands { // várias classes/subclasses possíveis: compara com a MAIOR (não acusa à toa)
				v := c.TE + c.TUSD
				if l.soTUSD && !l.soTE {
					v = c.TUSD
				} else if l.soTE && !l.soTUSD {
					v = c.TE
				}
				if v > l.hom {
					l.hom = v
				}
			}
			l.hom /= 1000
			l.ok = l.hom > 0 // categoria sem esse componente (ex.: A4 convencional cobra TUSD por kW): nada a comparar
			return l
		}
		// TE e TUSD do mesmo posto: há distribuidora que divide as duas de outro jeito (TE acima, TUSD abaixo) —
		// só acusa a linha se a SOMA TE+TUSD também passar da homologada
		type somaPosto struct {
			te, tusd int
			t, hom   float64
		}
		somas := map[string]*somaPosto{}
		for _, it := range f.itens {
			if l := homDe(it); l.ok && l.soTE != l.soTUSD {
				s := somas[it.posto]
				if s == nil {
					s = &somaPosto{}
					somas[it.posto] = s
				}
				if l.soTE {
					s.te++
				} else {
					s.tusd++
				}
				s.t += it.tsem.Float64
				s.hom += l.hom
			}
		}
		for _, it := range f.itens {
			l := homDe(it)
			if !l.ok {
				continue
			}
			soTE, soTUSD, hom := l.soTE, l.soTUSD, l.hom
			if s := somas[it.posto]; soTE != soTUSD && s != nil && s.te == 1 && s.tusd == 1 &&
				s.t <= tetoTarifa(s.hom+bandMax, f.pisCofins) {
				continue
			}
			t := it.tsem.Float64
			if !soTUSD && bandMax > 0 && t > tetoTarifa(hom, f.pisCofins) && t <= (hom+bandMax)/(1-pisCofinsMax)*1.005 {
				hom += bandMax // TE com a bandeira do mês embutida
			}
			if t > tetoTarifa(hom, f.pisCofins)*1.25 && t-hom/(1-pisCofinsMax)*1.005 > 0.0001 {
				// 25% acima não é reajuste nem arredondamento: quase sempre subgrupo/modalidade lidos errado na extração
				nA++
				if exA == "" {
					exA = fmt.Sprintf("%s: R$ %.6f/kWh × R$ %.6f homologado (%s %s) — diferença grande demais; confira subgrupo/modalidade da fatura",
						it.desc, t, hom, f.subgrupo, mod)
				}
			} else if dif := t - hom/(1-pisCofinsMax)*1.005; dif > 0.0001 && dif*nv(it.qtd) > 0.10 {
				tot += (t - tetoTarifa(hom, f.pisCofins)) * nv(it.qtd)
				n++
				if ex == "" {
					ex = fmt.Sprintf("%s: R$ %.6f/kWh cobrado × R$ %.6f homologado (%s)", it.desc, t, hom, l.reh)
				}
			} else if dif := t - tetoTarifa(hom, f.pisCofins); dif > 0.0001 && dif*nv(it.qtd) > 0.10 {
				nA++
				if exA == "" {
					exA = fmt.Sprintf("%s: R$ %.6f/kWh × R$ %.6f homologado — diferença do tamanho do PIS/COFINS (tarifa pode estar só sem ICMS)", it.desc, t, hom)
				}
			}
		}
		if n == 0 && nA > 0 {
			out = append(out, Achado{"F28", "ALERTA", fmt.Sprintf("%d item(ns). Ex.: %s", nA, exA), 0, 0})
		}
		if n > 0 {
			nivel := "ERRO"
			if cruza {
				nivel = "ALERTA"
				ex += " — o ciclo atravessa um reajuste (pode ser proporcionalização, regras 31/32)"
			}
			out = append(out, Achado{"F28", nivel, fmt.Sprintf("%d item(ns) com tarifa acima da homologada (R$ %.2f). Ex.: %s", n, tot, ex), rnd2(tot), 0})
		}
	}
	// F58 — demanda de geração cobrada pela TUSD C (≈ demanda de consumo) e acima da TUSD G homologada
	if sel["F58"] && !grupoB(f) {
		tusdC := 0.0
		for _, it := range f.itens {
			if it.comp == "DEMANDA" && it.tsem.Valid && it.tsem.Float64 > tusdC {
				tusdC = it.tsem.Float64
			}
		}
		for _, it := range f.itens {
			if !strings.HasPrefix(it.comp, "DEMANDA_GERACAO") || it.comp == "DEMANDA_GERACAO_ULTRAPASSAGEM" ||
				!it.tsem.Valid || it.tsem.Float64 <= 0 || nv(it.qtd) <= 0 {
				continue
			}
			cands := b.tarifasVigentes(f.cnpj, f.subgrupo, "Geração", "Não se aplica", "kW", "Não se aplica", data)
			if len(cands) == 0 {
				continue
			}
			hom := 0.0
			for _, c := range cands {
				if c.TUSD > hom {
					hom = c.TUSD
				}
			}
			tg := it.tsem.Float64
			if tg-tetoTarifa(hom, f.pisCofins) <= 0.0001 || (tg-hom)*nv(it.qtd) <= 0.10 {
				continue
			}
			if tusdC > 0 && math.Abs(tg-tusdC)/tusdC <= 0.02 {
				out = append(out, Achado{"F58", "ERRO", fmt.Sprintf("%s: %.0f kW a R$ %.4f/kW ≈ TUSD de consumo R$ %.4f; TUSD G homologada R$ %.4f/kW (%s)",
					it.desc, nv(it.qtd), tg, tusdC, hom, cands[0].REH), rnd2((tg - hom) * nv(it.qtd)), 0})
			} else {
				out = append(out, Achado{"F58", "ALERTA", fmt.Sprintf("%s: R$ %.4f/kW acima da TUSD G homologada R$ %.4f/kW (%s)",
					it.desc, tg, hom, cands[0].REH), 0, 0})
			}
			break
		}
	}
	// F41 / F42 — bandeira cobrada × bandeira oficial do(s) mês(es) do ciclo
	if sel["F41"] || sel["F42"] {
		meses := mesesCiclo(f)
		oficiais := map[string]bool{}
		conhecidos := 0
		for _, m := range meses {
			if bd, ok := b.bandeiras[m]; ok {
				oficiais[bd.Cor] = true
				if strings.HasPrefix(bd.Cor, "VERMELHA") || bd.Cor == "ESCASSEZ" {
					oficiais["VERMELHA"] = true // na Escassez Hídrica há distribuidora que imprime "bandeira vermelha"
				}
				conhecidos++
			}
		}
		// F41: a cor de qualquer dia do ciclo vale — inclui o mês da leitura anterior, que mesesCiclo pula
		// quando a leitura é no fim do mês (ex.: 28/11–12/12 cobra a vermelha de novembro proporcional)
		if len(f.lant) >= 7 {
			if bd, ok := b.bandeiras[f.lant[:7]]; ok {
				oficiais[bd.Cor] = true
				if strings.HasPrefix(bd.Cor, "VERMELHA") {
					oficiais["VERMELHA"] = true
				}
			}
		}
		// 3+ linhas de bandeira com cor = fatura que cobra vários meses (refaturamento / acerto de ciclos anteriores):
		// o ciclo da fatura não diz de que mês é cada linha — fica em alerta
		nBand := 0
		for _, it := range f.itens {
			if it.comp == "BANDEIRA" && nv(it.valor) > 0 && corBandeira(it.desc) != "" && corBandeira(it.desc) != "VERDE" {
				nBand++
			}
		}
		nivelF41 := "ERRO"
		if nBand >= 3 {
			nivelF41 = "ALERTA"
		}
		if conhecidos == len(meses) && conhecidos > 0 {
			for _, it := range f.itens {
				if it.comp != "BANDEIRA" || nv(it.valor) <= 0 {
					continue
				}
				cor := corBandeira(it.desc)
				if cor == "" || cor == "VERDE" {
					continue
				}
				if sel["F41"] && !oficiais[cor] {
					cs := make([]string, 0, len(oficiais))
					for c := range oficiais {
						cs = append(cs, c)
					}
					sort.Strings(cs)
					v := rnd2(nv(it.valor))
					if nivelF41 == "ALERTA" {
						v = 0
					}
					out = append(out, Achado{"F41", nivelF41, fmt.Sprintf("%s cobrada (R$ %.2f), mas a bandeira oficial do ciclo %s foi %s",
						strings.Title(strings.ToLower(strings.ReplaceAll(cor, "_", " "))), nv(it.valor), strings.Join(meses, ", "), strings.Join(cs, "/")),
						v, 0})
					continue
				}
				if sel["F42"] && it.tsem.Valid && it.tsem.Float64 > 0 && nv(it.qtd) > 0 {
					anos := map[string]bool{}
					corM := ""
					for _, m := range meses {
						anos[m[:4]] = true
						if bd := b.bandeiras[m]; bd.Cor != "VERDE" {
							if corM != "" && corM != bd.Cor {
								corM = "MISTO"
							} else if corM == "" {
								corM = bd.Cor
							}
						}
					}
					c := cor
					if c == "VERMELHA" && strings.HasPrefix(corM, "VERMELHA_") {
						c = corM // patamar não impresso: o oficial do ciclo
					}
					hom, ok := b.porCor[meses[0][:4]+"|"+c]
					if !ok {
						continue
					}
					hom /= 1000
					teto := tetoTarifa(hom, f.pisCofins)
					if dif := (it.tsem.Float64 - teto) * nv(it.qtd); dif > 0.01 && it.tsem.Float64-teto > 0.000001 {
						if len(anos) != 1 || corM == "MISTO" {
							out = append(out, Achado{"F42", "ALERTA", fmt.Sprintf("%s: R$ %.5f/kWh × R$ %.5f homologado — a linha mistura meses/patamares do ciclo (regra 43)",
								it.desc, it.tsem.Float64, hom), 0, 0})
						} else {
							out = append(out, Achado{"F42", "ERRO", fmt.Sprintf("%s: R$ %.5f/kWh cobrado × R$ %.5f homologado (%s %s)",
								it.desc, it.tsem.Float64, hom, strings.ToLower(c), meses[0][:4]), rnd2((it.tsem.Float64 - hom) * nv(it.qtd)), 0})
						}
					}
				}
			}
		}
	}
	return out
}

// ---------------------------------------------------------------- F51 — CIP/COSIP comparada entre UCs

// consumoCIP — consumo da UC no mês para a faixa da CIP: o medido (energia ativa) ou, sem medição, o das linhas
// de consumo da fatura. Em GD a CIP segue o consumo bruto, não o que sobrou depois da compensação.
func consumoCIP(f *uFat) float64 {
	med := 0.0
	for _, m := range f.meds {
		g := strings.ToUpper(sem(m.grandeza))
		if strings.Contains(g, "ATIV") && !strings.Contains(g, "INJ") && !strings.Contains(g, "GER") &&
			strings.HasPrefix(strings.ToUpper(m.unid), "KWH") && nv(m.cons) > 0 {
			med += nv(m.cons)
		}
	}
	if f.kwhRef > med { // consumo total gravado na base (na GD a linha de consumo é só o resíduo)
		med = f.kwhRef
	}
	if c := consumoAtivo(f); c > med {
		return c
	}
	return med
}

// regraCIPPares — a CIP é lei municipal (valor por faixa de consumo ou % de uma tarifa) e não há base nacional.
// Por isso compara a fatura com as outras UCs do MESMO município, distribuidora, classe, grupo e mês:
//   - "degrau" = valor de CIP pago por 2+ UCs diferentes (é a tabela do município vista nas faturas);
//   - ALERTA se 2+ UCs com consumo maior (≥ 5%) pagam um degrau menor — faixa de consumo trocada;
//     o valor estimado é a diferença para o maior degrau pago por essas UCs.
//
// Fica em ALERTA: sem a lei não dá para afirmar a faixa (pode haver subclasse, isenção, rural).
func regraCIPPares(fats map[string]*uFat) map[string][]Achado {
	type ponto struct {
		f   *uFat
		kwh float64
	}
	grupos := map[string][]ponto{}
	for _, f := range fats {
		if f.cip <= 0 || f.cidade == "" || f.cidade == "NULL" {
			continue
		}
		g := "B"
		if !grupoB(f) {
			g = "A"
		}
		k := f.cnpj + "|" + sem(f.cidade) + "|" + sem(f.classe) + "|" + g + "|" + f.mes
		grupos[k] = append(grupos[k], ponto{f, consumoCIP(f)})
	}
	igual := func(a, b float64) bool { return math.Abs(a-b) <= math.Max(0.05, 0.005*b) }
	out := map[string][]Achado{}
	for _, ps := range grupos {
		if len(ps) < 4 {
			continue
		}
		// degraus: valores pagos por 2+ UCs diferentes
		var degraus []float64
		for _, p := range ps {
			ucs := map[string]bool{}
			for _, q := range ps {
				if igual(q.f.cip, p.f.cip) {
					ucs[q.f.chave] = true
				}
			}
			if len(ucs) >= 2 {
				novo := true
				for _, d := range degraus {
					if igual(d, p.f.cip) {
						novo = false
					}
				}
				if novo {
					degraus = append(degraus, p.f.cip)
				}
			}
		}
		if len(degraus) < 2 {
			continue
		}
		maxDeg := 0.0
		for _, d := range degraus {
			maxDeg = math.Max(maxDeg, d)
		}
		ucsGrupo := map[string]bool{}
		marcadas := map[string]bool{}
		var cand []Achado
		var candID []string
		for _, p := range ps {
			ucsGrupo[p.f.chave] = true
			// valor pago por uma UC só NÃO é apontado: com poucas UCs por município, faixa legítima aparece uma vez
			// (teste nas usinas: 130 alertas assim, quase todos degraus reais da tabela da Light)
			if p.kwh <= 0 {
				continue
			}
			// CIP muito acima da maior faixa do município, ou mais que metade da conta: erro de extração, não de faixa
			if p.f.cip > 3*maxDeg || (p.f.total > 0 && p.f.cip > 0.5*p.f.total) {
				continue
			}
			n, maior := 0, 0.0
			for _, q := range ps {
				if q.f.chave != p.f.chave && q.kwh >= p.kwh*1.05+5 && q.f.cip < p.f.cip && !igual(q.f.cip, p.f.cip) {
					n++
					if q.f.cip > maior {
						maior = q.f.cip
					}
				}
			}
			if n >= 2 {
				marcadas[p.f.chave] = true
				candID = append(candID, p.f.id)
				cand = append(cand, Achado{"F51", "ALERTA", fmt.Sprintf(
					"CIP R$ %.2f com %.0f kWh — %d UC(s) de %s com consumo maior pagam menos (até R$ %.2f) em %s; degraus vistos: %s",
					p.f.cip, p.kwh, n, p.f.cidade, maior, p.f.mes, fmtDegraus(degraus)), rnd2(p.f.cip - maior), 0})
			}
		}
		// muitas UCs "fora da ordem" = o município não cobra por faixa do consumo bruto (ex.: % sobre o consumo
		// faturado depois da compensação GD, valor por classe/subclasse) — a comparação não vale ali
		if float64(len(marcadas)) > 0.15*float64(len(ucsGrupo)) {
			continue
		}
		for i, id := range candID {
			out[id] = append(out[id], cand[i])
		}
	}
	return out
}

func fmtDegraus(d []float64) string {
	c := append([]float64(nil), d...)
	sort.Float64s(c)
	var s []string
	for i, v := range c {
		if i == 8 {
			s = append(s, "…")
			break
		}
		s = append(s, fmt.Sprintf("%.2f", v))
	}
	return strings.Join(s, " · ")
}
