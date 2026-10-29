package v2

import (
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strconv"

	"github.com/gin-gonic/gin"
)

// GetAnexos — GET /api/v2/processos/:id/anexos
// FT_ANEXOS: id_anexo, id_processo, nome_arquivo, caminho_arquivo, enviado_por (enum), mime_type, tamanho_bytes, data_upload
func GetAnexos(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}

	const q = `
SELECT
    a.id_anexo,
    COALESCE(a.nome_arquivo, '')      AS nome,
    COALESCE(a.tamanho_bytes, 0)      AS tamanho,
    COALESCE(a.mime_type, '')         AS mime,
    COALESCE(a.caminho_arquivo, '')   AS url,
    COALESCE(a.enviado_por, '')       AS enviado_por,
    a.data_upload
FROM FT_ANEXOS a
WHERE a.id_processo = ?
ORDER BY a.data_upload DESC`

	rows, err := db.QueryContext(c.Request.Context(), q, id)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer rows.Close()

	items := []gin.H{}
	for rows.Next() {
		var (
			idAnexo    int
			nome, mime string
			tamanho    int64
			url        string
			enviadoPor string
			dtUpload   sql.NullTime
		)
		if err := rows.Scan(&idAnexo, &nome, &tamanho, &mime, &url, &enviadoPor, &dtUpload); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", "scan: "+err.Error(), nil)
			return
		}
		_ = url // caminho_arquivo cru não serve direto ao browser (é relativo) — usamos endpoint streamado
		item := gin.H{
			"id_anexo":      idAnexo,
			"nome_arquivo":  nome,
			"tamanho_bytes": tamanho,
			"mime_type":     mime,
			"url_download":  fmt.Sprintf("/api/v1/anexos/%d/download", idAnexo),
			"enviado_por":   enviadoPor,
		}
		if dtUpload.Valid {
			item["uploaded_at"] = dtUpload.Time.Format("2006-01-02T15:04:05Z07:00")
		}
		items = append(items, item)
	}

	c.JSON(http.StatusOK, gin.H{"items": items})
}

// AddAnexo — POST /api/v2/processos/:id/anexos  (multipart/form-data, campo "file")
// Grava o anexo como BLOB em FT_ANEXOS (id_processo, enviado_por='gestor'). Usado pelo
// MovimentarModal e pela aba de Anexos do drawer.
func AddAnexo(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}
	fh, err := c.FormFile("file")
	if err != nil {
		apiError(c, http.StatusBadRequest, "ARQUIVO_OBRIGATORIO", "envie o arquivo no campo 'file'", nil)
		return
	}
	f, err := fh.Open()
	if err != nil {
		apiError(c, http.StatusInternalServerError, "IO_ERR", err.Error(), nil)
		return
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "IO_ERR", err.Error(), nil)
		return
	}
	mime := fh.Header.Get("Content-Type")
	if mime == "" {
		mime = "application/octet-stream"
	}
	nome := filepath.Base(fh.Filename)

	res, err := db.ExecContext(c.Request.Context(),
		`INSERT INTO FT_ANEXOS
		  (id_processo, nome_arquivo, caminho_arquivo, enviado_por, data_upload, mime_type, tamanho_bytes, arquivo_blob)
		 VALUES (?, ?, '', 'gestor', NOW(), ?, ?, ?)`,
		id, nome, mime, len(data), data,
	)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	newID, _ := res.LastInsertId()

	c.JSON(http.StatusOK, gin.H{
		"id_anexo":      newID,
		"nome_arquivo":  nome,
		"mime_type":     mime,
		"tamanho_bytes": len(data),
		"url_download":  fmt.Sprintf("/api/v1/anexos/%d/download", newID),
		"enviado_por":   "gestor",
	})
}

// DeletarAnexo — DELETE /api/v2/processos/:id/anexos/:anexoId
func DeletarAnexo(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}
	anexoID, err := strconv.Atoi(c.Param("anexoId"))
	if err != nil || anexoID <= 0 {
		apiError(c, http.StatusBadRequest, "ID_INVALIDO", "anexoId inválido", nil)
		return
	}
	res, err := db.ExecContext(c.Request.Context(),
		"DELETE FROM FT_ANEXOS WHERE id_anexo = ? AND id_processo = ?", anexoID, id)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		apiError(c, http.StatusNotFound, "ANEXO_NAO_ENCONTRADO", "anexo não existe", nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
