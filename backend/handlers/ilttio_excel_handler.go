package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xuri/excelize/v2"
)

type ExcelIlttioResult struct {
	Identifier   string            `json:"identifier"`
	UC           string            `json:"uc,omitempty"`
	RuleResults  map[string]any    `json:"rule_results"`
	Diagnostics  map[string]any    `json:"diagnostics"`
	RawRowValues map[string]string `json:"raw_row_values"`
	HasError     bool              `json:"has_error"`
	ErrorMessage string            `json:"error_message,omitempty"`
}

type ExcelIlttioResponse struct {
	Rows []ExcelIlttioResult `json:"rows"`
}

const defaultOcrServiceURL = "http://ocr:8000"

// ImportIlttioExcel godoc
// @Summary      Importa planilha Ilttio
// @Tags         OCR
// @Accept       multipart/form-data
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/ocr/excel [post]
func ImportIlttioExcel(c *gin.Context) {
	file, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Arquivo obrigatório"})
		return
	}

	fd, err := file.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Falha ao abrir arquivo"})
		return
	}
	defer fd.Close()

	f, err := excelize.OpenReader(fd)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Formato do Excel inválido"})
		return
	}

	sheet := f.GetSheetName(f.GetActiveSheetIndex())
	rows, err := f.GetRows(sheet)
	if err != nil || len(rows) < 2 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Planilha sem dados"})
		return
	}

	headerMap := map[int]string{}
	for idx, col := range rows[0] {
		if key := normalizeColumnHeader(col); key != "" {
			headerMap[idx] = key
		}
	}

	if len(headerMap) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Cabeçalhos não reconhecidos"})
		return
	}

	rules := parseRulesField(c.PostForm("rules"))
	if len(rules) == 0 {
		rules = []string{"ILTTIO"}
	}

	results := make([]ExcelIlttioResult, 0, len(rows)-1)
	ctx := c.Request.Context()

	for rowIdx := 1; rowIdx < len(rows); rowIdx++ {
		raw := rows[rowIdx]
		values := map[string]string{}
		for idx, cell := range raw {
			if key, ok := headerMap[idx]; ok {
				values[key] = strings.TrimSpace(cell)
			}
		}
		if len(values) == 0 {
			continue
		}

		text := buildRowText(values)
		ruleRes, callErr := callIlttioInterpret(ctx, text, rules)

		diagnostics, _ := ruleRes["ILTTIO"].(map[string]any)

		result := ExcelIlttioResult{
			Identifier:   pickIdentifier(values, rowIdx),
			UC:           strings.TrimSpace(values["uc"]),
			RuleResults:  ruleRes,
			Diagnostics:  diagnostics,
			RawRowValues: values,
			HasError:     callErr != nil,
		}
		if callErr != nil {
			result.ErrorMessage = callErr.Error()
		}
		results = append(results, result)
	}

	c.JSON(http.StatusOK, ExcelIlttioResponse{Rows: results})
}

func normalizeColumnHeader(name string) string {
	lower := strings.ToLower(strings.TrimSpace(name))
	switch {
	case strings.Contains(lower, "uc") && strings.Contains(lower, "unidade"):
		return "uc"
	case strings.Contains(lower, "uc"):
		return "uc"
	case strings.Contains(lower, "cliente"):
		return "cliente"
	case strings.Contains(lower, "leitura anterior"):
		return "leitura_anterior"
	case strings.Contains(lower, "leitura atual"):
		return "leitura_atual"
	case strings.Contains(lower, "dias"):
		return "dias"
	case strings.Contains(lower, "consumo"):
		if strings.Contains(lower, "historico") {
			return "historico_consumo"
		}
		return "consumo_atual"
	case strings.Contains(lower, "energia injetada") || strings.Contains(lower, "energia compensada"):
		return "energia_injetada"
	case strings.Contains(lower, "icms"):
		return "icms_injetada"
	case strings.Contains(lower, "pis"):
		return "pis"
	case strings.Contains(lower, "cofins"):
		return "cofins"
	case strings.Contains(lower, "tarifa unit"):
		return "tarifa_unitaria"
	case strings.Contains(lower, "tarifa com"):
		return "tarifa_tributada"
	case strings.Contains(lower, "te"):
		return "te"
	case strings.Contains(lower, "tusd"):
		return "tusd"
	case strings.Contains(lower, "estado"):
		return "estado"
	case strings.Contains(lower, "modalidade"):
		return "modalidade"
	case strings.Contains(lower, "tipo"):
		return "tipo_consumidor"
	default:
		return ""
	}
}

func pickIdentifier(values map[string]string, rowIdx int) string {
	if v := values["uc"]; v != "" {
		return v
	}
	if v := values["cliente"]; v != "" {
		return v
	}
	if v := values["tipo_consumidor"]; v != "" {
		return v
	}
	return fmt.Sprintf("linha-%d", rowIdx+1)
}

func buildRowText(values map[string]string) string {
	order := []struct {
		key   string
		label string
	}{
		{"uc", "UC"},
		{"cliente", "Cliente"},
		{"leitura_anterior", "Leitura Anterior"},
		{"leitura_atual", "Leitura Atual"},
		{"dias", "Dias de Consumo"},
		{"consumo_atual", "Consumo Atual"},
		{"historico_consumo", "Histórico de consumo mensal"},
		{"energia_injetada", "Energia Injetada"},
		{"icms_injetada", "ICMS Energia Injetada"},
		{"pis", "PIS"},
		{"cofins", "COFINS"},
		{"tarifa_unitaria", "Tarifa Unitária"},
		{"tarifa_tributada", "Tarifa com tributos"},
		{"te", "TE"},
		{"tusd", "TUSD"},
		{"estado", "Estado"},
		{"modalidade", "Modalidade GD"},
		{"tipo_consumidor", "Tipo de consumidor"},
	}
	var b strings.Builder
	for _, item := range order {
		if val := values[item.key]; val != "" {
			b.WriteString(fmt.Sprintf("%s: %s\n", item.label, val))
		}
	}
	return b.String()
}

func parseRulesField(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var parsed []string
	if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
		return normalizeRuleList(parsed)
	}
	parts := strings.Split(raw, ",")
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			parsed = append(parsed, part)
		}
	}
	return normalizeRuleList(parsed)
}

func normalizeRuleList(list []string) []string {
	if len(list) == 0 {
		return nil
	}
	out := make([]string, 0, len(list))
	seen := make(map[string]struct{}, len(list))
	for _, item := range list {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, exists := seen[item]; exists {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	return out
}

func callIlttioInterpret(ctx context.Context, text string, rules []string) (map[string]any, error) {
	url := strings.TrimSpace(os.Getenv("OCR_SERVICE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("OCR_BACKEND_URL"))
	}
	if url == "" {
		url = defaultOcrServiceURL
	}
	url = strings.TrimRight(url, "/") + "/ocr/interpret_json"

	if len(rules) == 0 {
		rules = []string{"ILTTIO"}
	}

	payload := map[string]any{
		"request_id": uuid.NewString(),
		"filename":   "excel-import",
		"ocr_text":   text,
		"rules":      rules,
		"use_llm":    false,
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("erro OCR service: %s", string(respBody))
	}

	var parsed struct {
		RuleResults map[string]any `json:"rule_results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, err
	}

	return parsed.RuleResults, nil
}
