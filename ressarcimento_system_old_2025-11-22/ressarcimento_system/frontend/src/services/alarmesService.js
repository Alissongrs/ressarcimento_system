import api from './apiClient';

export async function getAlarmes() {
  const { data } = await api.get('/api/v1/admin/alarmes', { baseURL: '' });
  return data?.alarmes || [];
}

export async function saveAlarme(payload) {
  // payload: { id?, nome, ativo?, tipo, id_coluna_kanban?, id_etapa_processo?, sub_etapa?, prazo_dias, severity }
  const { data } = await api.post('/api/v1/admin/alarmes', payload, { baseURL: '' });
  return data;
}

export async function deleteAlarme(id) {
  const { data } = await api.delete(`/api/v1/admin/alarmes/${id}`, { baseURL: '' });
  return data;
}
