package handlers

// =============================================================================
// regras_desvio.go — Módulo de REGRAS de Análise de Desvio (F01–F05)
//
// FILOSOFIA (decisão do produto):
//   - Este módulo REGISTRA e AVALIA as regras em código puro (sem query que
//     marca flag no banco). O backend LÊ a FATURA_DADOS_EXTRAIDOS, monta os
//     structs abaixo e chama AvaliarDesvio(). O resultado:
//       (a) alimenta o PROMPT (cada regra disparada vira texto/contexto);
//       (b) abastece os gráficos do front (Análise de Desvio).
//   - Nenhuma regra é aplicada via UPDATE direto no banco.
//
// PARÂMETROS (ajustáveis) e a semântica de cada ficha estão em RegistroRegras.
// =============================================================================

import (
	"fmt"
	"math"
	"strings"
)

// ---- Parâmetros configuráveis das regras -----------------------------------
const (
	F01TolPct   = 0.015 // tolerância relativa de 1,5% na comparação faturado vs calculado
	F01Perda    = 1.025 // fator de perda de transformação (2,5%)
	F01MaxDiv   = 0.50  // divergência > 50% = leitura corrompida na extração (não erro de fatura)
	F02AltoPct  = 1.00  // DESVIO_ALTO: >= 100% acima da média
	F02PicoPct  = 2.00  // PICO_OUTLIER: >= 200% acima da média
	F02MinKWh   = 50.0  // só considera meses com consumo > 50 kWh na média
	F02BaseMin  = 3     // base mínima de meses pra análise confiável
	F02JanelaM  = 12    // janela de meses do histórico
	F03SeqIgual = 4     // nº de faturas anteriores idênticas que caracteriza acúmulo
	// F03B — "piso ANTES do pico" (Art.113 clássico): detecta faturamento por
	// média/estimativa (piso 100/50/30 kWh repetido por ≥10 meses seguidos)
	// SEGUIDO de um pico F02 (catch-up). Padrão típico de cobrança irregular:
	// concessionária estima o mínimo por muitos meses e depois faz uma leitura
	// única cobrando tudo acumulado. Reduz falso positivo do F03 original (94%)
	// porque exige o par piso-longo + pico-após.
	F03BPisoMinSeq = 10  // nº de meses seguidos no piso ANTES do catch-up
	F03BJanelaPos  = 3   // pico deve vir dentro dessa janela após a sequência de piso
	// F03B leitura-confirmado (17/07/2026) — CERTEZA pelo medidor: um run de meses
	// faturados no piso onde o MEDIDOR NÃO ANDOU (leit_atu≈leit_ant = estimado),
	// fechado por um mês de catch-up com leitura real (delta grande) = faturamento
	// pela média com prova física. Independe de base anterior (pega UC piso-desde-o-início).
	F03BFloorMax    = 100.0 // mês faturado <= isso = piso/estimado
	F03BMeterStill  = 20.0  // avanço do medidor <= isso no mês = medidor não lido (estimado)
	F03BMinRunLeit  = 3     // meses de (piso + medidor parado) p/ configurar estimativa
	F03BCatchupMin  = 300.0 // catch-up: mês com delta do medidor >= isso (leitura real recuperando)
	F05TolUnid  = 2.0   // tolerância de 2 unidades na continuidade de leitura
	// Teto de sanidade do consumo por posto (kWh/mês). Acima disso = lixo de
	// extração (ex.: leitura concatenada caindo no campo consumo — id 273383
	// Energisa RO: 72 trilhões). Nenhuma UC real chega perto de 1 bilhão de kWh/mês.
	ConsumoMaxKWh = 1_000_000_000.0
)

// RegraF01Ativa — F01 ATIVO com tratamento (só divergência 1%–50%; >50% = leitura
// corrompida na extração → LeituraSuspeita, não conta). Aponta as divergências reais.
const RegraF01Ativa = true

// ---- Entradas ---------------------------------------------------------------

// PostoLeitura — dados de UM posto horário (Ponta, Fora Ponta, Reservado, Intermediário/Branca).
type PostoLeitura struct {
	Posto           string  // "P" | "FP" | "R" | "I"
	LeituraAnterior float64 // leitura do medidor no início do ciclo
	LeituraAtual    float64 // leitura do medidor no fim do ciclo
	Constante       float64 // K (multiplicador do medidor); default 1 se 0
	ConsumoFaturado float64 // kWh efetivamente faturado no posto
}

// FaturaDesvio — tudo que o motor precisa de UMA fatura pra avaliar as 5 regras.
// O backend preenche a partir das colunas da FATURA_DADOS_EXTRAIDOS + histórico.
type FaturaDesvio struct {
	ID             int64
	UC             string
	Concessionaria string
	Segmento       string // posto principal do consumo p/ F02/F04 (ex "FP")
	Medidor        string
	MedidorAnt     string  // medidor da fatura anterior (mesma UC/seg)
	LeitAnteriorAtual float64 // leitura ANTERIOR registrada na fatura ATUAL  (p/ F05)
	LeitAtualAnterior float64 // leitura ATUAL registrada na fatura ANTERIOR  (p/ F05)
	Postos         []PostoLeitura

	// agregados de histórico (calculados pelo backend antes de chamar)
	ConsumoAtual    float64   // consumo do segmento na fatura atual (p/ F02/F04)
	MediaHistorica  float64   // média dos últimos até 12 meses (> 50 kWh)
	BaseMeses       int       // nº de meses válidos na base
	Ultimas4Iguais  bool      // F03: 4 faturas anteriores idênticas (>0) E mês atual quebra a sequência pra cima (catch-up)
	MesConsecutivo  bool      // F05: a fatura anterior é o mês IMEDIATAMENTE anterior (sem buraco no histórico)

	// F05 — confiabilidade das leituras (preenchido pelo backend). Só aponta
	// quebra de continuidade se as leituras das DUAS faturas (atual e anterior)
	// fecham a própria fórmula (|atu−ant|×K ≈ consumo). Sem isso, a "quebra" é
	// só extração ruim: 83% dos F05 eram leitura que nem reconcilia com o consumo.
	LeituraAtualConfiavel bool
	LeituraAntConfiavel   bool

	// F01 — cross-check fiscal SEFAZ. Quando o SEFAZ confirma o consumo faturado
	// (SefazConfirmaConsumo=true), a conta está PROVADA fiscalmente: qualquer
	// divergência leitura×K vs faturado é erro de EXTRAÇÃO da leitura, não erro de
	// fatura → NÃO aponta F01. (Ex.: id 65233 Energisa MT — total faturado 747,02 =
	// SEFAZ 747,02; ponta fecha 0%; fora-ponta "diverge" 39% só por leitura mal lida.)
	SefazConfirmaConsumo bool

	// F01 — conta de consumo internamente coerente: a soma dos postos (ponta +
	// fora-ponta) fecha com o kwh_total faturado. Quando fecha, o consumo cobrado
	// está consistente e a divergência leitura×K vs faturado é limitação de EXTRAÇÃO
	// da leitura (não erro de fatura) → NÃO aponta F01. Motivo concreto: medidores MV
	// (ex.: ENEL SP A4 Verde) têm a fora-ponta em DOIS registradores (capacitivo +
	// indutivo); o motor lê só um → reconcilia ~76% e dispara F01 falso, embora
	// capacit.+indutivo somem exatamente o consumo faturado. Ver leituras da fatura
	// Einstein MAI/2019 (id 69235): FP capacit. 76.795,5 + indutivo 248.055,8 = 324.851,3.
	ContaConsumoCoerente bool

	// F02 — validação FORWARD: consumo das próximas faturas da UC (até 3). Um pico
	// só é anomalia ressarcível se as 3 seguintes VOLTARAM à média; se mantiveram
	// alto = ativação/novo patamar (não aponta). <3 faturas = inconclusivo (informa).
	ConsumoProximas []float64

	// F03B — "piso ANTES de pico" (Art.113): backend preenche APENAS para os
	// meses que fazem parte de uma sequência ≥ F03BPisoMinSeq no mesmo piso
	// (100/50/30 kWh) IMEDIATAMENTE ANTERIOR a um pico F02 (catch-up). Não são
	// os meses do próprio pico — são os meses de estimativa que antecedem.
	F03BEmSequenciaPiso bool    // este mês pertence a uma sequência de piso qualificada
	F03BPisoValor       float64 // valor do piso (100/50/30)
	F03BSeqTamanho      int     // tamanho total da sequência de piso à qual este mês pertence
	F03BPicoRefID       int64   // ID da fatura de PICO F02 que fecha a sequência (após o piso)
	F03BPicoRefMes      string  // mes_ref do pico de referência
}

// ---- Saída ------------------------------------------------------------------

type ResultadoDesvio struct {
	F01  bool `json:"flag_f01"`
	F02  bool `json:"flag_f02"`
	F03  bool `json:"flag_f03"`
	F03B bool `json:"flag_f03b"` // piso após pico (faturamento por média/estimativa)
	F04  bool `json:"flag_f04"`
	F05  bool `json:"flag_f05"`

	QtdRegras       int      `json:"qtd_regras"`
	FichasAplicadas []string `json:"fichas_aplicadas"`
	DesvioPctMax    float64  `json:"desvio_pct_max"` // desvio do segmento (%) — p/ gráfico/ordenação
	ClasseDesvio    string   `json:"classe_desvio"`  // "", "DESVIO_ALTO", "PICO_OUTLIER"
	F02Validacao    string   `json:"f02_validacao"`  // "CONFIRMADO" | "ATIVACAO" | "SEM_3_PROXIMAS" (validação forward)
	// ClassificacaoHistorico — advisory (não remove apontamento): rotula o F02 conforme
	// o próprio histórico da UC. "ELEVADO_REAL" (acima do histórico e sem padrão sazonal),
	// "DENTRO_DO_HISTORICO" (já atingiu esse patamar antes), "SAZONAL" (mesmo mês de outros
	// anos é alto — safra/entressafra). Ajuda o analista a triar; o front mostra o rótulo.
	ClassificacaoHistorico string `json:"classificacao_historico"`
	Detalhamento    []string `json:"detalhamento"`   // texto por ficha (vai pro prompt/front)
	PostosF01       []string `json:"postos_f01"`     // postos que divergiram em F01
	LeituraSuspeita bool     `json:"leitura_suspeita"` // F01 calc >50% off = leitura corrompida na extração (não é erro de fatura)
	// DetalhesF01: a "conta" de cada posto que disparou F01 — o front MOSTRA isso
	// (constante, leituras, calc vs faturado) + oferece o print da fatura p/ conferência humana.
	DetalhesF01 []DetalheFormulaF01 `json:"detalhes_f01"`
	// TemParcelamento: fatura tem item Art.113/RES.414 (consumo acumulado recuperado
	// em parcelas). Força apontamento F02 + aviso "sempre analisar" no front.
	TemParcelamento bool `json:"tem_parcelamento"`
}

// DetalheFormulaF01 — dados da fórmula de um posto, pra exibir no front (F01 = alerta a conferir).
type DetalheFormulaF01 struct {
	Posto           string  `json:"posto"`
	LeituraAnterior float64 `json:"leitura_anterior"`
	LeituraAtual    float64 `json:"leitura_atual"`
	Constante       float64 `json:"constante"`            // K
	CalcSemPerda    float64 `json:"calc_sem_perda"`       // |atu-ant| × K
	CalcComPerda    float64 `json:"calc_com_perda"`       // × 1,025
	ConsumoFaturado float64 `json:"consumo_faturado"`
	DivergenciaPct  float64 `json:"divergencia_pct"`      // menor div (%) vs faturado
	RequerPrint     bool    `json:"requer_print"`         // F01 é duvidoso → front oferece print da fatura
}

// ---- Avaliação das regras (puras, sem banco) --------------------------------

// AvaliarDesvio roda as 5 fichas sobre uma fatura e devolve o resultado consolidado.
// F02, F04 e F05 são INDEPENDENTES (uma não bloqueia a outra).
func AvaliarDesvio(f FaturaDesvio) ResultadoDesvio {
	var r ResultadoDesvio

	// ---- F01: divergência de fórmula, por posto (DESATIVADO — ver RegraF01Ativa) ----
	// TRATAMENTO: só aponta divergência PLAUSÍVEL (1%–50%). Acima de 50% = leitura
	// corrompida na extração (OCR/regex), não erro de fatura → marca LeituraSuspeita.
	for _, p := range f.Postos {
		if !RegraF01Ativa || f.SefazConfirmaConsumo || f.ContaConsumoCoerente {
			break // SEFAZ confirma OU postos somam o total → divergência leitura×K é
			// limitação de extração da leitura (ex.: FP em 2 registradores), não erro de fatura
		}
		if p.ConsumoFaturado <= 0 || p.LeituraAtual == p.LeituraAnterior {
			continue
		}
		k := p.Constante
		if k == 0 {
			k = 1
		}
		calc := math.Abs(p.LeituraAtual-p.LeituraAnterior) * k
		div := math.Min(
			math.Abs(p.ConsumoFaturado-calc)/p.ConsumoFaturado,
			math.Abs(p.ConsumoFaturado-calc*F01Perda)/p.ConsumoFaturado,
		)
		if div > F01TolPct && div <= F01MaxDiv {
			r.F01 = true
			r.PostosF01 = append(r.PostosF01, p.Posto)
			r.DetalhesF01 = append(r.DetalhesF01, DetalheFormulaF01{
				Posto: p.Posto, LeituraAnterior: p.LeituraAnterior, LeituraAtual: p.LeituraAtual,
				Constante: k, CalcSemPerda: round1(calc), CalcComPerda: round1(calc * F01Perda),
				ConsumoFaturado: p.ConsumoFaturado, DivergenciaPct: round1(div * 100), RequerPrint: true,
			})
		} else if div > F01MaxDiv {
			r.LeituraSuspeita = true
		}
	}
	if r.F01 {
		r.Detalhamento = append(r.Detalhamento,
			fmt.Sprintf("F01 - Divergência de fórmula (%s)", strings.Join(r.PostosF01, ", ")))
	}

	// ---- desvio (base de F02 e F04) ----
	desvioPct, classe := 0.0, ""
	if f.MediaHistorica > 0 && f.BaseMeses >= 1 {
		desvioPct = (f.ConsumoAtual - f.MediaHistorica) / f.MediaHistorica
		if desvioPct >= F02PicoPct {
			classe = "PICO_OUTLIER"
		} else if desvioPct >= F02AltoPct {
			classe = "DESVIO_ALTO"
		}
	}
	r.DesvioPctMax = round1(desvioPct * 100)
	r.ClasseDesvio = classe
	temDesvio := classe != "" && f.BaseMeses >= F02BaseMin // só acima; base mínima 3

	// ---- VALIDAÇÃO FORWARD (11/06/2026): um pico só é anomalia ressarcível se as
	// 3 faturas SEGUINTES voltaram à média. Se mantiveram alto = ativação/novo
	// patamar (não aponta). <3 faturas posteriores = inconclusivo (aponta, mas
	// sinaliza SEM_3_PROXIMAS p/ o operador ser informado). Corte = média entre
	// a média histórica e o consumo do pico.
	temDesvioEfetivo := temDesvio
	if temDesvio {
		if len(f.ConsumoProximas) >= 3 {
			soma := 0.0
			for _, v := range f.ConsumoProximas {
				soma += v
			}
			med3 := soma / float64(len(f.ConsumoProximas))
			if med3 >= (f.MediaHistorica+f.ConsumoAtual)/2 {
				r.F02Validacao = "ATIVACAO" // manteve alto → novo patamar, não anomalia
				temDesvioEfetivo = false
			} else {
				r.F02Validacao = "CONFIRMADO" // voltou à média → anomalia confirmada
			}
		} else {
			r.F02Validacao = "SEM_3_PROXIMAS" // recente: sem as 3 próximas p/ confirmar
		}
	}

	// ---- F02: desvio (INDEPENDENTE — vale em R e junto com F04/F05) ----
	if temDesvioEfetivo {
		r.F02 = true
		obs := ""
		if r.F02Validacao == "SEM_3_PROXIMAS" {
			obs = " — aguardando 3 próximas faturas p/ confirmar (anomalia x ativação)"
		}
		r.Detalhamento = append(r.Detalhamento,
			fmt.Sprintf("F02 - Desvio %.1f%% acima da média (%s)%s", r.DesvioPctMax, classe, obs))
	}

	// ---- F03: REMOVIDA (08/06/2026) ----
	// O detector "4 faturas anteriores idênticas" gerava ~94% de falsos positivos
	// (cliente estável / faturamento mínimo repetido, sem irregularidade). Mesmo
	// restrito ao mês de quebra pra cima sobrava ruído. Removida a pedido: o
	// acúmulo Art.113 real é capturado pelo desvio (F02) no mês do catch-up.

	// ---- F03B: "piso ANTES de pico" (Art.113) (08/07/2026) ----
	// Detecta faturamento por média/estimativa: sequência ≥ F03BPisoMinSeq meses
	// no piso (100/50/30 kWh) IMEDIATAMENTE ANTES de um pico F02 (catch-up).
	// Ao contrário do F03 antigo (94% falso positivo — apontava qualquer sequência
	// repetida), o F03B exige o PADRÃO COMPLETO piso-longo + pico-depois — filtra
	// clientes estáveis com consumo baixo natural. Backend preenche
	// F03BEmSequenciaPiso/F03BPicoRefID; motor só decide.
	if f.F03BEmSequenciaPiso && f.F03BPicoRefID > 0 && f.F03BPisoValor > 0 &&
		f.F03BSeqTamanho >= F03BPisoMinSeq {
		r.F03B = true
		r.Detalhamento = append(r.Detalhamento, fmt.Sprintf(
			"F03B - Faturamento por média (piso %.0f kWh em %d meses seguidos, catch-up na FDE#%d %s)",
			f.F03BPisoValor, f.F03BSeqTamanho, f.F03BPicoRefID, f.F03BPicoRefMes))
	}

	// ---- F04: troca de medidor + desvio (mesmo desvio do F02) ----
	if trocouMedidor(f.MedidorAnt, f.Medidor) && temDesvioEfetivo {
		r.F04 = true
		r.Detalhamento = append(r.Detalhamento,
			fmt.Sprintf("F04 - Troca de medidor: %s > %s (com desvio de consumo)", f.MedidorAnt, f.Medidor))
	}

	// ---- F05: quebra de continuidade (mesmo medidor, MESES CONSECUTIVOS, leituras não emendam) ----
	// MesConsecutivo evita falso positivo quando há buraco no histórico (a "quebra"
	// seria só a lacuna entre meses não adjacentes, não erro de leitura real).
	// GATE DE CONFIABILIDADE (11/06/2026): só aponta se as leituras das DUAS faturas
	// fecham a própria fórmula. 83% dos F05 eram leitura mal-extraída (não reconcilia
	// com o consumo da fatura) — comparar lixo entre meses não é "quebra".
	if !trocouMedidor(f.MedidorAnt, f.Medidor) && f.MedidorAnt != "" && f.MesConsecutivo &&
		f.LeituraAtualConfiavel && f.LeituraAntConfiavel &&
		quebraContinuidade(f.LeitAtualAnterior, f.LeitAnteriorAtual) {
		r.F05 = true
		r.Detalhamento = append(r.Detalhamento, "F05 - Quebra de continuidade de leitura")
	}

	// ---- consolidação ----
	for _, c := range []struct {
		cod string
		on  bool
	}{{"F01", r.F01}, {"F02", r.F02}, {"F03B", r.F03B}, {"F04", r.F04}, {"F05", r.F05}} {
		if c.on {
			r.FichasAplicadas = append(r.FichasAplicadas, c.cod)
		}
	}
	r.QtdRegras = len(r.FichasAplicadas)
	return r
}

// bateF01 — true se o faturado está dentro de F01TolPct (1%) do calculado.
func bateF01(faturado, calc float64) bool {
	if faturado == 0 {
		return math.Abs(calc) < 0.01
	}
	return math.Abs(faturado-calc)/math.Abs(faturado) <= F01TolPct
}

// leiturasFecham — true se |atu−ant|×K reconcilia com o consumo faturado (tol 5%,
// com e sem perda 2,5%). É o teste de confiabilidade da leitura usado pelo F05:
// se a leitura nem fecha a fórmula da própria fatura, não dá pra alegar quebra.
func leiturasFecham(lant, latu, k, consumo float64) bool {
	if lant == 0 || latu == 0 || consumo == 0 {
		return false
	}
	if k == 0 {
		k = 1
	}
	calc := math.Abs(latu-lant) * k
	return math.Abs(calc-consumo)/consumo <= 0.05 || math.Abs(calc*F01Perda-consumo)/consumo <= 0.05
}

// trocouMedidor — true se há medidor anterior válido E diferente do atual.
// normMedidor mantém só os dígitos e remove zeros à esquerda, pra comparar o
// medidor por IDENTIDADE FÍSICA (não por formatação). "00000292603" e "292603"
// viram "292603"; "LEGIAO"/"" (lixo/placeholder) viram "" (medidor não confiável).
func normMedidor(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return strings.TrimLeft(b.String(), "0")
}

func trocouMedidor(ant, atual string) bool {
	a := normMedidor(ant)
	b := normMedidor(atual)
	// Sem medidor numérico confiável em algum dos meses → NÃO afirma troca
	// (evita F04 falso por zeros à esquerda "00000292603"↔"292603" ou lixo "LEGIAO").
	if a == "" || b == "" {
		return false
	}
	return a != b
}

// quebraContinuidade — true se as leituras NÃO emendam, com tolerância de 2 unidades
// e aceitando equivalência por escala (×10 / ×100, erro de OCR). Ignora placeholders.
func quebraContinuidade(leitAtualAnt, leitAnteriorAtual float64) bool {
	if leitAtualAnt == 0 || leitAnteriorAtual == 0 {
		return false // placeholder/sem leitura → não aponta
	}
	if math.Abs(leitAtualAnt-leitAnteriorAtual) <= F05TolUnid {
		return false // emenda (dentro da tolerância)
	}
	// equivalência por escala (OCR): aceita ×10 e ×100 em qualquer direção
	for _, fator := range []float64{10, 100} {
		if math.Abs(leitAtualAnt*fator-leitAnteriorAtual) <= F05TolUnid ||
			math.Abs(leitAtualAnt-leitAnteriorAtual*fator) <= F05TolUnid {
			return false
		}
	}
	return true // não emenda de jeito nenhum → quebra
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

// ---- Catálogo declarativo (alimenta o prompt e a documentação do front) -----

type RegraInfo struct {
	Codigo    string `json:"codigo"`
	Nome      string `json:"nome"`
	Descricao string `json:"descricao"` // linguagem de negócio, pronta pro prompt
}

// RegistroRegras — as 5 regras registradas (sem aplicação direta no banco).
var RegistroRegras = []RegraInfo{
	{"F01", "Divergência de fórmula",
		"Para cada posto: |LeitAtual − LeitAnterior| × K vs consumo faturado (tol 1,5%); se não bate, recalcula com perda 2,5% (×1,025). Divergiu (1,5%–50%) → F01. Acima de 50% = leitura corrompida na extração (não conta)."},
	{"F02", "Desvio anormal de consumo",
		"Compara o consumo do mês com a média dos últimos até 12 meses (>50 kWh) da mesma UC/concessionária/segmento (base mínima 3 meses). Dispara somente ACIMA: DESVIO_ALTO ≥100% e PICO_OUTLIER ≥200%. Independente — vale inclusive no segmento Reservado e junto com F04/F05."},
	{"F03B", "Faturamento por média (piso antes de pico)",
		"Padrão Art.113: ≥10 meses seguidos cobrando o mesmo piso (100/50/30 kWh) IMEDIATAMENTE ANTES de um pico F02. Sinal claro de que a concessionária estimou o consumo por muito tempo e depois cobrou tudo acumulado no catch-up. Aponta cada mês da sequência de piso (o pico já é F02)."},
	{"F04", "Troca de medidor com inconsistência",
		"O medidor mudou em relação à fatura anterior E há desvio de consumo (mesmo desvio do F02). Pode coexistir com F02."},
	{"F05", "Quebra de continuidade de leitura",
		"Mesmo medidor, mas a leitura anterior da fatura atual não emenda com a leitura atual da fatura anterior (tolerância 2 unidades; aceita equivalência ×10/×100 por erro de OCR; ignora MED/0/vazio)."},
}
