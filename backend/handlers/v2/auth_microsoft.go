package v2

// ─────────────────────────────────────────────────────────────────────────────
// Login "Entrar com Microsoft" (Microsoft Entra ID / Microsoft 365).
//
// Fluxo Authorization Code conduzido pelo BACKEND — sem bibliotecas novas:
//   - só usa golang-jwt/jwt/v5 (já no projeto) + biblioteca padrão do Go.
//   - reaproveita o MESMO app do Azure usado pelo Graph (AZURE_TENANT_ID /
//     AZURE_CLIENT_ID / AZURE_CLIENT_SECRET do .env).
//
// Se qualquer uma dessas variáveis faltar, msEnabled() = false e TODOS os
// endpoints se desligam (o front esconde o botão) — ou seja, o sistema volta
// ao login só-senha sem precisar reverter código.
//
// Endpoints (todos sob /api/v2):
//   GET /auth/microsoft/config      → { enabled }           (público)
//   GET /auth/microsoft/start       → 302 p/ a Microsoft     (público)
//   GET /auth/microsoft/callback    → volta da Microsoft     (público)
//
// mode=login  : acha o usuário por ms_oid ou e-mail; se não existir e o domínio
//               for autorizado, CRIA o usuário (auto-provisionamento) e já
//               autentica. Depois redireciona com o token no fragmento (#mstoken).
// mode=link   : exige sessão atual (cookie auth_token); vincula o ms_oid à conta
//               logada. Redireciona com #mslink=ok.
// ─────────────────────────────────────────────────────────────────────────────

import (
	"context"
	cryptorand "crypto/rand"
	"crypto/rsa"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
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
	"ressarcimento-backend/utils"
)

// ─── Configuração (lida do ambiente — mesmo app do Graph) ────────────────────

func msTenant() string       { return strings.TrimSpace(os.Getenv("AZURE_TENANT_ID")) }
func msClientID() string     { return strings.TrimSpace(os.Getenv("AZURE_CLIENT_ID")) }
func msClientSecret() string { return strings.TrimSpace(os.Getenv("AZURE_CLIENT_SECRET")) }

// msEnabled: o login Microsoft só liga se as 3 variáveis do Azure estiverem
// presentes E o flag explícito MS_LOGIN_ENABLED=true. O flag evita que o botão
// apareça só porque o Graph (leitura de e-mail) usa as mesmas AZURE_*: o login
// de usuário exige um redirect URI registrado no Azure, que é um passo à parte.
func msEnabled() bool {
	flag := strings.EqualFold(strings.TrimSpace(os.Getenv("MS_LOGIN_ENABLED")), "true")
	return flag && msTenant() != "" && msClientID() != "" && msClientSecret() != ""
}

// frontBase: para onde mandar o usuário depois (default "/"). Pode ser sobrescrito
// por APP_BASE_URL, mas normalmente é só o path "/".
func sanitizeReturn(p string) string {
	p = strings.TrimSpace(p)
	if p == "" || !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") {
		return "/"
	}
	return p
}

// msRedirectURI: a URI de retorno registrada no Azure. Por padrão é derivada do
// host da requisição; pode ser fixada com AZURE_LOGIN_REDIRECT.
func msRedirectURI(c *gin.Context) string {
	if v := strings.TrimSpace(os.Getenv("AZURE_LOGIN_REDIRECT")); v != "" {
		return v
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
	return scheme + "://" + c.Request.Host + "/api/v2/auth/microsoft/callback"
}

// ─── Metadados OIDC (issuer, jwks_uri, endpoints) com cache ──────────────────

type oidcMeta struct {
	Issuer        string `json:"issuer"`
	JwksURI       string `json:"jwks_uri"`
	TokenEndpoint string `json:"token_endpoint"`
	AuthEndpoint  string `json:"authorization_endpoint"`
}

var (
	oidcMu    sync.Mutex
	oidcCache *oidcMeta
	oidcAt    time.Time
)

func getOIDC() (*oidcMeta, error) {
	oidcMu.Lock()
	defer oidcMu.Unlock()
	if oidcCache != nil && time.Since(oidcAt) < time.Hour {
		return oidcCache, nil
	}
	cfgURL := "https://login.microsoftonline.com/" + url.PathEscape(msTenant()) + "/v2.0/.well-known/openid-configuration"
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, cfgURL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("openid-configuration status %d", resp.StatusCode)
	}
	var m oidcMeta
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return nil, err
	}
	if m.Issuer == "" || m.JwksURI == "" || m.TokenEndpoint == "" || m.AuthEndpoint == "" {
		return nil, errors.New("openid-configuration incompleto")
	}
	oidcCache, oidcAt = &m, time.Now()
	return oidcCache, nil
}

// ─── JWKS (chaves públicas da Microsoft) com cache ───────────────────────────

type jwkKey struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	N   string `json:"n"`
	E   string `json:"e"`
}
type jwksDoc struct {
	Keys []jwkKey `json:"keys"`
}

var (
	jwksMu    sync.Mutex
	jwksCache map[string]*rsa.PublicKey
	jwksAt    time.Time
)

func fetchJWKS() error {
	meta, err := getOIDC()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, meta.JwksURI, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("jwks status %d", resp.StatusCode)
	}
	var doc jwksDoc
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return err
	}
	m := make(map[string]*rsa.PublicKey, len(doc.Keys))
	for _, k := range doc.Keys {
		if !strings.EqualFold(k.Kty, "RSA") || k.Kid == "" {
			continue
		}
		pk, err := jwkToRSA(k)
		if err != nil {
			continue
		}
		m[k.Kid] = pk
	}
	if len(m) == 0 {
		return errors.New("jwks sem chaves RSA utilizáveis")
	}
	jwksCache, jwksAt = m, time.Now()
	return nil
}

func jwkToRSA(k jwkKey) (*rsa.PublicKey, error) {
	nb, err := base64.RawURLEncoding.DecodeString(k.N)
	if err != nil {
		return nil, err
	}
	eb, err := base64.RawURLEncoding.DecodeString(k.E)
	if err != nil {
		return nil, err
	}
	n := new(big.Int).SetBytes(nb)
	e := 0
	for _, b := range eb {
		e = e<<8 | int(b)
	}
	if e == 0 {
		return nil, errors.New("expoente inválido")
	}
	return &rsa.PublicKey{N: n, E: e}, nil
}

// keyForKid devolve a chave pública do kid; recarrega o JWKS uma vez se o kid
// for desconhecido (rotação de chaves) ou se o cache expirou (>12h).
func keyForKid(kid string) (*rsa.PublicKey, error) {
	jwksMu.Lock()
	defer jwksMu.Unlock()
	if jwksCache == nil || time.Since(jwksAt) > 12*time.Hour {
		if err := fetchJWKS(); err != nil {
			return nil, err
		}
	}
	if pk, ok := jwksCache[kid]; ok {
		return pk, nil
	}
	// kid desconhecido → tenta recarregar uma vez
	if err := fetchJWKS(); err != nil {
		return nil, err
	}
	if pk, ok := jwksCache[kid]; ok {
		return pk, nil
	}
	return nil, fmt.Errorf("kid %q não encontrado no JWKS", kid)
}

// ─── Verificação do id_token ─────────────────────────────────────────────────

type msIdentity struct {
	OID   string
	Email string
	Name  string
	TID   string
}

func verifyIDToken(idToken, expectedNonce string) (*msIdentity, error) {
	meta, err := getOIDC()
	if err != nil {
		return nil, err
	}
	claims := jwt.MapClaims{}
	_, err = jwt.ParseWithClaims(idToken, claims, func(t *jwt.Token) (interface{}, error) {
		kid, _ := t.Header["kid"].(string)
		if kid == "" {
			return nil, errors.New("id_token sem kid")
		}
		return keyForKid(kid)
	},
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(meta.Issuer),
		jwt.WithAudience(msClientID()),
	)
	if err != nil {
		return nil, err
	}

	// nonce precisa bater com o enviado no /start
	if n, _ := claims["nonce"].(string); expectedNonce != "" && n != expectedNonce {
		return nil, errors.New("nonce não confere")
	}

	// tenant: se AZURE_TENANT_ID for um GUID, exige tid igual (bloqueia contas de fora)
	tid, _ := claims["tid"].(string)
	if t := msTenant(); looksLikeGUID(t) && !strings.EqualFold(tid, t) {
		return nil, errors.New("tenant do token não confere")
	}

	email := firstNonEmpty(
		strClaim(claims, "preferred_username"),
		strClaim(claims, "email"),
		strClaim(claims, "upn"),
	)
	email = strings.ToLower(strings.TrimSpace(email))
	oid := strClaim(claims, "oid")
	if oid == "" {
		return nil, errors.New("id_token sem oid")
	}
	return &msIdentity{
		OID:   oid,
		Email: email,
		Name:  strings.TrimSpace(strClaim(claims, "name")),
		TID:   tid,
	}, nil
}

func strClaim(m jwt.MapClaims, k string) string {
	if v, ok := m[k].(string); ok {
		return v
	}
	return ""
}
func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
func looksLikeGUID(s string) bool {
	s = strings.TrimSpace(s)
	return len(s) == 36 && strings.Count(s, "-") == 4
}

// ─── Estado assinado (CSRF + nonce + mode) ───────────────────────────────────

const msStateTyp = "ms_oauth"

func signState(nonce, mode, returnTo string) (string, error) {
	claims := jwt.MapClaims{
		"typ":   msStateTyp,
		"nonce": nonce,
		"mode":  mode,
		"ret":   returnTo,
		"iat":   time.Now().Unix(),
		"exp":   time.Now().Add(10 * time.Minute).Unix(),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(auth.JwtKey)
}

func parseState(s string) (nonce, mode, returnTo string, err error) {
	claims := jwt.MapClaims{}
	_, err = jwt.ParseWithClaims(s, claims, func(t *jwt.Token) (interface{}, error) {
		return auth.JwtKey, nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil {
		return "", "", "", err
	}
	if strClaim(claims, "typ") != msStateTyp {
		return "", "", "", errors.New("state typ inválido")
	}
	return strClaim(claims, "nonce"), strClaim(claims, "mode"), strClaim(claims, "ret"), nil
}

func randToken() string {
	b := make([]byte, 24)
	if _, err := cryptorand.Read(b); err != nil {
		// fallback improvável — ainda assim único o bastante p/ nonce curto
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// ─── Troca do authorization code pelo token ──────────────────────────────────

type tokenResp struct {
	IDToken          string `json:"id_token"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

func exchangeCode(code, redirectURI string) (*tokenResp, error) {
	meta, err := getOIDC()
	if err != nil {
		return nil, err
	}
	form := url.Values{}
	form.Set("client_id", msClientID())
	form.Set("client_secret", msClientSecret())
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	form.Set("scope", "openid profile email")

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, meta.TokenEndpoint, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var tr tokenResp
	_ = json.Unmarshal(body, &tr)
	if tr.Error != "" {
		return &tr, fmt.Errorf("token endpoint: %s", tr.Error)
	}
	if resp.StatusCode != http.StatusOK || tr.IDToken == "" {
		return &tr, fmt.Errorf("token endpoint status %d", resp.StatusCode)
	}
	return &tr, nil
}

// ─── Sessão da aplicação (mesmo JWT/cookie do Login) ─────────────────────────

func issueAppSession(c *gin.Context, userID int64, nome, email, perfil string) (string, error) {
	role := strings.ToLower(strings.TrimSpace(perfil))
	if role == "" {
		role = "solicitante"
	}
	userName := strings.TrimSpace(nome)
	if userName == "" {
		userName = email
	}
	exp := time.Now().Add(24 * time.Hour)
	claims := &auth.Claims{
		UserID:    userID,
		TipoConta: role,
		Nome:      nome,
		UserName:  userName,
		Email:     email,
		Role:      role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(exp),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
		},
	}
	tokenStr, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(auth.JwtKey)
	if err != nil {
		return "", err
	}
	cookieSecure := os.Getenv("COOKIE_SECURE") == "true"
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie("auth_token", tokenStr, int(time.Until(exp).Seconds()), "/", "", cookieSecure, true)
	return tokenStr, nil
}

func userIDFromCookie(c *gin.Context) (int64, bool) {
	ck, err := c.Cookie("auth_token")
	if err != nil || strings.TrimSpace(ck) == "" {
		return 0, false
	}
	claims := &auth.Claims{}
	tok, err := jwt.ParseWithClaims(ck, claims, func(t *jwt.Token) (interface{}, error) {
		return auth.JwtKey, nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil || !tok.Valid {
		return 0, false
	}
	return claims.UserID, true
}

// redirectFront manda o usuário de volta ao front, anexando um fragmento (#...).
func redirectFront(c *gin.Context, path, fragment string) {
	u := sanitizeReturn(path)
	if fragment != "" {
		u += "#" + fragment
	}
	c.Redirect(http.StatusFound, u)
}

func clearStateCookie(c *gin.Context) {
	cookieSecure := os.Getenv("COOKIE_SECURE") == "true"
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie("ms_oauth", "", -1, "/", "", cookieSecure, true)
}

// ─── Handlers ────────────────────────────────────────────────────────────────

// MicrosoftConfig — GET /auth/microsoft/config
// Diz ao front se o botão "Entrar com Microsoft" deve aparecer.
func MicrosoftConfig(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"enabled": msEnabled()})
}

// MicrosoftStart — GET /auth/microsoft/start?mode=login|link&redirect=/
// Monta o estado assinado, grava cookie e redireciona para a Microsoft.
func MicrosoftStart(c *gin.Context) {
	if !msEnabled() {
		redirectFront(c, "/login", "ms=desativado")
		return
	}
	mode := c.Query("mode")
	if mode != "link" {
		mode = "login"
	}
	returnTo := sanitizeReturn(c.Query("redirect"))
	if returnTo == "/" && mode == "link" {
		returnTo = "/conta"
	}

	nonce := randToken()
	state, err := signState(nonce, mode, returnTo)
	if err != nil {
		redirectFront(c, "/login", "ms=erro")
		return
	}

	meta, err := getOIDC()
	if err != nil {
		log.Printf("[ms-login] falha ao obter openid-config: %v", err)
		redirectFront(c, "/login", "ms=erro")
		return
	}

	// cookie com o state (checado no callback — proteção CSRF)
	cookieSecure := os.Getenv("COOKIE_SECURE") == "true"
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie("ms_oauth", state, 600, "/", "", cookieSecure, true)

	q := url.Values{}
	q.Set("client_id", msClientID())
	q.Set("response_type", "code")
	q.Set("redirect_uri", msRedirectURI(c))
	q.Set("response_mode", "query")
	q.Set("scope", "openid profile email")
	q.Set("state", state)
	q.Set("nonce", nonce)
	if mode == "login" {
		q.Set("prompt", "select_account")
	}
	c.Redirect(http.StatusFound, meta.AuthEndpoint+"?"+q.Encode())
}

// MicrosoftCallback — GET /auth/microsoft/callback
func MicrosoftCallback(c *gin.Context) {
	if !msEnabled() {
		redirectFront(c, "/login", "ms=desativado")
		return
	}
	defer clearStateCookie(c)

	// erro vindo da Microsoft
	if e := c.Query("error"); e != "" {
		log.Printf("[ms-login] erro do provedor: %s — %s", e, c.Query("error_description"))
		redirectFront(c, "/login", "ms=erro")
		return
	}

	// CSRF: state do parâmetro precisa bater com o cookie
	stateParam := c.Query("state")
	stateCookie, _ := c.Cookie("ms_oauth")
	if stateParam == "" || stateCookie == "" || stateParam != stateCookie {
		redirectFront(c, "/login", "ms=estado")
		return
	}
	nonce, mode, returnTo, err := parseState(stateParam)
	if err != nil {
		redirectFront(c, "/login", "ms=estado")
		return
	}
	returnTo = sanitizeReturn(returnTo)

	code := c.Query("code")
	if code == "" {
		redirectFront(c, "/login", "ms=erro")
		return
	}

	tr, err := exchangeCode(code, msRedirectURI(c))
	if err != nil {
		log.Printf("[ms-login] troca de código falhou: %v", err)
		redirectFront(c, "/login", "ms=erro")
		return
	}

	id, err := verifyIDToken(tr.IDToken, nonce)
	if err != nil {
		log.Printf("[ms-login] id_token inválido: %v", err)
		redirectFront(c, "/login", "ms=erro")
		return
	}
	if id.Email == "" {
		redirectFront(c, "/login", "ms=sememail")
		return
	}
	// só domínios corporativos autorizados (mesma regra do auto-registro)
	if !utils.EmailDomainAllowed(id.Email) {
		log.Printf("[ms-login] domínio não autorizado: %s", id.Email)
		redirectFront(c, "/login", "ms=dominio")
		return
	}

	db := database.DB_V2
	if db == nil {
		redirectFront(c, "/login", "ms=db")
		return
	}

	if mode == "link" {
		msLink(c, db, id, returnTo)
		return
	}
	msLogin(c, db, id, returnTo)
}

// msLogin acha o usuário (por ms_oid → e-mail) ou cria (auto-provisionamento),
// emite a sessão e volta pro front com o token no fragmento.
func msLogin(c *gin.Context, db *sql.DB, id *msIdentity, returnTo string) {
	ctx := c.Request.Context()

	var (
		userID int64
		nome   string
		perfil string
		ativo  int
	)

	// 1) por ms_oid
	err := db.QueryRowContext(ctx, `
SELECT id_usuario, nome_usuario, perfil, usuario_ativo
  FROM DM_USUARIO WHERE ms_oid = ? LIMIT 1`, id.OID).Scan(&userID, &nome, &perfil, &ativo)

	if errors.Is(err, sql.ErrNoRows) {
		// 2) por e-mail — vincula o ms_oid se achar
		var msOID sql.NullString
		err = db.QueryRowContext(ctx, `
SELECT id_usuario, nome_usuario, perfil, usuario_ativo, ms_oid
  FROM DM_USUARIO WHERE LOWER(email) = ? LIMIT 1`, id.Email).Scan(&userID, &nome, &perfil, &ativo, &msOID)
		if err == nil && !msOID.Valid {
			if _, e := db.ExecContext(ctx,
				`UPDATE DM_USUARIO SET ms_oid = ?, ms_email = ? WHERE id_usuario = ?`,
				id.OID, id.Email, userID); e != nil {
				log.Printf("[ms-login] falha ao vincular ms_oid ao usuário %d: %v", userID, e)
			}
		}
	}

	if errors.Is(err, sql.ErrNoRows) {
		// 3) auto-provisionamento — cria usuário novo (sem senha; entra só por Microsoft)
		nome = firstNonEmpty(id.Name, emailLocalPart(id.Email))
		res, e := db.ExecContext(ctx, `
INSERT INTO DM_USUARIO (nome_usuario, email, senha_hash, id_departamento, perfil, usuario_ativo, ms_oid, ms_email)
VALUES (?, ?, NULL, NULL, 'solicitante', 1, ?, ?)`,
			nome, id.Email, id.OID, id.Email)
		if e != nil {
			log.Printf("[ms-login] falha ao criar usuário %s: %v", id.Email, e)
			redirectFront(c, "/login", "ms=db")
			return
		}
		userID, _ = res.LastInsertId()
		perfil, ativo = "solicitante", 1
		log.Printf("[ms-login] novo usuário criado via Microsoft: %s (id %d)", id.Email, userID)
	} else if err != nil {
		log.Printf("[ms-login] erro de DB: %v", err)
		redirectFront(c, "/login", "ms=db")
		return
	}

	if ativo != 1 {
		redirectFront(c, "/login", "ms=inativo")
		return
	}

	token, err := issueAppSession(c, userID, nome, id.Email, perfil)
	if err != nil {
		redirectFront(c, "/login", "ms=erro")
		return
	}
	redirectFront(c, returnTo, "mstoken="+token)
}

// msLink vincula o ms_oid à conta já logada (cookie auth_token).
func msLink(c *gin.Context, db *sql.DB, id *msIdentity, returnTo string) {
	ctx := c.Request.Context()
	currentUser, ok := userIDFromCookie(c)
	if !ok {
		redirectFront(c, "/login", "ms=sessao")
		return
	}

	// o ms_oid já pode estar vinculado a OUTRA conta?
	var owner int64
	err := db.QueryRowContext(ctx, `SELECT id_usuario FROM DM_USUARIO WHERE ms_oid = ? LIMIT 1`, id.OID).Scan(&owner)
	if err == nil && owner != currentUser {
		redirectFront(c, returnTo, "mslink=ja_vinculado")
		return
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		redirectFront(c, returnTo, "mslink=erro")
		return
	}

	if _, e := db.ExecContext(ctx,
		`UPDATE DM_USUARIO SET ms_oid = ?, ms_email = ? WHERE id_usuario = ?`,
		id.OID, id.Email, currentUser); e != nil {
		log.Printf("[ms-login] falha ao vincular conta %d: %v", currentUser, e)
		redirectFront(c, returnTo, "mslink=erro")
		return
	}
	redirectFront(c, returnTo, "mslink=ok")
}

func emailLocalPart(email string) string {
	if i := strings.IndexByte(email, '@'); i > 0 {
		return email[:i]
	}
	return email
}
