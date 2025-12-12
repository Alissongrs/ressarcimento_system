// frontend/src/utils/currency.js

/**
 * Formata número para moeda brasileira
 * @param {number|string} value - Valor a ser formatado
 * @param {boolean} showSymbol - Se deve exibir símbolo R$
 * @returns {string} Valor formatado (ex: "R$ 1.234,56" ou "1.234,56")
 */
export function formatCurrency(value, showSymbol = true) {
  if (value === null || value === undefined || value === '') {
    return showSymbol ? 'R$ 0,00' : '0,00';
  }

  const num = typeof value === 'string' ? parseFloat(value) : value;

  if (isNaN(num)) {
    return showSymbol ? 'R$ 0,00' : '0,00';
  }

  const formatted = new Intl.NumberFormat('pt-BR', {
    style: showSymbol ? 'currency' : 'decimal',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);

  return formatted;
}

/**
 * Parse moeda brasileira para número
 * Remove R$, espaços, pontos (separador de milhar) e troca vírgula por ponto
 * @param {string} value - Valor formatado (ex: "R$ 1.234,56" ou "1.234,56")
 * @returns {number} Valor numérico
 */
export function parseCurrency(value) {
  if (!value) return 0;

  const cleaned = String(value)
    .replace(/[R$\s]/g, '')  // Remove R$ e espaços
    .replace(/\./g, '')       // Remove separador de milhar
    .replace(',', '.');       // Troca vírgula por ponto

  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Valida se é um valor monetário válido
 * @param {string} value
 * @param {boolean} allowNegative - Se permite valores negativos
 * @returns {boolean}
 */
export function isValidCurrency(value, allowNegative = false) {
  const num = parseCurrency(value);
  if (isNaN(num)) return false;
  if (!allowNegative && num < 0) return false;
  return true;
}

/**
 * Formata input enquanto usuário digita
 * Aplica formatação de moeda em tempo real
 * @param {string} value - Valor sendo digitado
 * @returns {string} Valor formatado parcialmente
 */
export function formatCurrencyInput(value) {
  if (!value) return '';

  // Remove tudo exceto dígitos
  const digits = value.replace(/\D/g, '');

  if (digits === '') return '';

  // Converte para número (em centavos)
  const num = parseInt(digits, 10);

  // Divide por 100 para ter o valor real
  const realValue = num / 100;

  // Formata
  return formatCurrency(realValue, false);
}

/**
 * Soma múltiplos valores monetários
 * @param {...number} values - Valores a somar
 * @returns {number} Soma total com 2 casas decimais
 */
export function sumCurrency(...values) {
  const sum = values.reduce((acc, val) => {
    const num = typeof val === 'string' ? parseCurrency(val) : val;
    return acc + (isNaN(num) ? 0 : num);
  }, 0);

  // Arredonda para 2 casas decimais (evita problemas de float)
  return Math.round(sum * 100) / 100;
}

/**
 * Subtrai valores monetários
 * @param {number} minuend - Valor do qual subtrair
 * @param {...number} subtrahends - Valores a subtrair
 * @returns {number} Diferença com 2 casas decimais
 */
export function subtractCurrency(minuend, ...subtrahends) {
  const minuendNum = typeof minuend === 'string' ? parseCurrency(minuend) : minuend;

  const sum = subtrahends.reduce((acc, val) => {
    const num = typeof val === 'string' ? parseCurrency(val) : val;
    return acc + (isNaN(num) ? 0 : num);
  }, 0);

  const result = minuendNum - sum;
  return Math.round(result * 100) / 100;
}

/**
 * Multiplica valor monetário
 * @param {number} value - Valor base
 * @param {number} multiplier - Multiplicador
 * @returns {number} Produto com 2 casas decimais
 */
export function multiplyCurrency(value, multiplier) {
  const valueNum = typeof value === 'string' ? parseCurrency(value) : value;
  const result = valueNum * multiplier;
  return Math.round(result * 100) / 100;
}

/**
 * Divide valor monetário
 * @param {number} dividend - Dividendo
 * @param {number} divisor - Divisor
 * @returns {number} Quociente com 2 casas decimais
 */
export function divideCurrency(dividend, divisor) {
  if (divisor === 0) return 0;

  const dividendNum = typeof dividend === 'string' ? parseCurrency(dividend) : dividend;
  const result = dividendNum / divisor;
  return Math.round(result * 100) / 100;
}

/**
 * Calcula porcentagem de um valor
 * @param {number} value - Valor base
 * @param {number} percentage - Porcentagem (ex: 10 para 10%)
 * @returns {number} Valor da porcentagem
 */
export function percentageOf(value, percentage) {
  const valueNum = typeof value === 'string' ? parseCurrency(value) : value;
  const result = (valueNum * percentage) / 100;
  return Math.round(result * 100) / 100;
}

/**
 * Formata valor compacto (ex: "R$ 1,2 mil", "R$ 3,5 mi")
 * @param {number} value - Valor a formatar
 * @returns {string} Valor compacto
 */
export function formatCurrencyCompact(value) {
  if (value === null || value === undefined || value === '') {
    return 'R$ 0';
  }

  const num = typeof value === 'string' ? parseFloat(value) : value;

  if (isNaN(num)) {
    return 'R$ 0';
  }

  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(num);
}

/**
 * Retorna classe CSS baseada no valor (positivo/negativo/zero)
 * @param {number} value - Valor a verificar
 * @returns {string} Nome da classe CSS
 */
export function getCurrencyColorClass(value) {
  const num = typeof value === 'string' ? parseCurrency(value) : value;

  if (isNaN(num) || num === 0) return 'text-gray-600';
  return num > 0 ? 'text-green-600' : 'text-red-600';
}

/**
 * Hook React para formatação de moeda
 * Uso: const { format, parse, isValid } = useCurrency();
 */
export function useCurrency() {
  return {
    format: formatCurrency,
    parse: parseCurrency,
    isValid: isValidCurrency,
    sum: sumCurrency,
    subtract: subtractCurrency,
    multiply: multiplyCurrency,
    divide: divideCurrency,
    percentage: percentageOf,
    formatCompact: formatCurrencyCompact,
    getColorClass: getCurrencyColorClass,
  };
}
