package saude

import (
	"testing"
	"time"
)

func ptr(t time.Time) *time.Time { return &t }

func TestAvaliar(t *testing.T) {
	agora := time.Date(2026, 11, 13, 10, 0, 0, 0, time.Local)
	ping := Rotina{Nome: "p", Titulo: "ping", Tipo: TipoPing, Cadencia: "a cada minuto", Tolerancia: 5 * time.Minute, MaxDuracao: 30 * time.Minute}
	exec := Rotina{Nome: "e", Titulo: "exec", Tipo: TipoExecucao, Cadencia: "todo dia", Tolerancia: 26 * time.Hour, MaxDuracao: 3 * time.Hour}
	opc := Rotina{Nome: "o", Titulo: "opcional", Tipo: TipoPing, Opcional: true, Tolerancia: 5 * time.Minute, MaxDuracao: time.Hour}

	casos := []struct {
		nome   string
		r      Rotina
		s      Sinal
		estado string
	}{
		{"ping sem sinal", ping, Sinal{}, EstadoNunca},
		{"opcional sem sinal", opc, Sinal{}, EstadoDesligada},
		{"ping recente", ping, Sinal{UltimoPing: ptr(agora.Add(-2 * time.Minute))}, EstadoOK},
		{"ping no limite", ping, Sinal{UltimoPing: ptr(agora.Add(-5 * time.Minute))}, EstadoOK},
		{"ping velho", ping, Sinal{UltimoPing: ptr(agora.Add(-6 * time.Minute))}, EstadoAtrasada},
		{"ping ok mas última execução com erro", ping, Sinal{
			UltimoPing: ptr(agora.Add(-1 * time.Minute)),
			Ultima:     &Execucao{Inicio: agora.Add(-10 * time.Minute), Fim: ptr(agora.Add(-9 * time.Minute)), Status: EstadoErro, Resumo: "rc=1"},
		}, EstadoErro},
		{"erro seguido de ok", ping, Sinal{
			UltimoPing: ptr(agora.Add(-1 * time.Minute)),
			Ultima:     &Execucao{Inicio: agora.Add(-10 * time.Minute), Fim: ptr(agora.Add(-9 * time.Minute)), Status: EstadoOK},
			UltimaOK:   ptr(agora.Add(-9 * time.Minute)),
		}, EstadoOK},
		{"rodando dentro do limite", exec, Sinal{Ultima: &Execucao{Inicio: agora.Add(-time.Hour), Status: EstadoRodando}}, EstadoRodando},
		{"rodando além do limite = travada", exec, Sinal{Ultima: &Execucao{Inicio: agora.Add(-4 * time.Hour), Status: EstadoRodando}}, EstadoTravada},
		{"exec sem nada", exec, Sinal{}, EstadoNunca},
		{"exec ok ontem", exec, Sinal{
			Ultima:   &Execucao{Inicio: agora.Add(-7 * time.Hour), Fim: ptr(agora.Add(-7 * time.Hour)), Status: EstadoOK},
			UltimaOK: ptr(agora.Add(-7 * time.Hour)),
		}, EstadoOK},
		{"exec ok há 2 dias = atrasada", exec, Sinal{
			Ultima:   &Execucao{Inicio: agora.Add(-50 * time.Hour), Fim: ptr(agora.Add(-50 * time.Hour)), Status: EstadoOK},
			UltimaOK: ptr(agora.Add(-50 * time.Hour)),
		}, EstadoAtrasada},
		{"exec: última falhou, ok anterior = erro", exec, Sinal{
			Ultima:   &Execucao{Inicio: agora.Add(-time.Hour), Fim: ptr(agora.Add(-time.Hour)), Status: EstadoErro},
			UltimaOK: ptr(agora.Add(-25 * time.Hour)),
		}, EstadoErro},
		{"exec: só pings, nunca terminou ok", exec, Sinal{UltimoPing: ptr(agora.Add(-time.Minute))}, EstadoNunca},
	}
	for _, c := range casos {
		got, motivo := Avaliar(c.r, c.s, agora)
		if got != c.estado {
			t.Errorf("%s: estado %q, esperado %q (%s)", c.nome, got, c.estado, motivo)
		}
		if motivo == "" {
			t.Errorf("%s: motivo vazio", c.nome)
		}
	}
}

func TestProblema(t *testing.T) {
	for _, e := range []string{EstadoAtrasada, EstadoErro, EstadoTravada} {
		if !Problema(e) {
			t.Errorf("%s deveria ser problema", e)
		}
	}
	for _, e := range []string{EstadoOK, EstadoRodando, EstadoNunca, EstadoDesligada} {
		if Problema(e) {
			t.Errorf("%s não deveria ser problema", e)
		}
	}
}

func TestCatalogoSemRepeticao(t *testing.T) {
	vistos := map[string]bool{}
	for _, r := range Catalogo {
		if vistos[r.Nome] {
			t.Errorf("rotina repetida no catálogo: %s", r.Nome)
		}
		vistos[r.Nome] = true
		if r.Tolerancia <= 0 || r.MaxDuracao <= 0 || r.Titulo == "" || r.Cadencia == "" {
			t.Errorf("rotina %s incompleta", r.Nome)
		}
	}
}
