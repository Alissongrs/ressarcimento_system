package handlers

// Regras do catálogo na base da ACER (empresa 2028, FATURA_ACER_DADOS_EXTRAIDOS) — botão "⚙ Regras" da aba 🅰️ Acer.
// Mesmo motor das usinas (usinas_regras.go): as faturas da Acer são lidas do JSON de extração
// (extracao_raw_json → "bert", ou "normalization" nos layouts antigos) e montadas no formato uFat; daí rodam as
// regras da ANEEL (F28 F41 F42 F58, tarifa/bandeira homologada) e a CIP por comparação entre UCs (F51).
// F01–F05 continuam no motor da Auditoria (lista principal da aba).
//
//   - distribuidora: CNPJ do emitente tirado da chave de acesso da NF3e (posições 7–20), não do nome;
//   - itens: "classification" do extrator (CONSUMO_TE_KWH, CONSUMO_TUSD_KWH, ADIC_BANDEIRA_VERMELHA_P1...);
//     linha cujo valor não bate com quantidade × tarifa (campo trocado na extração) fica sem tarifa — não acusa.

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// regras que já rodam na base da Acer (as demais aparecem na lista como "ainda não ligada à Acer") — as mesmas
// da aba Usinas. Sem saldo de créditos na extração da Acer, F54/F55 não têm o que comparar e não apontam.
var regrasAcer = map[string]bool{"F28": true, "F41": true, "F42": true, "F58": true, "F51": true,
	"F13": true, "F14": true, "F15": true, "F17": true, "F27": true, "F35": true, "F36": true, "F52": true,
	"F53": true, "F54": true, "F55": true,
	"F06": true, "F07": true, "F08": true, "F33": true, "F34": true, "F57": true}

// situacaoConjunto — situação da regra num conjunto (o motor F01–F05 vale para todos)
func situacaoConjunto(conj, cod string) string {
	s := regrasSituacao[cod]
	if s == "" {
		return "pendente"
	}
	if s != "motor" && ((conj == "acer" && !regrasAcer[cod]) || (conj == "energia" && !regrasEnergia[cod])) {
		return "nao_ligada"
	}
	return s
}

// numJSON — número do JSON do extrator: "0,275750", "1.234,56", "18838.0" ou número
func numJSON(v any) sql.NullFloat64 {
	switch x := v.(type) {
	case float64:
		return sql.NullFloat64{Float64: x, Valid: true}
	case string:
		t := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(x), "%"))
		if t == "" {
			return sql.NullFloat64{}
		}
		if !strings.Contains(t, ",") {
			t = strings.ReplaceAll(t, ".", "§") // "18838.0" → ponto decimal
			if strings.Count(t, "§") == 1 {
				t = strings.ReplaceAll(t, "§", ",")
			} else {
				t = strings.ReplaceAll(t, "§", "")
			}
		}
		if !regexp.MustCompile(`^-?[\d.]*,?\d*$`).MatchString(t) {
			return sql.NullFloat64{}
		}
		return sql.NullFloat64{Float64: numBR(t), Valid: true}
	}
	return sql.NullFloat64{}
}

var reNaoDigito = regexp.MustCompile(`\D`)

// itemAcer — componente/posto da linha a partir da classificação do extrator
func itemAcer(cl, desc string) (comp, posto, descOut string) {
	c := strings.ToUpper(cl)
	switch {
	case strings.Contains(c, "_FORA_PONTA"):
		posto = "FORA_PONTA"
	case strings.Contains(c, "_PONTA"):
		posto = "PONTA"
	case strings.Contains(c, "_INTERMEDIARIO"):
		posto = "INTERMEDIARIO"
	}
	descOut = desc
	switch {
	case strings.Contains(c, "INJETADA") || strings.Contains(c, "COMPENSADO"):
		comp = "CONSUMO_COMPENSADO"
	case strings.Contains(c, "TARIFA_SOCIAL"):
		comp = "SOCIAL"
	case strings.HasPrefix(c, "CONSUMO_TE_KWH"):
		comp, descOut = "TE", "[TE] "+desc
	case strings.HasPrefix(c, "CONSUMO_TUSD_KWH"):
		comp, descOut = "TUSD", "[TUSD] "+desc
	case strings.HasPrefix(c, "CONSUMO_KWH"):
		comp = "CONSUMO" // TE+TUSD numa linha só
	case strings.HasPrefix(c, "ADIC_BANDEIRA"):
		comp, descOut = "BANDEIRA", desc+" · "+strings.ReplaceAll(c, "_", " ")
	case strings.HasPrefix(c, "DEMANDA_TUSD_KW") && !strings.Contains(c, "ULTRAPASSAGEM"):
		comp = "DEMANDA"
	case strings.Contains(c, "ILUMINACAO_PUBLICA") && !strings.Contains(c, "MULTA"):
		comp = "ILUMINACAO_PUBLICA"
	case strings.Contains(c, "REATIV") || strings.Contains(c, "UFER") || strings.Contains(c, "UFDR") || strings.Contains(c, "DMCR"):
		comp = "REATIVO_EXCEDENTE"
	default:
		comp = "OUTRO"
	}
	return
}

// subgrupoAcer — subgrupo da coluna; sem ele, pela classe (Grupo B): residencial B1, rural B2, demais B3
func subgrupoAcer(sg, grupo, classe string) string {
	if sg != "" {
		return sg
	}
	if grupo != "" && grupo != "B" {
		return ""
	}
	c := strings.ToUpper(sem(classe))
	switch {
	case strings.Contains(c, "RESID"):
		return "B1"
	case strings.Contains(c, "RURAL"):
		return "B2"
	case c != "":
		return "B3"
	}
	return ""
}

func carregarFaturasAcer(db *sql.DB) (map[string]*uFat, error) {
	return carregarFaturasAcerOnde(db, "")
}

// carregarFaturasAcerOnde — idem, só com as faturas que passam no filtro extra (ex.: uma UC, para o dossiê)
func carregarFaturasAcerOnde(db *sql.DB, onde string, args ...any) (map[string]*uFat, error) {
	if onde != "" {
		onde = " AND (" + onde + ")"
	}
	rows, err := db.Query(`SELECT id, COALESCE(NULLIF(TRIM(numero_instalacao),''), codigo_uc, ''), LEFT(mes_referencia,7),
		COALESCE(grupo_tarifario,''), COALESCE(subgrupo_tarifario,''), COALESCE(modalidade_tarifaria,''),
		COALESCE(DATE_FORMAT(data_leitura_anterior,'%Y-%m-%d'),''), COALESCE(DATE_FORMAT(data_leitura_atual,'%Y-%m-%d'),''),
		COALESCE(valor_cip_cosip,0), COALESCE(valor_total_fatura,0), COALESCE(kwh_total,0), COALESCE(extracao_raw_json,'{}'),
		energia_injetada_kwh, energia_compensada_kwh, COALESCE(dias_faturados,0), COALESCE(numero_medidor,''),
		COALESCE(indicacao_troca_medidor,0) = 1,
		(COALESCE(indicador_leitura_estimativa,0) = 1 OR COALESCE(flag_faturamento_media,0) = 1 OR COALESCE(indicacao_impedimento_leitura,0) = 1)
		FROM `+acerTabela+` WHERE mes_referencia REGEXP '^[0-9]{4}-[0-9]{2}'`+onde, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	fats := map[string]*uFat{}
	for rows.Next() {
		var id int64
		var raw string
		var inj, comp sql.NullFloat64
		f := &uFat{}
		if rows.Scan(&id, &f.chave, &f.mes, &f.grupo, &f.subgrupo, &f.modalidade, &f.lant, &f.latu, &f.cip, &f.total, &f.kwhRef, &raw,
			&inj, &comp, &f.diasImpr, &f.medidor, &f.trocaMed, &f.justLeitura) != nil {
			continue
		}
		f.dias, f.dLant, f.dLatu = diasEntre(f.lant, f.latu), f.lant, f.latu // antes de deduzir a leitura anterior abaixo
		f.id = fmt.Sprint(id)
		var j map[string]any
		_ = json.Unmarshal([]byte(raw), &j)
		if inj.Valid {
			f.gd = append(f.gd, uGD{tipo: "injetada", kwh: inj})
		}
		if comp.Valid {
			f.gd = append(f.gd, uGD{tipo: "compensada", kwh: comp})
		}
		// tipo de ligação ("Tipo de fornecimento: MONOFÁSICO") — mínimo faturável do Grupo B
		if s, ok := j["tipo_ligacao|texto_grande"].(string); ok {
			f.fornecimento = strings.ToUpper(s)
		}
		// tabela do medidor: um registrador por linha (grandeza, posto, leituras, constante, consumo)
		if tb, ok := j["tbl_medidor|tabela"].(map[string]any); ok {
			ks := make([]string, 0, len(tb))
			for k := range tb {
				ks = append(ks, k)
			}
			sort.Strings(ks)
			for _, k := range ks {
				m, _ := tb[k].(map[string]any)
				if m == nil {
					continue
				}
				g := strings.ToUpper(fmt.Sprint(m["grandeza"]))
				x := uMed{grandeza: g, medidor: fmt.Sprint(m["medidor"]), lant: numJSON(m["leitura_anterior"]),
					latu: numJSON(m["leitura_atual"]), k: numJSON(m["constante_medidor"]), cons: numJSON(m["consumo_medidor"])}
				p := strings.ToUpper(sem(fmt.Sprint(m["posto_horario"])))
				switch {
				case strings.Contains(p, "FORA"):
					x.posto = "FORA_PONTA"
				case strings.Contains(p, "PONTA"):
					x.posto = "PONTA"
				case strings.Contains(p, "INTERM"):
					x.posto = "INTERMEDIARIO"
				}
				switch {
				case strings.Contains(g, "KVARH"):
					x.unid = "kvarh"
				case strings.Contains(g, "KWH"):
					x.unid = "kWh"
				case strings.Contains(g, "KW") || strings.Contains(g, "DEMANDA"):
					x.unid = "kW"
				}
				f.meds = append(f.meds, x)
			}
		}
		// sem a leitura anterior, o ciclo começa "dias faturados" (ou 30) antes da atual — senão o ciclo vira
		// só o mês da conta e a bandeira dos dias do mês anterior parece cobrada à toa
		if f.lant == "" && f.latu != "" {
			dias := 30
			if d := numJSON(j["dias_fatura|texto"]); d.Valid && d.Float64 >= 10 && d.Float64 <= 45 {
				dias = int(d.Float64)
			}
			if t, err := time.Parse("2006-01-02", f.latu); err == nil {
				f.lant = t.AddDate(0, 0, -dias).Format("2006-01-02")
			}
		}
		b, _ := j["bert"].(map[string]any)
		if len(b) == 0 {
			b, _ = j["normalization"].(map[string]any)
		}
		if ch := reNaoDigito.ReplaceAllString(fmt.Sprint(b["QR_CODE_CHAVE_ACESSO"]), ""); len(ch) == 44 {
			f.cnpj = ch[6:20]
		}
		f.cidade = strings.ToUpper(strings.Trim(strings.TrimSpace(fmt.Sprint(b["CIDADE"])), ",."))
		if f.cidade == "<NIL>" {
			f.cidade = ""
		}
		if uf, _ := b["ESTADO"].(string); uf != "" && f.cidade != "" {
			f.cidade += "/" + strings.ToUpper(strings.TrimSpace(uf))
		}
		cl, _ := b["CLASSE"].(string)
		f.classe = strings.ToUpper(strings.TrimSpace(strings.Split(cl, "/")[0]))
		f.grupoInferido = f.subgrupo == "" && f.grupo == ""
		f.subgrupo = subgrupoAcer(f.subgrupo, f.grupo, f.classe)
		if f.grupo == "" && f.subgrupo != "" {
			f.grupo = f.subgrupo[:1]
		}
		// PIS + COFINS da tabela de alíquotas
		if tb, ok := j["tbl_aliquotas|tabela"].(map[string]any); ok {
			vistos := map[string]bool{}
			for _, v := range tb {
				t, _ := v.(map[string]any)
				d := strings.ToUpper(strings.ReplaceAll(fmt.Sprint(t["descricao"]), " ", ""))
				k := ""
				if strings.HasPrefix(d, "PIS") {
					k = "PIS"
				} else if strings.HasPrefix(d, "COFINS") {
					k = "COFINS"
				}
				if a := numJSON(t["aliquota"]); k != "" && !vistos[k] && a.Valid && a.Float64 < 15 {
					vistos[k] = true
					f.pisCofins += a.Float64 / 100
				}
			}
		}
		its, _ := b["itens_fatura"].([]any)
		for _, v := range its {
			it, _ := v.(map[string]any)
			if it == nil {
				continue
			}
			desc, _ := it["descricao"].(string)
			clf, _ := it["classification"].(string)
			x := uItem{unid: fmt.Sprint(it["unidade_medida"])}
			x.comp, x.posto, x.desc = itemAcer(clf, desc)
			x.qtd, x.valor = numJSON(it["quantidade"]), numJSON(it["valor"])
			x.tarifa, x.tsem = numJSON(it["tarifa_com_tributos"]), numJSON(it["tarifa_sem_tributos"])
			// tarifa sem tributos maior que a com tributos, ou acima de R$ 3/kWh: campo errado na extração
			if x.tsem.Valid && ((x.tarifa.Valid && x.tarifa.Float64 > 0 && x.tsem.Float64 > x.tarifa.Float64*1.005) ||
				((x.comp == "TE" || x.comp == "TUSD" || x.comp == "CONSUMO" || x.comp == "BANDEIRA") && x.tsem.Float64 > 3)) {
				x.tsem = sql.NullFloat64{}
			}
			// valor ≠ quantidade × tarifa (±3%): campos trocados na extração — a tarifa não é confiável
			if x.tsem.Valid && x.qtd.Valid && x.valor.Valid {
				ref := x.tarifa
				if !ref.Valid || ref.Float64 <= 0 {
					ref = x.tsem
				}
				if calc := ref.Float64 * x.qtd.Float64; calc <= 0 || math.Abs(calc-math.Abs(x.valor.Float64)) > 0.03*math.Abs(x.valor.Float64)+0.05 {
					x.tsem, x.tarifa = sql.NullFloat64{}, sql.NullFloat64{}
				}
			}
			if x.comp == "CONSUMO" { // regras da ANEEL olham TE/TUSD; a linha única vale pelas duas
				x.comp = "TE"
			}
			f.itens = append(f.itens, x)
		}
		f.medidor = normNumMedidor(f.medidor)
		if f.medidor == "" {
			f.medidor = medidorAtivo(f)
		}
		conferirItensExtraidos(f)
		fats[f.id] = f
	}
	return fats, nil
}

// AplicarRegrasAcer — achados das regras selecionadas no conjunto "acer", por id da fatura
func AplicarRegrasAcer(db *sql.DB, sel map[string]bool) (map[string][]Achado, map[string]*uFat, error) {
	out := map[string][]Achado{}
	roda := false
	for c := range sel {
		if regrasAcer[c] {
			roda = true
		}
	}
	if !roda {
		return out, nil, nil
	}
	fats, err := carregarFaturasAcer(db)
	if err != nil {
		return nil, nil, err
	}
	aplicarRegrasComuns(fats, sel, out)
	if sel["F28"] || sel["F41"] || sel["F42"] || sel["F58"] {
		base, err := baseAneel(db)
		if err != nil {
			return nil, nil, err
		}
		if base != nil {
			for id, f := range fats {
				if a := regrasAneel(f, base, sel); len(a) > 0 {
					out[id] = append(out[id], a...)
				}
			}
		}
	}
	if sel["F51"] {
		for id, a := range regraCIPPares(fats) {
			out[id] = append(out[id], a...)
		}
	}
	return out, fats, nil
}

// ---------------------------------------------------------------- endpoint

type acerAchadoFatura struct {
	ID            string   `json:"id"`
	UC            string   `json:"uc"`
	Mes           string   `json:"mes_referencia"`
	Distribuidora string   `json:"distribuidora"`
	Cidade        string   `json:"cidade"`
	Total         float64  `json:"total_a_pagar"`
	Achados       []Achado `json:"achados"`
	Erros         int      `json:"erros"`
	Valor         float64  `json:"valor_estimado"` // soma dos achados de nível ERRO
	Link          string   `json:"link_fatura"`
}

type acerRegrasResultado struct {
	Faturas      int                `json:"faturas_lidas"`
	Itens        []acerAchadoFatura `json:"itens"`
	PorRegra     map[string]int     `json:"por_regra"`
	PorAlerta    map[string]int     `json:"por_alerta"`
	Valor        float64            `json:"valor_estimado"`
	Selecionadas []string           `json:"selecionadas"`
	AneelOK      bool               `json:"aneel_importado"`
	GeradoEm     string             `json:"gerado_em"`
}

var (
	acerRegrasMu         sync.Mutex
	acerRegrasCache      *acerRegrasResultado
	acerRegrasEm         time.Time
	acerRegrasCalculando bool
	acerRegrasErro       string
	acerRegrasGeracao    int // muda quando a seleção é salva: cálculo em andamento com a seleção velha é descartado
)

// GET /api/v1/acer/regras-achados[?refresh=1] — o que as regras do botão ⚙ Regras acham na base da Acer.
// Ler as ~68 mil faturas leva minutos: o cálculo roda em segundo plano e a tela consulta até ficar pronto
// ({"calculando":true}). Com resultado anterior, devolve ele na hora e recalcula atrás se passou de 30 min.
func GetAcerRegrasAchados(c *gin.Context) {
	db, err := usinasDB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	acerRegrasMu.Lock()
	defer acerRegrasMu.Unlock()
	velho := acerRegrasCache == nil || c.Query("refresh") == "1" || time.Since(acerRegrasEm) > 30*time.Minute
	if velho && !acerRegrasCalculando {
		acerRegrasCalculando, acerRegrasErro = true, ""
		if c.Query("refresh") == "1" {
			acerRegrasCache = nil
		}
		ger := acerRegrasGeracao
		go func() {
			r, err := calcularAcerRegras(db)
			acerRegrasMu.Lock()
			defer acerRegrasMu.Unlock()
			acerRegrasCalculando = false
			if ger != acerRegrasGeracao {
				return // seleção mudou no meio: a próxima leitura recalcula
			}
			if err != nil {
				acerRegrasErro = err.Error()
				return
			}
			acerRegrasCache, acerRegrasEm = r, time.Now()
		}()
	}
	if acerRegrasCache == nil {
		if acerRegrasErro != "" {
			c.JSON(http.StatusInternalServerError, gin.H{"error": acerRegrasErro})
			return
		}
		c.JSON(http.StatusAccepted, gin.H{"calculando": true})
		return
	}
	c.JSON(http.StatusOK, acerRegrasCache)
}

func calcularAcerRegras(db *sql.DB) (*acerRegrasResultado, error) {
	sel, _ := selecaoRegras(db, "acer")
	achados, fats, err := AplicarRegrasAcer(db, sel)
	if err != nil {
		return nil, err
	}
	base, _ := baseAneel(db)
	r := &acerRegrasResultado{Faturas: len(fats), PorRegra: map[string]int{}, PorAlerta: map[string]int{},
		AneelOK: base != nil, GeradoEm: time.Now().Format("02/01/2006 15:04")}
	for cod := range sel {
		r.Selecionadas = append(r.Selecionadas, cod)
	}
	sort.Strings(r.Selecionadas)
	var ids []string
	for id := range achados {
		ids = append(ids, id)
	}
	info := map[string][2]string{} // distribuidora, link
	for i := 0; i < len(ids); i += 1000 {
		fim := i + 1000
		if fim > len(ids) {
			fim = len(ids)
		}
		rows, err := db.Query(`SELECT id, COALESCE(distribuidora,''), COALESCE(link_fatura,'') FROM ` + acerTabela +
			` WHERE id IN (` + strings.Join(ids[i:fim], ",") + `)`)
		if err != nil {
			continue
		}
		for rows.Next() {
			var id, d, l string
			if rows.Scan(&id, &d, &l) == nil {
				info[id] = [2]string{d, l}
			}
		}
		rows.Close()
	}
	for id, as := range achados {
		f := fats[id]
		it := acerAchadoFatura{ID: id, UC: f.chave, Mes: f.mes, Distribuidora: info[id][0], Cidade: f.cidade,
			Total: f.total, Achados: as, Link: info[id][1]}
		vistos := map[string]bool{}
		for _, a := range as {
			if a.Nivel == "ERRO" {
				it.Erros++
				it.Valor += a.Valor
			}
			k := a.Codigo + "|" + a.Nivel
			if vistos[k] {
				continue
			}
			vistos[k] = true
			if a.Nivel == "ERRO" {
				r.PorRegra[a.Codigo]++
			} else {
				r.PorAlerta[a.Codigo]++
			}
		}
		it.Valor = rnd2(it.Valor)
		r.Valor += it.Valor
		r.Itens = append(r.Itens, it)
	}
	r.Valor = rnd2(r.Valor)
	sort.Slice(r.Itens, func(i, j int) bool {
		if r.Itens[i].Erros != r.Itens[j].Erros {
			return r.Itens[i].Erros > r.Itens[j].Erros
		}
		return r.Itens[i].Valor > r.Itens[j].Valor
	})
	return r, nil
}

// limparCacheRegras — seleção salva: as abas recalculam na próxima leitura
func limparCacheRegras(conj string) {
	if conj == "acer" {
		acerRegrasMu.Lock()
		acerRegrasCache, acerRegrasErro = nil, "" // o cálculo seguinte usa a seleção nova
		acerRegrasGeracao++
		acerRegrasMu.Unlock()
		limparCacheAcerPainel()
	}
	if conj == "energia" {
		limparCacheEnergia()
	}
}
