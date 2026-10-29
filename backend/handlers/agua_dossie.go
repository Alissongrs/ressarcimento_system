package handlers

// Dossiê do apontamento de água: um PDF por apontamento VERDADEIRO com cabeçalho, conta (consumo × média,
// excedente, ressarcimento), gráfico do histórico da UC, tabela mês a mês, veredito e observação da
// conferência visual e as instruções padrão pela causa. A fatura vai como anexo separado na requisição
// (gofpdf não incorpora outro PDF).

import (
	"bytes"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
	"github.com/jung-kurt/gofpdf"
)

// instruções padrão por causa da conferência — o que o analista pede à concessionária
var aguaInstrucoesCausa = map[string][]string{
	"CONSUMO_ALTO_MEDIDO": {
		"Pedir à concessionária a revisão da leitura do mês apontado e a aferição do hidrômetro.",
		"Contestar o volume acima do consumo esperado (excedente indicado neste dossiê), usando o gráfico e a tabela do histórico.",
		"Se a fatura trouxe aviso de alta de consumo, pedir o registro da vistoria feita (ou a realização dela).",
		"Atenção: se o cliente confirmar vazamento interno no imóvel, o consumo é dele. Nesse caso, pedir só a revisão por vazamento prevista no regulamento da concessionária, com o comprovante do conserto.",
	},
	"ERRO_CONCESSIONARIA": {
		"Pedir o refaturamento da conta pelo volume e valor corretos descritos na conferência abaixo.",
		"Indicar na fatura anexa o ponto do erro (leitura, tipo de faturamento — média, estimativa ou mínimo —, faixas ou compensação).",
		"Pedir a devolução do valor pago a mais ou o crédito nas próximas faturas; havendo pagamento indevido, pedir a devolução em dobro (CDC, art. 42, parágrafo único).",
	},
	"TROCA_HIDROMETRO": {
		"Pedir a ordem de serviço da troca do hidrômetro, com a leitura de retirada do antigo e a leitura inicial do novo.",
		"Conferir se o volume cobrado bate com (leitura de retirada − última leitura faturada) + (leitura atual do novo − leitura inicial).",
		"Se o consumo subiu depois da troca, pedir a aferição do hidrômetro novo.",
		"Pedir o refaturamento da diferença e a devolução do que foi pago a mais.",
	},
	"VAZAMENTO": {
		"Pedir a revisão da conta por vazamento conforme o regulamento da concessionária (redução ou cobrança pela média).",
		"Juntar o comprovante do conserto (nota, foto ou laudo) com a data.",
		"Se o vazamento foi no ramal ou no cavalete (lado da concessionária), pedir o refaturamento integral pela média.",
	},
	"MINIMO_ECONOMIAS": {
		"Confirmar com o cliente quantas economias (unidades) existem de fato no imóvel.",
		"Se o cadastro da concessionária tem mais economias que o real, pedir a correção do cadastro e o refaturamento dos meses cobrados pelo mínimo a mais.",
		"Pedir a devolução do que foi pago a mais.",
	},
}

var aguaCausaRotulo = map[string]string{
	"CONSUMO_ALTO_MEDIDO": "Consumo alto medido",
	"ERRO_CONCESSIONARIA": "Erro da concessionária",
	"TROCA_HIDROMETRO":    "Troca de hidrômetro",
	"VAZAMENTO":           "Vazamento",
	"MINIMO_ECONOMIAS":    "Mínimo por economias — verificar cadastro",
}

var aguaFichaRotulo = map[string]string{
	"FA02": "FA02 — pico de consumo (consumo de 1,8× ou mais o esperado pela média por dia da UC)",
	"FA05": "FA05 — cobrança sem medição (mesmo m³ cobrado por vários meses, acima do normal)",
}

// caracteres que a fonte padrão (cp1252) não tem e aparecem nas observações da conferência
var aguaSemForaCP1252 = strings.NewReplacer("→", "->", "←", "<-", "≥", ">=", "≤", "<=", "−", "-", "≈", "~", "✓", "OK", "✗", "X")

var reDataSrc = regexp.MustCompile(`data-src=['"]([^'"]+)['"]`)

// baixarFaturasAgua busca os PDFs da fatura nos portais conhecidos. Quando o sgeeasy devolve a página
// "1º Fatura / 2º Fatura" em vez do PDF, devolve todas na ordem da página: na conferência de 28/10 a 1ª
// era a do mês em ~85% dos casos e a 2ª (refaturamento ou fatura de outro mês) no resto — não dá para
// escolher pelo nome do arquivo, então quem decide é o analista vendo as duas.
func baixarFaturasAgua(link string) ([][]byte, error) {
	get := func(raw string) ([]byte, error) {
		u, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || !aguaHostPermitido(u) {
			return nil, errors.New("link de fatura fora dos portais conhecidos")
		}
		resp, err := (&http.Client{Timeout: 60 * time.Second}).Get(u.String())
		if err != nil {
			return nil, errors.New("portal da fatura não respondeu")
		}
		defer resp.Body.Close()
		return io.ReadAll(io.LimitReader(resp.Body, 30<<20))
	}
	body, err := get(link)
	if err != nil {
		return nil, err
	}
	if pdf := aguaComoPDF(body); pdf != nil {
		return [][]byte{pdf}, nil
	}
	var pdfs [][]byte
	for _, m := range reDataSrc.FindAllSubmatch(body, -1) {
		if b, e := get(string(m[1])); e == nil {
			if pdf := aguaComoPDF(b); pdf != nil {
				pdfs = append(pdfs, pdf)
			}
		}
	}
	if len(pdfs) == 0 {
		return nil, errors.New("o portal não devolveu um PDF para esta fatura")
	}
	return pdfs, nil
}

// aguaComoPDF aceita o que os portais devolvem: PDF puro, PDF precedido do tamanho em texto
// (sgevia manda "466311%PDF...") ou a fatura escaneada em JPG/PNG, que vira um PDF de 1 página.
func aguaComoPDF(b []byte) []byte {
	if i := bytes.Index(b[:min(len(b), 64)], []byte("%PDF")); i >= 0 {
		return b[i:]
	}
	tipo := ""
	switch {
	case bytes.HasPrefix(b, []byte{0xFF, 0xD8}):
		tipo = "JPG"
	case bytes.HasPrefix(b, []byte{0x89, 'P', 'N', 'G'}):
		tipo = "PNG"
	default:
		return nil
	}
	pdf := gofpdf.New("P", "mm", "A4", "")
	info := pdf.RegisterImageOptionsReader("fatura", gofpdf.ImageOptions{ImageType: tipo}, bytes.NewReader(b))
	if pdf.Err() || info == nil {
		return nil
	}
	w, h := info.Width(), info.Height()
	pdf.AddPageFormat("P", gofpdf.SizeType{Wd: w, Ht: h})
	pdf.ImageOptions("fatura", 0, 0, w, h, false, gofpdf.ImageOptions{ImageType: tipo}, 0, "")
	var out bytes.Buffer
	if pdf.Output(&out) != nil {
		return nil
	}
	return out.Bytes()
}

func aguaHostPermitido(u *url.URL) bool {
	h := strings.ToLower(u.Hostname())
	if aguaPDFHosts[h] {
		return true
	}
	// PDFs do sgeeasy servidos direto do bucket
	return h == "storage.googleapis.com" && strings.HasPrefix(u.Path, "/sge-clientes/")
}

type aguaDossieDados struct {
	id, codEmp, codUC, nMeses                                       int64
	uc, conc, mes, ficha, link, cidade, uf, cliente                 string
	consumo, esperado, desvio, base, ress, exced                    float64
	veredito, causa, obs, evidencia, aviso, conferidoPor, conferido string
	hist                                                            []aguaDossieMes
}

type aguaDossieMes struct {
	mes            string
	consumo, valor float64
	dias           int
}

func carregarDossieAgua(sqlDB *sql.DB, id string) (*aguaDossieDados, error) {
	d := &aguaDossieDados{}
	var uc, conc, mes, ficha, link, cidade, uf, cliente, ver, causa, obs, evid, aviso, por, em sql.NullString
	var consumo, esperado, desvio, base, ress, exced sql.NullFloat64
	err := sqlDB.QueryRow(`SELECT a.id, a.cod_empresa, a.cod_uc, a.n_meses, a.uc, a.concessionaria,
	       DATE_FORMAT(a.mes_referencia,'%Y-%m'), a.ficha, TRIM(a.link_fatura), d.cidade, d.uf,
	       COALESCE(te.Rz_Social, CONCAT('Empresa ', a.cod_empresa)),
	       a.consumo_m3, a.mediana_m3, a.desvio_pct, a.base_rs, a.ressarcimento_estimado, a.excedente_m3,
	       cf.veredito, cf.causa, cf.observacao, cf.evidencia, cf.texto_aviso, cf.conferido_por,
	       DATE_FORMAT(cf.conferido_em,'%d/%m/%Y')
	     FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS a
	     LEFT JOIN FATURA_AGUA_CONFERENCIA cf ON cf.id = a.id
	     LEFT JOIN FATURA_AGUA_DADOS d ON d.cod_empresa = a.cod_empresa AND d.cod_uc = a.cod_uc AND d.mes_referencia = a.mes_referencia
	     LEFT JOIN Tab_Empresa te ON te.Cod_Empresa = a.cod_empresa
	     WHERE a.id = ? LIMIT 1`, id).Scan(&d.id, &d.codEmp, &d.codUC, &d.nMeses, &uc, &conc, &mes, &ficha, &link, &cidade, &uf,
		&cliente, &consumo, &esperado, &desvio, &base, &ress, &exced, &ver, &causa, &obs, &evid, &aviso, &por, &em)
	if err != nil {
		return nil, err
	}
	d.uc, d.conc, d.mes, d.ficha, d.link = uc.String, conc.String, mes.String, ficha.String, link.String
	d.cidade, d.uf, d.cliente = cidade.String, uf.String, cliente.String
	d.consumo, d.esperado, d.desvio, d.base, d.ress = consumo.Float64, esperado.Float64, desvio.Float64, base.Float64, ress.Float64
	d.exced = consumo.Float64 - esperado.Float64
	if exced.Valid { // gravado pela conferência quando o excedente não é consumo − esperado (ex.: cobrado − medido)
		d.exced = exced.Float64
	}
	d.veredito, d.causa, d.obs, d.evidencia, d.aviso = ver.String, causa.String, obs.String, evid.String, aviso.String
	d.conferidoPor, d.conferido = por.String, em.String
	// janela do gráfico: 12 meses antes do apontado até 3 depois
	rows, err := sqlDB.Query(`SELECT DATE_FORMAT(mes_referencia,'%Y-%m'), COALESCE(consumo_m3,0), COALESCE(rs_total_fat,0),
	       COALESCE(DATEDIFF(dt_leitura_atual, dt_leitura_anterior),0)
	     FROM FATURA_AGUA_DADOS WHERE cod_empresa=? AND cod_uc=?
	       AND mes_referencia BETWEEN DATE_SUB(STR_TO_DATE(CONCAT(?,'-01'),'%Y-%m-%d'), INTERVAL 12 MONTH)
	                              AND DATE_ADD(STR_TO_DATE(CONCAT(?,'-01'),'%Y-%m-%d'), INTERVAL 3 MONTH)
	     ORDER BY mes_referencia`, d.codEmp, d.codUC, d.mes, d.mes)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var m aguaDossieMes
			if rows.Scan(&m.mes, &m.consumo, &m.valor, &m.dias) == nil {
				d.hist = append(d.hist, m)
			}
		}
	}
	return d, nil
}

func brNum(v float64, casas int) string {
	s := fmt.Sprintf("%.*f", casas, v)
	inteiro, frac := s, ""
	if i := strings.Index(s, "."); i >= 0 {
		inteiro, frac = s[:i], s[i+1:]
	}
	neg := strings.HasPrefix(inteiro, "-")
	inteiro = strings.TrimPrefix(inteiro, "-")
	var b strings.Builder
	for i, r := range inteiro {
		if i > 0 && (len(inteiro)-i)%3 == 0 {
			b.WriteByte('.')
		}
		b.WriteRune(r)
	}
	out := b.String()
	if frac != "" {
		out += "," + frac
	}
	if neg {
		out = "-" + out
	}
	return out
}

func mesBR(m string) string { // "2023-07" → "07/2023"
	if len(m) >= 7 {
		return m[5:7] + "/" + m[:4]
	}
	return m
}

func gerarDossieAguaPDF(d *aguaDossieDados) []byte {
	pdf := gofpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(14, 14, 14)
	pdf.SetAutoPageBreak(true, 16)
	cp := pdf.UnicodeTranslatorFromDescriptor("") // cp1252 p/ acentos
	tr := func(t string) string { return cp(aguaSemForaCP1252.Replace(t)) }
	pdf.SetFooterFunc(func() {
		pdf.SetY(-11)
		pdf.SetFont("Arial", "", 7)
		pdf.SetTextColor(120, 120, 120)
		pdf.CellFormat(0, 4, tr(fmt.Sprintf("SURE · Dossiê do apontamento de água #%d · gerado em %s · página %d",
			d.id, time.Now().Format("02/01/2006 15:04"), pdf.PageNo())), "", 0, "C", false, 0, "")
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
	par := func(t string, tam float64) {
		pdf.SetFont("Arial", "", tam)
		pdf.MultiCell(W, 4.4, tr(t), "", "L", false)
	}

	// cabeçalho
	pdf.SetFont("Arial", "B", 15)
	pdf.SetTextColor(30, 58, 95)
	pdf.CellFormat(W, 8, tr("Dossiê do apontamento — Água"), "", 1, "L", false, 0, "")
	pdf.SetFont("Arial", "", 9.5)
	pdf.SetTextColor(60, 60, 60)
	local := strings.Trim(d.cidade+"/"+d.uf, "/")
	pdf.MultiCell(W, 5, tr(fmt.Sprintf("Cliente: %s\nUC: %s · Concessionária: %s%s\nMês de referência: %s · %s",
		d.cliente, d.uc, d.conc, map[bool]string{true: " · " + local, false: ""}[local != ""], mesBR(d.mes), aguaFichaRotulo[d.ficha])), "", "L", false)
	pdf.SetTextColor(0, 0, 0)

	// faixa do veredito
	pdf.Ln(2)
	cor := map[string][3]int{"VERDADEIRO": {31, 157, 107}, "FALSO": {220, 38, 38}}[d.veredito]
	if cor == [3]int{} {
		cor = [3]int{107, 114, 128}
	}
	pdf.SetFillColor(cor[0], cor[1], cor[2])
	pdf.SetTextColor(255, 255, 255)
	pdf.SetFont("Arial", "B", 11)
	rot := d.veredito
	if c := aguaCausaRotulo[d.causa]; c != "" {
		rot += " — " + c
	}
	pdf.CellFormat(W, 8, tr("  Veredito da conferência visual: "+rot), "", 1, "L", true, 0, "")
	pdf.SetTextColor(0, 0, 0)

	// a conta
	titulo("A conta")
	exced := d.exced
	if exced < 0 {
		exced = 0
	}
	kpis := [][2]string{
		{"Consumo do mês", brNum(d.consumo, 0) + " m³"},
		{"Consumo esperado", brNum(d.esperado, 1) + " m³"},
		{"Acima do esperado", "+" + brNum(d.desvio, 1) + "%"},
		{"Excedente", brNum(exced, 1) + " m³"},
		{"Valor da fatura", "R$ " + brNum(d.base, 2)},
		{"Ressarcimento estimado", "R$ " + brNum(d.ress, 2)},
	}
	cw := W / 3
	for i, k := range kpis {
		x := 14 + float64(i%3)*cw
		if i%3 == 0 && i > 0 {
			pdf.Ln(13)
		}
		y := pdf.GetY()
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
	par(fmt.Sprintf("Consumo esperado = média de consumo por dia dos %d meses anteriores com medição × dias de leitura desta fatura. "+
		"Ressarcimento estimado = valor da fatura × excedente ÷ consumo do mês (estimativa; o valor exato sai do recálculo pelas faixas da tarifa).", d.nMeses), 7.5)

	// gráfico
	titulo("Histórico de consumo da UC (m³)")
	gerarGraficoAgua(pdf, tr, d, W)

	// tabela
	pdf.SetFont("Arial", "B", 8)
	pdf.SetFillColor(30, 58, 95)
	pdf.SetTextColor(255, 255, 255)
	cols := []float64{30, 30, 30, 40, 52}
	for i, h := range []string{"Mês", "Consumo (m³)", "Dias de leitura", "Valor da fatura (R$)", "Observação"} {
		pdf.CellFormat(cols[i], 5.5, tr(h), "1", 0, "C", true, 0, "")
	}
	pdf.Ln(-1)
	pdf.SetTextColor(0, 0, 0)
	for _, m := range d.hist {
		apont := m.mes == d.mes
		pdf.SetFont("Arial", map[bool]string{true: "B", false: ""}[apont], 8)
		if apont {
			pdf.SetFillColor(254, 226, 226)
		}
		nota := ""
		switch {
		case apont:
			nota = "MÊS APONTADO"
		case m.consumo == 0:
			nota = "sem m³ no banco"
		case m.mes > d.mes:
			nota = "depois do apontado"
		}
		dias := "-"
		if m.dias > 0 {
			dias = fmt.Sprint(m.dias)
		}
		vals := []string{mesBR(m.mes), brNum(m.consumo, 0), dias, brNum(m.valor, 2), nota}
		for i, v := range vals {
			al := "R"
			if i == 0 || i == 4 {
				al = "C"
			}
			pdf.CellFormat(cols[i], 5, tr(v), "1", 0, al, apont, 0, "")
		}
		pdf.Ln(-1)
	}

	// conferência
	titulo("O que a conferência visual da fatura encontrou")
	if d.obs != "" {
		par(d.obs, 8.5)
	} else {
		par("Sem observação registrada.", 8.5)
	}
	if d.aviso != "" {
		pdf.Ln(1)
		par("Aviso impresso na fatura: \""+d.aviso+"\"", 8.5)
	}
	if d.conferidoPor != "" {
		pdf.Ln(1)
		pdf.SetTextColor(110, 110, 110)
		par("Conferido por: "+d.conferidoPor+map[bool]string{true: " em " + d.conferido, false: ""}[d.conferido != ""], 7.5)
		pdf.SetTextColor(0, 0, 0)
	}

	// instruções
	titulo("O que pedir à concessionária")
	inst := aguaInstrucoesCausa[d.causa]
	if len(inst) == 0 {
		inst = aguaInstrucoesCausa["ERRO_CONCESSIONARIA"]
	}
	for i, t := range inst {
		par(fmt.Sprintf("%d. %s", i+1, t), 9)
		pdf.Ln(0.8)
	}
	if strings.Contains(d.obs, "CASO ÚNICO") || strings.Contains(d.obs, "O QUE O ANALISTA FAZ") {
		pdf.Ln(0.5)
		par("Este apontamento tem orientação específica na conferência acima (\"O QUE O ANALISTA FAZ\" / \"CASO ÚNICO\"): ela prevalece sobre as instruções padrão.", 8.5)
	}

	// fatura
	titulo("Fatura")
	par("A fatura do mês apontado segue como anexo separado da requisição (fatura_agua_<UC>_<mês>.pdf).", 8.5)
	if d.link != "" {
		par("Link: "+d.link, 7.5)
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil
	}
	return buf.Bytes()
}

// gerarGraficoAgua desenha barras do consumo mensal, a linha do consumo esperado e a do limiar 1,8×.
func gerarGraficoAgua(pdf *gofpdf.Fpdf, tr func(string) string, d *aguaDossieDados, W float64) {
	const H = 52.0
	x0, y0 := 26.0, pdf.GetY()+2
	gw := W - 14
	maxV := d.esperado * 1.8
	for _, m := range d.hist {
		if m.consumo > maxV {
			maxV = m.consumo
		}
	}
	if maxV <= 0 || len(d.hist) == 0 {
		pdf.SetFont("Arial", "", 8.5)
		pdf.MultiCell(W, 5, tr("Sem histórico suficiente no banco para o gráfico."), "", "L", false)
		return
	}
	maxV *= 1.1
	yOf := func(v float64) float64 { return y0 + H - v/maxV*H }

	// eixo e grade
	pdf.SetDrawColor(225, 225, 225)
	pdf.SetLineWidth(0.15)
	pdf.SetFont("Arial", "", 6.5)
	pdf.SetTextColor(120, 120, 120)
	for i := 0; i <= 4; i++ {
		v := maxV * float64(i) / 4
		y := yOf(v)
		pdf.Line(x0, y, x0+gw, y)
		pdf.SetXY(x0-12, y-1.5)
		pdf.CellFormat(11, 3, brNum(v, 0), "", 0, "R", false, 0, "")
	}
	// barras
	n := float64(len(d.hist))
	slot := gw / n
	bw := slot * 0.62
	for i, m := range d.hist {
		x := x0 + float64(i)*slot + (slot-bw)/2
		switch {
		case m.mes == d.mes:
			pdf.SetFillColor(220, 38, 38)
		case m.mes > d.mes:
			pdf.SetFillColor(160, 174, 192)
		default:
			pdf.SetFillColor(43, 143, 214)
		}
		if m.consumo > 0 {
			pdf.Rect(x, yOf(m.consumo), bw, m.consumo/maxV*H, "F")
		}
		pdf.SetXY(x0+float64(i)*slot, y0+H+0.8)
		pdf.SetTextColor(90, 90, 90)
		pdf.CellFormat(slot, 3, m.mes[5:7]+"/"+m.mes[2:4], "", 0, "C", false, 0, "")
		if m.mes == d.mes {
			pdf.SetXY(x0+float64(i)*slot-4, yOf(m.consumo)-3.6)
			pdf.SetFont("Arial", "B", 7)
			pdf.SetTextColor(220, 38, 38)
			pdf.CellFormat(slot+8, 3, brNum(m.consumo, 0), "", 0, "C", false, 0, "")
			pdf.SetFont("Arial", "", 6.5)
		}
	}
	// linhas de referência
	pdf.SetLineWidth(0.4)
	pdf.SetDashPattern([]float64{1.6, 1.2}, 0)
	pdf.SetDrawColor(245, 158, 11)
	pdf.Line(x0, yOf(d.esperado), x0+gw, yOf(d.esperado))
	pdf.SetDrawColor(239, 68, 68)
	pdf.Line(x0, yOf(d.esperado*1.8), x0+gw, yOf(d.esperado*1.8))
	pdf.SetDashPattern([]float64{}, 0)
	pdf.SetLineWidth(0.2)
	pdf.SetDrawColor(0, 0, 0)

	// legenda
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
	leg(220, 38, 38, "mês apontado", false)
	leg(160, 174, 192, "meses seguintes", false)
	leg(245, 158, 11, "consumo esperado "+brNum(d.esperado, 1)+" m³", true)
	leg(239, 68, 68, "limiar 1,8× "+brNum(d.esperado*1.8, 1)+" m³", true)
	pdf.SetTextColor(0, 0, 0)
	pdf.SetDrawColor(0, 0, 0)
	pdf.SetXY(14, y0+H+11)
}

// GET /api/v1/faturas/agua/:id/dossie — PDF do dossiê (só para apontamento conferido como VERDADEIRO).
func GetAguaDossie(c *gin.Context) {
	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	d, err := carregarDossieAgua(sqlDB, c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "apontamento não encontrado"})
		return
	}
	if d.veredito != "VERDADEIRO" {
		c.JSON(http.StatusConflict, gin.H{"error": "dossiê só sai para apontamento conferido como VERDADEIRO (este está " +
			map[bool]string{true: d.veredito, false: "sem conferência"}[d.veredito != ""] + ")"})
		return
	}
	out := gerarDossieAguaPDF(d)
	if out == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao gerar o PDF do dossiê"})
		return
	}
	c.Header("Content-Disposition", fmt.Sprintf("inline; filename=dossie_agua_%s_%s.pdf", strings.TrimSpace(d.uc), d.mes))
	c.Data(http.StatusOK, "application/pdf", out)
}

// anexarDossieAgua grava na requisição recém-criada o dossiê e a fatura do apontamento de água
// (FT_ANEXOS, id_processo = id da requisição). Roda em goroutine; só para VERDADEIRO; dedup por nome.
func anexarDossieAgua(pid int, aguaID string) {
	if database.GormDB_App == nil || strings.TrimSpace(aguaID) == "" {
		return
	}
	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		return
	}
	d, err := carregarDossieAgua(sqlDB, aguaID)
	if err != nil || d.veredito != "VERDADEIRO" {
		return
	}
	uc := strings.TrimSpace(d.uc)
	anexar := func(nome string, data []byte) {
		if len(data) < 500 {
			return
		}
		var existe int
		if sqlDB.QueryRow("SELECT 1 FROM FT_ANEXOS WHERE id_processo = ? AND nome_arquivo = ? LIMIT 1", pid, nome).Scan(&existe) == nil {
			return
		}
		_, _ = sqlDB.Exec(`INSERT INTO FT_ANEXOS
			(id_processo, nome_arquivo, caminho_arquivo, enviado_por, data_upload, mime_type, tamanho_bytes, arquivo_blob)
			VALUES (?, ?, '', 'gestor', NOW(), 'application/pdf', ?, ?)`, pid, nome, len(data), data)
	}
	anexar(fmt.Sprintf("dossie_agua_%s_%s.pdf", uc, d.mes), gerarDossieAguaPDF(d))
	if d.link != "" {
		if fs, e := baixarFaturasAgua(d.link); e == nil {
			for i, f := range fs {
				nome := fmt.Sprintf("fatura_agua_%s_%s.pdf", uc, d.mes)
				if len(fs) > 1 {
					nome = fmt.Sprintf("fatura_agua_%s_%s_%da.pdf", uc, d.mes, i+1)
				}
				anexar(nome, f)
			}
		}
	}
}
