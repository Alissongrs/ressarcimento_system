// Utilitários de normalização para valores monetários em BRL
export function normalizeDecimalValue(val) {
  if (val === null || val === undefined) return '';
  const s = String(val).trim();
  if (!s) return '';

  if (/^\d+\.\d{2}$/.test(s)) {
    return s;
  }

  if (/^\d{1,3}(\.\d{3})*,\d{2}$/.test(s)) {
    return s.replace(/\./g, '').replace(',', '.');
  }

  if (/^\d+,\d{2}$/.test(s)) {
    return s.replace(',', '.');
  }

  const num = Number.parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(num) ? num.toFixed(2) : '';
}

export function normalizeCreditoValue(val) {
  const normalized = normalizeDecimalValue(val);
  if (!normalized) return '';
  const num = Number.parseFloat(normalized);
  if (!Number.isFinite(num)) return '';

  if (num > 500000) {
    const corrected = (num / 100).toFixed(2);
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`Valor anormalmente grande detectado (${num}). Corrigindo para ${corrected}.`);
    }
    return corrected;
  }

  return num.toFixed(2);
}

export function toNumberBR(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;

  const hasComma = raw.includes(',');
  const hasDot = raw.includes('.');
  let s = raw;

  if (hasComma && hasDot) {
    // 1.234,56 -> 1234.56
    s = raw.replace(/\./g, '').replace(',', '.');
  } else if (hasComma && !hasDot) {
    // 1234,56 -> 1234.56
    s = raw.replace(',', '.');
  } else if (hasDot && !hasComma) {
    // 1.234 or 1234.56
    s = /^\d{1,3}(\.\d{3})+$/.test(raw) ? raw.replace(/\./g, '') : raw;
  }

  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
