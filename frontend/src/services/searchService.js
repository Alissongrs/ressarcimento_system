import api from './apiClient';

export async function searchGlobal(q) {
  const params = { q: String(q || '').trim() };
  const { data } = await api.get('/search/global', { params });
  return Array.isArray(data) ? data : (Array.isArray(data?.rows) ? data.rows : []);
}

