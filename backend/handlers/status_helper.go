package handlers

import (
	"database/sql"

	"gorm.io/gorm"
)

// getStatusNomeByRequisicao busca o nome do status (DM_STATUS) para a requisição.
// Retorna string vazia em caso de erro/ausência.
func getStatusNomeByRequisicao(tx *sql.Tx, requisicaoID int64) string {
	if tx == nil || requisicaoID == 0 {
		return ""
	}
	var statusNome sql.NullString
	err := tx.QueryRow(`
		SELECT s.status
		FROM FT_REQUISICOES r
		JOIN DM_STATUS s ON s.id_status = r.id_status
		WHERE r.id_requisicao = ?
		LIMIT 1
	`, requisicaoID).Scan(&statusNome)
	if err != nil || !statusNome.Valid {
		return ""
	}
	return statusNome.String
}

// getStatusNomeByRequisicaoGorm busca o nome do status usando GORM.
func getStatusNomeByRequisicaoGorm(tx *gorm.DB, requisicaoID int64) string {
	if tx == nil || requisicaoID == 0 {
		return ""
	}
	var statusNome sql.NullString
	err := tx.Raw(`
		SELECT s.status
		FROM FT_REQUISICOES r
		JOIN DM_STATUS s ON s.id_status = r.id_status
		WHERE r.id_requisicao = ?
		LIMIT 1
	`, requisicaoID).Row().Scan(&statusNome)
	if err != nil || !statusNome.Valid {
		return ""
	}
	return statusNome.String
}
