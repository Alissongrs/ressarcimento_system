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
    return Promise.reject(error);
  }
);

export default api;
