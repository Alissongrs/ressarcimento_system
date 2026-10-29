// Roda uma rodada dos protocolos ANEEL fora do servidor (mesma lógica do agendamento de 1h).
// A primeira rodada só registra a situação de cada protocolo — não cria tarefas nem alertas.
//
//	go run ./cmd/protocolos_aneel
package main

import (
	"log"

	"ressarcimento-backend/database"
	_ "ressarcimento-backend/handlers" // liga protocolos.AtualizarCaixa (busca e-mails novos na caixa)
	"ressarcimento-backend/protocolos"

	"github.com/joho/godotenv"
)

func main() {
	for _, p := range []string{".env", "backend/.env"} {
		if godotenv.Load(p) == nil {
			break
		}
	}
	database.InitDBs()
	database.InitGorm()
	r, err := protocolos.Sincronizar()
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("ok: %+v", r)
}
