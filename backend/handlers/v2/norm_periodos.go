package v2

import "ressarcimento-backend/periodosnorm"

// normalizarPeriodosStore normaliza periodos_irregularidade para o formato canônico
// [{"ano":Y,"mes":M},...] antes de gravar. Delega ao pacote compartilhado periodosnorm.
func normalizarPeriodosStore(input string) string {
	return periodosnorm.Normalizar(input)
}
