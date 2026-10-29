// Auth service — agora apontando para /api/v2/auth/* (banco refatorado).
//
// Migração 23/06/2026: login/register passam a consultar D_USUARIO do
// db_ressarcimento_v2. Mesmo JWT/cookie do v1 (claims compatíveis),
// então o middleware atual continua aceitando o token.

import axios from 'axios';
import api from './apiClient';

// Cliente axios apontando pra /api/v2 (mesma origin do v1, sufixo trocado).
function v2BaseURL() {
  const base = String(import.meta?.env?.VITE_API_BASE || '/api/v1').trim();
  return base.replace(/\/api\/v1\/?$/, '/api/v2');
}

const authApi = axios.create({
  baseURL: v2BaseURL(),
  withCredentials: true,
});

// Login — POST /api/v2/auth/login
export const login = async (email, password) => {
  try {
    const response = await authApi.post('/auth/login', { email, password });
    return response.data;
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error('[auth v2] login error:', error?.response?.status ?? error?.message);
    }
    // Compatibilidade: o frontend antigo espera error.response.data.error como string
    if (error?.response?.data?.error?.message && !error.response.data.error?.code) {
      // já está no formato v1
    } else if (error?.response?.data?.error?.message) {
      error.response.data.error = error.response.data.error.message;
    }
    throw error;
  }
};

// Logout — POST /api/v2/auth/logout
export const logout = async () => {
  try {
    const response = await authApi.post('/auth/logout');
    return response.data;
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error('[auth v2] logout error:', error?.response?.status ?? error?.message);
    }
    // Logout silencioso — não bloqueia o usuário se rede falhar
    return { message: 'Logout (sem confirmação do servidor)' };
  }
};

// Register — POST /api/v2/auth/register
export const register = async (userData) => {
  try {
    const response = await authApi.post('/auth/register', userData);
    return response.data;
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error('[auth v2] register error:', error?.response?.status ?? error?.message);
    }
    if (error?.response?.data?.error?.message) {
      error.response.data.error = error.response.data.error.message;
    }
    throw error;
  }
};

// ─── Microsoft (Entra ID) ────────────────────────────────────────────────────
// O fluxo é conduzido pelo backend por redirecionamento de página inteira.
// Aqui só: (1) consultar se está ligado, (2) montar as URLs de start.

// GET /api/v2/auth/microsoft/config → { enabled }
export const microsoftEnabled = async () => {
  try {
    const { data } = await authApi.get('/auth/microsoft/config');
    return !!data?.enabled;
  } catch {
    return false; // se falhar, simplesmente não mostra o botão
  }
};

// URL absoluta do /start (navegação de página inteira). mode = 'login' | 'link'.
export const microsoftStartUrl = (mode = 'login', redirect = '/') => {
  const base = v2BaseURL().replace(/\/$/, '');
  const abs = base.startsWith('http') ? base : `${window.location.origin}${base}`;
  const q = new URLSearchParams({ mode, redirect });
  return `${abs}/auth/microsoft/start?${q.toString()}`;
};

// ─── Link mágico (passwordless, sem Azure) ────────────────────────────────────

// GET /api/v2/auth/magic/config → { enabled }
export const magicEnabled = async () => {
  try {
    const { data } = await authApi.get('/auth/magic/config');
    return !!data?.enabled;
  } catch {
    return false;
  }
};

// POST /api/v2/auth/magic { email } → envia o link de acesso
export const magicRequest = async (email) => {
  const { data } = await authApi.post('/auth/magic', { email });
  return data;
};

// /me — GET /api/v2/auth/me (autenticado)
export const me = async () => {
  const response = await authApi.get('/auth/me');
  return response.data;
};

// Departamentos — ainda no /api/v1 (não migrado pro v2 ainda)
export const getDepartamentos = async () => {
  try {
    const response = await api.get('/departamentos');
    return response.data;
  } catch (error) {
    console.error('Erro ao buscar departamentos:', error.response?.data?.error || error.message);
    throw error;
  }
};
