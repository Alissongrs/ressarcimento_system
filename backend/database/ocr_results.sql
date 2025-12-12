-- Tabela para guardar OCR + resumo do LLM por arquivo/processo
-- Compatível com MySQL 5.7+/8.0
CREATE TABLE IF NOT EXISTS OCR_RESULTS (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(64) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  ocr_text LONGTEXT,
  llm_json LONGTEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_filename (filename),
  INDEX idx_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Exemplo de inserção:
-- INSERT INTO OCR_RESULTS (request_id, filename, ocr_text, llm_json)
-- VALUES ('req-uuid', 'fatura_123.pdf', 'texto extraído...', '{"valor_total":123.45}');
