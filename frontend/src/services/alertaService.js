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

export async function listAlertas(params = {}) {
  try {
    const { data } = await api.get('/alertas', { params });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[alertaService] listAlertas falhou:', e?.message);
    return [];
  }
}

export async function criarAlerta(input = {}) {
  const { data } = await api.post('/alertas', input);
  return data;
}

export async function atualizarAlerta(alertaId, input = {}) {
  const { data } = await api.put(`/alertas/${alertaId}`, input);
  return data;
}

export async function excluirAlerta(alertaId) {
  const { data } = await api.delete(`/alertas/${alertaId}`);
  return data;
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
    return await listAlertas({ unread: 1 });
  } catch {
    return [];
  }
}

// Marcar como lidos
export async function marcarAlertasComoLidos(ids = []) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  await api.post('/alertas/marcar-lido', { alerta_ids: ids });
}
