//
package repositories

import (
	"context"
	"database/sql"
	"encoding/json"
)

type OCRResultRepo struct {
	db *sql.DB
}

func NewOCRResultRepo(db *sql.DB) *OCRResultRepo {
	return &OCRResultRepo{db: db}
}

func (r *OCRResultRepo) EnsureTable(ctx context.Context) error {
	_, err := r.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS OCR_RESULTS (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(191) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  ocr_text LONGTEXT,
  llm_json JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_request (request_id),
  KEY idx_filename (filename)
);`)
	return err
}

func (r *OCRResultRepo) Insert(ctx context.Context, requestID, filename, ocrText string, llm any) error {
	if err := r.EnsureTable(ctx); err != nil {
		return err
	}
	var llmBytes []byte
	if llm != nil {
		llmBytes, _ = json.Marshal(llm)
	}
	_, err := r.db.ExecContext(ctx, `
INSERT INTO OCR_RESULTS (request_id, filename, ocr_text, llm_json, created_at)
VALUES (?, ?, ?, ?, NOW())`, requestID, filename, ocrText, llmBytes)
	return err
}

