// Package database centraliza a inicialização e o acesso às conexões de banco.
package database

import (
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-sql-driver/mysql"
)

var (
	DB_App      *sql.DB
	DB_Consulta *sql.DB
)

func init() {
	registerTLSConfigs()
}

// registerTLSConfigs registra as configs TLS disponíveis para o driver MySQL.
// Aceita DB_APP_TLS / DB_CONSULTA_TLS = "false"|""|"skip-verify"|"rds"|"true".
func registerTLSConfigs() {
	// skip-verify: criptografa sem validar certificado do servidor
	_ = mysql.RegisterTLSConfig("skip-verify", &tls.Config{
		InsecureSkipVerify: true, //nolint:gosec // intencional: criptografa sem pinning
	})

	// rds: usa bundle de CA do AWS RDS (certs/global-bundle.pem ao lado do binário)
	if pem := findRDSBundle(); pem != "" {
		pool := x509.NewCertPool()
		data, err := os.ReadFile(pem)
		if err == nil && pool.AppendCertsFromPEM(data) {
			_ = mysql.RegisterTLSConfig("rds", &tls.Config{
				RootCAs:    pool,
				MinVersion: tls.VersionTLS12,
			})
			log.Printf("TLS RDS: bundle carregado de %s", pem)
		} else {
			log.Printf("TLS RDS: falha ao carregar %s — usando skip-verify como fallback", pem)
			_ = mysql.RegisterTLSConfig("rds", &tls.Config{
				InsecureSkipVerify: true, //nolint:gosec
			})
		}
	}
}

// findRDSBundle procura global-bundle.pem em locais convencionais.
// Ordem: DB_RDS_CERT_PATH env → junto ao binário → CWD → /etc/ssl/certs.
func findRDSBundle() string {
	if env := strings.TrimSpace(os.Getenv("DB_RDS_CERT_PATH")); env != "" {
		return env
	}
	candidates := []string{"certs/global-bundle.pem"}
	if exe, err := os.Executable(); err == nil {
		candidates = append([]string{filepath.Join(filepath.Dir(exe), "certs", "global-bundle.pem")}, candidates...)
	}
	candidates = append(candidates, "/etc/ssl/certs/aws-rds-global-bundle.pem")
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// InitDBs configura as conexões com os bancos de dados da aplicação e de consulta.
func InitDBs() {
	appTLS := strings.TrimSpace(os.Getenv("DB_APP_TLS"))
	consultaTLS := strings.TrimSpace(os.Getenv("DB_CONSULTA_TLS"))

	// Monta DSNs garantindo UTF-8 e timezone local
	buildDSN := func(base, tlsMode string) string {
		if base == "" {
			return ""
		}
		sep := "?"
		if strings.Contains(base, "?") {
			sep = "&"
		}
		dsn := fmt.Sprintf("%s%sparseTime=true&charset=utf8mb4&collation=utf8mb4_unicode_ci&loc=Local", base, sep)
		if tlsMode != "" && tlsMode != "false" {
			dsn += "&tls=" + tlsMode
		}
		return dsn
	}
	connStrApp := buildDSN(os.Getenv("DB_APP_URL"), appTLS)
	connStrConsulta := buildDSN(os.Getenv("DB_CONSULTA_URL"), consultaTLS)

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
