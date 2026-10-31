package handlers

// ⚡ Auditoria de Faturas das USINAS (Thopen) — aba dentro de /analise-desvio.
// Somente leitura: roda o MESMO motor F01–F05 da Auditoria de Faturas sobre FATURA_USINA*
// (carregadas pelo robô/visual), ao vivo, mapeando as colunas para o formato da FDE.
//
// Estimativa do F02 (não usa o total a pagar — nas usinas ele inclui demanda de geração etc.):
//   excesso_kwh = consumo − média histórica;  preço = valor dos itens de energia ÷ consumo (com tributos)
//   bruto = excesso × preço;  não compensado = bruto × (valor energia + compensação GD) ÷ valor energia

import (
	"database/sql"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// consumo do posto = maior quantidade faturada dos itens TUSD/TE/CONSUMO (TE e TUSD repetem a mesma quantidade)
const usinaItemMax = `(SELECT MAX(i.quantidade_faturada) FROM FATURA_USINA_ITENS i
   WHERE i.id_fatura = f.id_fatura AND i.componente IN ('TUSD','TE','CONSUMO') AND i.quantidade_faturada > 0 AND `

const usinaPostoP = `i.posto = 'PONTA')`
const usinaPostoFP = `(i.posto IS NULL OR i.posto IN ('FORA_PONTA','UNICO','TODOS')))`

// 1ª medição de energia ativa consumida fora ponta (leituras/constante p/ o F01)
func usinaMedFP(col string) string {
	return `(SELECT m.` + col + ` FROM FATURA_USINA_MEDICOES m
   WHERE m.id_fatura = f.id_fatura AND m.unidade IN ('kWh','KWH') AND m.posto = 'FORA_PONTA'
     AND m.grandeza NOT REGEXP 'INJ|GERA|REAT|EXCE|RTV|EXC' AND m.constante > 0
   ORDER BY m.ordem LIMIT 1)`
}

// chave da UC: só o número antes de " / " (Enel SP A4 imprime "inst / conta") e sem zeros à esquerda
const usinaChaveUC = `TRIM(LEADING '0' FROM TRIM(SUBSTRING_INDEX(COALESCE(f.uc,''),'/',1)))`

// FonteUsinas — subconsulta no formato que o motor lê (mesmas colunas da FDE).
// Ficam de fora demonstrativos (FIT, GD Copel), duplicatas e faturas sem consumo.
func FonteUsinas() string {
	cp := usinaItemMax + usinaPostoP
	cfp := usinaItemMax + usinaPostoFP
	return `(SELECT MIN(id) AS id, numero_instalacao, codigo_uc, mes_referencia,
	        ANY_VALUE(numero_medidor) AS numero_medidor, '' AS validador_gate,
	        ANY_VALUE(k) AS constante_k, ANY_VALUE(lant) AS leit_ant_ativa_fponta, ANY_VALUE(latu) AS leit_atu_ativa_fponta,
	        ANY_VALUE(cp) AS consumo_ativo_ponta_kwh, ANY_VALUE(cfp) AS consumo_ativo_fponta_kwh,
	        CAST(NULL AS DECIMAL(14,2)) AS consumo_ativo_sefaz_kwh, '' AS historico_consumo_json,
	        0 AS flag_fatura_revisao, 0 AS flag_acumulo_art113, 0 AS kwh_acumulado_art113,
	        ANY_VALUE(grupo) AS grupo_tarifario, kwh_total
	   FROM (SELECT CAST(CONV(LEFT(f.id_fatura,15),16,10) AS SIGNED) AS id,
	                ` + usinaChaveUC + ` AS numero_instalacao, '' AS codigo_uc,
	                CONCAT(SUBSTRING(f.mes_referencia,6,2),'/',LEFT(f.mes_referencia,4)) AS mes_referencia,
	                NULL AS numero_medidor, COALESCE(f.grupo,'') AS grupo,
	                ` + cp + ` AS cp, ` + cfp + ` AS cfp,
	                ` + usinaMedFP("constante") + ` AS k,
	                ` + usinaMedFP("leitura_anterior") + ` AS lant,
	                ` + usinaMedFP("leitura_atual") + ` AS latu,
	                COALESCE(` + cp + `,0) + COALESCE(` + cfp + `,0) AS kwh_total
	           FROM FATURA_USINA f
	          WHERE f.duplicata_de IS NULL AND COALESCE(f.tipo_documento,'fatura_energia') NOT LIKE 'demonstrativo%'
	            AND f.mes_referencia REGEXP '^[0-9]{4}-[0-9]{2}' AND COALESCE(f.uc,'') <> '') x
	  WHERE kwh_total > 0
	  GROUP BY numero_instalacao, codigo_uc, mes_referencia, kwh_total) t`
}

// MotorUsinas — apontamentos F01–F05 das usinas, indexados pelo id numérico (15 hex do id_fatura).
func MotorUsinas(db *sql.DB) (map[int64]ResultadoDesvio, error) {
	return motorApontamentosWhere(db, FonteUsinas(), "1=1", nil)
}

type UsinaApontamento struct {
	IDFatura        string   `json:"id_fatura"`
	Distribuidora   string   `json:"distribuidora"`
	Usina           string   `json:"usina"`
	Titular         string   `json:"titular"`
	UC              string   `json:"uc"`
	UCChave         string   `json:"uc_chave"`
	MesRef          string   `json:"mes_referencia"`
	Metodo          string   `json:"metodo"`
	Fichas          []string `json:"fichas"`
	ConsumoKWh      float64  `json:"consumo_kwh"`
	MediaKWh        float64  `json:"media_kwh"`
	ExcessoKWh      float64  `json:"excesso_kwh"`
	PrecoKWh        float64  `json:"preco_kwh"`
	DesvioPct       float64  `json:"desvio_pct"`
	Classe          string   `json:"classe_desvio"`
	F02Validacao    string   `json:"f02_validacao"`
	Classificacao   string   `json:"classificacao_historico"`
	Forte           bool     `json:"forte"`
	EstimativaBruta float64  `json:"estimativa_bruta"`
	EstimativaLiq   float64  `json:"estimativa_nao_compensada"`
	TotalAPagar     float64  `json:"total_a_pagar"`
	LeituraSuspeita bool     `json:"leitura_suspeita"`
	Detalhe         []string `json:"detalhamento"`
	DetalhesF01     any      `json:"detalhes_f01,omitempty"`
	Link            string   `json:"link_drive"`
	Achados         []Achado `json:"achados,omitempty"` // regras do catálogo além do motor (F13, F35, F53...)
	Alertas         []string `json:"alertas,omitempty"` // códigos com nível ALERTA (não entram em "fichas")
}

type usinasResultado struct {
	Gerado       string             `json:"gerado_em"`
	Faturas      int                `json:"faturas_analisadas"`
	UCs          int                `json:"ucs_analisadas"`
	PorFicha     map[string]int     `json:"por_ficha"`
	Fortes       int                `json:"f02_fortes"`
	EstBruta     float64            `json:"estimativa_bruta"`
	EstLiq       float64            `json:"estimativa_nao_compensada"`
	EstFortesB   float64            `json:"estimativa_fortes_bruta"`
	EstFortesL   float64            `json:"estimativa_fortes_nao_compensada"`
	EstOutras    float64            `json:"estimativa_outras_regras"`
	PorAlerta    map[string]int     `json:"por_alerta"`
	Selecionadas []string           `json:"regras_selecionadas"`
	Apontamentos []UsinaApontamento `json:"apontamentos"`
}

var (
	usinasCacheMu sync.Mutex
	usinasCache   *usinasResultado
	usinasCacheEm time.Time
)

// usinasDB — conexão do banco da aplicação (sql puro; cai para a do GORM se for o caso).
func usinasDB() (*sql.DB, error) {
	if database.DB_App != nil {
		return database.DB_App, nil
	}
	if database.GormDB_App == nil {
		return nil, sql.ErrConnDone
	}
	return database.GormDB_App.DB()
}

func r2(v float64) float64 { return float64(int64(v*100+0.5)) / 100 }

func calcularUsinas(db *sql.DB) (*usinasResultado, error) {
	sel, _ := selecaoRegras(db, "usinas")
	return CalcularUsinas(db, sel)
}

// CalcularUsinas — apontamentos com uma seleção de regras explícita (a aba usa a seleção salva).
func CalcularUsinas(db *sql.DB, sel map[string]bool) (*usinasResultado, error) {
	res, err := MotorUsinas(db)
	if err != nil {
		return nil, err
	}
	achados, err := AplicarRegrasUsinas(db, sel)
	if err != nil {
		return nil, err
	}
	out := &usinasResultado{Gerado: time.Now().Format(time.RFC3339), PorFicha: map[string]int{}, PorAlerta: map[string]int{}}
	for c := range sel {
		out.Selecionadas = append(out.Selecionadas, c)
	}
	sort.Strings(out.Selecionadas)
	_ = db.QueryRow(`SELECT COUNT(*), COUNT(DISTINCT numero_instalacao) FROM `+FonteUsinas()).Scan(&out.Faturas, &out.UCs)

	// metadados (id numérico → fatura)
	rows, err := db.Query(`SELECT f.id_fatura, COALESCE(f.distribuidora_sigla,''), COALESCE(f.pasta_usina,''),
		COALESCE(f.titular_nome,''), COALESCE(f.uc,''), ` + usinaChaveUC + `, COALESCE(f.mes_referencia,''),
		COALESCE(f.metodo,''), COALESCE(f.total_a_pagar,0), COALESCE(f.link_drive,'') FROM FATURA_USINA f`)
	if err != nil {
		return nil, err
	}
	meta := map[int64]UsinaApontamento{}
	metaID := map[string]UsinaApontamento{}
	for rows.Next() {
		var x UsinaApontamento
		if rows.Scan(&x.IDFatura, &x.Distribuidora, &x.Usina, &x.Titular, &x.UC, &x.UCChave, &x.MesRef, &x.Metodo,
			&x.TotalAPagar, &x.Link) == nil && len(x.IDFatura) >= 15 {
			if n, e := strconv.ParseInt(x.IDFatura[:15], 16, 64); e == nil {
				meta[n] = x
				metaID[x.IDFatura] = x
			}
		}
	}
	rows.Close()

	ids := make([]string, 0, len(res)+len(achados))
	for id := range res {
		if m, ok := meta[id]; ok {
			ids = append(ids, m.IDFatura)
		}
	}
	for id := range achados {
		ids = append(ids, id)
	}
	// consumo e valores de energia/compensação das faturas apontadas
	type energia struct{ cons, vCons, vComp float64 }
	en := map[string]energia{}
	for k := 0; k < len(ids); k += 500 {
		fim := k + 500
		if fim > len(ids) {
			fim = len(ids)
		}
		ph := strings.TrimSuffix(strings.Repeat("?,", fim-k), ",")
		args := make([]any, 0, fim-k)
		for _, s := range ids[k:fim] {
			args = append(args, s)
		}
		er, err := db.Query(`SELECT id_fatura,
			COALESCE(MAX(CASE WHEN componente IN ('TUSD','TE','CONSUMO') AND posto='PONTA' THEN quantidade_faturada END),0)
			 + COALESCE(MAX(CASE WHEN componente IN ('TUSD','TE','CONSUMO') AND (posto IS NULL OR posto IN ('FORA_PONTA','UNICO','TODOS')) THEN quantidade_faturada END),0),
			COALESCE(SUM(CASE WHEN componente IN ('TUSD','TE','CONSUMO') AND valor > 0 THEN valor END),0),
			COALESCE(SUM(CASE WHEN componente IN ('CONSUMO_COMPENSADO','GD_INJETADA') AND valor < 0 THEN valor END),0)
			FROM FATURA_USINA_ITENS WHERE id_fatura IN (`+ph+`) GROUP BY id_fatura`, args...)
		if err != nil {
			return nil, err
		}
		for er.Next() {
			var id string
			var e energia
			if er.Scan(&id, &e.cons, &e.vCons, &e.vComp) == nil {
				en[id] = e
			}
		}
		er.Close()
	}

	feitos := map[string]bool{}
	for id, r := range res {
		x, ok := meta[id]
		if !ok {
			continue
		}
		var fichas []string // só as regras do motor que estão selecionadas para as usinas
		for _, f := range r.FichasAplicadas {
			if sel[f] {
				fichas = append(fichas, f)
			}
		}
		if len(fichas) == 0 && len(achados[x.IDFatura]) == 0 {
			continue
		}
		r.FichasAplicadas = fichas
		r.F02 = r.F02 && sel["F02"]
		x.Fichas, x.DesvioPct, x.Classe, x.F02Validacao = r.FichasAplicadas, r2(r.DesvioPctMax), r.ClasseDesvio, r.F02Validacao
		x.Classificacao, x.LeituraSuspeita, x.Detalhe = r.ClassificacaoHistorico, r.LeituraSuspeita, r.Detalhamento
		if len(r.DetalhesF01) > 0 {
			x.DetalhesF01 = r.DetalhesF01
		}
		e := en[x.IDFatura]
		x.ConsumoKWh = r2(e.cons)
		if r.F02 && r.DesvioPctMax > 0 && e.cons > 0 {
			x.MediaKWh = r2(e.cons / (1 + r.DesvioPctMax/100))
			x.ExcessoKWh = r2(e.cons - x.MediaKWh)
			x.PrecoKWh = float64(int64(e.vCons/e.cons*100000+0.5)) / 100000
			x.EstimativaBruta = r2(x.ExcessoKWh * x.PrecoKWh)
			if e.vCons > 0 {
				liq := e.vCons + e.vComp
				if liq < 0 {
					liq = 0
				}
				x.EstimativaLiq = r2(x.EstimativaBruta * liq / e.vCons)
			}
			x.Forte = r.ClassificacaoHistorico == "ELEVADO_REAL" && r.F02Validacao == "CONFIRMADO"
			out.EstBruta += x.EstimativaBruta
			out.EstLiq += x.EstimativaLiq
			if x.Forte {
				out.Fortes++
				out.EstFortesB += x.EstimativaBruta
				out.EstFortesL += x.EstimativaLiq
			}
		}
		feitos[x.IDFatura] = true
		out.Apontamentos = append(out.Apontamentos, x)
	}
	for id := range achados {
		if feitos[id] {
			continue
		}
		if x, ok := metaID[id]; ok {
			x.ConsumoKWh = r2(en[id].cons)
			out.Apontamentos = append(out.Apontamentos, x)
		}
	}
	lst := out.Apontamentos[:0]
	for _, x := range out.Apontamentos {
		for _, a := range achados[x.IDFatura] {
			x.Achados = append(x.Achados, a)
			if a.Nivel == "ERRO" {
				x.Fichas = append(x.Fichas, a.Codigo)
				x.Detalhe = append(x.Detalhe, a.Codigo+" - "+a.Detalhe)
				out.EstOutras += a.Valor
			} else {
				x.Alertas = append(x.Alertas, a.Codigo)
			}
		}
		for _, f := range x.Fichas {
			out.PorFicha[f]++
		}
		for _, f := range x.Alertas {
			out.PorAlerta[f]++
		}
		lst = append(lst, x)
	}
	out.Apontamentos = lst
	out.EstOutras = r2(out.EstOutras)
	out.EstBruta, out.EstLiq, out.EstFortesB, out.EstFortesL = r2(out.EstBruta), r2(out.EstLiq), r2(out.EstFortesB), r2(out.EstFortesL)
	sort.Slice(out.Apontamentos, func(i, j int) bool {
		a, b := out.Apontamentos[i], out.Apontamentos[j]
		if a.Forte != b.Forte {
			return a.Forte
		}
		return a.EstimativaLiq > b.EstimativaLiq || (a.EstimativaLiq == b.EstimativaLiq && a.DesvioPct > b.DesvioPct)
	})
	return out, nil
}

// GET /api/v1/usinas/apontamentos[?refresh=1] — resumo + apontamentos F01–F05 (cache de 10 min).
func GetUsinasApontamentos(c *gin.Context) {
	sqlDB, err := usinasDB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	usinasCacheMu.Lock()
	defer usinasCacheMu.Unlock()
	if usinasCache == nil || c.Query("refresh") == "1" || time.Since(usinasCacheEm) > 10*time.Minute {
		r, err := calcularUsinas(sqlDB)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		usinasCache, usinasCacheEm = r, time.Now()
	}
	c.JSON(http.StatusOK, usinasCache)
}

// GET /api/v1/usinas/uc-historico?uc=<uc_chave> — consumo mês a mês da UC (para o gráfico do detalhe).
func GetUsinasUCHistorico(c *gin.Context) {
	uc := strings.TrimSpace(c.Query("uc"))
	if uc == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "uc obrigatória"})
		return
	}
	sqlDB, err := usinasDB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	cp := usinaItemMax + usinaPostoP
	cfp := usinaItemMax + usinaPostoFP
	rows, err := sqlDB.Query(`SELECT f.id_fatura, f.mes_referencia, COALESCE(`+cp+`,0), COALESCE(`+cfp+`,0),
		COALESCE(f.total_a_pagar,0), COALESCE(f.link_drive,''), COALESCE(f.metodo,'')
		FROM FATURA_USINA f
		WHERE `+usinaChaveUC+` = ? AND f.duplicata_de IS NULL
		  AND COALESCE(f.tipo_documento,'fatura_energia') NOT LIKE 'demonstrativo%'
		ORDER BY f.mes_referencia`, uc)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	type mes struct {
		IDFatura string  `json:"id_fatura"`
		Mes      string  `json:"mes_referencia"`
		Ponta    float64 `json:"ponta_kwh"`
		FPonta   float64 `json:"fora_ponta_kwh"`
		Total    float64 `json:"total_a_pagar"`
		Link     string  `json:"link_drive"`
		Metodo   string  `json:"metodo"`
	}
	out := []mes{}
	for rows.Next() {
		var m mes
		if rows.Scan(&m.IDFatura, &m.Mes, &m.Ponta, &m.FPonta, &m.Total, &m.Link, &m.Metodo) == nil {
			out = append(out, m)
		}
	}
	c.JSON(http.StatusOK, gin.H{"uc": uc, "meses": out})
}
