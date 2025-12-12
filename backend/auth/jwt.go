// backend/auth/jwt.go
package auth

import (
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Segredo do JWT - OBRIGATÓRIO via variável de ambiente JWT_SECRET
var JwtKey = []byte(func() string {
	secret := strings.TrimSpace(os.Getenv("JWT_SECRET"))

	// Em produção (GO_ENV=production), JWT_SECRET é OBRIGATÓRIO
	if os.Getenv("GO_ENV") == "production" {
		if secret == "" {
			log.Fatal("ERRO CRÍTICO: JWT_SECRET não foi definido em produção. Configure a variável de ambiente JWT_SECRET antes de iniciar o servidor.")
		}
		if len(secret) < 32 {
			log.Fatal("ERRO CRÍTICO: JWT_SECRET deve ter no mínimo 32 caracteres em produção.")
		}
		log.Println("✓ JWT_SECRET configurado corretamente para produção")
		return secret
	}

	// Em desenvolvimento, permite fallback mas avisa
	if secret == "" {
		log.Println("⚠️  AVISO: JWT_SECRET não configurado. Usando chave de desenvolvimento.")
		log.Println("⚠️  NUNCA use isso em produção! Configure JWT_SECRET no .env")
		return "dev-secret-change-me-INSEGURO"
	}

	if len(secret) < 32 {
		log.Printf("⚠️  AVISO: JWT_SECRET tem apenas %d caracteres. Recomendado: 32+", len(secret))
	}

	return secret
}())

// ValidateJWTSetup verifica se a configuração JWT está correta (chamado no startup)
func ValidateJWTSetup() error {
	if os.Getenv("GO_ENV") == "production" && len(JwtKey) < 32 {
		return fmt.Errorf("JWT_SECRET inválido em produção")
	}
	return nil
}

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
