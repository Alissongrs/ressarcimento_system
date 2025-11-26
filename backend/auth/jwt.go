// backend/auth/jwt.go
package auth

import (
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Segredo do JWT (usa env JWT_SECRET, senão fallback dev)
var JwtKey = []byte(func() string {
	if v := strings.TrimSpace(os.Getenv("JWT_SECRET")); v != "" {
		return v
	}
	return "dev-secret-change-me" // troque em produção
}())

// Claims padrão do sistema
type Claims struct {
	UserID    int64  `json:"user_id"`
	TipoConta string `json:"tipo_conta,omitempty"`
	Nome      string `json:"nome,omitempty"`
	UserName  string `json:"user_name,omitempty"`
	Role      string `json:"role,omitempty"`
	jwt.RegisteredClaims
}

// Helper para criar claims com expiração
func NewClaims(userID int64, nome, role, tipo string, ttl time.Duration) *Claims {
	now := time.Now()
	return &Claims{
		UserID:    userID,
		Nome:      nome,
		UserName:  nome,
		Role:      role,
		TipoConta: tipo,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
		},
	}
}
