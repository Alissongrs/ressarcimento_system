package handlers

// Auditoria por IA de uma fatura (FATURA_DADOS_EXTRAIDOS):
//   POST /api/v1/faturas/:id/auditar  → gpt-5.4-mini audita os valores; grava em FATURA_REANALISES
//   GET  /api/v1/faturas/:id/chat     → histórico do chat (AI_CHAT_SESSIONS/MESSAGES)
//   POST /api/v1/faturas/:id/chat     → gpt-5.4-nano responde; grava as mensagens
//
// Modelos liberados: gpt-5.4-mini (auditoria) e gpt-5.4-nano (chat). Chamada direta ao
// chat/completions da OpenAI (mesma chave OPENAI_API_KEY do .env). Sem temperature — os
// modelos gpt-5.4 rejeitam temperature != 1.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

const (
	modeloAuditoria = "gpt-5.4-mini"
	modeloChat      = "gpt-5.4-nano"
)

// Timeout ALTO no cliente HTTP (backstop). O corte real é feito por-rota via
// context.WithTimeout (chat/auditar ~120s, v19 5min). Antes o cliente tinha
// Timeout=120s fixo, que cortava a análise v19 aos 2min e mentia "levou 5min".
var iaHTTP = &http.Client{Timeout: 6 * time.Minute}

// Blobs/textos pesados que NÃO vão pro payload da IA (economia de token + irrelevantes).
var iaColsExcluir = map[string]bool{
	"texto_plumber": true, "texto_markdown": true, "texto_ocr": true, "texto_bbox": true,
	"analise_ia": true, "resultado_analises_final": true, "extracao_raw_json": true,
	"metadados_fatura": true, "validacao_deterministica": true, "grandezas_contratadas_json": true,
}

// carregarFaturaCompacta lê a fatura por id e devolve um mapa (sem os blobs pesados),
// já pronto pra virar o JSON de contexto da IA.
func carregarFaturaCompacta(id string) (map[string]interface{}, error) {
	return carregarFaturaCompactaT(id, "")
}

// carregarFaturaCompactaT — idem, mas parametriza a TABELA por fonte (Acer). fonte vazio = FDE.
func carregarFaturaCompactaT(id, fonte string) (map[string]interface{}, error) {
	db := database.GormDB_App
	if db == nil {
		return nil, fmt.Errorf("banco indisponível")
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	tabela := "FATURA_DADOS_EXTRAIDOS"
	if fonte == "acer" {
		tabela = "FATURA_ACER_DADOS_EXTRAIDOS"
	}
	rows, err := sqlDB.Query("SELECT * FROM "+tabela+" WHERE id = ? LIMIT 1", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	if !rows.Next() {
		return nil, sql.ErrNoRows
	}
	vals := make([]interface{}, len(cols))
	ptrs := make([]interface{}, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		return nil, err
	}
	out := make(map[string]interface{}, len(cols))
	for i, col := range cols {
		if iaColsExcluir[col] {
			continue
		}
		v := vals[i]
		if b, ok := v.([]byte); ok {
			s := string(b)
			if s != "" && s != "null" {
				out[col] = s
			}
		} else if v != nil {
			out[col] = v
		}
	}
	return out, nil
}

func chamarOpenAIChat(ctx context.Context, modelo, system string, msgs []map[string]string) (string, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return "", fmt.Errorf("OPENAI_API_KEY não definido")
	}
	all := make([]map[string]string, 0, len(msgs)+1)
	all = append(all, map[string]string{"role": "system", "content": system})
	all = append(all, msgs...)
	buf, _ := json.Marshal(map[string]any{"model": modelo, "messages": all})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.openai.com/v1/chat/completions", bytes.NewReader(buf))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp, err := iaHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error map[string]any `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("openai %d: %v", resp.StatusCode, out.Error)
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("sem resposta da openai")
	}
	content := out.Choices[0].Message.Content
	if strings.TrimSpace(content) == "" {
		return "", fmt.Errorf("openai devolveu conteúdo vazio")
	}
	return content, nil
}

func usuarioIA(c *gin.Context) (int64, string) {
	var uid int64
	var nome string
	if v, ok := c.Get("userID"); ok {
		if n, ok2 := v.(int64); ok2 {
			uid = n
		}
	}
	if v, ok := c.Get("userName"); ok {
		if s, ok2 := v.(string); ok2 {
			nome = s
		}
	}
	return uid, nome
}

// AuditarValoresFatura — POST /api/v1/faturas/:id/auditar
func AuditarValoresFatura(c *gin.Context) {
	id := c.Param("id")
	fonteAcer := c.Query("fonte") // "acer" → lê/grava na tabela Acer (namespace de reanálise)
	fat, err := carregarFaturaCompactaT(id, fonteAcer)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "fatura não encontrada"})
		return
	}
	// Contexto opcional: o apontamento detectado pelo motor (consumo × média, desvio,
	// ressarcimento) — enviado pelo front pra IA CONFERIR se o erro procede.
	var body struct {
		Apontamento string `json:"apontamento"`
	}
	_ = c.ShouldBindJSON(&body)

	payload, _ := json.Marshal(fat)
	userContent := string(payload)
	if strings.TrimSpace(body.Apontamento) != "" {
		userContent += "\n\n=== APONTAMENTO LEVANTADO PELO MOTOR (confira se procede) ===\n" + body.Apontamento
	}

	system := "Você é auditor de faturas de energia elétrica. Foi levantado um POSSÍVEL ERRO / cobrança indevida nesta fatura. " +
		"Sua tarefa é CONFERIR se o apontamento procede, em PT-BR, objetivo:\n" +
		"1) O consumo do mês realmente destoa da média histórica? (confira com o histórico do JSON)\n" +
		"2) O valor total confere com itens + tributos? Há cobrança acima do documento fiscal (SEFAZ)?\n" +
		"3) O ressarcimento estimado é plausível diante do desvio?\n" +
		"4) VEREDITO: comece a resposta com UMA das linhas em maiúsculas — 'ERRO CONFIRMADO', 'SEM ERRO' ou 'INCONCLUSIVO' — seguida do motivo em 1-2 frases.\n" +
		"Depois detalhe os itens 1-3 e termine com 'CONFIANÇA: alta|média|baixa'. NÃO invente dados fora do JSON."
	resposta, err := chamarOpenAIChat(c.Request.Context(), modeloAuditoria, system,
		[]map[string]string{{"role": "user", "content": userContent}})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	uid, uname := usuarioIA(c)
	if sqlDB, e := database.GormDB_App.DB(); e == nil {
		conf := 0
		low := strings.ToLower(resposta)
		if strings.Contains(low, "confiança: alta") {
			conf = 90
		} else if strings.Contains(low, "confiança: média") || strings.Contains(low, "confiança: media") {
			conf = 60
		} else if strings.Contains(low, "confiança: baixa") {
			conf = 30
		}
		_, _ = sqlDB.Exec(`INSERT INTO FATURA_REANALISES
			(fatura_id, modelo, justificativa, recomendacao, resposta_crua, confianca_final, pdf_anexado, usuario_id, usuario_nome, criado_em)
			VALUES (?, ?, ?, NULL, ?, ?, 0, ?, ?, NOW())`,
			id, modeloAuditoria, truncarIA(resposta, 4000), resposta, conf, uid, uname)
	}
	c.JSON(http.StatusOK, gin.H{"resposta": resposta, "modelo": modeloAuditoria})
}

// RejeitarApontamento — POST /api/v1/faturas/:id/rejeitar-apontamento
// O analista marca o apontamento da fatura como rejeitado (falso positivo): a fatura
// sai da lista da Auditoria (flag apontamento_rejeitado). Registra motivo/usuário/data
// e loga em FATURA_REANALISES para trilha de auditoria.
func RejeitarApontamento(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Motivo string `json:"motivo"`
	}
	_ = c.ShouldBindJSON(&body)
	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return
	}
	// Confere existência da fatura (sem alterar schema).
	var existe int
	if e := sqlDB.QueryRow("SELECT 1 FROM FATURA_DADOS_EXTRAIDOS WHERE id = ? LIMIT 1", id).Scan(&existe); e == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, gin.H{"error": "fatura não encontrada"})
		return
	} else if e != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": e.Error()})
		return
	}
	uid, uname := usuarioIA(c)
	// Persiste a rejeição como reanálise (recomendacao='REJEITADO'). A lista da Auditoria
	// exclui faturas que tenham esse registro — sem coluna nova no schema.
	if _, err := sqlDB.Exec(`INSERT INTO FATURA_REANALISES
		(fatura_id, modelo, justificativa, recomendacao, resposta_crua, confianca_final, pdf_anexado, usuario_id, usuario_nome, criado_em)
		VALUES (?, 'rejeicao_manual', ?, 'REJEITADO', ?, 0, 0, ?, ?, NOW())`,
		id, truncarIA("Apontamento rejeitado pelo analista. Motivo: "+body.Motivo, 4000),
		"REJEITADO: "+body.Motivo, uid, uname); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Remoção IMEDIATA do snapshot vivo — senão o apontamento só sai no próximo rebuild
	// (cron ./auditados) e o usuário vê ele "voltar pra lista" ao atualizar. O rebuild já
	// exclui REJEITADO daqui pra frente; este DELETE (best-effort) cobre a janela até lá.
	_, _ = sqlDB.Exec("DELETE FROM FATURA_APONTAMENTOS_AUDITADOS WHERE id = ?", id)
	c.JSON(http.StatusOK, gin.H{"ok": true, "rejeitado": true})
}

// RejeitarApontamentoSgeeasy — rejeita um apontamento do sgeeasy (Inconclusivos/Outlier),
// que NÃO tem linha na FDE. Persiste em FATURA_REANALISES chaveado por uid (fatura_id=0),
// mesmo mecanismo soft do RejeitarApontamento. O sgeeasy-gap exclui uids rejeitados.
// POST /api/v1/faturas/rejeitar-sgeeasy  { "uid": "...", "motivo": "..." }
func RejeitarApontamentoSgeeasy(c *gin.Context) {
	var body struct {
		UID    string `json:"uid"`
		Motivo string `json:"motivo"`
	}
	_ = c.ShouldBindJSON(&body)
	body.UID = strings.TrimSpace(body.UID)
	if body.UID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "uid obrigatório"})
		return
	}
	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return
	}
	uidUser, uname := usuarioIA(c)
	if _, err := sqlDB.Exec(`INSERT INTO FATURA_REANALISES
		(fatura_id, uid, modelo, justificativa, recomendacao, resposta_crua, confianca_final, pdf_anexado, usuario_id, usuario_nome, criado_em)
		VALUES (0, ?, 'rejeicao_manual_sgeeasy', ?, 'REJEITADO', ?, 0, 0, ?, ?, NOW())`,
		body.UID, truncarIA("Apontamento sgeeasy rejeitado pelo analista. Motivo: "+body.Motivo, 4000),
		"REJEITADO: "+body.Motivo, uidUser, uname); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "rejeitado": true, "uid": body.UID})
}

// sessaoFatura acha (ou cria, se criar=true) a sessão de chat de uma fatura para o usuário.
func sessaoFatura(sqlDB *sql.DB, id string, uid int64, criar bool) int64 {
	return sessaoFaturaT(sqlDB, id, uid, criar, "")
}

// sessaoFaturaT — sessão de chat com namespace por FONTE (Acer usa título "ACER#id" p/ não
// colidir com a FDE "FDE#id"). fonte vazio = FDE (comportamento atual).
func sessaoFaturaT(sqlDB *sql.DB, id string, uid int64, criar bool, fonte string) int64 {
	prefixo := "FDE#"
	if fonte == "acer" {
		prefixo = "ACER#"
	}
	titulo := prefixo + id
	var sess int64
	err := sqlDB.QueryRow(
		"SELECT id FROM AI_CHAT_SESSIONS WHERE title=? AND user_id=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
		titulo, uid).Scan(&sess)
	if err == nil && sess > 0 {
		return sess
	}
	if !criar {
		return 0
	}
	res, e := sqlDB.Exec("INSERT INTO AI_CHAT_SESSIONS (user_id, title, created_at, updated_at) VALUES (?, ?, NOW(), NOW())", uid, titulo)
	if e != nil {
		return 0
	}
	ns, _ := res.LastInsertId()
	return ns
}

// GetChatFatura — GET /api/v1/faturas/:id/chat
func GetChatFatura(c *gin.Context) {
	id := c.Param("id")
	uid, _ := usuarioIA(c)
	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sess := sessaoFaturaT(sqlDB, id, uid, false, c.Query("fonte"))
	msgs := []gin.H{}
	if sess > 0 {
		rows, e := sqlDB.Query("SELECT role, content, created_at FROM AI_CHAT_MESSAGES WHERE session_id=? ORDER BY id", sess)
		if e == nil {
			defer rows.Close()
			for rows.Next() {
				var role, content string
				var criado sql.NullString
				_ = rows.Scan(&role, &content, &criado)
				msgs = append(msgs, gin.H{"role": role, "content": content, "created_at": criado.String})
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"session_id": sess, "messages": msgs})
}

// ChatFatura — POST /api/v1/faturas/:id/chat  { "mensagem": "..." }
func ChatFatura(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Mensagem string `json:"mensagem"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.Mensagem) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "mensagem obrigatória"})
		return
	}
	uid, _ := usuarioIA(c)
	fonte := c.Query("fonte")
	fat, err := carregarFaturaCompactaT(id, fonte)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "fatura não encontrada"})
		return
	}
	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sess := sessaoFaturaT(sqlDB, id, uid, true, fonte)

	// histórico anterior (contexto da conversa)
	hist := []map[string]string{}
	if rows, e := sqlDB.Query("SELECT role, content FROM AI_CHAT_MESSAGES WHERE session_id=? ORDER BY id", sess); e == nil {
		defer rows.Close()
		for rows.Next() {
			var role, content string
			_ = rows.Scan(&role, &content)
			hist = append(hist, map[string]string{"role": role, "content": content})
		}
	}

	payload, _ := json.Marshal(fat)
	system := "Você é assistente de auditoria de faturas de energia. CONTEXTO — dados extraídos desta fatura (JSON):\n" +
		string(payload) +
		"\n\nResponda as dúvidas do auditor sobre ESTA fatura de forma objetiva, em PT-BR. " +
		"Baseie-se apenas nos dados do JSON; se algo não estiver lá, diga que não consta."
	msgs := append(hist, map[string]string{"role": "user", "content": body.Mensagem})

	resposta, err := chamarOpenAIChat(c.Request.Context(), modeloChat, system, msgs)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	_, _ = sqlDB.Exec("INSERT INTO AI_CHAT_MESSAGES (session_id, role, content, created_at) VALUES (?, 'user', ?, NOW())", sess, body.Mensagem)
	_, _ = sqlDB.Exec("INSERT INTO AI_CHAT_MESSAGES (session_id, role, content, created_at) VALUES (?, 'assistant', ?, NOW())", sess, resposta)
	_, _ = sqlDB.Exec("UPDATE AI_CHAT_SESSIONS SET updated_at=NOW() WHERE id=?", sess)

	c.JSON(http.StatusOK, gin.H{"resposta": resposta, "session_id": sess, "modelo": modeloChat})
}

func truncarIA(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
