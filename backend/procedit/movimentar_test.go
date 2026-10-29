package procedit

import "testing"

func intp(v int) *int { return &v }

func eqp(a, b *int) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }

// Interpretação de pedidos de MOVIMENTAÇÃO feitos no chat (#sistema). Só o parser —
// a resolução contra o processo (o que não foi dito mantém o atual) é do montarMov.
func TestInterpretarMovimentacao(t *testing.T) {
	casos := []struct {
		msg               string
		ref               string
		etapa, dir        int
		inst, status, apr *int
		coment            string
	}{
		// pedido real da Eliane (unidade em vez de nº do processo; status e instância por extenso)
		{msg: "Sure ache a unidade 200994986 e coloque na movimentação que está aguardando resposta perante distribuidora",
			ref: "UC:200994986", inst: intp(1), status: intp(3)},
		{msg: "mover o processo 16470 de contestação para conciliação: acordo fechado com a distribuidora",
			ref: "16470", etapa: 3, coment: "acordo fechado com a distribuidora"},
		{msg: "deferir o processo PR-2023-016470", ref: "PR-2023-016470", etapa: 6, apr: intp(1)},
		{msg: "indeferido processo 16470", ref: "16470", etapa: 6, apr: intp(2)},
		{msg: "avançar o processo 16470", ref: "16470", dir: 1},
		{msg: "voltar o processo 16470 uma etapa", ref: "16470", dir: -1},
		{msg: "movimentar o processo 16470 da ouvidoria para a ANEEL status pendente", ref: "16470", inst: intp(3), status: intp(4)},
		{msg: "transferir a UC 5/2445677-4 para a ouvidoria", ref: "UC:5/2445677-4", inst: intp(2)},
	}
	for _, c := range casos {
		p, ok := interpretar(c.msg)
		if !ok || p.op != "movimentar" {
			t.Errorf("%q: esperava movimentar, veio op=%q ok=%v motivo=%q", c.msg, p.op, ok, p.motivo)
			continue
		}
		if p.processoRef != c.ref || p.movEtapa != c.etapa || p.movDir != c.dir ||
			!eqp(p.movInst, c.inst) || !eqp(p.movStatus, c.status) || !eqp(p.movAprov, c.apr) || p.comentario != c.coment {
			t.Errorf("%q:\n got ref=%q etapa=%d dir=%d inst=%v st=%v apr=%v com=%q", c.msg,
				p.processoRef, p.movEtapa, p.movDir, deref(p.movInst), deref(p.movStatus), deref(p.movAprov), p.comentario)
		}
		if !EhComando(c.msg) {
			t.Errorf("%q: EhComando deveria ser true (senão o chat responde como pergunta)", c.msg)
		}
	}
}

// Pedidos que NÃO são movimentação continuam no caminho de sempre.
func TestNaoViraMovimentacao(t *testing.T) {
	if p, ok := interpretar("atualizar a observação do processo 18789 para teste"); !ok || p.op != "editar_processo" {
		t.Errorf("edição de campo virou %q (ok=%v, %q)", p.op, ok, p.motivo)
	}
	if p, ok := interpretar("inserir histórico no processo 18789: liguei para a distribuidora e vou mover amanhã"); !ok || p.op != "inserir_historico" {
		t.Errorf("histórico virou %q (ok=%v, %q)", p.op, ok, p.motivo)
	}
	if EhComando("quantas movimentações o processo 16470 teve?") {
		t.Errorf("pergunta não pode virar comando")
	}
}

func deref(p *int) interface{} {
	if p == nil {
		return nil
	}
	return *p
}
