package v2

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"ressarcimento-backend/auth"
	"ressarcimento-backend/utils"
)

// ─── Hashing (mesma estratégia do v1) ───────────────────────────────────────

// saltLegacy: mesmo sal usado no v1 pra compatibilidade com hashes SHA256 antigos.
const saltLegacy = "qmF8Yp$3Lz!9wT@rXk1bN5cE7vA0sJ"

func hashPasswordBcrypt(password string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return "", err
	}
	return string(h), nil
}

func verifyPasswordBcrypt(password, hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

func hashPasswordSHA256Legacy(password string) string {
	salted := password + saltLegacy
	h := sha256.New()
	h.Write([]byte(salted))
	return hex.EncodeToString(h.Sum(nil))
}

func isBcryptHash(hash string) bool {
	return strings.HasPrefix(hash, "$2a$") ||
		strings.HasPrefix(hash, "$2b$") ||
		strings.HasPrefix(hash, "$2y$")
}

// verifyPassword valida a senha (bcrypt + fallback SHA256 com migração automática).
// Quando hash legado é detectado e validado, atualiza pra bcrypt no banco v2.
func verifyPasswordV2(db *sql.DB, password, hash string, userID int64) (bool, error) {
	if isBcryptHash(hash) {
		return verifyPasswordBcrypt(password, hash), nil
	}

	// Legacy SHA256
	if hashPasswordSHA256Legacy(password) == hash {
		log.Printf("[auth v2] Migrando senha SHA256→bcrypt para usuário %d", userID)
		newHash, err := hashPasswordBcrypt(password)
		if err == nil {
			if _, err := db.Exec("UPDATE DM_USUARIO SET senha_hash = ? WHERE id_usuario = ?", newHash, userID); err != nil {
				log.Printf("[auth v2] Falha ao atualizar hash do usuário %d: %v", userID, err)
			}
		}
		return true, nil
	}
	return false, nil
}

// ─── Login ──────────────────────────────────────────────────────────────────

type loginReq struct {
	Email    string `json:"email"    binding:"required,email"`
	Password string `json:"password" binding:"required,min=6,max=128"`
}

// Login — POST /api/v2/auth/login
// Autentica contra DM_USUARIO no banco v2 e devolve JWT.
func Login(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}

	var input loginReq
	if !bindJSON(c, &input) {
		return
	}

	email := strings.ToLower(strings.TrimSpace(input.Email))
	log.Printf("[auth v2] Tentativa de login: %s", email)

	var (
		userID    int64
		nome      string
		hashFromDB string
		perfil    string
		ativo     int
	)
	err := db.QueryRowContext(c.Request.Context(), `
SELECT id_usuario, nome_usuario, senha_hash, perfil, usuario_ativo
  FROM DM_USUARIO
 WHERE LOWER(email) = ?
   AND senha_hash IS NOT NULL`, email).Scan(&userID, &nome, &hashFromDB, &perfil, &ativo)
	if errors.Is(err, sql.ErrNoRows) {
		apiError(c, http.StatusUnauthorized, "CREDENCIAIS_INVALIDAS", "Email ou senha inválidos", nil)
		return
	}
	if err != nil {
		log.Printf("[auth v2] Erro de DB no login %s: %v", email, err)
		apiError(c, http.StatusInternalServerError, "DB_ERR", "Erro ao buscar usuário", nil)
		return
	}
	if ativo != 1 {
		apiError(c, http.StatusUnauthorized, "CREDENCIAIS_INVALIDAS", "Email ou senha inválidos", nil)
		return
	}

	ok, err := verifyPasswordV2(db, input.Password, hashFromDB, userID)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "AUTH_ERR", "Erro ao verificar senha", nil)
		return
	}
	if !ok {
		apiError(c, http.StatusUnauthorized, "CREDENCIAIS_INVALIDAS", "Email ou senha inválidos", nil)
		return
	}

	// Monta JWT — mesmas claims do v1 pra reusar middleware AuthMiddleware
	role := strings.ToLower(strings.TrimSpace(perfil))
	if role == "" {
		role = "solicitante"
	}
	tipo := role // alias

	userName := strings.TrimSpace(nome)
	if userName == "" {
		userName = email
	}

	exp := time.Now().Add(24 * time.Hour)
	claims := &auth.Claims{
		UserID:    userID,
		TipoConta: tipo,
		Nome:      nome,
		UserName:  userName,
		Role:      role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(exp),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
		},
	}
	tokenStr, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(auth.JwtKey)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "TOKEN_ERR", "Erro ao gerar token", nil)
		return
	}

	// last_login não existe em DM_USUARIO — pulado.

	// Cookie
	cookieSecure := os.Getenv("COOKIE_SECURE") == "true"
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie("auth_token", tokenStr,
		int(time.Until(exp).Seconds()),
		"/", "", cookieSecure, true)

	c.JSON(http.StatusOK, gin.H{
		"message": "Login bem-sucedido!",
		"token":   tokenStr,
		"user": gin.H{
			"id":     userID,
			"nome":   nome,
			"email":  email,
			"perfil": perfil,
			"role":   role,
		},
	})
}

// ─── Logout ─────────────────────────────────────────────────────────────────

// Logout — POST /api/v2/auth/logout
func Logout(c *gin.Context) {
	cookieSecure := os.Getenv("COOKIE_SECURE") == "true"
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie("auth_token", "", -1, "/", "", cookieSecure, true)
	c.JSON(http.StatusOK, gin.H{"message": "Logout efetuado"})
}

// ─── /me ────────────────────────────────────────────────────────────────────

// Me — GET /api/v2/auth/me
// Retorna o usuário autenticado. Requer AuthMiddleware no grupo.
func Me(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}

	raw, exists := c.Get("userID")
	if !exists {
		apiError(c, http.StatusUnauthorized, "NAO_AUTENTICADO", "Token ausente ou inválido", nil)
		return
	}
	var userID int64
	switch v := raw.(type) {
	case int:
		userID = int64(v)
	case int64:
		userID = v
	case float64:
		userID = int64(v)
	default:
		apiError(c, http.StatusUnauthorized, "NAO_AUTENTICADO", "ID de usuário inválido no token", nil)
		return
	}

	// Tenta primeiro por id_usuario (token v2). Se não achar, tenta por id_usuario_origem (token vindo do v1).
	var (
		id      int64
		nome, email, perfil string
		ativo   int
		msOID   sql.NullString
		msEmail sql.NullString
	)
	err := db.QueryRowContext(c.Request.Context(), `
SELECT id_usuario, nome_usuario, email, perfil, usuario_ativo, ms_oid, ms_email
  FROM DM_USUARIO
 WHERE id_usuario = ? OR id_usuario_origem = ?
 LIMIT 1`, userID, userID).Scan(&id, &nome, &email, &perfil, &ativo, &msOID, &msEmail)
	if errors.Is(err, sql.ErrNoRows) {
		apiError(c, http.StatusNotFound, "USUARIO_NAO_ENCONTRADO", "Usuário não existe no v2", nil)
		return
	}
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"id":     id,
		"nome":   nome,
		"email":  email,
		"perfil": perfil,
		"role":   perfil,
		"ativo":  ativo == 1,
		"microsoft_vinculado": msOID.Valid && msOID.String != "",
		"microsoft_email":     msEmail.String,
	})
}

// ─── Register ───────────────────────────────────────────────────────────────

type registerReq struct {
	Nome           string `json:"nome"            binding:"required,min=2,max=120"`
	Email          string `json:"email"           binding:"required,email"`
	Password       string `json:"password"        binding:"required,min=6,max=128"`
	IDDepartamento *int   `json:"id_departamento"`
}

// Register — POST /api/v2/auth/register
// Cria usuário com perfil 'solicitante' por padrão.
func Register(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}

	var input registerReq
	if !bindJSON(c, &input) {
		return
	}
	// P2-6: auto-registro só para domínios corporativos autorizados (default @amee.com.br).
	if !utils.EmailDomainAllowed(input.Email) {
		apiError(c, http.StatusForbidden, "DOMINIO_NAO_PERMITIDO",
			"Registro permitido apenas para e-mails corporativos autorizados.", nil)
		return
	}

	hashed, err := hashPasswordBcrypt(input.Password)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "HASH_ERR", "Erro ao gerar hash", nil)
		return
	}

	res, err := db.ExecContext(c.Request.Context(), `
INSERT INTO DM_USUARIO (nome_usuario, email, senha_hash, id_departamento, perfil, usuario_ativo)
VALUES (?, ?, ?, ?, 'solicitante', 1)`,
		input.Nome, strings.ToLower(strings.TrimSpace(input.Email)),
		hashed, input.IDDepartamento)
	if err != nil {
		// duplicidade de email
		if strings.Contains(err.Error(), "Duplicate") {
			apiError(c, http.StatusConflict, "EMAIL_JA_CADASTRADO",
				"Já existe usuário com esse email", nil)
			return
		}
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	newID, _ := res.LastInsertId()
	c.JSON(http.StatusCreated, gin.H{
		"message":    "Usuário criado com sucesso",
		"id_usuario": newID,
	})
}
