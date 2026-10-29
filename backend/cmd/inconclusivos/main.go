// Command inconclusivos imprime (stdout, 1 id por linha) os ids da FDE que estão na aba
// "Inconclusivos" da Auditoria de Faturas: motor F01-F05 apontou, mas ainda não auditadas
// e não rejeitadas/em-processo. Uso:
//
//	cd backend && go build -o inconclusivos ./cmd/inconclusivos && ./inconclusivos > inconc.txt
//	# depois: pdf_pipeline.py --revalidar --id-file inconc.txt --auto-audit --prod
//
// Logs vão pro STDERR; só os ids vão pro STDOUT (pode redirecionar direto).
package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/joho/godotenv"

	"ressarcimento-backend/database"
	"ressarcimento-backend/handlers"
)

func main() {
	loadEnv()
	database.InitDBs()
	database.InitGorm()
	db := database.DB_App
	if db == nil {
		log.Fatal("[inconclusivos] DB_App nil — verifique DB_APP_URL no .env")
	}
	log.Println("[inconclusivos] rodando motor F01-F05 + filtro (não-auditada, não-rejeitada)...")
	ids, err := handlers.ListInconclusivos(db)
	if err != nil {
		log.Fatalf("[inconclusivos] falha: %v", err)
	}
	log.Printf("[inconclusivos] %d faturas na fila (aba Inconclusivos)", len(ids))
	for _, id := range ids {
		fmt.Println(id) // stdout — redirecione p/ arquivo
	}
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
}
