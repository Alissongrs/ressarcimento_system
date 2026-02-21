package handlers

import (
	"database/sql"
	"strings"

	"gorm.io/gorm"
)

// resolveSubEtapaIDTx retorna o id da subetapa pelo nome (trim).
// Se vazio ou não encontrado, retorna NullInt64 inválido (IsValid=false).
func resolveSubEtapaIDTx(tx *sql.Tx, nome string) (sql.NullInt64, error) {
	n := strings.TrimSpace(nome)
	if n == "" {
		return sql.NullInt64{}, nil
	}
	var id sql.NullInt64
	err := tx.QueryRow(
		"SELECT id_subetapa FROM DM_SUBETAPA_PROCESSOS WHERE nome_subetapa = ? LIMIT 1",
		n,
	).Scan(&id)
	if err == sql.ErrNoRows {
		return sql.NullInt64{}, nil
	}
	return id, err
}

// resolveSubEtapaNameByIDTx retorna o nome da subetapa pelo id.
func resolveSubEtapaNameByIDTx(tx *sql.Tx, id int) (sql.NullString, error) {
	if id <= 0 {
		return sql.NullString{}, nil
	}
	var nome sql.NullString
	err := tx.QueryRow(
		"SELECT nome_subetapa FROM DM_SUBETAPA_PROCESSOS WHERE id_subetapa = ? LIMIT 1",
		id,
	).Scan(&nome)
	if err == sql.ErrNoRows {
		return sql.NullString{}, nil
	}
	return nome, err
}

func nullIntToIface(n sql.NullInt64) interface{} {
	if n.Valid {
		return n.Int64
	}
	return nil
}

// resolveSubEtapaIDGorm retorna o id da subetapa pelo nome usando GORM.
func resolveSubEtapaIDGorm(db *gorm.DB, nome string) (sql.NullInt64, error) {
	n := strings.TrimSpace(nome)
	if n == "" {
		return sql.NullInt64{}, nil
	}
	var id sql.NullInt64
	err := db.Raw("SELECT id_subetapa FROM DM_SUBETAPA_PROCESSOS WHERE nome_subetapa = ? LIMIT 1", n).Row().Scan(&id)
	if err == sql.ErrNoRows {
		return sql.NullInt64{}, nil
	}
	return id, err
}

// resolveSubEtapaNameByIDGorm retorna o nome da subetapa pelo id usando GORM.
func resolveSubEtapaNameByIDGorm(db *gorm.DB, id int) (sql.NullString, error) {
	if id <= 0 {
		return sql.NullString{}, nil
	}
	var nome sql.NullString
	err := db.Raw("SELECT nome_subetapa FROM DM_SUBETAPA_PROCESSOS WHERE id_subetapa = ? LIMIT 1", id).Row().Scan(&nome)
	if err == sql.ErrNoRows {
		return sql.NullString{}, nil
	}
	return nome, err
}
