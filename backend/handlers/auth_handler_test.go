package handlers

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestLogin_InvalidJSON_Returns400(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewBufferString("{invalid"))
	req.Header.Set("Content-Type", "application/json")
	c.Request = req

	Login(c)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	if got := w.Body.String(); !bytes.Contains([]byte(got), []byte("Dados de entrada inválidos")) {
		t.Fatalf("missing error message, got: %s", got)
	}
}

func TestRegister_MissingDepartamento_Returns400(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	// Missing id_departamento
	body := []byte(`{"nome":"Teste","email":"t@e.com","senha":"x"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	c.Request = req

	Register(c)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	if got := w.Body.String(); !bytes.Contains([]byte(got), []byte("O departamento é obrigatório")) {
		t.Fatalf("missing error message, got: %s", got)
	}
}
