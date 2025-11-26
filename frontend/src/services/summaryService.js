import api from './apiClient';

export async function getSummary(processoId) {
  const { data } = await api.get(`/processos/${processoId}/summary`);
  return data || { status: 'none' };
}

export async function refreshSummary(processoId) {
  const { data } = await api.post(`/processos/${processoId}/summary/refresh`);
  return data || { ok: true };
}

