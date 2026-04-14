package main

import (
	"database/sql"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

func main() {
	var dsn string
	var out string
	flag.StringVar(&dsn, "dsn", "", "MySQL DSN")
	flag.StringVar(&out, "out", "", "Output .sql file")
	flag.Parse()

	if strings.TrimSpace(dsn) == "" {
		log.Fatal("dsn is required")
	}
	if strings.TrimSpace(out) == "" {
		log.Fatal("out is required")
	}

	db, err := sql.Open("mysql", dsn)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		log.Fatalf("ping db: %v", err)
	}

	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		log.Fatalf("mkdir output dir: %v", err)
	}

	f, err := os.Create(out)
	if err != nil {
		log.Fatalf("create output: %v", err)
	}
	defer f.Close()

	writeLine(f, "-- Backup gerado em "+time.Now().Format("2006-01-02 15:04:05"))
	writeLine(f, "SET NAMES utf8mb4;")
	writeLine(f, "SET FOREIGN_KEY_CHECKS=0;")
	writeLine(f, "")

	dbName := currentDatabase(db)
	if dbName != "" {
		writeLine(f, "-- Banco: "+dbName)
		writeLine(f, "CREATE DATABASE IF NOT EXISTS `"+dbName+"`;")
		writeLine(f, "USE `"+dbName+"`;")
		writeLine(f, "")
	}

	tables := listObjects(db, "BASE TABLE")
	for _, tbl := range tables {
		if err := dumpTable(db, f, tbl); err != nil {
			log.Fatalf("dump table %s: %v", tbl, err)
		}
	}

	views := listObjects(db, "VIEW")
	for _, vw := range views {
		if err := dumpView(db, f, vw); err != nil {
			log.Fatalf("dump view %s: %v", vw, err)
		}
	}

	writeLine(f, "SET FOREIGN_KEY_CHECKS=1;")
}

func currentDatabase(db *sql.DB) string {
	var name sql.NullString
	if err := db.QueryRow("SELECT DATABASE()").Scan(&name); err != nil || !name.Valid {
		return ""
	}
	return name.String
}

func listObjects(db *sql.DB, objectType string) []string {
	rows, err := db.Query(`
		SELECT table_name
		FROM information_schema.tables
		WHERE table_schema = DATABASE()
		  AND table_type = ?
		ORDER BY table_name
	`, objectType)
	if err != nil {
		log.Fatalf("list objects (%s): %v", objectType, err)
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			log.Fatalf("scan object name: %v", err)
		}
		out = append(out, name)
	}
	return out
}

func dumpTable(db *sql.DB, f *os.File, table string) error {
	var tbl, createSQL string
	if err := db.QueryRow("SHOW CREATE TABLE `"+table+"`").Scan(&tbl, &createSQL); err != nil {
		return err
	}

	writeLine(f, "--")
	writeLine(f, "-- Estrutura da tabela `"+table+"`")
	writeLine(f, "--")
	writeLine(f, "DROP TABLE IF EXISTS `"+table+"`;")
	writeLine(f, createSQL+";")
	writeLine(f, "")

	rows, err := db.Query("SELECT * FROM `" + table + "`")
	if err != nil {
		return err
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return err
	}

	raw := make([][]byte, len(cols))
	dest := make([]any, len(cols))
	for i := range raw {
		dest[i] = &raw[i]
	}

	for rows.Next() {
		if err := rows.Scan(dest...); err != nil {
			return err
		}
		values := make([]string, len(cols))
		for i, b := range raw {
			values[i] = sqlLiteral(b)
		}
		writeLine(f, "INSERT INTO `"+table+"` VALUES ("+strings.Join(values, ", ")+");")
	}
	writeLine(f, "")
	return rows.Err()
}

func dumpView(db *sql.DB, f *os.File, view string) error {
	var name, createSQL, charset, collation string
	if err := db.QueryRow("SHOW CREATE VIEW `"+view+"`").Scan(&name, &createSQL, &charset, &collation); err != nil {
		return err
	}

	writeLine(f, "--")
	writeLine(f, "-- View `"+view+"`")
	writeLine(f, "--")
	writeLine(f, "DROP VIEW IF EXISTS `"+view+"`;")
	writeLine(f, createSQL+";")
	writeLine(f, "")
	return nil
}

func sqlLiteral(b []byte) string {
	if b == nil {
		return "NULL"
	}
	s := string(b)
	if isNumeric(s) {
		return s
	}
	return "'" + escapeSQLString(s) + "'"
}

func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	if _, err := strconv.ParseInt(s, 10, 64); err == nil {
		return true
	}
	if _, err := strconv.ParseFloat(s, 64); err == nil {
		return true
	}
	l := strings.ToLower(s)
	return l == "true" || l == "false"
}

func escapeSQLString(s string) string {
	replacer := strings.NewReplacer(
		"\\", "\\\\",
		"'", "\\'",
		"\x00", "\\0",
		"\n", "\\n",
		"\r", "\\r",
		"\x1a", "\\Z",
	)
	return replacer.Replace(s)
}

func writeLine(f *os.File, s string) {
	if _, err := fmt.Fprintln(f, s); err != nil {
		log.Fatalf("write output: %v", err)
	}
}
