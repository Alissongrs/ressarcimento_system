package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

type Rule struct {
	ID             int        `json:"id"`
	Name           string     `json:"name"`
	Distribuidoras []string   `json:"distribuidoras"`
	Grupo          string     `json:"grupo"`
	Periodo        string     `json:"periodo"`
	Tipo           string     `json:"tipo"`
	Active         bool       `json:"active"`
	NaturalText    string     `json:"natural_text"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
	PendingApply   bool       `json:"pending_apply"`           // marcada p/ "passar ao banco"
	ScheduledFor   *time.Time `json:"scheduled_for,omitempty"` // 00:00 do próximo dia
	AppliedAt      *time.Time `json:"applied_at,omitempty"`    // quando foi aplicada no banco
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

// ============================================================================
// "Passar a regra no banco" — deferido para 00:00 do dia seguinte, reversível.
// O usuário cria/edita a regra e pede "passar": ela fica PENDENTE, agendada p/ o
// próximo 00:00. Um job (cron) chama AplicarRegrasAgendadas, que grava a regra na
// tabela DM_REGRAS (UPSERT) com backup em DM_REGRAS_BACKUP (undo).
// ============================================================================

func regrasDB() *sql.DB {
	if database.GormDB_App == nil {
		return nil
	}
	db, err := database.GormDB_App.DB()
	if err != nil {
		return nil
	}
	ensureRegrasTable(db)
	return db
}

func ensureRegrasTable(db *sql.DB) {
	_, _ = db.Exec(`
CREATE TABLE IF NOT EXISTS DM_REGRAS (
  id            INT PRIMARY KEY,
  name          VARCHAR(255) NULL,
  distribuidoras TEXT NULL,
  grupo         VARCHAR(80) NULL,
  periodo       VARCHAR(40) NULL,
  tipo          VARCHAR(120) NULL,
  active        TINYINT NOT NULL DEFAULT 1,
  natural_text  TEXT NULL,
  aplicada_em   DATETIME NULL,
  atualizado_em DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	_, _ = db.Exec(`
CREATE TABLE IF NOT EXISTS DM_REGRAS_BACKUP (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  regra_id     INT NOT NULL,
  valor_antigo TEXT NULL,   -- NULL = era inserção (reverter = DELETE)
  valor_novo   TEXT NULL,
  criado_em    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revertido_em DATETIME NULL,
  KEY k_regra (regra_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// proximaMeiaNoite devolve o 00:00 do DIA SEGUINTE (horário local do servidor).
func proximaMeiaNoite(now time.Time) time.Time {
	y, m, d := now.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, now.Location()).Add(24 * time.Hour)
}

func findRule(id int) *Rule {
	for i := range rulesDB.Items {
		if rulesDB.Items[i].ID == id {
			return &rulesDB.Items[i]
		}
	}
	return nil
}

// POST /api/v1/rules/:id/passar — agenda a regra p/ ser gravada no banco às 00:00 do dia seguinte.
func PassarRegra(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	rulesMu.Lock()
	defer rulesMu.Unlock()
	r := findRule(id)
	if r == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "regra não encontrada"})
		return
	}
	when := proximaMeiaNoite(time.Now())
	r.PendingApply = true
	r.ScheduledFor = &when
	r.UpdatedAt = time.Now()
	saveRules()
	c.JSON(http.StatusOK, gin.H{"ok": true, "scheduled_for": when})
}

// POST /api/v1/rules/:id/cancelar-passagem — desfaz o agendamento (antes de aplicar).
func CancelarPassagemRegra(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	rulesMu.Lock()
	defer rulesMu.Unlock()
	r := findRule(id)
	if r == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "regra não encontrada"})
		return
	}
	r.PendingApply = false
	r.ScheduledFor = nil
	r.UpdatedAt = time.Now()
	saveRules()
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/v1/rules/aplicar-agendadas — chamado pelo CRON (00:00). Protegido por token
// (header X-Cron-Token == env CRON_TOKEN). Aplica as regras pendentes cujo horário chegou.
func AplicarRegrasAgendadas(c *gin.Context) {
	tok := strings.TrimSpace(os.Getenv("CRON_TOKEN"))
	if tok == "" || c.GetHeader("X-Cron-Token") != tok {
		c.JSON(http.StatusForbidden, gin.H{"error": "token de cron inválido"})
		return
	}
	db := regrasDB()
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return
	}
	now := time.Now()
	aplicadas := []int{}
	rulesMu.Lock()
	defer rulesMu.Unlock()
	for i := range rulesDB.Items {
		r := &rulesDB.Items[i]
		if r.PendingApply && r.ScheduledFor != nil && !r.ScheduledFor.After(now) {
			if err := aplicarRegraNoBanco(db, r); err != nil {
				continue // deixa pendente p/ a próxima rodada
			}
			t := now
			r.AppliedAt = &t
			r.PendingApply = false
			r.ScheduledFor = nil
			r.UpdatedAt = now
			aplicadas = append(aplicadas, r.ID)
		}
	}
	saveRules()
	c.JSON(http.StatusOK, gin.H{"ok": true, "aplicadas": aplicadas})
}

// aplicarRegraNoBanco grava (UPSERT) a regra em DM_REGRAS, salvando antes o estado
// anterior em DM_REGRAS_BACKUP (undo).
func aplicarRegraNoBanco(db *sql.DB, r *Rule) error {
	dist, _ := json.Marshal(r.Distribuidoras)

	// snapshot anterior (p/ reverter) — NULL se for inserção nova
	var oName, oDist, oGrupo, oPeriodo, oTipo, oNat sql.NullString
	var oActive sql.NullInt64
	existed := db.QueryRow(
		`SELECT name,distribuidoras,grupo,periodo,tipo,active,natural_text FROM DM_REGRAS WHERE id=?`, r.ID).
		Scan(&oName, &oDist, &oGrupo, &oPeriodo, &oTipo, &oActive, &oNat) == nil
	var antigo interface{}
	if existed {
		b, _ := json.Marshal(map[string]interface{}{
			"name": oName.String, "distribuidoras": oDist.String, "grupo": oGrupo.String,
			"periodo": oPeriodo.String, "tipo": oTipo.String, "active": oActive.Int64, "natural_text": oNat.String,
		})
		antigo = string(b)
	}
	novo, _ := json.Marshal(map[string]interface{}{
		"name": r.Name, "distribuidoras": string(dist), "grupo": r.Grupo,
		"periodo": r.Periodo, "tipo": r.Tipo, "active": b2i(r.Active), "natural_text": r.NaturalText,
	})
	_, _ = db.Exec(`INSERT INTO DM_REGRAS_BACKUP (regra_id, valor_antigo, valor_novo, criado_em) VALUES (?,?,?,NOW())`,
		r.ID, antigo, string(novo))

	_, err := db.Exec(`
INSERT INTO DM_REGRAS (id,name,distribuidoras,grupo,periodo,tipo,active,natural_text,aplicada_em,atualizado_em)
VALUES (?,?,?,?,?,?,?,?,NOW(),NOW())
ON DUPLICATE KEY UPDATE name=VALUES(name),distribuidoras=VALUES(distribuidoras),grupo=VALUES(grupo),
  periodo=VALUES(periodo),tipo=VALUES(tipo),active=VALUES(active),natural_text=VALUES(natural_text),
  aplicada_em=NOW(),atualizado_em=NOW()`,
		r.ID, r.Name, string(dist), r.Grupo, r.Periodo, r.Tipo, b2i(r.Active), r.NaturalText)
	return err
}

// POST /api/v1/rules/:id/reverter-aplicacao — desfaz a última aplicação no banco.
func ReverterAplicacaoRegra(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	db := regrasDB()
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return
	}
	var bid int64
	var antigo sql.NullString
	err := db.QueryRow(
		`SELECT id, valor_antigo FROM DM_REGRAS_BACKUP WHERE regra_id=? AND revertido_em IS NULL ORDER BY id DESC LIMIT 1`, id).
		Scan(&bid, &antigo)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "nada a reverter para esta regra"})
		return
	}
	if !antigo.Valid { // era inserção → remove
		_, _ = db.Exec(`DELETE FROM DM_REGRAS WHERE id=?`, id)
	} else {
		var o struct {
			Name, Distribuidoras, Grupo, Periodo, Tipo, NaturalText string
			Active                                                  int64
		}
		var m map[string]interface{}
		_ = json.Unmarshal([]byte(antigo.String), &m)
		gs := func(k string) string { s, _ := m[k].(string); return s }
		o.Name, o.Distribuidoras, o.Grupo = gs("name"), gs("distribuidoras"), gs("grupo")
		o.Periodo, o.Tipo, o.NaturalText = gs("periodo"), gs("tipo"), gs("natural_text")
		if f, ok := m["active"].(float64); ok {
			o.Active = int64(f)
		}
		_, _ = db.Exec(`UPDATE DM_REGRAS SET name=?,distribuidoras=?,grupo=?,periodo=?,tipo=?,active=?,natural_text=?,atualizado_em=NOW() WHERE id=?`,
			o.Name, o.Distribuidoras, o.Grupo, o.Periodo, o.Tipo, o.Active, o.NaturalText, id)
	}
	_, _ = db.Exec(`UPDATE DM_REGRAS_BACKUP SET revertido_em=NOW() WHERE id=?`, bid)

	rulesMu.Lock()
	if r := findRule(id); r != nil {
		r.AppliedAt = nil
		r.UpdatedAt = time.Now()
		saveRules()
	}
	rulesMu.Unlock()
	c.JSON(http.StatusOK, gin.H{"ok": true})
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
