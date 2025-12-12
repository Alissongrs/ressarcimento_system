// backend/utils/decimal_test.go
package utils

import (
	"testing"

	"github.com/shopspring/decimal"
)

func TestParseBrazilianCurrency(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{
			name:  "formato brasileiro com R$",
			input: "R$ 1.234,56",
			want:  "1234.56",
		},
		{
			name:  "formato brasileiro sem R$",
			input: "1.234,56",
			want:  "1234.56",
		},
		{
			name:  "formato com vírgula",
			input: "1234,56",
			want:  "1234.56",
		},
		{
			name:  "formato com ponto",
			input: "1234.56",
			want:  "1234.56",
		},
		{
			name:  "valor grande",
			input: "R$ 123.456.789,12",
			want:  "123456789.12",
		},
		{
			name:  "valor zero",
			input: "0",
			want:  "0.00",
		},
		{
			name:  "string vazia",
			input: "",
			want:  "0.00",
		},
		{
			name:  "apenas R$",
			input: "R$",
			want:  "0.00",
		},
		{
			name:  "valor negativo",
			input: "-1.234,56",
			want:  "-1234.56",
		},
		{
			name:    "valor inválido",
			input:   "abc",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseBrazilianCurrency(tt.input)

			if (err != nil) != tt.wantErr {
				t.Errorf("ParseBrazilianCurrency() error = %v, wantErr %v", err, tt.wantErr)
				return
			}

			if !tt.wantErr {
				want := decimal.RequireFromString(tt.want)
				if !got.Equal(want) {
					t.Errorf("ParseBrazilianCurrency(%q) = %v, want %v", tt.input, got, want)
				}
			}
		})
	}
}

func TestFormatBrazilianCurrency(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "valor simples",
			input: "1234.56",
			want:  "1.234,56",
		},
		{
			name:  "valor grande",
			input: "123456789.12",
			want:  "123.456.789,12",
		},
		{
			name:  "valor zero",
			input: "0",
			want:  "0,00",
		},
		{
			name:  "valor com uma casa decimal",
			input: "123.4",
			want:  "123,40",
		},
		{
			name:  "valor sem decimais",
			input: "1000",
			want:  "1.000,00",
		},
		{
			name:  "valor negativo",
			input: "-1234.56",
			want:  "-1.234,56",
		},
		{
			name:  "valor pequeno",
			input: "0.99",
			want:  "0,99",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			input := decimal.RequireFromString(tt.input)
			got := FormatBrazilianCurrency(input)

			if got != tt.want {
				t.Errorf("FormatBrazilianCurrency(%s) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestRoundTrip(t *testing.T) {
	// Testa parse -> format -> parse
	tests := []string{
		"1.234,56",
		"123.456,78",
		"0,99",
		"1.000,00",
	}

	for _, tt := range tests {
		t.Run(tt, func(t *testing.T) {
			// Parse
			parsed, err := ParseBrazilianCurrency(tt)
			if err != nil {
				t.Fatalf("ParseBrazilianCurrency(%q) error = %v", tt, err)
			}

			// Format
			formatted := FormatBrazilianCurrency(parsed)

			// Parse novamente
			parsedAgain, err := ParseBrazilianCurrency(formatted)
			if err != nil {
				t.Fatalf("ParseBrazilianCurrency(%q) error = %v", formatted, err)
			}

			// Deve ser igual
			if !parsed.Equal(parsedAgain) {
				t.Errorf("Round trip failed: %s -> %s -> %s", tt, formatted, parsedAgain)
			}
		})
	}
}

func TestSumDecimals(t *testing.T) {
	a := decimal.RequireFromString("1.10")
	b := decimal.RequireFromString("2.25")
	c := decimal.RequireFromString("3.99")

	sum := SumDecimals(a, b, c)
	want := decimal.RequireFromString("7.34")

	if !sum.Equal(want) {
		t.Errorf("SumDecimals() = %s, want %s", sum, want)
	}
}

func TestPrecision(t *testing.T) {
	// Testa que não há perda de precisão
	tests := []struct {
		name   string
		values []string
		want   string
	}{
		{
			name:   "soma simples",
			values: []string{"0.1", "0.2"},
			want:   "0.30",
		},
		{
			name:   "soma complexa",
			values: []string{"1.11", "2.22", "3.33"},
			want:   "6.66",
		},
		{
			name:   "muitos valores",
			values: []string{"0.01", "0.01", "0.01", "0.01", "0.01", "0.01", "0.01", "0.01", "0.01", "0.01"},
			want:   "0.10",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var decimals []decimal.Decimal
			for _, v := range tt.values {
				decimals = append(decimals, decimal.RequireFromString(v))
			}

			sum := SumDecimals(decimals...)
			want := decimal.RequireFromString(tt.want)

			if !sum.Equal(want) {
				t.Errorf("SumDecimals(%v) = %s, want %s", tt.values, sum, want)
			}
		})
	}
}

func TestNullDecimal(t *testing.T) {
	// Test valid NullDecimal
	t.Run("valid", func(t *testing.T) {
		nd := NewNullDecimal(decimal.RequireFromString("123.45"))

		if !nd.Valid {
			t.Error("Expected Valid = true")
		}

		if nd.String() != "123,45" {
			t.Errorf("String() = %q, want %q", nd.String(), "123,45")
		}

		if nd.Float64() != 123.45 {
			t.Errorf("Float64() = %f, want %f", nd.Float64(), 123.45)
		}
	})

	// Test null NullDecimal
	t.Run("null", func(t *testing.T) {
		nd := NullDecimal{}

		if nd.Valid {
			t.Error("Expected Valid = false")
		}

		if nd.String() != "" {
			t.Errorf("String() = %q, want empty string", nd.String())
		}

		if nd.Float64() != 0 {
			t.Errorf("Float64() = %f, want 0", nd.Float64())
		}
	})

	// Test from string
	t.Run("from string", func(t *testing.T) {
		nd, err := NewNullDecimalFromString("1.234,56")
		if err != nil {
			t.Fatalf("NewNullDecimalFromString() error = %v", err)
		}

		if !nd.Valid {
			t.Error("Expected Valid = true")
		}

		want := "1.234,56"
		if nd.String() != want {
			t.Errorf("String() = %q, want %q", nd.String(), want)
		}
	})
}

func BenchmarkParseBrazilianCurrency(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_, _ = ParseBrazilianCurrency("R$ 1.234,56")
	}
}

func BenchmarkFormatBrazilianCurrency(b *testing.B) {
	d := decimal.RequireFromString("1234.56")
	for i := 0; i < b.N; i++ {
		_ = FormatBrazilianCurrency(d)
	}
}
