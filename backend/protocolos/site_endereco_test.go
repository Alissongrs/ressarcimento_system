package protocolos

import (
	"reflect"
	"testing"
)

func TestUCsDoEndereco(t *testing.T) {
	casos := map[string][]string{
		"JACESA -585359105940 - Presidente Dutra - (RJ)":                                                       {"585359105940"},
		"CLARO - UC 90569563 - Doutor Alexandre Rasgulaeff - (PR)":                                             {"90569563"},
		"TIM - 0036001089 - Santos Saraiva, 1520 - (SC)":                                                       {"36001089"},
		"CLARO - 10035918304 - ALA ISMERINO, Q. 0, L. 0, S/N SETOR FAICALVILLE CEP: 74000000 GOIANIA G - (GO)": {"10035918304"},
		"x - 5.853.591.059-40 - y":                                                                             {"585359105940"},
		"TIM - Enel SP - Duarte Correia - (SP)":                                                                nil,
	}
	for in, want := range casos {
		if got := UCsDoEndereco(in); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %v, want %v", in, got, want)
		}
	}
}
