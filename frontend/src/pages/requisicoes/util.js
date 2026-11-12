// src/pages/requisicoes/util.js — extraído de Requisicoes.jsx em 12/11/2026 (melhoria 2: arquivos menores).
// Conteúdo idêntico ao original; só mudou de arquivo e ganhou export/import.

import { useEffect, useState } from 'react';


// =======================
// HELPERS (perf + util)
// =======================
export const norm = (v) => {
  try {
    return String(v || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  } catch {
    return String(v || '').toLowerCase();
  }
};

// =======================
// Mojibake / encoding repair (safe)
// =======================
// Fixes strings like "Requisi\u00C3\u00A7\u00C3\u00A3o" (UTF-8 bytes interpreted as latin1),
// and even double-encoded variants like "Requisi\u00C3\u0192\u00C2\u00A7\u00C3\u0192\u00C2\u00A3o".
export const looksLikeMojibake = (v) => {
  if (v == null) return false;
  const s = String(v);
  // Ã + continuation, Â + continuation, or the Unicode replacement char
  return /[\u00C3\u00C2][\u0080-\u00BF]|\uFFFD/.test(s) || s.includes('\u00C3\u0192\u00C2');
};

export const latin1ToUtf8 = (v) => {
  try {
    const s = String(v ?? '');
    const bytes = Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return v;
  }
};

export const fixMojibake = (v) => {
  if (v == null) return v;
  const s0 = String(v);
  if (!looksLikeMojibake(s0)) return v;

  let s = s0;
  // up to 2 passes handles double-encoding
  for (let i = 0; i < 2; i++) {
    const dec = latin1ToUtf8(s);
    if (dec === s) break;
    s = dec;
  }

  // normalize NBSP -> space (common after copy/paste)
  s = s.replace(/\u00A0/g, ' ');

  return s;
};

export const unwrapDbValue = (value) => {
  try {
    if (value == null) return '';
    if (typeof value === 'object') {
      if (value.Valid === false) return '';
      if (typeof value.String === 'string') return fixMojibake(value.String);
      if (typeof value.Int64 === 'number') return String(value.Int64);
      if (typeof value.Float64 === 'number') return String(value.Float64);
    }
    if (typeof value === 'string') return fixMojibake(value);
    return String(value);
  } catch {
    return '';
  }
};


export const pickFirst = (obj, keys, fallback = '') => {
  for (const k of keys) {
    const v = unwrapDbValue(obj?.[k]);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return fallback;
};

export const normalizeKanbanName = (value) => {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('indefer')) return 'Indeferidos';
  if (s.includes('defer')) return 'Deferidos';
  if (s.includes('fluxo')) return 'Fluxo de Ressarcimento';
  if (s.includes('fatur')) return 'Faturamento';
  if (s.includes('conclu')) return 'Concluídos';
  if (s.includes('suspens')) return 'Suspensos';
  if (s.includes('ativo')) return 'Ativos';
  return '';
};

export const normalizeReqStatusValue = (value) => {
  const n = norm(unwrapDbValue(value));
  if (n.includes('nova requisicao') || n.includes('pendente')) return 'Nova Requisição';
  if (n.includes('analise')) return 'Em Análise';
  if (n.includes('aprov')) return 'Aprovado';
  if (n.includes('rejeit')) return 'Rejeitado';
  return value || '';
};

export const toISODateFromPt = (pt) => {
  if (!pt) return '';
  const s = String(pt).trim();
  const m = s.match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/);
  if (!m) return s;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
};

export const toISODateTimeFromPt = (pt) => {
  if (!pt) return '';
  const s = String(pt).trim();
  const m = s.match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*$/);
  if (!m) return s;
  const [, d, mo, y, h, mi] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi.padStart(2, '0')}`;
};

export const useTimer = (refreshInterval = 60000) => {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), refreshInterval);
    return () => clearInterval(id);
  }, [refreshInterval]);
  return time;
};
