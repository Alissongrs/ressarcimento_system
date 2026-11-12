// src/services/divergenciasService.js
// Status × histórico: processos cujo espelho (FT_PROCESSOS) não bate com a última
// movimentação. Só administradores. Backend: handlers/v2/divergencias.go.
import axios from 'axios';
import { getRawToken } from './api';

function v2BaseURL() {
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

// GET /api/v2/divergencias/status → { total, itens: [...] }
export async function listarDivergencias() {
  const { data } = await apiV2.get('/divergencias/status');
  return data;
}

// POST /api/v2/divergencias/status/corrigir { id_processo, direcao }
// direcao: 'historico' (registra no histórico o estado do processo) | 'processo' (atualiza o processo pelo histórico)
export async function corrigirDivergencia(idProcesso, direcao) {
  const { data } = await apiV2.post('/divergencias/status/corrigir', { id_processo: idProcesso, direcao });
  return data;
}
