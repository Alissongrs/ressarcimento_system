package database

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
)

func LogSnapshotSyncStatus(db *sql.DB) {
	if db == nil {
		return
	}
	var hasSnapshot int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME = 'FT_PROCESSO_SNAPSHOT'`,
	).Scan(&hasSnapshot)

	var hasSyncSP int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.ROUTINES
		WHERE ROUTINE_SCHEMA = DATABASE()
		  AND ROUTINE_NAME = 'sp_sync_from_original_tables'
		  AND ROUTINE_TYPE = 'PROCEDURE'`,
	).Scan(&hasSyncSP)

	var hasBefore int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TRIGGERS
		WHERE TRIGGER_SCHEMA = DATABASE()
		  AND TRIGGER_NAME = 'trg_ft_processos_before_insert_defaults'`,
	).Scan(&hasBefore)

	var hasAfter int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TRIGGERS
		WHERE TRIGGER_SCHEMA = DATABASE()
		  AND TRIGGER_NAME = 'trg_ft_processos_after_insert_snapshot'`,
	).Scan(&hasAfter)

	log.Printf("[snapshot] status: snapshot_table=%t sync_sp=%t trigger_before=%t trigger_after=%t",
		hasSnapshot > 0, hasSyncSP > 0, hasBefore > 0, hasAfter > 0)
}

func BackfillSnapshotIfEnabled(db *sql.DB) {
	if db == nil {
		return
	}
	if !envFlag("SNAPSHOT_BACKFILL_ON_START") {
		return
	}

	limit := envInt("SNAPSHOT_BACKFILL_LIMIT", 2000)
	userID := envInt("SNAPSHOT_BACKFILL_USER_ID", 0)

	go func() {
		var hasSnapshot int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME = 'FT_PROCESSO_SNAPSHOT'`,
		).Scan(&hasSnapshot)
		if hasSnapshot == 0 {
			log.Println("[snapshot] backfill skipped: FT_PROCESSO_SNAPSHOT not found")
			return
		}

		var hasSyncSP int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.ROUTINES
			WHERE ROUTINE_SCHEMA = DATABASE()
			  AND ROUTINE_NAME = 'sp_sync_from_original_tables'
			  AND ROUTINE_TYPE = 'PROCEDURE'`,
		).Scan(&hasSyncSP)

		hasCreatedAt := columnExists(db, "FT_PROCESSO_SNAPSHOT", "created_at")
		hasUpdatedAt := columnExists(db, "FT_PROCESSO_SNAPSHOT", "updated_at")

		cols := []string{"id_processo"}
		vals := []string{"?"}
		if hasCreatedAt {
			cols = append(cols, "created_at")
			vals = append(vals, "NOW()")
		}
		if hasUpdatedAt {
			cols = append(cols, "updated_at")
			vals = append(vals, "NOW()")
		}
		insertSQL := fmt.Sprintf(
			"INSERT IGNORE INTO FT_PROCESSO_SNAPSHOT (%s) VALUES (%s)",
			strings.Join(cols, ", "),
			strings.Join(vals, ", "),
		)

		missingSQL := `
			SELECT p.id_processo
			FROM FT_PROCESSOS p
			LEFT JOIN FT_PROCESSO_SNAPSHOT s ON s.id_processo = p.id_processo
			WHERE s.id_processo IS NULL`
		if limit > 0 {
			missingSQL = fmt.Sprintf("%s LIMIT %d", missingSQL, limit)
		}

		rows, err := db.Query(missingSQL)
		if err != nil {
			log.Printf("[snapshot] backfill query failed: %v", err)
			return
		}
		defer rows.Close()

		ids := make([]int, 0, 128)
		for rows.Next() {
			var id int
			if err := rows.Scan(&id); err == nil && id > 0 {
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			log.Println("[snapshot] backfill: no missing snapshot rows")
			return
		}

		log.Printf("[snapshot] backfill: inserting %d missing snapshot rows", len(ids))
		for _, id := range ids {
			if _, err := db.Exec(insertSQL, id); err != nil {
				log.Printf("[snapshot] backfill insert failed for %d: %v", id, err)
				continue
			}
			if hasSyncSP > 0 {
				if _, err := db.Exec(`CALL sp_sync_from_original_tables(?, ?)`, id, userID); err != nil {
					log.Printf("[snapshot] backfill sync failed for %d: %v", id, err)
				}
			}
		}
		log.Printf("[snapshot] backfill: completed (%d rows)", len(ids))
	}()
}

func columnExists(db *sql.DB, table, column string) bool {
	if db == nil {
		return false
	}
	var count int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME = ?
		  AND COLUMN_NAME = ?`,
		table, column,
	).Scan(&count)
	return count > 0
}

func envFlag(key string) bool {
	val := strings.TrimSpace(os.Getenv(key))
	if val == "" {
		return false
	}
	val = strings.ToLower(val)
	return val == "1" || val == "true" || val == "yes" || val == "on"
}

func envInt(key string, fallback int) int {
	val := strings.TrimSpace(os.Getenv(key))
	if val == "" {
		return fallback
	}
	n, err := strconv.Atoi(val)
	if err != nil {
		return fallback
	}
	return n
}
