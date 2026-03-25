import axios from 'axios';

// Cliente Axios padronizado
// - Preserva URLs absolutas (http/https)
// - Prefixa URLs relativas com /api/v1/
// - Anexa Authorization: Bearer <token> quando existir em localStorage
// Use caminhos relativos; o interceptor já normaliza para "/api/v1/..."
// Manter baseURL vazio evita URLs quebradas como "http:localhost:5173apiv1..."
const api = axios.create({ baseURL: '' });

const cleanToken = (t) => {
  if (!t) return '';
  return String(t).trim().replace(/^['"]+|['"]+$/g, '');
};

const getToken = () => {
  try {
    return cleanToken(localStorage.getItem('userToken') || '');
  } catch {
    return '';
  }
};

const appendQuery = (url, rawQuery) => {
  if (!rawQuery) return url;
  const clean = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  if (!clean) return url;
  return url + (url.includes('?') ? '&' : '?') + clean;
};

const normalizeUrlQuery = (url) => {
  const idx = url.indexOf('?');
  if (idx === -1) return url;
  const base = url.slice(0, idx);
  const raw = url.slice(idx + 1);
  const parts = raw.split('?').filter(Boolean);
  if (parts.length <= 1) return url;
  return base + '?' + parts.join('&');
};

let savingCount = 0;
const isWriteMethod = (method) => {
  const m = String(method || 'get').toLowerCase();
  return !['get', 'head', 'options'].includes(m);
};
const inFlightWrites = new Map();

const stableStringify = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys.map((k) => `${k}:${stableStringify(value[k])}`).join(',');
  return `{${body}}`;
};

const serializeData = (data) => {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data;
  if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) {
    return data.toString();
  }
  if (typeof FormData !== 'undefined' && data instanceof FormData) {
    const parts = [];
    data.forEach((v, k) => {
      if (typeof File !== 'undefined' && v instanceof File) {
        parts.push(`${k}=@${v.name || 'file'}:${v.size || 0}:${v.type || ''}`);
      } else if (typeof Blob !== 'undefined' && v instanceof Blob) {
        parts.push(`${k}=@blob:${v.size || 0}:${v.type || ''}`);
      } else {
        parts.push(`${k}=${String(v)}`);
      }
    });
    parts.sort();
    return parts.join('&');
  }
  try {
    return stableStringify(data);
  } catch {
    return '';
  }
};

const buildDedupeKey = (config) => {
  const method = String(config?.method || 'get').toLowerCase();
  const url = String(config?.url || '');
  const params = config?.params ? stableStringify(config.params) : '';
  const data = serializeData(config?.data);
  return `${method}|${url}|${params}|${data}`;
};

const originalAdapter = api.defaults.adapter || axios.defaults.adapter;
const getAdapter = typeof axios.getAdapter === 'function' ? axios.getAdapter : null;
const resolveAdapter = (config) => {
  const adapter =
    config.adapter && config.adapter !== dedupeAdapter ? config.adapter : originalAdapter;
  if (getAdapter && (Array.isArray(adapter) || typeof adapter === 'string')) {
    return getAdapter(adapter)(config);
  }
  if (Array.isArray(adapter)) {
    const fn = adapter.find((item) => typeof item === 'function');
    if (fn) return fn(config);
    return originalAdapter(config);
  }
  if (typeof adapter === 'function') {
    return adapter(config);
  }
  if (getAdapter) {
    return getAdapter(axios.defaults.adapter || 'xhr')(config);
  }
  throw new TypeError('Adapter não suportado');
};

const dedupeAdapter = (config) => {
  if (!isWriteMethod(config?.method) || config?.dedupe === false) {
    return resolveAdapter(config);
  }
  const key = buildDedupeKey(config);
  if (!key) {
    return resolveAdapter(config);
  }
  const existing = inFlightWrites.get(key);
  if (existing) return existing;

  const req = resolveAdapter(config).finally(() => {
    inFlightWrites.delete(key);
  });
  inFlightWrites.set(key, req);
  return req;
};
api.defaults.adapter = dedupeAdapter;
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
const notifyAuthExpired = (status) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('auth:expired', { detail: { status } }));
};
let hardReloadInProgress = false;
const hardReloadNoCache = async () => {
  if (typeof window === 'undefined' || hardReloadInProgress) return;
  hardReloadInProgress = true;
  try {
    const now = Date.now();
    const prev = Number(sessionStorage.getItem('__hard_reload_ts') || 0);
    if (now - prev < 15000) return;
    sessionStorage.setItem('__hard_reload_ts', String(now));
  } catch {}
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {}
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker?.getRegistrations) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {}
  const next = new URL(window.location.href);
  next.searchParams.set('_hr', String(Date.now()));
  window.location.replace(next.toString());
};

if (import.meta?.env?.DEV) {
  // eslint-disable-next-line no-console
  console.info('[apiClient] baseURL =', api.defaults.baseURL);
}

api.interceptors.request.use(
  (config) => {
    try {
      const token = getToken();
      if (token) {
        config.headers = { ...(config.headers || {}), Authorization: `Bearer ${token}` };
      }
    } catch {}

    if (typeof config.url === 'string') {
      let u = config.url.trim();
      if (/^https?:\/\//i.test(u)) {
        // absoluta
      } else if (u.startsWith('/')) {
        // Se não comeÃ§ar com /api/, prefixa /api/v1
        if (!/^\/api(\/|$)/i.test(u)) {
          u = '/api/v1' + u;
        }
      } else {
        // relativa â†’ prefixar /api/v1/
        u = '/api/v1/' + u.replace(/^\/+/, '');
      }
      config.url = normalizeUrlQuery(u);
    }
    if (config.params) {
      if (typeof config.params === 'string') {
        config.url = appendQuery(config.url || '', config.params);
        delete config.params;
      } else if (typeof URLSearchParams !== 'undefined' && config.params instanceof URLSearchParams) {
        config.url = appendQuery(config.url || '', config.params.toString());
        delete config.params;
      }
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
    const status = error?.response?.status;
    if (status === 401 && error?.config?.authExpired === true) {
      notifyAuthExpired(status);
    }
    return Promise.reject(error);
  }
);

export default api;

export const getAuthToken = () => getToken();

export const withAuthToken = (url) => {
  if (!url) return url;
  const token = getToken();
  if (!token) return url;
  if (String(url).includes('token=')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
};

// Retry leve para quedas momentâneas de rede (ex.: net::ERR_NETWORK_CHANGED)
api.interceptors.response.use(
  (resp) => resp,
  async (error) => {
    try {
      const cfg = error?.config || {};
      const code = error?.code || '';
      const msg = String(error?.message || '').toLowerCase();
      const networkChanged = msg.includes('network changed') || msg.includes('err_network_changed');
      const transient = code === 'ERR_NETWORK' || networkChanged;
      if (!transient) throw error;

      cfg.__retryCount = (cfg.__retryCount || 0) + 1;
      if (cfg.__retryCount > 2) throw error; // até 2 tentativas

      await new Promise((r) => setTimeout(r, 400 * cfg.__retryCount));
      return api(cfg);
    } catch {
      const msg = String(error?.message || '').toLowerCase();
      if (msg.includes('network changed') || msg.includes('err_network_changed')) {
        hardReloadNoCache();
      }
      return Promise.reject(error);
    }
  }
);
