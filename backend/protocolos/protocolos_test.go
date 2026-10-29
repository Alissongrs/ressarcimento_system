package protocolos

import (
	"reflect"
	"testing"
)

func TestExtrair(t *testing.T) {
	casos := map[string][]string{
		"Enviamos para ANEEL - Protocolo 010.665.84026-55":                         {"0106658402655"},
		"Encaminhado para ANEEL 0105145012406;":                                    {"0105145012406"},
		"Solicitação de Ouvidoria n. 0106622822611 - ... (SO) n. 010.646.83526-06": {"0106622822611", "0106468352606"},
		"010.643.30126-47":                          {"0106433012647"},
		"Ouvidoria Nº 001246981873 UC 3011766042":   nil,
		"chave 35201001065584026551234":             nil,
		"010.665.84026-55 e de novo 0106658402655":  {"0106658402655"},
		"Reclamação feita na ANEEL 10.631.88126-01": {"0106318812601"},
		"Ouvidoria 100224833045 sem pontuação":      nil,
	}
	for txt, want := range casos {
		if got := Extrair(txt); !reflect.DeepEqual(got, want) {
			t.Errorf("Extrair(%q) = %v, quero %v", txt, got, want)
		}
	}
}

func TestNormalizarFormatar(t *testing.T) {
	if n := Normalizar(" 010.665.84026-55 "); n != "0106658402655" || Formatar(n) != "010.665.84026-55" {
		t.Fatalf("normalizar/formatar: %q", n)
	}
	if Normalizar("12345") != "" || Normalizar("0206658402655") != "" {
		t.Fatal("aceitou protocolo inválido")
	}
}

func TestClassificarELeitura(t *testing.T) {
	if Classificar("Registro da solicitação de ouvidoria nº 010.665.84026-55 na ANEEL") != "registro" ||
		Classificar("Solicitação de Ouvidoria n. 0106620712606 - Am Energia") != "resposta" ||
		Classificar("Avalie a ouvidoria da sua empresa de energia elétrica") != "prazo" ||
		Classificar("Recuperação de senha (Ouvidoria") != "" {
		t.Fatal("classificação errada")
	}
	if Leitura("a Ouvidoria ratifica o posicionamento") != "parece desfavorável" ||
		Leitura("pedido improcedente") != "parece desfavorável" ||
		Leitura("constatou-se a necessidade de revisão da fatura") != "parece favorável" ||
		Leitura("Agradecemos o contato") != "" {
		t.Fatal("leitura errada")
	}
}

func TestProtDistrib(t *testing.T) {
	txt := "Protocolo Aberto pela Ouvidoria da Distribuidora: 1671755100. Prazo final: 18/05/2026; " +
		"registro sua na empresa sob o protocolo nº 391136657 que ainda"
	var got []string
	for _, m := range reProtDistrib.FindAllStringSubmatch(txt, -1) {
		got = append(got, m[1])
	}
	if !reflect.DeepEqual(got, []string{"1671755100", "391136657"}) {
		t.Fatalf("protocolos da distribuidora: %v", got)
	}
}

func TestChaveRegra(t *testing.T) {
	casos := map[[2]string]string{
		{"registro", ""}:                    "registro_sem_processo",
		{"resposta", "parece favorável"}:    "resposta_favoravel",
		{"resposta", "parece desfavorável"}: "resposta_desfavoravel",
		{"resposta", ""}:                    "resposta_outra",
		{"prazo", ""}:                       "prazo",
	}
	validas := map[string]bool{}
	for _, r := range RegrasTarefa {
		validas[r.Chave] = true
	}
	for in, want := range casos {
		if got := ChaveRegra(in[0], in[1]); got != want || !validas[got] {
			t.Errorf("ChaveRegra(%v) = %q, quero %q (e cadastrada em RegrasTarefa)", in, got, want)
		}
	}
}
