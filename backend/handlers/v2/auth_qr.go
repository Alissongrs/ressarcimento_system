package v2

// Login no celular por QR code ("Conectar celular").
//
//   POST /api/v2/auth/qr            (logado no site)  → {codigo, url, expira_em}
//   GET  /api/v2/auth/qr/:codigo    (logado no site)  → {usado} — o site mostra "celular conectado"
//   POST /api/v2/auth/qr/entrar     (público) {codigo} → abre a sessão do MESMO usuário no celular
//
// O código é aleatório (256 bits), vale UMA vez e por 2 minutos, e fica só na memória do
// backend (reiniciou = some). No momento de entrar, o usuário é relido do banco: inativo não entra.

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const qrValidade = 2 * time.Minute

type qrPendente struct {
	userID int64
	expira time.Time
	usado  bool
}

var (
	qrMu    sync.Mutex
	qrCodes = map[string]*qrPendente{}
)

func qrLimpar() { // chamar com qrMu travado
	agora := time.Now()
	for k, v := range qrCodes {
		if agora.After(v.expira.Add(5 * time.Minute)) {
			delete(qrCodes, k)
		}
	}
}

func qrUserID(c *gin.Context) (int64, bool) {
	raw, ok := c.Get("userID")
	if !ok {
		return 0, false
	}
	switch v := raw.(type) {
	case int:
		return int64(v), true
	case int64:
		return v, true
	case float64:
		return int64(v), true
	}
	return 0, false
}

// POST /auth/qr
func QRCriar(c *gin.Context) {
	uid, ok := qrUserID(c)
	if !ok || uid <= 0 {
		apiError(c, http.StatusUnauthorized, "NAO_AUTENTICADO", "Entre no site para conectar o celular", nil)
		return
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		apiError(c, http.StatusInternalServerError, "RAND", "não consegui gerar o código", nil)
		return
	}
	cod := hex.EncodeToString(b)
	exp := time.Now().Add(qrValidade)
	qrMu.Lock()
	qrLimpar()
	qrCodes[cod] = &qrPendente{userID: uid, expira: exp}
	qrMu.Unlock()

	esquema := "https"
	if c.Request.TLS == nil && c.GetHeader("X-Forwarded-Proto") == "http" {
		esquema = "http"
	}
	host := c.Request.Host
	if fh := c.GetHeader("X-Forwarded-Host"); fh != "" {
		host = fh
	}
	c.JSON(http.StatusOK, gin.H{
		"codigo":    cod,
		"url":       esquema + "://" + host + "/m/#qr=" + cod,
		"expira_em": exp.UnixMilli(),
		"segundos":  int(qrValidade.Seconds()),
	})
}

// GET /auth/qr/:codigo — só quem criou consegue ver
func QRStatus(c *gin.Context) {
	uid, _ := qrUserID(c)
	qrMu.Lock()
	p := qrCodes[c.Param("codigo")]
	var usado, expirado bool
	if p != nil && p.userID == uid {
		usado = p.usado
		expirado = !p.usado && time.Now().After(p.expira)
	} else {
		expirado = true
	}
	qrMu.Unlock()
	c.JSON(http.StatusOK, gin.H{"usado": usado, "expirado": expirado})
}

// POST /auth/qr/entrar {codigo}
func QREntrar(c *gin.Context) {
	var req struct {
		Codigo string `json:"codigo"`
	}
	_ = c.ShouldBindJSON(&req)
	cod := strings.TrimSpace(req.Codigo)
	if len(cod) != 64 {
		apiError(c, http.StatusBadRequest, "QR_INVALIDO", "Código inválido. Gere um QR novo no site.", nil)
		return
	}
	qrMu.Lock()
	p := qrCodes[cod]
	if p == nil || p.usado || time.Now().After(p.expira) {
		qrMu.Unlock()
		apiError(c, http.StatusUnauthorized, "QR_EXPIRADO", "Este QR já foi usado ou expirou. Gere um novo no site (vale 2 minutos).", nil)
		return
	}
	p.usado = true // uma vez só, mesmo se algo abaixo falhar
	uid := p.userID
	qrMu.Unlock()

	db := requireDB(c)
	if db == nil {
		return
	}
	var (
		id                  int64
		nome, email, perfil string
		ativo               int
	)
	err := db.QueryRowContext(c.Request.Context(), `
SELECT id_usuario, nome_usuario, email, perfil, usuario_ativo
  FROM DM_USUARIO
 WHERE id_usuario = ? OR id_usuario_origem = ?
 LIMIT 1`, uid, uid).Scan(&id, &nome, &email, &perfil, &ativo)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && ativo != 1) {
		apiError(c, http.StatusForbidden, "USUARIO_INATIVO", "Usuário inativo.", nil)
		return
	}
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "erro ao abrir a sessão", nil)
		return
	}
	token, err := issueAppSession(c, uid, nome, email, perfil)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "SESSAO", "erro ao abrir a sessão", nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"token": token, "nome": nome})
}
