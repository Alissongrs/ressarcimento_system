package handlers

// ⚡ Aba ENERGIA da Auditoria de Faturas no formato da aba Usinas — FATURA_DADOS_EXTRAIDOS (FDE).
// Junta, por fatura:
//   - o motor F01–F05 (o mesmo das abas Apontamentos/Energia — motorApontamentosCached, já sem o que virou processo);
//   - as regras do botão "⚙ Regras" (conjunto "energia"): tarifa/bandeira homologada da ANEEL (F28 F41 F42 F58)
//     e CIP comparada entre UCs (F51), rodando sobre os itens extraídos (itens_cobrados);
//   - a rejeição POR REGRA (rejeicao_regras.go): regra já rejeitada nesta fatura não aponta de novo; regra nova
//     que aponta numa fatura rejeitada volta marcada "rejeitada por F02 (analista, data) — novo apontamento por F28".
//
// Itens da FDE: descrição livre (cada distribuidora escreve de um jeito) → componente por palavra-chave
// (itemEnergia). A tarifa "sem tributos" só vale quando foi impressa: o extrator copia a com tributos quando
// não acha (_tarifa_aneel_fonte = fallback…) — essa é descartada, senão toda linha com ICMS pareceria cara.
// Linha cujo valor ≠ quantidade × tarifa (±3%) também perde a tarifa (campo trocado na extração).

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
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// regras que já rodam na base de Energia (as demais aparecem como "ainda não ligada a esta base"):
// as mesmas da aba Usinas — só com a fatura, com o histórico da UC, da ANEEL e a CIP entre UCs
var regrasEnergia = map[string]bool{"F28": true, "F41": true, "F42": true, "F58": true, "F51": true,
	// regras_extra.go (05/11/2026) — a FDE não tem o quadro de tributos (base/valor) nem o de continuidade
	"F16": true, "F18": true, "F20": true, "F23": true, "F29": true, "F44": true, "F46": true, "F45": true, "F56": true,
	"F10": true, "F11": true, "F19": true, "F21": true, "F24": true, "F26": true, "F31": true, "F32": true, "F43": true,
	"F13": true, "F14": true, "F15": true, "F17": true, "F27": true, "F35": true, "F36": true, "F52": true,
	"F53": true, "F54": true, "F55": true,
	"F06": true, "F07": true, "F08": true, "F33": true, "F34": true, "F57": true}

// empresas fora da Auditoria de Faturas (REZEK, VTAL) — mesmo corte da lista antiga
const energiaFiltroEmpresa = `COALESCE(cod_empresa,0) NOT IN (14, 2025)`

// mês de referência da FDE ("2026-01-01" ou "01/2026") → "AAAA-MM"
const energiaMesSQL = `CASE WHEN mes_referencia REGEXP '^[0-9]{4}-[0-9]{2}' THEN LEFT(mes_referencia,7)
	WHEN mes_referencia REGEXP '^[0-9]{2}/[0-9]{4}' THEN CONCAT(SUBSTRING(mes_referencia,4,4),'-',LEFT(mes_referencia,2)) END`

var (
	reEnForaPonta = regexp.MustCompile(`F\.?\s*PONTA|FORA\s*(DE\s*)?PONTA|FPONTA|F\.?\s*PTA|HFP|\bFP\b|FORA\s*PTA`)
	reEnPonta     = regexp.MustCompile(`PONTA|\bPTA\b|\bHP\b`)
	reEnTE        = regexp.MustCompile(`(^|[^A-Z])TE([^A-Z]|$)|ENERGIA\s*\(TE\)`)
	reEnTUSD      = regexp.MustCompile(`TUSD|USO\s*(DO\s*)?SIST|\bFIO\b`)
	reEnOutro     = regexp.MustCompile(`\bCDE\b|ENCARGO|CONTA\s*ESCASS|REAT|MULTA|JUROS|CORRE|ATUALIZ|DEVOLU|AJUSTE|DESC|SUBV|SUBSID|CRED|DEBIT|DÉBIT|\bPIS\b|COFINS|ICMS|ACL|LIVRE|TERC|COMERCIALIZ|PARCEL|ULTRAPASS|DIF\.|RESSARC|DIC|FIC|DMIC|ACRESC.*ATRASO|DOA[CÇ]|SEGURO|CONTRIB.*ASSOC`)
	reEnCompensa  = regexp.MustCompile(`INJ|COMPENS|SCEE|\bGD\b|GDI|GERA[CÇ]`)
	// "escassez" sozinho é o encargo CDE Escassez Hídrica (regra 46), não a bandeira
	reEnBandeira = regexp.MustCompile(`BAND|\bB\.?\s*(AMAREL|VERM|ESCASS)|AD\.?\s*B\.|AMARELA|VERMELHA`)
	reEnCIP      = regexp.MustCompile(`ILUM|\bCIP\b|COSIP|CIP-|CIP\s`)
	reEnReativo  = regexp.MustCompile(`REAT|UFER|UFDR|DMCR|EXCED.*KVA|KVARH`)
	reEnConsumo  = regexp.MustCompile(`CONSUMO|ENERGIA|TUSD|USO\s*(DO\s*)?SIST|(^|[^A-Z])TE([^A-Z]|$)|DISP|FORNECID`)
)

// itemEnergia — componente/posto de uma linha da FDE pela descrição (última linha do texto: a 1ª às vezes
// carrega a coluna de ICMS da linha de cima)
func itemEnergia(descRaw, postoCampo, unidade string, credGD bool, valor float64) (comp, posto, desc string) {
	ls := strings.Split(strings.TrimSpace(descRaw), "\n")
	desc = strings.TrimSpace(ls[len(ls)-1])
	d := strings.ToUpper(sem(desc))
	p := strings.ToUpper(sem(postoCampo)) + " " + d
	switch {
	case reEnForaPonta.MatchString(p):
		posto = "FORA_PONTA"
	case strings.Contains(p, "INTERMEDI"):
		posto = "INTERMEDIARIO"
	case reEnPonta.MatchString(p):
		posto = "PONTA"
	}
	u := strings.ToUpper(strings.TrimSpace(unidade))
	kwh := u == "" || strings.HasPrefix(u, "KWH")
	switch {
	case credGD || reEnCompensa.MatchString(d):
		comp = "CONSUMO_COMPENSADO"
	case reEnCIP.MatchString(d) && !strings.Contains(d, "MULTA") && !strings.Contains(d, "JUROS"):
		comp = "ILUMINACAO_PUBLICA"
	case valor > 0 && reEnReativo.MatchString(d):
		comp = "REATIVO_EXCEDENTE"
	case valor < 0 || reEnOutro.MatchString(d):
		comp = "OUTRO"
	case reEnBandeira.MatchString(d):
		comp = "BANDEIRA"
	case strings.Contains(d, "DEMANDA") || strings.HasPrefix(u, "KW") && !strings.HasPrefix(u, "KWH"):
		comp = "DEMANDA"
		if strings.Contains(d, "GERA") {
			comp = "DEMANDA_GERACAO"
		}
	case kwh && reEnConsumo.MatchString(d):
		// as regras da ANEEL olham "TE"; a marca na descrição diz se a linha é só TE, só TUSD ou as duas
		comp = "TE"
		tusd, te := reEnTUSD.MatchString(d), reEnTE.MatchString(d)
		if tusd && !te {
			desc = "[TUSD] " + desc
		} else if te && !tusd {
			desc = "[TE] " + desc
		}
	default:
		comp = "OUTRO"
	}
	return
}

// cnpjAneel — CNPJ da distribuidora como está na base da ANEEL (a fatura às vezes traz o da filial)
type cnpjAneel struct {
	base   *aneelBase
	raiz   map[string]string
	vistos map[string]string
}

func novoCNPJAneel(b *aneelBase) *cnpjAneel {
	c := &cnpjAneel{base: b, raiz: map[string]string{}, vistos: map[string]string{}}
	if b != nil {
		for _, t := range b.tarifas {
			if len(t.CNPJ) == 14 {
				if _, ok := c.raiz[t.CNPJ[:8]]; !ok || strings.HasSuffix(t.CNPJ[8:12], "0001") {
					c.raiz[t.CNPJ[:8]] = t.CNPJ
				}
			}
		}
	}
	return c
}

func (c *cnpjAneel) resolver(cn string) string {
	if len(cn) != 14 || c.base == nil {
		return cn
	}
	if r, ok := c.vistos[cn]; ok {
		return r
	}
	r := cn
	if len(c.base.daDistribuidora(cn)) == 0 {
		if m, ok := c.raiz[cn[:8]]; ok {
			r = m
		}
	}
	c.vistos[cn] = r
	return r
}

type itemFDE struct {
	Desc      string `json:"descricao"`
	Posto     any    `json:"posto"`
	Unidade   any    `json:"unidade"`
	CredGD    any    `json:"eh_credito_gd"`
	Qtd       any    `json:"quantidade_numerica"`
	Tarifa    any    `json:"tarifa_unit_numerica"`
	Valor     any    `json:"valor_brl_numerico"`
	TsemNum   any    `json:"tarifa_unit_aneel_numerica"`
	TsemStr   any    `json:"tarifa_unit_aneel"`
	TsemFonte string `json:"_tarifa_aneel_fonte"`
}

func carregarFaturasEnergia(db *sql.DB, cn *cnpjAneel, comItens bool) (map[string]*uFat, error) {
	return carregarFaturasEnergiaOnde(db, cn, comItens, "")
}

// carregarFaturasEnergiaOnde — idem, só com as faturas que passam no filtro extra (ex.: uma UC, para o dossiê)
func carregarFaturasEnergiaOnde(db *sql.DB, cn *cnpjAneel, comItens bool, onde string, args ...any) (map[string]*uFat, error) {
	if onde != "" {
		onde = " AND (" + onde + ")"
	}
	itens := `'[]'`
	if comItens {
		itens = `COALESCE(itens_cobrados,'[]')`
	}
	rows, err := db.Query(`SELECT id, COALESCE(NULLIF(TRIM(numero_instalacao),''), codigo_uc, ''), `+energiaMesSQL+`,
		UPPER(COALESCE(grupo_tarifario,'')), UPPER(COALESCE(subgrupo_tarifario,'')), COALESCE(modalidade_tarifaria,''),
		REGEXP_REPLACE(COALESCE(cnpj_distribuidora_filial,''),'[^0-9]',''),
		COALESCE(DATE_FORMAT(data_leitura_anterior,'%Y-%m-%d'),''), COALESCE(DATE_FORMAT(data_leitura_atual,'%Y-%m-%d'),''),
		COALESCE(pis_aliquota,0), COALESCE(cofins_aliquota,0), LEFT(REGEXP_REPLACE(COALESCE(cep_uc,''),'[^0-9]',''),5),
		UPPER(TRIM(COALESCE(classe_consumidor,''))), COALESCE(cip_iluminacao_publica_rs, valor_cip_cosip, 0),
		COALESCE(valor_total_fatura,0), COALESCE(kwh_total,0), `+itens+`,
		COALESCE(tipo_ligacao,''), COALESCE(numero_medidor,''), constante_k,
		leit_ant_ativa_fponta, leit_atu_ativa_fponta, leit_ant_ativa_ponta, leit_atu_ativa_ponta,
		leit_ant_reativa, leit_atu_reativa, leit_demanda_ponta, leit_demanda_fponta, fator_potencia,
		energia_injetada_kwh, energia_compensada_kwh,
		COALESCE(saldo_credito_energia, IF(saldo_gd_fponta_kwh IS NULL AND saldo_gd_ponta_kwh IS NULL, NULL,
			COALESCE(saldo_gd_fponta_kwh,0) + COALESCE(saldo_gd_ponta_kwh,0))), COALESCE(valor_total_sefaz,0),
		COALESCE(dias_faturados,0), COALESCE(indicacao_troca_medidor,0) = 1,
		(COALESCE(indicador_leitura_estimativa,0) = 1 OR COALESCE(flag_faturamento_media,0) = 1 OR COALESCE(indicacao_impedimento_leitura,0) = 1),
		COALESCE(fio_b_sefaz_rs,0), COALESCE(custo_disponib_sefaz_rs,0),
		COALESCE(demanda_contratada_ponta_kw,0), COALESCE(demanda_contratada_fponta_kw,0), COALESCE(indicador_leitura_real,0) = 1
		FROM FATURA_DADOS_EXTRAIDOS WHERE `+energiaFiltroEmpresa+` AND (`+energiaMesSQL+`) IS NOT NULL`+onde, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	fats := map[string]*uFat{}
	for rows.Next() {
		f := &uFat{}
		var pis, cof float64
		var cep, raw, medidor string
		var k, laFP, luFP, laP, luP, laR, luR, dP, dFP, fp, inj, comp, saldo sql.NullFloat64
		var cP, cFP float64
		if rows.Scan(&f.id, &f.chave, &f.mes, &f.grupo, &f.subgrupo, &f.modalidade, &f.cnpj, &f.lant, &f.latu,
			&pis, &cof, &cep, &f.classe, &f.cip, &f.total, &f.kwhRef, &raw,
			&f.fornecimento, &medidor, &k, &laFP, &luFP, &laP, &luP, &laR, &luR, &dP, &dFP, &fp, &inj, &comp, &saldo, &f.totalSefaz,
			&f.diasImpr, &f.trocaMed, &f.justLeitura, &f.fioBSefaz, &f.dispSefaz, &cP, &cFP, &f.leituraReal) != nil {
			continue
		}
		if cP > 0 || cFP > 0 { // demanda contratada (regras_extra.go: F23, F24, F26, F29)
			f.contr = map[string]float64{}
			if cP > 0 {
				f.contr["PONTA"] = cP
			}
			if cFP > 0 {
				f.contr["FORA_PONTA"] = cFP
			}
		}
		f.dias, f.dLant, f.dLatu = diasEntre(f.lant, f.latu), f.lant, f.latu // antes de qualquer ajuste das datas abaixo
		f.medidor = normNumMedidor(medidor)
		f.fornecimento = strings.ToUpper(f.fornecimento)
		// medições (registradores) no formato das usinas: ativa por posto, reativa, demanda e o fator de potência
		med := func(g, posto, unid string, a, b sql.NullFloat64) {
			if a.Valid || b.Valid {
				f.meds = append(f.meds, uMed{grandeza: g, posto: posto, medidor: medidor, unid: unid, lant: a, latu: b, k: k})
			}
		}
		med("ENERGIA ATIVA", "FORA_PONTA", "kWh", laFP, luFP)
		med("ENERGIA ATIVA", "PONTA", "kWh", laP, luP)
		med("ENERGIA REATIVA", "", "kvarh", laR, luR)
		for _, d := range []struct {
			p string
			v sql.NullFloat64
		}{{"PONTA", dP}, {"FORA_PONTA", dFP}} {
			if d.v.Valid {
				f.meds = append(f.meds, uMed{grandeza: "DEMANDA", posto: d.p, medidor: medidor, unid: "kW", cons: d.v})
			}
		}
		// 0,92 impresso é quase sempre o fator de REFERÊNCIA da distribuidora, não o medido
		if fp.Valid && fp.Float64 > 0 && fp.Float64 <= 1 && math.Abs(fp.Float64-0.92) > 0.0005 {
			f.meds = append(f.meds, uMed{grandeza: "FATOR DE POTENCIA", fp: fp})
		}
		for _, g := range []struct {
			t string
			v sql.NullFloat64
		}{{"injetada", inj}, {"compensada", comp}, {"saldo_atual", saldo}} {
			if g.v.Valid {
				f.gd = append(f.gd, uGD{tipo: g.t, kwh: g.v})
			}
		}
		f.cnpj = cn.resolver(f.cnpj)
		if len(cep) == 5 {
			f.cidade = "CEP " + cep // a FDE não tem o município da UC; o CEP de 5 dígitos fica dentro de um município
		}
		f.classe = strings.TrimSpace(strings.Split(f.classe, "/")[0])
		f.grupoInferido = f.subgrupo == "" && f.grupo == ""
		f.subgrupo = subgrupoAcer(f.subgrupo, f.grupo, f.classe)
		if f.grupo == "" && f.subgrupo != "" {
			f.grupo = f.subgrupo[:1]
		}
		if pis > 0 && cof > 0 && pis < 15 && cof < 15 {
			f.pisCofins = (pis + cof) / 100
		}
		if !datasCoerentes(f) { // datas lidas errado: o ciclo vira o mês anterior + o da conta (consumo costuma ser do anterior)
			if t, err := time.Parse("2006-01-02", f.mes+"-15"); err == nil {
				f.lant, f.latu = t.AddDate(0, -1, 0).Format("2006-01-02"), f.mes+"-15"
			}
		}
		if f.lant == "" && f.latu != "" { // ciclo sem leitura anterior: 30 dias antes da atual
			if t, err := time.Parse("2006-01-02", f.latu); err == nil {
				f.lant = t.AddDate(0, 0, -30).Format("2006-01-02")
			}
		}
		if comItens && len(raw) > 2 {
			var its []itemFDE
			_ = json.Unmarshal([]byte(raw), &its)
			vistos := map[string]bool{}
			for _, it := range its {
				x := uItem{unid: fmt.Sprint(it.Unidade)}
				x.qtd, x.valor, x.tarifa = numJSON(it.Qtd), numJSON(it.Valor), numJSON(it.Tarifa)
				cred, _ := it.CredGD.(bool)
				x.comp, x.posto, x.desc = itemEnergia(it.Desc, fmt.Sprint(it.Posto), fmt.Sprint(it.Unidade), cred, nv(x.valor))
				k := x.desc + "|" + fmt.Sprint(nv(x.qtd)) + "|" + fmt.Sprint(nv(x.valor))
				if vistos[k] { // o extrator às vezes repete a linha
					continue
				}
				vistos[k] = true
				if !strings.HasPrefix(it.TsemFonte, "fallback") {
					x.tsem = numJSON(it.TsemNum)
					if !x.tsem.Valid {
						x.tsem = numJSON(it.TsemStr)
					}
				}
				// "sem tributos" igual/maior que a com tributos (cópia) ou fora de escala: não é a tarifa sem tributos
				if x.tsem.Valid && ((x.tarifa.Valid && x.tarifa.Float64 > 0 && x.tsem.Float64 > x.tarifa.Float64*0.995) ||
					((x.comp == "TE" || x.comp == "BANDEIRA") && x.tsem.Float64 > 3) || x.tsem.Float64 <= 0) {
					x.tsem = sql.NullFloat64{}
				}
				if x.tsem.Valid && x.qtd.Valid && x.valor.Valid {
					ref := x.tarifa
					if !ref.Valid || ref.Float64 <= 0 {
						ref = x.tsem
					}
					if calc := ref.Float64 * x.qtd.Float64; calc <= 0 || math.Abs(calc-math.Abs(x.valor.Float64)) > 0.03*math.Abs(x.valor.Float64)+0.05 {
						x.tsem, x.tarifa = sql.NullFloat64{}, sql.NullFloat64{}
					}
				}
				// valor copiado da quantidade (campo trocado): vale quantidade × tarifa; sem tarifa, a linha não tem valor
				if x.valor.Valid && x.qtd.Valid && x.valor.Float64 == x.qtd.Float64 && x.qtd.Float64 > 1 {
					if x.tarifa.Valid && x.tarifa.Float64 > 0 && x.tarifa.Float64 < 5 {
						x.valor = sql.NullFloat64{Float64: rnd2(x.qtd.Float64 * x.tarifa.Float64), Valid: true}
					} else {
						x.valor = sql.NullFloat64{}
					}
				}
				if x.comp == "BANDEIRA" && x.valor.Valid && x.qtd.Valid && x.tarifa.Valid && x.tarifa.Float64 > 0 &&
					math.Abs(x.qtd.Float64*x.tarifa.Float64-x.valor.Float64) > 0.05*x.valor.Float64+0.05 {
					x.valor = sql.NullFloat64{} // bandeira com valor que não fecha: não acusa pela cor
				}
				f.itens = append(f.itens, x)
			}
		}
		conferirItensExtraidos(f)
		fats[f.id] = f
	}
	return fats, rows.Err()
}

// faixas de CEP por UF (início dos 5 dígitos)
var faixasCEP = []struct {
	de, ate int
	uf      string
}{
	{1000, 19999, "SP"}, {20000, 28999, "RJ"}, {29000, 29999, "ES"}, {30000, 39999, "MG"}, {40000, 48999, "BA"},
	{49000, 49999, "SE"}, {50000, 56999, "PE"}, {57000, 57999, "AL"}, {58000, 58999, "PB"}, {59000, 59999, "RN"},
	{60000, 63999, "CE"}, {64000, 64999, "PI"}, {65000, 65999, "MA"}, {66000, 68899, "PA"}, {68900, 68999, "AP"},
	{69000, 69299, "AM"}, {69300, 69399, "RR"}, {69400, 69899, "AM"}, {69900, 69999, "AC"}, {70000, 72799, "DF"},
	{72800, 72999, "GO"}, {73000, 73699, "DF"}, {73700, 76799, "GO"}, {76800, 76999, "RO"}, {77000, 77999, "TO"},
	{78000, 78899, "MT"}, {79000, 79999, "MS"}, {80000, 87999, "PR"}, {88000, 89999, "SC"}, {90000, 99999, "RS"},
}

func ufCEP(cidade string) string {
	n, err := strconv.Atoi(strings.TrimPrefix(cidade, "CEP "))
	if err != nil {
		return ""
	}
	for _, x := range faixasCEP {
		if n >= x.de && n <= x.ate {
			return x.uf
		}
	}
	return ""
}

// conferirCNPJPorUF — parte da base traz o CNPJ de outra distribuidora (ex.: fatura da CEEE/RS com o CNPJ da
// Equatorial Pará). O estado de cada CNPJ é o da maioria das UCs dele (pelo CEP); a fatura de outro estado fica
// sem CNPJ — sem distribuidora certa não há tarifa homologada a comparar.
func conferirCNPJPorUF(fats map[string]*uFat) {
	cont := map[string]map[string]int{}
	for _, f := range fats {
		if uf := ufCEP(f.cidade); uf != "" && len(f.cnpj) == 14 {
			if cont[f.cnpj] == nil {
				cont[f.cnpj] = map[string]int{}
			}
			cont[f.cnpj][uf]++
		}
	}
	dono := map[string]string{}
	for cn, m := range cont {
		tot, melhor, uf := 0, 0, ""
		for u, n := range m {
			tot += n
			if n > melhor {
				melhor, uf = n, u
			}
		}
		if tot >= 20 && float64(melhor) >= 0.6*float64(tot) {
			dono[cn] = uf
		}
	}
	for _, f := range fats {
		uf := ufCEP(f.cidade)
		if d, ok := dono[f.cnpj]; !ok || uf == "" || uf != d {
			f.cnpj = "" // CNPJ sem estado definido, fatura sem CEP ou de outro estado: não compara com a ANEEL
		}
	}
}

// datasCoerentes — as duas leituras com 10–70 dias de ciclo valem por si (o mês de referência é que às vezes vem
// errado na extração); só a leitura atual, sem a anterior, precisa estar perto do mês de referência (±75 dias)
func datasCoerentes(f *uFat) bool {
	if f.latu == "" {
		return false // sem leitura: o ciclo vira o mês anterior + o da conta
	}
	atu, err := time.Parse("2006-01-02", f.latu)
	if err != nil {
		return false
	}
	if f.lant != "" {
		ant, err := time.Parse("2006-01-02", f.lant)
		d := atu.Sub(ant).Hours() / 24
		return err == nil && d >= 10 && d <= 70
	}
	ref, err := time.Parse("2006-01-02", f.mes+"-15")
	return err == nil && math.Abs(atu.Sub(ref).Hours()/24) <= 75
}

// AplicarRegrasEnergia — achados das regras selecionadas no conjunto "energia", por id da fatura
func AplicarRegrasEnergia(db *sql.DB, sel map[string]bool) (map[string][]Achado, map[string]*uFat, error) {
	out := map[string][]Achado{}
	aneel := precisaAneel(sel)
	outras := false // regras só com a fatura / com o histórico da UC
	for c := range sel {
		if s := regrasSituacao[c]; regrasEnergia[c] && (s == "fatura" || s == "historico") {
			outras = true
		}
	}
	if !aneel && !outras && !sel["F51"] {
		return out, map[string]*uFat{}, nil
	}
	var base *aneelBase
	if aneel {
		var err error
		if base, err = baseAneel(db); err != nil {
			return nil, nil, err
		}
	}
	fats, err := carregarFaturasEnergia(db, novoCNPJAneel(base), (aneel && base != nil) || outras)
	if err != nil {
		return nil, nil, err
	}
	aplicarRegrasComuns(fats, sel, out)
	conferirCNPJPorUF(fats)
	if base != nil {
		for id, f := range fats {
			if a := regrasAneel(f, base, sel); len(a) > 0 {
				out[id] = append(out[id], a...)
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

// ---------------------------------------------------------------- resultado da aba

type EnergiaApontamento struct {
	ID            string    `json:"id"`
	CodEmpresa    int64     `json:"cod_empresa"`
	Empresa       string    `json:"empresa"`
	Distribuidora string    `json:"distribuidora"`
	UC            string    `json:"uc"`
	Mes           string    `json:"mes_referencia"`
	Fichas        []string  `json:"fichas"`       // regras com ERRO (motor + catálogo), fora as já rejeitadas
	Motor         []string  `json:"fichas_motor"` // as do motor F01–F05
	Alertas       []string  `json:"alertas,omitempty"`
	Achados       []Achado  `json:"achados,omitempty"`
	Detalhe       []string  `json:"detalhamento,omitempty"`
	ConsumoKWh    float64   `json:"consumo_kwh"`
	MediaKWh      float64   `json:"media_kwh"`
	ExcessoKWh    float64   `json:"excesso_kwh"`
	PrecoKWh      float64   `json:"preco_kwh"`
	DesvioPct     float64   `json:"desvio_pct"`
	F02Validacao  string    `json:"f02_validacao"`
	Classificacao string    `json:"classificacao_historico"`
	Forte         bool      `json:"forte"`
	EstimativaF02 float64   `json:"estimativa_f02"`
	EstAuditada   bool      `json:"estimativa_auditada"` // valor do F02 = o conferido (FATURA_APONTAMENTOS_AUDITADOS)
	ValorOutras   float64   `json:"valor_outras_regras"`
	Total         float64   `json:"total_a_pagar"`
	Link          string    `json:"link_fatura"`
	Verificado    bool      `json:"verificado"` // conferido pelo analista (aba Energia antiga)
	Observacao    string    `json:"observacao,omitempty"`
	Rejeitada     *Rejeicao `json:"rejeitada,omitempty"` // rejeição anterior (outras regras) — volta com a marca
}

type energiaResultado struct {
	Gerado       string               `json:"gerado_em"`
	Faturas      int                  `json:"faturas_analisadas"`
	UCs          int                  `json:"ucs_analisadas"`
	PorFicha     map[string]int       `json:"por_ficha"`
	PorAlerta    map[string]int       `json:"por_alerta"`
	Fortes       int                  `json:"f02_fortes"`
	Verificados  int                  `json:"verificados"`
	Reabertas    int                  `json:"reabertas"` // rejeitadas antes, com apontamento novo
	EstF02       float64              `json:"estimativa_f02"`
	EstOutras    float64              `json:"estimativa_outras_regras"`
	Selecionadas []string             `json:"regras_selecionadas"`
	AneelOK      bool                 `json:"aneel_importado"`
	Apontamentos []EnergiaApontamento `json:"apontamentos"`
}

var (
	energiaMu         sync.Mutex
	energiaCache      *energiaResultado
	energiaEm         time.Time
	energiaCalculando bool
	energiaErro       string
	energiaGeracao    int
)

// GET /api/v1/energia/apontamentos[?refresh=1] — cálculo em segundo plano (lê ~160 mil faturas e os itens):
// {"calculando":true} até ficar pronto; com resultado anterior devolve ele e recalcula atrás depois de 2 h.
func GetEnergiaApontamentos(c *gin.Context) {
	db, err := usinasDB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	energiaMu.Lock()
	defer energiaMu.Unlock()
	velho := energiaCache == nil || c.Query("refresh") == "1" || time.Since(energiaEm) > 2*time.Hour
	if velho && !energiaCalculando {
		energiaCalculando, energiaErro = true, ""
		if c.Query("refresh") == "1" {
			energiaCache = nil
		}
		ger := energiaGeracao
		go func() {
			sel, _ := selecaoRegras(db, "energia")
			r, err := CalcularEnergia(db, sel)
			energiaMu.Lock()
			defer energiaMu.Unlock()
			energiaCalculando = false
			if ger != energiaGeracao {
				return
			}
			if err != nil {
				energiaErro = err.Error()
				return
			}
			energiaCache, energiaEm = r, time.Now()
		}()
	}
	if energiaCache == nil {
		if energiaErro != "" {
			c.JSON(http.StatusInternalServerError, gin.H{"error": energiaErro})
			return
		}
		c.JSON(http.StatusAccepted, gin.H{"calculando": true})
		return
	}
	c.JSON(http.StatusOK, energiaCache)
}

// CalcularEnergia — motor F01–F05 + regras do conjunto "energia" + rejeições por regra
func CalcularEnergia(db *sql.DB, sel map[string]bool) (*energiaResultado, error) {
	motor, err := motorApontamentosCached(db, "", true)
	if err != nil {
		return nil, err
	}
	achados, fats, err := AplicarRegrasEnergia(db, sel)
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
	_ = db.QueryRow(`SELECT COUNT(*), COUNT(DISTINCT COALESCE(NULLIF(TRIM(numero_instalacao),''), codigo_uc)) FROM FATURA_DADOS_EXTRAIDOS WHERE `+
		energiaFiltroEmpresa).Scan(&out.Faturas, &out.UCs)

	idSet := map[string]bool{}
	for id := range motor {
		idSet[strconv.FormatInt(id, 10)] = true
	}
	for id := range achados {
		idSet[id] = true
	}
	ids := make([]string, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	rej := CarregarRejeicoes(db, ids)

	empresas := map[int64]string{}
	if er, err := db.Query(`SELECT cod_empresa, ANY_VALUE(nome_empresa) FROM DM_EMPRESA_PERCENTUAL GROUP BY cod_empresa`); err == nil {
		for er.Next() {
			var cod int64
			var n sql.NullString
			if er.Scan(&cod, &n) == nil {
				empresas[cod] = n.String
			}
		}
		er.Close()
	}

	type meta struct {
		x        EnergiaApontamento
		kwh, rsE float64
		aud      bool
		ress     sql.NullFloat64
		emProc   bool
	}
	metas := map[string]*meta{}
	for i := 0; i < len(ids); i += 1000 {
		fim := i + 1000
		if fim > len(ids) {
			fim = len(ids)
		}
		rows, err := db.Query(`SELECT f.id, COALESCE(f.cod_empresa,0), COALESCE(f.distribuidora,''),
			COALESCE(NULLIF(TRIM(f.numero_instalacao),''), f.codigo_uc, ''), COALESCE(` + strings.ReplaceAll(energiaMesSQL, "mes_referencia", "f.mes_referencia") + `,''),
			COALESCE(f.kwh_total,0), COALESCE(f.rs_kwh_total,0), COALESCE(f.valor_total_fatura,0), COALESCE(f.link_fatura,''),
			COALESCE(f.auditado,0) = 1, aa.ressarcimento_estimado, COALESCE(aa.observacao,''),
			EXISTS (SELECT 1 FROM FATURA_REANALISES r WHERE r.fatura_id = f.id AND r.recomendacao = 'JA_EM_PROCESSO')
			FROM FATURA_DADOS_EXTRAIDOS f LEFT JOIN FATURA_APONTAMENTOS_AUDITADOS aa ON aa.id = f.id
			WHERE f.id IN (` + strings.Join(ids[i:fim], ",") + `) AND COALESCE(f.cod_empresa,0) NOT IN (14, 2025)`)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			m := &meta{}
			if rows.Scan(&m.x.ID, &m.x.CodEmpresa, &m.x.Distribuidora, &m.x.UC, &m.x.Mes, &m.kwh, &m.rsE, &m.x.Total, &m.x.Link,
				&m.aud, &m.ress, &m.x.Observacao, &m.emProc) == nil {
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
		x.Fichas, x.Motor = []string{}, []string{} // [] no JSON, não null
		x.Empresa = empresas[x.CodEmpresa]
		x.ConsumoKWh = r2(m.kwh)
		r := rej[id]
		n, _ := strconv.ParseInt(id, 10, 64)
		if res, ok := motor[n]; ok && !m.emProc {
			for _, f := range res.FichasAplicadas {
				if sel[f] && (r == nil || !r.Regras[f]) {
					x.Motor = append(x.Motor, f)
				}
			}
			if len(x.Motor) > 0 {
				x.Fichas = append(x.Fichas, x.Motor...)
				x.Detalhe = append(x.Detalhe, res.Detalhamento...)
				x.DesvioPct, x.F02Validacao, x.Classificacao = r2(res.DesvioPctMax), res.F02Validacao, res.ClassificacaoHistorico
				if res.F02 && sel["F02"] && (r == nil || !r.Regras["F02"]) {
					x.Forte = res.ClassificacaoHistorico == "ELEVADO_REAL" && res.F02Validacao == "CONFIRMADO"
					if res.DesvioPctMax > 0 && m.kwh > 0 {
						x.MediaKWh = r2(m.kwh / (1 + res.DesvioPctMax/100))
						x.ExcessoKWh = r2(m.kwh - x.MediaKWh)
						if m.rsE > 0 {
							x.PrecoKWh = math.Round(m.rsE/m.kwh*100000) / 100000
							x.EstimativaF02 = r2(x.ExcessoKWh * x.PrecoKWh)
						}
					}
				}
				x.Verificado = m.aud && m.ress.Valid && m.ress.Float64 > 0
				if x.Verificado {
					x.EstimativaF02, x.EstAuditada = r2(m.ress.Float64), true
				}
			}
		}
		for _, a := range achados[id] {
			if r != nil && r.Regras[a.Codigo] {
				continue // o analista já rejeitou esta regra nesta fatura
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
		if f := fats[id]; f != nil && x.Distribuidora == "" {
			x.Distribuidora = f.cnpj
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
		if x.Verificado {
			out.Verificados++
		}
		out.EstF02 += x.EstimativaF02
		out.EstOutras += x.ValorOutras
		out.Apontamentos = append(out.Apontamentos, x)
	}
	out.EstF02, out.EstOutras = r2(out.EstF02), r2(out.EstOutras)
	sort.Slice(out.Apontamentos, func(i, j int) bool {
		a, b := out.Apontamentos[i], out.Apontamentos[j]
		if a.Verificado != b.Verificado {
			return a.Verificado
		}
		if a.Forte != b.Forte {
			return a.Forte
		}
		return a.EstimativaF02+a.ValorOutras > b.EstimativaF02+b.ValorOutras
	})
	return out, nil
}

func contem(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// energiaAplicarRejeicao — a fatura acabou de ser rejeitada: tira as regras rejeitadas do resultado em memória
// (sem recalcular as 160 mil faturas). Sem regras gravadas (NULL) vale o legado F01–F05.
func energiaAplicarRejeicao(id string, regras sql.NullString, usuario string) {
	energiaMu.Lock()
	defer energiaMu.Unlock()
	aplicarRejeicaoResultado(energiaCache, id, regras, usuario)
}

// aplicarRejeicaoResultado — tira do resultado em memória (Energia ou Acer) as regras rejeitadas da fatura
// (quem chama segura o mutex do cache)
func aplicarRejeicaoResultado(cache *energiaResultado, id string, regras sql.NullString, usuario string) {
	lst := regrasRejeicaoLegado
	if regras.Valid && regras.String != "" {
		lst = strings.Split(regras.String, ",")
	}
	rj := map[string]bool{}
	for _, c := range lst {
		rj[c] = true
	}
	tira := func(l []string) []string {
		var o []string
		for _, c := range l {
			if !rj[c] {
				o = append(o, c)
			}
		}
		return o
	}
	if cache == nil {
		return
	}
	lstOut := cache.Apontamentos[:0]
	for _, x := range cache.Apontamentos {
		if x.ID == id {
			x.Fichas, x.Motor, x.Alertas = tira(x.Fichas), tira(x.Motor), tira(x.Alertas)
			var as []Achado
			for _, a := range x.Achados {
				if !rj[a.Codigo] {
					as = append(as, a)
				}
			}
			x.Achados = as
			if len(x.Fichas) == 0 && len(x.Alertas) == 0 {
				continue
			}
			if x.Rejeitada == nil {
				x.Rejeitada = &Rejeicao{Regras: map[string]bool{}}
			}
			for c := range rj {
				if !x.Rejeitada.Regras[c] {
					x.Rejeitada.Regras[c] = true
					x.Rejeitada.Lista = append(x.Rejeitada.Lista, c)
				}
			}
			sort.Strings(x.Rejeitada.Lista)
			x.Rejeitada.Usuario, x.Rejeitada.Em = usuario, time.Now().Format("02/01/2006")
		}
		lstOut = append(lstOut, x)
	}
	cache.Apontamentos = lstOut
}

// limparCacheEnergia — seleção salva: a próxima leitura recalcula
func limparCacheEnergia() {
	energiaMu.Lock()
	energiaCache, energiaErro = nil, ""
	energiaGeracao++
	energiaMu.Unlock()
}
