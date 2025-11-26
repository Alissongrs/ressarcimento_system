//go:build integration

package handlers

import (
	"bytes"
	"database/sql"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
	_ "github.com/go-sql-driver/mysql"
)

// Este teste de integração move um processo e verifica logs de histórico.
// Requer um banco MySQL acessível. Configure as variáveis:
//
//	DB_APP_URL
//
// Execute com: go test -tags=integration ./handlers -run TestMovimentaHistorico_Integration -v
func TestMovimentaHistorico_Integration(t *testing.T) {
	dsn := os.Getenv("DB_APP_URL")
	if dsn == "" {
		t.Skip("DB_APP_URL não definido; pulando teste de integração")
	}

	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	database.DB_App = db

	// Ajuste o ID de processo existente para seu ambiente de teste.
	processoID := os.Getenv("TEST_PROCESSO_ID")
	if processoID == "" {
		t.Skip("TEST_PROCESSO_ID não definido; pulando")
	}

	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	body := bytes.NewBufferString(`{"comentario":"Teste integração histórico"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/processos/"+processoID+"/movimentar", body)
	req.Header.Set("Content-Type", "application/json")
	c.Request = req
	c.Params = append(c.Params, gin.Param{Key: "id", Value: processoID})
	c.Set("userID", int64(1))

	// Captura logs do teste
	var buf bytes.Buffer
	log.SetOutput(&buf)
	MovimentarProcesso(c)

	// Logs devem conter a marca de histórico (ok ou erro)
	logStr := buf.String()
	if w.Code >= 500 && !bytes.Contains([]byte(logStr), []byte("ERRO HISTORICO")) {
		t.Fatalf("esperava log de erro de histórico; logs: %s", logStr)
	}
}
