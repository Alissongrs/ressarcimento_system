package empresas

import (
	"context"
	"testing"
	"time"
)

func TestCanonico(t *testing.T) {
	nomes := map[int64]string{1014: "CLARO", 1042: "VIA S.A.", 1038: "SER EDUCACIONAL S.A.", 1021: "HAPVIDA ASSISTENCIA MEDICA S.A.",
		1032: "OI", 1018: "FERNANDO MAGALHÃES", 1022: "HOSPITAL ISRAELITA ALBERT EINSTEIN", 1027: "MAGAZINE LUIZA S/A", 1002: "ACER",
		1007: "ASSOCIACAO DE COMPARTILHAMENTO DE ENERGIA RENOVAVEL - ACER"}
	cache = nil
	for c, n := range nomes {
		cache = append(cache, empresa{c, n, Tokens(n)})
	}
	cacheEm = time.Now()
	casos := map[string]int64{"CLARO SA": 1014, "Claro": 1014, "CLARO S/A": 1014, "VIA SA": 1042, "VIA VAREJO S/A": 1042,
		"SER EDUCACIONAL": 1038, "SER EDUCACIONAL S A": 1038, "HAPVIDA ASSISTÊNCIA MÉDICA S.A.": 1021, "Fernando Magalhães": 1018,
		"MAGAZINE LUIZA SA": 1027, "ACER": 1002, "OI S.A. EM RECUPERACAO JUDICIAL": 1032,
		"VTAL REDE NEUTRA DE TELECOMUNICACOES S.A.": 0, "FARMA PONTE": 0, "TELECOMUNICACOES S.A.": 0, "OIL TECH": 0, "VIA ITALIA RESTAURANTE": 0, "OI EM RECUPERACAO JUDICIAL": 1032}
	for in, quer := range casos {
		cod, nome, ok := Canonico(context.Background(), nil, in)
		_ = nome
		if quer == 0 && ok || quer != 0 && cod != quer {
			t.Errorf("%q → %d %q %v, quer %d", in, cod, nome, ok, quer)
		}
	}
}
