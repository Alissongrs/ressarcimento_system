package services

import (
	"testing"
	"time"
)

// Regra de prazo por instância (5/10 dias úteis; 30/30 corridos). Mudar isso muda quem
// aparece como vencido na tela Prazos e os alertas aos gestores.
func TestPrazoPorInstancia(t *testing.T) {
	want := map[int]PrazoRegra{
		1: {Dias: 5, Uteis: true},   // Distribuidora
		2: {Dias: 10, Uteis: true},  // Ouvidoria
		3: {Dias: 30, Uteis: false}, // ANEEL
		4: {Dias: 30, Uteis: false}, // SMA
	}
	if len(PrazoPorInstancia) != len(want) {
		t.Fatalf("PrazoPorInstancia tem %d regras; quer %d", len(PrazoPorInstancia), len(want))
	}
	for id, w := range want {
		if got := PrazoPorInstancia[id]; got != w {
			t.Errorf("instância %d: %+v; quer %+v", id, got, w)
		}
	}
}

func dia(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 10, 30, 0, 0, time.Local) // hora de propósito: a conta trunca para o dia
}

func TestDiasUteisEntre(t *testing.T) {
	// nov/2026: 09 é segunda, 13 sexta, 14 sábado, 15 domingo, 16 segunda.
	tests := []struct {
		name        string
		inicio, fim time.Time
		want        int
	}{
		{"mesmo dia", dia(2026, 11, 9), dia(2026, 11, 9), 0},
		{"fim antes do início", dia(2026, 11, 10), dia(2026, 11, 9), 0},
		{"segunda → terça (não conta o início, conta o fim)", dia(2026, 11, 9), dia(2026, 11, 10), 1},
		{"segunda → sexta", dia(2026, 11, 9), dia(2026, 11, 13), 4},
		{"sexta → segunda pula o fim de semana", dia(2026, 11, 13), dia(2026, 11, 16), 1},
		{"sexta → sábado não conta", dia(2026, 11, 13), dia(2026, 11, 14), 0},
		{"segunda → segunda seguinte", dia(2026, 11, 9), dia(2026, 11, 16), 5},
		{"duas semanas", dia(2026, 11, 9), dia(2026, 11, 23), 10},
		{"hora não interfere", time.Date(2026, 11, 9, 23, 59, 0, 0, time.Local), time.Date(2026, 11, 10, 0, 1, 0, 0, time.Local), 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DiasUteisEntre(tt.inicio, tt.fim); got != tt.want {
				t.Errorf("= %d; quer %d", got, tt.want)
			}
		})
	}
}

func TestDiasCorridosEntre(t *testing.T) {
	tests := []struct {
		name        string
		inicio, fim time.Time
		want        int
	}{
		{"mesmo dia", dia(2026, 11, 9), dia(2026, 11, 9), 0},
		{"fim antes", dia(2026, 11, 10), dia(2026, 11, 9), 0},
		{"um dia", dia(2026, 11, 9), dia(2026, 11, 10), 1},
		{"fim de semana conta", dia(2026, 11, 13), dia(2026, 11, 16), 3},
		{"30 dias cruzando o mês", dia(2026, 10, 15), dia(2026, 11, 14), 30},
		{"vira o ano", dia(2026, 12, 20), dia(2027, 1, 5), 16},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DiasCorridosEntre(tt.inicio, tt.fim); got != tt.want {
				t.Errorf("= %d; quer %d", got, tt.want)
			}
		})
	}
}

// Vencido só a partir do dia N+1: no dia N o processo ainda está no prazo (restante 0).
func TestAplicarPrazo(t *testing.T) {
	base := dia(2026, 11, 9) // segunda
	tests := []struct {
		name           string
		instancia      int
		now            time.Time
		wantDecorridos int
		wantRestantes  int
		wantAtrasado   bool
		wantTemRegra   bool
	}{
		{"Distribuidora no dia 5 útil: no prazo", 1, dia(2026, 11, 16), 5, 0, false, true},
		{"Distribuidora no dia 6 útil: vencido", 1, dia(2026, 11, 17), 6, -1, true, true},
		{"Distribuidora no sábado após 4 úteis: no prazo", 1, dia(2026, 11, 14), 4, 1, false, true},
		{"Ouvidoria 10 úteis: no prazo", 2, dia(2026, 11, 23), 10, 0, false, true},
		{"Ouvidoria 11 úteis: vencido", 2, dia(2026, 11, 24), 11, -1, true, true},
		{"ANEEL 30 corridos: no prazo", 3, dia(2026, 12, 9), 30, 0, false, true},
		{"ANEEL 31 corridos: vencido", 3, dia(2026, 12, 10), 31, -1, true, true},
		{"SMA 30 corridos: no prazo", 4, dia(2026, 12, 9), 30, 0, false, true},
		{"instância desconhecida: sem regra, nunca vencido", 9, dia(2027, 3, 1), 0, 0, false, false},
		{"instância zero (processo sem instância): sem regra", 0, dia(2027, 3, 1), 0, 0, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := ProcessoPrazo{IDProcesso: 1, IDInstancia: tt.instancia, DataBase: base}
			aplicarPrazo(&p, tt.now)
			if p.TemRegra != tt.wantTemRegra || p.DiasDecorridos != tt.wantDecorridos || p.DiasRestantes != tt.wantRestantes || p.Atrasado != tt.wantAtrasado {
				t.Errorf("regra=%v decorridos=%d restantes=%d atrasado=%v; quer regra=%v decorridos=%d restantes=%d atrasado=%v",
					p.TemRegra, p.DiasDecorridos, p.DiasRestantes, p.Atrasado, tt.wantTemRegra, tt.wantDecorridos, tt.wantRestantes, tt.wantAtrasado)
			}
			if tt.wantTemRegra {
				if r := PrazoPorInstancia[tt.instancia]; p.PrazoDias != r.Dias || p.PrazoUteis != r.Uteis {
					t.Errorf("prazo copiado errado: %d/%v; quer %d/%v", p.PrazoDias, p.PrazoUteis, r.Dias, r.Uteis)
				}
			}
		})
	}
}
