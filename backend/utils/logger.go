// Package utils fornece utilitários compartilhados.
package utils

import (
	"log/slog"
	"os"
)

// InitLogger configura slog como logger padrão da aplicação.
// Em produção (LOG_FORMAT=json) usa JSONHandler; caso contrário TextHandler.
func InitLogger() {
	var h slog.Handler
	level := parseLevel(os.Getenv("LOG_LEVEL"))

	if os.Getenv("LOG_FORMAT") == "json" {
		h = slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	} else {
		h = slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	}
	slog.SetDefault(slog.New(h))
}

func parseLevel(s string) slog.Level {
	switch s {
	case "debug", "DEBUG":
		return slog.LevelDebug
	case "warn", "WARN":
		return slog.LevelWarn
	case "error", "ERROR":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
