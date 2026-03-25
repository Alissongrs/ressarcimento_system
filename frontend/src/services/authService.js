import api from './apiClient';

// Login
export const login = async (email, password) => {
  try {
    const response = await api.post('/login', { email, password }, { skipAuthExpired: true });
    return response.data;
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error('[auth] login error:', error?.response?.status ?? error?.message);
    }
    throw error;
  }
};

// Registro
export const register = async (userData) => {
  try {
    const response = await api.post('/register', userData, { skipAuthExpired: true });
    return response.data;
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error('[auth] register error:', error?.response?.status ?? error?.message);
    }
    throw error;
  }
};

// Departamentos
export const getDepartamentos = async () => {
  try {
    const response = await api.get('/departamentos');
    return response.data;
  } catch (error) {
    console.error('Erro ao buscar departamentos:', error.response?.data?.error || error.message);
    throw error;
  }
};
