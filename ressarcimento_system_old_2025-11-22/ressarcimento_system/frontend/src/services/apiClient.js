import axios from 'axios';

// Cliente Axios padronizado
// - Preserva URLs absolutas (http/https)
// - Prefixa URLs relativas com /api/v1/
// - Anexa Authorization: Bearer <token> quando existir em localStorage
// Use caminhos relativos; o interceptor já normaliza para "/api/v1/..."
// Manter baseURL vazio evita URLs quebradas como "http:localhost:5173apiv1..."
const api = axios.create({ baseURL: '' });

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
    return config;
  },
  (error) => Promise.reject(error)
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
