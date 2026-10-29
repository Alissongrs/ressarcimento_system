package v2

// ─────────────────────────────────────────────────────────────────────────────
// Login por LINK MÁGICO (passwordless) — entra com o e-mail da empresa, sem
// Azure e sem senha. A pessoa informa o e-mail @amee.com.br, recebe um link na
// caixa de entrada e, ao clicar, é autenticada. No 1º acesso o usuário é criado
// automaticamente (mesma política do auto-registro / "cria sozinho").
//
// Usa o envio de e-mail que o sistema já tem (services.SendEmailDetailed →
// Graph se configurado, senão SMTP). Token de uso único, válido por 15 min,
// assinado com o JWT_SECRET e registrado em FT_MAGIC_LINKS (consumido no clique).
//
// Endpoints (sob /api/v2, públicos):
//   GET  /auth/magic/config   → { enabled }
//   POST /auth/magic          → { email }   (envia o link)
//   GET  /auth/magic/verify   → ?token=...  (consome e autentica; redireciona)
// ─────────────────────────────────────────────────────────────────────────────

import (
	"database/sql"
	"errors"
	"fmt"
	"html"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"ressarcimento-backend/auth"
	"ressarcimento-backend/database"
	"ressarcimento-backend/services"
	"ressarcimento-backend/utils"
)

const magicTyp = "magic"
const magicTTL = 30 * time.Minute

// throttle simples por e-mail (evita spam de envio): 1 pedido a cada 60s.
var (
	magicThrottleMu sync.Mutex
	magicLastSent   = map[string]time.Time{}
)

func magicEnabled() bool { return services.MailSendConfigured() }

// publicBaseURL monta a URL pública do SURE (pro link do e-mail). Usa
// APP_PUBLIC_URL se setado; senão deriva do host da requisição.
func publicBaseURL(c *gin.Context) string {
	if v := strings.TrimSpace(os.Getenv("APP_PUBLIC_URL")); v != "" {
		return strings.TrimRight(v, "/")
	}
	scheme := "https"
	if p := strings.TrimSpace(c.GetHeader("X-Forwarded-Proto")); p != "" {
		scheme = p
	} else if c.Request.TLS == nil {
		host := c.Request.Host
		if strings.HasPrefix(host, "localhost") || strings.HasPrefix(host, "127.0.0.1") {
			scheme = "http"
		}
	}
	return scheme + "://" + c.Request.Host
}

// ─── Handlers ────────────────────────────────────────────────────────────────

// MagicConfig — GET /auth/magic/config
func MagicConfig(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"enabled": magicEnabled()})
}

type magicReq struct {
	Email string `json:"email" binding:"required,email"`
}

// MagicRequest — POST /auth/magic  { email }
// Sempre responde 200 genérico (não revela se o e-mail existe). Só envia o link
// se o domínio for autorizado e o envio de e-mail estiver configurado.
func MagicRequest(c *gin.Context) {
	if !magicEnabled() {
		apiError(c, http.StatusServiceUnavailable, "MAGIC_DESATIVADO", "Login por e-mail indisponível.", nil)
		return
	}
	var in magicReq
	if !bindJSON(c, &in) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))

	// resposta genérica — independente do resultado
	ok := gin.H{"ok": true, "message": "Se o e-mail for válido, enviamos um link de acesso."}

	if !utils.EmailDomainAllowed(email) {
		c.JSON(http.StatusOK, ok) // não revela
		return
	}

	// throttle por e-mail
	magicThrottleMu.Lock()
	last, seen := magicLastSent[email]
	if seen && time.Since(last) < 60*time.Second {
		magicThrottleMu.Unlock()
		c.JSON(http.StatusOK, ok)
		return
	}
	magicLastSent[email] = time.Now()
	magicThrottleMu.Unlock()

	db := database.DB_V2
	if db == nil {
		c.JSON(http.StatusOK, ok)
		return
	}

	// gera token de uso único e registra o jti
	jti := randToken()
	claims := jwt.MapClaims{
		"typ":   magicTyp,
		"email": email,
		"jti":   jti,
		"iat":   time.Now().Unix(),
		"exp":   time.Now().Add(magicTTL).Unix(),
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(auth.JwtKey)
	if err != nil {
		c.JSON(http.StatusOK, ok)
		return
	}
	if _, err := db.ExecContext(c.Request.Context(),
		`INSERT INTO FT_MAGIC_LINKS (jti, email, expires_at) VALUES (?, ?, ?)`,
		jti, email, time.Now().Add(magicTTL)); err != nil {
		log.Printf("[magic] falha ao registrar jti: %v", err)
		c.JSON(http.StatusOK, ok)
		return
	}

	link := publicBaseURL(c) + "/api/v2/auth/magic/verify?token=" + url.QueryEscape(token)
	if err := services.SendEmail(email, "Seu link de acesso ao SURE", magicEmailHTML(link)); err != nil {
		log.Printf("[magic] falha ao enviar e-mail para %s: %v", email, err)
	} else {
		log.Printf("[magic] link enviado para %s", email)
	}
	c.JSON(http.StatusOK, ok)
}

// MagicVerify — GET /auth/magic/verify?token=...
// Consome o token (uso único), acha/cria o usuário e autentica. Redireciona
// pro front com o token de sessão no fragmento (#mstoken), igual ao fluxo MS.
func MagicVerify(c *gin.Context) {
	if !magicEnabled() {
		redirectFront(c, "/login", "magic=desativado")
		return
	}
	tokenStr := c.Query("token")
	if tokenStr == "" {
		redirectFront(c, "/login", "magic=invalido")
		return
	}

	claims := jwt.MapClaims{}
	_, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
		return auth.JwtKey, nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil {
		redirectFront(c, "/login", "magic=expirado")
		return
	}
	if strClaim(claims, "typ") != magicTyp {
		redirectFront(c, "/login", "magic=invalido")
		return
	}
	email := strings.ToLower(strings.TrimSpace(strClaim(claims, "email")))
	jti := strClaim(claims, "jti")
	if email == "" || jti == "" || !utils.EmailDomainAllowed(email) {
		redirectFront(c, "/login", "magic=invalido")
		return
	}

	db := database.DB_V2
	if db == nil {
		redirectFront(c, "/login", "magic=db")
		return
	}

	// consome o jti (uso único): só prossegue se removeu exatamente 1 linha válida
	res, err := db.ExecContext(c.Request.Context(),
		`DELETE FROM FT_MAGIC_LINKS WHERE jti = ? AND email = ? AND expires_at > NOW()`, jti, email)
	if err != nil {
		redirectFront(c, "/login", "magic=db")
		return
	}
	if n, _ := res.RowsAffected(); n != 1 {
		redirectFront(c, "/login", "magic=usado")
		return
	}

	userID, perfil, ativo, err := findOrProvisionByEmail(c, db, email)
	if err != nil {
		log.Printf("[magic] erro ao resolver usuário %s: %v", email, err)
		redirectFront(c, "/login", "magic=db")
		return
	}
	if ativo != 1 {
		redirectFront(c, "/login", "magic=inativo")
		return
	}

	nome := nomeDoUsuario(c, db, userID, email)
	token, err := issueAppSession(c, userID, nome, email, perfil)
	if err != nil {
		redirectFront(c, "/login", "magic=erro")
		return
	}
	// IMPORTANTE: redireciona para /login (não "/"). Deslogado, o app manda "/" →
	// "/login" e perde o #mstoken no caminho. A tela de login é quem lê o token.
	redirectFront(c, "/login", "mstoken="+token)
}

// findOrProvisionByEmail acha o usuário pelo e-mail ou cria (sem senha).
func findOrProvisionByEmail(c *gin.Context, db *sql.DB, email string) (userID int64, perfil string, ativo int, err error) {
	ctx := c.Request.Context()
	err = db.QueryRowContext(ctx,
		`SELECT id_usuario, perfil, usuario_ativo FROM DM_USUARIO WHERE LOWER(email) = ? LIMIT 1`,
		email).Scan(&userID, &perfil, &ativo)
	if errors.Is(err, sql.ErrNoRows) {
		res, e := db.ExecContext(ctx, `
INSERT INTO DM_USUARIO (nome_usuario, email, senha_hash, id_departamento, perfil, usuario_ativo)
VALUES (?, ?, NULL, NULL, 'solicitante', 1)`, emailLocalPart(email), email)
		if e != nil {
			return 0, "", 0, e
		}
		userID, _ = res.LastInsertId()
		log.Printf("[magic] novo usuário criado via link mágico: %s (id %d)", email, userID)
		return userID, "solicitante", 1, nil
	}
	if err != nil {
		return 0, "", 0, err
	}
	return userID, perfil, ativo, nil
}

func nomeDoUsuario(c *gin.Context, db *sql.DB, userID int64, fallback string) string {
	var nome sql.NullString
	_ = db.QueryRowContext(c.Request.Context(),
		`SELECT nome_usuario FROM DM_USUARIO WHERE id_usuario = ? LIMIT 1`, userID).Scan(&nome)
	if nome.Valid && strings.TrimSpace(nome.String) != "" {
		return nome.String
	}
	return emailLocalPart(fallback)
}

// magicEmailHTML monta o corpo do e-mail com o botão do link.
// Marcação à prova de cliente de e-mail (Outlook inclusive): tabelas + bgcolor
// SÓLIDO (nada de gradiente, que o Outlook remove) + botão "bulletproof".
func magicEmailHTML(link string) string {
	safe := html.EscapeString(link)
	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#eef2f6;">
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef2f6">
<tr><td align="center" style="padding:26px 12px;">
  <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px;max-width:100%%;background-color:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e1e7ee;">
    <tr><td bgcolor="#0a1b2e" style="background-color:#0a1b2e;padding:24px 28px;font-family:Arial,Helvetica,sans-serif;">
      <div style="font-size:26px;font-weight:bold;letter-spacing:5px;color:#ffffff;">SURE</div>
      <div style="font-size:13px;color:#9fc7dd;margin-top:4px;">Sistema Unificado de Ressarcimento</div>
    </td></tr>
    <tr><td style="padding:30px 28px;font-family:Arial,Helvetica,sans-serif;color:#1b2733;">
      <div style="font-size:20px;font-weight:bold;margin:0 0 12px;color:#0f2436;">Seu link de acesso</div>
      <div style="font-size:14px;line-height:1.6;color:#44535f;margin:0 0 26px;">
        Clique no botão abaixo para entrar no SURE. O link vale por <strong>30 minutos</strong> e só pode ser usado uma vez.
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
        <tr><td align="center" bgcolor="#0d9488" style="border-radius:9px;">
          <a href="%s" target="_blank" style="display:inline-block;padding:15px 38px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:9px;">Entrar no SURE &rarr;</a>
        </td></tr>
      </table>
      <div style="font-size:12px;color:#8696a3;line-height:1.6;margin:28px 0 0;border-top:1px solid #eef2f6;padding-top:16px;">
        Se você não pediu este acesso, pode ignorar este e-mail.<br>
        Se o botão não funcionar, copie e cole este endereço no navegador:<br>
        <a href="%s" style="word-break:break-all;color:#0d7a6e;">%s</a>
      </div>
    </td></tr>
  </table>
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#9aa7b2;margin-top:14px;">SURE &middot; Ressarcimento de energia</div>
</td></tr>
</table>
</body></html>`, safe, safe, safe)
}
