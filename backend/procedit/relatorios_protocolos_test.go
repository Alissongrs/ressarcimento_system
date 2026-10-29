package procedit

import "testing"

// Pedidos reais da Luana (29/10/2026) e o relatório antigo de "mais de N protocolos", que não pode mudar.
func TestInterpretarRelatoriosProtocolos(t *testing.T) {
	casos := []struct{ msg, chave, anos string }{
		{"faça um relatório em excel dos processos que estão em Protocolos ANEEL", "protocolos_aneel_lista", ""},
		{"elabore um relatório contendo a quantidade que é concluído na ANEEL por dia e o tempo médio para a conclusão dos processos que foram abertos em 2024, 2025 e 2026.", "conclusoes_aneel", "2024,2025,2026"},
		{"tempo médio de conclusão na ANEEL dos processos de 2024 a 2026", "conclusoes_aneel", "2024,2025,2026"},
		{"faça um relatório somente dos processos que possuem mais de um protocolo da ANEEL somente dos casos que encontram-se na etapa de Contestação.", "protocolos_aneel", ""},
	}
	for _, c := range casos {
		ch, p, ok := interpretarRelatorio(norm(c.msg))
		if !ok || ch != c.chave {
			t.Errorf("%q → %q, quer %q", c.msg, ch, c.chave)
			continue
		}
		if c.anos != "" && p["anos"] != c.anos {
			t.Errorf("%q → anos %q, quer %q", c.msg, p["anos"], c.anos)
		}
	}
}
