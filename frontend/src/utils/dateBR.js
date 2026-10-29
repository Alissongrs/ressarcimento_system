// dateBR.js — formatação consistente de data/hora em fuso America/Sao_Paulo (BRT, UTC-3).
//
// Por que isso existe: o banco PROD grava timestamps em UTC (TIMESTAMP). O backend retorna
// strings ISO com "Z" (UTC). Se cada front rodar `new Date(...).getHours()`, depende do fuso
// do navegador do usuário (pode ser BRT, UTC, GMT, etc) → resultado inconsistente.
//
// Aqui forçamos `timeZone: 'America/Sao_Paulo'` em Intl.DateTimeFormat — sempre BR independente
// de onde o navegador esteja rodando.

const TZ = 'America/Sao_Paulo';

// Parser tolerante: aceita ISO ("2026-06-29T15:16:43.000Z"), ISO sem Z, "YYYY-MM-DD",
// "YYYY-MM-DD HH:MM:SS", Date e timestamp numérico.
function toDate(input) {
  if (input == null || input === '') return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === 'number') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(input).trim();
  if (!s) return null;
  // "YYYY-MM-DD" puro: tratar como meia-noite local BRT (não UTC), pra não voltar 1 dia
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 3, 0, 0)); // 03:00 UTC = 00:00 BRT
  }
  // "YYYY-MM-DD HH:MM:SS" sem TZ — assumir BRT (comum em retornos antigos)
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    // adiciona offset -03:00 explícito pra forçar interpretação BRT
    const iso = s.replace(' ', 'T') + '-03:00';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Formata como "dd/mm/aaaa"
export function fmtDataBR(input) {
  const d = toDate(input);
  if (!d) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

// Formata como "dd/mm/aaaa HH:mm"
export function fmtDataHoraBR(input) {
  const d = toDate(input);
  if (!d) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

// Formata como "dd/mm/aaaa HH:mm:ss"
export function fmtDataHoraSegBR(input) {
  const d = toDate(input);
  if (!d) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}

// "x dias atrás" — diff em dias entre input e hoje (em BRT).
export function diasDesdeBR(input) {
  const d = toDate(input);
  if (!d) return null;
  const hoje = new Date();
  const diff = Math.floor((hoje - d) / (1000 * 60 * 60 * 24));
  return diff;
}
