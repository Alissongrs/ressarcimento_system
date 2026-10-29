package rotinas

import (
	"strings"
	"testing"
	"time"
)

func TestInterpretarSync(t *testing.T) {
	casos := []struct {
		txt, janela, horarios, dias, tipo string
		deRotina                          bool
	}{
		{"quero que todos emails do dia anteriores sejam vinculados aos processos as 14:00 e as 18:00", "desde_ontem", "14:00,18:00", "*", "recorrente", true},
		{"vincular os e-mails às 9h nos dias úteis", "desde_ontem", "09:00", "1,2,3,4,5", "recorrente", true},
		{"sincronize os emails dessa semana", "semana", "", "*", "unica", false},
		{"sincronize os e-mails desde 01/10", "periodo", "", "*", "unica", false},
		{"vincule os e-mails de 01/10 a 05/10", "periodo", "", "*", "unica", false},
		{"sincronizar e-mails dos últimos 3 dias toda segunda às 8:30", "dias", "08:30", "1", "recorrente", true},
	}
	for _, c := range casos {
		p, err := InterpretarRotina(nil, c.txt, c.deRotina, 1, "Alisson")
		if err != nil {
			t.Fatalf("%q: %v", c.txt, err)
		}
		if p.Op != "sincronizar_emails" || p.Params["janela"] != c.janela || strings.Join(p.Horarios, ",") != c.horarios || p.Dias != c.dias || p.Tipo != c.tipo {
			t.Errorf("%q → op=%s janela=%v horarios=%v dias=%s tipo=%s", c.txt, p.Op, p.Params["janela"], p.Horarios, p.Dias, p.Tipo)
		}
		t.Log(p.Resumo)
	}
	if _, err := InterpretarRotina(nil, "#rotina vincular e-mails", true, 1, "A"); err == nil {
		t.Error("rotina sem horário deveria pedir horário")
	}
}

func TestHorarios(t *testing.T) {
	for in, want := range map[string]string{
		"as 14:30 e as 18": "14:30,18:00", "10h": "10:00", "15 horas": "15:00", "processo 18228 de 01/10": "",
	} {
		if got := strings.Join(horarios(norm(in)), ","); got != want {
			t.Errorf("%q → %q, quer %q", in, got, want)
		}
	}
}

func TestJanela(t *testing.T) {
	ref := time.Date(2026, 10, 22, 14, 0, 0, 0, Loc) // quinta
	de, ate := JanelaEmails(map[string]any{"janela": "semana"}, ref)
	if de.Format("2006-01-02 15:04") != "2026-10-19 00:00" || !ate.After(ref) {
		t.Errorf("semana %v %v", de, ate)
	}
	de, ate = JanelaEmails(map[string]any{"janela": "ontem"}, ref)
	if de.Format("02/01") != "21/10" || ate.Format("02/01 15:04") != "22/10 00:00" {
		t.Errorf("ontem %v %v", de, ate)
	}
}

func TestTextoLimpo(t *testing.T) {
	h := "<p>Prezados, segue protocolo 2026008913</p><div>De: Fulano &lt;x@y&gt;<br>Enviado: segunda<br>protocolo 999999999</div>"
	got := TextoLimpo(h)
	if !strings.Contains(got, "2026008913") || strings.Contains(got, "999999999") {
		t.Errorf("limpo = %q", got)
	}
}

func TestEscolherUsuarios(t *testing.T) {
	l := []UsuarioMin{{1, "Alisson Gonçalves Rodrigues", ""}, {2, "Luana Rosso Costa do Nascimento", ""},
		{3, "Luana Silva", ""}, {4, "Eliane Fatima De Araujo", ""}}
	n := norm("inclua um lembrete para a Luana nascimento para amanhã as 10:00")
	if got := escolherUsuarios(l, n, 1); len(got) != 1 || got[0].ID != 2 {
		t.Errorf("luana nascimento → %v", got)
	}
	if got := escolherUsuarios(l, norm("lembrete para a Luana amanhã"), 1); len(got) != 2 {
		t.Errorf("luana (ambíguo) → %v", got)
	}
	if got := escolherUsuarios(l, norm("lembrete para a Eliane hoje 15h"), 1); len(got) != 1 || got[0].ID != 4 {
		t.Errorf("eliane → %v", got)
	}
}
