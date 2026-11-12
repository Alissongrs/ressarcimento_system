package v2

import (
	"database/sql"
	"encoding/json"
	"math"
	"os"
	"testing"
)

// Gabarito de repasse com casos reais (lidos do banco em 12/11/2026, só leitura).
// Só entraram deferimentos em que o repasse gravado bate com crédito × percentual; os que
// divergem são valores históricos negociados e NÃO devem ser recalculados (ver memória
// "Repasse: valores históricos"). Se este teste quebrar, a fórmula ou a escolha do
// percentual mudou — e isso mexe com dinheiro.
type casoRepasse struct {
	IDProcesso      int      `json:"id_processo"`
	Cliente         string   `json:"cliente"`
	DataProcedencia *string  `json:"data_procedencia"`
	CreditoSimples  *float64 `json:"credito_simples"`
	CreditoDobro    *float64 `json:"credito_dobro"`
	Override        *float64 `json:"percentual_override"`
	VigenteSimples  *float64 `json:"percentual_simples_vigente"`
	VigenteDobro    *float64 `json:"percentual_dobro_vigente"`
	RepasseSimples  *float64 `json:"repasse_simples"`
	RepasseDobro    *float64 `json:"repasse_dobro"`
}

func nullFloat(p *float64) sql.NullFloat64 {
	if p == nil {
		return sql.NullFloat64{}
	}
	return sql.NullFloat64{Float64: *p, Valid: true}
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

func TestRepasseCasosHistoricos(t *testing.T) {
	raw, err := os.ReadFile("testdata/repasse_casos_historicos.json")
	if err != nil {
		t.Fatalf("gabarito não encontrado: %v", err)
	}
	var fx struct {
		Casos []casoRepasse `json:"casos"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("gabarito inválido: %v", err)
	}
	if len(fx.Casos) < 30 {
		t.Fatalf("gabarito com só %d casos; esperava pelo menos 30", len(fx.Casos))
	}
	for _, c := range fx.Casos {
		pctS, pctD := percentuaisRepasse(nullFloat(c.Override), nullFloat(c.VigenteSimples), nullFloat(c.VigenteDobro))
		cs, cd := 0.0, 0.0
		if c.CreditoSimples != nil {
			cs = *c.CreditoSimples
		}
		if c.CreditoDobro != nil {
			cd = *c.CreditoDobro
		}
		if c.RepasseSimples != nil {
			if got, want := round2(calcRepasse(cs, pctS)), round2(*c.RepasseSimples); math.Abs(got-want) > 0.011 {
				t.Errorf("processo %d (%s): repasse simples = %.2f; gravado %.2f (crédito %.2f × %.2f%%)", c.IDProcesso, c.Cliente, got, want, cs, pctS)
			}
		}
		if c.RepasseDobro != nil {
			if got, want := round2(calcRepasse(cd, pctD)), round2(*c.RepasseDobro); math.Abs(got-want) > 0.011 {
				t.Errorf("processo %d (%s): repasse dobro = %.2f; gravado %.2f (crédito %.2f × %.2f%%)", c.IDProcesso, c.Cliente, got, want, cd, pctD)
			}
		}
	}
}

func TestPercentuaisRepasse(t *testing.T) {
	v := func(f float64) sql.NullFloat64 { return sql.NullFloat64{Float64: f, Valid: true} }
	nada := sql.NullFloat64{}
	tests := []struct {
		name                 string
		override, vigS, vigD sql.NullFloat64
		wantS, wantD         float64
	}{
		{"sem override usa o par da empresa", nada, v(25), v(40), 25, 40},
		{"override vale para os dois lados", v(30), v(25), v(40), 30, 30},
		{"override zero é ignorado", v(0), v(25), v(40), 25, 40},
		{"override NULL é ignorado", nada, v(20), v(40), 20, 40},
		{"empresa sem cadastro → 0 (não grava)", nada, nada, nada, 0, 0},
		{"só dobro cadastrado", nada, nada, v(40), 0, 40},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, d := percentuaisRepasse(tt.override, tt.vigS, tt.vigD)
			if s != tt.wantS || d != tt.wantD {
				t.Errorf("= (%v, %v); quer (%v, %v)", s, d, tt.wantS, tt.wantD)
			}
		})
	}
}

func TestRepartir(t *testing.T) {
	tests := []struct {
		name                  string
		total, cs, cd, rs, rd float64
		wantS, wantD          float64
	}{
		{"só crédito simples: tudo no simples", 1000, 5000, 0, 0, 0, 1000, 0},
		{"só crédito dobro: tudo no dobro", 1000, 0, 5000, 0, 0, 0, 1000},
		{"sem crédito nenhum: cai no simples", 1000, 0, 0, 0, 0, 1000, 0},
		{"dois lados sem repasse anterior: proporção dos créditos", 1000, 3000, 1000, 0, 0, 750, 250},
		{"dois lados com repasse anterior: mantém a proporção do repasse", 1000, 3000, 1000, 100, 300, 250, 750},
		{"centavos fecham: dobro recebe o resto", 100, 1000, 1000, 1, 2, 33.33, 66.67},
		{"proporção 25/40 da CLARO em créditos iguais", 650, 1000, 1000, 250, 400, 250, 400},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, d := repartir(tt.total, tt.cs, tt.cd, tt.rs, tt.rd)
			if math.Abs(s-tt.wantS) > 1e-9 || math.Abs(d-tt.wantD) > 1e-9 {
				t.Errorf("= (%.2f, %.2f); quer (%.2f, %.2f)", s, d, tt.wantS, tt.wantD)
			}
			if math.Abs((s+d)-tt.total) > 1e-9 {
				t.Errorf("simples+dobro = %.2f; quer %.2f (não pode perder centavo)", s+d, tt.total)
			}
		})
	}
}
