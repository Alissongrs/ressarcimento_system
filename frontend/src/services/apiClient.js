import axios from 'axios';

// Cliente Axios padronizado
// - Preserva URLs absolutas (http/https)
// - Prefixa URLs relativas com /api/v1/
// - Anexa Authorization: Bearer <token> quando existir em localStorage
// Use caminhos relativos; o interceptor já normaliza para "/api/v1/..."
// Manter baseURL vazio evita URLs quebradas como "http:localhost:5173apiv1..."
const api = axios.create({ baseURL: '' });

let savingCount = 0;
const isWriteMethod = (method) => {
  const m = String(method || 'get').toLowerCase();
  return !['get', 'head', 'options'].includes(m);
};
const getSavingCount = () => {
  if (typeof window !== 'undefined' && typeof window.__appSavingCount === 'number') {
    return window.__appSavingCount;
  }
  return savingCount;
};
const setSavingCount = (next) => {
  savingCount = next;
  if (typeof window !== 'undefined') window.__appSavingCount = next;
  notifySaving();
};
const notifySaving = () => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('app-saving', { detail: { count: getSavingCount() } }));
};

if (import.meta?.env?.DEV) {
  // eslint-disable-next-line no-console
  console.info('[apiClient] baseURL =', api.defaults.baseURL);
}

api.interceptors.request.use(
  (config) => {
    try {
      const token = localStorage.getItem('userToken') || localStorage.getItem('token');
      if (token) {
        config.headers = { ...(config.headers || {}), Authorization: `Bearer ${token}` };
      }
    } catch {}

    if (typeof config.url === 'string') {
      let u = config.url.trim();
      if (/^https?:\/\//i.test(u)) {
        // absoluta
      } else if (u.startsWith('/')) {
        // Se não começar com /api/, prefixa /api/v1
        if (!/^\/api(\/|$)/i.test(u)) {
          u = '/api/v1' + u;
        }
      } else {
        // relativa → prefixar /api/v1/
        u = '/api/v1/' + u.replace(/^\/+/, '');
      }
      config.url = u;
    }
    if (isWriteMethod(config.method)) {
      setSavingCount(getSavingCount() + 1);
    }
    return config;
  },
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (resp) => {
    if (isWriteMethod(resp?.config?.method)) {
      setSavingCount(Math.max(0, getSavingCount() - 1));
    }
    return resp;
  },
  (error) => {
    if (isWriteMethod(error?.config?.method)) {
      setSavingCount(Math.max(0, getSavingCount() - 1));
    }
    return Promise.reject(error);
  }
);

export default api;

// Retry leve para quedas momentâneas de rede (ex.: net::ERR_NETWORK_CHANGED)
api.interceptors.response.use(
  (resp) => resp,
  async (error) => {
    try {
      const cfg = error?.config || {};
      const code = error?.code || '';
      const msg = String(error?.message || '').toLowerCase();
      const transient = code === 'ERR_NETWORK' || msg.includes('network changed');
      if (!transient) throw error;

      cfg.__retryCount = (cfg.__retryCount || 0) + 1;
      if (cfg.__retryCount > 2) throw error; // até 2 tentativas

      await new Promise((r) => setTimeout(r, 400 * cfg.__retryCount));
      return api(cfg);
    } catch (e) {
      return Promise.reject(error);
    }
  }
);
