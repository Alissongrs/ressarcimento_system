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
	"F46": "parametro", "F51": "parametro", "F56": "parametro",
}

// o que falta para as regras que dependem de parâmetro (mostrado na lista)
var regrasPrecisa = map[string]string{
	"F28": "tarifa homologada TE/TUSD — importada da ANEEL", "F58": "TUSD G homologada — importada da ANEEL",
	"F41": "bandeira acionada no mês — importada da ANEEL", "F42": "adicional da bandeira — importado da ANEEL",
	"F31": "datas de vigência dos reajustes (ANEEL)", "F32": "tarifas antiga e nova + data do reajuste (ANEEL)",
	"F39": "alíquotas de ICMS por UF/classe e PIS/COFINS", "F40": "isenções/benefícios de ICMS por UF",
	"F43": "dias de cada bandeira no ciclo (rateio por dias)", "F44": "valor da bandeira + alíquotas",
	"F45": "valor homologado da CDE Covid", "F46": "vigência da CDE Escassez Hídrica",
	"F51": "valor da CIP/COSIP por município, classe e faixa de consumo",
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
		s := regrasSituacao[f.Codigo]
		if s == "" {
			s = "pendente"
		}
		pr := regrasPrecisa[f.Codigo]
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
		s := regrasSituacao[cod]
		if s != "motor" && s != "fatura" && s != "historico" && s != "aneel" {
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
	total                                         float64
	itens                                         []uItem
	meds                                          []uMed
	gd                                            []uGD
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
		COALESCE(JSON_EXTRACT(f.dados_json,'$.tributos'),'[]') ` + base)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		f := &uFat{}
		var trib string
		if rows.Scan(&f.id, &f.chave, &f.mes, &f.grupo, &f.subgrupo, &f.total, &f.fornecimento, &f.cnpj, &f.modalidade,
			&f.lant, &f.latu, &trib) == nil {
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

func regrasFatura(f *uFat, sel map[string]bool) []Achado {
	var out []Achado
	soma := 0.0
	for _, it := range f.itens {
		soma += nv(it.valor)
	}
	// F35 — Total a Pagar − soma dos itens > R$ 0,10
	if sel["F35"] && len(f.itens) > 0 {
		if d := f.total - soma; d > 0.10 {
			out = append(out, Achado{"F35", "ERRO", fmt.Sprintf("total a pagar R$ %.2f − soma dos itens R$ %.2f = R$ %.2f", f.total, soma, d), rnd2(d), 0})
		} else if d >= 0.01 {
			out = append(out, Achado{"F35", "ALERTA", fmt.Sprintf("diferença de arredondamento R$ %.2f entre total e soma dos itens", d), rnd2(d), 0})
		}
	}
	// F36 — valor do item − quantidade × tarifa (com tributos) > R$ 0,10 (+ arredondamento da tarifa impressa)
	if sel["F36"] {
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
		if n > 0 {
			out = append(out, Achado{"F36", "ERRO", fmt.Sprintf("%d item(ns) cobrado(s) acima de quantidade × tarifa (R$ %.2f). Ex.: %s", n, tot, pior), rnd2(tot), 0})
		} else if nA > 0 {
			out = append(out, Achado{"F36", "ALERTA", fmt.Sprintf("%d item(ns) com diferença de R$ %.2f (até 0,1%% do item — pode ser arredondamento da tarifa impressa)", nA, totA), 0, 0})
		}
	}
	// F13 — ativo zero com reativo excedente cobrado ou demanda medida > 0 (GD com compensação afasta)
	if sel["F13"] && consumoAtivo(f) == 0 && !temCompensacao(f) {
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
			if lb < la {
				dig := math.Pow(10, math.Floor(math.Log10(math.Max(la, 1)))+1)
				if la >= 0.9*dig && lb < 0.1*dig {
					continue // virada do mostrador (F07)
				}
				nivel, obs := "ERRO", ""
				if lb == 0 || lb < 0.5*la || strings.Contains(g, "INJ") || strings.Contains(g, "GERA") || strings.Contains(g, "DATA") {
					nivel, obs = "ALERTA", " — queda grande, leitura zerada ou registrador de geração: pode ser troca de medidor (F08) ou leitura não extraída"
				}
				out = append(out, Achado{"F14", nivel, fmt.Sprintf("%s %s: leitura atual %.0f < anterior %.0f (medidor %s)%s", m.grandeza, m.posto, lb, la, m.medidor, obs), 0, 0})
				break
			}
		}
	}
	// F15 — Grupo A, FP ≥ 0,92 no posto e UFER cobrada (só quando o FP está impresso/extraído)
	if sel["F15"] && !grupoB(f) {
		ufer := 0.0
		for _, it := range f.itens {
			if it.comp == "REATIVO_EXCEDENTE" && nv(it.valor) > 0 {
				ufer += nv(it.valor)
			}
		}
		if ufer > 0 {
			for _, m := range f.meds {
				if m.fp.Valid && m.fp.Float64 >= 0.92 && m.fp.Float64 <= 1 {
					out = append(out, Achado{"F15", "ERRO", fmt.Sprintf("fator de potência %.3f (≥ 0,92) e UFER cobrada R$ %.2f", m.fp.Float64, ufer), rnd2(ufer), 0})
					break
				}
			}
		}
	}
	// F17 — Grupo B com reativo excedente cobrado
	if sel["F17"] && grupoB(f) {
		v := 0.0
		for _, it := range f.itens {
			if it.comp == "REATIVO_EXCEDENTE" && nv(it.valor) > 0 {
				v += nv(it.valor)
			}
		}
		if v > 0 {
			out = append(out, Achado{"F17", "ERRO", fmt.Sprintf("Grupo B (%s) com reativo excedente cobrado R$ %.2f", f.subgrupo, v), rnd2(v), 0})
		}
	}
	// F27 — Grupo B com item de demanda cobrado
	if sel["F27"] && grupoB(f) {
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
		if v > 0 {
			out = append(out, Achado{"F27", "ERRO", fmt.Sprintf("Grupo B (%s) com demanda de consumo cobrada R$ %.2f", f.subgrupo, v), rnd2(v), 0})
		} else if vg > 0 {
			out = append(out, Achado{"F27", "ALERTA", fmt.Sprintf("Grupo B (%s) com uso do sistema pela geração (TUSDg) R$ %.2f — conferir enquadramento", f.subgrupo, vg), 0, 0})
		}
	}
	// F52 — duas ou mais linhas de CIP com valores iguais/próximos no mês
	if sel["F52"] {
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
			if sel["F53"] && tem[i] {
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
				if okA && okP && okI && okC {
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
					out[f.id] = append(out[f.id], Achado{"F55", nivel, fmt.Sprintf("consumo %.0f − compensado %.0f = %.0f kWh faturados acima do mínimo %.0f, com saldo de %.0f kWh sobrando", cons, comp, liq, minimo, saldo), rnd2(exc * precoEnergia(f)), rnd2(exc)})
				}
			}
		}
	}
	return out
}

// AplicarRegrasUsinas — achados das regras "fatura"/"historico" selecionadas, por id_fatura
func AplicarRegrasUsinas(db *sql.DB, sel map[string]bool) (map[string][]Achado, error) {
	precisa := false
	for c := range sel {
		if s := regrasSituacao[c]; s == "fatura" || s == "historico" || s == "aneel" {
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
	for id, f := range fats {
		if a := regrasFatura(f, sel); len(a) > 0 {
			out[id] = append(out[id], a...)
		}
	}
	for id, a := range regrasHistorico(fats, sel) {
		out[id] = append(out[id], a...)
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
		tot, n, ex, semTabela := 0.0, 0, "", true
		nA, exA := 0, ""
		for _, it := range f.itens {
			if (it.comp != "TE" && it.comp != "TUSD") || !it.tsem.Valid || it.tsem.Float64 <= 0 || nv(it.qtd) <= 0 {
				continue
			}
			d := strings.ToUpper(it.desc)
			if strings.Contains(d, "INJ") || strings.Contains(d, "COMP") || strings.Contains(d, "SCEE") {
				continue
			}
			cands := b.tarifasVigentes(f.cnpj, f.subgrupo, mod, postoANEEL(it.posto), "MWh", "Não se aplica", data)
			if len(cands) == 0 && it.posto == "" {
				cands = b.tarifasVigentes(f.cnpj, f.subgrupo, mod, "", "MWh", "Não se aplica", data)
			}
			if len(cands) == 0 {
				continue
			}
			semTabela = false
			// linha que não diz TE nem TUSD (ex.: Energisa "Consumo em kWh") cobra as duas juntas
			soTUSD := strings.Contains(d, "TUSD") || strings.Contains(d, "USD")
			soTE := regexp.MustCompile(`(^|[^A-Z])TE([^A-Z]|$)`).MatchString(d)
			hom := 0.0 // várias classes/subclasses possíveis: compara com a MAIOR (não acusa à toa)
			for _, c := range cands {
				v := c.TE + c.TUSD
				if soTUSD && !soTE {
					v = c.TUSD
				} else if soTE && !soTUSD {
					v = c.TE
				}
				if v > hom {
					hom = v
				}
			}
			hom /= 1000
			t := it.tsem.Float64
			if !soTUSD && bandMax > 0 && t > tetoTarifa(hom, f.pisCofins) && t <= (hom+bandMax)/(1-pisCofinsMax)*1.005 {
				hom += bandMax // TE com a bandeira do mês embutida
			}
			if dif := t - hom/(1-pisCofinsMax)*1.005; dif > 0.0001 && dif*nv(it.qtd) > 0.10 {
				tot += (t - tetoTarifa(hom, f.pisCofins)) * nv(it.qtd)
				n++
				if ex == "" {
					ex = fmt.Sprintf("%s: R$ %.6f/kWh cobrado × R$ %.6f homologado (%s)", it.desc, t, hom, cands[0].REH)
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
		_ = semTabela
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
				if strings.HasPrefix(bd.Cor, "VERMELHA") {
					oficiais["VERMELHA"] = true
				}
				conhecidos++
			}
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
					out = append(out, Achado{"F41", "ERRO", fmt.Sprintf("%s cobrada (R$ %.2f), mas a bandeira oficial do ciclo %s foi %s",
						strings.Title(strings.ToLower(strings.ReplaceAll(cor, "_", " "))), nv(it.valor), strings.Join(meses, ", "), strings.Join(cs, "/")),
						rnd2(nv(it.valor)), 0})
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
