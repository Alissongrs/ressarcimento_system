package middleware

import (
	"sync"
	"testing"
	"time"
)

func TestInMemoryRateLimiter_AllowsUnderLimit(t *testing.T) {
	rl := newRateLimiter(5, time.Second)
	for i := 0; i < 5; i++ {
		allowed, _, _, _ := rl.allow("ip:1.1.1.1")
		if !allowed {
			t.Fatalf("request %d deveria ter sido permitido", i+1)
		}
	}
}

func TestInMemoryRateLimiter_BlocksAtLimit(t *testing.T) {
	rl := newRateLimiter(3, time.Second)
	for i := 0; i < 3; i++ {
		rl.allow("ip:2.2.2.2")
	}
	allowed, _, _, remaining := rl.allow("ip:2.2.2.2")
	if allowed {
		t.Fatal("4ª request deveria ter sido bloqueada")
	}
	if remaining != 0 {
		t.Fatalf("remaining esperado=0, got=%d", remaining)
	}
}

func TestInMemoryRateLimiter_ResetsAfterWindow(t *testing.T) {
	rl := newRateLimiter(2, 50*time.Millisecond)
	rl.allow("ip:3.3.3.3")
	rl.allow("ip:3.3.3.3")
	if allowed, _, _, _ := rl.allow("ip:3.3.3.3"); allowed {
		t.Fatal("deveria estar bloqueado dentro da janela")
	}
	time.Sleep(60 * time.Millisecond)
	if allowed, _, _, _ := rl.allow("ip:3.3.3.3"); !allowed {
		t.Fatal("deveria ter resetado após janela expirar")
	}
}

func TestInMemoryRateLimiter_PerKeyIsolation(t *testing.T) {
	rl := newRateLimiter(1, time.Second)
	if a, _, _, _ := rl.allow("ip:A"); !a {
		t.Fatal("primeira request de A deveria passar")
	}
	if a, _, _, _ := rl.allow("ip:B"); !a {
		t.Fatal("primeira request de B deveria passar (chave diferente)")
	}
	if a, _, _, _ := rl.allow("ip:A"); a {
		t.Fatal("segunda request de A deveria ser bloqueada")
	}
}

func TestInMemoryRateLimiter_ConcurrentAccess(t *testing.T) {
	rl := newRateLimiter(1000, time.Second)
	var wg sync.WaitGroup
	allowed := 0
	var mu sync.Mutex

	for i := 0; i < 500; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if a, _, _, _ := rl.allow("shared"); a {
				mu.Lock()
				allowed++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if allowed != 500 {
		t.Fatalf("esperava 500 requisições permitidas, got %d", allowed)
	}
}

func TestNewBackend_FallsBackToMemoryWhenNoRedis(t *testing.T) {
	old := getenv
	getenv = func(string) string { return "" }
	defer func() { getenv = old }()

	be := newBackend(10, time.Second, "test")
	if _, ok := be.(*rateLimiter); !ok {
		t.Fatalf("esperava *rateLimiter (in-memory), got %T", be)
	}
	be.close()
}

func TestNewBackend_FallsBackWhenRedisUnreachable(t *testing.T) {
	old := getenv
	getenv = func(k string) string {
		if k == "REDIS_URL" {
			return "redis://127.0.0.1:1" // porta inválida
		}
		return ""
	}
	defer func() { getenv = old }()

	be := newBackend(10, time.Second, "test")
	if _, ok := be.(*rateLimiter); !ok {
		t.Fatalf("esperava fallback para in-memory quando Redis indisponível, got %T", be)
	}
	be.close()
}
