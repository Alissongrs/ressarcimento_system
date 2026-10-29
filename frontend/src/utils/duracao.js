// horas → texto curto ("45 min", "4 h", "17 dias")
export function fmtDuracao(h) {
  if (h == null || Number.isNaN(Number(h))) return '—';
  const v = Number(h);
  if (v < 1) return `${Math.max(1, Math.round(v * 60))} min`;
  if (v < 48) return `${Math.round(v)} h`;
  return `${Math.round(v / 24)} dias`;
}
