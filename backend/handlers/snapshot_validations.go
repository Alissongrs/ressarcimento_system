package handlers

import (
	"log"
	"regexp"
	"time"
)

// SnapshotValidationError representa um erro de validação
type SnapshotValidationError struct {
	Field   string
	Message string
}

// ValidateProcessoSnapshotUpdate valida os dados antes de atualizar
func ValidateProcessoSnapshotUpdate(update *ProcessoSnapshotUpdate) []SnapshotValidationError {
	var errors []SnapshotValidationError

	if update == nil {
		return append(errors, SnapshotValidationError{
			Field:   "root",
			Message: "Dados de atualização são obrigatórios",
		})
	}

	// ========================================================================
	// Validações de campos texto
	// ========================================================================

	// UC: deve ter 11 dígitos ou estar vazio
	if update.UC != nil && *update.UC != "" {
		if !isValidUC(*update.UC) {
			errors = append(errors, SnapshotValidationError{
				Field:   "uc",
				Message: "UC deve ter 11 dígitos",
			})
		}
	}

	// Cliente: máximo 255 caracteres
	if update.Cliente != nil && *update.Cliente != "" {
		if len(*update.Cliente) > 255 {
			errors = append(errors, SnapshotValidationError{
				Field:   "cliente",
				Message: "Cliente não pode ter mais de 255 caracteres",
			})
		}
	}

	// Concessionária: máximo 255 caracteres
	if update.Concessionaria != nil && *update.Concessionaria != "" {
		if len(*update.Concessionaria) > 255 {
			errors = append(errors, SnapshotValidationError{
				Field:   "concessionaria",
				Message: "Concessionária não pode ter mais de 255 caracteres",
			})
		}
	}

	// ========================================================================
	// Validações de suspensão
	// ========================================================================

	// Se suspenso = 1, motivo é obrigatório
	if update.Suspensao != nil && *update.Suspensao == 1 {
		if update.SuspensaoMotivo == nil || *update.SuspensaoMotivo == "" {
			errors = append(errors, SnapshotValidationError{
				Field:   "suspenso_motivo",
				Message: "Motivo de suspensão é obrigatório quando suspenso = 1",
			})
		}

		// Se suspensão está ativa, deve haver data de término
		if update.SuspensaoMotivo != nil && *update.SuspensaoMotivo != "" {
			log.Printf("Validação: suspenso motivo preenchido: %s", *update.SuspensaoMotivo)
		}
	}

	// ========================================================================
	// Validações de valores monetários
	// ========================================================================

	// Crédito Simples: deve ser positivo
	if update.CreditoSimples != nil {
		if *update.CreditoSimples < 0 {
			errors = append(errors, SnapshotValidationError{
				Field:   "credito_simples",
				Message: "Crédito simples deve ser positivo",
			})
		}

		// Máximo de R$ 1.000.000,00
		if *update.CreditoSimples > 1000000 {
			errors = append(errors, SnapshotValidationError{
				Field:   "credito_simples",
				Message: "Crédito simples não pode exceder R$ 1.000.000,00",
			})
		}
	}

	// Crédito Dobro: deve ser positivo
	if update.CreditoDobro != nil {
		if *update.CreditoDobro < 0 {
			errors = append(errors, SnapshotValidationError{
				Field:   "credito_dobro",
				Message: "Crédito dobro deve ser positivo",
			})
		}

		// Máximo de R$ 2.000.000,00
		if *update.CreditoDobro > 2000000 {
			errors = append(errors, SnapshotValidationError{
				Field:   "credito_dobro",
				Message: "Crédito dobro não pode exceder R$ 2.000.000,00",
			})
		}
	}

	// Se ambos créditos foram informados, dobro não pode ser menor que simples
	if update.CreditoSimples != nil && update.CreditoDobro != nil &&
		*update.CreditoSimples > 0 && *update.CreditoDobro > 0 {
		if *update.CreditoDobro < *update.CreditoSimples {
			errors = append(errors, SnapshotValidationError{
				Field:   "credito_dobro",
				Message: "Crédito dobro não pode ser menor que crédito simples",
			})
		}
	}

	// Valor de Ressarcimento: deve ser positivo
	if update.ValorRessarcimento != nil {
		if *update.ValorRessarcimento < 0 {
			errors = append(errors, SnapshotValidationError{
				Field:   "valor_ressarcimento",
				Message: "Valor de ressarcimento deve ser positivo",
			})
		}

		// Máximo de R$ 5.000.000,00
		if *update.ValorRessarcimento > 5000000 {
			errors = append(errors, SnapshotValidationError{
				Field:   "valor_ressarcimento",
				Message: "Valor de ressarcimento não pode exceder R$ 5.000.000,00",
			})
		}
	}

	// ========================================================================
	// Validações de datas
	// ========================================================================

	// Data de Devolução: deve ser data válida e não no futuro (muito distante)
	if update.DataDevolucao != nil && *update.DataDevolucao != "" {
		if !isValidDate(*update.DataDevolucao) {
			errors = append(errors, SnapshotValidationError{
				Field:   "data_devolucao",
				Message: "Data de devolução em formato inválido (use YYYY-MM-DD)",
			})
		} else if isDateTooFar(*update.DataDevolucao) {
			errors = append(errors, SnapshotValidationError{
				Field:   "data_devolucao",
				Message: "Data de devolução não pode estar muito no futuro",
			})
		}
	}

	// Data de Envio Financeiro: deve ser data válida
	if update.DataEnvioFinanceiro != nil && *update.DataEnvioFinanceiro != "" {
		if !isValidDate(*update.DataEnvioFinanceiro) {
			errors = append(errors, SnapshotValidationError{
				Field:   "data_envio_financeiro",
				Message: "Data de envio financeiro em formato inválido (use YYYY-MM-DD)",
			})
		}
	}

	// Data de Envio não pode ser antes de Data de Devolução (se ambas informadas)
	if update.DataDevolucao != nil && update.DataEnvioFinanceiro != nil &&
		*update.DataDevolucao != "" && *update.DataEnvioFinanceiro != "" {
		if isDateBefore(*update.DataEnvioFinanceiro, *update.DataDevolucao) {
			errors = append(errors, SnapshotValidationError{
				Field:   "data_envio_financeiro",
				Message: "Data de envio não pode ser antes da data de devolução",
			})
		}
	}

	// ========================================================================
	// Validações de enum
	// ========================================================================

	// Forma de Devolução: deve estar no enum
	if update.FormaDevolucao != nil && *update.FormaDevolucao != "" {
		validFormas := map[string]bool{"Fatura": true, "GD": true, "Deposito": true}
		if !validFormas[*update.FormaDevolucao] {
			errors = append(errors, SnapshotValidationError{
				Field:   "forma_devolucao",
				Message: "Forma de devolução inválida. Válidas: Fatura, GD, Deposito",
			})
		}
	}

	// ========================================================================
	// Validações de integridade
	// ========================================================================

	// Se forneceu valor de ressarcimento, deve ter forma de devolução
	if update.ValorRessarcimento != nil && *update.ValorRessarcimento > 0 {
		if update.FormaDevolucao == nil || *update.FormaDevolucao == "" {
			errors = append(errors, SnapshotValidationError{
				Field:   "forma_devolucao",
				Message: "Forma de devolução é obrigatória quando há valor de ressarcimento",
			})
		}
	}

	return errors
}

// ============================================================================
// Funções auxiliares de validação
// ============================================================================

// isValidUC verifica se UC tem 11 dígitos
func isValidUC(uc string) bool {
	regex := regexp.MustCompile(`^\d{11}$`)
	return regex.MatchString(uc)
}

// isValidDate verifica se a data está em formato YYYY-MM-DD
func isValidDate(dateStr string) bool {
	_, err := time.Parse("2006-01-02", dateStr)
	return err == nil
}

// isDateTooFar verifica se a data está muito no futuro (mais de 5 anos)
func isDateTooFar(dateStr string) bool {
	t, err := time.Parse("2006-01-02", dateStr)
	if err != nil {
		return false
	}

	maxFuture := time.Now().AddDate(5, 0, 0)
	return t.After(maxFuture)
}

// isDateBefore compara duas datas (retorna true se date1 < date2)
func isDateBefore(date1, date2 string) bool {
	t1, err1 := time.Parse("2006-01-02", date1)
	t2, err2 := time.Parse("2006-01-02", date2)

	if err1 != nil || err2 != nil {
		return false
	}

	return t1.Before(t2)
}

// FormatValidationErrors formata erros de validação para resposta JSON
func FormatValidationErrors(errors []SnapshotValidationError) map[string]interface{} {
	if len(errors) == 0 {
		return nil
	}

	errMap := make(map[string][]string)
	for _, err := range errors {
		errMap[err.Field] = append(errMap[err.Field], err.Message)
	}

	return map[string]interface{}{
		"validation_errors": errMap,
		"error_count":       len(errors),
	}
}

// LogValidationErrors registra os erros de validação no log
func LogValidationErrors(idProcesso int, errors []SnapshotValidationError) {
	if len(errors) == 0 {
		return
	}

	log.Printf("[VALIDATION] Processo %d: %d erro(s) encontrado(s)", idProcesso, len(errors))
	for i, err := range errors {
		log.Printf("  [%d] %s: %s", i+1, err.Field, err.Message)
	}
}
