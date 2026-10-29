package protocolos

import "testing"

func TestRotuloSite(t *testing.T) {
	casos := map[string]string{
		"CONCLUÍDA":                    SitConcluidaSite,
		" concluída ":                  SitConcluidaSite,
		"EM ANÁLISE NA CONCESSIONÁRIA": SitAnaliseDistribuid,
		"EM ANÁLISE NA AGÊNCIA":        SitAnaliseANEEL,
		"SOLICITAÇÃO REGISTRADA":       SitRegistrado,
		"":                             "",
	}
	for in, want := range casos {
		if got := RotuloSite(in); got != want {
			t.Errorf("RotuloSite(%q) = %q, quer %q", in, got, want)
		}
	}
}
