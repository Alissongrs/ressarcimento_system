package protocolos

import (
	"strings"
	"testing"
	"time"
)

func TestTravaVence(t *testing.T) {
	a, err := pegarTrava("teste")
	if err != nil {
		t.Fatal(err)
	}
	etapa(a, "lendo a caixa")
	if _, err := pegarTrava("outra"); err == nil || !strings.Contains(err.Error(), "lendo a caixa") {
		t.Fatalf("devia recusar dizendo a etapa, veio %v", err)
	}

	// rodada travada há mais que a validade: a próxima assume
	travaMu.Lock()
	travaDesde = time.Now().Add(-travaValidade - time.Minute)
	travaMu.Unlock()
	b, err := pegarTrava("nova")
	if err != nil {
		t.Fatalf("trava vencida devia ser assumida: %v", err)
	}

	// a antiga acorda e termina: não pode soltar a trava da nova
	soltarTrava(a)
	if _, err := pegarTrava("terceira"); err == nil {
		t.Fatal("a rodada vencida soltou a trava da sucessora")
	}
	soltarTrava(b)
	c, err := pegarTrava("depois")
	if err != nil {
		t.Fatalf("trava devia estar livre: %v", err)
	}
	soltarTrava(c)
}
