// src/services/alertaService.js
import api from './apiClient';

// tenta achar o token salvo pelo login
function getToken() {
  try {
    const byStorage = localStorage.getItem('userToken');
    if (byStorage) return byStorage;

    const auth = api?.defaults?.headers?.common?.Authorization || '';
    if (auth.toLowerCase().startsWith('bearer ')) {
      return auth.slice(7).trim();
    }
  } catch {}
  return '';
}

// base para SSE: garantir /api/v1 quando base é origem absoluta
function getBase() {
  let base = api?.defaults?.baseURL || '/api/v1';
  base = String(base || '').trim();
  if (/^https?:\/\//i.test(base)) {
    try {
      const u = new URL(base);
      const path = (u.pathname || '/').replace(/\/$/, '');
      if (/^\/api(\/|$)/i.test(path)) {
        return u.origin + path;
      }
      return u.origin + '/api/v1';
    } catch {
      return '/api/v1';
    }
  }
  if (!base.startsWith('/')) base = '/' + base;
  if (!/^\/api(\/|$)/i.test(base)) base = '/api/v1';
  return base.replace(/\/$/, '');
}

// === CONTAGEM (fallback) ===
// backend não tem endpoint de count -> filtra os não lidos
export async function getUnreadCount() {
  try {
    const { data } = await api.get('/alertas');
    if (Array.isArray(data)) {
      return data.filter((a) => !a.lido && a.lido !== true).length;
    }
  } catch (e) {
    console.warn('[alertaService] getUnreadCount falhou:', e?.message);
  }
  return 0;
}

// === SSE ===
// Abre EventSource com token na query (?token=...). EventSource nativo não envia Authorization.
export function connectAlertasSSE() {
  const base = getBase();
  const token = getToken();
  const url = `${base}/alertas/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;

  const es = new EventSource(url);
  return es;
}

// === Consulta de alertas não lidos (com data_alerta) ===
export async function getUnreadAlertas() {
  try {
    const { data } = await api.get('/alertas?unread=1');
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

// Marcar como lidos
export async function marcarAlertasComoLidos(ids = []) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  await api.post('/alertas/marcar-lido', { alerta_ids: ids });
}

