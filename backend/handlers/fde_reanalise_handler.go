package handlers

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// httpClient simples para baixar o PDF do link_fatura.
var pdfDownloadClient = &http.Client{Timeout: 60 * time.Second}

// ReanaliseFDEHandler — reanalise IA com TODOS os dados da linha FDE como contexto.
// Usa GPT-5.4 (via callAisureOpenAIPDF) e anexa o PDF da fatura quando disponível.
//
// POST /api/v1/faturas/:id/reanalise-fde
func ReanaliseFDEHandler(c *gin.Context) {
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

	// Lê TUDO da linha de FDE pelo id
	type fdeRow struct {
		UID              sql.NullString
		CodigoUC         sql.NullString
		MesReferencia    sql.NullString
		DistribuidoraStr sql.NullString
		ClienteStr       sql.NullString
		CodEmpresa       sql.NullInt64
		ValorTotal       sql.NullFloat64
		LinkFatura       sql.NullString

		TextoPlumber  sql.NullString
		TextoMarkdown sql.NullString
		TextoOCR      sql.NullString
		AnaliseIA     sql.NullString
		FichasApontadas sql.NullString

		ConsumoP  sql.NullFloat64
		ConsumoFP sql.NullFloat64
		LeitAntP  sql.NullFloat64
		LeitAtuP  sql.NullFloat64
		LeitAntFP sql.NullFloat64
		LeitAtuFP sql.NullFloat64
		ConstK    sql.NullFloat64
		Medidor   sql.NullString

		GrupoTar       sql.NullString
		SubgrupoTar    sql.NullString
		Modalidade     sql.NullString
		Tensao         sql.NullString
		Classe         sql.NullString
		HistoricoJSON  sql.NullString
	}

	var fr fdeRow
	rowErr := sqlDB.QueryRow(`
		SELECT
			uid, codigo_uc, mes_referencia, distribuidora, nome_cliente, cod_empresa,
			valor_total_fatura, link_fatura,
			texto_plumber, texto_markdown, texto_ocr, analise_ia, fichas_apontadas,
			consumo_ativo_ponta_kwh, consumo_ativo_fponta_kwh,
			leit_ant_ativa_ponta, leit_atu_ativa_ponta,
			leit_ant_ativa_fponta, leit_atu_ativa_fponta,
			constante_k, numero_medidor,
			grupo_tarifario, subgrupo_tarifario, modalidade_tarifaria,
			tensao_fornecimento, classe_consumidor, historico_consumo_12_meses
		FROM FATURA_DADOS_EXTRAIDOS WHERE id = ?`, id,
	).Scan(
		&fr.UID, &fr.CodigoUC, &fr.MesReferencia, &fr.DistribuidoraStr, &fr.ClienteStr, &fr.CodEmpresa,
		&fr.ValorTotal, &fr.LinkFatura,
		&fr.TextoPlumber, &fr.TextoMarkdown, &fr.TextoOCR, &fr.AnaliseIA, &fr.FichasApontadas,
		&fr.ConsumoP, &fr.ConsumoFP,
		&fr.LeitAntP, &fr.LeitAtuP, &fr.LeitAntFP, &fr.LeitAtuFP,
		&fr.ConstK, &fr.Medidor,
		&fr.GrupoTar, &fr.SubgrupoTar, &fr.Modalidade,
		&fr.Tensao, &fr.Classe, &fr.HistoricoJSON,
	)
	if rowErr != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("fatura não encontrada em FATURA_DADOS_EXTRAIDOS: %v", rowErr)})
		return
	}

	// Parse fichas_apontadas → extrai motor_regras_sql + decisão atual
	var fichasMap map[string]interface{}
	if fr.FichasApontadas.Valid && fr.FichasApontadas.String != "" {
		_ = json.Unmarshal([]byte(fr.FichasApontadas.String), &fichasMap)
	}

	// Monta o contexto para a IA
	ctxBuilder := strings.Builder{}
	addLine := func(label, val string) {
		if val != "" {
			ctxBuilder.WriteString(fmt.Sprintf("%s: %s\n", label, val))
		}
	}

	ctxBuilder.WriteString("=== IDENTIFICAÇÃO ===\n")
	addLine("ID FDE", strconv.FormatInt(id, 10))
	addLine("UID", nullStr(fr.UID))
	addLine("UC", nullStr(fr.CodigoUC))
	addLine("Mês Referência", nullStr(fr.MesReferencia))
	addLine("Cliente", nullStr(fr.ClienteStr))
	addLine("Distribuidora", nullStr(fr.DistribuidoraStr))
	addLine("Grupo Tarifário", nullStr(fr.GrupoTar))
	addLine("Subgrupo", nullStr(fr.SubgrupoTar))
	addLine("Modalidade", nullStr(fr.Modalidade))
	addLine("Tensão", nullStr(fr.Tensao))
	addLine("Classe", nullStr(fr.Classe))
	addLine("Medidor", nullStr(fr.Medidor))
	if fr.ValorTotal.Valid {
		addLine("Valor Total Fatura", fmt.Sprintf("R$ %.2f", fr.ValorTotal.Float64))
	}
	addLine("Link PDF", nullStr(fr.LinkFatura))

	ctxBuilder.WriteString("\n=== CAMPOS DE MEDIÇÃO ===\n")
	if fr.ConsumoP.Valid {
		addLine("Consumo Ponta (kWh)", fmt.Sprintf("%.3f", fr.ConsumoP.Float64))
	}
	if fr.ConsumoFP.Valid {
		addLine("Consumo Fora-Ponta (kWh)", fmt.Sprintf("%.3f", fr.ConsumoFP.Float64))
	}
	if fr.LeitAntP.Valid && fr.LeitAtuP.Valid {
		addLine("Leitura Ponta", fmt.Sprintf("anterior=%.3f, atual=%.3f", fr.LeitAntP.Float64, fr.LeitAtuP.Float64))
	}
	if fr.LeitAntFP.Valid && fr.LeitAtuFP.Valid {
		addLine("Leitura FP", fmt.Sprintf("anterior=%.3f, atual=%.3f", fr.LeitAntFP.Float64, fr.LeitAtuFP.Float64))
	}
	if fr.ConstK.Valid {
		addLine("Constante K", fmt.Sprintf("%.5f", fr.ConstK.Float64))
	}

	if fr.HistoricoJSON.Valid && fr.HistoricoJSON.String != "" && fr.HistoricoJSON.String != "null" {
		ctxBuilder.WriteString("\n=== HISTÓRICO 12 MESES (extraído pela IA antes) ===\n")
		ctxBuilder.WriteString(truncate(fr.HistoricoJSON.String, 1500))
		ctxBuilder.WriteString("\n")
	}

	if motor, ok := fichasMap["motor_regras_sql"].(map[string]interface{}); ok {
		ctxBuilder.WriteString("\n=== MOTOR DE REGRAS SQL (deterministico) ===\n")
		mb, _ := json.MarshalIndent(motor, "", "  ")
		ctxBuilder.WriteString(string(mb))
		ctxBuilder.WriteString("\n")
	}

	if fichasMap != nil {
		decisaoAtual := map[string]interface{}{
			"decisao_final":            fichasMap["decisao_final"],
			"fichas_confirmadas":       fichasMap["fichas_confirmadas"],
			"percentual_ressarcimento": fichasMap["percentual_ressarcimento"],
			"justificativa":            fichasMap["justificativa"],
			"justificativa_humana":     fichasMap["justificativa_humana"],
			"auditado_por":             fichasMap["auditado_por"],
		}
		ctxBuilder.WriteString("\n=== DECISÃO IA/HUMANA ATUAL (você pode contradizer) ===\n")
		mb, _ := json.MarshalIndent(decisaoAtual, "", "  ")
		ctxBuilder.WriteString(string(mb))
		ctxBuilder.WriteString("\n")
	}

	if fr.TextoPlumber.Valid && fr.TextoPlumber.String != "" {
		ctxBuilder.WriteString("\n=== TEXTO PLUMBER (extração estruturada do PDF) ===\n")
		ctxBuilder.WriteString(truncate(fr.TextoPlumber.String, 6000))
		ctxBuilder.WriteString("\n")
	}
	if fr.TextoMarkdown.Valid && fr.TextoMarkdown.String != "" {
		ctxBuilder.WriteString("\n=== TEXTO MARKDOWN ===\n")
		ctxBuilder.WriteString(truncate(fr.TextoMarkdown.String, 4000))
		ctxBuilder.WriteString("\n")
	}
	if fr.TextoOCR.Valid && fr.TextoOCR.String != "" {
		ctxBuilder.WriteString("\n=== TEXTO OCR (PaddleOCR) ===\n")
		ctxBuilder.WriteString(truncate(fr.TextoOCR.String, 4000))
		ctxBuilder.WriteString("\n")
	}

	systemPrompt := `Você é um auditor especializado em faturas de energia elétrica brasileiras.

Você recebe TODOS os dados que o sistema tem desta fatura:
- Identificação completa (UC, mês, cliente, distribuidora, classe tarifária)
- Campos de medição (leituras, constante, consumos)
- Histórico de 12 meses
- Resultado do MOTOR SQL (regras deterministicas F01-F05)
- Decisão atual da IA e/ou auditoria humana
- 3 extrações de texto (Plumber, Markdown, OCR)
- PDF anexado (quando disponível)

Aplique APENAS as fichas F01-F05 (F06-F14 estão desativadas no escopo atual):
- F01: divergência de fórmula  ((LeitAtu-LeitAnt)*Const ≠ kWh)
- F02: desvio estatístico de consumo (dif_pct ≥ +100% sobre média histórica real)
- F03: acúmulo / faturamento por média (ART.323/ART.113 explícito OU 4 de 5 meses fixos + pico ≥+100%)
- F04: troca de medidor + inconsistência (medidor diferente do mês anterior + desvio)
- F05: quebra de continuidade (LeitAtu(N-1) ≠ LeitAnt(N), sem erro de escala)

Use o motor SQL como ÂNCORA — você pode contradizer com justificativa robusta, mas
nunca confirmar uma ficha refutada pelo motor sem evidência documental específica.

Responda EXATAMENTE neste formato JSON (sem markdown, sem texto antes ou depois):

{
  "decisao_final": "CONFIRMADO" | "REFUTADO" | "INCONCLUSIVO",
  "ficha_principal": "F01" | "F02" | "F03" | "F04" | "F05" | "",
  "fichas_confirmadas": ["F01", ...],
  "confianca_final": 0-100,
  "percentual_ressarcimento": 0-100,
  "justificativa": "explicação técnica completa com números (mostre os cálculos)",
  "recomendacao": "próximo passo operacional"
}`

	userMsg := "Analise esta fatura aplicando as fichas F01-F05 e retorne o JSON estruturado.\n\n" + ctxBuilder.String()

	// Tenta baixar o PDF para anexar
	pdfBase64 := ""
	pdfName := ""
	if fr.LinkFatura.Valid {
		link := strings.TrimSpace(fr.LinkFatura.String)
		if link != "" {
			b64, name := baixarPDFBase64(link)
			pdfBase64 = b64
			pdfName = name
		}
	}

	ctxIA, cancel := context.WithTimeout(c.Request.Context(), 180*time.Second)
	defer cancel()

	var resposta string
	var aiErr error
	if pdfBase64 != "" {
		resposta, aiErr = callAisureOpenAIPDF(ctxIA, userMsg, "", pdfBase64, pdfName, systemPrompt)
	} else {
		resposta, aiErr = callAisureOpenAI(ctxIA, nil, userMsg, "", systemPrompt)
	}
	if aiErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("erro na IA: %v", aiErr)})
		return
	}

	// Parse JSON da resposta
	novaDecisao := parseRespostaJSON(resposta)
	if novaDecisao == nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":    "IA retornou formato inválido",
			"resposta": resposta,
		})
		return
	}

	// Atualiza fichas_apontadas: preserva motor_regras_sql, justificativa_humana antiga, etc.
	// Sobrescreve apenas os campos da decisão IA
	if fichasMap == nil {
		fichasMap = make(map[string]interface{})
	}
	fichasMap["decisao_final"] = novaDecisao["decisao_final"]
	fichasMap["ficha_principal"] = novaDecisao["ficha_principal"]
	fichasMap["fichas_confirmadas"] = novaDecisao["fichas_confirmadas"]
	fichasMap["confianca_final"] = novaDecisao["confianca_final"]
	fichasMap["percentual_ressarcimento"] = novaDecisao["percentual_ressarcimento"]
	fichasMap["justificativa"] = novaDecisao["justificativa"]
	fichasMap["recomendacao"] = novaDecisao["recomendacao"]
	fichasMap["reanalise_em"] = time.Now().Format(time.RFC3339)
	fichasMap["reanalise_modelo"] = "gpt-5.4"

	novoJSON, _ := json.Marshal(fichasMap)
	now := time.Now()
	if _, err := sqlDB.Exec(
		"UPDATE FATURA_DADOS_EXTRAIDOS SET fichas_apontadas = ?, resultado_em = ?, resultado_analises_final = ? WHERE id = ?",
		string(novoJSON), now, resposta, id,
	); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("erro ao gravar resultado: %v", err)})
		return
	}

	// ⭐ Audit trail: registra reanálise em FATURA_REANALISES
	// (não bloqueia resposta se falhar — só loga)
	go func() {
		fichasJSON, _ := json.Marshal(novaDecisao["fichas_confirmadas"])

		// Snapshot dos campos v19 NO MOMENTO da reanálise (pra histórico)
		var v19Score sql.NullInt64
		var v19Alerta, v19StatusPassib sql.NullString
		var v19Total sql.NullFloat64
		_ = sqlDB.QueryRow(`
			SELECT
				extracao_score_confianca,
				parcela_art323_alerta,
				parcela_art323_total_estimado_rs,
				CASE
					WHEN COALESCE(parcela_art323_alerta, '') = 'PARCELAMENTO_SOBREPOSTO'
						THEN 'PARCELAMENTO_SOBREPOSTO'
					WHEN COALESCE(compensacao_ja_aplicada, 0) = 1
					  OR COALESCE(devolucao_em_dobro_ativa, 0) = 1
						THEN 'COMPENSADO_NEUTRALIZADO'
					WHEN COALESCE(ciclo_infinito_art113, 0) = 1
						THEN 'PASSIVEL_CICLO_INFINITO'
					WHEN COALESCE(parcela_art323_alerta, '') = 'PARCELAMENTO'
					  OR COALESCE(parcela_art323_y, 0) > 0
						THEN 'TEM_PARCELAMENTO'
					ELSE NULL
				END
			FROM FATURA_DADOS_EXTRAIDOS WHERE id = ?
		`, id).Scan(&v19Score, &v19Alerta, &v19Total, &v19StatusPassib)

		// Usuário que disparou (do contexto do request)
		var usuarioID interface{} = nil
		var usuarioNome interface{} = nil
		if userID, ok := c.Get("user_id"); ok {
			usuarioID = userID
		}
		if userName, ok := c.Get("user_name"); ok {
			usuarioNome = userName
		}

		_, errIns := sqlDB.Exec(`
			INSERT INTO FATURA_REANALISES
			  (fatura_id, decisao_final, ficha_principal, fichas_confirmadas,
			   confianca_final, percentual_ressarcimento, justificativa, recomendacao,
			   modelo, pdf_anexado, resposta_crua,
			   v19_score_confianca, v19_parcela_alerta, v19_total_estimado,
			   v19_status_passibilidade,
			   usuario_id, usuario_nome)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
			id,
			fmt.Sprint(novaDecisao["decisao_final"]),
			fmt.Sprint(novaDecisao["ficha_principal"]),
			string(fichasJSON),
			toIntOrNil(novaDecisao["confianca_final"]),
			toFloatOrNil(novaDecisao["percentual_ressarcimento"]),
			fmt.Sprint(novaDecisao["justificativa"]),
			fmt.Sprint(novaDecisao["recomendacao"]),
			"gpt-5.4",
			boolToInt01(pdfBase64 != ""),
			resposta,
			auditNullInt(v19Score),
			auditNullStr(v19Alerta),
			auditNullFloat(v19Total),
			auditNullStr(v19StatusPassib),
			usuarioID,
			usuarioNome,
		)
		if errIns != nil {
			fmt.Printf("[reanalise-fde] WARN: falha ao registrar histórico: %v\n", errIns)
		}
	}()

	c.JSON(http.StatusOK, gin.H{
		"id":             id,
		"decisao":        novaDecisao,
		"resposta_bruta": resposta,
		"pdf_anexado":    pdfBase64 != "",
	})
}

// Helpers locais (conversão segura de tipos)
func toIntOrNil(v interface{}) interface{} {
	if v == nil { return nil }
	switch x := v.(type) {
	case float64: return int(x)
	case int:     return x
	case string:
		var n int
		if _, err := fmt.Sscanf(x, "%d", &n); err == nil { return n }
	}
	return nil
}
func toFloatOrNil(v interface{}) interface{} {
	if v == nil { return nil }
	switch x := v.(type) {
	case float64: return x
	case int:     return float64(x)
	case string:
		var f float64
		if _, err := fmt.Sscanf(x, "%f", &f); err == nil { return f }
	}
	return nil
}
func boolToInt01(b bool) int { if b { return 1 }; return 0 }
func auditNullInt(n sql.NullInt64) interface{}     { if n.Valid { return n.Int64 }; return nil }
func auditNullStr(n sql.NullString) interface{}    { if n.Valid && n.String != "" { return n.String }; return nil }
func auditNullFloat(n sql.NullFloat64) interface{} { if n.Valid { return n.Float64 }; return nil }

// RejeitarFaturaFDEHandler — marca a fatura como REFUTADO (lixeira do front).
//
// POST /api/v1/faturas/:id/rejeitar-fde
// Body opcional: { "motivo": "string" }
func RejeitarFaturaFDEHandler(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}

	var body struct {
		Motivo string `json:"motivo"`
	}
	_ = c.ShouldBindJSON(&body)
	motivo := strings.TrimSpace(body.Motivo)
	if motivo == "" {
		motivo = "rejeitado pelo usuario via UI"
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

	// Verifica se a fatura existe
	var existeID int64
	if err := sqlDB.QueryRow("SELECT id FROM FATURA_DADOS_EXTRAIDOS WHERE id = ?", id).Scan(&existeID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "fatura não encontrada"})
		return
	}

	// Atualiza fichas_apontadas via JSON_SET
	res, err := sqlDB.Exec(`
		UPDATE FATURA_DADOS_EXTRAIDOS
		SET fichas_apontadas = JSON_SET(
			COALESCE(fichas_apontadas, '{}'),
			'$.decisao_final', 'REFUTADO',
			'$.percentual_ressarcimento', 0,
			'$.ficha_principal', '',
			'$.justificativa_humana', CONCAT(
				COALESCE(fichas_apontadas->>'$.justificativa_humana', ''),
				CASE WHEN COALESCE(fichas_apontadas->>'$.justificativa_humana', '') = '' THEN '' ELSE ' | ' END,
				?
			),
			'$.auditado_por', 'humano-claude',
			'$.auditado_em', NOW()
		),
		resultado_em = NOW()
		WHERE id = ?`,
		"REJEITADO PELO USUARIO: "+motivo, id,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("erro ao rejeitar: %v", err)})
		return
	}
	rows, _ := res.RowsAffected()

	c.JSON(http.StatusOK, gin.H{
		"id":               id,
		"rows_affected":    rows,
		"decisao_final":    "REFUTADO",
		"motivo":           motivo,
	})
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func nullStr(s sql.NullString) string {
	if !s.Valid {
		return ""
	}
	return s.String
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func baixarPDFBase64(url string) (string, string) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return "", ""
	}
	resp, err := pdfDownloadClient.Do(req)
	if err != nil {
		return "", ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", ""
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 10*1024*1024)) // 10 MB max
	if err != nil || len(body) == 0 {
		return "", ""
	}
	name := "fatura.pdf"
	if idx := strings.LastIndex(url, "/"); idx >= 0 && idx < len(url)-1 {
		seg := url[idx+1:]
		if q := strings.Index(seg, "?"); q >= 0 {
			seg = seg[:q]
		}
		if seg != "" {
			name = seg
		}
	}
	return base64.StdEncoding.EncodeToString(body), name
}

// parseRespostaJSON tenta extrair um objeto JSON da resposta da IA.
// Aceita JSON puro ou um bloco com markdown ```json ... ```.
func parseRespostaJSON(s string) map[string]interface{} {
	s = strings.TrimSpace(s)
	// Tenta direto
	var m map[string]interface{}
	if json.Unmarshal([]byte(s), &m) == nil {
		return m
	}
	// Procura primeira { e última }
	first := strings.Index(s, "{")
	last := strings.LastIndex(s, "}")
	if first >= 0 && last > first {
		candidato := s[first : last+1]
		if json.Unmarshal([]byte(candidato), &m) == nil {
			return m
		}
	}
	return nil
}
