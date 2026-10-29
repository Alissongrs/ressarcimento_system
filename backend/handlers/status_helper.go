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
		SELECT s.nome
		FROM FT_PROCESSOS p
		JOIN DM_STATUS_PROCESSO s ON s.id_status = p.id_status_atual
		WHERE p.id_processo = ?
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
		SELECT s.nome
		FROM FT_PROCESSOS p
		JOIN DM_STATUS_PROCESSO s ON s.id_status = p.id_status_atual
		WHERE p.id_processo = ?
		LIMIT 1
	`, requisicaoID).Row().Scan(&statusNome)
	if err != nil || !statusNome.Valid {
		return ""
	}
	return statusNome.String
}
