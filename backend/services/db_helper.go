package services

import (
	"database/sql"

	"ressarcimento-backend/database"
)

func getAppDB() *sql.DB {
	if database.GormDB_App != nil {
		if db, err := database.GormDB_App.DB(); err == nil {
			return db
		}
	}
	return database.DB_App
}
