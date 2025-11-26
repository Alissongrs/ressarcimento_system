export function brDateTime(input) {
  try {
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d)) return '';
    return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } catch {
    return '';
  }
}

export function brDate(input, opts = {}) {
  try {
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', ...opts });
  } catch {
    return '';
  }
}

