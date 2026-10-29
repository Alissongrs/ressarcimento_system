package utils

import (
	"os"
	"strings"
)

// EmailDomainAllowed indica se o domínio do e-mail pode se auto-registrar (P2-6).
//
// Grupos corporativos do mesmo AD/tenant: por padrão os três domínios da casa
// (amee.com.br, thopenergy.com.br, acessoenergia.com.br) — os mesmos oferecidos
// no seletor da tela de cadastro. Configurável por REGISTER_ALLOWED_DOMAINS
// (domínios separados por vírgula), que SOBRESCREVE o default quando definido.
// Use "*" para liberar qualquer domínio (equivale ao registro público aberto).
func EmailDomainAllowed(email string) bool {
	raw := strings.TrimSpace(os.Getenv("REGISTER_ALLOWED_DOMAINS"))
	if raw == "" {
		raw = "amee.com.br,thopenergy.com.br,acessoenergia.com.br"
	}
	if raw == "*" {
		return true
	}
	at := strings.LastIndex(email, "@")
	if at < 0 || at == len(email)-1 {
		return false
	}
	dom := strings.ToLower(strings.TrimSpace(email[at+1:]))
	for _, d := range strings.Split(raw, ",") {
		if d = strings.ToLower(strings.TrimSpace(d)); d != "" && d == dom {
			return true
		}
	}
	return false
}
