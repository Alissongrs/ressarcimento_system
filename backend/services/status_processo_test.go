package services

import (
	"database/sql"
	"testing"
	"time"
)

func TestSugerirDirecao(t *testing.T) {
	h := time.Date(2026, 6, 23, 11, 10, 0, 0, time.Local)
	casos := []struct {
		nome     string
		d        Divergencia
		quer     string
		quereMsg string
	}{
		{"processo mudou depois da movimentação → faltou histórico", Divergencia{FTData: h.Add(2 * time.Hour), HistData: h}, "historico", "faltou gravar"},
		{"movimentação mais nova → espelho atrasado", Divergencia{FTData: h.Add(-2 * time.Hour), HistData: h}, "processo", "ficou para trás"},
		{"mesmo instante (empate) → espelho atrasado", Divergencia{FTData: h, HistData: h}, "processo", "ficou para trás"},
		{"suspenso sempre registra no histórico", Divergencia{Suspenso: true, FTData: h.Add(-48 * time.Hour), HistData: h}, "historico", "suspenso"},
	}
	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			dir, motivo := sugerirDirecao(c.d)
			if dir != c.quer {
				t.Errorf("direção %q; quer %q", dir, c.quer)
			}
			if !contem(motivo, c.quereMsg) {
				t.Errorf("motivo %q não menciona %q", motivo, c.quereMsg)
			}
		})
	}
}

func contem(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// MudarStatusProcesso não grava nada quando o estado pedido é igual ao atual: a
// comparação campo a campo (ponteiro nil = manter; 0 = NULL) é o que garante isso.
func TestNullIntPtrEIguais(t *testing.T) {
	atual := sql.NullInt64{Int64: 3, Valid: true}
	if v := nullIntPtr(nil, atual); !iguais(v, atual) {
		t.Errorf("nil deveria manter o atual")
	}
	zero := 0
	if v := nullIntPtr(&zero, atual); v != nil || iguais(v, atual) {
		t.Errorf("0 deveria virar NULL e ser diferente de 3")
	}
	cinco := 5
	if v := nullIntPtr(&cinco, atual); iguais(v, atual) {
		t.Errorf("5 é diferente de 3")
	}
	if v := nullIntPtr(nil, sql.NullInt64{}); v != nil || !iguais(v, sql.NullInt64{}) {
		t.Errorf("nil com atual NULL continua NULL e igual")
	}
}
