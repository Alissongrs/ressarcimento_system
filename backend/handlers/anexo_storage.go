package handlers

import (
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

const maxAnexoBytes int64 = (16 * 1024 * 1024) - 1024

func readAnexoFile(file *multipart.FileHeader) (string, []byte, string, int64, error) {
	if file == nil {
		return "", nil, "", 0, errors.New("arquivo vazio")
	}
	name := filepath.Base(file.Filename)
	if name == "" {
		name = "anexo"
	}
	if file.Size > 0 && file.Size > maxAnexoBytes {
		return "", nil, "", 0, fmt.Errorf("arquivo excede o limite de %d bytes", maxAnexoBytes)
	}
	f, err := file.Open()
	if err != nil {
		return "", nil, "", 0, err
	}
	defer f.Close()

	data, err := io.ReadAll(io.LimitReader(f, maxAnexoBytes+1))
	if err != nil {
		return "", nil, "", 0, err
	}
	if int64(len(data)) > maxAnexoBytes {
		return "", nil, "", 0, fmt.Errorf("arquivo excede o limite de %d bytes", maxAnexoBytes)
	}
	mimeType := strings.TrimSpace(file.Header.Get("Content-Type"))
	if mimeType == "" {
		mimeType = http.DetectContentType(data)
	}
	return name, data, mimeType, int64(len(data)), nil
}

func buildAnexoPath(processoID int, histID int, filename string) string {
	safe := filepath.Base(filename)
	ts := time.Now().Unix()
	if histID > 0 {
		return fmt.Sprintf("hist-%d/%d-%d-%s", histID, processoID, ts, safe)
	}
	return fmt.Sprintf("proc-%d/%d-%d-%s", processoID, processoID, ts, safe)
}

func anexoDownloadURL(id int64) string {
	if id <= 0 {
		return ""
	}
	return fmt.Sprintf("/api/v1/anexos/%d/download", id)
}
