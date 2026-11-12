package v2

// ─────────────────────────────────────────────────────────────────────────────
// Login por CÓDIGO DO AUTENTICADOR (TOTP, RFC 6238) — alternativa ao link por
// e-mail, para quando o e-mail está fora do ar. Funciona com Microsoft
// Authenticator, Google Authenticator e qualquer app de código de 6 dígitos:
// o segredo fica no SURE (cifrado) e no celular; nada passa por e-mail.
//
// Fluxo:
//   1. Em Minha Conta, a pessoa clica "Ativar": o SURE gera um segredo
//      PENDENTE e mostra o QR code. Ela aponta o app e digita o 1º código.
//   2. Código certo → segredo vira ATIVO e a pessoa recebe 8 códigos de
//      recuperação (mostrados uma vez; guardamos só o hash).
//   3. Na tela de login, "Entrar com código do autenticador": e-mail + 6
//      dígitos (ou um código de recuperação) → sessão igual à do link.
//
// Proteções: código aceito uma única vez (guardamos o último passo usado),
// janela de ±30 s, 5 erros por e-mail a cada 5 min além do limite por IP,
// segredo cifrado com AES-GCM (chave derivada do JWT_SECRET) e nunca logado.
//
// Endpoints (sob /api/v2):
//   públicos:     POST /auth/totp/login            { email, codigo } → { token }
//   autenticados: GET  /auth/totp                  → { ativo, recuperacao_restantes }
//                 POST /auth/totp/iniciar          → { segredo, otpauth, qr }
//                 POST /auth/totp/confirmar        { codigo } → { ok, recuperacao: [...] }
//                 POST /auth/totp/desativar        { codigo } → { ok }
//                 POST /auth/totp/desativar/:id    (admin) → { ok }  — perdeu o celular
// ─────────────────────────────────────────────────────────────────────────────

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	cryptorand "crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	qrcode "github.com/skip2/go-qrcode"

	"ressarcimento-backend/auth"
	"ressarcimento-backend/utils"
)

const (
	totpEmissor  = "SURE"
	totpPeriodo  = 30 // segundos
	totpDigitos  = 6
	totpJanela   = 1 // aceita o passo anterior e o seguinte (relógio do celular adiantado/atrasado)
	totpRecupQtd = 8
)

// ── TOTP puro (RFC 6238 sobre HOTP RFC 4226, SHA-1, 6 dígitos) ─────────────

var totpBase32 = base32.StdEncoding.WithPadding(base32.NoPadding)

func gerarSegredoTOTP() (string, error) {
	b := make([]byte, 20)
	if _, err := cryptorand.Read(b); err != nil {
		return "", err
	}
	return totpBase32.EncodeToString(b), nil
}

// hotp calcula o código de 6 dígitos para um contador (passo de 30 s).
func hotp(segredoB32 string, contador int64) (string, error) {
	chave, err := totpBase32.DecodeString(strings.ToUpper(strings.TrimSpace(segredoB32)))
	if err != nil {
		return "", err
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(contador))
	mac := hmac.New(sha1.New, chave)
	mac.Write(msg[:])
	h := mac.Sum(nil)
	off := h[len(h)-1] & 0x0f
	bin := (int(h[off])&0x7f)<<24 | int(h[off+1])<<16 | int(h[off+2])<<8 | int(h[off+3])
	return fmt.Sprintf("%06d", bin%1000000), nil
}

func passoTOTP(t time.Time) int64 { return t.Unix() / totpPeriodo }

// validarTOTP confere o código nos passos [atual-janela, atual+janela] e devolve o
// passo em que bateu (para o bloqueio de reuso) ou -1.
func validarTOTP(segredoB32, codigo string, agora time.Time) int64 {
	codigo = strings.TrimSpace(strings.ReplaceAll(codigo, " ", ""))
	if len(codigo) != totpDigitos {
		return -1
	}
	base := passoTOTP(agora)
	for d := int64(-totpJanela); d <= totpJanela; d++ {
		esperado, err := hotp(segredoB32, base+d)
		if err != nil {
			return -1
		}
		if hmac.Equal([]byte(esperado), []byte(codigo)) {
			return base + d
		}
	}
	return -1
}

func otpauthURL(segredo, email string) string {
	return "otpauth://totp/" + url.PathEscape(totpEmissor+":"+email) +
		"?secret=" + segredo + "&issuer=" + url.QueryEscape(totpEmissor) +
		fmt.Sprintf("&algorithm=SHA1&digits=%d&period=%d", totpDigitos, totpPeriodo)
}

// ── Cifra do segredo em repouso (AES-GCM, chave derivada do JWT_SECRET) ─────

func totpChave() []byte {
	k := sha256.Sum256([]byte("sure-totp:" + string(auth.JwtKey)))
	return k[:]
}

func cifrar(texto string) (string, error) {
	blk, err := aes.NewCipher(totpChave())
	if err != nil {
		return "", err
	}
	g, err := cipher.NewGCM(blk)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, g.NonceSize())
	if _, err := cryptorand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(g.Seal(nonce, nonce, []byte(texto), nil)), nil
}

func decifrar(b64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", err
	}
	blk, err := aes.NewCipher(totpChave())
	if err != nil {
		return "", err
	}
	g, err := cipher.NewGCM(blk)
	if err != nil {
		return "", err
	}
	if len(raw) < g.NonceSize() {
		return "", errors.New("segredo curto")
	}
	out, err := g.Open(nil, raw[:g.NonceSize()], raw[g.NonceSize():], nil)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// ── Códigos de recuperação (10 caracteres "xxxxx-xxxxx"; guardamos só o sha256) ──

func gerarCodigosRecuperacao() ([]string, []string, error) {
	const alfabeto = "abcdefghjkmnpqrstuvwxyz23456789" // sem 0/o/1/l/i
	claros := make([]string, 0, totpRecupQtd)
	hashes := make([]string, 0, totpRecupQtd)
	for i := 0; i < totpRecupQtd; i++ {
		b := make([]byte, 10)
		if _, err := cryptorand.Read(b); err != nil {
			return nil, nil, err
		}
		s := make([]byte, 10)
		for j := range b {
			s[j] = alfabeto[int(b[j])%len(alfabeto)]
		}
		c := string(s[:5]) + "-" + string(s[5:])
		claros = append(claros, c)
		hashes = append(hashes, hashRecuperacao(c))
	}
	return claros, hashes, nil
}

func hashRecuperacao(c string) string {
	c = strings.ToLower(strings.TrimSpace(c))
	h := sha256.Sum256([]byte("sure-recup:" + c))
	return hex.EncodeToString(h[:])
}

// ── Limite de erros por e-mail (além do limite por IP do AuthRateLimit) ──────

var (
	totpErrosMu sync.Mutex
	totpErros   = map[string][]time.Time{} // e-mail → instantes dos erros nos últimos 5 min
)

func totpBloqueado(email string) bool {
	totpErrosMu.Lock()
	defer totpErrosMu.Unlock()
	corte := time.Now().Add(-5 * time.Minute)
	v := totpErros[email][:0]
	for _, t := range totpErros[email] {
		if t.After(corte) {
			v = append(v, t)
		}
	}
	totpErros[email] = v
	return len(v) >= 5
}

func totpRegistrarErro(email string) {
	totpErrosMu.Lock()
	totpErros[email] = append(totpErros[email], time.Now())
	totpErrosMu.Unlock()
}

// ── Handlers ────────────────────────────────────────────────────────────────

type totpEstado struct {
	id          int64
	email       string
	nome        string
	perfil      string
	ativoConta  int
	segredo     sql.NullString // cifrado
	pendente    sql.NullString // cifrado
	ativo       int
	ultimoPasso sql.NullInt64
	recuperacao sql.NullString // JSON []hash
}

func lerTOTP(c *gin.Context, db *sql.DB, where string, arg interface{}) (*totpEstado, error) {
	e := &totpEstado{}
	err := db.QueryRowContext(c.Request.Context(), `
SELECT id_usuario, LOWER(COALESCE(email,'')), COALESCE(nome_usuario,''), COALESCE(perfil,''), COALESCE(usuario_ativo,0),
       totp_segredo, totp_pendente, COALESCE(totp_ativo,0), totp_ultimo_passo, totp_recuperacao
  FROM DM_USUARIO WHERE `+where+` LIMIT 1`, arg).
		Scan(&e.id, &e.email, &e.nome, &e.perfil, &e.ativoConta, &e.segredo, &e.pendente, &e.ativo, &e.ultimoPasso, &e.recuperacao)
	if err != nil {
		return nil, err
	}
	return e, nil
}

func userIDDoContexto(c *gin.Context) (int64, bool) {
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

// TOTPStatus — GET /auth/totp
func TOTPStatus(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	uid, ok := userIDDoContexto(c)
	if !ok {
		apiError(c, http.StatusUnauthorized, "NAO_AUTENTICADO", "Token ausente ou inválido", nil)
		return
	}
	e, err := lerTOTP(c, db, "id_usuario = ?", uid)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	restantes := 0
	if e.recuperacao.Valid {
		var hs []string
		_ = json.Unmarshal([]byte(e.recuperacao.String), &hs)
		restantes = len(hs)
	}
	c.JSON(http.StatusOK, gin.H{"ativo": e.ativo == 1, "recuperacao_restantes": restantes, "pendente": e.pendente.Valid && e.pendente.String != ""})
}

// TOTPIniciar — POST /auth/totp/iniciar: gera o segredo pendente e o QR.
func TOTPIniciar(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	uid, ok := userIDDoContexto(c)
	if !ok {
		apiError(c, http.StatusUnauthorized, "NAO_AUTENTICADO", "Token ausente ou inválido", nil)
		return
	}
	e, err := lerTOTP(c, db, "id_usuario = ?", uid)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	segredo, err := gerarSegredoTOTP()
	if err != nil {
		apiError(c, http.StatusInternalServerError, "TOTP_ERR", "Não foi possível gerar o segredo.", nil)
		return
	}
	cif, err := cifrar(segredo)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "TOTP_ERR", "Não foi possível guardar o segredo.", nil)
		return
	}
	if _, err := db.ExecContext(c.Request.Context(), `UPDATE DM_USUARIO SET totp_pendente = ? WHERE id_usuario = ?`, cif, uid); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	uri := otpauthURL(segredo, e.email)
	png, err := qrcode.Encode(uri, qrcode.Medium, 280)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "TOTP_ERR", "Não foi possível gerar o QR code.", nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"segredo": segredo, // para digitar à mão no app, se a câmera não ler
		"otpauth": uri,
		"qr":      "data:image/png;base64," + base64.StdEncoding.EncodeToString(png),
		"conta":   totpEmissor + ":" + e.email,
	})
}

type totpCodigoReq struct {
	Codigo string `json:"codigo"`
}

// TOTPConfirmar — POST /auth/totp/confirmar: valida o 1º código, ativa e devolve os códigos de recuperação.
func TOTPConfirmar(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	uid, ok := userIDDoContexto(c)
	if !ok {
		apiError(c, http.StatusUnauthorized, "NAO_AUTENTICADO", "Token ausente ou inválido", nil)
		return
	}
	var in totpCodigoReq
	if !bindJSON(c, &in) {
		return
	}
	e, err := lerTOTP(c, db, "id_usuario = ?", uid)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	if !e.pendente.Valid || e.pendente.String == "" {
		apiError(c, http.StatusBadRequest, "TOTP_SEM_PENDENTE", "Clique em Ativar para gerar o QR code antes de confirmar.", nil)
		return
	}
	if totpBloqueado(e.email) {
		apiError(c, http.StatusTooManyRequests, "TOTP_BLOQUEADO", "Muitas tentativas. Aguarde 5 minutos.", nil)
		return
	}
	segredo, err := decifrar(e.pendente.String)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "TOTP_ERR", "Segredo pendente inválido; clique em Ativar de novo.", nil)
		return
	}
	passo := validarTOTP(segredo, in.Codigo, time.Now())
	if passo < 0 {
		totpRegistrarErro(e.email)
		apiError(c, http.StatusBadRequest, "TOTP_CODIGO_INVALIDO", "Código não confere. Confira o relógio do celular e tente o código seguinte.", nil)
		return
	}
	claros, hashes, err := gerarCodigosRecuperacao()
	if err != nil {
		apiError(c, http.StatusInternalServerError, "TOTP_ERR", "Não foi possível gerar os códigos de recuperação.", nil)
		return
	}
	hj, _ := json.Marshal(hashes)
	if _, err := db.ExecContext(c.Request.Context(), `
UPDATE DM_USUARIO
   SET totp_segredo = totp_pendente, totp_pendente = NULL, totp_ativo = 1,
       totp_ultimo_passo = ?, totp_recuperacao = ?
 WHERE id_usuario = ?`, passo, string(hj), uid); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	log.Printf("[totp] autenticador ativado para usuário %d", uid)
	c.JSON(http.StatusOK, gin.H{"ok": true, "recuperacao": claros})
}

// TOTPDesativar — POST /auth/totp/desativar: exige um código válido (ou de recuperação).
func TOTPDesativar(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	uid, ok := userIDDoContexto(c)
	if !ok {
		apiError(c, http.StatusUnauthorized, "NAO_AUTENTICADO", "Token ausente ou inválido", nil)
		return
	}
	var in totpCodigoReq
	if !bindJSON(c, &in) {
		return
	}
	e, err := lerTOTP(c, db, "id_usuario = ?", uid)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	if e.ativo != 1 {
		// só limpa um pendente que ficou pelo caminho
		_, _ = db.ExecContext(c.Request.Context(), `UPDATE DM_USUARIO SET totp_pendente = NULL WHERE id_usuario = ?`, uid)
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}
	if totpBloqueado(e.email) {
		apiError(c, http.StatusTooManyRequests, "TOTP_BLOQUEADO", "Muitas tentativas. Aguarde 5 minutos.", nil)
		return
	}
	if _, _, okCod := conferirCodigo(e, in.Codigo, time.Now()); !okCod {
		totpRegistrarErro(e.email)
		apiError(c, http.StatusBadRequest, "TOTP_CODIGO_INVALIDO", "Código não confere.", nil)
		return
	}
	if err := limparTOTP(c, db, uid); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	log.Printf("[totp] autenticador desativado pelo próprio usuário %d", uid)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// TOTPDesativarUsuario — POST /auth/totp/desativar/:id (admin): quem perdeu o celular e os códigos.
func TOTPDesativarUsuario(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	if adm, _ := c.Get("isAdmin"); adm != true {
		apiError(c, http.StatusForbidden, "SEM_PERMISSAO", "Só administradores podem desativar o autenticador de outra pessoa.", nil)
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}
	if err := limparTOTP(c, db, int64(id)); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	quem, _ := c.Get("userID")
	log.Printf("[totp] autenticador do usuário %d desativado pelo admin %v", id, quem)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func limparTOTP(c *gin.Context, db *sql.DB, uid int64) error {
	_, err := db.ExecContext(c.Request.Context(), `
UPDATE DM_USUARIO
   SET totp_segredo = NULL, totp_pendente = NULL, totp_ativo = 0, totp_ultimo_passo = NULL, totp_recuperacao = NULL
 WHERE id_usuario = ?`, uid)
	return err
}

// conferirCodigo aceita o código do app (devolve o passo) ou um código de recuperação
// (devolve a lista de hashes já sem ele). ok=false quando nada confere.
func conferirCodigo(e *totpEstado, codigo string, agora time.Time) (passo int64, restantes []string, ok bool) {
	codigo = strings.TrimSpace(codigo)
	if e.segredo.Valid && e.segredo.String != "" {
		if segredo, err := decifrar(e.segredo.String); err == nil {
			if p := validarTOTP(segredo, codigo, agora); p >= 0 {
				if e.ultimoPasso.Valid && p <= e.ultimoPasso.Int64 {
					return -1, nil, false // código já usado (reuso)
				}
				return p, nil, true
			}
		}
	}
	if len(codigo) >= 10 && e.recuperacao.Valid {
		var hs []string
		if json.Unmarshal([]byte(e.recuperacao.String), &hs) == nil {
			h := hashRecuperacao(strings.ReplaceAll(codigo, " ", ""))
			for i, x := range hs {
				if hmac.Equal([]byte(x), []byte(h)) {
					return -1, append(append([]string{}, hs[:i]...), hs[i+1:]...), true
				}
			}
		}
	}
	return -1, nil, false
}

type totpLoginReq struct {
	Email  string `json:"email"`
	Codigo string `json:"codigo"`
}

// TOTPLogin — POST /auth/totp/login (público): e-mail + código → sessão.
// Resposta de erro sempre igual, para não revelar quem tem autenticador.
func TOTPLogin(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	var in totpLoginReq
	if !bindJSON(c, &in) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	falha := func() {
		totpRegistrarErro(email)
		apiError(c, http.StatusUnauthorized, "TOTP_CODIGO_INVALIDO", "E-mail ou código inválido.", nil)
	}
	if email == "" || !utils.EmailDomainAllowed(email) {
		falha()
		return
	}
	if totpBloqueado(email) {
		apiError(c, http.StatusTooManyRequests, "TOTP_BLOQUEADO", "Muitas tentativas. Aguarde 5 minutos e tente de novo.", nil)
		return
	}
	e, err := lerTOTP(c, db, "LOWER(email) = ?", email)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (e.ativo != 1 || e.ativoConta != 1)) {
		falha()
		return
	}
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	passo, restantes, ok := conferirCodigo(e, in.Codigo, time.Now())
	if !ok {
		falha()
		return
	}
	if passo >= 0 {
		// marca o passo usado: o mesmo código não entra duas vezes
		res, err := db.ExecContext(c.Request.Context(),
			`UPDATE DM_USUARIO SET totp_ultimo_passo = ? WHERE id_usuario = ? AND (totp_ultimo_passo IS NULL OR totp_ultimo_passo < ?)`,
			passo, e.id, passo)
		if n, _ := res.RowsAffected(); err != nil || n != 1 {
			falha()
			return
		}
	} else {
		hj, _ := json.Marshal(restantes)
		if _, err := db.ExecContext(c.Request.Context(), `UPDATE DM_USUARIO SET totp_recuperacao = ? WHERE id_usuario = ?`, string(hj), e.id); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
			return
		}
		log.Printf("[totp] usuário %d entrou com código de recuperação (%d restantes)", e.id, len(restantes))
	}
	nome := e.nome
	if strings.TrimSpace(nome) == "" {
		nome = emailLocalPart(email)
	}
	token, err := issueAppSession(c, e.id, nome, email, e.perfil)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "TOKEN_ERR", "Erro ao gerar sessão", nil)
		return
	}
	log.Printf("[totp] login por autenticador: %s", email)
	c.JSON(http.StatusOK, gin.H{"token": token, "recuperacao_usada": passo < 0, "recuperacao_restantes": len(restantes)})
}
