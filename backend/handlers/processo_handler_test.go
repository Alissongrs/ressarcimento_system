package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestMovimentarProcesso_InvalidID_Returns400WithAccents(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	req := httptest.NewRequest(http.MethodPost, "/api/processos/abc/movimentar", nil)
	c.Request = req
	c.Params = append(c.Params, gin.Param{Key: "id", Value: "abc"})

	MovimentarProcesso(c)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	if got := w.Body.String(); !strings.Contains(got, "ID do processo inv") {
		t.Fatalf("missing expected message, got: %s", got)
	}
}

func containsAll(s string, subs []string) bool {
	for _, sub := range subs {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}
