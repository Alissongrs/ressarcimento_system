package handlers

import (
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCreateRequisicao_NoAuth_Returns401(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	// multipart/form-data request
	body := &multipart.Writer{}
	req := httptest.NewRequest(http.MethodPost, "/api/requisicoes", nil)
	req.Header.Set("Content-Type", body.FormDataContentType())
	c.Request = req

	CreateRequisicao(c)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
	if got := w.Body.String(); !strings.Contains(got, "Usuário não autenticado") {
		t.Fatalf("missing message, got: %s", got)
	}
}

func TestUpdateRequisicao_NoAuth_Returns401(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	req := httptest.NewRequest(http.MethodPost, "/api/requisicoes/123/update", nil)
	c.Params = append(c.Params, gin.Param{Key: "id", Value: "123"})
	c.Request = req

	UpdateRequisicaoCompleta(c)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
	if got := w.Body.String(); !strings.Contains(got, "Usuário não autenticado") {
		t.Fatalf("missing message, got: %s", got)
	}
}
