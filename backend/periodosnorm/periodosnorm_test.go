package periodosnorm

import "testing"

func TestNormalizar(t *testing.T) {
	casos := []struct{ in, want string }{
		{`[{"raw": "2023-05-01 00:00:00"}]`, `[{"ano":2023,"mes":5}]`},
		{`[{"raw": "01/05/2023 e 01/06/2023"}]`, `[{"ano":2023,"mes":5},{"ano":2023,"mes":6}]`},
		{`[{"raw": "01/05/2023 até 01/08/2023 "}]`, `[{"ano":2023,"mes":5},{"ano":2023,"mes":6},{"ano":2023,"mes":7},{"ano":2023,"mes":8}]`},
		{`[{"raw": "01/05/2023, 01/07/2023 e 01/08/2023 mai/23, jul/23 e ago/23"}]`, `[{"ano":2023,"mes":5},{"ano":2023,"mes":7},{"ano":2023,"mes":8}]`},
		{`[{"raw": "01/11/2021 a atual fatura"}]`, `[{"raw":"11/2021 em diante"}]`},
		{`[{"raw": "-"}]`, `[{"raw": "-"}]`},
		{`[{"raw": "<NA>"}]`, `[{"raw": "<NA>"}]`},
		{`[{"ano": 2024, "mes": 6}]`, `[{"ano":2024,"mes":6}]`},
		{`[{"ano": "2024", "mes": "7"}]`, `[{"ano":2024,"mes":7}]`},
		{`01/05/2023 e 01/06/2023`, `[{"ano":2023,"mes":5},{"ano":2023,"mes":6}]`}, // texto solto do form
	}
	for _, c := range casos {
		got := Normalizar(c.in)
		if got != c.want {
			t.Errorf("Normalizar(%q)\n  got  %q\n  want %q", c.in, got, c.want)
		}
		// idempotência
		if got2 := Normalizar(got); got2 != got {
			t.Errorf("não idempotente: Normalizar(%q)=%q -> %q", c.in, got, got2)
		}
	}
}
