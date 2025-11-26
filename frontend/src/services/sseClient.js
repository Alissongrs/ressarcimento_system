function resolveOrigin() {
  const raw = (import.meta?.env?.VITE_API_BASE_URL ?? '/api/v1').toString().trim();
  const fixed = raw
    .replace(/^http:(?!\/\/)/, 'http://')
    .replace(/^https:(?!\/\/)/, 'https://');
  if (/^https?:\/\//.test(fixed)) {
    try { return new URL(fixed).origin; } catch { return window.location.origin; }
  }
  return window.location.origin;
}

export function subscribeProcesso(processoId, token, onUpdate) {
  if (!processoId || !token) return () => {};
  const origin = resolveOrigin();
  const url = new URL(`/api/v1/processos/${encodeURIComponent(processoId)}/events`, origin);
  url.searchParams.set('token', token);
  const es = new EventSource(url.toString());
  const handler = (ev) => { try { const data = JSON.parse(ev.data || '{}'); onUpdate?.(data); } catch {} };
  es.addEventListener('update', handler);
  es.onerror = () => { try { es.close(); } catch {} };
  return () => { try { es.close(); } catch {} };
}

export function subscribeGlobal(token, onUpdate) {
  if (!token) return () => {};
  const origin = resolveOrigin();
  const url = new URL('/api/v1/events', origin);
  url.searchParams.set('token', token);
  const es = new EventSource(url.toString());
  const handler = (ev) => { try { const data = JSON.parse(ev.data || '{}'); onUpdate?.(data); } catch {} };
  es.addEventListener('update', handler);
  es.onerror = () => { try { es.close(); } catch {} };
  return () => { try { es.close(); } catch {} };
}
