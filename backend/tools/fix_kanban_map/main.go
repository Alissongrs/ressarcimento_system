package main

import (
	"database/sql"
	"fmt"
	"log"

	"github.com/joho/godotenv"
	"ressarcimento-backend/database"
)

type row struct {
	etapa   string
	colID   sql.NullInt64
	colNome sql.NullString
}

func main() {
	_ = godotenv.Load()
	database.InitDBs()
	db := database.DB_App
	if db == nil {
		log.Fatal("DB_App nil")
	}

	// Mostra situação atual
	fmt.Println("-- Antes --")
	dump(db)

	// Garante que exista etapa 'Deferidos' e aponte para a coluna 'Deferidos'
	var col2ID int64
	if err := db.QueryRow("SELECT id_coluna FROM DM_KANBAN_COLUNAS WHERE nome_coluna = 'Deferidos'").Scan(&col2ID); err != nil {
		log.Fatalf("Coluna 'Deferidos' não encontrada em DM_KANBAN_COLUNAS: %v", err)
	}
	var existeDeferidos int
	if err := db.QueryRow("SELECT COUNT(1) FROM DM_ETAPAS_PROCESSO WHERE etapa IN ('Deferidos','Deferido')").Scan(&existeDeferidos); err != nil {
		log.Fatalf("Erro ao verificar etapa Deferidos: %v", err)
	}
	if existeDeferidos == 0 {
		if _, err := db.Exec("INSERT INTO DM_ETAPAS_PROCESSO (etapa, id_coluna_kanban) VALUES ('Deferidos', ?)", col2ID); err != nil {
			log.Fatalf("Falha ao criar etapa 'Deferidos': %v", err)
		}
	} else {
		if _, err := db.Exec("UPDATE DM_ETAPAS_PROCESSO SET id_coluna_kanban = ? WHERE etapa IN ('Deferidos','Deferido')", col2ID); err != nil {
			log.Fatalf("Falha ao ajustar etapa 'Deferidos': %v", err)
		}
	}

	// Corrige Validação/Fluxo -> Fluxo de Ressarcimento
	if _, err := db.Exec(`
        UPDATE DM_ETAPAS_PROCESSO e
        JOIN DM_KANBAN_COLUNAS kc ON kc.nome_coluna = 'Fluxo de Ressarcimento'
        SET e.id_coluna_kanban = kc.id_coluna
        WHERE e.etapa IN ('Validação','Validacao','Fluxo de Ressarcimento');
    `); err != nil {
		log.Fatalf("Falha ao ajustar Fluxo: %v", err)
	}

	fmt.Println("-- Depois --")
	dump(db)
}

func dump(db *sql.DB) {
	rows, err := db.Query(`
        SELECT e.etapa, e.id_coluna_kanban, kc.nome_coluna
        FROM DM_ETAPAS_PROCESSO e
        LEFT JOIN DM_KANBAN_COLUNAS kc ON kc.id_coluna = e.id_coluna_kanban
        WHERE e.etapa IN ('Deferidos','Deferido','Validação','Validacao','Fluxo de Ressarcimento')
        ORDER BY e.etapa;
    `)
	if err != nil {
		log.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.etapa, &r.colID, &r.colNome); err == nil {
			fmt.Printf("%s -> col_id=%v col_nome=%v\n", r.etapa, nullI64(r.colID), nullStr(r.colNome))
		}
	}
}

func nullI64(v sql.NullInt64) interface{} {
	if v.Valid {
		return v.Int64
	}
	return nil
}
func nullStr(v sql.NullString) interface{} {
	if v.Valid {
		return v.String
	}
	return nil
}
