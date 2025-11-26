package handlers

import "testing"

func Test_normalizeAndAppendCanais(t *testing.T) {
	sc, sn, canais, canalStr := normalizeAndAppendCanais("Validacao - Em elaboracao", nil, []string{" Email ", "whatsapp", "email", " ", "WhatsApp"})
	if canalStr != "email, whatsapp" {
		t.Fatalf("canalStr got %q", canalStr)
	}
	if len(canais) != 2 || canais[0] != "email" || canais[1] != "whatsapp" {
		t.Fatalf("canais got %#v", canais)
	}
	if sc != "Validacao - Em elaboracao via email, whatsapp" {
		t.Fatalf("status_composto got %q", sc)
	}
	if sn != nil {
		t.Fatalf("status_novo should remain nil when status_composto present")
	}
}

func Test_normalizeAndAppendCanais_FallbackStatusNovo(t *testing.T) {
	novo := "Distribuidora - Aguardando"
	sc, sn, canais, canalStr := normalizeAndAppendCanais("", &novo, []string{"sms", "SMS", "ligacao"})
	if canalStr != "ligacao, sms" {
		t.Fatalf("canalStr got %q", canalStr)
	}
	if len(canais) != 2 || canais[0] != "ligacao" || canais[1] != "sms" {
		t.Fatalf("canais got %#v", canais)
	}
	if sc != "" {
		t.Fatalf("status_composto should be empty, got %q", sc)
	}
	if sn == nil || *sn != "Distribuidora - Aguardando via ligacao, sms" {
		t.Fatalf("status_novo got %v", sn)
	}
}
