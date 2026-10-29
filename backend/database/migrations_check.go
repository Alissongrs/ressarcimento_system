package database

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"
)

// CheckSchemaVersion inspects the schema_migrations table (golang-migrate format)
// and logs the current version + dirty flag. It NEVER runs DDL.
//
// Returns a non-nil error ONLY when the schema is marked dirty — that means the
// last golang-migrate run failed mid-way and the DB is in an inconsistent state,
// so the process should NOT start until an operator inspects it.
//
// If schema_migrations doesn't exist yet, this is treated as "version 0, clean"
// (the DB was bootstrapped by another path — e.g. the legacy blob or a manual
// SQL dump). No DDL is created here on purpose; the schema_migrations table is
// created by golang-migrate on its first `up` run.
func CheckSchemaVersion(db *sql.DB) error {
	if db == nil {
		return fmt.Errorf("db nulo em CheckSchemaVersion")
	}

	// 1) A tabela existe?
	var exists int
	if err := db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME = 'schema_migrations'
	`).Scan(&exists); err != nil {
		return fmt.Errorf("verificando schema_migrations: %w", err)
	}
	if exists == 0 {
		log.Println("[migrate] schema_migrations não existe ainda — schema ainda não versionado por golang-migrate.")
		log.Println("[migrate] Rode a primeira baseline com `migrate up` (ou use SURE_LEGACY_AUTO_MIGRATE=true APENAS em dev).")
		return nil
	}

	// 2) Lê versão + dirty
	var version sql.NullInt64
	var dirty sql.NullBool
	err := db.QueryRow(`SELECT version, dirty FROM schema_migrations LIMIT 1`).Scan(&version, &dirty)
	if err != nil && err != sql.ErrNoRows {
		return fmt.Errorf("lendo schema_migrations: %w", err)
	}

	if err == sql.ErrNoRows {
		log.Println("[migrate] schema_migrations vazio — nada aplicado ainda.")
		return nil
	}

	if dirty.Valid && dirty.Bool {
		return fmt.Errorf(
			"schema_migrations.dirty = 1 (última migração falhou na versão %d). "+
				"Corrija manualmente e execute `migrate force <versao>` antes de subir o backend",
			version.Int64,
		)
	}

	log.Printf("[migrate] schema OK — versão atual: %d", version.Int64)
	return nil
}

// LegacyAutoMigrateEnabled retorna true se o env SURE_LEGACY_AUTO_MIGRATE=true.
// Só use em dev/local — em produção o migrate é passo explícito via golang-migrate.
func LegacyAutoMigrateEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("SURE_LEGACY_AUTO_MIGRATE")))
	return v == "true" || v == "1" || v == "yes"
}

// acquireMigrateLock tenta pegar um advisory lock MySQL antes de rodar DDL.
// Retorna uma função de release para chamar em defer. Se não conseguir, retorna erro.
//
// Padrão compatível com o que golang-migrate usa internamente (GET_LOCK) —
// evita duas instâncias rodando DDL ao mesmo tempo.
func acquireMigrateLock(db *sql.DB, timeoutSeconds int) (func(), error) {
	const lockName = "sure_migrate"
	var got sql.NullInt64
	if err := db.QueryRow(`SELECT GET_LOCK(?, ?)`, lockName, timeoutSeconds).Scan(&got); err != nil {
		return nil, fmt.Errorf("GET_LOCK falhou: %w", err)
	}
	if !got.Valid || got.Int64 != 1 {
		return nil, fmt.Errorf("GET_LOCK '%s' retornou %v — outra instância pode estar migrando", lockName, got)
	}
	release := func() {
		if _, err := db.Exec(`SELECT RELEASE_LOCK(?)`, lockName); err != nil {
			log.Printf("[migrate] aviso: RELEASE_LOCK falhou: %v", err)
		}
	}
	return release, nil
}
