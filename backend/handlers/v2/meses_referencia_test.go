package v2

import "testing"

func TestFormatarMesesReferencia(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{`[{"raw": "2023-05-01 00:00:00"}]`, "mai/23"},
		{`[{"raw": "01/05/2023"}]`, "mai/23"},
		{`[{"raw": "01/05/2023 e 01/06/2023"}]`, "mai/23 e jun/23"},
		{`[{"raw": "01/05/2023 até 01/07/2023 "}]`, "mai/23 até jul/23"},
		{`[{"raw": "01/11/2021 a atual fatura"}]`, "nov/21 a atual fatura"},
		{`[{"raw": "01/05/2023, 01/07/2023 e 01/08/2023 mai/23, jul/23 e ago/23"}]`, "mai/23, jul/23, ago/23"},
		{`[{"raw": "2023-05-01"},{"raw":"2023-06-01"},{"raw":"2023-07-01"}]`, "mai/23 até jul/23"},
		{`[{"ano": "2024", "mes": "6"}]`, "jun/24"},
		{`[{"raw": "<NA>"}]`, ""},
		{`[]`, ""},
		{`null`, ""},
	}
	for _, c := range cases {
		_, got := formatarMesesReferencia(c.in)
		if got != c.want {
			t.Errorf("in=%q got=%q want=%q", c.in, got, c.want)
		}
	}
}
