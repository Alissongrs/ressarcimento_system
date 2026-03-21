package database

import (
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var (
	GormDB_App      *gorm.DB
	GormDB_Consulta *gorm.DB
)

// InitGorm inicializa conexões GORM para DB_APP e DB_CONSULTA.
func InitGorm() {
	buildDSN := func(base string) string {
		if base == "" {
			return ""
		}
		sep := "?"
		if strings.Contains(base, "?") {
			sep = "&"
		}
		return base + sep + "parseTime=true&charset=utf8mb4&collation=utf8mb4_unicode_ci&loc=Local"
	}

	connStrApp := buildDSN(os.Getenv("DB_APP_URL"))
	connStrConsulta := buildDSN(os.Getenv("DB_CONSULTA_URL"))

	timeZone := strings.TrimSpace(os.Getenv("DB_TIMEZONE"))
	if timeZone == "" {
		timeZone = "-03:00"
	}

	getEnvInt := func(key string, def int) int {
		raw := strings.TrimSpace(os.Getenv(key))
		if raw == "" {
			return def
		}
		if n, err := strconv.Atoi(raw); err == nil && n >= 0 {
			return n
		}
		return def
	}
	// maxOpen=0 => sem limite de conexões abertas
	maxOpen := getEnvInt("DB_MAX_OPEN_CONNS", 0)
	maxIdle := getEnvInt("DB_MAX_IDLE_CONNS", 10)
	maxLifeMin := getEnvInt("DB_CONN_MAX_LIFETIME_MIN", 15)

	if connStrApp != "" {
		db, err := gorm.Open(mysql.Open(connStrApp), &gorm.Config{
			SkipDefaultTransaction: true,
			Logger:                 logger.Default.LogMode(logger.Error),
		})
		if err != nil {
			log.Fatalf("Erro fatal ao ABRIR GORM no banco da aplicação: %v", err)
		}
		if raw, err := db.DB(); err == nil {
			_ = raw.Ping()
			raw.SetMaxOpenConns(maxOpen)
			raw.SetMaxIdleConns(maxIdle)
			raw.SetConnMaxLifetime(time.Duration(maxLifeMin) * time.Minute)
		}
		_ = db.Exec("SET time_zone = '" + timeZone + "'")
		_ = db.Exec("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci")
		_ = db.Exec("SET collation_connection = 'utf8mb4_unicode_ci'")
		GormDB_App = db
		log.Println("Conexão GORM com o Banco da Aplicação estabelecida com sucesso!")
	}

	if strings.TrimSpace(connStrConsulta) == "" {
		GormDB_Consulta = nil
		log.Println("Aviso: DB_CONSULTA_URL vazio — GORM de consulta desabilitado")
		return
	}

	dbc, err := gorm.Open(mysql.Open(connStrConsulta), &gorm.Config{
		SkipDefaultTransaction: true,
		Logger:                 logger.Default.LogMode(logger.Error),
	})
	if err != nil {
		log.Printf("Aviso: falha ao ABRIR GORM no banco de consulta: %v", err)
		GormDB_Consulta = nil
		return
	}
	if raw, err := dbc.DB(); err == nil {
		_ = raw.Ping()
		raw.SetMaxOpenConns(maxOpen)
		raw.SetMaxIdleConns(maxIdle)
		raw.SetConnMaxLifetime(time.Duration(maxLifeMin) * time.Minute)
	}
	_ = dbc.Exec("SET time_zone = '" + timeZone + "'")
	_ = dbc.Exec("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci")
	_ = dbc.Exec("SET collation_connection = 'utf8mb4_unicode_ci'")
	GormDB_Consulta = dbc
	log.Println("Conexão GORM com o Banco de Consulta estabelecida com sucesso!")
}
