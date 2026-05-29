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

export function subscribeProcesso(processoId, _token, onUpdate) {
  if (!processoId) return () => {};
  const origin = resolveOrigin();
  const url = new URL(`/api/v1/processos/${encodeURIComponent(processoId)}/events`, origin);
  // Cookie auth_token enviado automaticamente via withCredentials
  const es = new EventSource(url.toString(), { withCredentials: true });
  const handler = (ev) => { try { const data = JSON.parse(ev.data || '{}'); onUpdate?.(data); } catch {} };
  es.addEventListener('update', handler);
  es.onerror = () => { try { es.close(); } catch {} };
  return () => { try { es.close(); } catch {} };
}

export function subscribeGlobal(_token, onUpdate) {
  const origin = resolveOrigin();
  const url = new URL('/api/v1/events', origin);
  const es = new EventSource(url.toString(), { withCredentials: true });
  const handler = (ev) => { try { const data = JSON.parse(ev.data || '{}'); onUpdate?.(data); } catch {} };
  es.addEventListener('update', handler);
  es.onerror = () => { try { es.close(); } catch {} };
  return () => { try { es.close(); } catch {} };
}
