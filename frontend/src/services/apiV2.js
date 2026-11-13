// src/services/apiV2.js
// Cliente axios para a API v2 (/api/v2), com o mesmo token da sessão. Serviços novos usam este
// em vez de montar o próprio (divergenciasService, rotinasSaudeService).
import axios from 'axios';
import { getRawToken } from './api';

export function v2BaseURL() {
  const base = String(import.meta?.env?.VITE_API_BASE || '/api/v1').trim();
  return base.replace(/\/api\/v1\/?$/, '/api/v2');
}

const apiV2 = axios.create({ baseURL: v2BaseURL(), withCredentials: true });
apiV2.interceptors.request.use((config) => {
  const token = String(getRawToken() || '').trim().replace(/^['"]+|['"]+$/g, '');
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default apiV2;
