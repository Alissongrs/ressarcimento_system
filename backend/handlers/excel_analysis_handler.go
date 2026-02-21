package handlers

import (
	"encoding/json"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xuri/excelize/v2"
)

type excelAnalyzeResult struct {
	Unit      string  `json:"unit"`
	Mean      float64 `json:"mean"`
	Count     int     `json:"count"`
	Deviation float64 `json:"deviation"`
	ZScore    float64 `json:"zscore"`
}

// AnalyzeExcelMetric processa um Excel e calcula media e outliers por unidade.
// Espera arquivo (multipart) em "file" e instrucao opcional em "instruction".
// @Summary Analise simples de Excel
// @Tags OCR
// @Accept multipart/form-data
// @Produce json
// @Param file formData file true "Arquivo"
// @Param instruction formData string false "Instrucao"
// @Param unit_field formData string false "Campo unidade"
// @Param value_field formData string false "Campo valor"
// @Param outlier_method formData string false "Metodo"
// @Param zscore_threshold formData number false "Threshold"
// @Success 200 {object} map[string]any
// @Failure 400 {object} map[string]string
// @Router /api/v1/ocr/excel/analyze [post]
func AnalyzeExcelMetric(c *gin.Context) {
	file, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Arquivo obrigatorio"})
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
		c.JSON(http.StatusBadRequest, gin.H{"error": "Formato do Excel invalido"})
		return
	}

	sheet := f.GetSheetName(f.GetActiveSheetIndex())
	rows, err := f.GetRows(sheet)
	if err != nil || len(rows) < 2 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Planilha sem dados"})
		return
	}

	instruction := strings.TrimSpace(c.PostForm("instruction"))
	unitField := strings.TrimSpace(c.PostForm("unit_field"))
	valueField := strings.TrimSpace(c.PostForm("value_field"))
	method := strings.ToLower(strings.TrimSpace(c.DefaultPostForm("outlier_method", "zscore")))
	thresholdStr := strings.TrimSpace(c.DefaultPostForm("zscore_threshold", "2"))
	threshold := 2.0
	if v, err := strconv.ParseFloat(thresholdStr, 64); err == nil && v > 0 {
		threshold = v
	}

	headerMap := map[int]string{}
	normHeaderMap := map[string]int{}
	for idx, col := range rows[0] {
		name := strings.TrimSpace(col)
		if name == "" {
			continue
		}
		headerMap[idx] = name
		normHeaderMap[normalizeHeader(name)] = idx
	}

	if len(headerMap) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Cabecalhos nao reconhecidos"})
		return
	}

	if unitField == "" {
		if _, ok := normHeaderMap["uc"]; ok {
			unitField = "UC"
		} else if _, ok := normHeaderMap["cod_uc"]; ok {
			unitField = "Cod_UC"
		}
	}

	if valueField == "" {
		valueField = detectValueField(instruction, normHeaderMap)
	}
	if valueField == "" {
		if _, ok := normHeaderMap["kwh_fponta"]; ok {
			valueField = "KWH_FPonta"
		}
	}

	unitIdx, okUnit := normHeaderMap[normalizeHeader(unitField)]
	valueIdx, okValue := normHeaderMap[normalizeHeader(valueField)]
	if !okUnit || !okValue {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":       "Colunas nao encontradas",
			"unit_field":  unitField,
			"value_field": valueField,
		})
		return
	}

	sumByUnit := map[string]float64{}
	countByUnit := map[string]int{}
	totalRows := 0
	validRows := 0

	for rowIdx := 1; rowIdx < len(rows); rowIdx++ {
		row := rows[rowIdx]
		totalRows++
		unit := strings.TrimSpace(getCell(row, unitIdx))
		if unit == "" {
			continue
		}
		raw := strings.TrimSpace(getCell(row, valueIdx))
		if raw == "" {
			continue
		}
		val, ok := parseNumberBR(raw)
		if !ok {
			continue
		}
		validRows++
		sumByUnit[unit] += val
		countByUnit[unit] += 1
	}

	units := make([]excelAnalyzeResult, 0, len(sumByUnit))
	for unit, sum := range sumByUnit {
		count := countByUnit[unit]
		if count == 0 {
			continue
		}
		mean := sum / float64(count)
		units = append(units, excelAnalyzeResult{
			Unit:  unit,
			Mean:  mean,
			Count: count,
		})
	}

	if len(units) == 0 {
		c.JSON(http.StatusOK, gin.H{
			"ok":          true,
			"unit_field":  unitField,
			"value_field": valueField,
			"rows":        totalRows,
			"valid_rows":  validRows,
			"total_units": 0,
			"message":     "Nenhum valor valido encontrado.",
		})
		return
	}

	overallMean, overallStd := meanStd(units)
	outliers := make([]excelAnalyzeResult, 0)
	for i := range units {
		units[i].Deviation = units[i].Mean - overallMean
		if overallStd > 0 {
			units[i].ZScore = units[i].Deviation / overallStd
		}
		if method == "zscore" && math.Abs(units[i].ZScore) >= threshold {
			outliers = append(outliers, units[i])
		}
	}

	sort.Slice(units, func(i, j int) bool {
		return units[i].Mean > units[j].Mean
	})
	sort.Slice(outliers, func(i, j int) bool {
		return math.Abs(outliers[i].ZScore) > math.Abs(outliers[j].ZScore)
	})

	c.JSON(http.StatusOK, gin.H{
		"ok":           true,
		"unit_field":   unitField,
		"value_field":  valueField,
		"rows":         totalRows,
		"valid_rows":   validRows,
		"total_units":  len(units),
		"overall_mean": overallMean,
		"overall_std":  overallStd,
		"method":       method,
		"threshold":    threshold,
		"outliers":     outliers,
		"units":        units,
	})
}

func detectValueField(instruction string, normHeaderMap map[string]int) string {
	if instruction == "" {
		return ""
	}
	normalized := normalizeHeader(instruction)
	for key := range normHeaderMap {
		if strings.Contains(normalized, key) {
			return key
		}
	}
	// tenta pegar algo do tipo kwh_foraponta ou kwhfponta
	re := regexp.MustCompile(`kwh[_\-\s]*f?ponta`)
	if re.MatchString(normalized) {
		if _, ok := normHeaderMap["kwh_fponta"]; ok {
			return "kwh_fponta"
		}
	}
	return ""
}

func normalizeHeader(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	re := regexp.MustCompile(`[^a-z0-9]+`)
	return re.ReplaceAllString(s, "_")
}

func getCell(row []string, idx int) string {
	if idx < 0 || idx >= len(row) {
		return ""
	}
	return row[idx]
}

func parseNumberBR(raw string) (float64, bool) {
	clean := strings.TrimSpace(raw)
	if clean == "" {
		return 0, false
	}
	// tenta JSON number simples
	if strings.HasPrefix(clean, "{") || strings.HasPrefix(clean, "[") {
		var v any
		if err := json.Unmarshal([]byte(clean), &v); err == nil {
			if num, ok := v.(float64); ok {
				return num, true
			}
		}
	}
	// remove separadores de milhar e usa ponto como decimal
	clean = strings.ReplaceAll(clean, ".", "")
	clean = strings.ReplaceAll(clean, ",", ".")
	val, err := strconv.ParseFloat(clean, 64)
	if err != nil {
		return 0, false
	}
	return val, true
}

func meanStd(items []excelAnalyzeResult) (mean float64, std float64) {
	if len(items) == 0 {
		return 0, 0
	}
	sum := 0.0
	for _, it := range items {
		sum += it.Mean
	}
	mean = sum / float64(len(items))
	variance := 0.0
	for _, it := range items {
		d := it.Mean - mean
		variance += d * d
	}
	variance /= float64(len(items))
	std = math.Sqrt(variance)
	return
}
