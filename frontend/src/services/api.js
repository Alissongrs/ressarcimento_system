// src/services/api.js
import axios from 'axios';

export function getRawToken() {
  return (
    localStorage.getItem('token') ||
    localStorage.getItem('authToken') ||
    localStorage.getItem('jwt') ||
    sessionStorage.getItem('token') ||
    ''
  );
}

function cleanToken(t) {
  if (!t) return '';
  // Remove aspas simples/duplas e espaços
  return String(t).trim().replace(/^['"]+|['"]+$/g, '');
}

const api = axios.create({
  baseURL: (import.meta?.env?.VITE_API_BASE || '/api/v1').trim(),
  withCredentials: true,
});

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

api.interceptors.request.use((config) => {
  const raw = getRawToken();
  const token = cleanToken(raw);

  // Header Authorization
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }

  // /ocr/chat também aceita ?token= (útil p/ dev e SSE-like)
  const url = (config.url || '').toLowerCase();
  if (token && (url.endsWith('/ocr/chat') || url.includes('/ocr/chat?'))) {
    // injeta query param sem sobrescrever outros
    config.params = { ...(config.params || {}), token };
  }

  if (isWriteMethod(config.method)) {
    setSavingCount(getSavingCount() + 1);
  }
  return config;
});

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
    if (status === 401 && !error?.config?.skipAuthExpired) {
      notifyAuthExpired(status);
    }
    const msg = String(error?.message || '').toLowerCase();
    if (msg.includes('network changed') || msg.includes('err_network_changed')) {
      hardReloadNoCache();
    }
    return Promise.reject(error);
  }
);

export default api;
