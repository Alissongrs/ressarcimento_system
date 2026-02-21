package repositories

import (
	"context"
	"database/sql"
	"encoding/json"

	"gorm.io/gorm"
)

type OCRResultRepo struct {
	db *gorm.DB
}

func NewOCRResultRepo(db *gorm.DB) *OCRResultRepo {
	return &OCRResultRepo{db: db}
}

func (r *OCRResultRepo) EnsureTable(ctx context.Context) error {
	res := r.db.Exec(`
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
	return res.Error
}

func (r *OCRResultRepo) Insert(ctx context.Context, requestID, filename, ocrText string, llm any) error {
	if err := r.EnsureTable(ctx); err != nil {
		return err
	}
	var llmBytes []byte
	if llm != nil {
		llmBytes, _ = json.Marshal(llm)
	}
	res := r.db.Exec(`
INSERT INTO OCR_RESULTS (request_id, filename, ocr_text, llm_json, created_at)
VALUES (?, ?, ?, ?, NOW())`, requestID, filename, ocrText, llmBytes)
	return res.Error
}

// GetByRequestAndFilename busca um registro de OCR pelo request_id e filename
func (r *OCRResultRepo) GetByRequestAndFilename(ctx context.Context, requestID, filename string) (ocrText string, llmJSON []byte, err error) {
	row := r.db.Raw(`
SELECT ocr_text, llm_json
FROM OCR_RESULTS
WHERE request_id = ? AND filename = ?
ORDER BY created_at DESC
LIMIT 1`, requestID, filename)

	var llmData sql.NullString
	err = row.Row().Scan(&ocrText, &llmData)
	if err != nil {
		return "", nil, err
	}

	if llmData.Valid {
		llmJSON = []byte(llmData.String)
	}
	return ocrText, llmJSON, nil
}

// UpdateLLMResult atualiza o llm_json de um registro específico
func (r *OCRResultRepo) UpdateLLMResult(ctx context.Context, requestID, filename string, llm any) error {
	var llmBytes []byte
	if llm != nil {
		llmBytes, _ = json.Marshal(llm)
	}
	res := r.db.Exec(`
UPDATE OCR_RESULTS
SET llm_json = ?
WHERE request_id = ? AND filename = ?
ORDER BY created_at DESC
LIMIT 1`, llmBytes, requestID, filename)
	return res.Error
}



