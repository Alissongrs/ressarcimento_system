package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"ressarcimento-backend/repositories"
)

type ResumoService struct {
	Repo       *repositories.ResumoRepo
	DBRepo     *repositories.ProcessosRepo
	HTTPClient *http.Client
}

func NewResumoService(res *repositories.ResumoRepo, proc *repositories.ProcessosRepo) *ResumoService {
	return &ResumoService{
		Repo:       res,
		DBRepo:     proc,
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// buildPrompt collects latest history items for a process
func (s *ResumoService) buildPrompt(ctx context.Context, processoID int64) (system string, user string) {
	system = "Você é um assistente que explica de forma clara e objetiva o momento do processo com base no histórico de movimentações. Resuma em 3-6 linhas em pt-BR, aponte etapa atual, últimos eventos relevantes e próximos passos. Seja direto."
	// Fetch last 20 history rows
	type item struct {
		Data   string `json:"data"`
		Etapa  string `json:"etapa"`
		Sub    string `json:"sub"`
		Coment string `json:"comentario"`
		Tipo   string `json:"tipo"`
	}
	rows, _ := s.DBRepo.DB.QueryContext(ctx, `SELECT DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s') as d, COALESCE(h.etapa_nova,''), COALESCE(h.sub_etapa,''), COALESCE(h.comentario,''), COALESCE(h.tipo_movimentacao,'')
      FROM FT_HISTORICO_MOVIMENTACOES h WHERE h.id_requisicao = ? ORDER BY h.data_movimentacao DESC LIMIT 20`, processoID)
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
		"historico":   arr,
	}
	b, _ := json.MarshalIndent(payload, "", "  ")
	user = "Dados do processo (JSON):\n" + string(b)
	return
}

// callOpenAI performs a minimal chat call
func (s *ResumoService) callOpenAI(ctx context.Context, system, user string) (string, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return "", Err("OPENAI_API_KEY não definido")
	}
	body := map[string]any{
		"model": "gpt-4o-mini",
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
	system = "Você é um assistente que explica de forma clara e objetiva o momento do processo com base no histórico de movimentações. Para cada processo, responda em 3-6 linhas pt-BR com etapa atual, últimos eventos relevantes e próximos passos. Retorne apenas JSON estrito no formato: {\"summaries\":[{\"id\":<numero>,\"summary\":\"...\"}], \"ok\":true}. Sem texto extra."
	type hist struct {
		Data   string `json:"data"`
		Etapa  string `json:"etapa"`
		Sub    string `json:"sub"`
		Coment string `json:"comentario"`
		Tipo   string `json:"tipo"`
	}
	items = make(map[int64]any, len(ids))
	for _, pid := range ids {
		rows, _ := s.DBRepo.DB.QueryContext(ctx, `SELECT DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s') as d, COALESCE(h.etapa_nova,''), COALESCE(h.sub_etapa,''), COALESCE(h.comentario,''), COALESCE(h.tipo_movimentacao,'')
          FROM FT_HISTORICO_MOVIMENTACOES h WHERE h.id_requisicao = ? ORDER BY h.data_movimentacao DESC LIMIT 20`, pid)
		arr := make([]hist, 0, 20)
		for rows != nil && rows.Next() {
			var it hist
			_ = rows.Scan(&it.Data, &it.Etapa, &it.Sub, &it.Coment, &it.Tipo)
			arr = append(arr, it)
		}
		if rows != nil {
			rows.Close()
		}
		items[pid] = map[string]any{"id": pid, "historico": arr}
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

// callOpenAIJSON asks the model to return a JSON object
func (s *ResumoService) callOpenAIJSON(ctx context.Context, system, user string) (map[string]any, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return nil, Err("OPENAI_API_KEY não definido")
	}
	body := map[string]any{
		"model": "gpt-4o-mini",
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

// ProcessarResumos busca pendentes e gera texto
func (s *ResumoService) ProcessarResumos(ctx context.Context, limit int) error {
	if err := s.Repo.EnsureTable(ctx); err != nil {
		return err
	}
	ids, err := s.Repo.ListPending(ctx, limit)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		// silencioso quando não há pendentes
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
			_ = s.Repo.SaveReady(ctx, pid, sum, "openai", "gpt-4o-mini")
			seen[pid] = true
			okIDs = append(okIDs, pid)
		}
		// os que não vieram na resposta, marcam erro
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
