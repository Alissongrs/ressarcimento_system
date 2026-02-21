package handlers

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type Rule struct {
	ID             int       `json:"id"`
	Name           string    `json:"name"`
	Distribuidoras []string  `json:"distribuidoras"`
	Grupo          string    `json:"grupo"`
	Periodo        string    `json:"periodo"`
	Tipo           string    `json:"tipo"`
	Active         bool      `json:"active"`
	NaturalText    string    `json:"natural_text"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

var (
	rulesMu sync.Mutex
	rulesDB = struct {
		NextID int    `json:"next_id"`
		Items  []Rule `json:"items"`
	}{NextID: 1, Items: []Rule{}}
)

func rulesPath() string { return filepath.Join("data", "rules.json") }

func ensureRulesDir() error { return os.MkdirAll("data", 0o755) }

func loadRules() {
	b, err := os.ReadFile(rulesPath())
	if err != nil {
		return
	}
	_ = json.Unmarshal(b, &rulesDB)
	if rulesDB.NextID <= 0 {
		rulesDB.NextID = 1
	}
}

func saveRules() {
	_ = ensureRulesDir()
	b, _ := json.MarshalIndent(rulesDB, "", "  ")
	_ = os.WriteFile(rulesPath(), b, 0o644)
}

func init() { loadRules() }

// Seed default rule if empty
func init() {
	rulesMu.Lock()
	defer rulesMu.Unlock()
	if len(rulesDB.Items) == 0 {
		now := time.Now()
		rulesDB.Items = append(rulesDB.Items, Rule{
			ID:             rulesDB.NextID,
			Name:           "ENEL SP - Grupo B - Bandeira (09/2024)",
			Distribuidoras: []string{"ENEL SP"},
			Grupo:          "Grupo B",
			Periodo:        "092024",
			Tipo:           "BANDEIRA_ENEL_SP_GB",
			Active:         true,
			NaturalText:    "Regra inicial: ENEL SP, Grupo B, mês 09/2024, leitura 01-06/09, verificar bandeira tarifária incorreta.",
			CreatedAt:      now,
			UpdatedAt:      now,
		})
		rulesDB.NextID++
		saveRules()
	}
}

// GET /api/v1/rules
// @Summary Listar regras
// @Tags Regras
// @Produce json
// @Success 200 {object} map[string][]Rule
// @Router /api/v1/rules [get]
func GetRules(c *gin.Context) {
	rulesMu.Lock()
	defer rulesMu.Unlock()
	c.JSON(http.StatusOK, gin.H{"items": rulesDB.Items})
}

// GET /api/v1/rules/active
// @Summary Listar regras ativas
// @Tags Regras
// @Produce json
// @Success 200 {object} map[string][]Rule
// @Router /api/v1/rules/active [get]
func GetActiveRules(c *gin.Context) {
	rulesMu.Lock()
	defer rulesMu.Unlock()
	out := make([]Rule, 0, len(rulesDB.Items))
	for _, r := range rulesDB.Items {
		if r.Active {
			out = append(out, r)
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// POST /api/v1/rules
// @Summary Criar regra
// @Tags Regras
// @Accept json
// @Produce json
// @Param body body Rule true "Regra"
// @Success 201 {object} Rule
// @Failure 400 {object} map[string]string
// @Router /api/v1/rules [post]
func CreateRule(c *gin.Context) {
	var r Rule
	if err := c.ShouldBindJSON(&r); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "JSON inválido"})
		return
	}
	rulesMu.Lock()
	defer rulesMu.Unlock()
	r.ID = rulesDB.NextID
	rulesDB.NextID++
	now := time.Now()
	r.CreatedAt = now
	r.UpdatedAt = now
	normalizeRule(&r)
	rulesDB.Items = append(rulesDB.Items, r)
	saveRules()
	c.JSON(http.StatusCreated, r)
}

// PUT /api/v1/rules/:id
// @Summary Atualizar regra
// @Tags Regras
// @Accept json
// @Produce json
// @Param id path int true "ID da regra"
// @Param body body Rule true "Regra"
// @Success 200 {object} Rule
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /api/v1/rules/{id} [put]
func UpdateRule(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var in Rule
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "JSON inválido"})
		return
	}
	rulesMu.Lock()
	defer rulesMu.Unlock()
	for i := range rulesDB.Items {
		if rulesDB.Items[i].ID == id {
			in.ID = id
			in.CreatedAt = rulesDB.Items[i].CreatedAt
			in.UpdatedAt = time.Now()
			normalizeRule(&in)
			rulesDB.Items[i] = in
			saveRules()
			c.JSON(http.StatusOK, in)
			return
		}
	}
	c.JSON(http.StatusNotFound, gin.H{"error": "regra não encontrada"})
}

// DELETE /api/v1/rules/:id
// @Summary Excluir regra
// @Tags Regras
// @Produce json
// @Param id path int true "ID da regra"
// @Success 200 {object} map[string]bool
// @Failure 404 {object} map[string]string
// @Router /api/v1/rules/{id} [delete]
func DeleteRule(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	rulesMu.Lock()
	defer rulesMu.Unlock()
	out := make([]Rule, 0, len(rulesDB.Items))
	found := false
	for _, r := range rulesDB.Items {
		if r.ID == id {
			found = true
			continue
		}
		out = append(out, r)
	}
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "regra não encontrada"})
		return
	}
	rulesDB.Items = out
	saveRules()
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/v1/rules/interpret { text: string }
// Usa OpenAI (OCRChat) para sugerir campos estruturados.
// @Summary Interpretar regra (IA)
// @Tags Regras
// @Accept json
// @Produce json
// @Param body body map[string]string true "Texto"
// @Success 200 {object} map[string]any
// @Failure 400 {object} map[string]string
// @Router /api/v1/rules/interpret [post]
func InterpretRule(c *gin.Context) {
	var body struct {
		Text string `json:"text"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.Text) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "text obrigatório"})
		return
	}
	// Reaproveita OCRChat: mensagens (system+user)
	prompt := `Você transforma uma regra em linguagem natural em campos estruturados JSON.
Campos: name, distribuidoras (array), grupo (string), periodo (string), tipo (string), active (bool), natural_text (string).
Responda apenas JSON.`
	req := gin.H{
		"messages": []gin.H{
			{"role": "system", "content": prompt},
			{"role": "user", "content": strings.TrimSpace(body.Text)},
		},
	}
	// Encaminha para OCRChat internamente
	c.Request.Body = ioNopCloserFrom(req)
	OCRChat(c)
}

// Util: construir io.ReadCloser de JSON
type rc struct{ *strings.Reader }

func (r rc) Close() error { return nil }
func ioNopCloserFrom(v any) rc {
	b, _ := json.Marshal(v)
	return rc{strings.NewReader(string(b))}
}

func normalizeRule(r *Rule) {
	r.Name = strings.TrimSpace(r.Name)
	r.Grupo = strings.TrimSpace(r.Grupo)
	r.Periodo = strings.TrimSpace(r.Periodo)
	r.Tipo = strings.TrimSpace(r.Tipo)
	r.NaturalText = strings.TrimSpace(r.NaturalText)
	if len(r.Distribuidoras) > 0 {
		out := make([]string, 0, len(r.Distribuidoras))
		for _, s := range r.Distribuidoras {
			s = strings.TrimSpace(s)
			if s != "" {
				out = append(out, s)
			}
		}
		r.Distribuidoras = out
	}
}
