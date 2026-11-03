package handlers

// 🅰️ Aba ACER da Auditoria de Faturas no formato da aba Usinas (mesma tela da Energia — EnergiaPanel base="acer").
// Junta, por fatura da FATURA_ACER_DADOS_EXTRAIDOS:
//   - o motor F01–F05 apontado para a tabela da Acer (só F02–F05: F01 na Acer é ruído de extração —
//     acerApontamentoValido), com o ressarcimento estimado cheio (100%, acerRessEstimado);
//   - as regras do botão "⚙ Regras" (conjunto "acer"), as mesmas das usinas (acer_regras.go);
//   - a rejeição POR REGRA. Os ids da Acer repetem os da FDE, então a rejeição da Acer fica em
//     FATURA_REANALISES com fatura_id = 0 e uid = "ACER#<id>" (nunca cai numa fatura da Energia).

import (
	"database/sql"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const acerUIDPrefixo = "ACER#"

var (
	acerPainelMu         sync.Mutex
	acerPainelCache      *energiaResultado
	acerPainelEm         time.Time
	acerPainelCalculando bool
	acerPainelErro       string
	acerPainelGeracao    int
)

// carregarRejeicoesAcer — rejeições das faturas da Acer (FATURA_REANALISES.uid = "ACER#id")
func carregarRejeicoesAcer(db *sql.DB, ids []string) map[string]*Rejeicao {
	out := map[string]*Rejeicao{}
	for i := 0; i < len(ids); i += 1000 {
		fim := i + 1000
		if fim > len(ids) {
			fim = len(ids)
		}
		args := make([]any, 0, fim-i)
		ph := make([]string, 0, fim-i)
		for _, id := range ids[i:fim] {
			args = append(args, acerUIDPrefixo+id)
			ph = append(ph, "?")
		}
		rows, err := db.Query(`SELECT uid, COALESCE(regras_rejeitadas,''), COALESCE(usuario_nome,''),
			COALESCE(DATE_FORMAT(criado_em,'%d/%m/%Y'),'') FROM FATURA_REANALISES
			WHERE recomendacao = 'REJEITADO' AND fatura_id = 0 AND uid IN (`+strings.Join(ph, ",")+`) ORDER BY criado_em`, args...)
		if err != nil {
			continue
		}
		for rows.Next() {
			var uid, regras, usuario, em string
			if rows.Scan(&uid, &regras, &usuario, &em) != nil {
				continue
			}
			id := strings.TrimPrefix(uid, acerUIDPrefixo)
			r := out[id]
			if r == nil {
				r = &Rejeicao{Regras: map[string]bool{}}
				out[id] = r
			}
			lst := strings.Split(normalizarRegras(regras), ",")
			if regras == "" {
				lst = regrasRejeicaoLegado
			}
			for _, c := range lst {
				if c != "" {
					r.Regras[c] = true
				}
			}
			r.Usuario, r.Em = usuario, em
		}
		rows.Close()
	}
	for _, r := range out {
		for c := range r.Regras {
			r.Lista = append(r.Lista, c)
		}
		sort.Strings(r.Lista)
	}
	return out
}

// GET /api/v1/acer/painel[?refresh=1] — cálculo em segundo plano (~2 min): {"calculando":true} até ficar pronto
func GetAcerPainel(c *gin.Context) {
	db, err := usinasDB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	acerPainelMu.Lock()
	defer acerPainelMu.Unlock()
	velho := acerPainelCache == nil || c.Query("refresh") == "1" || time.Since(acerPainelEm) > 2*time.Hour
	if velho && !acerPainelCalculando {
		acerPainelCalculando, acerPainelErro = true, ""
		if c.Query("refresh") == "1" {
			acerPainelCache = nil
		}
		ger := acerPainelGeracao
		go func() {
			sel, _ := selecaoRegras(db, "acer")
			r, err := CalcularAcerPainel(db, sel)
			acerPainelMu.Lock()
			defer acerPainelMu.Unlock()
			acerPainelCalculando = false
			if ger != acerPainelGeracao {
				return
			}
			if err != nil {
				acerPainelErro = err.Error()
				return
			}
			acerPainelCache, acerPainelEm = r, time.Now()
		}()
	}
	if acerPainelCache == nil {
		if acerPainelErro != "" {
			c.JSON(http.StatusInternalServerError, gin.H{"error": acerPainelErro})
			return
		}
		c.JSON(http.StatusAccepted, gin.H{"calculando": true})
		return
	}
	c.JSON(http.StatusOK, acerPainelCache)
}

// CalcularAcerPainel — motor F01–F05 da Acer + regras do conjunto "acer" + rejeições por regra
func CalcularAcerPainel(db *sql.DB, sel map[string]bool) (*energiaResultado, error) {
	motor, err := motorApontamentosCachedT(db, "", true, acerTabela)
	if err != nil {
		return nil, err
	}
	achados, _, err := AplicarRegrasAcer(db, sel)
	if err != nil {
		return nil, err
	}
	base, _ := baseAneel(db)
	out := &energiaResultado{Gerado: time.Now().Format("02/01/2006 15:04"), PorFicha: map[string]int{}, PorAlerta: map[string]int{},
		AneelOK: base != nil}
	for c := range sel {
		out.Selecionadas = append(out.Selecionadas, c)
	}
	sort.Strings(out.Selecionadas)
	_ = db.QueryRow(`SELECT COUNT(*), COUNT(DISTINCT COALESCE(NULLIF(TRIM(numero_instalacao),''), codigo_uc)) FROM `+acerTabela).
		Scan(&out.Faturas, &out.UCs)

	idSet := map[string]bool{}
	for id, res := range motor {
		if acerApontamentoValido(res.FichasAplicadas) {
			idSet[strconv.FormatInt(id, 10)] = true
		}
	}
	for id := range achados {
		idSet[id] = true
	}
	ids := make([]string, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	rej := carregarRejeicoesAcer(db, ids)

	type meta struct {
		x       EnergiaApontamento
		kwh, en float64
	}
	metas := map[string]*meta{}
	for i := 0; i < len(ids); i += 1000 {
		fim := i + 1000
		if fim > len(ids) {
			fim = len(ids)
		}
		rows, err := db.Query(`SELECT id, COALESCE(TRIM(distribuidora),''),
			COALESCE(NULLIF(TRIM(numero_instalacao),''), codigo_uc, ''), COALESCE(LEFT(mes_referencia,7),''),
			COALESCE(kwh_total,0), COALESCE(valor_energia_ativa,0), COALESCE(valor_total_fatura,0), COALESCE(link_fatura,'')
			FROM ` + acerTabela + ` WHERE id IN (` + strings.Join(ids[i:fim], ",") + `)`)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			m := &meta{}
			if rows.Scan(&m.x.ID, &m.x.Distribuidora, &m.x.UC, &m.x.Mes, &m.kwh, &m.en, &m.x.Total, &m.x.Link) == nil {
				metas[m.x.ID] = m
			}
		}
		rows.Close()
	}

	for _, id := range ids {
		m := metas[id]
		if m == nil {
			continue
		}
		x := m.x
		x.Fichas, x.Motor = []string{}, []string{}
		x.CodEmpresa, x.Empresa = 2028, "ACER"
		x.ConsumoKWh = r2(m.kwh)
		r := rej[id]
		n, _ := strconv.ParseInt(id, 10, 64)
		if res, ok := motor[n]; ok && acerApontamentoValido(res.FichasAplicadas) {
			for _, f := range res.FichasAplicadas {
				if f != "F01" && sel[f] && (r == nil || !r.Regras[f]) {
					x.Motor = append(x.Motor, f)
				}
			}
			if len(x.Motor) > 0 {
				x.Fichas = append(x.Fichas, x.Motor...)
				x.Detalhe = append(x.Detalhe, res.Detalhamento...)
				x.DesvioPct, x.F02Validacao, x.Classificacao = r2(res.DesvioPctMax), res.F02Validacao, res.ClassificacaoHistorico
				if contem(x.Motor, "F02") {
					x.Forte = res.ClassificacaoHistorico == "ELEVADO_REAL" && res.F02Validacao == "CONFIRMADO"
					if res.DesvioPctMax > 0 && m.kwh > 0 {
						x.MediaKWh = r2(m.kwh / (1 + res.DesvioPctMax/100))
						x.ExcessoKWh = r2(m.kwh - x.MediaKWh)
						x.PrecoKWh = r2(m.en/m.kwh*1000) / 1000
					}
					en := m.en
					if en <= 0 {
						en = m.x.Total
					}
					x.EstimativaF02 = acerRound2(acerRessEstimado(en, res.DesvioPctMax))
				}
			}
		}
		for _, a := range achados[id] {
			if r != nil && r.Regras[a.Codigo] {
				continue
			}
			x.Achados = append(x.Achados, a)
			if a.Nivel == "ERRO" {
				if !contem(x.Fichas, a.Codigo) {
					x.Fichas = append(x.Fichas, a.Codigo)
				}
				x.ValorOutras += a.Valor
			} else if !contem(x.Alertas, a.Codigo) {
				x.Alertas = append(x.Alertas, a.Codigo)
			}
		}
		if len(x.Fichas) == 0 && len(x.Alertas) == 0 {
			continue
		}
		x.ValorOutras = r2(x.ValorOutras)
		if r != nil {
			x.Rejeitada = r
			if len(x.Fichas) > 0 { // reabre só com erro novo (alerta novo fica na lista de alertas)
				out.Reabertas++
			}
		}
		for _, f := range x.Fichas {
			out.PorFicha[f]++
		}
		for _, f := range x.Alertas {
			out.PorAlerta[f]++
		}
		if x.Forte {
			out.Fortes++
		}
		out.EstF02 += x.EstimativaF02
		out.EstOutras += x.ValorOutras
		out.Apontamentos = append(out.Apontamentos, x)
	}
	out.EstF02, out.EstOutras = r2(out.EstF02), r2(out.EstOutras)
	sort.Slice(out.Apontamentos, func(i, j int) bool {
		a, b := out.Apontamentos[i], out.Apontamentos[j]
		if a.Forte != b.Forte {
			return a.Forte
		}
		return a.EstimativaF02+a.ValorOutras > b.EstimativaF02+b.ValorOutras
	})
	return out, nil
}

// acerAplicarRejeicao — a fatura da Acer acabou de ser rejeitada: atualiza o resultado em memória
func acerAplicarRejeicao(id string, regras sql.NullString, usuario string) {
	acerPainelMu.Lock()
	defer acerPainelMu.Unlock()
	aplicarRejeicaoResultado(acerPainelCache, id, regras, usuario)
}

// limparCacheAcerPainel — seleção salva: a próxima leitura recalcula
func limparCacheAcerPainel() {
	acerPainelMu.Lock()
	acerPainelCache, acerPainelErro = nil, ""
	acerPainelGeracao++
	acerPainelMu.Unlock()
}
