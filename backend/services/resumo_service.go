package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"ressarcimento-backend/repositories"
)

type ResumoService struct {
	Repo       *repositories.ResumoRepo
	DBRepo     *repositories.ProcessosRepo
	HTTPClient *http.Client
}

const systemPromptSingle = `Resuma o processo em máximo 10 linhas em português puro, sem código:
  - Etapa atual
  - Tipo de irregularidade
  - Últimas ações
  - Risco (alto/médio/baixo)
  - Próximo passo
  `

const systemPromptBatch = `Você é um Analista Especialista em Ressarcimento do setor elétrico (Brasil), com forte experiência em tratativas com concessionárias e regulação ANEEL.

Base normativa:
- Use a REN ANEEL 1000 como referência principal.
- Use a REN ANEEL 457 quando o caso for antigo e o período do histórico indicar que se aplica.
Importante: não invente artigos, prazos ou trechos. Se faltar informação para afirmar algo, declare "Informação insuficiente" e liste o que falta.

Objetivo:
Avaliar o andamento do processo com base nos dados fornecidos (etapa/subetapa/histórico/valores) e sugerir próximos passos, de forma prática e operacional.

Restrições e segurança:
- Não forneça aconselhamento jurídico; forneça orientação operacional e de compliance.
- Seja direto, claro e orientado a decisão.
- Não exponha dados sensíveis além do que foi informado.
- Se houver inconsistência no histórico (datas fora de ordem, falta de protocolo, ausência de retorno etc.), sinalize.

Formato de saída (OBRIGATÓRIO, sempre):
Para cada processo, gere exatamente dois blocos no resumo:

1) "Análise (visão de negócios)"
- 4 a 8 bullets curtos.
- Deve conter: status atual, risco/prioridade, gargalo provável, impacto (prazo/valor), e base normativa aplicável (sem citar artigos específicos se você não tiver certeza).

2) "Próximos passos (operacional)"
- Checklist numerado (5 a 12 itens).
- Deve incluir: o que fazer agora, quais evidências/coletas buscar, qual mensagem/solicitação típica enviar, e critérios de pronto para avançar (gate).
- Se couber, incluir 2 variações: se houve retorno vs se não houve retorno.

Extras:
- Se o histórico for grande, use apenas os eventos fornecidos e o resumo fornecido; não tente reconstruir o que não existe.
- Quando mencionar norma, use esta forma:
  "Base normativa: REN 1000 (tema: ...); REN 457 (aplicável se período antigo)."

Retorne apenas JSON estrito no formato: {"summaries":[{"id":<numero>,"summary":"..."}], "ok":true}. Sem texto extra.`

func openAIModel() string {
	if v := os.Getenv("OPENAI_MODEL"); v != "" {
		return v
	}
	return "gpt-5-nano"
}

func NewResumoService(res *repositories.ResumoRepo, proc *repositories.ProcessosRepo) *ResumoService {
	return &ResumoService{
		Repo:       res,
		DBRepo:     proc,
		HTTPClient: &http.Client{Timeout: 180 * time.Second},
	}
}

// buildPrompt collects latest history items for a process
func (s *ResumoService) buildPrompt(ctx context.Context, processoID int64) (system string, user string) {
	system = systemPromptSingle

	// Fetch processo info
	var (
		uc, cliente, concessionaria, status                         string
		descricaoIrregularidade, periodosIrregularidade, linkFatura string
		razaoSocial, cnpj, endereco                                 string
		tipoIrregularidade, subtipoIrregularidade                   string
		etapaAtual, subEtapaAtual                                   string
	)
	_ = s.DBRepo.DB.WithContext(ctx).Raw(`
		SELECT
			COALESCE(r.uc, ''),
			COALESCE(r.cliente, ''),
			COALESCE(r.concessionaria, ''),
			COALESCE(s.status, ''),
			COALESCE(r.descricao_irregularidade, ''),
			COALESCE(r.periodos_irregularidade, ''),
			COALESCE(r.link_fatura, ''),
			COALESCE(r.razao_social_fatura, ''),
			COALESCE(r.cnpj, ''),
			COALESCE(r.endereco_completo, ''),
			COALESCE(ti.nome, ''),
			COALESCE(sti.nome, ''),
			COALESCE(e.etapa, ''),
			COALESCE(p.sub_etapa, '')
		FROM FT_REQUISICOES r
		LEFT JOIN DM_STATUS s ON r.id_status = s.id_status
		LEFT JOIN FT_PROCESSOS p ON p.id_processo = r.id_requisicao
		LEFT JOIN DM_ETAPAS_PROCESSO e ON p.id_etapa_processo = e.id_etapa_processo
		LEFT JOIN DM_TIPO_IRREGULARIDADE ti ON ti.id_tipo = r.id_tipo_irregularidade
		LEFT JOIN DM_SUBTIPO_IRREGULARIDADE sti ON sti.id_subtipo = r.id_subtipo_irregularidade
		WHERE r.id_requisicao = ?
	`, processoID).Row().Scan(
		&uc,
		&cliente,
		&concessionaria,
		&status,
		&descricaoIrregularidade,
		&periodosIrregularidade,
		&linkFatura,
		&razaoSocial,
		&cnpj,
		&endereco,
		&tipoIrregularidade,
		&subtipoIrregularidade,
		&etapaAtual,
		&subEtapaAtual,
	)

	// Fetch last 20 history rows
	type item struct {
		Data   string `json:"data"`
		Etapa  string `json:"etapa"`
		Sub    string `json:"sub"`
		Coment string `json:"comentario"`
		Tipo   string `json:"tipo"`
	}
	rows, _ := s.DBRepo.DB.WithContext(ctx).Raw(`
		SELECT DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s') as d,
			   COALESCE(h.etapa_nova,''),
			   COALESCE(h.sub_etapa,''),
			   COALESCE(h.comentario,''),
			   COALESCE(h.tipo_movimentacao,'')
		FROM FT_HISTORICO_MOVIMENTACOES h
		WHERE h.id_requisicao = ?
		ORDER BY h.data_movimentacao DESC
		LIMIT 20`, processoID).Rows()
	defer func() {
		if rows != nil {
			rows.Close()
		}
	}()
	arr := make([]item, 0, 20)
	for rows != nil && rows.Next() {
		var it item
		_ = rows.Scan(&it.Data, &it.Etapa, &it.Sub, &it.Coment, &it.Tipo)
		arr = append(arr, it)
	}

	payload := map[string]any{
		"processo_id": processoID,
		"identificacao": map[string]any{
			"uc":             uc,
			"cliente":        cliente,
			"concessionaria": concessionaria,
			"cnpj":           cnpj,
			"razao_social":   razaoSocial,
		},
		"status_atual": map[string]any{
			"status":    status,
			"etapa":     etapaAtual,
			"sub_etapa": subEtapaAtual,
		},
		"irregularidade": map[string]any{
			"descricao": descricaoIrregularidade,
			"periodos":  periodosIrregularidade,
			"tipo":      tipoIrregularidade,
			"subtipo":   subtipoIrregularidade,
		},
		"link_fatura": linkFatura,
		"endereco":    endereco,
		"historico":   arr,
	}

	b, _ := json.MarshalIndent(payload, "", "  ")
	user = "Dados do processo (JSON):\n" + string(b)
	return
}

// callOpenAI performs a minimal chat call
// callLocalAgent chama o agente IA local (Llama via Docker) para gerar resumo
func (s *ResumoService) callLocalAgent(ctx context.Context, system, user string) (string, error) {
	// Detecta URL do agente: Docker (LLAMA_AGENT_URL) ou localhost para dev
	llamaURL := os.Getenv("LLAMA_AGENT_URL")
	if llamaURL == "" {
		llamaURL = "http://localhost:8000"
	}

	prompt := system + "\n\n" + user
	body := map[string]string{
		"question": prompt,
	}
	buf, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, llamaURL+"/query", bytes.NewReader(buf))
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return "", Errf("agente llama indisponível (%s): %v", llamaURL, err)
	}
	defer resp.Body.Close()
	var out struct {
		FinalAnswer string `json:"final_answer"`
		Resposta    string `json:"resposta"`
		Answer      string `json:"answer"`
		Error       string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode >= 400 {
		return "", Errf("agente llama %d: %s", resp.StatusCode, out.Error)
	}
	// Tenta vários campos possíveis de resposta
	if out.FinalAnswer != "" {
		return out.FinalAnswer, nil
	}
	if out.Resposta != "" {
		return out.Resposta, nil
	}
	if out.Answer != "" {
		return out.Answer, nil
	}
	return "", Err("resposta vazia do agente llama")
}

func (s *ResumoService) callOpenAI(ctx context.Context, system, user string) (string, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return "", Err("OPENAI_API_KEY nÃÆ’Ã†â€™Ãâ€šÂÂ£o definido")
	}
	body := map[string]any{
		"model": openAIModel(),
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
		"temperature": 0.2,
	}
	buf, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.openai.com/v1/chat/completions", bytes.NewReader(buf))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp, err := s.HTTPClient.Do(req)
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
		return "", Errf("openai %d: %v", resp.StatusCode, out.Error)
	}
	if len(out.Choices) == 0 {
		return "", Err("sem escolhas da openai")
	}
	return out.Choices[0].Message.Content, nil
}

// buildBatchPrompt builds a batch payload for multiple processos
func (s *ResumoService) buildBatchPrompt(ctx context.Context, ids []int64) (system string, user string, items map[int64]any) {
	system = systemPromptBatch
	type hist struct {
		Data   string `json:"data"`
		Etapa  string `json:"etapa"`
		Sub    string `json:"sub"`
		Coment string `json:"comentario"`
		Tipo   string `json:"tipo"`
	}
	items = make(map[int64]any, len(ids))
	for _, pid := range ids {
		var (
			uc, cliente, concessionaria, status                         string
			descricaoIrregularidade, periodosIrregularidade, linkFatura string
			razaoSocial, cnpj, endereco                                 string
			tipoIrregularidade, subtipoIrregularidade                   string
			etapaAtual, subEtapaAtual                                   string
		)
		_ = s.DBRepo.DB.WithContext(ctx).Raw(`
			SELECT
				COALESCE(r.uc, ''),
				COALESCE(r.cliente, ''),
				COALESCE(r.concessionaria, ''),
				COALESCE(s.status, ''),
				COALESCE(r.descricao_irregularidade, ''),
				COALESCE(r.periodos_irregularidade, ''),
				COALESCE(r.link_fatura, ''),
				COALESCE(r.razao_social_fatura, ''),
				COALESCE(r.cnpj, ''),
				COALESCE(r.endereco_completo, ''),
				COALESCE(ti.nome, ''),
				COALESCE(sti.nome, ''),
				COALESCE(e.etapa, ''),
				COALESCE(p.sub_etapa, '')
			FROM FT_REQUISICOES r
			LEFT JOIN DM_STATUS s ON r.id_status = s.id_status
			LEFT JOIN FT_PROCESSOS p ON p.id_processo = r.id_requisicao
			LEFT JOIN DM_ETAPAS_PROCESSO e ON p.id_etapa_processo = e.id_etapa_processo
			LEFT JOIN DM_TIPO_IRREGULARIDADE ti ON ti.id_tipo = r.id_tipo_irregularidade
			LEFT JOIN DM_SUBTIPO_IRREGULARIDADE sti ON sti.id_subtipo = r.id_subtipo_irregularidade
			WHERE r.id_requisicao = ?
		`, pid).Row().Scan(
			&uc,
			&cliente,
			&concessionaria,
			&status,
			&descricaoIrregularidade,
			&periodosIrregularidade,
			&linkFatura,
			&razaoSocial,
			&cnpj,
			&endereco,
			&tipoIrregularidade,
			&subtipoIrregularidade,
			&etapaAtual,
			&subEtapaAtual,
		)
		rows, _ := s.DBRepo.DB.WithContext(ctx).Raw(`SELECT DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s') as d, COALESCE(h.etapa_nova,''), COALESCE(h.sub_etapa,''), COALESCE(h.comentario,''), COALESCE(h.tipo_movimentacao,'')
          FROM FT_HISTORICO_MOVIMENTACOES h WHERE h.id_requisicao = ? ORDER BY h.data_movimentacao DESC LIMIT 20`, pid).Rows()
		arr := make([]hist, 0, 20)
		for rows != nil && rows.Next() {
			var it hist
			_ = rows.Scan(&it.Data, &it.Etapa, &it.Sub, &it.Coment, &it.Tipo)
			arr = append(arr, it)
		}
		if rows != nil {
			rows.Close()
		}
		items[pid] = map[string]any{
			"id": pid,
			"identificacao": map[string]any{
				"uc":             uc,
				"cliente":        cliente,
				"concessionaria": concessionaria,
				"cnpj":           cnpj,
				"razao_social":   razaoSocial,
			},
			"status_atual": map[string]any{
				"status":    status,
				"etapa":     etapaAtual,
				"sub_etapa": subEtapaAtual,
			},
			"irregularidade": map[string]any{
				"descricao": descricaoIrregularidade,
				"periodos":  periodosIrregularidade,
				"tipo":      tipoIrregularidade,
				"subtipo":   subtipoIrregularidade,
			},
			"link_fatura": linkFatura,
			"endereco":    endereco,
			"historico":   arr,
		}
	}
	// user message
	msg := struct {
		Items []any `json:"items"`
	}{Items: make([]any, 0, len(items))}
	for _, pid := range ids {
		msg.Items = append(msg.Items, items[pid])
	}
	b, _ := json.MarshalIndent(msg, "", "  ")
	user = "Dados dos processos (JSON):\n" + string(b)
	return
}

// callLocalAgentJSON chama o agente llama esperando resposta em JSON
func (s *ResumoService) callLocalAgentJSON(ctx context.Context, system, user string) (map[string]any, error) {
	// Detecta URL do agente: Docker (LLAMA_AGENT_URL) ou localhost para dev
	llamaURL := os.Getenv("LLAMA_AGENT_URL")
	if llamaURL == "" {
		llamaURL = "http://localhost:8000"
	}

	prompt := system + "\n\n" + user
	body := map[string]string{
		"question": prompt,
	}
	buf, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, llamaURL+"/query", bytes.NewReader(buf))
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return nil, Errf("agente llama indisponível (%s): %v", llamaURL, err)
	}
	defer resp.Body.Close()
	var out struct {
		FinalAnswer string `json:"final_answer"`
		Resposta    string `json:"resposta"`
		Answer      string `json:"answer"`
		Error       string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode >= 400 {
		return nil, Errf("agente llama %d: %s", resp.StatusCode, out.Error)
	}

	// Tenta vários campos possíveis de resposta
	var jsonStr string
	if out.FinalAnswer != "" {
		jsonStr = out.FinalAnswer
	} else if out.Resposta != "" {
		jsonStr = out.Resposta
	} else if out.Answer != "" {
		jsonStr = out.Answer
	} else {
		return nil, Err("resposta vazia do agente llama")
	}

	var obj map[string]any
	if err := json.Unmarshal([]byte(jsonStr), &obj); err != nil {
		return nil, Errf("erro ao parsear JSON do agente llama: %v", err)
	}
	return obj, nil
}

// callOpenAIJSON asks the model to return a JSON object
func (s *ResumoService) callOpenAIJSON(ctx context.Context, system, user string) (map[string]any, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return nil, Err("OPENAI_API_KEY nÃÆ’Ã†â€™Ãâ€šÂÂ£o definido")
	}
	body := map[string]any{
		"model": openAIModel(),
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
		"temperature":     0.2,
		"response_format": map[string]string{"type": "json_object"},
	}
	buf, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.openai.com/v1/chat/completions", bytes.NewReader(buf))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return nil, err
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
		return nil, Errf("openai %d: %v", resp.StatusCode, out.Error)
	}
	if len(out.Choices) == 0 {
		return nil, Err("sem escolhas da openai")
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(out.Choices[0].Message.Content), &obj); err != nil {
		return nil, err
	}
	return obj, nil
}

// GerarResumoAgora gera o resumo de um processo de forma síncrona via OpenAI.
func (s *ResumoService) GerarResumoAgora(ctx context.Context, processoID int64) (string, error) {
	system, user := s.buildPrompt(ctx, processoID)

	text, err := s.callOpenAI(ctx, system, user)
	if err != nil {
		_ = s.Repo.SaveError(ctx, processoID, err.Error())
		return "", err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		_ = s.Repo.SaveError(ctx, processoID, "summary vazio")
		return "", Err("summary vazio")
	}
	_ = s.Repo.SaveReady(ctx, processoID, text, "openai", openAIModel())
	return text, nil
}

// ProcessarResumos busca pendentes e gera texto
func (s *ResumoService) ProcessarResumos(ctx context.Context, limit int) error {
	ids, err := s.Repo.ListPending(ctx, limit)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		// silencioso quando nÃÆ’Ã†â€™Ãâ€šÂÂ£o hÃÆ’Ã†â€™Ãâ€šÂÂ¡ pendentes
		resumoStats.updateCycleStart(0, 0, limit)
		return nil
	}
	// micro-batches de 5 processos por chamada
	const batchSize = 5
	batches := (len(ids) + batchSize - 1) / batchSize
	fmt.Printf("[resumo] pendentes=%d, batches=%d (limit=%d)\n", len(ids), batches, limit)
	resumoStats.updateCycleStart(len(ids), batches, limit)
	for i := 0; i < len(ids); i += batchSize {
		end := i + batchSize
		if end > len(ids) {
			end = len(ids)
		}
		batch := ids[i:end]
		// log de dispatch dos IDs deste lote
		fmt.Printf("[resumo] dispatch batch ids=%v\n", batch)
		resumoStats.updateDispatch(batch)
		// monta payload batch
		system, user, _ := s.buildBatchPrompt(ctx, batch)

		// Usa OpenAI diretamente
		provider := "openai"
		obj, err := s.callOpenAIJSON(ctx, system, user)

		if err != nil {
			// se falhou a chamada inteira, marca cada como error e segue
			for _, id := range batch {
				_ = s.Repo.SaveError(ctx, id, err.Error())
			}
			// log batch error
			fmt.Printf("[resumo] batch %d processos %v ERROR: %v\n", len(batch), batch, err)
			resumoStats.updateBatchResult(nil, batch)
			continue
		}
		// espera { summaries: [{id, summary}, ...] }
		summaries, ok := obj["summaries"].([]any)
		if !ok {
			for _, id := range batch {
				_ = s.Repo.SaveError(ctx, id, "resposta sem summaries")
			}
			fmt.Printf("[resumo] batch %d processos %v ERROR: resposta sem summaries\n", len(batch), batch)
			resumoStats.updateBatchResult(nil, batch)
			continue
		}
		seen := make(map[int64]bool)
		okIDs := make([]int64, 0, len(batch))
		errIDs := make([]int64, 0)
		for _, raw := range summaries {
			m, _ := raw.(map[string]any)
			if m == nil {
				continue
			}
			var pid int64
			switch v := m["id"].(type) {
			case float64:
				pid = int64(v)
			case int64:
				pid = v
			}
			if pid == 0 {
				continue
			}
			sum, _ := m["summary"].(string)
			if sum == "" {
				_ = s.Repo.SaveError(ctx, pid, "summary vazio")
				seen[pid] = true
				errIDs = append(errIDs, pid)
				continue
			}
			model := "llama"
			if provider == "openai" {
				model = "gpt-4o-mini"
			}
			_ = s.Repo.SaveReady(ctx, pid, sum, provider, model)
			seen[pid] = true
			okIDs = append(okIDs, pid)
		}
		// os que nÃÆ’Ã†â€™Ãâ€šÂÂ£o vieram na resposta, marcam erro
		for _, id := range batch {
			if !seen[id] {
				_ = s.Repo.SaveError(ctx, id, "sem retorno no batch")
				errIDs = append(errIDs, id)
			}
		}
		fmt.Printf("[resumo] batch %d processos OK=%d %v ERR=%d %v\n", len(batch), len(okIDs), okIDs, len(errIDs), errIDs)
		resumoStats.updateBatchResult(okIDs, errIDs)
	}
	fmt.Printf("[resumo] finalizado: processados=%d (limit=%d)\n", len(ids), limit)
	resumoStats.updateCycleEnd(len(ids))
	return nil
}

// Err helpers
type strErr string

func (e strErr) Error() string      { return string(e) }
func Err(s string) error            { return strErr(s) }
func Errf(f string, a ...any) error { return strErr(fmt.Sprintf(f, a...)) }

// ---------------------- Runtime stats (in-memory) ----------------------
type ResumoRuntimeStats struct {
	mu                 sync.RWMutex
	LastDispatchIDs    []int64
	LastOKIDs          []int64
	LastErrIDs         []int64
	LastCyclePending   int
	LastCycleBatches   int
	LastCycleLimit     int
	LastCycleProcessed int
	LastCycleAt        time.Time
}

type ResumoRuntimeStatus struct {
	LastDispatchIDs    []int64   `json:"last_dispatch_ids"`
	LastOKIDs          []int64   `json:"last_ok_ids"`
	LastErrIDs         []int64   `json:"last_err_ids"`
	LastCyclePending   int       `json:"last_cycle_pending"`
	LastCycleBatches   int       `json:"last_cycle_batches"`
	LastCycleLimit     int       `json:"last_cycle_limit"`
	LastCycleProcessed int       `json:"last_cycle_processed"`
	LastCycleAt        time.Time `json:"last_cycle_at"`
}

var resumoStats ResumoRuntimeStats

func (s *ResumoRuntimeStats) updateCycleStart(pending, batches, limit int) {
	s.mu.Lock()
	s.LastCyclePending = pending
	s.LastCycleBatches = batches
	s.LastCycleLimit = limit
	s.LastCycleProcessed = 0
	s.LastCycleAt = time.Now()
	s.mu.Unlock()
}

func (s *ResumoRuntimeStats) updateDispatch(ids []int64) {
	s.mu.Lock()
	s.LastDispatchIDs = append([]int64(nil), ids...)
	s.mu.Unlock()
}

func (s *ResumoRuntimeStats) updateBatchResult(ok, err []int64) {
	s.mu.Lock()
	if len(ok) > 0 {
		s.LastOKIDs = append([]int64(nil), ok...)
	}
	if len(err) > 0 {
		s.LastErrIDs = append([]int64(nil), err...)
	}
	s.LastCycleProcessed += len(ok) + len(err)
	s.mu.Unlock()
}

func (s *ResumoRuntimeStats) updateCycleEnd(processed int) {
	s.mu.Lock()
	s.LastCycleProcessed = processed
	s.LastCycleAt = time.Now()
	s.mu.Unlock()
}

// GetResumoRuntimeStatus returns a snapshot copy of the runtime stats
func GetResumoRuntimeStatus() ResumoRuntimeStatus {
	resumoStats.mu.RLock()
	defer resumoStats.mu.RUnlock()
	// deep-copy slices
	cp := ResumoRuntimeStatus{
		LastCyclePending:   resumoStats.LastCyclePending,
		LastCycleBatches:   resumoStats.LastCycleBatches,
		LastCycleLimit:     resumoStats.LastCycleLimit,
		LastCycleProcessed: resumoStats.LastCycleProcessed,
		LastCycleAt:        resumoStats.LastCycleAt,
	}
	if len(resumoStats.LastDispatchIDs) > 0 {
		cp.LastDispatchIDs = append([]int64(nil), resumoStats.LastDispatchIDs...)
	}
	if len(resumoStats.LastOKIDs) > 0 {
		cp.LastOKIDs = append([]int64(nil), resumoStats.LastOKIDs...)
	}
	if len(resumoStats.LastErrIDs) > 0 {
		cp.LastErrIDs = append([]int64(nil), resumoStats.LastErrIDs...)
	}
	return cp
}
