package sse

import (
	"encoding/json"
	"sync"
	"time"
)

type Event struct {
	Type       string      `json:"type"`
	ProcessoID int         `json:"processo_id"`
	Payload    interface{} `json:"payload,omitempty"`
	Ts         time.Time   `json:"ts"`
}

type subscriber chan []byte

var (
	mu   sync.RWMutex
	subs = map[int]map[subscriber]struct{}{}
)

func Subscribe(processoID int) subscriber {
	ch := make(chan []byte, 8)
	mu.Lock()
	defer mu.Unlock()
	if subs[processoID] == nil {
		subs[processoID] = make(map[subscriber]struct{})
	}
	subs[processoID][ch] = struct{}{}
	return ch
}

func Unsubscribe(processoID int, ch subscriber) {
	mu.Lock()
	defer mu.Unlock()
	if m := subs[processoID]; m != nil {
		delete(m, ch)
		close(ch)
		if len(m) == 0 {
			delete(subs, processoID)
		}
	}
}

func Broadcast(processoID int, ev Event) {
	ev.Ts = time.Now()
	b, _ := json.Marshal(ev)
	mu.RLock()
	defer mu.RUnlock()
	for ch := range subs[processoID] {
		select {
		case ch <- b:
		default:
			// slow consumer, drop
		}
	}
}
