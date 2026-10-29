package database

import (
	"log"
	"net/url"
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
	GormDB_Faturas  *gorm.DB
	GormDB_Vtal     *gorm.DB // banco VTAL (quivere_vtal, cod_empresa 2025)
)

// InitGorm inicializa conexões GORM para DB_APP, DB_CONSULTA e DB_FATURAS.
func InitGorm() {
	// timeZone vai NA DSN (não só num Exec avulso): assim TODA conexão do pool nasce
	// em -03:00. Senão, só uma conexão recebe o SET e as demais (idle + novas sob
	// carga) usam o default do RDS (UTC) → carimbos 3h adiantados.
	timeZone := strings.TrimSpace(os.Getenv("DB_TIMEZONE"))
	if timeZone == "" {
		timeZone = "-03:00"
	}
	tzParam := "&time_zone=" + url.QueryEscape("'"+timeZone+"'")

	buildDSN := func(base, tlsMode string) string {
		if base == "" {
			return ""
		}
		sep := "?"
		if strings.Contains(base, "?") {
			sep = "&"
		}
		dsn := base + sep + "parseTime=true&charset=utf8mb4&collation=utf8mb4_unicode_ci&loc=Local" + tzParam
		if tlsMode != "" && tlsMode != "false" {
			dsn += "&tls=" + tlsMode
		}
		return dsn
	}

	appTLS := strings.TrimSpace(os.Getenv("DB_APP_TLS"))
	consultaTLS := strings.TrimSpace(os.Getenv("DB_CONSULTA_TLS"))
	faturasTLS := strings.TrimSpace(os.Getenv("DB_FATURAS_TLS"))

	connStrApp := buildDSN(os.Getenv("DB_APP_URL"), appTLS)
	connStrConsulta := buildDSN(os.Getenv("DB_CONSULTA_URL"), consultaTLS)

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

	// DB_VTAL (banco do cliente VTAL — cod_empresa 2025). Não usa early-return
	// pra não impedir a init do DB_FATURAS abaixo.
	if connStrVtal := buildDSN(os.Getenv("DB_VTAL"), faturasTLS); strings.TrimSpace(connStrVtal) != "" {
		if dbv, err := gorm.Open(mysql.Open(connStrVtal), &gorm.Config{
			SkipDefaultTransaction: true,
			Logger:                 logger.Default.LogMode(logger.Error),
		}); err != nil {
			log.Printf("Aviso: falha ao ABRIR GORM no banco VTAL: %v", err)
			GormDB_Vtal = nil
		} else {
			if raw, err := dbv.DB(); err == nil {
				_ = raw.Ping()
				raw.SetMaxOpenConns(maxOpen)
				raw.SetMaxIdleConns(maxIdle)
				raw.SetConnMaxLifetime(time.Duration(maxLifeMin) * time.Minute)
			}
			_ = dbv.Exec("SET time_zone = '" + timeZone + "'")
			_ = dbv.Exec("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci")
			GormDB_Vtal = dbv
			log.Println("Conexão GORM com o Banco VTAL estabelecida com sucesso!")
		}
	} else {
		GormDB_Vtal = nil
		log.Println("Aviso: DB_VTAL vazio — banco VTAL desabilitado")
	}

	// DB_FATURAS
	connStrFaturas := buildDSN(os.Getenv("DB_FATURAS"), faturasTLS)
	if strings.TrimSpace(connStrFaturas) == "" {
		GormDB_Faturas = nil
		log.Println("Aviso: DB_FATURAS vazio — banco de faturas desabilitado")
		return
	}
	dbf, err := gorm.Open(mysql.Open(connStrFaturas), &gorm.Config{
		SkipDefaultTransaction: true,
		Logger:                 logger.Default.LogMode(logger.Error),
	})
	if err != nil {
		log.Printf("Aviso: falha ao ABRIR GORM no banco de faturas: %v", err)
		GormDB_Faturas = nil
		return
	}
	if raw, err := dbf.DB(); err == nil {
		_ = raw.Ping()
		raw.SetMaxOpenConns(maxOpen)
		raw.SetMaxIdleConns(maxIdle)
		raw.SetConnMaxLifetime(time.Duration(maxLifeMin) * time.Minute)
	}
	_ = dbf.Exec("SET time_zone = '" + timeZone + "'")
	_ = dbf.Exec("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci")
	GormDB_Faturas = dbf
	log.Println("Conexão GORM com o Banco de Faturas estabelecida com sucesso!")
}
