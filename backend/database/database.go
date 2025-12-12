// Package database centraliza a inicialização e o acesso às conexões de banco.
package database

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"

	_ "github.com/go-sql-driver/mysql"
)

var (
	DB_App      *sql.DB
	DB_Consulta *sql.DB
)

// InitDBs configura as conexões com os bancos de dados da aplicação e de consulta.
func InitDBs() {
	// Monta DSNs garantindo UTF-8 e timezone local
	buildDSN := func(base string) string {
		if base == "" {
			return ""
		}
		sep := "?"
		if strings.Contains(base, "?") {
			sep = "&"
		}
		// Fixar timezone via sessão (abaixo) e usar loc=Local para não depender de tabelas TZ do MySQL
		// Ajustamos a collation da sessão abaixo com fallback para 0900 quando suportado
		return fmt.Sprintf("%s%sparseTime=true&charset=utf8mb4&collation=utf8mb4_unicode_ci&loc=Local", base, sep)
	}
	connStrApp := buildDSN(os.Getenv("DB_APP_URL"))
	connStrConsulta := buildDSN(os.Getenv("DB_CONSULTA_URL"))

	timeZone := strings.TrimSpace(os.Getenv("DB_TIMEZONE"))
	if timeZone == "" {
		timeZone = "-03:00" // default para evitar depender de time zone tables
	}

	var err error

	DB_App, err = sql.Open("mysql", connStrApp)
	if err != nil {
		log.Fatalf("Erro fatal ao ABRIR a conexão com o banco da aplicação: %v", err)
	}
	err = DB_App.Ping()
	if err != nil {
		log.Fatalf("Erro fatal ao CONECTAR com o banco da aplicação: %v", err)
	}
	if _, err := DB_App.Exec("SET time_zone = '" + timeZone + "'"); err != nil {
		log.Printf("Aviso: falha ao definir time_zone na sessão APP: %v (fazendo fallback para -03:00)", err)
		_, _ = DB_App.Exec("SET time_zone = '-03:00'")
	}
	// Alinha collation/names na sessão para evitar mix de collations, com fallback
	ensureSessionCollation(DB_App)
	log.Println("Conexão com o Banco da Aplicação estabelecida com sucesso!")

    if strings.TrimSpace(connStrConsulta) == "" {
        log.Println("Aviso: DB_CONSULTA_URL vazio — recursos de consulta serão desabilitados")
        DB_Consulta = nil
    } else {
        DB_Consulta, err = sql.Open("mysql", connStrConsulta)
        if err != nil {
            log.Printf("Aviso: falha ao ABRIR a conexão com o banco de consulta: %v (desabilitando consultas)", err)
            DB_Consulta = nil
        } else if err = DB_Consulta.Ping(); err != nil {
            log.Printf("Aviso: falha ao CONECTAR com o banco de consulta: %v (desabilitando consultas)", err)
            _ = DB_Consulta.Close()
            DB_Consulta = nil
        } else {
            if _, err := DB_Consulta.Exec("SET time_zone = '" + timeZone + "'"); err != nil {
                log.Printf("Aviso: falha ao definir time_zone na sessão CONSULTA: %v (fazendo fallback para -03:00)", err)
                _, _ = DB_Consulta.Exec("SET time_zone = '-03:00'")
            }
            ensureSessionCollation(DB_Consulta)
            log.Println("Conexão com o Banco de Consulta (Amee_Serving) estabelecida com sucesso!")
        }
    }
}

// ensureSessionCollation tenta aplicar a collation mais nova e recua para unicode_ci quando necessário.
func ensureSessionCollation(db *sql.DB) {
	if db == nil {
		return
	}
	if _, err := db.Exec("SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci"); err == nil {
		_, _ = db.Exec("SET collation_connection = 'utf8mb4_0900_ai_ci'")
		return
	}
	// Fallback compatível com MySQL < 8.0.13
	_, _ = db.Exec("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci")
	_, _ = db.Exec("SET collation_connection = 'utf8mb4_unicode_ci'")
}
