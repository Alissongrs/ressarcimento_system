package sse

import (
	"encoding/json"
	"sync"
)

// Reaproveita seu tipo Event já usado em processo_update
// type Event struct { Type string; ProcessoID int; Payload any }

var (
	userSubsMu sync.RWMutex
	userSubs   = map[int64]map[chan []byte]struct{}{}
)

// SubscribeUser registra um subscriber por usuário e devolve (canal, cancel)
func SubscribeUser(userID int64) (chan []byte, func()) {
	ch := make(chan []byte, 16)

	userSubsMu.Lock()
	m, ok := userSubs[userID]
	if !ok {
		m = map[chan []byte]struct{}{}
		userSubs[userID] = m
	}
	m[ch] = struct{}{}
	userSubsMu.Unlock()

	cancel := func() {
		userSubsMu.Lock()
		if mm, ok := userSubs[userID]; ok {
			if _, ok2 := mm[ch]; ok2 {
				delete(mm, ch)
				close(ch)
			}
			if len(mm) == 0 {
				delete(userSubs, userID)
			}
		}
		userSubsMu.Unlock()
	}
	return ch, cancel
}

// BroadcastUser envia um Event JSON para todos os subscribers daquele usuário
func BroadcastUser(userID int64, ev Event) {
	b, _ := json.Marshal(ev)

	userSubsMu.RLock()
	defer userSubsMu.RUnlock()
	if mm, ok := userSubs[userID]; ok {
		for ch := range mm {
			select { // não bloquear
			case ch <- b:
			default:
				// leitor lento: descarta silenciosamente
			}
		}
	}
}
