// ressarcimento-backend/handlers/auth.go
package handlers

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"log"
	"net/http"
	"strings"
	"time"

	"ressarcimento-backend/auth"
	"ressarcimento-backend/database"
	"ressarcimento-backend/models"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// Sal para hash de senha (pode vir do env também, se quiser)
var salt = "um-sal-secreto-para-aumentar-a-seguranca"

func hashPassword(password string) string {
	saltedPassword := password + salt
	hasher := sha256.New()
	hasher.Write([]byte(saltedPassword))
	return hex.EncodeToString(hasher.Sum(nil))
}

// Register cria um novo usuário na tabela DM_USUARIO.
func Register(c *gin.Context) {
	var user models.User
	if err := c.ShouldBindJSON(&user); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos"})
		return
	}

	// Validação: departamento é obrigatório
	if user.IDDepartamento == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "O departamento é obrigatório"})
		return
	}

	hashedPassword := hashPassword(user.Senha)

	// Insert incluindo id_departamento e perfil padrão 'solicitante'
	_, err := database.DB_App.Exec(
		"INSERT INTO DM_USUARIO (nome_usuario, email, senha_hash, id_departamento, perfil) VALUES (?, ?, ?, ?, ?)",
		user.Nome, user.Email, hashedPassword, user.IDDepartamento, "solicitante",
	)
	if err != nil {
		log.Printf("Erro ao cadastrar usuário: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Email já cadastrado ou erro ao criar usuário"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"message": "Usuário criado com sucesso!"})
}

// Login autentica um usuário e gera um token JWT.
func Login(c *gin.Context) {
	var input struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados de entrada inválidos"})
		return
	}

	log.Printf("Tentativa de login para o email: %s", input.Email)

	var user models.User
	var hashedPasswordFromDB string

	// Busca usuário ativo por email
	err := database.DB_App.QueryRow(
		"SELECT id_usuario, nome_usuario, email, senha_hash, perfil FROM DM_USUARIO WHERE email = ? AND usuario_ativo = TRUE",
		input.Email,
	).Scan(&user.ID, &user.Nome, &user.Email, &hashedPasswordFromDB, &user.TipoConta)
	if err != nil {
		if err == sql.ErrNoRows {
			log.Printf("Falha no login: Usuário '%s' não encontrado ou inativo.", input.Email)
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Email ou senha inválidos"})
			return
		}
		log.Printf("Erro de servidor ao buscar usuário '%s': %v", input.Email, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro no servidor"})
		return
	}

	// Compara hash da senha
	hashOfInputPassword := hashPassword(input.Password)
	log.Printf("Hash do DB para '%s': %s", input.Email, hashedPasswordFromDB)
	log.Printf("Hash do Input para '%s': %s", input.Email, hashOfInputPassword)

	if hashOfInputPassword != hashedPasswordFromDB {
		log.Printf("Falha na verificação da senha para '%s'. Hashes não coincidem.", input.Email)
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Email ou senha inválidos"})
		return
	}

	// Monta campos para as claims
	userName := strings.TrimSpace(user.Nome)
	if userName == "" {
		userName = strings.TrimSpace(user.Email) // fallback
	}
	role := strings.ToLower(strings.TrimSpace(user.TipoConta))
	if role == "" {
		role = "solicitante"
	}

	expirationTime := time.Now().Add(24 * time.Hour)

	claims := &auth.Claims{
		UserID:    user.ID,
		TipoConta: user.TipoConta,
		Nome:      user.Nome,
		UserName:  userName,
		Role:      role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expirationTime),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, err := token.SignedString(auth.JwtKey)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao gerar token"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "Login bem-sucedido!",
		"token":   tokenString,
	})
}
