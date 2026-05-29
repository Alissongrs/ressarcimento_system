package handlers

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// ===== Testes unitários de hash de senha (sem DB) =====

func TestHashPasswordBcrypt_ProducesValidHash(t *testing.T) {
	hash, err := hashPasswordBcrypt("senha-forte-123")
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if !isBcryptHash(hash) {
		t.Fatalf("hash gerado não passa em isBcryptHash: %s", hash)
	}
}

func TestVerifyPasswordBcrypt_AcceptsCorrectPassword(t *testing.T) {
	pw := "outra-senha-456"
	hash, _ := hashPasswordBcrypt(pw)
	if !verifyPasswordBcrypt(pw, hash) {
		t.Fatal("senha correta foi rejeitada")
	}
}

func TestVerifyPasswordBcrypt_RejectsWrongPassword(t *testing.T) {
	hash, _ := hashPasswordBcrypt("senha-original")
	if verifyPasswordBcrypt("senha-errada", hash) {
		t.Fatal("senha errada foi aceita")
	}
}

func TestIsBcryptHash_DetectsAllVariants(t *testing.T) {
	cases := []struct {
		hash string
		want bool
	}{
		{"$2a$10$abcdefghij...", true},
		{"$2b$12$abcdefghij...", true},
		{"$2y$12$abcdefghij...", true},
		{"abc123def456", false},
		{"$5$rounds=...", false},
		{"", false},
		{"$1$salt$hash", false},
	}
	for _, tc := range cases {
		if got := isBcryptHash(tc.hash); got != tc.want {
			t.Errorf("isBcryptHash(%q) = %v, esperado %v", tc.hash, got, tc.want)
		}
	}
}

func TestHashPasswordSHA256Legacy_IsDeterministic(t *testing.T) {
	a := hashPasswordSHA256Legacy("teste")
	b := hashPasswordSHA256Legacy("teste")
	if a != b {
		t.Fatal("SHA256 legacy não é determinístico")
	}
	if len(a) != 64 {
		t.Fatalf("hash SHA256 hex deveria ter 64 chars, got %d", len(a))
	}
}

func TestBcryptHashes_AreUnique(t *testing.T) {
	h1, _ := hashPasswordBcrypt("mesma-senha")
	h2, _ := hashPasswordBcrypt("mesma-senha")
	if h1 == h2 {
		t.Fatal("dois hashes bcrypt da mesma senha não deveriam ser iguais (salt aleatório)")
	}
	if !verifyPasswordBcrypt("mesma-senha", h1) || !verifyPasswordBcrypt("mesma-senha", h2) {
		t.Fatal("ambos hashes deveriam validar a mesma senha")
	}
}

// ===== Testes de validação de input (sem DB) =====

func TestLogin_InvalidJSON_Returns400(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewBufferString("{invalid"))
	req.Header.Set("Content-Type", "application/json")
	c.Request = req

	Login(c)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("esperava 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "Dados de entrada inválidos") {
		t.Fatalf("erro deveria mencionar 'Dados de entrada inválidos', got: %s", w.Body.String())
	}
}

func TestLogin_MissingEmail_Returns400(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	body := []byte(`{"password":"123456"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	c.Request = req

	Login(c)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("esperava 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "email") {
		t.Fatalf("erro deveria mencionar campo email, got: %s", w.Body.String())
	}
}

func TestRegister_MissingDepartamento_Returns400(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	body := []byte(`{"nome":"Teste","email":"t@e.com","senha":"senhaforte"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	c.Request = req

	Register(c)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("esperava 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "id_departamento") {
		t.Fatalf("erro deveria mencionar 'id_departamento', got: %s", w.Body.String())
	}
}

func TestRegister_ShortPassword_Returns400(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	body := []byte(`{"nome":"Teste","email":"t@e.com","senha":"abc","id_departamento":1}`)
	req := httptest.NewRequest(http.MethodPost, "/api/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	c.Request = req

	Register(c)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("esperava 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "8") {
		t.Fatalf("erro deveria mencionar mínimo 8 chars, got: %s", w.Body.String())
	}
}

func TestLogout_ClearsCookie(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/logout", nil)

	Logout(c)

	if w.Code != http.StatusOK {
		t.Fatalf("esperava 200, got %d", w.Code)
	}
	cookies := w.Result().Cookies()
	found := false
	for _, ck := range cookies {
		if ck.Name == "auth_token" {
			found = true
			if ck.MaxAge >= 0 {
				t.Fatalf("cookie deveria estar expirado (MaxAge<0), got %d", ck.MaxAge)
			}
			if ck.Value != "" {
				t.Fatalf("cookie deveria estar vazio, got %q", ck.Value)
			}
		}
	}
	if !found {
		t.Fatal("Logout deveria ter setado cookie auth_token (expirado)")
	}
}
