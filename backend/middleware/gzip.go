// backend/middleware/gzip.go
package middleware

import (
	"compress/gzip"
	"io"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
)

type gzipWriter struct {
	gin.ResponseWriter
	writer *gzip.Writer
}

func (g *gzipWriter) Write(data []byte) (int, error) {
	return g.writer.Write(data)
}

func (g *gzipWriter) WriteString(s string) (int, error) {
	return g.writer.Write([]byte(s))
}

var gzipPool = sync.Pool{
	New: func() interface{} {
		w, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
		return w
	},
}

// Gzip middleware para compressão de respostas HTTP
// Melhora significativamente a performance para JSON e HTML
func Gzip() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Verifica se o cliente aceita gzip
		if !strings.Contains(c.GetHeader("Accept-Encoding"), "gzip") {
			c.Next()
			return
		}

		// Não comprime se já estiver comprimido
		if c.GetHeader("Content-Encoding") != "" {
			c.Next()
			return
		}

		// Não comprime SSE (Server-Sent Events) - precisa de streaming
		if c.GetHeader("Content-Type") == "text/event-stream" {
			c.Next()
			return
		}

		// Obtém writer do pool
		gz := gzipPool.Get().(*gzip.Writer)
		defer gzipPool.Put(gz)
		gz.Reset(c.Writer)

		// Configura headers
		c.Header("Content-Encoding", "gzip")
		c.Header("Vary", "Accept-Encoding")

		// Wrap writer
		c.Writer = &gzipWriter{
			ResponseWriter: c.Writer,
			writer:         gz,
		}
		defer func() {
			gz.Close()
			c.Header("Content-Length", "")
		}()

		c.Next()
	}
}
