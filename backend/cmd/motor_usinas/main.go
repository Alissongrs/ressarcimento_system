// Command motor_usinas aplica as regras do catálogo às faturas das usinas Thopen (FATURA_USINA*) — o MESMO
// cálculo da aba ⚡ Usinas da Auditoria de Faturas (handlers.CalcularUsinas). SOMENTE LEITURA.
//
//	cd backend && go run ./cmd/motor_usinas -saida ../backups/motor_usinas [-regras F01,F02,F35,F55]
//
// Sem -regras: F01–F05 (motor da Auditoria). Regras aceitas: as de situação motor/fatura/historico/aneel.
// -aneel-api: busca tarifas/bandeiras na API da ANEEL em memória (teste sem as tabelas PARAM_ANEEL_*).
package main

import (
	"encoding/json"
	"flag"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/joho/godotenv"

	"ressarcimento-backend/database"
	"ressarcimento-backend/handlers"
)

func main() {
	saida := flag.String("saida", "motor_usinas", "pasta de saída")
	regras := flag.String("regras", "F01,F02,F03,F04,F05", "regras a aplicar, separadas por vírgula")
	aneelAPI := flag.Bool("aneel-api", false, "monta a base da ANEEL direto da API (sem ler/gravar as tabelas PARAM_ANEEL_*)")
	flag.Parse()
	for _, p := range []string{".env", filepath.Join("backend", ".env")} {
		if godotenv.Load(p) == nil {
			break
		}
	}
	database.InitDBs()
	db := database.DB_App
	if db == nil {
		log.Fatal("DB_App nil — verifique DB_APP_URL no .env")
	}
	if err := os.MkdirAll(*saida, 0o755); err != nil {
		log.Fatal(err)
	}
	sel := map[string]bool{}
	for _, c := range strings.Split(*regras, ",") {
		if c = strings.ToUpper(strings.TrimSpace(c)); c != "" {
			sel[c] = true
		}
	}
	ini := time.Now()
	if *aneelAPI {
		b, err := handlers.AneelBaseDaAPI(db)
		if err != nil {
			log.Fatal(err)
		}
		handlers.SetAneelBase(b)
		log.Printf("[motor_usinas] base ANEEL da API em %.0fs", time.Since(ini).Seconds())
	}
	res, err := handlers.CalcularUsinas(db, sel)
	if err != nil {
		log.Fatal(err)
	}
	b, _ := json.MarshalIndent(res, "", " ")
	_ = os.WriteFile(filepath.Join(*saida, "resultado.json"), b, 0o644)
	log.Printf("[motor_usinas] %d faturas | apontamentos %d | erro %v | alerta %v | F02 R$ %.2f não compensado | outras regras R$ %.2f | %.0fs → %s",
		res.Faturas, len(res.Apontamentos), res.PorFicha, res.PorAlerta, res.EstLiq, res.EstOutras, time.Since(ini).Seconds(), *saida)
}
