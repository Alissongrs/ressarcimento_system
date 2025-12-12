// frontend/src/components/CurrencyInput.jsx
import React, { useState, useEffect, useRef } from 'react';
import { formatCurrency, parseCurrency, formatCurrencyInput } from '../utils/currency';

/**
 * Componente de input para valores monetários brasileiros
 * Formata automaticamente enquanto o usuário digita
 *
 * @param {Object} props
 * @param {number} props.value - Valor numérico
 * @param {function} props.onChange - Callback com valor numérico
 * @param {string} props.placeholder - Placeholder do input
 * @param {boolean} props.disabled - Se está desabilitado
 * @param {string} props.className - Classes CSS adicionais
 * @param {boolean} props.required - Se é obrigatório
 * @param {boolean} props.allowNegative - Se permite valores negativos
 * @param {number} props.min - Valor mínimo
 * @param {number} props.max - Valor máximo
 * @param {string} props.label - Label do campo
 * @param {string} props.error - Mensagem de erro
 */
export function CurrencyInput({
  value,
  onChange,
  placeholder = '0,00',
  disabled = false,
  className = '',
  required = false,
  allowNegative = false,
  min,
  max,
  label,
  error,
  name,
  id,
}) {
  const [displayValue, setDisplayValue] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef(null);

  // Atualiza display value quando value prop muda (externamente)
  useEffect(() => {
    if (value !== undefined && value !== null && !isFocused) {
      setDisplayValue(formatCurrency(value, false));
    }
  }, [value, isFocused]);

  const handleFocus = () => {
    setIsFocused(true);
  };

  const handleChange = (e) => {
    const input = e.target.value;

    // Remove tudo exceto dígitos e vírgula/ponto
    let cleaned = input.replace(/[^\d,\.]/g, '');

    // Permite apenas uma vírgula ou ponto
    const commaCount = (cleaned.match(/,/g) || []).length;
    const dotCount = (cleaned.match(/\./g) || []).length;

    if (commaCount > 1) {
      // Remove vírgulas extras
      const firstCommaIndex = cleaned.indexOf(',');
      cleaned = cleaned.slice(0, firstCommaIndex + 1) + cleaned.slice(firstCommaIndex + 1).replace(/,/g, '');
    }

    if (dotCount > 0) {
      // Remove pontos (separador de milhar não é permitido na digitação)
      cleaned = cleaned.replace(/\./g, '');
    }

    setDisplayValue(cleaned);

    // Converte para número e chama onChange
    const numValue = parseCurrency(cleaned);

    // Validações
    if (!allowNegative && numValue < 0) {
      return;
    }

    if (min !== undefined && numValue < min) {
      return;
    }

    if (max !== undefined && numValue > max) {
      return;
    }

    if (onChange) {
      onChange(numValue);
    }
  };

  const handleBlur = () => {
    setIsFocused(false);

    // Formata ao perder foco
    const num = parseCurrency(displayValue);
    setDisplayValue(formatCurrency(num, false));
  };

  const handleKeyDown = (e) => {
    // Permite: backspace, delete, tab, escape, enter
    const allowedKeys = ['Backspace', 'Delete', 'Tab', 'Escape', 'Enter'];

    // Permite: Ctrl/Cmd + A/C/V/X
    if (
      (e.ctrlKey || e.metaKey) &&
      ['a', 'c', 'v', 'x'].includes(e.key.toLowerCase())
    ) {
      return;
    }

    // Permite: setas de navegação
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      return;
    }

    if (allowedKeys.includes(e.key)) {
      return;
    }

    // Permite: vírgula para decimal
    if (e.key === ',' && !displayValue.includes(',')) {
      return;
    }

    // Permite: números
    if (/^\d$/.test(e.key)) {
      return;
    }

    // Bloqueia tudo mais
    e.preventDefault();
  };

  const inputClasses = `
    w-full px-3 py-2 pl-10
    border rounded-lg
    focus:outline-none focus:ring-2 focus:ring-blue-500
    ${disabled ? 'bg-gray-100 cursor-not-allowed' : 'bg-white'}
    ${error ? 'border-red-500' : 'border-gray-300'}
    ${className}
  `.trim();

  return (
    <div className="space-y-1">
      {label && (
        <label
          htmlFor={id || name}
          className="block text-sm font-medium text-gray-700"
        >
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}

      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none">
          R$
        </span>

        <input
          ref={inputRef}
          id={id || name}
          name={name}
          type="text"
          value={displayValue}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          className={inputClasses}
          autoComplete="off"
        />
      </div>

      {error && (
        <p className="text-sm text-red-500 mt-1">{error}</p>
      )}

      {!error && (min !== undefined || max !== undefined) && (
        <p className="text-xs text-gray-500 mt-1">
          {min !== undefined && max !== undefined && (
            <>
              Valor deve estar entre {formatCurrency(min)} e {formatCurrency(max)}
            </>
          )}
          {min !== undefined && max === undefined && (
            <>
              Valor mínimo: {formatCurrency(min)}
            </>
          )}
          {min === undefined && max !== undefined && (
            <>
              Valor máximo: {formatCurrency(max)}
            </>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * Componente para exibir valor monetário formatado (read-only)
 */
export function CurrencyDisplay({
  value,
  showSymbol = true,
  className = '',
  compact = false,
  colorize = false,
}) {
  const { format, formatCompact, getColorClass } = useCurrency();

  const formatted = compact ? formatCompact(value) : format(value, showSymbol);
  const colorClass = colorize ? getColorClass(value) : '';

  return (
    <span className={`${colorClass} ${className}`.trim()}>
      {formatted}
    </span>
  );
}

// Re-exporta hook
import { useCurrency } from '../utils/currency';

export default CurrencyInput;
