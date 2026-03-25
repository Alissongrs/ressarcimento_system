package handlers

import (
  "bytes"
  "context"
  "encoding/json"
  "fmt"
  "io"
  "mime/multipart"
  "net/http"
  "os"
  "os/exec"
  "path/filepath"
  "strconv"
  "strings"
  "time"

  "github.com/gin-gonic/gin"
)

// DesvioMedia runs the Python robot to analyze consumption (e.g. KWH_FPonta)
// grouped by UC + Concessionaria, with robust outlier and duplicate detection.
// @Summary Analisar desvio de media (Excel)
// @Tags OCR
// @Accept multipart/form-data
// @Produce json
// @Param file formData file true "Arquivo"
// @Param unit_col formData string false "Coluna UC"
// @Param concessionaria_col formData string false "Coluna Concessionaria"
// @Param value_col formData string false "Coluna valor"
// @Param placeholder formData string false "Placeholders"
// @Param min_base formData string false "Min base"
// @Param score_threshold formData string false "Score threshold"
// @Param pct_high formData string false "Pct high"
// @Param pct_low formData string false "Pct low"
// @Success 200 {object} map[string]any
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/ocr/desvio-media [post]
func DesvioMedia(c *gin.Context) {
  // Upload limit (MB) - optional via ENV
  maxMB := envIntDM("DESVIO_MEDIA_MAX_UPLOAD_MB", 25)
  c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, int64(maxMB)*1024*1024)

  file, err := c.FormFile("file")
  if err != nil {
    c.JSON(400, gin.H{"error": "Arquivo nao enviado."})
    return
  }

  tmp, err := os.CreateTemp("", "desvio-media-*"+filepath.Ext(file.Filename))
  if err != nil {
    c.JSON(500, gin.H{"error": "Falha ao criar arquivo temporario."})
    return
  }
  defer os.Remove(tmp.Name())
  defer tmp.Close()

  src, err := file.Open()
  if err != nil {
    c.JSON(500, gin.H{"error": "Falha ao abrir arquivo."})
    return
  }
  defer src.Close()

  if _, err := io.Copy(tmp, src); err != nil {
    c.JSON(500, gin.H{"error": "Falha ao salvar arquivo."})
    return
  }

  // Fields (defaults aligned with frontend)
  unitCol := c.DefaultPostForm("unit_col", "UC")
  concCol := c.DefaultPostForm("concessionaria_col", "Concessionaria")
  valueCol := c.DefaultPostForm("value_col", "KWH_FPonta")
  placeholder := c.DefaultPostForm("placeholder", "0,1,50")

  // New
  mesCol := strings.TrimSpace(c.PostForm("mes_col"))
  k := c.DefaultPostForm("k", "3.0")
  placeholderRepeat := c.DefaultPostForm("placeholder_repeat_threshold", "3")
  maxAnom := c.DefaultPostForm("max_anom", "200")

  // Excel optional
  sheet := strings.TrimSpace(c.PostForm("sheet"))
  headerRow := c.DefaultPostForm("header_row", "1")

  // Old thresholds
  minBase := c.DefaultPostForm("min_base", "8")
  scoreThreshold := c.DefaultPostForm("score_threshold", "3.0")
  pctHigh := c.DefaultPostForm("pct_high", "1.0")
  pctLow := c.DefaultPostForm("pct_low", "-0.9")

  pythonBin := strings.TrimSpace(os.Getenv("PYTHON_PATH"))
  if pythonBin == "" {
    // Try local venv in ocr_service before falling back to PATH
    cand := filepath.Join("..", "ocr_service", ".venv", "Scripts", "python.exe")
    if _, err := os.Stat(cand); err == nil {
      pythonBin = cand
    } else {
      pythonBin = "python"
    }
  }

  scriptPath := strings.TrimSpace(os.Getenv("DESVIO_MEDIA_PATH"))
  if scriptPath == "" {
    // default to ocr_service location
    scriptPath = filepath.Join("..", "ocr_service", "desvio_media.py")
  }

  // Timeout (seconds) - optional via ENV
  timeoutSec := envIntDM("DESVIO_MEDIA_TIMEOUT_SEC", 60)
  ctx, cancel := context.WithTimeout(c.Request.Context(), time.Duration(timeoutSec)*time.Second)
  defer cancel()

  args := []string{
    scriptPath,
    "--input", tmp.Name(),
    "--unit-col", unitCol,
    "--concessionaria-col", concCol,
    "--value-col", valueCol,
    "--placeholder", placeholder,
    "--min-base", minBase,
    "--score-threshold", scoreThreshold,
    "--pct-high", pctHigh,
    "--pct-low", pctLow,

    // new
    "--k", k,
    "--placeholder-repeat-threshold", placeholderRepeat,
    "--max-anom", maxAnom,
    "--header-row", headerRow,
    "--pretty",
  }

  if mesCol != "" {
    args = append(args, "--mes-col", mesCol)
  }
  if sheet != "" {
    args = append(args, "--sheet", sheet)
  }

  // If explicitly forced, proxy to OCR service instead of local python.
  if strings.TrimSpace(os.Getenv("DESVIO_MEDIA_FORCE_PROXY")) == "1" {
    if ok := proxyDesvioMedia(c, tmp.Name(), map[string]string{
      "unit_col":                     unitCol,
      "concessionaria_col":           concCol,
      "value_col":                    valueCol,
      "placeholder":                  placeholder,
      "min_base":                     minBase,
      "score_threshold":              scoreThreshold,
      "pct_high":                     pctHigh,
      "pct_low":                      pctLow,
      "k":                            k,
      "placeholder_repeat_threshold": placeholderRepeat,
      "max_anom":                     maxAnom,
      "header_row":                   headerRow,
      "sheet":                        sheet,
      "mes_col":                      mesCol,
      "instruction":                  strings.TrimSpace(c.PostForm("instruction")),
    }); ok {
      return
    }
  }

  cmd := exec.CommandContext(ctx, pythonBin, args...)
  var out bytes.Buffer
  var stderr bytes.Buffer
  cmd.Stdout = &out
  cmd.Stderr = &stderr

  if err := cmd.Run(); err != nil {
    if ctx.Err() == context.DeadlineExceeded {
      c.JSON(500, gin.H{
        "error":  "Timeout ao executar desvio_media.py",
        "detail": strings.TrimSpace(stderr.String()),
      })
      return
    }
    // If python/script missing in container, try proxy to OCR service.
    if proxyDesvioMedia(c, tmp.Name(), map[string]string{
      "unit_col":                     unitCol,
      "concessionaria_col":           concCol,
      "value_col":                    valueCol,
      "placeholder":                  placeholder,
      "min_base":                     minBase,
      "score_threshold":              scoreThreshold,
      "pct_high":                     pctHigh,
      "pct_low":                      pctLow,
      "k":                            k,
      "placeholder_repeat_threshold": placeholderRepeat,
      "max_anom":                     maxAnom,
      "header_row":                   headerRow,
      "sheet":                        sheet,
      "mes_col":                      mesCol,
      "instruction":                  strings.TrimSpace(c.PostForm("instruction")),
    }) {
      return
    }

    detail := strings.TrimSpace(stderr.String())
    if detail == "" {
      detail = err.Error()
    }
    c.JSON(500, gin.H{
      "error":  "Falha ao executar desvio_media.py",
      "detail": detail,
    })
    return
  }

  raw := out.Bytes()
  var payload any
  if err := json.Unmarshal(raw, &payload); err != nil {
    c.JSON(http.StatusOK, gin.H{
      "raw":    out.String(),
      "stderr": strings.TrimSpace(stderr.String()),
    })
    return
  }

  if m, ok := payload.(map[string]any); ok {
    m["params"] = map[string]any{
      "unit_col":                     unitCol,
      "concessionaria_col":           concCol,
      "value_col":                    valueCol,
      "mes_col":                      mesCol,
      "placeholder":                  placeholder,
      "min_base":                     mustInt(minBase),
      "score_threshold":              mustFloat(scoreThreshold),
      "pct_high":                     mustFloat(pctHigh),
      "pct_low":                      mustFloat(pctLow),
      "k":                            mustFloat(k),
      "placeholder_repeat_threshold": mustInt(placeholderRepeat),
      "max_anom":                     mustInt(maxAnom),
      "sheet":                        sheet,
      "header_row":                   mustInt(headerRow),
      "python_bin":                   pythonBin,
      "script_path":                  scriptPath,
    }
    c.JSON(http.StatusOK, m)
    return
  }

  c.JSON(http.StatusOK, payload)
}

// ------------------ helpers ------------------

// proxyDesvioMedia forwards the request to the OCR service when python is unavailable in backend container.
func proxyDesvioMedia(c *gin.Context, filePath string, fields map[string]string) bool {
  base := strings.TrimSpace(os.Getenv("OCR_BACKEND_URL"))
  if base == "" {
    return false
  }
  urlStr := strings.TrimRight(base, "/") + "/ocr/desvio-media"

  f, err := os.Open(filePath)
  if err != nil {
    return false
  }
  defer f.Close()

  var buf bytes.Buffer
  writer := multipart.NewWriter(&buf)
  part, err := writer.CreateFormFile("file", filepath.Base(filePath))
  if err != nil {
    return false
  }
  if _, err := io.Copy(part, f); err != nil {
    return false
  }
  for k, v := range fields {
    if strings.TrimSpace(v) == "" {
      continue
    }
    _ = writer.WriteField(k, v)
  }
  _ = writer.Close()

  req, err := http.NewRequest("POST", urlStr, &buf)
  if err != nil {
    return false
  }
  req.Header.Set("Content-Type", writer.FormDataContentType())

  client := &http.Client{Timeout: 120 * time.Second}
  resp, err := client.Do(req)
  if err != nil {
    return false
  }
  defer resp.Body.Close()
  data, _ := io.ReadAll(resp.Body)
  c.Data(resp.StatusCode, resp.Header.Get("Content-Type"), data)
  return true
}

func envIntDM(key string, def int) int {
  v := strings.TrimSpace(os.Getenv(key))
  if v == "" {
    return def
  }
  n, err := strconv.Atoi(v)
  if err != nil {
    return def
  }
  return n
}

func mustInt(v string) int {
  v = strings.TrimSpace(v)
  if v == "" {
    return 0
  }
  n, _ := strconv.Atoi(v)
  return n
}

func mustFloat(v string) float64 {
  v = strings.TrimSpace(v)
  if v == "" {
    return 0
  }
  v = strings.ReplaceAll(v, ",", ".")
  f, _ := strconv.ParseFloat(v, 64)
  return f
}

// optional: custom temp name
func tmpName(ext string) string {
  if ext == "" {
    ext = ".xlsx"
  }
  return filepath.Join(os.TempDir(), fmt.Sprintf("desvio-media-%d%s", time.Now().UnixNano(), ext))
}
