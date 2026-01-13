package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

func ensureAIResumoFeedbackTable() error {
	_, err := database.DB_App.Exec(`
		CREATE TABLE IF NOT EXISTS ai_resumo_feedback (
		  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		  processo_id BIGINT UNSIGNED NOT NULL,
		  model VARCHAR(100) NOT NULL,
		  prompt_version VARCHAR(50) NOT NULL,
		  input_hash CHAR(64) NOT NULL,
		  input_payload JSON NOT NULL,
		  output_text LONGTEXT NOT NULL,
		  label ENUM('aceitar','parcial','nada_a_ver') NOT NULL,
		  comentario TEXT NULL,
		  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
		  created_by BIGINT UNSIGNED NULL,
		  PRIMARY KEY (id),
		  KEY idx_processo (processo_id),
		  KEY idx_label (label),
		  KEY idx_created_at (created_at),
		  UNIQUE KEY uq_input_hash (input_hash)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`)
	return err
}

type resumoFeedbackIn struct {
	ProcessoID    int64           `json:"processo_id"`
	Model         string          `json:"model"`
	PromptVersion string          `json:"prompt_version"`
	InputHash     string          `json:"input_hash"`
	InputPayload  json.RawMessage `json:"input_payload"`
	OutputText    string          `json:"output_text"`
	Label         string          `json:"label"`
	Comentario    string          `json:"comentario"`
}

// POST /api/v1/ai/resumo/feedback
func CreateResumoFeedback(c *gin.Context) {
	var uid int64
	if v, ok := c.Get("userID"); ok {
		if id, ok2 := v.(int64); ok2 {
			uid = id
		}
	}
	if uid == 0 {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "não autenticado"})
		return
	}

	var in resumoFeedbackIn
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
		return
	}

	in.Model = strings.TrimSpace(in.Model)
	in.PromptVersion = strings.TrimSpace(in.PromptVersion)
	in.Label = strings.ToLower(strings.TrimSpace(in.Label))
	in.OutputText = strings.TrimSpace(in.OutputText)
	in.Comentario = strings.TrimSpace(in.Comentario)

	if in.ProcessoID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "processo_id obrigatório"})
		return
	}
	if in.Model == "" || in.PromptVersion == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "model e prompt_version obrigatórios"})
		return
	}
	if len(in.InputPayload) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "input_payload obrigatório"})
		return
	}
	if in.OutputText == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "output_text obrigatório"})
		return
	}
	if in.Label != "aceitar" && in.Label != "parcial" && in.Label != "nada_a_ver" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "label inválido"})
		return
	}

	if strings.TrimSpace(in.InputHash) == "" {
		hashBase := in.Model + "\n" + in.PromptVersion + "\n" + string(in.InputPayload)
		sum := sha256.Sum256([]byte(hashBase))
		in.InputHash = hex.EncodeToString(sum[:])
	}

	if err := ensureAIResumoFeedbackTable(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao preparar tabela de feedback"})
		return
	}

	_, err := database.DB_App.Exec(`
		INSERT INTO ai_resumo_feedback (
			processo_id, model, prompt_version, input_hash, input_payload, output_text, label, comentario, created_by
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			label = VALUES(label),
			comentario = VALUES(comentario),
			output_text = VALUES(output_text),
			created_by = VALUES(created_by),
			created_at = CURRENT_TIMESTAMP
	`, in.ProcessoID, in.Model, in.PromptVersion, in.InputHash, in.InputPayload, in.OutputText, in.Label, in.Comentario, uid)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "doesn't exist") ||
			strings.Contains(strings.ToLower(err.Error()), "nao existe") {
			if err2 := ensureAIResumoFeedbackTable(); err2 == nil {
				_, err = database.DB_App.Exec(`
					INSERT INTO ai_resumo_feedback (
						processo_id, model, prompt_version, input_hash, input_payload, output_text, label, comentario, created_by
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON DUPLICATE KEY UPDATE
						label = VALUES(label),
						comentario = VALUES(comentario),
						output_text = VALUES(output_text),
						created_by = VALUES(created_by),
						created_at = CURRENT_TIMESTAMP
				`, in.ProcessoID, in.Model, in.PromptVersion, in.InputHash, in.InputPayload, in.OutputText, in.Label, in.Comentario, uid)
				if err == nil {
					c.JSON(http.StatusCreated, gin.H{"ok": true, "input_hash": in.InputHash})
					return
				}
			}
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao salvar feedback"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"ok": true, "input_hash": in.InputHash})
}
