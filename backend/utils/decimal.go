// backend/utils/decimal.go
package utils

import (
	"database/sql/driver"
	"fmt"
	"strings"

	"github.com/shopspring/decimal"
)

// ParseBrazilianCurrency converte valores brasileiros para decimal
// Aceita formatos: "R$ 1.234,56", "1.234,56", "1234,56", "1234.56"
func ParseBrazilianCurrency(s string) (decimal.Decimal, error) {
	if s == "" {
		return decimal.Zero, nil
	}

	// Remove prefixo R$, espaços e caracteres especiais
	clean := strings.ReplaceAll(s, "R$", "")
	clean = strings.ReplaceAll(clean, " ", "")
	clean = strings.TrimSpace(clean)

	if clean == "" {
		return decimal.Zero, nil
	}

	// Detecta formato: se tem vírgula E ponto, assume formato brasileiro
	hasComma := strings.Contains(clean, ",")
	hasDot := strings.Contains(clean, ".")

	if hasComma && hasDot {
		// Formato brasileiro: "1.234,56"
		clean = strings.ReplaceAll(clean, ".", "") // Remove separador de milhar
		clean = strings.ReplaceAll(clean, ",", ".") // Vírgula vira ponto decimal
	} else if hasComma {
		// Apenas vírgula: "1234,56" → "1234.56"
		clean = strings.ReplaceAll(clean, ",", ".")
	}
	// Se apenas ponto, já está no formato correto: "1234.56"

	// Converte para decimal
	dec, err := decimal.NewFromString(clean)
	if err != nil {
		return decimal.Zero, fmt.Errorf("valor inválido '%s': %w", s, err)
	}

	// Força 2 casas decimais
	return dec.Round(2), nil
}

// MustParseBrazilianCurrency converte ou retorna zero
func MustParseBrazilianCurrency(s string) decimal.Decimal {
	d, err := ParseBrazilianCurrency(s)
	if err != nil {
		return decimal.Zero
	}
	return d
}

// FormatBrazilianCurrency formata decimal para formato brasileiro "1.234,56"
func FormatBrazilianCurrency(d decimal.Decimal) string {
	// Garante 2 casas decimais
	d = d.Round(2)

	// Converte para string com ponto
	s := d.StringFixed(2)

	// Separa parte inteira e decimal
	parts := strings.Split(s, ".")
	intPart := parts[0]
	decPart := parts[1]

	// Trata números negativos
	negative := strings.HasPrefix(intPart, "-")
	if negative {
		intPart = intPart[1:]
	}

	// Adiciona separadores de milhar (da direita para esquerda)
	var result []rune
	for i := len(intPart) - 1; i >= 0; i-- {
		if len(result) > 0 && len(result)%4 == 3 {
			result = append([]rune{'.'}, result...)
		}
		result = append([]rune{rune(intPart[i])}, result...)
	}

	formatted := string(result) + "," + decPart

	if negative {
		return "-" + formatted
	}
	return formatted
}

// FormatBrazilianCurrencyWithSymbol formata com símbolo "R$ 1.234,56"
func FormatBrazilianCurrencyWithSymbol(d decimal.Decimal) string {
	return "R$ " + FormatBrazilianCurrency(d)
}

// ParseFloatToDecimal converte float64 para decimal com 2 casas decimais
func ParseFloatToDecimal(f float64) decimal.Decimal {
	return decimal.NewFromFloat(f).Round(2)
}

// ToFloat64 converte decimal para float64 (use apenas para exibição)
func ToFloat64(d decimal.Decimal) float64 {
	f, _ := d.Float64()
	return f
}

// SumDecimals soma múltiplos decimals
func SumDecimals(decimals ...decimal.Decimal) decimal.Decimal {
	sum := decimal.Zero
	for _, d := range decimals {
		sum = sum.Add(d)
	}
	return sum.Round(2)
}

// IsZero verifica se decimal é zero
func IsZero(d decimal.Decimal) bool {
	return d.IsZero()
}

// IsPositive verifica se decimal é positivo
func IsPositive(d decimal.Decimal) bool {
	return d.GreaterThan(decimal.Zero)
}

// IsNegative verifica se decimal é negativo
func IsNegative(d decimal.Decimal) bool {
	return d.LessThan(decimal.Zero)
}

// Max retorna o maior entre dois decimals
func Max(a, b decimal.Decimal) decimal.Decimal {
	if a.GreaterThan(b) {
		return a
	}
	return b
}

// Min retorna o menor entre dois decimals
func Min(a, b decimal.Decimal) decimal.Decimal {
	if a.LessThan(b) {
		return a
	}
	return b
}

// NullDecimal é um helper para trabalhar com decimal.NullDecimal
type NullDecimal struct {
	decimal.NullDecimal
}

// NewNullDecimal cria um NullDecimal válido
func NewNullDecimal(d decimal.Decimal) NullDecimal {
	return NullDecimal{
		NullDecimal: decimal.NullDecimal{
			Decimal: d,
			Valid:   true,
		},
	}
}

// NewNullDecimalFromString cria NullDecimal a partir de string
func NewNullDecimalFromString(s string) (NullDecimal, error) {
	if s == "" {
		return NullDecimal{}, nil
	}

	d, err := ParseBrazilianCurrency(s)
	if err != nil {
		return NullDecimal{}, err
	}

	return NewNullDecimal(d), nil
}

// MustNewNullDecimalFromString converte ou retorna zero
func MustNewNullDecimalFromString(s string) NullDecimal {
	nd, _ := NewNullDecimalFromString(s)
	return nd
}

// Value implementa driver.Valuer para salvar no banco
func (nd NullDecimal) Value() (driver.Value, error) {
	if !nd.Valid {
		return nil, nil
	}
	return nd.Decimal.Value()
}

// Scan implementa sql.Scanner para ler do banco
func (nd *NullDecimal) Scan(value interface{}) error {
	return nd.NullDecimal.Scan(value)
}

// String retorna representação em string
func (nd NullDecimal) String() string {
	if !nd.Valid {
		return ""
	}
	return FormatBrazilianCurrency(nd.Decimal)
}

// StringWithSymbol retorna com símbolo R$
func (nd NullDecimal) StringWithSymbol() string {
	if !nd.Valid {
		return "R$ 0,00"
	}
	return FormatBrazilianCurrencyWithSymbol(nd.Decimal)
}

// Float64 retorna float64 ou 0
func (nd NullDecimal) Float64() float64 {
	if !nd.Valid {
		return 0
	}
	f, _ := nd.Decimal.Float64()
	return f
}
