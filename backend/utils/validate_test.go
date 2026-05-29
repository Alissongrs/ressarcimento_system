package utils

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

type loginInput struct {
	Email    string `json:"email"    binding:"required,email"`
	Password string `json:"password" binding:"required,min=6,max=128"`
}

func setupRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/test", func(c *gin.Context) {
		var in loginInput
		if BindAndValidate(c, &in) {
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	return r
}

func doPost(t *testing.T, r *gin.Engine, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/test", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestBindAndValidate_ValidPayload(t *testing.T) {
	r := setupRouter()
	w := doPost(t, r, loginInput{Email: "u@example.com", Password: "abcdef"})
	if w.Code != http.StatusOK {
		t.Fatalf("esperava 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBindAndValidate_RejectsMissingEmail(t *testing.T) {
	r := setupRouter()
	w := doPost(t, r, map[string]string{"password": "abcdef"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("esperava 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "email") {
		t.Fatalf("erro deveria mencionar 'email', got: %s", w.Body.String())
	}
}

func TestBindAndValidate_RejectsInvalidEmail(t *testing.T) {
	r := setupRouter()
	w := doPost(t, r, loginInput{Email: "not-an-email", Password: "abcdef"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("esperava 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "e-mail") {
		t.Fatalf("erro deveria mencionar 'e-mail', got: %s", w.Body.String())
	}
}

func TestBindAndValidate_RejectsShortPassword(t *testing.T) {
	r := setupRouter()
	w := doPost(t, r, loginInput{Email: "u@example.com", Password: "abc"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("esperava 400, got %d", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, "password") || !strings.Contains(body, "6") {
		t.Fatalf("erro deveria mencionar 'password' e mínimo 6, got: %s", body)
	}
}

func TestBindAndValidate_MalformedJSON(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/test", func(c *gin.Context) {
		var in loginInput
		if BindAndValidate(c, &in) {
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	req := httptest.NewRequest(http.MethodPost, "/test", strings.NewReader("{not json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("esperava 400 para JSON malformado, got %d", w.Code)
	}
}
