// Command reprocessar_relatorio reinterpreta um pedido (FT_SOLICITACOES) com o código atual
// e, se for RELATÓRIO da whitelist (somente leitura), roda e grava o resultado no próprio
// pedido — no mesmo formato do executor. Útil quando um relatório novo entra e um pedido
// antigo saiu vazio. Só altera a linha do pedido (acao_json/resultado/status).
//
//	cd backend && go run ./cmd/reprocessar_relatorio -id 23 [-dry]
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"path/filepath"

	"github.com/joho/godotenv"

	"ressarcimento-backend/database"
	"ressarcimento-backend/procedit"
)

func main() {
	id := flag.Int64("id", 0, "id do pedido em FT_SOLICITACOES")
	dry := flag.Bool("dry", false, "só mostra, não grava")
	flag.Parse()
	if *id == 0 {
		log.Fatal("informe -id")
	}
	for _, p := range []string{".env", filepath.Join("backend", ".env")} {
		if godotenv.Load(p) == nil {
			break
		}
	}
	database.InitDBs()
	db := database.DB_App
	if db == nil {
		log.Fatal("DB_App nil")
	}

	var msg string
	if err := db.QueryRow("SELECT mensagem FROM FT_SOLICITACOES WHERE id=?", *id).Scan(&msg); err != nil {
		log.Fatalf("pedido %d: %v", *id, err)
	}
	acao, _, ok, motivo := procedit.Montar(db, msg)
	if !ok || acao == nil || acao.Op != "relatorio" {
		log.Fatalf("pedido %d não é relatório da whitelist (%s)", *id, motivo)
	}
	tabs, resumo, err := procedit.RunRelatorioAbas(db, acao.Relatorio, acao.Params)
	if err != nil {
		log.Fatal(err)
	}
	texto := procedit.FormatarResultado(tabs, resumo, 3000) // teto por aba; a lista da página Protocolos ANEEL passa de 1.200
	linhas := 0
	for _, t := range tabs {
		linhas += len(t.Linhas)
	}
	aj, _ := json.Marshal(acao)
	fmt.Printf("pedido #%d → %s | %d aba(s), %d linhas | %s\n", *id, acao.Relatorio, len(tabs), linhas, resumo)
	if *dry {
		return
	}
	if _, err := db.Exec(`UPDATE FT_SOLICITACOES SET acao_json=?, resultado=?, status='executado', executado_em=NOW(),
	        feedback_solicitante=NULL, feedback_em=NULL WHERE id=?`, string(aj), texto, *id); err != nil {
		log.Fatal(err)
	}
	fmt.Println("gravado.")
}
