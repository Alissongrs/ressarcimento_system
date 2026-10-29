package handlers

import (
	"log"

	"ressarcimento-backend/database"
)

func ensureSnapshotRow(idProcesso int) {
	if idProcesso <= 0 {
		return
	}
	if _, err := execGorm(database.GormDB_App, 
		`INSERT IGNORE INTO FT_PROCESSO_SNAPSHOT (id_processo, created_at, updated_at) VALUES (?, NOW(), NOW())`,
		idProcesso,
	); err == nil {
		return
	} else {
		log.Printf("[snapshot] insert with timestamps failed for processo %d: %v", idProcesso, err)
	}

	if _, err := execGorm(database.GormDB_App, 
		`INSERT IGNORE INTO FT_PROCESSO_SNAPSHOT (id_processo) VALUES (?)`,
		idProcesso,
	); err != nil {
		log.Printf("[snapshot] insert minimal failed for processo %d: %v", idProcesso, err)
	}
}

func syncSnapshotFromOriginal(idProcesso int, userID int) {
	// V2: o mecanismo de espelho FT_PROCESSO_SNAPSHOT + sp_sync_from_original_tables foi
	// removido na migração. O estado do processo vive direto em FT_PROCESSOS, então não há
	// mais snapshot a sincronizar. No-op (evita Error 1146/1305 a cada save de classificação).
	_ = idProcesso
	_ = userID
}

