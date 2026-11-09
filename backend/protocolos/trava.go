package protocolos

import (
	"fmt"
	"log"
	"sync"
	"time"
)

// Trava das rodadas (Sincronizar e ImportarSite) com prazo de validade.
//
// Antes era um sync.Mutex: se uma rodada travasse (ex.: conexão do banco morta, sem resposta), a trava
// nunca soltava e o "Atualizar agora" respondia para sempre "já existe uma atualização em andamento",
// e as rodadas agendadas eram puladas até reiniciar o backend (09/11/2026). Agora a trava vence em
// travaValidade: a próxima rodada assume e a antiga, se um dia acordar, não solta a trava da nova.
const travaValidade = 30 * time.Minute

var (
	travaMu    sync.Mutex
	travaDono  uint64 // 0 = livre
	travaSeq   uint64
	travaDesde time.Time
	travaEtapa string
)

// pegarTrava tenta pegar a trava sem esperar. Devolve o id do dono (para soltar) ou erro dizendo
// desde quando e em que etapa está a rodada em andamento.
func pegarTrava(quem string) (uint64, error) {
	travaMu.Lock()
	defer travaMu.Unlock()
	if travaDono != 0 {
		if idade := time.Since(travaDesde); idade < travaValidade {
			return 0, fmt.Errorf("já existe uma atualização em andamento (desde %s, etapa: %s)",
				travaDesde.Format("15:04"), travaEtapa)
		}
		log.Printf("[protocolos] rodada iniciada às %s travou na etapa %q (%s sem terminar); assumindo a trava",
			travaDesde.Format("02/01 15:04"), travaEtapa, time.Since(travaDesde).Round(time.Minute))
	}
	travaSeq++
	travaDono, travaDesde, travaEtapa = travaSeq, time.Now(), quem
	return travaDono, nil
}

// esperarTrava tenta pegar a trava por até `max`, de 2 em 2 segundos.
func esperarTrava(quem string, max time.Duration) (uint64, error) {
	limite := time.Now().Add(max)
	for {
		id, err := pegarTrava(quem)
		if err == nil || time.Now().After(limite) {
			return id, err
		}
		time.Sleep(2 * time.Second)
	}
}

// etapa registra em que parte a rodada está (aparece no aviso e no log se ela travar).
func etapa(id uint64, nome string) {
	travaMu.Lock()
	if travaDono == id {
		travaEtapa = nome
	}
	travaMu.Unlock()
}

// soltarTrava solta só se a trava ainda for desta rodada (uma rodada vencida não solta a da sucessora).
func soltarTrava(id uint64) {
	travaMu.Lock()
	if travaDono == id {
		travaDono, travaEtapa = 0, ""
	} else if id != 0 {
		log.Printf("[protocolos] rodada vencida terminou depois de perder a trava")
	}
	travaMu.Unlock()
}
