// Command relatorio_auditoria imprime (JSON) o relatório gerencial de auditoria de
// faturas (fichas F01-F05) para faturas ingressadas num período. READ-ONLY: roda o
// motor ao vivo sobre a FDE e NÃO escreve nada em produção.
//
// Uso:
//
//	cd backend && go run ./cmd/relatorio_auditoria -ini 2026-07-01 -fim 2026-10-01
//
// Lê a conexão do backend/.env (mesmas variáveis do servidor).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/joho/godotenv"

	"ressarcimento-backend/database"
	"ressarcimento-backend/handlers"
)

func main() {
	ini := flag.String("ini", "", "data inicial ISO (YYYY-MM-DD), inclusive")
	fim := flag.String("fim", "", "data final ISO (YYYY-MM-DD), exclusive")
	flag.Parse()
	if *ini == "" || *fim == "" {
		log.Fatal("informe -ini e -fim (YYYY-MM-DD)")
	}

	loadEnv()
	database.InitDBs()
	database.InitGorm()

	db := database.DB_App
	if db == nil {
		log.Fatal("DB_App nil — verifique DB_APP_URL no .env")
	}

	rep, err := handlers.RelatorioAuditoria(db, *ini, *fim)
	if err != nil {
		log.Fatalf("falha: %v", err)
	}
	b, _ := json.MarshalIndent(rep, "", "  ")
	fmt.Println(string(b))
}

func loadEnv() {
	candidates := []string{".env", filepath.Join("backend", ".env")}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), ".env"), filepath.Join(filepath.Dir(exe), "backend", ".env"))
	}
	for _, p := range candidates {
		if godotenv.Load(p) == nil {
			return
		}
	}
	log.Println("[relatorio] aviso: .env não carregado — usando variáveis do ambiente")
}
