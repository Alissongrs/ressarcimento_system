package middleware

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
)

// ─── Request-ID (P2-7) ───────────────────────────────────────────────────────

const RequestIDHeader = "X-Request-ID"

func newRequestID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "req-unknown"
	}
	return hex.EncodeToString(b[:])
}

// RequestID garante um X-Request-ID por requisição: propaga o do cliente se vier,
// senão gera um; disponibiliza em c.Get("request_id") e no header de resposta.
// Facilita rastrear uma requisição de ponta a ponta nos logs.
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		rid := strings.TrimSpace(c.GetHeader(RequestIDHeader))
		if rid == "" {
			rid = newRequestID()
		}
		c.Set("request_id", rid)
		c.Header(RequestIDHeader, rid)
		c.Next()
	}
}

// ─── Métricas leves, sem dependência externa (P2-7) ──────────────────────────

var (
	mReqTotal      atomic.Int64
	mReq2xx        atomic.Int64
	mReq4xx        atomic.Int64
	mReq5xx        atomic.Int64
	mInFlight      atomic.Int64
	mLatencyNsSum  atomic.Int64
	mStartUnix     = time.Now().Unix()
)

// Metrics contabiliza requisições (total, por classe de status, em andamento, latência).
func Metrics() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.URL.Path == "/metrics" {
			c.Next()
			return
		}
		start := time.Now()
		mInFlight.Add(1)
		mReqTotal.Add(1)
		c.Next()
		mInFlight.Add(-1)
		mLatencyNsSum.Add(time.Since(start).Nanoseconds())
		switch code := c.Writer.Status(); {
		case code >= 500:
			mReq5xx.Add(1)
		case code >= 400:
			mReq4xx.Add(1)
		case code >= 200 && code < 300:
			mReq2xx.Add(1)
		}
	}
}

// MetricsHandler expõe as métricas no formato de exposição Prometheus (texto puro).
func MetricsHandler(c *gin.Context) {
	var sb strings.Builder
	line := func(name, typ, help string, val int64) {
		fmt.Fprintf(&sb, "# HELP %s %s\n# TYPE %s %s\n%s %d\n", name, help, name, typ, name, val)
	}
	line("sure_http_requests_total", "counter", "Total de requisicoes HTTP", mReqTotal.Load())
	line("sure_http_requests_2xx", "counter", "Respostas 2xx", mReq2xx.Load())
	line("sure_http_requests_4xx", "counter", "Respostas 4xx", mReq4xx.Load())
	line("sure_http_requests_5xx", "counter", "Respostas 5xx", mReq5xx.Load())
	line("sure_http_in_flight", "gauge", "Requisicoes em andamento", mInFlight.Load())
	line("sure_http_latency_ns_sum", "counter", "Soma de latencia (ns)", mLatencyNsSum.Load())
	line("sure_uptime_seconds", "gauge", "Uptime em segundos", time.Now().Unix()-mStartUnix)
	c.Data(http.StatusOK, "text/plain; version=0.0.4; charset=utf-8", []byte(sb.String()))
}
