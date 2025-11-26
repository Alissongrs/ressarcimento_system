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

  return config;
});

export default api;
