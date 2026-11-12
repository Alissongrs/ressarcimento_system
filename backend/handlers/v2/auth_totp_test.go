package v2

import (
	"database/sql"
	"encoding/json"
	"testing"
	"time"
)

// Vetores oficiais da RFC 6238 (apêndice B) para SHA-1, segredo "12345678901234567890".
const rfcSegredoB32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

func TestTOTPVetoresRFC6238(t *testing.T) {
	casos := []struct {
		unix int64
		want string
	}{
		{59, "287082"}, // a RFC lista 8 dígitos (94287082); os 6 últimos são o código de 6 dígitos
		{1111111109, "081804"},
		{1111111111, "050471"},
		{1234567890, "005924"},
		{2000000000, "279037"},
		{20000000000, "353130"},
	}
	for _, c := range casos {
		got, err := hotp(rfcSegredoB32, c.unix/totpPeriodo)
		if err != nil {
			t.Fatalf("t=%d: %v", c.unix, err)
		}
		if got != c.want {
			t.Errorf("t=%d: código %s; quer %s", c.unix, got, c.want)
		}
	}
}

func TestValidarTOTPJanelaEFormato(t *testing.T) {
	agora := time.Unix(1111111111, 0)
	if p := validarTOTP(rfcSegredoB32, "050471", agora); p != 1111111111/totpPeriodo {
		t.Errorf("código do passo atual: passo %d", p)
	}
	// passo anterior (t=1111111109 cai no passo anterior) ainda vale, por causa da janela
	if p := validarTOTP(rfcSegredoB32, "081804", agora); p != 1111111109/totpPeriodo {
		t.Errorf("código do passo anterior deveria valer: passo %d", p)
	}
	if p := validarTOTP(rfcSegredoB32, "050 471", agora); p < 0 {
		t.Errorf("espaço no meio deveria ser ignorado")
	}
	for _, ruim := range []string{"", "05047", "0504711", "abcdef", "000000"} {
		if p := validarTOTP(rfcSegredoB32, ruim, agora); p >= 0 {
			t.Errorf("%q não deveria validar", ruim)
		}
	}
	// dois passos atrás não vale
	if p := validarTOTP(rfcSegredoB32, "050471", agora.Add(2*totpPeriodo*time.Second)); p >= 0 {
		t.Errorf("código de 2 passos atrás não deveria valer")
	}
}

func TestCifrarDecifrarSegredo(t *testing.T) {
	seg, err := gerarSegredoTOTP()
	if err != nil || len(seg) != 32 {
		t.Fatalf("segredo: %q %v", seg, err)
	}
	c1, _ := cifrar(seg)
	c2, _ := cifrar(seg)
	if c1 == c2 {
		t.Errorf("duas cifras do mesmo segredo não podem ser iguais (nonce)")
	}
	if c1 == seg || len(c1) < len(seg) {
		t.Errorf("segredo não foi cifrado")
	}
	for _, c := range []string{c1, c2} {
		got, err := decifrar(c)
		if err != nil || got != seg {
			t.Errorf("decifrar: %q %v", got, err)
		}
	}
	if _, err := decifrar(c1[:len(c1)-4] + "AAAA"); err == nil {
		t.Errorf("cifra adulterada deveria falhar")
	}
}

func TestConferirCodigoReusoERecuperacao(t *testing.T) {
	cif, _ := cifrar(rfcSegredoB32)
	claros, hashes, err := gerarCodigosRecuperacao()
	if err != nil || len(claros) != totpRecupQtd {
		t.Fatalf("recuperação: %v", err)
	}
	hj, _ := json.Marshal(hashes)
	agora := time.Unix(1111111111, 0)
	e := &totpEstado{segredo: sql.NullString{String: cif, Valid: true}, recuperacao: sql.NullString{String: string(hj), Valid: true}}

	passo, _, ok := conferirCodigo(e, "050471", agora)
	if !ok || passo != 1111111111/totpPeriodo {
		t.Fatalf("código válido recusado (ok=%v passo=%d)", ok, passo)
	}
	// o mesmo código, depois de usado, não entra de novo
	e.ultimoPasso = sql.NullInt64{Int64: passo, Valid: true}
	if _, _, ok := conferirCodigo(e, "050471", agora); ok {
		t.Errorf("código reutilizado deveria ser recusado")
	}
	// o do passo anterior também não (é menor que o último usado)
	if _, _, ok := conferirCodigo(e, "081804", agora); ok {
		t.Errorf("código de passo anterior ao último usado deveria ser recusado")
	}
	// código de recuperação: entra uma vez e some da lista
	p, restantes, ok := conferirCodigo(e, claros[3], agora)
	if !ok || p != -1 || len(restantes) != totpRecupQtd-1 {
		t.Fatalf("recuperação: ok=%v p=%d restantes=%d", ok, p, len(restantes))
	}
	rj, _ := json.Marshal(restantes)
	e.recuperacao = sql.NullString{String: string(rj), Valid: true}
	if _, _, ok := conferirCodigo(e, claros[3], agora); ok {
		t.Errorf("código de recuperação usado não pode entrar de novo")
	}
	if _, _, ok := conferirCodigo(e, "XXXXX-XXXXX", agora); ok {
		t.Errorf("código de recuperação inventado não pode entrar")
	}
	// maiúsculas/espaços no código de recuperação são tolerados
	if _, _, ok := conferirCodigo(e, " "+toUpperASCII(claros[0])+" ", agora); !ok {
		t.Errorf("código de recuperação em maiúsculas deveria valer")
	}
}

func toUpperASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - 32
		}
	}
	return string(b)
}

func TestOtpauthURL(t *testing.T) {
	u := otpauthURL("ABC234", "alguem@amee.com.br")
	for _, parte := range []string{"otpauth://totp/SURE:alguem@amee.com.br", "secret=ABC234", "issuer=SURE", "digits=6", "period=30"} {
		if !contains(u, parte) {
			t.Errorf("otpauth sem %q: %s", parte, u)
		}
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
