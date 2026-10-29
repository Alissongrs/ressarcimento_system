package procedit

import "testing"

// Consultas/relatórios não precisam de aprovação; qualquer alteração precisa.
func TestEhLeitura(t *testing.T) {
	leitura := []string{
		"relatório dos processos da CELESC aguardando retorno",
		"preciso de um relatório em que foram registrados mais de dois protocolos na ANEEL a partir do mês 06/2026",
		"relatório de movimentações na ANEEL incluindo as alterações de status",
		"quantos processos estão na ANEEL?",
		"gere uma planilha com as faturas da UC 123",
		"verifique se os e-mails da unidade 123 estão coerentes no histórico do processo",
		"busque nas faturas da CLARO a fatura de set/2026 da unidade 2.964.616.011-87",
	}
	escrita := []string{
		"mover o processo 16470 para a ouvidoria",
		"atualizar a observação do processo 18789 para teste",
		"enviar e-mail para a celesc cobrando retorno",
		"cancele o pedido 12",
		"coloque o processo 123 em aguardando retorno",
		"altere a meta mensal para 250 mil",
	}
	for _, m := range leitura {
		if !EhLeitura(m, nil) {
			t.Errorf("deveria ser LEITURA (sem aprovação): %q", m)
		}
	}
	for _, m := range escrita {
		if EhLeitura(m, nil) {
			t.Errorf("deveria ser ESCRITA (com aprovação): %q", m)
		}
	}
	if !EhLeitura("x", &Acao{Op: "relatorio"}) || EhLeitura("x", &Acao{Op: "movimentar"}) {
		t.Errorf("com ação: só relatório é leitura")
	}
}
