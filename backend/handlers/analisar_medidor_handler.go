package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// extrairMedidorComIA baixa o PDF e chama gpt-5.4 pra extrair o número real
// do medidor (não confia nos dados extraídos do banco que podem estar quebrados).
// Retorna ("12345678", nil) ou ("", erro).
func extrairMedidorComIA(ctx context.Context, linkPDF string) (string, error) {
	if strings.TrimSpace(linkPDF) == "" {
		return "", fmt.Errorf("link_fatura vazio")
	}
	pdfB64, pdfName := baixarPDFBase64(linkPDF)
	if pdfB64 == "" {
		return "", fmt.Errorf("falha ao baixar PDF de %s", linkPDF)
	}

	prompt := `Você é um auditor especialista em faturas de energia elétrica.
Sua tarefa é EXTRAIR o número de série do medidor de energia desta fatura.
Procure por: "Nº Medidor", "Número do Medidor", "Medidor", "Nro Medidor", "Equipamento de Medição".
O número costuma ter 7-10 dígitos.

RESPONDA APENAS EM JSON ESTRITO (sem markdown, sem texto extra):
{"numero_medidor": "<número exato extraído da fatura, sem espaços>", "encontrado": true}

Se não encontrar:
{"numero_medidor": "", "encontrado": false}`

	question := "Qual é o número do medidor de energia nesta fatura?"

	raw, err := callAisureOpenAIPDF(ctx, question, "", pdfB64, pdfName, prompt)
	if err != nil {
		return "", err
	}

	// Tenta parsear JSON
	t := strings.TrimSpace(raw)
	t = strings.TrimPrefix(t, "```json")
	t = strings.TrimPrefix(t, "```JSON")
	t = strings.TrimPrefix(t, "```")
	t = strings.TrimSuffix(t, "```")
	t = strings.TrimSpace(t)
	if start := strings.Index(t, "{"); start >= 0 {
		if end := strings.LastIndex(t, "}"); end > start {
			t = t[start : end+1]
		}
	}

	var parsed struct {
		NumeroMedidor string `json:"numero_medidor"`
		Encontrado    bool   `json:"encontrado"`
	}
	if err := json.Unmarshal([]byte(t), &parsed); err != nil {
		return "", fmt.Errorf("resposta IA não-JSON: %s", raw)
	}
	return strings.TrimSpace(parsed.NumeroMedidor), nil
}

// leiturasFatura representa as 2 leituras impressas no PDF de uma fatura.
type leiturasFatura struct {
	LeituraAnterior float64 `json:"leitura_anterior"`
	LeituraAtual    float64 `json:"leitura_atual"`
	Encontrado      bool    `json:"encontrado"`
}

// extrairLeiturasComIA baixa o PDF e pede pra IA extrair as leituras de
// medidor (registrador) da fatura. Usado para verificar F05 (quebra de
// continuidade) sem depender de dados que podem ter sido extraídos errado.
func extrairLeiturasComIA(ctx context.Context, linkPDF string) (leiturasFatura, error) {
	zero := leiturasFatura{}
	if strings.TrimSpace(linkPDF) == "" {
		return zero, fmt.Errorf("link_fatura vazio")
	}
	pdfB64, pdfName := baixarPDFBase64(linkPDF)
	if pdfB64 == "" {
		return zero, fmt.Errorf("falha ao baixar PDF de %s", linkPDF)
	}

	prompt := `Você é um auditor especialista em faturas de energia elétrica.
Sua tarefa é EXTRAIR as duas leituras do registrador de energia desta fatura:
1. "Leitura anterior" (do ciclo anterior, no início do mês)
2. "Leitura atual" (do mês corrente, no fim do ciclo)

Procure por: "Leitura anterior", "Leitura atual", "Leitura ant.", "Leitura atu.",
"L. anterior", "L. atual", "Lant", "Latu", ou tabelas com colunas semelhantes.

Use APENAS o consumo ATIVO TOTAL (somando ponta + fora-ponta se houver).
Se a fatura traz só ponta, devolva o valor de ponta. Se só fora-ponta, devolva esse.

RESPONDA APENAS EM JSON ESTRITO (sem markdown, sem texto extra):
{"leitura_anterior": <número>, "leitura_atual": <número>, "encontrado": true}

Se não encontrar:
{"leitura_anterior": 0, "leitura_atual": 0, "encontrado": false}`

	question := "Quais são as leituras anterior e atual do medidor nesta fatura?"

	raw, err := callAisureOpenAIPDF(ctx, question, "", pdfB64, pdfName, prompt)
	if err != nil {
		return zero, err
	}

	t := strings.TrimSpace(raw)
	t = strings.TrimPrefix(t, "```json")
	t = strings.TrimPrefix(t, "```JSON")
	t = strings.TrimPrefix(t, "```")
	t = strings.TrimSuffix(t, "```")
	t = strings.TrimSpace(t)
	if start := strings.Index(t, "{"); start >= 0 {
		if end := strings.LastIndex(t, "}"); end > start {
			t = t[start : end+1]
		}
	}

	var parsed leiturasFatura
	if err := json.Unmarshal([]byte(t), &parsed); err != nil {
		return zero, fmt.Errorf("resposta IA não-JSON: %s", raw)
	}
	return parsed, nil
}

// CompararMedidoresUCHandler — para cada fatura com F04, baixa o PDF dela e o da
// próxima cronológica, manda ambos pra IA gpt-5.4 que LÊ os medidores diretamente
// do PDF (não confia nos dados extraídos do banco). Compara os números e retorna
// veredicto por par.
//
// GET /api/v1/faturas/uc/:uc/comparar-medidores
func CompararMedidoresUCHandler(c *gin.Context) {
	uc := strings.TrimSpace(c.Param("uc"))
	if uc == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "uc obrigatória"})
		return
	}

	db := database.DB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}

	// Lista todas as faturas da UC com flag F04
	rows, err := db.Query(`
		SELECT id, COALESCE(mes_referencia,''), COALESCE(link_fatura,'')
		FROM FATURA_DADOS_EXTRAIDOS
		WHERE codigo_uc = ?
		  AND COALESCE(fichas_apontadas->>'$.motor_regras_sql.flag_f04', '0') = '1'
		ORDER BY COALESCE(
		  STR_TO_DATE(mes_referencia, '%Y-%m-%d'),
		  STR_TO_DATE(CONCAT('01/', mes_referencia), '%d/%m/%Y')
		) ASC`, uc)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao listar apontamentos: " + err.Error()})
		return
	}
	defer rows.Close()

	type apontada struct {
		ID     int64
		MesRef string
		Link   string
	}
	var apontadas []apontada
	for rows.Next() {
		var a apontada
		if err := rows.Scan(&a.ID, &a.MesRef, &a.Link); err == nil {
			apontadas = append(apontadas, a)
		}
	}
	rows.Close()

	// Cache: id_fatura → medidor extraído (evita chamar IA 2x na mesma fatura)
	cacheMedidor := make(map[int64]string)

	// Helper que extrai com cache
	getMedidorIA := func(ctx context.Context, id int64, link string) (string, error) {
		if v, ok := cacheMedidor[id]; ok {
			return v, nil
		}
		med, err := extrairMedidorComIA(ctx, link)
		if err != nil {
			return "", err
		}
		cacheMedidor[id] = med
		return med, nil
	}

	type comparacao struct {
		IDApontada      int64  `json:"id_apontada"`
		MesApontada     string `json:"mes_apontada"`
		MedidorApontada string `json:"medidor_apontada"`
		IDProxima       int64  `json:"id_proxima"`
		MesProxima      string `json:"mes_proxima"`
		MedidorProxima  string `json:"medidor_proxima"`
		Veredicto       string `json:"veredicto"`
		Motivo          string `json:"motivo"`
	}

	// Timeout generoso: até 5 min total (cada par leva ~30-60s)
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
	defer cancel()

	comparacoes := make([]comparacao, 0, len(apontadas))

	for _, ap := range apontadas {
		// Busca próxima fatura cronológica
		var nextID int64
		var nextMes, nextLink string
		errNext := db.QueryRow(`
			SELECT id, COALESCE(mes_referencia,''), COALESCE(link_fatura,'')
			FROM FATURA_DADOS_EXTRAIDOS
			WHERE codigo_uc = ?
			  AND COALESCE(
			    STR_TO_DATE(mes_referencia, '%Y-%m-%d'),
			    STR_TO_DATE(CONCAT('01/', mes_referencia), '%d/%m/%Y')
			  ) > COALESCE(
			    STR_TO_DATE(?, '%Y-%m-%d'),
			    STR_TO_DATE(CONCAT('01/', ?), '%d/%m/%Y')
			  )
			ORDER BY COALESCE(
			  STR_TO_DATE(mes_referencia, '%Y-%m-%d'),
			  STR_TO_DATE(CONCAT('01/', mes_referencia), '%d/%m/%Y')
			) ASC LIMIT 1`, uc, ap.MesRef, ap.MesRef).Scan(&nextID, &nextMes, &nextLink)

		cmp := comparacao{
			IDApontada:  ap.ID,
			MesApontada: ap.MesRef,
		}

		if errNext != nil {
			cmp.Veredicto = "sem_proxima"
			cmp.Motivo = "Não há fatura posterior cadastrada"
			comparacoes = append(comparacoes, cmp)
			continue
		}

		cmp.IDProxima = nextID
		cmp.MesProxima = nextMes

		// Extrai medidores via IA (cada PDF, com cache por ID)
		medA, errA := getMedidorIA(ctx, ap.ID, ap.Link)
		medB, errB := getMedidorIA(ctx, nextID, nextLink)

		cmp.MedidorApontada = medA
		cmp.MedidorProxima = medB

		switch {
		case errA != nil && errB != nil:
			cmp.Veredicto = "sem_dados"
			cmp.Motivo = "IA não conseguiu ler os medidores nas duas faturas"
		case errA != nil:
			cmp.Veredicto = "sem_dados"
			cmp.Motivo = fmt.Sprintf("IA não leu medidor da apontada (%s): %s", ap.MesRef, errA.Error())
		case errB != nil:
			cmp.Veredicto = "sem_dados"
			cmp.Motivo = fmt.Sprintf("IA não leu medidor da próxima (%s): %s", nextMes, errB.Error())
		case medA == "" || medB == "":
			cmp.Veredicto = "sem_dados"
			cmp.Motivo = "IA não encontrou número de medidor em uma das faturas"
		case medA == medB:
			cmp.Veredicto = "falso_positivo"
			cmp.Motivo = fmt.Sprintf("Mesmo medidor (%s) lido nas duas faturas pela IA", medA)
		default:
			cmp.Veredicto = "troca_real"
			cmp.Motivo = fmt.Sprintf("Medidor mudou: %s → %s (lido pela IA)", medA, medB)
		}

		comparacoes = append(comparacoes, cmp)
	}

	c.JSON(http.StatusOK, gin.H{
		"uc":                 uc,
		"total_apontamentos": len(apontadas),
		"comparacoes":        comparacoes,
		"fonte":              "ia_gpt-5.4_via_pdf",
	})
}

// AnalisarMedidorHandler — chama IA (gpt-5.4) para verificar se o apontamento
// de troca de medidor (flag F04) está correto, comparando dados estruturados
// e textos extraídos da fatura apontada com a próxima cronológica.
//
// POST /api/v1/faturas/:id/analisar-medidor
//
// Resposta JSON:
//
//	{
//	  "veredicto": "troca_real" | "falso_positivo" | "inconclusivo",
//	  "confianca": 0..100,
//	  "justificativa": "...",
//	  "evidencias": ["..."],
//	  "fatura_apontada": {...},
//	  "fatura_proxima":  {...}
//	}
func AnalisarMedidorHandler(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}

	db := database.DB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}

	apontada, err := loadFaturaForMedidorAnalise(db, id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "fatura apontada não encontrada", "details": err.Error()})
		return
	}

	proxima, err := loadProximaFatura(db, apontada.CodigoUC, apontada.MesReferencia)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{
			"veredicto":     "inconclusivo",
			"confianca":     0,
			"justificativa": "Não foi encontrada fatura posterior para a UC " + apontada.CodigoUC + " (mes_ref " + apontada.MesReferencia + "). Sem comparativo, o apontamento não pode ser auditado.",
			"evidencias":    []string{},
			"fatura_apontada": apontada,
			"fatura_proxima":  nil,
		})
		return
	}

	prompt := medidorAnalysisSystemPrompt()
	question := buildMedidorComparisonContext(apontada, proxima)

	ctx, cancel := context.WithTimeout(c.Request.Context(), 90*time.Second)
	defer cancel()

	raw, err := callAisureOpenAI(ctx, nil, question, "", prompt)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "IA indisponível: " + err.Error()})
		return
	}

	parsed := parseMedidorVerdict(raw)
	parsed["fatura_apontada"] = apontada
	parsed["fatura_proxima"] = proxima
	parsed["raw_response"] = raw

	// Log discreto para auditoria
	if v, ok := c.Get("userID"); ok {
		if uid, ok2 := v.(int64); ok2 && uid > 0 {
			payload, _ := json.Marshal(parsed)
			_, _ = execGorm(database.GormDB_App,
				`INSERT INTO AI_CHAT_LOG (user_id, question, answer, sources, model) VALUES (?,?,?,?,?)`,
				uid, fmt.Sprintf("AnalisarMedidor id=%d", id), string(payload), "[]", "gpt-5.4-medidor",
			)
		}
	}

	c.JSON(http.StatusOK, parsed)
}

// faturaMedidorRow estrutura os campos relevantes para análise de medidor.
type faturaMedidorRow struct {
	ID                       int64    `json:"id"`
	CodigoUC                 string   `json:"codigo_uc"`
	MesReferencia            string   `json:"mes_referencia"`
	NumeroMedidor            string   `json:"numero_medidor"`
	NumeroFatura             string   `json:"numero_fatura,omitempty"`
	DataLeituraAnterior      string   `json:"data_leitura_anterior,omitempty"`
	DataLeituraAtual         string   `json:"data_leitura_atual,omitempty"`
	DiasFaturados            int64    `json:"dias_faturados,omitempty"`
	LeitAntAtivaPonta        float64  `json:"leit_ant_ativa_ponta"`
	LeitAtuAtivaPonta        float64  `json:"leit_atu_ativa_ponta"`
	LeitAntAtivaFPonta       float64  `json:"leit_ant_ativa_fponta"`
	LeitAtuAtivaFPonta       float64  `json:"leit_atu_ativa_fponta"`
	ConsumoAtivoPontaKwh     float64  `json:"consumo_ativo_ponta_kwh"`
	ConsumoAtivoFPontaKwh    float64  `json:"consumo_ativo_fponta_kwh"`
	IndicacaoTrocaMedidor    *bool    `json:"indicacao_troca_medidor,omitempty"`
	ObservacoesFatura        string   `json:"observacoes_fatura,omitempty"`
	InformacoesOperacionais  string   `json:"informacoes_operacionais,omitempty"`
	TextoMarkdown            string   `json:"texto_markdown,omitempty"`
	LinkFatura               string   `json:"link_fatura,omitempty"`
	FichasConfirmadas        []string `json:"fichas_confirmadas,omitempty"`
}

func loadFaturaForMedidorAnalise(db *sql.DB, id int64) (*faturaMedidorRow, error) {
	q := `
		SELECT id, COALESCE(codigo_uc,''), COALESCE(mes_referencia,''),
		       COALESCE(numero_medidor,''), COALESCE(numero_fatura,''),
		       COALESCE(DATE_FORMAT(data_leitura_anterior,'%d/%m/%Y'),''),
		       COALESCE(DATE_FORMAT(data_leitura_atual,'%d/%m/%Y'),''),
		       COALESCE(dias_faturados, 0),
		       COALESCE(leit_ant_ativa_ponta, 0), COALESCE(leit_atu_ativa_ponta, 0),
		       COALESCE(leit_ant_ativa_fponta, 0), COALESCE(leit_atu_ativa_fponta, 0),
		       COALESCE(consumo_ativo_ponta_kwh, 0), COALESCE(consumo_ativo_fponta_kwh, 0),
		       indicacao_troca_medidor,
		       COALESCE(observacoes_fatura,''),
		       COALESCE(informacoes_operacionais,''),
		       COALESCE(texto_markdown,''), COALESCE(link_fatura,''),
		       COALESCE(fichas_apontadas,'')
		FROM FATURA_DADOS_EXTRAIDOS WHERE id = ? LIMIT 1`
	var r faturaMedidorRow
	var indTroca sql.NullInt64
	var fichasJSON string
	err := db.QueryRow(q, id).Scan(
		&r.ID, &r.CodigoUC, &r.MesReferencia, &r.NumeroMedidor, &r.NumeroFatura,
		&r.DataLeituraAnterior, &r.DataLeituraAtual, &r.DiasFaturados,
		&r.LeitAntAtivaPonta, &r.LeitAtuAtivaPonta, &r.LeitAntAtivaFPonta, &r.LeitAtuAtivaFPonta,
		&r.ConsumoAtivoPontaKwh, &r.ConsumoAtivoFPontaKwh,
		&indTroca,
		&r.ObservacoesFatura, &r.InformacoesOperacionais,
		&r.TextoMarkdown, &r.LinkFatura, &fichasJSON,
	)
	if err != nil {
		return nil, err
	}
	if indTroca.Valid {
		v := indTroca.Int64 == 1
		r.IndicacaoTrocaMedidor = &v
	}
	// extrai fichas_confirmadas
	if fichasJSON != "" {
		var fa map[string]any
		if json.Unmarshal([]byte(fichasJSON), &fa) == nil {
			if arr, ok := fa["fichas_confirmadas"].([]any); ok {
				for _, x := range arr {
					if s, ok2 := x.(string); ok2 {
						r.FichasConfirmadas = append(r.FichasConfirmadas, s)
					}
				}
			}
		}
	}
	// Trunca texto_markdown se muito longo (gpt-5.4 limite)
	if len(r.TextoMarkdown) > 12000 {
		r.TextoMarkdown = r.TextoMarkdown[:12000] + "\n[...truncado]"
	}
	return &r, nil
}

// loadProximaFatura busca a próxima fatura cronologicamente para a mesma UC.
// Robusto a múltiplos formatos de mes_referencia ("YYYY-MM-DD", "MM/YYYY", "MMM/YYYY")
// e tolera data_leitura_atual NULL — usa o mes_referencia como fallback canônico.
func loadProximaFatura(db *sql.DB, uc, mesRef string) (*faturaMedidorRow, error) {
	if uc == "" || mesRef == "" {
		return nil, fmt.Errorf("UC ou mes_referencia vazios")
	}

	// Expressão SQL que converte mes_referencia em DATE canônica (1º dia do mês),
	// suportando "YYYY-MM-DD" e "MM/YYYY".
	const canonicalDateExpr = `
		COALESCE(
		  STR_TO_DATE(mes_referencia, '%Y-%m-%d'),
		  STR_TO_DATE(CONCAT('01/', mes_referencia), '%d/%m/%Y')
		)`

	q := fmt.Sprintf(`
		SELECT id FROM FATURA_DADOS_EXTRAIDOS
		WHERE codigo_uc = ?
		  AND %s > COALESCE(
		    STR_TO_DATE(?, '%%Y-%%m-%%d'),
		    STR_TO_DATE(CONCAT('01/', ?), '%%d/%%m/%%Y')
		  )
		ORDER BY %s ASC LIMIT 1`, canonicalDateExpr, canonicalDateExpr)

	var nextID int64
	if err := db.QueryRow(q, uc, mesRef, mesRef).Scan(&nextID); err != nil {
		return nil, err
	}
	return loadFaturaForMedidorAnalise(db, nextID)
}

func medidorAnalysisSystemPrompt() string {
	return `Você é um auditor técnico especialista em faturas de energia elétrica. Sua tarefa é
verificar se um apontamento de TROCA DE MEDIDOR (ficha F04) sinalizado pelo motor de regras
está realmente correto, comparando duas faturas consecutivas da mesma UC.

REGRAS PARA CONFIRMAR TROCA DE MEDIDOR (qualquer uma é suficiente):
1) numero_medidor da fatura apontada DIFERE do numero_medidor da próxima fatura.
2) indicacao_troca_medidor = true em qualquer das duas faturas.
3) Sequência de leituras descontínua: leit_atu_ativa da apontada NÃO bate com leit_ant_ativa da próxima
   (com tolerância de 0,1%) — exceto se houver justificativa explícita.
4) observacoes_fatura ou informacoes_operacionais mencionam troca/substituição/instalação de medidor.

REGRAS PARA REFUTAR (FALSO POSITIVO):
- Mesmo numero_medidor nas duas faturas E sequência de leituras contínua E nenhum evento/historico marcado.
- Apenas fim/início de período sem troca real (rollover de leitura por capacidade do display NÃO é troca).

FORMATO DE RESPOSTA (JSON estrito, sem markdown wrapper):
{
  "veredicto": "troca_real" | "falso_positivo" | "inconclusivo",
  "confianca": <0-100>,
  "justificativa": "<texto curto, 1-3 frases, com base nas regras acima>",
  "evidencias": ["<fato 1>", "<fato 2>"]
}

Regras de saída:
- Use exatamente uma das 3 strings de veredicto.
- "inconclusivo" só quando dados-chave (medidor ou leituras) faltam nas duas faturas.
- Cite números reais nas evidências (ex: "medidor 14097563 = 14097563", "leit_atu_ponta=12345, leit_ant_ponta_proxima=12350 difere 5 kWh").
- NÃO invente dados que não estão no contexto.`
}

func buildMedidorComparisonContext(a, b *faturaMedidorRow) string {
	var sb strings.Builder
	sb.WriteString("# DADOS PARA AUDITORIA\n\n")

	sb.WriteString("## Fatura APONTADA (com F04)\n")
	dumpFaturaToContext(&sb, a)

	sb.WriteString("\n## Fatura PRÓXIMA (cronologicamente posterior)\n")
	dumpFaturaToContext(&sb, b)

	sb.WriteString("\n## SUA TAREFA\n")
	sb.WriteString("Aplique as regras do prompt e responda em JSON puro o veredicto sobre o apontamento de troca de medidor.\n")
	return sb.String()
}

func dumpFaturaToContext(sb *strings.Builder, r *faturaMedidorRow) {
	if r == nil {
		sb.WriteString("(sem dados)\n")
		return
	}
	w := func(k, v string) {
		if strings.TrimSpace(v) != "" {
			sb.WriteString(fmt.Sprintf("- **%s:** %s\n", k, v))
		}
	}
	wn := func(k string, v float64) {
		if v != 0 {
			sb.WriteString(fmt.Sprintf("- **%s:** %.2f\n", k, v))
		}
	}
	wb := func(k string, v *bool) {
		if v != nil {
			sb.WriteString(fmt.Sprintf("- **%s:** %v\n", k, *v))
		}
	}
	w("ID FDE", strconv.FormatInt(r.ID, 10))
	w("UC", r.CodigoUC)
	w("Mes Referência", r.MesReferencia)
	w("Numero Medidor", r.NumeroMedidor)
	w("Numero Fatura", r.NumeroFatura)
	w("Data Leitura Anterior", r.DataLeituraAnterior)
	w("Data Leitura Atual", r.DataLeituraAtual)
	if r.DiasFaturados > 0 {
		sb.WriteString(fmt.Sprintf("- **Dias Faturados:** %d\n", r.DiasFaturados))
	}
	wn("Leit Ant Ativa Ponta", r.LeitAntAtivaPonta)
	wn("Leit Atu Ativa Ponta", r.LeitAtuAtivaPonta)
	wn("Leit Ant Ativa FPonta", r.LeitAntAtivaFPonta)
	wn("Leit Atu Ativa FPonta", r.LeitAtuAtivaFPonta)
	wn("Consumo Ponta kWh", r.ConsumoAtivoPontaKwh)
	wn("Consumo FPonta kWh", r.ConsumoAtivoFPontaKwh)
	wb("indicacao_troca_medidor", r.IndicacaoTrocaMedidor)
	w("Observações da Fatura", r.ObservacoesFatura)
	w("Informações Operacionais", r.InformacoesOperacionais)
	if len(r.FichasConfirmadas) > 0 {
		sb.WriteString(fmt.Sprintf("- **Fichas Confirmadas:** %s\n", strings.Join(r.FichasConfirmadas, ", ")))
	}
	if r.TextoMarkdown != "" {
		sb.WriteString("\n### Texto da fatura (extraído)\n```\n")
		// Limita o markdown a 4000 caracteres para não estourar o contexto
		t := r.TextoMarkdown
		if len(t) > 4000 {
			t = t[:4000] + "\n[...truncado]"
		}
		sb.WriteString(t)
		sb.WriteString("\n```\n")
	}
}

// parseMedidorVerdict tenta extrair JSON da resposta da IA.
// Tolera respostas com markdown ```json ``` ou texto ao redor.
func parseMedidorVerdict(raw string) map[string]any {
	out := map[string]any{
		"veredicto":     "inconclusivo",
		"confianca":     0,
		"justificativa": "",
		"evidencias":    []string{},
	}
	t := strings.TrimSpace(raw)
	// Remove blocos ```json
	t = strings.TrimPrefix(t, "```json")
	t = strings.TrimPrefix(t, "```JSON")
	t = strings.TrimPrefix(t, "```")
	t = strings.TrimSuffix(t, "```")
	t = strings.TrimSpace(t)

	// Tenta achar o primeiro { e último }
	start := strings.Index(t, "{")
	end := strings.LastIndex(t, "}")
	if start >= 0 && end > start {
		t = t[start : end+1]
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(t), &parsed); err == nil {
		for k, v := range parsed {
			out[k] = v
		}
	} else {
		// Não conseguiu parsear: devolve raw como justificativa
		out["justificativa"] = raw
	}
	return out
}

// CompararLeiturasUCHandler — para cada fatura com F05 (quebra de continuidade),
// baixa o PDF dela e o da fatura imediatamente ANTERIOR cronologicamente, manda
// pra IA extrair as leituras anterior/atual de ambos e compara: a leitura ATUAL
// da fatura anterior precisa bater com a leitura ANTERIOR da fatura atual. Se
// bate (com tolerância pequena), F05 é falso positivo de extração; se diverge,
// confirma a quebra de continuidade.
//
// GET /api/v1/faturas/uc/:uc/comparar-leituras
func CompararLeiturasUCHandler(c *gin.Context) {
	uc := strings.TrimSpace(c.Param("uc"))
	if uc == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "uc obrigatória"})
		return
	}

	db := database.DB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}

	// Lista todas as faturas da UC com flag F05
	rows, err := db.Query(`
		SELECT id, COALESCE(mes_referencia,''), COALESCE(link_fatura,'')
		FROM FATURA_DADOS_EXTRAIDOS
		WHERE codigo_uc = ?
		  AND COALESCE(fichas_apontadas->>'$.motor_regras_sql.flag_f05', '0') = '1'
		ORDER BY COALESCE(
		  STR_TO_DATE(mes_referencia, '%Y-%m-%d'),
		  STR_TO_DATE(CONCAT('01/', mes_referencia), '%d/%m/%Y')
		) ASC`, uc)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao listar apontamentos: " + err.Error()})
		return
	}
	defer rows.Close()

	type apontada struct {
		ID     int64
		MesRef string
		Link   string
	}
	var apontadas []apontada
	for rows.Next() {
		var a apontada
		if err := rows.Scan(&a.ID, &a.MesRef, &a.Link); err == nil {
			apontadas = append(apontadas, a)
		}
	}
	rows.Close()

	// Cache: id_fatura → leituras (evita IA 2x na mesma fatura)
	cacheLeituras := make(map[int64]leiturasFatura)
	getLeiturasIA := func(ctx context.Context, id int64, link string) (leiturasFatura, error) {
		if v, ok := cacheLeituras[id]; ok {
			return v, nil
		}
		l, err := extrairLeiturasComIA(ctx, link)
		if err != nil {
			return leiturasFatura{}, err
		}
		cacheLeituras[id] = l
		return l, nil
	}

	type comparacao struct {
		IDApontada       int64   `json:"id_apontada"`
		MesApontada      string  `json:"mes_apontada"`
		LeituraAnteriorAtual float64 `json:"leitura_anterior_atual"` // leitura_anterior da fatura atual
		IDAnterior       int64   `json:"id_anterior"`
		MesAnterior      string  `json:"mes_anterior"`
		LeituraAtualAnterior float64 `json:"leitura_atual_anterior"` // leitura_atual da fatura anterior
		Diferenca        float64 `json:"diferenca"`
		Veredicto        string  `json:"veredicto"`
		Motivo           string  `json:"motivo"`
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
	defer cancel()

	comparacoes := make([]comparacao, 0, len(apontadas))

	// Tolerância: leituras "batem" se diferença < 1 unidade (números de 5+ dígitos
	// não devem ter ruído fracionário relevante).
	const tolerancia = 1.0

	for _, ap := range apontadas {
		// Busca fatura ANTERIOR cronológica
		var prevID int64
		var prevMes, prevLink string
		errPrev := db.QueryRow(`
			SELECT id, COALESCE(mes_referencia,''), COALESCE(link_fatura,'')
			FROM FATURA_DADOS_EXTRAIDOS
			WHERE codigo_uc = ?
			  AND COALESCE(
			    STR_TO_DATE(mes_referencia, '%Y-%m-%d'),
			    STR_TO_DATE(CONCAT('01/', mes_referencia), '%d/%m/%Y')
			  ) < COALESCE(
			    STR_TO_DATE(?, '%Y-%m-%d'),
			    STR_TO_DATE(CONCAT('01/', ?), '%d/%m/%Y')
			  )
			ORDER BY COALESCE(
			  STR_TO_DATE(mes_referencia, '%Y-%m-%d'),
			  STR_TO_DATE(CONCAT('01/', mes_referencia), '%d/%m/%Y')
			) DESC LIMIT 1`, uc, ap.MesRef, ap.MesRef).Scan(&prevID, &prevMes, &prevLink)

		cmp := comparacao{
			IDApontada:  ap.ID,
			MesApontada: ap.MesRef,
		}

		if errPrev != nil {
			cmp.Veredicto = "sem_anterior"
			cmp.Motivo = "Não há fatura anterior cadastrada (primeiro mês do histórico)"
			comparacoes = append(comparacoes, cmp)
			continue
		}

		cmp.IDAnterior = prevID
		cmp.MesAnterior = prevMes

		// Extrai leituras das duas via IA
		lAtual, errA := getLeiturasIA(ctx, ap.ID, ap.Link)
		lPrev, errB := getLeiturasIA(ctx, prevID, prevLink)

		cmp.LeituraAnteriorAtual = lAtual.LeituraAnterior
		cmp.LeituraAtualAnterior = lPrev.LeituraAtual

		switch {
		case errA != nil && errB != nil:
			cmp.Veredicto = "sem_dados"
			cmp.Motivo = "IA não conseguiu ler as leituras nas duas faturas"
		case errA != nil:
			cmp.Veredicto = "sem_dados"
			cmp.Motivo = fmt.Sprintf("IA não leu leituras da apontada (%s): %s", ap.MesRef, errA.Error())
		case errB != nil:
			cmp.Veredicto = "sem_dados"
			cmp.Motivo = fmt.Sprintf("IA não leu leituras da anterior (%s): %s", prevMes, errB.Error())
		case !lAtual.Encontrado || !lPrev.Encontrado:
			cmp.Veredicto = "sem_dados"
			cmp.Motivo = "IA não encontrou as leituras em uma das faturas"
		default:
			diff := lAtual.LeituraAnterior - lPrev.LeituraAtual
			cmp.Diferenca = diff
			if diff < 0 {
				diff = -diff
			}
			if diff < tolerancia {
				cmp.Veredicto = "falso_positivo"
				cmp.Motivo = fmt.Sprintf("Leituras batem: %.0f → %.0f (sem quebra)", lPrev.LeituraAtual, lAtual.LeituraAnterior)
			} else {
				cmp.Veredicto = "quebra_real"
				cmp.Motivo = fmt.Sprintf("Quebra real: anterior terminou em %.0f, atual começa em %.0f (Δ %.0f)",
					lPrev.LeituraAtual, lAtual.LeituraAnterior, cmp.Diferenca)
			}
		}

		comparacoes = append(comparacoes, cmp)
	}

	c.JSON(http.StatusOK, gin.H{
		"uc":                 uc,
		"total_apontamentos": len(apontadas),
		"comparacoes":        comparacoes,
	})
}

// AprovarF04Handler marca o apontamento F04 como aprovado pelo usuário.
// Grava em fichas_apontadas.f04_aprovado = true (mantém o flag_f04 = 1).
// POST /api/v1/faturas/:id/f04/aprovar
func AprovarF04Handler(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}
	res, err := sqlDB.ExecContext(c.Request.Context(), `
		UPDATE FATURA_DADOS_EXTRAIDOS
		SET fichas_apontadas = JSON_SET(
		    COALESCE(fichas_apontadas, JSON_OBJECT()),
		    '$.f04_aprovado', TRUE,
		    '$.f04_aprovado_em', ?
		)
		WHERE id = ?
	`, time.Now().UTC().Format(time.RFC3339), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao gravar: " + err.Error()})
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "fatura não encontrada"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": id, "f04_aprovado": true})
}

// DesaprovarF04Handler remove o apontamento F04: zera flag_f04, limpa
// detalhe_f04, marca f04_aprovado=false e remove "F04" das fichas aplicadas.
// POST /api/v1/faturas/:id/f04/desaprovar
func DesaprovarF04Handler(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}
	// Lê fichas_aplicadas atual para tirar "F04" da lista (formato "F01 | F02 | F04")
	var fichasAtuaisRaw sql.NullString
	if err := sqlDB.QueryRowContext(c.Request.Context(),
		`SELECT COALESCE(fichas_apontadas->>'$.motor_regras_sql.fichas_aplicadas', '') FROM FATURA_DADOS_EXTRAIDOS WHERE id = ?`,
		id,
	).Scan(&fichasAtuaisRaw); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao ler fatura: " + err.Error()})
		return
	}
	novaFichas := removerFichaDaLista(fichasAtuaisRaw.String, "F04")

	res, err := sqlDB.ExecContext(c.Request.Context(), `
		UPDATE FATURA_DADOS_EXTRAIDOS
		SET fichas_apontadas = JSON_SET(
		    COALESCE(fichas_apontadas, JSON_OBJECT()),
		    '$.motor_regras_sql.flag_f04', 0,
		    '$.motor_regras_sql.detalhe_f04', NULL,
		    '$.motor_regras_sql.troca_medidor', NULL,
		    '$.motor_regras_sql.fichas_aplicadas', ?,
		    '$.f04_aprovado', FALSE,
		    '$.f04_desaprovado_em', ?
		)
		WHERE id = ?
	`, novaFichas, time.Now().UTC().Format(time.RFC3339), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao gravar: " + err.Error()})
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "fatura não encontrada"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": id, "f04_removido": true, "fichas_aplicadas": novaFichas})
}

// removerFichaDaLista tira "F04" (ou outra ficha) de uma string "F01 | F02 | F04".
func removerFichaDaLista(lista, ficha string) string {
	if strings.TrimSpace(lista) == "" {
		return ""
	}
	parts := strings.Split(lista, "|")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		t := strings.TrimSpace(p)
		if t == "" || strings.EqualFold(t, ficha) {
			continue
		}
		out = append(out, t)
	}
	return strings.Join(out, " | ")
}
