package handlers

// Auditoria comparativa de fatura — endpoint que junta FDE + sgeeasy + IA em uma
// resposta única para o modal ModalAuditoriaComparativa (3 colunas).
//
//   POST /api/v1/faturas/:id/auditar-comparativo  → JSON estruturado
//
// Fluxo:
//   1. Carrega fatura da FATURA_DADOS_EXTRAIDOS (colunas normalizadas)
//   2. Consulta Faturas_Registradas_Cache do sgeeasy (mesmo UC + Mes_Ref)
//   3. Aplica fórmula determinística de ressarcimento
//   4. Chama gpt-5.4-mini com prompt de auditor comparativo → veredito
//   5. Salva em FATURA_REANALISES (modelo="auditar-comparativo:gpt-5.4-mini")
//   6. Devolve JSON com as 3 colunas + divergências + ressarcimento + veredito

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strings"
	"unicode"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// Modelo preferido para EXTRAÇÃO IA da fatura (2ª leitura independente).
// Prioriza qualidade: mini como primário (~$0.002/fatura, mais preciso em
// interpretações comparativas); nano como fallback só se o mini falhar
// (não é fallback de custo, é fallback de disponibilidade).
const (
	modeloExtracaoPrimario  = "gpt-5.4-mini"
	modeloExtracaoFallback  = "gpt-5.4-nano"

	// FatorRetencaoRessarcimento — retenção do ressarcimento estimado.
	// Ago/2026: DEFINIDO EM 1.0 (100%, valor cheio) por decisão do usuário — retenção de 42% REMOVIDA
	// em TODAS as frentes (Apontamentos, Auditados, Inconclusivos, Água, Acer, sgeeasy-gap).
	FatorRetencaoRessarcimento = 1.0
)

// Modelo usado no comparativo — gpt-5.4-mini (validado no benchmark).
const modeloComparativo = "gpt-5.4-mini"

// Campos comparados entre FDE e sgeeasy. Mapeia coluna FDE → coluna sgeeasy.
var camposComparativos = []struct {
	rotulo string  // label na UI
	fde    string  // nome coluna na FATURA_DADOS_EXTRAIDOS
	sge    string  // nome coluna na Faturas_Registradas_Cache
	tipo   string  // "kwh" | "brl" | "str"
	peso   float64 // divergência considerada relevante ≥ peso%
}{
	{"Consumo ponta", "consumo_ativo_ponta_kwh", "KWH_Ponta", "kwh", 5},
	{"Consumo fora-ponta", "consumo_ativo_fponta_kwh", "KWH_FPonta", "kwh", 5},
	{"Consumo reservado", "consumo_ativo_reservado_kwh", "KWH_Reservado", "kwh", 5},
	{"Valor total", "valor_total_fatura", "RS_Total_Fatura", "brl", 2},
	{"Modalidade tarifária", "modalidade_tarifaria", "Modalidade_Tarifaria", "str", 0},
	{"Tensão", "tp_tensao", "Tp_Tensao", "str", 0},
	{"Nº medidor", "numero_medidor", "NroMedidor", "str", 0},
	{"Concessionária", "concessionaria", "Concessionaria", "str", 0},
}

type divergencia struct {
	Campo       string   `json:"campo"`
	FDE         any      `json:"fde"`
	Sgeeasy     any      `json:"sgeeasy"`
	DeltaPct    *float64 `json:"delta_pct,omitempty"` // nil pra campos string
	Status      string   `json:"status"`              // "ok" | "diverge" | "faltante"
	Tipo        string   `json:"tipo"`                // "kwh" | "brl" | "str"
	Observacao  string   `json:"observacao,omitempty"`
}

type ressarcimentoCalc struct {
	Base           string   `json:"base"`
	ConsumoCobrado *float64 `json:"consumo_cobrado_kwh,omitempty"`
	ConsumoReal    *float64 `json:"consumo_real_kwh,omitempty"`
	TarifaMedia    *float64 `json:"tarifa_media_brl_kwh,omitempty"`
	DesvioPct      *float64 `json:"desvio_pct,omitempty"`
	ValorEnergia   *float64 `json:"valor_energia_ativa,omitempty"`
	ValorSugerido  float64  `json:"valor_sugerido_brl"`
	Explicacao     string   `json:"explicacao"`
	FonteValor     string   `json:"fonte_valor"` // "motor_f02" | "calculado_backend"
}

// ExtracaoIA — 2ª leitura da fatura via LLM (sobre texto_plumber ou markdown).
// Serve como 3ª fonte independente da coluna FDE (regex) e do sgeeasy.
type ExtracaoIA struct {
	Encontrada          bool     `json:"encontrada"`
	Modelo              string   `json:"modelo,omitempty"`
	ConsumoPontaKwh     *float64 `json:"consumo_ponta_kwh,omitempty"`
	ConsumoFPontaKwh    *float64 `json:"consumo_fponta_kwh,omitempty"`
	ConsumoReservadoKwh *float64 `json:"consumo_reservado_kwh,omitempty"`
	ValorTotalBrl       *float64 `json:"valor_total_brl,omitempty"`
	IcmsBrl             *float64 `json:"icms_brl,omitempty"`
	PisBrl              *float64 `json:"pis_brl,omitempty"`
	CofinsBrl           *float64 `json:"cofins_brl,omitempty"`
	ModalidadeTarifaria string   `json:"modalidade_tarifaria,omitempty"`
	TensaoFornecimento  string   `json:"tensao_fornecimento,omitempty"`
	NumeroMedidor       string   `json:"numero_medidor,omitempty"`
	Observacao          string   `json:"observacao,omitempty"`
}

type veredito struct {
	Macro       string `json:"macro"`       // "SEM ERRO" | "ERRO CONFIRMADO" | "INCONCLUSIVO"
	Tipo        string `json:"tipo"`        // "consistente" | "anomalia_real" | "bug_extracao" | "sem_referencia_sgeeasy" | "divergencia_menor" | "ativacao"
	Confianca   string `json:"confianca"`   // "alta" | "media" | "baixa"
	Justificativa string `json:"justificativa"`
	AcaoSugerida string `json:"acao_sugerida"`
	AnaliseGrafico string `json:"analise_grafico"` // análise do padrão do histórico de consumo (gráfico)
}

type auditoriaComparativaResp struct {
	FaturaID          string            `json:"fatura_id"`
	UC                string            `json:"uc"`
	MesReferencia     string            `json:"mes_referencia"`
	Concessionaria    string            `json:"concessionaria"`
	FDE               map[string]any    `json:"fde"`
	Sgeeasy           map[string]any    `json:"sgeeasy"`
	SgeeasyEncontrada bool              `json:"sgeeasy_encontrada"`
	IA                ExtracaoIA        `json:"ia"` // 2ª leitura via LLM
	Divergencias      []divergencia     `json:"divergencias"`
	Ressarcimento     ressarcimentoCalc `json:"ressarcimento"`
	Veredito          veredito          `json:"veredito"`
	RespostaCrua      string            `json:"resposta_crua_ia"`
	Modelo            string            `json:"modelo"`
}

// Body opcional do POST — front passa ressarcimento e desvio já calculados para
// espelhar EXATAMENTE o valor exibido na tabela (linha do apontamento).
type reqBodyComparativo struct {
	RessarcimentoEstimado *float64 `json:"ressarcimento_estimado"`
	DesvioPctMax          *float64 `json:"desvio_pct_max"`
	ValorEnergiaAtiva     *float64 `json:"valor_energia_ativa"`
}

// AuditarComparativoFatura — POST /api/v1/faturas/:id/auditar-comparativo
func AuditarComparativoFatura(c *gin.Context) {
	id := c.Param("id")

	// Body opcional — front pode passar ressarcimento/desvio já calculados
	var body reqBodyComparativo
	_ = c.ShouldBindJSON(&body)

	fatFDE, err := carregarFaturaCompacta(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "fatura não encontrada"})
		return
	}
	uc := coalesceStr(fatFDE["numero_instalacao"], fatFDE["codigo_uc"])
	mesRef := coalesceStr(fatFDE["mes_referencia"])
	codEmpresa := coalesceStr(fatFDE["cod_empresa"])
	conc := coalesceStr(fatFDE["concessionaria"])

	// 2. sgeeasy (Faturas_Registradas_Cache) — mesmo UC + Mes_Ref
	fatSGE, tarifaMedia := carregarSgeeasy(codEmpresa, uc, mesRef)
	sgeEncontrada := fatSGE != nil
	if fatSGE == nil {
		fatSGE = map[string]any{}
	}

	// 3. IA — 2ª leitura independente da fatura (via texto_plumber/markdown)
	// Roda em paralelo com o resto pra não atrasar; se falhar, ignora.
	iaExtracao := extrairFaturaViaIA(c.Request.Context(), id)

	// 4. divergências (compara FDE × sgeeasy — coluna IA é diagnóstica, não entra na conta)
	divs := compararCampos(fatFDE, fatSGE, sgeEncontrada)

	// 5. ressarcimento — prioridade: valor do front (mesma linha da tabela);
	// fallback: fórmula backend com tarifa média sgeeasy.
	ress := calcularRessarcimento(fatFDE, fatSGE, tarifaMedia, sgeEncontrada, body)

	// 6. IA — veredito, recebe divergências, ressarcimento e a 2ª leitura já prontos
	respIA, verd := chamarIAVeredito(c.Request.Context(), fatFDE, fatSGE, iaExtracao, divs, ress, sgeEncontrada)

	// 6. grava em FATURA_REANALISES (audit trail)
	uid, uname := usuarioIA(c)
	if sqlDB, e := database.GormDB_App.DB(); e == nil {
		conf := 0
		switch verd.Confianca {
		case "alta":
			conf = 90
		case "media":
			conf = 60
		case "baixa":
			conf = 30
		}
		just, _ := json.Marshal(map[string]any{
			"veredito": verd, "ressarcimento": ress, "n_divergencias": len(divs),
		})
		_, _ = sqlDB.Exec(`INSERT INTO FATURA_REANALISES
			(fatura_id, modelo, justificativa, recomendacao, resposta_crua, confianca_final, pdf_anexado, usuario_id, usuario_nome, criado_em)
			VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NOW())`,
			id, "auditar-comparativo:"+modeloComparativo,
			truncarIA(string(just), 4000), verd.Macro,
			truncarIA(respIA, 8000), conf, uid, uname)
	}

	c.JSON(http.StatusOK, auditoriaComparativaResp{
		FaturaID: id, UC: uc, MesReferencia: mesRef, Concessionaria: conc,
		FDE: filtrarCampos(fatFDE), Sgeeasy: fatSGE, SgeeasyEncontrada: sgeEncontrada,
		IA: iaExtracao,
		Divergencias: divs, Ressarcimento: ress, Veredito: verd,
		RespostaCrua: respIA, Modelo: modeloComparativo,
	})
}

// ---- helpers ---------------------------------------------------------------

func coalesceStr(vals ...any) string {
	for _, v := range vals {
		if v == nil {
			continue
		}
		s := strings.TrimSpace(fmt.Sprintf("%v", v))
		if s != "" && s != "<nil>" {
			return s
		}
	}
	return ""
}

// carregarSgeeasy busca a fatura na Faturas_Registradas_Cache e calcula tarifa
// média dos últimos 12 meses (para uso na fórmula de ressarcimento). Retorna nil
// se não achou. Aceita mes em ISO ('YYYY-MM-DD') ou legado ('MM/YYYY').
func carregarSgeeasy(codEmpresa, uc, mesRef string) (map[string]any, float64) {
	if codEmpresa == "" || uc == "" {
		return nil, 0
	}
	// VTAL (cod_empresa 2025) fica em outro banco (quivere_vtal). Mesma tabela
	// Faturas_Registradas_Cache / mesmas colunas → só troca a conexão.
	gdb := database.GormDB_Faturas
	if strings.TrimSpace(codEmpresa) == "2025" && database.GormDB_Vtal != nil {
		gdb = database.GormDB_Vtal
	}
	if gdb == nil {
		return nil, 0
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		return nil, 0
	}

	// tenta ambos formatos de mes
	mesISO := mesRef
	if strings.Contains(mesRef, "/") && len(mesRef) == 7 {
		// "MM/YYYY" → "YYYY-MM-01"
		mesISO = mesRef[3:] + "-" + mesRef[:2] + "-01"
	}

	row := sqlDB.QueryRow(`
		SELECT KWH_Ponta, KWH_FPonta, KWH_Reservado, KWH_Total, Media_Consumo,
		       RS_Total_Fatura, ICMS_RS, PIS_RS, COFINS_RS,
		       Modalidade_Tarifaria, Tp_Tensao, NroMedidor, Concessionaria,
		       RAZAO_SOCIAL, Apelido, Mes_Ref
		FROM Faturas_Registradas_Cache
		WHERE Cod_Empresa=? AND UC=? AND Mes_Ref=?
		ORDER BY id DESC LIMIT 1`, codEmpresa, uc, mesISO)

	var (
		kP, kFP, kR, kT, mediaCons, rsTot, icms, pis, cof sql.NullFloat64
		modal, tens, med, cons, razao, apel, mes           sql.NullString
	)
	if err := row.Scan(&kP, &kFP, &kR, &kT, &mediaCons, &rsTot, &icms, &pis, &cof,
		&modal, &tens, &med, &cons, &razao, &apel, &mes); err != nil {
		return nil, 0
	}

	// tarifa média = valor / consumo (ultimos 12 meses). Se o mês atual não tem,
	// faz uma busca separada.
	tarifa := 0.0
	rowTar := sqlDB.QueryRow(`
		SELECT SUM(RS_Total_Fatura) AS soma_valor,
		       SUM(COALESCE(KWH_Total,0) + COALESCE(KWH_Ponta,0)+COALESCE(KWH_FPonta,0)+COALESCE(KWH_Reservado,0)) AS soma_kwh
		FROM Faturas_Registradas_Cache
		WHERE Cod_Empresa=? AND UC=?
		  AND Mes_Ref < ?
		  AND Mes_Ref >= DATE_SUB(?, INTERVAL 12 MONTH)
		  AND RS_Total_Fatura > 0`, codEmpresa, uc, mesISO, mesISO)
	var somaValor, somaKwh sql.NullFloat64
	_ = rowTar.Scan(&somaValor, &somaKwh)
	if somaKwh.Valid && somaKwh.Float64 > 0 {
		// divide pelo dobro porque KWH_Total pode duplicar com postos — usa média conservadora
		tarifa = somaValor.Float64 / somaKwh.Float64
		if tarifa > 5 { // sanidade: tarifa BR não passa de ~R$ 5/kWh
			tarifa = somaValor.Float64 / (somaKwh.Float64 * 2)
		}
	}

	consumoTotal := kT.Float64
	if consumoTotal == 0 {
		consumoTotal = kP.Float64 + kFP.Float64 + kR.Float64
	}

	out := map[string]any{
		"KWH_Ponta":            kP.Float64,
		"KWH_FPonta":           kFP.Float64,
		"KWH_Reservado":        kR.Float64,
		"KWH_Total":            consumoTotal,
		"Media_Consumo":        mediaCons.Float64,
		"RS_Total_Fatura":      rsTot.Float64,
		"ICMS_RS":              icms.Float64,
		"PIS_RS":               pis.Float64,
		"COFINS_RS":            cof.Float64,
		"Modalidade_Tarifaria": modal.String,
		"Tp_Tensao":            tens.String,
		"NroMedidor":           med.String,
		"Concessionaria":       cons.String,
		"RAZAO_SOCIAL":         razao.String,
		"Apelido":              apel.String,
		"Mes_Ref":              mes.String,
	}
	return out, tarifa
}

// compararCampos monta a lista de divergências FDE × sgeeasy.
func compararCampos(fde, sge map[string]any, sgeEncontrada bool) []divergencia {
	out := make([]divergencia, 0, len(camposComparativos))
	for _, c := range camposComparativos {
		vFDE := fde[c.fde]
		vSGE := sge[c.sge]
		d := divergencia{Campo: c.rotulo, FDE: vFDE, Sgeeasy: vSGE, Tipo: c.tipo}
		if !sgeEncontrada {
			d.Status = "faltante"
			d.Observacao = "sem referência no sgeeasy"
			out = append(out, d)
			continue
		}
		if c.tipo == "str" {
			a := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", vFDE)))
			b := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", vSGE)))
			if a == "" || b == "" {
				d.Status = "faltante"
			} else if a == b {
				d.Status = "ok"
			} else {
				d.Status = "diverge"
			}
			out = append(out, d)
			continue
		}
		// numérico
		aNum, aOK := paraFloat(vFDE)
		bNum, bOK := paraFloat(vSGE)
		if !aOK || !bOK {
			d.Status = "faltante"
			out = append(out, d)
			continue
		}
		base := math.Max(math.Abs(aNum), math.Abs(bNum))
		if base == 0 {
			d.Status = "ok"
		} else {
			pct := math.Abs(aNum-bNum) / base * 100
			d.DeltaPct = &pct
			if pct <= c.peso {
				d.Status = "ok"
			} else {
				d.Status = "diverge"
			}
		}
		out = append(out, d)
	}
	return out
}

func paraFloat(v any) (float64, bool) {
	if v == nil {
		return 0, false
	}
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case string:
		s := strings.ReplaceAll(strings.ReplaceAll(x, ".", ""), ",", ".")
		var f float64
		if _, err := fmt.Sscanf(s, "%f", &f); err == nil {
			return f, true
		}
	}
	// fallback via fmt
	var f float64
	if _, err := fmt.Sscanf(fmt.Sprintf("%v", v), "%f", &f); err == nil {
		return f, true
	}
	return 0, false
}

// calcularRessarcimento — prioridade absoluta: valor que o front enviou (mesmo
// da tabela de apontamentos, calculado por calcRessEstimado em AnaliseDesvio.jsx
// como base × d/(1+d), base=valor_energia_ativa, d=desvio_pct_max/100). Se o
// front não enviou nada, tenta reproduzir a fórmula com os dados da FDE; e
// último recurso, cai na fórmula (cobrado - real) × tarifa média sgeeasy.
func calcularRessarcimento(fde, sge map[string]any, tarifa float64, sgeEncontrada bool, body reqBodyComparativo) ressarcimentoCalc {
	consumoCobrado := somaConsumoFDE(fde)
	var consumoReal float64
	if sgeEncontrada {
		if v, ok := paraFloat(sge["KWH_Total"]); ok {
			consumoReal = v
		}
	}
	out := ressarcimentoCalc{
		Base:           "base × d/(1+d) — mesma fórmula da tabela de apontamentos",
		ConsumoCobrado: &consumoCobrado,
	}
	if sgeEncontrada && consumoReal > 0 {
		out.ConsumoReal = &consumoReal
	}

	// Caminho 1: front passou o valor calculado da linha (fonte de verdade da UI)
	// O front JÁ aplica FATOR_RETENCAO_RESSARCIMENTO em calcRessEstimado, então
	// o valor recebido aqui já está reduzido — não reaplica.
	if body.RessarcimentoEstimado != nil && *body.RessarcimentoEstimado > 0 {
		out.ValorSugerido = *body.RessarcimentoEstimado
		out.FonteValor = "motor_f02"
		if body.DesvioPctMax != nil {
			out.DesvioPct = body.DesvioPctMax
		}
		if body.ValorEnergiaAtiva != nil {
			out.ValorEnergia = body.ValorEnergiaAtiva
		}
		out.Explicacao = fmt.Sprintf(
			"Valor estimado pelo motor F02 (idêntico ao da tabela): R$ %.2f. Fórmula: base × d/(1+d), com base = valor_energia_ativa e d = desvio_pct/100.",
			out.ValorSugerido)
		return out
	}

	// Caminho 2: reproduz a fórmula do front usando dados da FDE (sem body).
	// Aqui aplica o FatorRetencaoRessarcimento pra manter paridade com o front.
	if val, ok := paraFloat(fde["valor_energia_ativa"]); ok && val > 0 {
		// desvio: se sgeeasy tem consumo real, calcula (cobrado - real) / real
		if consumoReal > 0 && consumoCobrado > 0 {
			d := (consumoCobrado - consumoReal) / consumoReal
			if d > 0 {
				bruto := val * d / (1 + d)
				out.ValorSugerido = bruto // BRUTO — retenção só no ressarcimento total, não no estimado
				out.DesvioPct = ptrFloat(d * 100)
				out.ValorEnergia = &val
				out.FonteValor = "calculado_backend"
				out.Explicacao = fmt.Sprintf(
					"Ressarcimento estimado: R$ %.2f (consumo cobrado %.0f kWh > real %.0f kWh, desvio %.0f%%).",
					out.ValorSugerido, consumoCobrado, consumoReal, d*100)
				return out
			}
		}
	}

	// Caminho 3 (fallback): (cobrado - real) × tarifa média — sem valor_energia_ativa
	if sgeEncontrada && consumoReal > 0 && consumoCobrado > consumoReal && tarifa > 0 {
		bruto := (consumoCobrado - consumoReal) * tarifa
		out.ValorSugerido = bruto // BRUTO — retenção só no ressarcimento total, não no estimado
		out.TarifaMedia = &tarifa
		out.FonteValor = "calculado_backend"
		out.Explicacao = fmt.Sprintf(
			"Ressarcimento estimado (fallback): R$ %.2f (consumo cobrado %.0f kWh > real %.0f kWh, tarifa R$ %.4f/kWh).",
			out.ValorSugerido, consumoCobrado, consumoReal, tarifa)
		return out
	}

	out.FonteValor = "indisponivel"
	out.Explicacao = "Sem dados suficientes para estimar o ressarcimento."
	return out
}

func ptrFloat(v float64) *float64 { return &v }

func somaConsumoFDE(fde map[string]any) float64 {
	total := 0.0
	for _, k := range []string{"consumo_ativo_ponta_kwh", "consumo_ativo_fponta_kwh", "consumo_ativo_reservado_kwh"} {
		if v, ok := paraFloat(fde[k]); ok {
			total += v
		}
	}
	return total
}

// filtrarCampos devolve só as colunas relevantes da FDE pra o painel do modal.
func filtrarCampos(fde map[string]any) map[string]any {
	campos := []string{
		"consumo_ativo_ponta_kwh", "consumo_ativo_fponta_kwh", "consumo_ativo_reservado_kwh",
		"valor_total_fatura", "modalidade_tarifaria", "tp_tensao", "numero_medidor",
		"concessionaria", "razao_social", "nome_cliente", "mes_referencia",
		"pis_valor", "cofins_valor", "icms_valor",
	}
	out := make(map[string]any, len(campos))
	for _, c := range campos {
		if v, ok := fde[c]; ok && v != nil {
			out[c] = v
		}
	}
	return out
}

// chamarIAVeredito envia divergências + ressarcimento pré-calculado + a 2ª leitura
// via IA para gpt-5.4-mini e recebe o veredito estruturado (JSON).
func chamarIAVeredito(ctx context.Context, fde, sge map[string]any, ia ExtracaoIA, divs []divergencia, ress ressarcimentoCalc, sgeEncontrada bool) (string, veredito) {
	system := `Voce e auditor comparativo de faturas de energia eletrica brasileiras. Recebe 4 fontes ja cruzadas:
(1) FDE — dados extraidos da fatura via pipeline de regex.
(2) SGEEASY — sistema oficial de registro (fonte de verdade).
(3) IA_EXTRACAO — 2a leitura da fatura via LLM (opcional).
(4) DIVERGENCIAS — lista ja computada campo a campo (nao recalcule).

Idioma: RESPONDER EXCLUSIVAMENTE EM PORTUGUES BRASILEIRO. Nao use nenhuma
palavra em ingles, hindi, arabe ou qualquer outro idioma. Nao use conectivos
estrangeiros ("while", "such that", etc). Apenas caracteres latinos com
acentos portugueses.

Tarefa: devolver VEREDITO em JSON puro (sem markdown, sem texto extra), schema:
{
  "macro": "SEM ERRO" | "ERRO CONFIRMADO" | "INCONCLUSIVO",
  "tipo":  "consistente" | "anomalia_real" | "bug_extracao" | "sem_referencia_sgeeasy" | "divergencia_menor" | "ativacao",
  "confianca": "alta" | "media" | "baixa",
  "justificativa": "1-2 frases em PT-BR objetivo",
  "acao_sugerida": "1 frase acionavel em PT-BR",
  "analise_grafico": "2-4 frases em PT-BR analisando a serie HISTORICO_CONSUMO: tendencia geral, sazonalidade, e se o mes atual e um pico/vale fora do padrao (compare com a media dos meses anteriores). Se HISTORICO_CONSUMO estiver vazio, escreva 'Sem histórico suficiente para análise do gráfico.'"
}

Regras:
- Se FDE e IA_EXTRACAO concordam MAS SGEEASY diverge >20% → tipo="anomalia_real" (fatura mostra o valor que sistema nao registra).
- Se SGEEASY e IA_EXTRACAO concordam MAS FDE diverge >20% → tipo="bug_extracao" (regex leu errado; PDF e SGEEASY concordam).
- Se DIVERGENCIAS.consumo diverge >20% MAS valor total bate → tipo="bug_extracao".
- Se consumo E valor divergem >20% e IA_EXTRACAO confirma FDE → tipo="anomalia_real" (sugerir requisicao).
- Se sem referencia sgeeasy → tipo="sem_referencia_sgeeasy" (INCONCLUSIVO).
- Se todos os campos batem ≤5% → tipo="consistente" (SEM ERRO).
- Divergencias 5-20% → tipo="divergencia_menor" (INCONCLUSIVO).
- NAO invente. Use apenas os dados fornecidos.`

	payload := map[string]any{
		"fde":                filtrarCampos(fde),
		"sgeeasy":            sge,
		"sgeeasy_encontrada": sgeEncontrada,
		"ia_extracao":        ia,
		"divergencias":       divs,
		"ressarcimento":      ress,
		"historico_consumo":  carregarSerieHistorico(coalesceStr(fde["codigo_uc"], fde["numero_instalacao"])),
	}
	buf, _ := json.Marshal(payload)

	resposta, err := chamarOpenAIChat(ctx, modeloComparativo, system,
		[]map[string]string{{"role": "user", "content": string(buf)}})
	if err != nil || strings.TrimSpace(resposta) == "" {
		return "", vereditoFallback(divs, ress, sgeEncontrada)
	}
	jsonStr := extrairJSON(resposta)
	var v veredito
	if err := json.Unmarshal([]byte(jsonStr), &v); err != nil || v.Macro == "" {
		return resposta, vereditoFallback(divs, ress, sgeEncontrada)
	}
	// Sanitiza texto — remove qualquer caractere de scripts nao-latinos que
	// modelos multilingues costumam misturar (arabe, hindi, chines, etc).
	v.Justificativa = sanitizarPTBR(v.Justificativa)
	v.AcaoSugerida = sanitizarPTBR(v.AcaoSugerida)
	v.AnaliseGrafico = sanitizarPTBR(v.AnaliseGrafico)
	return resposta, v
}

// carregarSerieHistorico — série mensal de consumo da UC (p/ a IA analisar o gráfico).
// Consumo em cascata: kwh_total, senão ponta+fponta. Últimos ~24 meses, ordem cronológica.
func carregarSerieHistorico(codigoUC string) []map[string]any {
	out := []map[string]any{}
	if codigoUC == "" || database.GormDB_App == nil {
		return out
	}
	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		return out
	}
	rows, err := sqlDB.Query(`
		SELECT COALESCE(mes_referencia,'') mes,
		       ROUND(CASE WHEN COALESCE(kwh_total,0) > 0 THEN kwh_total
		                  ELSE COALESCE(consumo_ativo_ponta_kwh,0)+COALESCE(consumo_ativo_fponta_kwh,0) END, 0) kwh
		FROM FATURA_DADOS_EXTRAIDOS
		WHERE codigo_uc = ?
		ORDER BY CASE WHEN mes_referencia LIKE '____-__-__' THEN mes_referencia
		              WHEN mes_referencia LIKE '__/____'   THEN CONCAT(SUBSTRING(mes_referencia,4,4),'-',SUBSTRING(mes_referencia,1,2),'-01')
		              ELSE mes_referencia END DESC
		LIMIT 24`, codigoUC)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var mes string
		var kwh float64
		if rows.Scan(&mes, &kwh) == nil {
			out = append(out, map[string]any{"mes": mes, "kwh": kwh})
		}
	}
	// devolve em ordem cronológica (mais antigo → mais recente)
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func extrairJSON(s string) string {
	i := strings.Index(s, "{")
	j := strings.LastIndex(s, "}")
	if i >= 0 && j > i {
		return s[i : j+1]
	}
	return s
}

// sanitizarPTBR remove caracteres fora dos scripts latino/pontuação — LLMs
// multilíngues às vezes colam palavras em hindi/árabe no meio de PT-BR
// (ex: "जबकि" no meio da frase). Se a limpeza remover >30% da string,
// substitui por texto padrão pra não gerar frase truncada.
var reNaoLatino = regexp.MustCompile(`[^\p{Latin}\p{N}\p{P}\p{Zs}\p{Sm}\p{Sc}\n\r\t·°→←↔]+`)

func sanitizarPTBR(s string) string {
	if s == "" {
		return s
	}
	orig := s
	// remove tudo que não seja letra latina, número, pontuação, espaço ou símbolos comuns
	limpo := reNaoLatino.ReplaceAllString(s, "")
	// normaliza espaços múltiplos
	limpo = strings.Join(strings.Fields(limpo), " ")
	// verifica se sobrou algo aproveitável
	if len([]rune(limpo)) < int(0.7*float64(len([]rune(orig)))) && len([]rune(orig)) > 20 {
		// removeu demais — provavelmente resposta veio muito contaminada
		var sb strings.Builder
		for _, r := range orig {
			if unicode.Is(unicode.Latin, r) || unicode.IsDigit(r) ||
				unicode.IsPunct(r) || unicode.IsSpace(r) || unicode.IsSymbol(r) {
				sb.WriteRune(r)
			}
		}
		limpo = strings.Join(strings.Fields(sb.String()), " ")
	}
	return limpo
}

// carregarTextoFatura busca o texto da fatura para a IA reextrair. Prefere
// texto_markdown (mais estruturado), cai em texto_plumber (mais bruto).
func carregarTextoFatura(id string) string {
	db := database.GormDB_App
	if db == nil {
		return ""
	}
	sqlDB, err := db.DB()
	if err != nil {
		return ""
	}
	var md, plumber sql.NullString
	_ = sqlDB.QueryRow(
		"SELECT texto_markdown, texto_plumber FROM FATURA_DADOS_EXTRAIDOS WHERE id=? LIMIT 1", id,
	).Scan(&md, &plumber)
	if md.Valid && len(strings.TrimSpace(md.String)) > 200 {
		return md.String
	}
	if plumber.Valid {
		return plumber.String
	}
	return ""
}

// extrairFaturaViaIA — 2a leitura da fatura via LLM. Tenta gpt-5.4-nano;
// se falhar, cai no gpt-5.4-mini. Retorna ExtracaoIA{Encontrada:false} se não
// há texto ou ambos modelos falharem.
func extrairFaturaViaIA(ctx context.Context, id string) ExtracaoIA {
	texto := carregarTextoFatura(id)
	if strings.TrimSpace(texto) == "" {
		return ExtracaoIA{Encontrada: false, Observacao: "sem texto extraido salvo"}
	}
	// Trunca texto a ~40KB (~10k tokens) para conter custo/latência
	if len(texto) > 40000 {
		texto = texto[:40000]
	}

	system := `Voce e extrator de fatura de energia eletrica brasileira. Leia o texto e extraia os campos abaixo. Se um campo NAO esta claro no texto, deixe null (nao invente). Numeros em formato BR (usar ponto como separador decimal na resposta).

RESPONDA APENAS em JSON puro (sem markdown, sem texto extra). Schema:
{
  "consumo_ponta_kwh": number|null,
  "consumo_fponta_kwh": number|null,
  "consumo_reservado_kwh": number|null,
  "valor_total_brl": number|null,
  "icms_brl": number|null,
  "pis_brl": number|null,
  "cofins_brl": number|null,
  "modalidade_tarifaria": string|null,
  "tensao_fornecimento": string|null,
  "numero_medidor": string|null
}

Observacao: se a fatura for tarifa convencional (sem posto), coloque o consumo unico em "consumo_fponta_kwh" e deixe ponta/reservado null. Idioma da resposta: nao aplicavel (so JSON). NAO responda em outro idioma que nao seja JSON estrito.`

	// tenta modelo primário (nano); se erro/timeout/output invalido, tenta fallback
	tentar := func(modelo string) (ExtracaoIA, string, error) {
		resp, err := chamarOpenAIChat(ctx, modelo, system,
			[]map[string]string{{"role": "user", "content": texto}})
		if err != nil {
			return ExtracaoIA{}, "", err
		}
		var ia ExtracaoIA
		if e := json.Unmarshal([]byte(extrairJSON(resp)), &ia); e != nil {
			return ExtracaoIA{}, resp, e
		}
		return ia, resp, nil
	}

	ia, _, err := tentar(modeloExtracaoPrimario)
	if err != nil {
		// fallback pro mini
		ia, _, err = tentar(modeloExtracaoFallback)
		if err != nil {
			return ExtracaoIA{Encontrada: false, Observacao: "IA indisponivel"}
		}
		ia.Encontrada = true
		ia.Modelo = modeloExtracaoFallback
		return ia
	}
	ia.Encontrada = true
	ia.Modelo = modeloExtracaoPrimario
	return ia
}

// vereditoFallback é usado quando a IA falha (rede/timeout/erro de parse).
// Aplica regras simples sobre as divergências já calculadas.
func vereditoFallback(divs []divergencia, ress ressarcimentoCalc, sgeEncontrada bool) veredito {
	if !sgeEncontrada {
		return veredito{
			Macro: "INCONCLUSIVO", Tipo: "sem_referencia_sgeeasy",
			Confianca: "baixa",
			Justificativa: "Sem referência no sgeeasy para comparar.",
			AcaoSugerida:  "Revisar manualmente.",
		}
	}
	consumoDiverge, valorDiverge := false, false
	for _, d := range divs {
		if d.DeltaPct == nil {
			continue
		}
		if strings.HasPrefix(strings.ToLower(d.Campo), "consumo") && *d.DeltaPct > 20 {
			consumoDiverge = true
		}
		if d.Campo == "Valor total" && *d.DeltaPct > 20 {
			valorDiverge = true
		}
	}
	switch {
	case consumoDiverge && valorDiverge:
		return veredito{
			Macro: "ERRO CONFIRMADO", Tipo: "anomalia_real", Confianca: "media",
			Justificativa: "Consumo e valor divergem entre fatura e sistema.",
			AcaoSugerida:  fmt.Sprintf("Abrir requisição de ressarcimento R$ %.2f.", ress.ValorSugerido),
		}
	case consumoDiverge && !valorDiverge:
		return veredito{
			Macro: "ERRO CONFIRMADO", Tipo: "bug_extracao", Confianca: "alta",
			Justificativa: "Consumo lido diverge do sistema, mas valor total bate — bug de extração.",
			AcaoSugerida:  "Reprocessar fatura na FDE.",
		}
	default:
		return veredito{
			Macro: "SEM ERRO", Tipo: "consistente", Confianca: "alta",
			Justificativa: "FDE e sgeeasy batem dentro da tolerância.",
			AcaoSugerida:  "Arquivar.",
		}
	}
}
