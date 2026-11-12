package main

import "testing"

// O executor acha o percentual do cliente pelo NOME (DM_EMPRESA_PERCENTUAL.nome_empresa).
// Um casamento errado aplica o percentual de outra empresa no repasse.
func TestNormNome(t *testing.T) {
	tests := []struct{ in, want string }{
		{"Claro", "CLARO"},
		{"CLARO S.A.", "CLARO"},
		{"Claro S/A", "CLARO"},
		{"GGF AGRO LTDA", "GGF AGRO"},
		{"Coyote Alimentação Ltda.", "COYOTE ALIMENTACAO"},
		{"HOSPITAL ISRAELITA ALBERT EINSTEIN", "HOSPITAL ISRAELITA ALBERT EINSTEIN"},
		{"  Via   Varejo  ", "VIA VAREJO"},
		{"VIA S.A.", "VIA"},
		{"Oi", "OI"},
		{"LTDA", "LTDA"}, // nome só com sufixo não vira vazio
		{"", ""},
	}
	for _, tt := range tests {
		if got := normNome(tt.in); got != tt.want {
			t.Errorf("normNome(%q) = %q; quer %q", tt.in, got, tt.want)
		}
	}
}

func TestCasaNome(t *testing.T) {
	tests := []struct {
		a, b string
		want bool
	}{
		{"CLARO", "CLARO", true},
		{"CLARO NXT", "CLARO", true},    // cliente mais longo que o cadastro
		{"CLARO", "CLARO BRASIL", true}, // cadastro mais longo que o cliente
		{"VIA", "VIAVAREJO", false},     // prefixo sem espaço NÃO casa
		{"OI", "OI MOVEL", true},
		{"OI", "OIT", false},
		{"GGF AGRO", "GGF", true},
		{"BP BUNGE", "BUNGE", false}, // tem que começar igual
		{"", "CLARO", false},
	}
	for _, tt := range tests {
		if got := casaNome(tt.a, tt.b); got != tt.want {
			t.Errorf("casaNome(%q, %q) = %v; quer %v", tt.a, tt.b, got, tt.want)
		}
	}
}

// round2 é o arredondamento do repasse gravado pelo executor: meio centavo sobe.
func TestRound2(t *testing.T) {
	tests := []struct{ in, want float64 }{
		{19537.7125, 19537.71},
		{19537.715, 19537.72},
		{0.125, 0.13}, // meio centavo exato em binário sobe
		{0.004, 0},
		{-0.125, -0.13},
		{250, 250},
		{1356.16, 1356.16},
	}
	for _, tt := range tests {
		if got := round2(tt.in); got != tt.want {
			t.Errorf("round2(%v) = %v; quer %v", tt.in, got, tt.want)
		}
	}
}
