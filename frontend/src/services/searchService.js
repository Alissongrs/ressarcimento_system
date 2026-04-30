import api from './apiClient';

export async function searchGlobal(q) {
  const params = { q: String(q || '').trim() };
  const { data } = await api.get('/search/global', { params });
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

