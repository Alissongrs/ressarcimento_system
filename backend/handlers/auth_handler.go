// ressarcimento-backend/handlers/auth.go
package handlers

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"ressarcimento-backend/auth"
	"ressarcimento-backend/database"
	"ressarcimento-backend/models"
	"ressarcimento-backend/utils"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

// Sal legado para compatibilidade com hashes SHA256 antigos
// DEPRECATED: usado apenas para migração de senhas antigas
var salt = func() string {
	if s := os.Getenv("LEGACY_PASSWORD_SALT"); s != "" {
		return s
	}
	return "um-sal-secreto-para-aumentar-a-seguranca"
}()

// hashPasswordBcrypt cria um hash seguro usando bcrypt (custo 12)
func hashPasswordBcrypt(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// verifyPasswordBcrypt verifica se a senha corresponde ao hash bcrypt
func verifyPasswordBcrypt(password, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

// hashPasswordSHA256Legacy gera hash SHA256 (DEPRECATED: apenas para compatibilidade)
func hashPasswordSHA256Legacy(password string) string {
	saltedPassword := password + salt
	hasher := sha256.New()
	hasher.Write([]byte(saltedPassword))
	return hex.EncodeToString(hasher.Sum(nil))
}

// isBcryptHash verifica se o hash é bcrypt (comeÃ§a com $2a$, $2b$ ou $2y$)
func isBcryptHash(hash string) bool {
	return strings.HasPrefix(hash, "$2a$") ||
	       strings.HasPrefix(hash, "$2b$") ||
	       strings.HasPrefix(hash, "$2y$")
}

// verifyPassword verifica senha com suporte a bcrypt e SHA256 legacy
// Se detectar SHA256, automaticamente migra para bcrypt
func verifyPassword(password, hash string, userID int64) (bool, error) {
	if isBcryptHash(hash) {
		// Hash moderno (bcrypt)
		return verifyPasswordBcrypt(password, hash), nil
	}

	// Hash legado (SHA256) - verifica e migra
	legacyHash := hashPasswordSHA256Legacy(password)
	if legacyHash == hash {
		log.Printf("Migrando senha do usuário ID %d de SHA256 para bcrypt", userID)

		// Gera novo hash bcrypt
		newHash, err := hashPasswordBcrypt(password)
		if err != nil {
			log.Printf("ERRO ao gerar hash bcrypt na migraÃ§ão para usuário ID %d: %v", userID, err)
			return true, nil // Senha está correta, mas falhou migraÃ§ão
		}

		// Atualiza no banco
		_, err = execGorm(database.GormDB_App, 
			"UPDATE DM_USUARIO SET senha_hash = ? WHERE id_usuario = ?",
			newHash, userID,
		)
		if err != nil {
			log.Printf("ERRO ao atualizar hash no banco para usuário ID %d: %v", userID, err)
			return true, nil // Senha está correta, mas falhou migraÃ§ão
		}

		log.Printf("âœ“ Senha migrada com sucesso para usuário ID %d", userID)
		return true, nil
	}

	return false, nil
}

// Register cria um novo usuário na tabela DM_USUARIO.
// @Summary Registrar usuario
// @Tags Auth
// @Accept json
// @Produce json
// @Param body body models.User true "Usuario"
// @Success 201 {object} map[string]string
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/register [post]
func Register(c *gin.Context) {
	var input struct {
		Nome           string `json:"nome"           binding:"required,min=2,max=120"`
		Email          string `json:"email"          binding:"required,email"`
		Senha          string `json:"senha"          binding:"required,min=8,max=128"`
		IDDepartamento int64  `json:"id_departamento" binding:"required,min=1"`
	}
	if utils.BindAndValidate(c, &input) {
		return
	}
	user := models.User{
		Nome:           input.Nome,
		Email:          input.Email,
		Senha:          input.Senha,
		IDDepartamento: input.IDDepartamento,
	}

	// Gera hash seguro com bcrypt
	hashedPassword, err := hashPasswordBcrypt(user.Senha)
	if err != nil {
		log.Printf("Erro ao gerar hash de senha: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao processar senha"})
		return
	}

	// Insert incluindo id_departamento e perfil padrão 'solicitante'
	_, err = execGorm(database.GormDB_App, 
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
// @Summary Login
// @Tags Auth
// @Accept json
// @Produce json
// @Param body body map[string]string true "Credenciais"
// @Success 200 {object} map[string]string
// @Failure 400 {object} map[string]string
// @Failure 401 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/login [post]
func Login(c *gin.Context) {
	var input struct {
		Email    string `json:"email"    binding:"required,email"`
		Password string `json:"password" binding:"required,min=6,max=128"`
	}
	if utils.BindAndValidate(c, &input) {
		return
	}

	log.Printf("Tentativa de login para o email: %s", input.Email)

	var user models.User
	var hashedPasswordFromDB string

	// Busca usuário ativo por email
	err := queryRowGorm(database.GormDB_App, 
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

	// Verifica senha com suporte a migraÃ§ão automática de SHA256 para bcrypt
	passwordValid, err := verifyPassword(input.Password, hashedPasswordFromDB, user.ID)
	if err != nil {
		log.Printf("Erro ao verificar senha para '%s': %v", input.Email, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro no servidor"})
		return
	}

	if !passwordValid {
		log.Printf("Falha na verificaÃ§ão da senha para '%s'", input.Email)
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

	cookieSecure := os.Getenv("COOKIE_SECURE") == "true"
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(
		"auth_token",
		tokenString,
		int(time.Until(expirationTime).Seconds()),
		"/",
		"",
		cookieSecure,
		true, // HttpOnly
	)

	c.JSON(http.StatusOK, gin.H{
		"message": "Login bem-sucedido!",
		"token":   tokenString,
	})
}

// Logout limpa o cookie de autenticação.
// @Summary Logout
// @Tags Auth
// @Success 200 {object} map[string]string
// @Router /api/v1/logout [post]
func Logout(c *gin.Context) {
	cookieSecure := os.Getenv("COOKIE_SECURE") == "true"
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie("auth_token", "", -1, "/", "", cookieSecure, true)
	c.JSON(http.StatusOK, gin.H{"message": "Logout realizado com sucesso"})
}

