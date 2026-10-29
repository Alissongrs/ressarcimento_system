// Command auditados reconstrói a tabela FATURA_APONTAMENTOS_AUDITADOS (snapshot de
// ressarcimento que a página "Auditoria de Faturas" lê), rodando o motor F01-F05 direto
// em Go + swap atômico. Substitui o _build_tabela_auditados.py (que forjava JWT dev-secret
// — quebra com GO_ENV=production — e dava DELETE deixando a tabela vazia no meio).
//
// Uso na VPS (o crontab chama isto):
//
//	cd /caminho/do/repo/backend && ./auditados
//
// Lê a conexão do backend/.env (mesmas variáveis do servidor). Idempotente.
package main

import (
	"flag"
	"log"
	"os"
	"path/filepath"

	"github.com/joho/godotenv"

	"ressarcimento-backend/database"
	"ressarcimento-backend/handlers"
)

func main() {
	dry := flag.Bool("dry", false, "modo teste: monta staging e compara com a tabela viva, sem fazer o swap (não escreve em prod)")
	flag.Parse()

	loadEnv()

	// Inicializa as conexões exatamente como o servidor (garante que qualquer estado
	// global usado pelo motor esteja disponível).
	database.InitDBs()
	database.InitGorm()

	db := database.DB_App
	if db == nil {
		log.Fatal("DB_App nil — verifique DB_APP_URL no .env")
	}

	var st handlers.AuditadosRebuildStats
	var err error
	if *dry {
		log.Println("[auditados] DRY-RUN: montando staging + comparando (sem swap, sem escrever em prod)...")
		st, err = handlers.RebuildAuditadosDry(db)
	} else {
		log.Println("[auditados] reconstruindo FATURA_APONTAMENTOS_AUDITADOS (motor F01-F05 + swap atômico)...")
		st, err = handlers.RebuildAuditados(db)
	}
	if err != nil {
		log.Fatalf("[auditados] falha no rebuild: %v", err)
	}
	log.Printf("[auditados] OK — auditados=%d inseridos=%d ressarcimento_estimado_total=R$ %.2f (%dms)",
		st.Auditados, st.Inseridos, st.TotalEstimado, st.DuracaoMs)
}

// loadEnv tenta backend/.env / .env (cwd e ao lado do binário), como o main.go.
func loadEnv() {
	candidates := []string{".env", filepath.Join("backend", ".env")}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), ".env"), filepath.Join(filepath.Dir(exe), "backend", ".env"))
	}
	for _, p := range candidates {
		if godotenv.Load(p) == nil {
			log.Printf("[auditados] .env carregado de %s", p)
			return
		}
	}
	log.Println("[auditados] aviso: .env não carregado — usando variáveis do ambiente")
}
