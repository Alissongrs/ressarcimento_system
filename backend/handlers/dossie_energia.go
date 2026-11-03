package handlers

// Dossiê do apontamento de ENERGIA (abas Energia, Acer e Usinas da Auditoria de Faturas): um PDF por fatura
// apontada que explica ao time COMO o apontamento foi feito e O QUE foi pego:
//   - cabeçalho da fatura (UC, distribuidora, ciclo de leitura, grupo/classe, total) e a situação (erros/alertas,
//     rejeição, conferência);
//   - para cada regra apontada: o que foi encontrado (a conta com os números da fatura), como o sistema chegou
//     nisso (dados usados e o teste), o texto da regra no catálogo (interpretação, critérios, base legal, valor a
//     ressarcir) e o valor envolvido;
//   - o histórico de consumo da UC (gráfico + tabela), as leituras do medidor com a conta leitura × constante e
//     os itens da fatura;
//   - as PÁGINAS DA PRÓPRIA FATURA, com marca-texto amarelo nos valores citados (data/dossie_fatura_png.py,
//     PyMuPDF — o mesmo Python da extração);
//   - o que fazer agora (conferência visual e o que pedir à distribuidora).
// O apontamento vem do resultado já calculado da aba (cache); a fatura e o histórico são lidos do banco.
// Só leitura: não grava nada.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jung-kurt/gofpdf"
)

// dossieApont — o apontamento como a aba mostra (Energia, Acer ou Usinas), num formato só
type dossieApont struct {
	Base, ID, UC, Distribuidora, Empresa, Mes string
	Fichas, Motor, Alertas                    []string
	Achados                                   []Achado
	Detalhe                                   []string
	Consumo, Media, Excesso, Preco, Desvio    float64
	EstF02, Outras, Total                     float64
	F02Val, Classif, Observacao, Link         string
	Forte, Verificado, EstAuditada            bool
	CodEmpresa                                int64
	Rejeitada                                 *Rejeicao
}

var dossieBaseRotulo = map[string]string{"energia": "Energia", "acer": "Acer", "usinas": "Usinas"}

// apontamentoDoCache — o apontamento da fatura no resultado calculado da aba ("" = achou)
func apontamentoDoCache(base, id string) (*dossieApont, string) {
	conv := func(x EnergiaApontamento) *dossieApont {
		return &dossieApont{Base: base, ID: x.ID, UC: x.UC, Distribuidora: x.Distribuidora, Empresa: x.Empresa, Mes: x.Mes,
			Fichas: x.Fichas, Motor: x.Motor, Alertas: x.Alertas, Achados: x.Achados, Detalhe: x.Detalhe,
			Consumo: x.ConsumoKWh, Media: x.MediaKWh, Excesso: x.ExcessoKWh, Preco: x.PrecoKWh, Desvio: x.DesvioPct,
			EstF02: x.EstimativaF02, Outras: x.ValorOutras, Total: x.Total, F02Val: x.F02Validacao, Classif: x.Classificacao,
			Observacao: x.Observacao, Link: x.Link, Forte: x.Forte, Verificado: x.Verificado, EstAuditada: x.EstAuditada,
			Rejeitada: x.Rejeitada, CodEmpresa: x.CodEmpresa}
	}
	semCalculo := "o resultado da aba " + dossieBaseRotulo[base] + " ainda não foi calculado — abra a aba, espere carregar e tente de novo"
	switch base {
	case "energia":
		energiaMu.Lock()
		defer energiaMu.Unlock()
		if energiaCache == nil {
			return nil, semCalculo
		}
		for _, x := range energiaCache.Apontamentos {
			if x.ID == id {
				return conv(x), ""
			}
		}
	case "acer":
		acerPainelMu.Lock()
		defer acerPainelMu.Unlock()
		if acerPainelCache == nil {
			return nil, semCalculo
		}
		for _, x := range acerPainelCache.Apontamentos {
			if x.ID == id {
				return conv(x), ""
			}
		}
	case "usinas":
		usinasCacheMu.Lock()
		defer usinasCacheMu.Unlock()
		if usinasCache == nil {
			return nil, semCalculo
		}
		for _, x := range usinasCache.Apontamentos {
			if x.IDFatura == id {
				a := &dossieApont{Base: base, ID: x.IDFatura, UC: x.UC, Distribuidora: x.Distribuidora,
					Empresa: strings.TrimSpace(x.Usina + " · " + x.Titular), Mes: x.MesRef, Alertas: x.Alertas, Achados: x.Achados,
					Detalhe: x.Detalhe, Consumo: x.ConsumoKWh, Media: x.MediaKWh, Excesso: x.ExcessoKWh, Preco: x.PrecoKWh,
					Desvio: x.DesvioPct, EstF02: x.EstimativaBruta, Total: x.TotalAPagar, F02Val: x.F02Validacao,
					Classif: x.Classificacao, Link: x.Link, Forte: x.Forte}
				for _, f := range x.Fichas {
					if strings.HasPrefix(f, "F0") && f <= "F05" {
						a.Motor = append(a.Motor, f)
					}
				}
				a.Fichas = x.Fichas
				for _, ac := range x.Achados {
					if ac.Nivel == "ERRO" {
						a.Outras += ac.Valor
						if !contem(a.Fichas, ac.Codigo) {
							a.Fichas = append(a.Fichas, ac.Codigo)
						}
					}
				}
				return a, ""
			}
		}
	default:
		return nil, "base desconhecida"
	}
	return nil, "esta fatura não está entre os apontamentos atuais da aba (pode ter sido rejeitada ou a seleção de regras mudou)"
}

// faturaEHistorico — a fatura apontada e as faturas da mesma UC (para o gráfico e as tabelas)
func faturaEHistorico(db *sql.DB, base, id string) (*uFat, []*uFat, error) {
	var um map[string]*uFat
	var err error
	switch base {
	case "energia":
		um, err = carregarFaturasEnergiaOnde(db, novoCNPJAneel(nil), true, "id = ?", id)
	case "acer":
		um, err = carregarFaturasAcerOnde(db, "id = ?", id)
	case "usinas":
		um, err = carregarFaturasUsinasOnde(db, "f.id_fatura = ?", id)
	}
	if err != nil {
		return nil, nil, err
	}
	f := um[id]
	if f == nil {
		return nil, nil, errors.New("fatura não encontrada no banco")
	}
	var hist map[string]*uFat
	switch base {
	case "energia":
		hist, err = carregarFaturasEnergiaOnde(db, novoCNPJAneel(nil), false,
			"COALESCE(NULLIF(TRIM(numero_instalacao),''), codigo_uc, '') = ?", f.chave)
	case "acer":
		hist, err = carregarFaturasAcerOnde(db, "COALESCE(NULLIF(TRIM(numero_instalacao),''), codigo_uc, '') = ?", f.chave)
	case "usinas":
		hist, err = carregarFaturasUsinasOnde(db, usinaChaveUC+" = ?", f.chave)
	}
	var lst []*uFat
	if err == nil {
		for _, h := range hist {
			lst = append(lst, h)
		}
	}
	sort.Slice(lst, func(i, j int) bool {
		if lst[i].mes != lst[j].mes {
			return lst[i].mes < lst[j].mes
		}
		return lst[i].id == id // a apontada primeiro entre as do mesmo mês
	})
	// uma por mês (a apontada fica no mês dela); janela: 12 meses antes até 3 depois
	var out []*uFat
	vistos := map[string]bool{}
	for _, h := range lst {
		if vistos[h.mes] || h.mes < mesDesloc(f.mes, -12) || h.mes > mesDesloc(f.mes, 3) {
			continue
		}
		vistos[h.mes] = true
		out = append(out, h)
	}
	return f, out, nil
}

func mesDesloc(m string, n int) string {
	t, err := time.Parse("2006-01", m)
	if err != nil {
		return m
	}
	return t.AddDate(0, n, 0).Format("2006-01")
}

// ficha completa do catálogo (texto da regra)
func fichaCompleta(db *sql.DB, cod string) *fichaRegra {
	var f fichaRegra
	var interp, fat, crit, apl, leg sql.NullString
	if db.QueryRow(`SELECT codigo, nome, COALESCE(grupo,''), interpretacao, faturas_necessarias, criterios, aplicacao, base_legal
		FROM DM_FICHAS_REGRAS WHERE codigo = ?`, cod).Scan(&f.Codigo, &f.Nome, &f.Grupo, &interp, &fat, &crit, &apl, &leg) == nil {
		f.Interpretacao, f.FaturasNecess, f.Criterios, f.Aplicacao, f.BaseLegal = interp.String, fat.String, crit.String, apl.String, leg.String
		return &f
	}
	var seed []fichaRegra
	_ = json.Unmarshal(fichasSeedJSON, &seed)
	for i := range seed {
		if seed[i].Codigo == cod {
			return &seed[i]
		}
	}
	return nil
}

var reValorRessarcir = regexp.MustCompile(`(?s)\d+\.\s*Valor a ressarcir:?\s*(.*?)(?:\n\s*\d+\.\s|\z)`)

// regraComo — como o SISTEMA chegou no apontamento (dados usados e o teste), regra a regra
var regraComo = map[string]string{
	"F01":  "Para cada posto (ponta e fora ponta), o motor calcula (leitura atual − leitura anterior) × constante do medidor e compara com o consumo faturado do posto, com e sem 2,5% de perda de transformação. Aponta quando a diferença fica entre 1,5% e 50% (acima de 50% é leitura mal extraída, não erro da fatura). Não aponta quando a nota fiscal na SEFAZ confirma o consumo ou quando os postos somam o total faturado.",
	"F02":  "O motor compara o consumo do mês com a média da própria UC nos até 12 meses anteriores (só meses acima de 50 kWh; mínimo de 3 meses). Aponta a partir de 100% acima da média (200% ou mais = pico). Depois confere as 3 faturas SEGUINTES: se voltaram para perto da média, a anomalia está CONFIRMADA; se continuaram altas, é um novo patamar de consumo (não aponta); sem as 3 seguintes, fica aguardando. A estimativa é o excesso (consumo − média) × o preço médio do kWh da própria fatura.",
	"F03B": "O motor procura faturamento pelo mínimo/estimativa (piso de 100, 50 ou 30 kWh) repetido por 10 meses ou mais, seguido de um pico de consumo (a leitura real que cobra o acumulado de uma vez).",
	"F04":  "É o mesmo teste do F02 (consumo pelo menos 100% acima da média, confirmado pelas faturas seguintes), quando o número do medidor mudou em relação à fatura anterior — o pico veio junto com a troca do medidor.",
	"F05":  "Mesmo medidor, meses seguidos: a leitura anterior desta fatura deveria ser a leitura atual da fatura anterior (tolerância de 2 unidades). Só aponta quando as leituras das duas faturas fecham a própria conta (leitura × constante = consumo), para não confundir com leitura mal extraída.",
	"F06":  "A fatura não tem leitura de energia ativa, cobra mais que o mínimo (custo de disponibilidade: 30/50/100 kWh pelo tipo de ligação; Grupo A: qualquer consumo) e não indica média, estimativa ou impedimento de leitura. Só aponta quando outras faturas da mesma UC trazem a leitura. Fica em ALERTA: a leitura pode estar na fatura e só não ter sido extraída.",
	"F07":  "A leitura anterior está perto do máximo do mostrador (9.999 / 99.999 / 999.999…) e a atual perto de zero: o medidor virou. O consumo correto é (máximo + 1 − leitura anterior + leitura atual) × constante; aponta quando o faturado difere disso em mais de 1,5%.",
	"F08":  "Troca de medidor (o número mudou em relação à fatura anterior e continua o novo na seguinte, ou a fatura indica a troca). Com os dois medidores impressos, soma os dois trechos e compara com o faturado (1,5%); com só o novo, compara (leitura atual − inicial) × constante com o faturado e acusa consumo negativo.",
	"F13":  "A fatura não tem consumo ativo (nem compensação de geração) mas cobra reativo excedente — ou mostra demanda medida.",
	"F14":  "Num registrador de energia (não demanda), a leitura atual é menor que a anterior sem ser virada do mostrador.",
	"F15":  "Grupo A com fator de potência impresso de 0,92 ou mais e, mesmo assim, UFER (reativo excedente) cobrada.",
	"F17":  "UC do Grupo B com reativo excedente cobrado (só o Grupo A, ou o B optante, paga reativo).",
	"F27":  "UC do Grupo B com demanda cobrada (demanda é do Grupo A).",
	"F28":  "A tarifa sem tributos de TE e TUSD de cada item é comparada com a tarifa homologada pela ANEEL vigente no ciclo de leitura, para a distribuidora, o subgrupo e a modalidade da UC (com o PIS/COFINS da fatura quando a distribuidora imprime a tarifa sem ICMS, e 0,5% de folga de arredondamento).",
	"F33":  "Dias do ciclo = data da leitura atual − data da leitura anterior. Aponta abaixo de 15 dias (REN 1000, arts. 260 e 261). Na base extraída, só conta quando as datas batem com os dias impressos ou com a leitura da fatura anterior. Ficam de fora a 1ª fatura da UC (ligação nova), a última (encerramento), troca de medidor e mudança de grupo.",
	"F34":  "Dias do ciclo = data da leitura atual − data da leitura anterior. Aponta acima de 33 dias no Grupo B (34 é tolerado — muda só a forma de contar) ou de 47 dias em qualquer grupo. Mesmas exceções do F33; leitura por média no ciclo vira alerta.",
	"F35":  "Base das usinas: total a pagar × soma dos itens da fatura. Bases extraídas (Energia/Acer): total impresso × total da nota fiscal (NF3e) consultada na SEFAZ.",
	"F36":  "Em cada item, valor cobrado × quantidade × tarifa com tributos. Aponta a diferença acima de R$ 0,10 e de 0,1% do item (arredondamento da tarifa impressa). Na base extraída, diferenças de casa decimal ou de mais de 5% do item são descartadas (leitura errada) e o resto fica em alerta.",
	"F41":  "A cor da bandeira cobrada é comparada com a bandeira oficial da ANEEL nos meses do ciclo de leitura (qualquer dia do ciclo vale).",
	"F42":  "O valor da bandeira por kWh cobrado é comparado com o adicional homologado pela ANEEL para aquela cor no mês.",
	"F51":  "A CIP é lei municipal, sem base nacional: o sistema compara com as outras UCs do mesmo município (na base Energia: mesmo CEP de 5 dígitos), distribuidora, classe, grupo e mês. Os valores pagos por 2+ UCs formam os degraus da tabela; aponta quando 2+ UCs com consumo maior pagam um degrau MENOR (faixa trocada). Fica em alerta — sem a lei não dá para afirmar a faixa.",
	"F52":  "Duas ou mais linhas de CIP na mesma fatura com valores iguais (até 1%) e sem indicação de retroativo ou parcelamento.",
	"F53":  "A energia injetada do mês é comparada com a média dos 12 meses anteriores da UC (mínimo 3) e com o mesmo mês do ano anterior: aponta quando fica em 50% ou menos dos dois.",
	"F54":  "Saldo esperado = saldo anterior + injetada − compensada, comparado com o saldo de créditos impresso (tolerância de 1 kWh).",
	"F55":  "Havia saldo de créditos sobrando e, mesmo assim, o consumo líquido (consumo − compensado) ficou acima do mínimo faturável.",
	"F57":  "Fatura de GD do Grupo B com custo de disponibilidade E Fio B cobrados. Pela Lei 14.300 cobra-se só o maior entre a disponibilidade e (consumo não compensado × tarifa + Fio B); o outro é indevido.",
	"F58":  "Demanda de geração cobrada pela TUSD de consumo (TUSD C) e acima da TUSD G homologada pela ANEEL.",
}

// o que pedir à distribuidora, pelo grupo da regra no catálogo
var dossieInstrucoesGrupo = map[string][]string{
	"Medição": {
		"Pedir a revisão do faturamento do mês apontado com a memória de cálculo do consumo (leituras, constante, perdas).",
		"Se houve troca de medidor, pedir o termo de troca com as leituras de retirada e de instalação.",
		"Pedir o refaturamento pela leitura correta (ou pela média, se a leitura não for confiável) e a devolução do que foi pago a mais — em dobro quando o pagamento foi indevido (REN 1000, art. 323; CDC, art. 42).",
	},
	"Reativo/Demanda": {
		"Pedir a memória de cálculo do reativo/demanda (grandezas medidas, fator de potência por posto, demanda contratada).",
		"Contestar a cobrança indevida apontada e pedir o refaturamento com devolução do valor.",
	},
	"Período": {
		"Pedir a justificativa do ciclo de leitura fora do prazo (REN 1000, arts. 260 e 261) e o calendário de leitura da UC.",
		"Pedir o refaturamento proporcional aos dias corretos (custo de disponibilidade, faixas e bandeira) e a devolução da diferença.",
	},
	"Tributos/Itens": {
		"Pedir a memória de cálculo do item (quantidade, tarifa, base dos tributos) e a correção da diferença apontada.",
		"Se o total impresso diverge da nota fiscal, pedir a fatura corrigida e a devolução do que foi pago a mais.",
	},
	"Bandeiras": {
		"Pedir o refaturamento da bandeira pelos dias de cada cor no ciclo (ANEEL) e pelo adicional homologado, com devolução da diferença.",
	},
	"Encargos (CDE)": {"Pedir a correção do encargo pelo valor homologado e a devolução da diferença."},
	"CIP/COSIP": {
		"Conferir a faixa da CIP na lei do município (classe e consumo da UC).",
		"Se a faixa estiver errada ou a CIP em dobro, pedir a correção à distribuidora (que arrecada) e a devolução; a correção da faixa pode depender da prefeitura.",
	},
	"Geração Distribuída": {
		"Pedir o demonstrativo de compensação (injetada, compensada, saldo por posto e rateio entre UCs).",
		"Contestar a compensação ou a cobrança indevida apontada e pedir o refaturamento com o crédito correto.",
	},
}

// ---------------------------------------------------------------- fatura em imagem (com marca-texto)

func energiaHostPermitido(u *url.URL) bool {
	h := strings.ToLower(u.Hostname())
	return aguaPDFHosts[h] || h == "storage.googleapis.com" || h == "vtal.amee.com.br"
}

// baixarFaturaEnergia — o PDF da fatura (portal sgeeasy/sgevia, bucket ou VTAL); página com "1ª Fatura" → a 1ª
func baixarFaturaEnergia(link string) ([]byte, error) {
	get := func(raw string) ([]byte, error) {
		u, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || !energiaHostPermitido(u) {
			return nil, errors.New("link da fatura fora dos portais conhecidos")
		}
		resp, err := (&http.Client{Timeout: 60 * time.Second}).Get(u.String())
		if err != nil {
			return nil, errors.New("o portal da fatura não respondeu")
		}
		defer resp.Body.Close()
		return io.ReadAll(io.LimitReader(resp.Body, 30<<20))
	}
	body, err := get(link)
	if err != nil {
		return nil, err
	}
	if pdf := aguaComoPDF(body); pdf != nil {
		return pdf, nil
	}
	for _, m := range reDataSrc.FindAllSubmatch(body, -1) {
		if b, e := get(string(m[1])); e == nil {
			if pdf := aguaComoPDF(b); pdf != nil {
				return pdf, nil
			}
		}
	}
	return nil, errors.New("o portal não devolveu um PDF para esta fatura")
}

type paginasFatura struct {
	Paginas []string         `json:"paginas"`
	Achados map[string][]int `json:"achados"`
	Total   int              `json:"total_paginas"`
	Erro    string           `json:"erro"`
}

// renderizarFatura — páginas da fatura em PNG com os termos marcados (Python + PyMuPDF)
func renderizarFatura(pdf []byte, termos []string, dir string) (*paginasFatura, error) {
	py := os.Getenv("PYTHON_PATH")
	if py == "" {
		py = "python3"
	}
	script := os.Getenv("DOSSIE_RENDER_PATH")
	if script == "" {
		script = "/app/data/dossie_fatura_png.py"
		if _, err := os.Stat(script); err != nil {
			script = filepath.Join("data", "dossie_fatura_png.py") // rodando fora do container
		}
	}
	fPDF, fTermos := filepath.Join(dir, "fatura.pdf"), filepath.Join(dir, "termos.json")
	if err := os.WriteFile(fPDF, pdf, 0o600); err != nil {
		return nil, err
	}
	tj, _ := json.Marshal(termos)
	if err := os.WriteFile(fTermos, tj, 0o600); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, py, script, fPDF, filepath.Join(dir, "pg"), fTermos, "4", "110").Output()
	var r paginasFatura
	if e := json.Unmarshal(bytes.TrimSpace(out), &r); e != nil {
		if err != nil {
			return nil, fmt.Errorf("não consegui transformar a fatura em imagem: %v", err)
		}
		return nil, e
	}
	if r.Erro != "" {
		return nil, errors.New("não consegui abrir o PDF da fatura: " + r.Erro)
	}
	return &r, nil
}

var (
	reNumDec     = regexp.MustCompile(`\d[\d.]*\.\d{2}\b`)
	reNumInt     = regexp.MustCompile(`\b\d{4,}\b`)
	reDataDossie = regexp.MustCompile(`\b\d{2}/\d{2}/\d{4}\b`)
)

// termosMarcar — o que procurar na fatura para o marca-texto: total, consumo, datas e leituras, e os números
// citados nos achados (no texto do sistema os decimais vêm com ponto: 89.88 → "89,88" na fatura)
func termosMarcar(a *dossieApont, f *uFat) []string {
	vistos := map[string]bool{}
	var out []string
	add := func(t string) {
		t = strings.TrimSpace(t)
		if len(t) >= 3 && !vistos[t] && len(out) < 40 {
			vistos[t] = true
			out = append(out, t)
		}
	}
	addNum := func(v float64, casas int) {
		if v <= 0 {
			return
		}
		add(brNum(v, casas))
		if casas == 0 && v >= 1000 {
			add(strconv.FormatFloat(v, 'f', 0, 64)) // "1234" sem ponto de milhar
		}
	}
	addNum(f.total, 2)
	addNum(a.Consumo, 0)
	for _, d := range []string{f.dLant, f.dLatu} {
		if len(d) == 10 {
			add(br(d))
		}
	}
	for _, m := range f.meds {
		if registroAtivo(m) {
			if m.lant.Valid && m.lant.Float64 >= 100 {
				addNum(m.lant.Float64, 0)
			}
			if m.latu.Valid && m.latu.Float64 >= 100 {
				addNum(m.latu.Float64, 0)
			}
		}
	}
	textos := append([]string{}, a.Detalhe...)
	for _, ac := range a.Achados {
		textos = append(textos, ac.Detalhe)
	}
	for _, t := range textos {
		for _, d := range reDataDossie.FindAllString(t, -1) {
			add(d)
		}
		t = reDataDossie.ReplaceAllString(t, " ") // o ano das datas não é valor a marcar
		for _, n := range reNumDec.FindAllString(t, -1) {
			if v, err := strconv.ParseFloat(strings.ReplaceAll(n, ",", ""), 64); err == nil && v >= 1 {
				addNum(v, 2)
			}
		}
		for _, n := range reNumInt.FindAllString(t, -1) {
			if v, err := strconv.ParseFloat(n, 64); err == nil && !(v >= 1990 && v <= 2040) { // ano não
				addNum(v, 0)
			}
		}
	}
	if u := strings.TrimSpace(a.UC); len(u) >= 5 {
		add(u)
	}
	return out
}

// ---------------------------------------------------------------- o PDF

var dossieForaCP1252 = strings.NewReplacer("→", "->", "←", "<-", "≥", ">=", "≤", "<=", "−", "-", "≈", "~", "✓", "OK",
	"✗", "X", "⚠️", "", "⚠", "", "✅", "", "↩", "", "▸", ">", "…", "...")

func codigosOrdenados(a *dossieApont) (erros, alertas []string) {
	for _, c := range a.Fichas {
		if !contem(erros, c) {
			erros = append(erros, c)
		}
	}
	for _, c := range a.Alertas {
		if !contem(erros, c) && !contem(alertas, c) {
			alertas = append(alertas, c)
		}
	}
	return
}

func gerarDossieEnergiaPDF(db *sql.DB, a *dossieApont, f *uFat, hist []*uFat, pags *paginasFatura, motivoSemImagem string, termos []string) []byte {
	pdf := gofpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(14, 14, 14)
	pdf.SetAutoPageBreak(true, 16)
	cp := pdf.UnicodeTranslatorFromDescriptor("")
	tr := func(t string) string { return cp(dossieForaCP1252.Replace(t)) }
	pdf.SetFooterFunc(func() {
		pdf.SetY(-11)
		pdf.SetFont("Arial", "", 7)
		pdf.SetTextColor(120, 120, 120)
		pdf.CellFormat(0, 4, tr(fmt.Sprintf("SURE · Dossiê do apontamento (%s) · fatura %s · gerado em %s · página %d",
			dossieBaseRotulo[a.Base], a.ID, time.Now().Format("02/01/2006 15:04"), pdf.PageNo())), "", 0, "C", false, 0, "")
	})
	pdf.AddPage()
	const W = 182.0
	titulo := func(t string) {
		pdf.Ln(3)
		pdf.SetFont("Arial", "B", 10.5)
		pdf.SetTextColor(30, 58, 95)
		pdf.CellFormat(W, 6, tr(t), "B", 1, "L", false, 0, "")
		pdf.SetTextColor(0, 0, 0)
		pdf.Ln(1.5)
	}
	sub := func(t string) {
		pdf.Ln(0.8)
		pdf.SetFont("Arial", "B", 8.5)
		pdf.SetTextColor(70, 70, 70)
		pdf.CellFormat(W, 4.6, tr(t), "", 1, "L", false, 0, "")
		pdf.SetTextColor(0, 0, 0)
	}
	par := func(t string, tam float64) {
		pdf.SetFont("Arial", "", tam)
		pdf.MultiCell(W, tam*0.5, tr(t), "", "L", false)
	}

	// ---- cabeçalho
	pdf.SetFont("Arial", "B", 15)
	pdf.SetTextColor(30, 58, 95)
	pdf.CellFormat(W, 8, tr("Dossiê do apontamento — Energia"), "", 1, "L", false, 0, "")
	pdf.SetFont("Arial", "", 9.2)
	pdf.SetTextColor(60, 60, 60)
	ciclo := "datas de leitura não informadas"
	if f.dLant != "" && f.dLatu != "" {
		ciclo = fmt.Sprintf("leitura de %s a %s (%d dias", br(f.dLant), br(f.dLatu), f.dias)
		if f.diasImpr > 0 {
			ciclo += fmt.Sprintf("; %d impressos", f.diasImpr)
		}
		ciclo += ")"
	}
	grupo := strings.Trim(strings.Join([]string{f.subgrupo, f.classe, f.modalidade, strings.ToLower(f.fornecimento)}, " · "), " ·")
	if f.grupoInferido {
		grupo += " (grupo deduzido da classe)"
	}
	linhas := []string{
		fmt.Sprintf("Cliente: %s · Aba: %s", a.Empresa, dossieBaseRotulo[a.Base]),
		fmt.Sprintf("UC: %s · Distribuidora: %s", a.UC, a.Distribuidora),
		fmt.Sprintf("Mês de referência: %s · %s", mesBR(a.Mes), ciclo),
		fmt.Sprintf("Enquadramento: %s", map[bool]string{true: grupo, false: "não informado"}[grupo != ""]),
		fmt.Sprintf("Total a pagar: R$ %s · Medidor: %s · Fatura nº interno %s", brNum(f.total, 2), map[bool]string{true: f.medidor, false: "-"}[f.medidor != ""], a.ID),
	}
	pdf.MultiCell(W, 4.8, tr(strings.Join(linhas, "\n")), "", "L", false)
	pdf.SetTextColor(0, 0, 0)

	erros, alertas := codigosOrdenados(a)
	pdf.Ln(2)
	cor := [3]int{217, 119, 6}
	faixa := "  Situação: "
	if len(erros) > 0 {
		cor = [3]int{220, 38, 38}
		faixa += fmt.Sprintf("%d regra(s) com ERRO (%s)", len(erros), strings.Join(erros, ", "))
		if len(alertas) > 0 {
			faixa += fmt.Sprintf(" + %d alerta(s)", len(alertas))
		}
	} else {
		faixa += fmt.Sprintf("%d alerta(s) para conferir (%s)", len(alertas), strings.Join(alertas, ", "))
	}
	pdf.SetFillColor(cor[0], cor[1], cor[2])
	pdf.SetTextColor(255, 255, 255)
	pdf.SetFont("Arial", "B", 10.5)
	pdf.CellFormat(W, 8, tr(faixa), "", 1, "L", true, 0, "")
	pdf.SetTextColor(0, 0, 0)
	var notas []string
	if a.Forte {
		notas = append(notas, "F02 FORTE: o histórico confirma a anomalia (as faturas seguintes voltaram à média).")
	}
	if a.Verificado {
		notas = append(notas, "Fatura já conferida pelo analista (aba Energia)."+map[bool]string{true: " Observação: " + a.Observacao, false: ""}[a.Observacao != ""])
	}
	if a.Rejeitada != nil {
		notas = append(notas, fmt.Sprintf("Regras rejeitadas antes nesta fatura: %s (por %s em %s) — não entram aqui.", strings.Join(a.Rejeitada.Lista, ", "), a.Rejeitada.Usuario, a.Rejeitada.Em))
	}
	if len(notas) > 0 {
		pdf.Ln(1)
		par(strings.Join(notas, "\n"), 8.3)
	}

	// ---- resumo
	titulo("Resumo")
	kpis := [][2]string{{"Consumo do mês", brNum(a.Consumo, 0) + " kWh"}}
	if a.Media > 0 {
		kpis = append(kpis, [2]string{"Média histórica", brNum(a.Media, 0) + " kWh"},
			[2]string{"Acima da média", "+" + brNum(a.Desvio, 1) + "%"}, [2]string{"Excesso", brNum(a.Excesso, 0) + " kWh"})
	}
	if a.EstF02 > 0 {
		kpis = append(kpis, [2]string{"Estimativa do F02", "R$ " + brNum(a.EstF02, 2)})
	}
	if a.Outras > 0 {
		kpis = append(kpis, [2]string{"Outras regras (erros)", "R$ " + brNum(a.Outras, 2)})
	}
	kpis = append(kpis, [2]string{"Total a pagar", "R$ " + brNum(a.Total, 2)})
	cw := W / 3
	for i, k := range kpis {
		if i%3 == 0 && i > 0 {
			pdf.Ln(13)
		}
		x, y := 14+float64(i%3)*cw, pdf.GetY()
		pdf.SetDrawColor(220, 220, 220)
		pdf.Rect(x, y, cw-2, 12, "D")
		pdf.SetXY(x+2, y+1.5)
		pdf.SetFont("Arial", "", 7)
		pdf.SetTextColor(110, 110, 110)
		pdf.CellFormat(cw-4, 3.5, tr(strings.ToUpper(k[0])), "", 2, "L", false, 0, "")
		pdf.SetFont("Arial", "B", 11)
		pdf.SetTextColor(0, 0, 0)
		pdf.CellFormat(cw-4, 6, tr(k[1]), "", 0, "L", false, 0, "")
		pdf.SetXY(14, y)
	}
	pdf.Ln(14)
	fonte := "Os dados vêm da extração automática da fatura (base " + dossieBaseRotulo[a.Base] + ")."
	if f.variasFaturas {
		fonte += " ATENÇÃO: o PDF desta fatura parece trazer MAIS DE UMA FATURA e a extração juntou os itens das duas (a soma dos itens passa de 1,5× o total a pagar) — confira se cada linha citada é da fatura deste mês."
	} else if f.extraida && !f.itensOK {
		fonte += " Nesta fatura os itens extraídos NÃO fecham com o total a pagar — os valores por item são indicativos."
	}
	par("Como ler: ERRO = a regra se confirmou com os números da fatura; ALERTA = indício que precisa da conferência visual antes de virar pedido. "+
		fonte+" Toda conclusão deve ser conferida na fatura (páginas no fim deste dossiê, com os valores marcados em amarelo).", 7.6)

	// ---- regra a regra
	for _, grupoCod := range []struct {
		nivel string
		cods  []string
	}{{"ERRO", erros}, {"ALERTA", alertas}} {
		for _, cod := range grupoCod.cods {
			ficha := fichaCompleta(db, cod)
			nome := cod
			if ficha != nil {
				nome = cod + " — " + ficha.Nome
			}
			titulo(fmt.Sprintf("%s · %s", nome, grupoCod.nivel))
			sub("O que foi pego nesta fatura")
			var achou []string
			valor := 0.0
			for _, d := range a.Detalhe {
				if strings.HasPrefix(d, cod+" ") || strings.HasPrefix(d, cod+"-") || strings.HasPrefix(d, cod+" -") {
					achou = append(achou, d)
				}
			}
			for _, ac := range a.Achados {
				if ac.Codigo == cod {
					t := ac.Detalhe
					if ac.KWh > 0 {
						t += fmt.Sprintf(" [%s kWh envolvidos]", brNum(ac.KWh, 0))
					}
					achou = append(achou, t)
					valor += ac.Valor
				}
			}
			if cod == "F02" || cod == "F04" {
				if a.Media > 0 {
					achou = append(achou, fmt.Sprintf("Conta: consumo %s kWh × média histórica %s kWh = %s%% acima; excesso = %s − %s = %s kWh.",
						brNum(a.Consumo, 0), brNum(a.Media, 0), brNum(a.Desvio, 1), brNum(a.Consumo, 0), brNum(a.Media, 0), brNum(a.Excesso, 0)))
				}
				if a.F02Val != "" {
					v := map[string]string{"CONFIRMADO": "CONFIRMADO — as 3 faturas seguintes voltaram para perto da média",
						"SEM_3_PROXIMAS": "AGUARDANDO — ainda não há 3 faturas seguintes para confirmar", "ATIVACAO": "novo patamar de consumo"}[a.F02Val]
					if v == "" {
						v = a.F02Val
					}
					achou = append(achou, "Validação pelas faturas seguintes: "+v+".")
				}
				if a.Classif != "" {
					achou = append(achou, "Classificação pelo histórico: "+strings.ReplaceAll(a.Classif, "_", " ")+".")
				}
				if cod == "F02" && a.EstF02 > 0 {
					conta := fmt.Sprintf("Estimativa: R$ %s", brNum(a.EstF02, 2))
					if a.Preco > 0 && a.Excesso > 0 {
						conta += fmt.Sprintf(" (excesso %s kWh × R$ %s/kWh = R$ %s)", brNum(a.Excesso, 0), brNum(a.Preco, 4), brNum(a.Excesso*a.Preco, 2))
					}
					if a.EstAuditada {
						conta += " — valor já conferido na auditoria"
					}
					achou = append(achou, conta+".")
					valor = a.EstF02
				}
			}
			if len(achou) == 0 {
				achou = []string{"(sem detalhe registrado pelo motor)"}
			}
			for _, t := range achou {
				par("• "+t, 8.6)
			}
			if valor > 0 {
				pdf.SetFont("Arial", "B", 8.6)
				pdf.CellFormat(W, 5, tr("Valor envolvido: R$ "+brNum(valor, 2)), "", 1, "L", false, 0, "")
			}
			if como := regraComo[cod]; como != "" {
				sub("Como o sistema chegou nisso")
				par(como, 8.2)
			}
			if ficha != nil {
				if ficha.Interpretacao != "" {
					sub("O que a regra diz (catálogo)")
					par(ficha.Interpretacao, 7.8)
				}
				if ficha.Criterios != "" {
					sub("Critérios")
					par(ficha.Criterios, 7.8)
				}
				if m := reValorRessarcir.FindStringSubmatch(ficha.Aplicacao); m != nil {
					sub("Valor a ressarcir (catálogo)")
					par(strings.TrimSpace(m[1]), 7.8)
				}
				if ficha.FaturasNecess != "" {
					sub("Faturas necessárias")
					par(ficha.FaturasNecess, 7.8)
				}
				if ficha.BaseLegal != "" {
					sub("Base legal")
					par(ficha.BaseLegal, 7.8)
				}
			}
		}
	}

	// ---- histórico (página nova só se o gráfico não couber)
	if pdf.GetY() > 297-16-95 {
		pdf.AddPage()
	}
	titulo("Histórico de consumo da UC (kWh)")
	gerarGraficoEnergia(pdf, tr, a, hist, W)
	pdf.SetFont("Arial", "B", 8)
	pdf.SetFillColor(30, 58, 95)
	pdf.SetTextColor(255, 255, 255)
	cols := []float64{24, 30, 26, 22, 34, 46}
	for i, h := range []string{"Mês", "Consumo (kWh)", "Total (R$)", "Dias", "Leitura", "Observação"} {
		pdf.CellFormat(cols[i], 5.5, tr(h), "1", 0, "C", true, 0, "")
	}
	pdf.Ln(-1)
	pdf.SetTextColor(0, 0, 0)
	for _, h := range hist {
		apont := h.id == a.ID
		pdf.SetFont("Arial", map[bool]string{true: "B", false: ""}[apont], 7.8)
		if apont {
			pdf.SetFillColor(254, 226, 226)
		}
		nota := ""
		switch {
		case apont:
			nota = "FATURA APONTADA"
		case h.mes > a.Mes:
			nota = "depois da apontada"
		case h.justLeitura:
			nota = "extração: média/estim."
		}
		dias, leit := "-", "-"
		if h.dias > 0 {
			dias = fmt.Sprint(h.dias)
		}
		if h.dLatu != "" {
			leit = br(h.dLatu)
		}
		vals := []string{mesBR(h.mes), brNum(consumoFaturado(h), 0), brNum(h.total, 2), dias, leit, nota}
		for i, v := range vals {
			al := "R"
			if i == 0 || i >= 4 {
				al = "C"
			}
			pdf.CellFormat(cols[i], 5, tr(v), "1", 0, al, apont, 0, "")
		}
		pdf.Ln(-1)
	}
	if len(hist) == 0 {
		par("Sem outras faturas desta UC no banco.", 8.5)
	}

	// ---- leituras
	if len(f.meds) > 0 {
		titulo("Leituras do medidor nesta fatura")
		par("Conta de cada registrador: (leitura atual − leitura anterior) × constante. A última coluna é o consumo impresso, quando a fatura traz.", 7.6)
		pdf.Ln(1)
		mc := []float64{46, 22, 26, 24, 24, 16, 24}
		pdf.SetFont("Arial", "B", 7.5)
		pdf.SetFillColor(30, 58, 95)
		pdf.SetTextColor(255, 255, 255)
		for i, h := range []string{"Grandeza", "Posto", "Medidor", "Anterior", "Atual", "K", "(Atu−Ant)×K"} {
			pdf.CellFormat(mc[i], 5.5, tr(h), "1", 0, "C", true, 0, "")
		}
		pdf.Ln(-1)
		pdf.SetTextColor(0, 0, 0)
		pdf.SetFont("Arial", "", 7.3)
		for _, m := range f.meds {
			if m.fp.Valid && !m.lant.Valid && !m.latu.Valid && !m.cons.Valid {
				pdf.CellFormat(W, 5, tr(fmt.Sprintf("Fator de potência impresso: %s", brNum(m.fp.Float64, 3))), "1", 1, "L", false, 0, "")
				continue
			}
			num := func(x float64, ok bool, casas int) string {
				if !ok {
					return "-"
				}
				return brNum(x, casas)
			}
			calc := "-"
			if m.lant.Valid && m.latu.Valid {
				calc = brNum((m.latu.Float64-m.lant.Float64)*kMed(m), 0)
				if m.cons.Valid {
					calc += " / " + brNum(m.cons.Float64, 0)
				}
			} else if m.cons.Valid {
				calc = brNum(m.cons.Float64, 1) + " " + m.unid
			}
			g := m.grandeza
			if len(g) > 32 {
				g = g[:32]
			}
			md := m.medidor
			if len(md) > 16 {
				md = md[:16]
			}
			vals := []string{g, sem(m.posto), md, num(m.lant.Float64, m.lant.Valid, 0), num(m.latu.Float64, m.latu.Valid, 0), num(kMed(m), true, 4), calc}
			for i, v := range vals {
				al := "R"
				if i <= 2 {
					al = "L"
				}
				pdf.CellFormat(mc[i], 5, tr(v), "1", 0, al, false, 0, "")
			}
			pdf.Ln(-1)
		}
	}

	// ---- itens
	if len(f.itens) > 0 {
		titulo("Itens cobrados na fatura")
		ic := []float64{80, 24, 26, 28, 24}
		pdf.SetFont("Arial", "B", 7.5)
		pdf.SetFillColor(30, 58, 95)
		pdf.SetTextColor(255, 255, 255)
		for i, h := range []string{"Descrição", "Quantidade", "Tarifa (c/ trib.)", "Valor (R$)", "Componente"} {
			pdf.CellFormat(ic[i], 5.5, tr(h), "1", 0, "C", true, 0, "")
		}
		pdf.Ln(-1)
		pdf.SetTextColor(0, 0, 0)
		pdf.SetFont("Arial", "", 7.2)
		soma := 0.0
		for _, it := range f.itens {
			soma += nv(it.valor)
			d := it.desc
			if len(d) > 58 {
				d = d[:58]
			}
			q, t, v := "-", "-", "-"
			if it.qtd.Valid {
				q = brNum(it.qtd.Float64, 2)
			}
			if it.tarifa.Valid {
				t = brNum(it.tarifa.Float64, 6)
			}
			if it.valor.Valid {
				v = brNum(it.valor.Float64, 2)
			}
			comp := strings.ToLower(strings.ReplaceAll(it.comp, "_", " "))
			if it.comp == "TE" { // TE e TUSD ficam no mesmo componente; a marca na descrição diz qual é
				switch {
				case strings.HasPrefix(it.desc, "[TUSD]"):
					comp = "tusd"
				case strings.HasPrefix(it.desc, "[TE]"):
					comp = "te"
				default:
					comp = "energia"
				}
			}
			for i, x := range []string{d, q, t, v, comp} {
				al := "R"
				if i == 0 || i == 4 {
					al = "L"
				}
				pdf.CellFormat(ic[i], 4.8, tr(x), "1", 0, al, false, 0, "")
			}
			pdf.Ln(-1)
		}
		pdf.SetFont("Arial", "B", 7.6)
		fecha := "fecha com o total"
		if math.Abs(soma-f.total) > 0.10 {
			fecha = fmt.Sprintf("diferença de R$ %s para o total", brNum(f.total-soma, 2))
		}
		pdf.CellFormat(W, 5, tr(fmt.Sprintf("Soma dos itens: R$ %s × total a pagar R$ %s (%s)", brNum(soma, 2), brNum(f.total, 2), fecha)), "", 1, "L", false, 0, "")
		if f.totalSefaz > 0 {
			pdf.CellFormat(W, 5, tr("Total da nota fiscal na SEFAZ (NF3e): R$ "+brNum(f.totalSefaz, 2)), "", 1, "L", false, 0, "")
		}
	}

	// ---- o que fazer
	titulo("O que fazer agora")
	passos := []string{
		"Conferir na fatura (páginas a seguir) cada valor marcado em amarelo e o que este dossiê diz ter encontrado.",
		"Se a conferência confirmar, marcar como VERDADEIRO e criar a requisição; se for erro de leitura da extração, rejeitar a regra na aba (ela não volta).",
	}
	grupos := map[string]bool{}
	for _, c := range append(append([]string{}, erros...), alertas...) {
		if fc := fichaCompleta(db, c); fc != nil {
			grupos[fc.Grupo] = true
		}
	}
	gs := make([]string, 0, len(grupos))
	for g := range grupos {
		gs = append(gs, g)
	}
	sort.Strings(gs)
	for _, g := range gs {
		passos = append(passos, dossieInstrucoesGrupo[g]...)
	}
	for i, p := range passos {
		par(fmt.Sprintf("%d. %s", i+1, p), 8.8)
		pdf.Ln(0.6)
	}

	// ---- páginas da fatura
	pdf.AddPage()
	titulo("A fatura, com os valores do apontamento marcados")
	if pags == nil || len(pags.Paginas) == 0 {
		par("Não foi possível incluir as páginas da fatura: "+motivoSemImagem+".", 8.6)
		if a.Link != "" {
			par("Link/caminho da fatura: "+a.Link, 7.6)
		}
	} else {
		var achados, faltam []string
		for _, t := range termos {
			if ps, ok := pags.Achados[t]; ok {
				var pp []string
				for _, p := range ps {
					pp = append(pp, fmt.Sprint(p))
				}
				achados = append(achados, fmt.Sprintf("%s (pág. %s)", t, strings.Join(pp, ",")))
			} else {
				faltam = append(faltam, t)
			}
		}
		txt := "Marcados em amarelo: " + map[bool]string{true: strings.Join(achados, "; "), false: "nenhum dos valores foi achado no texto da fatura (fatura escaneada ou layout em imagem)"}[len(achados) > 0] + "."
		if len(faltam) > 0 {
			txt += " Não achados no texto (conferir na imagem): " + strings.Join(faltam, "; ") + "."
		}
		if pags.Total > len(pags.Paginas) {
			txt += fmt.Sprintf(" A fatura tem %d páginas; aqui vão as %d primeiras.", pags.Total, len(pags.Paginas))
		}
		par(txt, 7.8)
		for i, p := range pags.Paginas {
			info := pdf.RegisterImageOptions(p, gofpdf.ImageOptions{ImageType: "PNG"})
			if pdf.Err() || info == nil {
				pdf.ClearError()
				continue
			}
			if i > 0 || pdf.GetY() > 60 {
				pdf.AddPage()
			}
			w, h := info.Width(), info.Height()
			maxW, maxH := W, 297.0-pdf.GetY()-18
			esc := math.Min(maxW/w, maxH/h)
			pdf.ImageOptions(p, 14+(maxW-w*esc)/2, pdf.GetY(), w*esc, h*esc, false, gofpdf.ImageOptions{ImageType: "PNG"}, 0, "")
		}
		if a.Link != "" {
			pdf.Ln(2)
		}
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil
	}
	return buf.Bytes()
}

// gerarGraficoEnergia — barras do consumo mensal (apontada em vermelho) e a linha da média histórica
func gerarGraficoEnergia(pdf *gofpdf.Fpdf, tr func(string) string, a *dossieApont, hist []*uFat, W float64) {
	const H = 52.0
	x0, y0 := 28.0, pdf.GetY()+2
	gw := W - 16
	maxV := a.Media * 1.2
	for _, h := range hist {
		maxV = math.Max(maxV, consumoFaturado(h))
	}
	if maxV <= 0 || len(hist) == 0 {
		pdf.SetFont("Arial", "", 8.5)
		pdf.MultiCell(W, 5, tr("Sem histórico suficiente no banco para o gráfico."), "", "L", false)
		return
	}
	maxV *= 1.1
	yOf := func(v float64) float64 { return y0 + H - v/maxV*H }
	pdf.SetDrawColor(225, 225, 225)
	pdf.SetLineWidth(0.15)
	pdf.SetFont("Arial", "", 6.5)
	pdf.SetTextColor(120, 120, 120)
	for i := 0; i <= 4; i++ {
		v := maxV * float64(i) / 4
		pdf.Line(x0, yOf(v), x0+gw, yOf(v))
		pdf.SetXY(x0-14, yOf(v)-1.5)
		pdf.CellFormat(13, 3, brNum(v, 0), "", 0, "R", false, 0, "")
	}
	slot := gw / float64(len(hist))
	bw := slot * 0.62
	for i, h := range hist {
		v := consumoFaturado(h)
		x := x0 + float64(i)*slot + (slot-bw)/2
		switch {
		case h.id == a.ID:
			pdf.SetFillColor(220, 38, 38)
		case h.mes > a.Mes:
			pdf.SetFillColor(160, 174, 192)
		default:
			pdf.SetFillColor(43, 143, 214)
		}
		if v > 0 {
			pdf.Rect(x, yOf(v), bw, v/maxV*H, "F")
		}
		pdf.SetXY(x0+float64(i)*slot, y0+H+0.8)
		pdf.SetTextColor(90, 90, 90)
		pdf.CellFormat(slot, 3, h.mes[5:7]+"/"+h.mes[2:4], "", 0, "C", false, 0, "")
		if h.id == a.ID {
			pdf.SetXY(x0+float64(i)*slot-6, yOf(v)-3.6)
			pdf.SetFont("Arial", "B", 7)
			pdf.SetTextColor(220, 38, 38)
			pdf.CellFormat(slot+12, 3, brNum(v, 0), "", 0, "C", false, 0, "")
			pdf.SetFont("Arial", "", 6.5)
		}
	}
	if a.Media > 0 {
		pdf.SetLineWidth(0.4)
		pdf.SetDashPattern([]float64{1.6, 1.2}, 0)
		pdf.SetDrawColor(245, 158, 11)
		pdf.Line(x0, yOf(a.Media), x0+gw, yOf(a.Media))
		pdf.SetDrawColor(239, 68, 68)
		pdf.Line(x0, yOf(a.Media*2), x0+gw, yOf(a.Media*2))
		pdf.SetDashPattern([]float64{}, 0)
		pdf.SetLineWidth(0.2)
	}
	pdf.SetDrawColor(0, 0, 0)
	pdf.SetXY(x0, y0+H+5)
	pdf.SetFont("Arial", "", 7)
	leg := func(r, g, b int, txt string, linha bool) {
		x, y := pdf.GetX(), pdf.GetY()
		if linha {
			pdf.SetDrawColor(r, g, b)
			pdf.SetLineWidth(0.5)
			pdf.Line(x, y+1.6, x+5, y+1.6)
			pdf.SetLineWidth(0.2)
		} else {
			pdf.SetFillColor(r, g, b)
			pdf.Rect(x, y+0.4, 3, 2.6, "F")
		}
		pdf.SetX(x + 6)
		pdf.SetTextColor(60, 60, 60)
		pdf.CellFormat(pdf.GetStringWidth(tr(txt))+5, 3.4, tr(txt), "", 0, "L", false, 0, "")
	}
	leg(43, 143, 214, "meses anteriores", false)
	leg(220, 38, 38, "fatura apontada", false)
	leg(160, 174, 192, "meses seguintes", false)
	if a.Media > 0 {
		leg(245, 158, 11, "média "+brNum(a.Media, 0)+" kWh", true)
		leg(239, 68, 68, "2× a média (limite do F02)", true)
	}
	pdf.SetTextColor(0, 0, 0)
	pdf.SetDrawColor(0, 0, 0)
	pdf.SetXY(14, y0+H+11)
}

// GET /api/v1/dossie/:base/:id — PDF do dossiê do apontamento (base = energia | acer | usinas). Só leitura.
func GetDossieEnergia(c *gin.Context) {
	db, err := usinasDB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	out, nome, status, msg := montarDossieEnergia(db, c.Param("base"), strings.TrimSpace(c.Param("id")))
	if out == nil {
		c.JSON(status, gin.H{"error": msg})
		return
	}
	c.Header("Content-Disposition", "inline; filename="+nome)
	c.Data(http.StatusOK, "application/pdf", out)
}

// montarDossieEnergia — o PDF do dossiê e o nome do arquivo; sem PDF, o status HTTP e o motivo
func montarDossieEnergia(db *sql.DB, base, id string) ([]byte, string, int, string) {
	a, motivo := apontamentoDoCache(base, id)
	if a == nil {
		return nil, "", http.StatusConflict, motivo
	}
	f, hist, err := faturaEHistorico(db, base, id)
	if err != nil {
		return nil, "", http.StatusNotFound, err.Error()
	}
	if strings.TrimSpace(a.Empresa) == "" && a.CodEmpresa > 0 { // nome oficial do cliente pelo código
		var nome sql.NullString
		_ = db.QueryRow(`SELECT ANY_VALUE(nome_empresa) FROM DM_EMPRESA_PERCENTUAL WHERE cod_empresa = ?`, a.CodEmpresa).Scan(&nome)
		if !nome.Valid || strings.TrimSpace(nome.String) == "" {
			_ = db.QueryRow(`SELECT Rz_Social FROM Tab_Empresa WHERE Cod_Empresa = ? LIMIT 1`, a.CodEmpresa).Scan(&nome)
		}
		a.Empresa = strings.TrimSpace(nome.String)
		if a.Empresa == "" {
			a.Empresa = fmt.Sprintf("empresa %d", a.CodEmpresa)
		}
	}
	termos := termosMarcar(a, f)
	var pags *paginasFatura
	semImg := ""
	link := strings.TrimSpace(a.Link)
	switch {
	case link == "":
		semImg = "a fatura não tem link no banco"
	case strings.HasPrefix(link, "gdrive:"):
		semImg = "a fatura das usinas está no Google Drive (" + strings.TrimPrefix(link, "gdrive:") + "), que o servidor não acessa"
	default:
		if base == "acer" {
			link = strings.TrimSuffix(link, ".json") // o link da Acer é o JSON da extração; o PDF é o mesmo caminho sem .json
		}
		if pdfFat, e := baixarFaturaEnergia(link); e != nil {
			semImg = e.Error()
		} else if dir, e := os.MkdirTemp("", "dossie_"); e != nil {
			semImg = "sem pasta temporária"
		} else {
			defer os.RemoveAll(dir)
			if pags, e = renderizarFatura(pdfFat, termos, dir); e != nil {
				semImg = e.Error()
			}
		}
	}
	out := gerarDossieEnergiaPDF(db, a, f, hist, pags, semImg, termos)
	if out == nil {
		return nil, "", http.StatusInternalServerError, "falha ao gerar o PDF do dossiê"
	}
	return out, fmt.Sprintf("dossie_%s_%s_%s.pdf", base, reNaoAlnum.ReplaceAllString(strings.ToUpper(a.UC), ""), a.Mes), 0, ""
}

// anexarDossieEnergia grava na requisição recém-criada (FT_ANEXOS, id_processo = id da requisição) o dossiê
// do apontamento de energia de onde ela saiu. Roda em goroutine; dedup por nome; sem cálculo da aba, só registra
// no log (a requisição segue normal e o dossiê pode ser baixado depois pelo botão).
func anexarDossieEnergia(pid int, base, id string) {
	if pid <= 0 || strings.TrimSpace(id) == "" || dossieBaseRotulo[base] == "" {
		return
	}
	db, err := usinasDB()
	if err != nil {
		return
	}
	out, nome, _, msg := montarDossieEnergia(db, base, strings.TrimSpace(id))
	if out == nil {
		log.Printf("[dossie] requisição %d: dossiê %s/%s não anexado: %s", pid, base, id, msg)
		return
	}
	var existe int
	if db.QueryRow("SELECT 1 FROM FT_ANEXOS WHERE id_processo = ? AND nome_arquivo = ? LIMIT 1", pid, nome).Scan(&existe) == nil {
		return
	}
	if _, err := db.Exec(`INSERT INTO FT_ANEXOS
		(id_processo, nome_arquivo, caminho_arquivo, enviado_por, data_upload, mime_type, tamanho_bytes, arquivo_blob)
		VALUES (?, ?, '', 'gestor', NOW(), 'application/pdf', ?, ?)`, pid, nome, len(out), out); err != nil {
		log.Printf("[dossie] requisição %d: falha ao gravar o anexo: %v", pid, err)
		return
	}
	log.Printf("[dossie] requisição %d: dossiê %s anexado (%d bytes)", pid, nome, len(out))
}
