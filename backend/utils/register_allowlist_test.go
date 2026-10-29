package utils

import "testing"

// P2-6: garante que o auto-registro só aceita domínios corporativos autorizados.
func TestEmailDomainAllowed(t *testing.T) {
	tests := []struct {
		name  string
		env   string // valor de REGISTER_ALLOWED_DOMAINS ("" = default amee.com.br)
		email string
		want  bool
	}{
		{"default amee permitido", "", "joao@amee.com.br", true},
		{"default amee maiusculo", "", "JOAO@AMEE.COM.BR", true},
		{"default gmail bloqueado", "", "joao@gmail.com", false},
		{"default subdominio nao casa", "", "joao@sub.amee.com.br", false},
		{"default sem arroba", "", "joaoamee.com.br", false},
		{"default arroba no fim", "", "joao@", false},
		{"default string vazia", "", "", false},
		{"default espaco no dominio", "", "joao@amee.com.br ", true},
		{"wildcard libera tudo", "*", "qualquer@dominio.xyz", true},
		{"custom multiplos - listado", "amee.com.br,parceiro.com", "x@parceiro.com", true},
		{"custom multiplos - nao listado", "amee.com.br,parceiro.com", "x@outro.com", false},
		{"custom com espacos", " amee.com.br , parceiro.com ", "x@parceiro.com", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("REGISTER_ALLOWED_DOMAINS", tt.env)
			if got := EmailDomainAllowed(tt.email); got != tt.want {
				t.Errorf("EmailDomainAllowed(%q) [env=%q] = %v; quer %v", tt.email, tt.env, got, tt.want)
			}
		})
	}
}
