package procedit

import "testing"

// Pedido de número novo/antigo de UC vai para a fila do worker como consulta (sem aprovação).
func TestUCNumeroNovoViraConsulta(t *testing.T) {
	sim := []string{
		"Preciso do número novo da UC 38946823 da CLARO, Concessionária Elektro",
		"SURE, PRECISO DO NÚMERO NOVO DA UNIDADE CONSUMIDORA 60286180",
		"Pode verificar, por favor, o número novo da UC 60286180?",
		"qual o número antigo da instalação 335563503161?",
		"a UC 60286180 tem número novo?",
		"verifique a nova numeração da unidade 123456",
	}
	for _, m := range sim {
		if !EhComando(m) {
			t.Errorf("deveria ir para a fila (comando): %q", m)
		}
		if !EhLeitura(m, nil) {
			t.Errorf("deveria ser consulta (sem aprovação): %q", m)
		}
	}
	nao := []string{
		"qual o número de processos da CELESC?",
		"quantos processos novos entraram hoje?",
	}
	for _, m := range nao {
		if EhComando(m) {
			t.Errorf("não deveria virar comando: %q", m)
		}
	}
}
