package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/repositories"
)

// agenteRecepcaoModel é fixo (não segue a env var global OPENAI_MODEL) — mesmo padrão já
// usado em outros endpoints isolados (ex: aisure_handler.go, geração de descrição de
// apontamento). Decisão explícita: este agente usa gpt-4o-mini.
const agenteRecepcaoModel = "gpt-4o-mini"

// Agente de Recepção — escopo real (corrigido): faturas SEMPRE entram no sistema dentro
// de uma requisição que o analista já criou manualmente, então não há ambiguidade de
// "qual processo" a resolver nesse caminho. Quem chega solto, sem processo conhecido de
// antemão, são e-mails recebidos que não bateram com nenhum processo pelo casamento de
// assunto já existente (graph_imap.go). É aí que este agente atua: varre esses e-mails
// órfãos (FT_EMAILS_PROCESSO com id_processo NULL) e SUGERE vínculo com um processo
// existente — nunca vincula sozinho, e NUNCA cria requisição (isso é sempre humano).

// RecepcaoInput é a entrada do motor de decisão.
type RecepcaoInput struct {
	Canal         string // "email" — canal real hoje
	OrigemRef     string // identificador de origem, ex: "email #1234 (Assunto: ...)"
	TextoExtraido string // assunto + corpo do e-mail
}

// RecepcaoDecisao é o resultado do motor. Só existem duas decisões possíveis — o agente
// nunca cria requisição/processo, só aponta o caminho para um humano decidir.
type RecepcaoDecisao struct {
	Decisao            string // SUGERIU_VINCULO | PRECISA_REVISAO
	IDProcessoSugerido *int64
	Confianca          int
	Justificativa      string
}

type recepcaoExtracao struct {
	UC                string `json:"uc"`
	Cliente           string `json:"cliente"`
	Concessionaria    string `json:"concessionaria"`
	Resumo            string `json:"resumo"`
	ConfiancaExtracao int    `json:"confianca_extracao"`
}

// ProcessarRecepcao é o motor de decisão:
//  1. Match determinístico por UC (sem IA) contra FT_REQUISICOES — se casar com um único
//     processo, SUGERE o vínculo (nunca vincula sozinho).
//  2. Sem match: gpt-4o-mini lê o e-mail e monta um resumo (UC/cliente/concessionária se
//     identificáveis + do que se trata), só para o alerta ficar útil — não decide nada.
//  3. Decisão final é sempre PRECISA_REVISAO quando não há match; abrir requisição
//     continua 100% manual, como já é hoje.
//
// Idempotência: dedup_key (hash do canal+texto) com UNIQUE KEY em AGENTE_RECEPCAO_LOG +
// GET_LOCK nomeado, para não reprocessar o mesmo e-mail (retry, varredura rodada 2x etc.).
func ProcessarRecepcao(ctx context.Context, in RecepcaoInput) (*RecepcaoDecisao, error) {
	db := getAppDB()
	if db == nil {
		return nil, fmt.Errorf("banco não inicializado")
	}
	gdb := database.GormDB_App
	if gdb == nil {
		return nil, fmt.Errorf("banco (gorm) não inicializado")
	}

	texto := strings.TrimSpace(in.TextoExtraido)
	if texto == "" {
		return nil, fmt.Errorf("texto vazio")
	}
	canal := strings.TrimSpace(in.Canal)
	if canal == "" {
		canal = "email"
	}

	dedupKey := recepcaoDedupKey(canal, texto)

	if prev, ok := decisaoJaRegistrada(db, dedupKey); ok {
		return prev, nil
	}

	if !acquireNamedLock(db, "agente_recepcao:"+dedupKey) {
		return nil, fmt.Errorf("processamento concorrente em andamento, tente novamente")
	}
	defer releaseNamedLock(db, "agente_recepcao:"+dedupKey)

	// Re-checa dentro do lock (outra goroutine pode ter processado enquanto esperávamos).
	if prev, ok := decisaoJaRegistrada(db, dedupKey); ok {
		return prev, nil
	}

	// Passo 1 — match determinístico por UC (sem IA, sem custo).
	if pid, ok := repositories.FindProcessByUC(gdb, texto); ok {
		dec := &RecepcaoDecisao{
			Decisao:            "SUGERIU_VINCULO",
			IDProcessoSugerido: &pid,
			Justificativa:      "UC encontrada no texto casa com um único processo existente.",
		}
		criarAlertaRecepcao(db, &pid, fmt.Sprintf(
			"Agente de Recepção: %s parece pertencer ao processo #%d — confirme o vínculo.",
			originLabel(in.OrigemRef), pid))
		registrarLogRecepcao(db, in, dedupKey, dec, "")
		return dec, nil
	}

	// Passo 2 — sem match: LLM só resume, não decide.
	extr, raw, err := extrairResumoRecepcao(ctx, texto)
	resumo := ""
	if err == nil && extr != nil {
		resumo = extr.Resumo
		if resumo == "" {
			resumo = "sem resumo disponível"
		}
	} else {
		resumo = "falha ao gerar resumo automático (" + errMsg(err) + ")"
	}

	dec := &RecepcaoDecisao{
		Decisao:       "PRECISA_REVISAO",
		Justificativa: "Não bateu com nenhum processo existente. " + resumo,
	}
	if extr != nil {
		dec.Confianca = extr.ConfiancaExtracao
	}
	criarAlertaRecepcao(db, nil, fmt.Sprintf(
		"Agente de Recepção: %s não bateu com nenhum processo — revisão manual. %s",
		originLabel(in.OrigemRef), resumo))
	registrarLogRecepcao(db, in, dedupKey, dec, raw)
	return dec, nil
}

func errMsg(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func originLabel(origemRef string) string {
	origemRef = strings.TrimSpace(origemRef)
	if origemRef == "" {
		return "um e-mail recebido"
	}
	return origemRef
}

// extrairResumoRecepcao chama gpt-4o-mini (response_format json_object) só para produzir
// um resumo legível do e-mail — não decide nada, é puro apoio ao humano que vai revisar.
func extrairResumoRecepcao(ctx context.Context, texto string) (*recepcaoExtracao, string, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return nil, "", fmt.Errorf("OPENAI_API_KEY não definido")
	}

	system := `Você ajuda a triagem de um sistema de ressarcimento de energia elétrica.
Recebeu um e-mail que não bateu com nenhum processo conhecido no sistema. Leia e devolva
um resumo curto para um humano decidir o que fazer — você NÃO decide nada, só resume.
Responda em JSON estrito:
{
  "uc": "número da unidade consumidora, se aparecer no e-mail, senão vazio",
  "cliente": "nome do cliente/titular, se identificável, senão vazio",
  "concessionaria": "nome da distribuidora, se identificável, senão vazio",
  "resumo": "1-2 frases objetivas do que é esse e-mail e o que parece precisar de ação",
  "confianca_extracao": 0
}
"confianca_extracao" é 0-100: sua confiança de que o resumo acima está correto.`

	user := "E-mail recebido (assunto + corpo):\n\n" + texto

	body := map[string]any{
		"model": agenteRecepcaoModel,
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
		"temperature":     0.2,
		"response_format": map[string]string{"type": "json_object"},
	}
	buf, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.openai.com/v1/chat/completions", bytes.NewReader(buf))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
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
		return nil, "", fmt.Errorf("openai %d: %v", resp.StatusCode, out.Error)
	}
	if len(out.Choices) == 0 {
		return nil, "", fmt.Errorf("sem resposta da OpenAI")
	}
	raw := out.Choices[0].Message.Content
	var extr recepcaoExtracao
	if err := json.Unmarshal([]byte(raw), &extr); err != nil {
		return nil, raw, fmt.Errorf("resposta da IA não é JSON válido: %w", err)
	}
	return &extr, raw, nil
}

// recepcaoDedupKey identifica de forma estável um recebimento (mesmo canal + mesmo
// conteúdo = mesma chave), pra nunca reprocessar o mesmo e-mail.
func recepcaoDedupKey(canal, texto string) string {
	h := sha256.Sum256([]byte(canal + "|" + texto))
	return hex.EncodeToString(h[:])
}

// decisaoJaRegistrada verifica se esse dedup_key já foi processado; se sim, devolve a
// decisão histórica em vez de reprocessar (evita custo de IA duplicado em retries/varreduras repetidas).
func decisaoJaRegistrada(db *sql.DB, dedupKey string) (*RecepcaoDecisao, bool) {
	var decisao string
	var idProc sql.NullInt64
	var confianca sql.NullInt64
	var justificativa sql.NullString
	err := db.QueryRow(`
		SELECT decisao, id_processo_sugerido, confianca, justificativa
		FROM AGENTE_RECEPCAO_LOG WHERE dedup_key = ? LIMIT 1`, dedupKey,
	).Scan(&decisao, &idProc, &confianca, &justificativa)
	if err != nil {
		return nil, false
	}
	dec := &RecepcaoDecisao{Decisao: decisao, Justificativa: justificativa.String, Confianca: int(confianca.Int64)}
	if idProc.Valid {
		v := idProc.Int64
		dec.IDProcessoSugerido = &v
	}
	return dec, true
}

// registrarLogRecepcao grava a decisão em AGENTE_RECEPCAO_LOG (auditoria). dedup_key tem
// UNIQUE KEY — se outra goroutine venceu a corrida entre a checagem e este INSERT, o erro
// de duplicidade é só logado (o resultado relevante já está registrado).
func registrarLogRecepcao(db *sql.DB, in RecepcaoInput, dedupKey string, dec *RecepcaoDecisao, respostaCrua string) {
	_, err := db.Exec(`
		INSERT INTO AGENTE_RECEPCAO_LOG
			(canal, origem_ref, dedup_key, texto_recebido, decisao,
			 id_processo_sugerido, confianca, justificativa, modelo, resposta_crua, criado_em)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
		in.Canal, in.OrigemRef, dedupKey, truncateUTF8(in.TextoExtraido, 60000), dec.Decisao,
		nullableInt64(dec.IDProcessoSugerido), dec.Confianca, dec.Justificativa,
		agenteRecepcaoModel, truncateUTF8(respostaCrua, 20000),
	)
	if err != nil {
		fmt.Printf("[agente_recepcao] erro ao registrar log (dedup=%s): %v\n", dedupKey, err)
	}
}

func nullableInt64(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}

func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// criarAlertaRecepcao notifica os gestores ativos (mesmo padrão de prazos_service.go) —
// SUGERIU_VINCULO e PRECISA_REVISAO nunca escrevem vínculo/decisão sozinhos, só alertam
// para confirmação humana. Reaproveita FT_ALERTAS: zero UI nova, já aparece no sino
// (AlertasDropdown.jsx) via SSE.
func criarAlertaRecepcao(db *sql.DB, idProcesso *int64, mensagem string) {
	rows, err := db.Query(`SELECT id_usuario FROM DM_USUARIO WHERE perfil='gestor' AND usuario_ativo=1`)
	if err != nil {
		return
	}
	var idsGestores []int64
	for rows.Next() {
		var uid int64
		if rows.Scan(&uid) == nil {
			idsGestores = append(idsGestores, uid)
		}
	}
	rows.Close()

	for _, uid := range idsGestores {
		_, _ = db.Exec(
			"INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, acknowledged, data_criacao) VALUES (?, ?, ?, 0, 0, NOW())",
			uid, nullableInt64(idProcesso), mensagem,
		)
	}
}

// acquireNamedLock / releaseNamedLock serializam processamento concorrente do mesmo
// conteúdo entre goroutines/réplicas — mesmo padrão de GET_LOCK já usado em
// mail_handler.go (upsert de e-mails).
func acquireNamedLock(db *sql.DB, key string) bool {
	var got sql.NullInt64
	if err := db.QueryRow("SELECT GET_LOCK(?, 15)", key).Scan(&got); err != nil {
		return false
	}
	return got.Valid && got.Int64 == 1
}

func releaseNamedLock(db *sql.DB, key string) {
	_, _ = db.Exec("SELECT RELEASE_LOCK(?)", key)
}

// VarreduraResultado resume uma rodada de VarrerEmailsNaoVinculados.
type VarreduraResultado struct {
	Processados      int `json:"processados"`
	SugeriramVinculo int `json:"sugeriram_vinculo"`
	PrecisamRevisao  int `json:"precisam_revisao"`
	Erros            int `json:"erros"`
}

// VarrerEmailsNaoVinculados é o ponto de entrada real do Agente de Recepção: percorre
// e-mails RECEBIDOS que não bateram com nenhum processo pelo casamento de assunto
// (graph_imap.go, id_processo NULL) e roda o motor de decisão em cada um. Gatilho manual
// por enquanto (não roda em cron) — evita custo de IA e ruído de alerta sem controle
// numa primeira passada sobre a caixa inteira.
func VarrerEmailsNaoVinculados(ctx context.Context, limit int) (*VarreduraResultado, error) {
	db := getAppDB()
	if db == nil {
		return nil, fmt.Errorf("banco não inicializado")
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}

	rows, err := db.QueryContext(ctx, `
		SELECT id_email, COALESCE(assunto,''), COALESCE(corpo,''), COALESCE(de_email,'')
		FROM FT_EMAILS_PROCESSO
		WHERE id_processo IS NULL AND tipo = 'recebido'
		ORDER BY data_envio DESC
		LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	type emailRow struct {
		ID      int64
		Assunto string
		Corpo   string
		De      string
	}
	var lista []emailRow
	for rows.Next() {
		var e emailRow
		if err := rows.Scan(&e.ID, &e.Assunto, &e.Corpo, &e.De); err == nil {
			lista = append(lista, e)
		}
	}
	rows.Close()

	res := &VarreduraResultado{}
	for _, e := range lista {
		texto := strings.TrimSpace(e.Assunto + "\n\n" + e.Corpo)
		if texto == "" {
			continue
		}
		origem := fmt.Sprintf("e-mail #%d de %s (assunto: %q)", e.ID, e.De, e.Assunto)
		dec, err := ProcessarRecepcao(ctx, RecepcaoInput{Canal: "email", OrigemRef: origem, TextoExtraido: texto})
		res.Processados++
		if err != nil {
			res.Erros++
			continue
		}
		switch dec.Decisao {
		case "SUGERIU_VINCULO":
			res.SugeriramVinculo++
		default:
			res.PrecisamRevisao++
		}
	}
	return res, nil
}
