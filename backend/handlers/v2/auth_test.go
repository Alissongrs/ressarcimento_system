package v2

import "testing"

func TestIsBcryptHash(t *testing.T) {
	cases := map[string]bool{
		"$2a$12$abcdefghijklmnopqrstuv": true,
		"$2b$10$abcdefghijklmnopqrstuv": true,
		"$2y$12$abcdefghijklmnopqrstuv": true,
		"deadbeefdeadbeef":             false, // hash SHA256 legado (hex)
		"":                             false,
		"$1$md5$xxxxxxxx":              false,
	}
	for h, want := range cases {
		if got := isBcryptHash(h); got != want {
			t.Errorf("isBcryptHash(%q) = %v; quer %v", h, got, want)
		}
	}
}

func TestSHA256LegacyDeterministico(t *testing.T) {
	a := hashPasswordSHA256Legacy("minhaSenha")
	b := hashPasswordSHA256Legacy("minhaSenha")
	if a != b {
		t.Errorf("hash legado não determinístico: %q != %q", a, b)
	}
	if len(a) != 64 { // SHA256 hex = 64 chars
		t.Errorf("hash SHA256 deveria ter 64 chars, tem %d", len(a))
	}
	if hashPasswordSHA256Legacy("outra") == a {
		t.Error("senhas diferentes geraram o mesmo hash")
	}
}

func TestBcryptRoundtrip(t *testing.T) {
	hash, err := hashPasswordBcrypt("S3nh@Forte!")
	if err != nil {
		t.Fatalf("erro ao gerar hash: %v", err)
	}
	if !isBcryptHash(hash) {
		t.Error("hash gerado não é reconhecido como bcrypt")
	}
	if !verifyPasswordBcrypt("S3nh@Forte!", hash) {
		t.Error("senha correta deveria validar")
	}
	if verifyPasswordBcrypt("senhaErrada", hash) {
		t.Error("senha errada NÃO deveria validar")
	}
}
