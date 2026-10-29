package v2

import (
	"math"
	"testing"
)

// P1-7: trava a fórmula de repasse (credito × percentual / 100), origem do bug de dinheiro.
func TestCalcRepasse(t *testing.T) {
	tests := []struct {
		name           string
		credito, pct   float64
		want           float64
	}{
		{"CLARO simples 25%", 1000, 25, 250},
		{"CLARO dobro 40%", 1000, 40, 400},
		{"credito zero", 0, 25, 0},
		{"percentual zero", 500, 0, 0},
		{"quinze porcento fracionado", 1234.56, 15, 185.184},
		{"cem porcento", 800, 100, 800},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := calcRepasse(tt.credito, tt.pct)
			if math.Abs(got-tt.want) > 1e-9 {
				t.Errorf("calcRepasse(%v, %v) = %v; quer %v", tt.credito, tt.pct, got, tt.want)
			}
		})
	}
}
