import api from './apiClient';

// Login
export const login = async (email, password) => {
  try {
    const response = await api.post('/login', { email, password });
    return response.data;
  } catch (error) {
    console.error('Erro detalhado no serviço de login:', error);
    if (error.response) {
      console.error('Dados do erro:', error.response.data);
      console.error('Status do erro:', error.response.status);
    } else if (error.request) {
      console.error('Requisição feita, mas sem resposta:', error.request);
    } else {
      console.error('Erro ao configurar a requisição:', error.message);
    }
    throw error;
  }
};

// Registro
export const register = async (userData) => {
  try {
    const response = await api.post('/register', userData);
    return response.data;
  } catch (error) {
    console.error('Erro no serviço de registro:', error.response?.data?.error || error.message);
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
