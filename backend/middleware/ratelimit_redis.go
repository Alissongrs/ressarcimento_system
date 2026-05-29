package middleware

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// incrScript executa INCR + PEXPIRE atomicamente e retorna {count, pttl_ms}.
var incrScript = redis.NewScript(`
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local pttl = redis.call("PTTL", KEYS[1])
return {count, pttl}
`)

// redisLimiter implementa rlBackend usando janela fixa em Redis.
// Fail-open: em caso de erro do Redis, libera a request e loga warning.
type redisLimiter struct {
	client *redis.Client
	limit  int
	window time.Duration
	prefix string
}

func newRedisLimiter(rawURL string, limit int, window time.Duration, prefix string) (*redisLimiter, error) {
	opts, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, fmt.Errorf("REDIS_URL inválida: %w", err)
	}

	client := redis.NewClient(opts)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("redis ping falhou: %w", err)
	}

	slog.Info("Rate limiter Redis conectado", "prefix", prefix, "limit", limit, "window", window)
	return &redisLimiter{
		client: client,
		limit:  limit,
		window: window,
		prefix: prefix,
	}, nil
}

func (r *redisLimiter) allow(key string) (bool, time.Duration, int, int) {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	fullKey := r.prefix + ":" + key
	windowMs := r.window.Milliseconds()

	raw, err := incrScript.Run(ctx, r.client, []string{fullKey}, windowMs).Slice()
	if err != nil {
		slog.Warn("Redis rate limiter erro (fail-open)", "key", fullKey, "err", err)
		return true, r.window, r.limit, r.limit - 1
	}
	if len(raw) < 2 {
		return true, r.window, r.limit, r.limit - 1
	}

	count, _ := raw[0].(int64)
	pttlMs, _ := raw[1].(int64)

	resetIn := r.window
	if pttlMs > 0 {
		resetIn = time.Duration(pttlMs) * time.Millisecond
	}

	allowed := int(count) <= r.limit
	remaining := r.limit - int(count)
	if remaining < 0 {
		remaining = 0
	}

	return allowed, resetIn, r.limit, remaining
}

func (r *redisLimiter) close() {
	if r.client != nil {
		_ = r.client.Close()
	}
}
