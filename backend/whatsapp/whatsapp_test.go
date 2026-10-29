package whatsapp

import (
	"os"
	"testing"
)

func TestNormalizarCelular(t *testing.T) {
	casos := map[string]string{
		"(15) 99747-7277":   "5515997477277",
		"+55 15 99747-7277": "5515997477277",
		"1533183770":        "551533183770",
		"12345":             "",
	}
	for in, want := range casos {
		if got := NormalizarCelular(in); got != want {
			t.Errorf("NormalizarCelular(%q) = %q, quero %q", in, got, want)
		}
	}
}

// A sessão abre no SQLite puro-Go (o binário é CGO_ENABLED=0) e fica esperando o QR code.
func TestIniciarSemAparelho(t *testing.T) {
	dir, err := os.MkdirTemp("", "wa-sessao-") // sem limpeza automática: no Windows o SQLite segura o arquivo
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("WHATSAPP_DIR", dir)
	Iniciar()
	e := ObterEstado()
	if !e.Ligado || e.Erro != "" || e.Vinculado || e.Conectado {
		t.Fatalf("estado inesperado: %+v", e)
	}
}
