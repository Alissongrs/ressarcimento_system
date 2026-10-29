package handlers

import "testing"

// R3 — parser de JSON robusto do v19.
func TestExtrairDadosEstruturadosV19(t *testing.T) {
	casos := []struct {
		nome     string
		in       string
		querUC   string
		querNil  bool
	}{
		{
			nome:   "json simples no fim",
			in:     "análise...\n{\"uc\":\"123\",\"mes_ref\":\"05/2026\",\"total_rs\":100.5,\"kwh_total\":900}",
			querUC: "123",
		},
		{
			nome:   "chaves dentro de string nao desbalanceiam",
			in:     "{\"uc\":\"9\",\"obs\":\"pico }{ estranho\",\"mes_ref\":\"01/26\",\"total_rs\":1}",
			querUC: "9",
		},
		{
			nome:   "dois blocos json - pega o ultimo valido",
			in:     "exemplo:\n{\"uc\":\"AAA\",\"a\":1,\"b\":2,\"c\":3}\nreal:\n{\"uc\":\"BBB\",\"mes_ref\":\"x\",\"total_rs\":2,\"kwh_total\":1}",
			querUC: "BBB",
		},
		{
			nome:   "cerca json maiuscula",
			in:     "```JSON\n{\"uc\":\"CC\",\"mes_ref\":\"z\",\"total_rs\":3,\"kwh_total\":2}\n```",
			querUC: "CC",
		},
		{
			nome:    "truncado sem fechar -> nil",
			in:      "{\"uc\":\"D\",\"mes_ref\":\"y\",\"total_rs\":4,\"kwh_total",
			querNil: true,
		},
		{
			nome:    "sem json -> nil",
			in:      "só texto, nenhuma decisão estruturada",
			querNil: true,
		},
	}
	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			got := extrairDadosEstruturadosV19(c.in)
			if c.querNil {
				if got != nil {
					t.Fatalf("esperava nil, veio %v", got)
				}
				return
			}
			if got == nil {
				t.Fatalf("esperava objeto, veio nil")
			}
			if uc, _ := got["uc"].(string); uc != c.querUC {
				t.Fatalf("uc esperado %q, veio %q", c.querUC, uc)
			}
		})
	}
}

// R7 — detecção de decisão tolerante a espaço/caixa/underscore.
func TestExtrairDecisaoV19(t *testing.T) {
	casos := map[string]string{
		`"decisao": "CONFIRMADO"`:      "confirmado",
		`"decisao":"refutado"`:         "refutado",
		`"decisao_final" :  "Inconclusivo"`: "inconclusivo",
		`nada aqui`:                    "",
	}
	for in, quer := range casos {
		if got := extrairDecisaoV19(in); got != quer {
			t.Errorf("extrairDecisaoV19(%q) = %q, quer %q", in, got, quer)
		}
	}
	if decisaoValidaV19("confirmado") != true || decisaoValidaV19("") != false || decisaoValidaV19("talvez") != false {
		t.Error("decisaoValidaV19 incoerente")
	}
}

// R2 — normalização de nome de distribuidora (base do match determinístico).
func TestNormNomeDist(t *testing.T) {
	casos := map[string]string{
		"CEMIG Distribuição S.A.":              "CEMIG",
		"ENEL DISTRIBUIÇÃO SÃO PAULO S.A.":     "ENEL SAO PAULO",
		"Light Serviços de Eletricidade S.A.":  "LIGHT SERVICOS ELETRICIDADE",
	}
	for in, quer := range casos {
		if got := normNomeDist(in); got != quer {
			t.Errorf("normNomeDist(%q) = %q, quer %q", in, got, quer)
		}
	}
}
