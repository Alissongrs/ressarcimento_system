import api from './apiClient';

export async function getPrazos() {
  const { data } = await api.get('/api/v1/admin/prazos', { baseURL: '' });
  return data || { kanban: [], etapas: [] };
}

export async function savePrazos(payload) {
  // payload: { kanban: [{id_coluna_kanban, prazo_dias|null}], overrides: [{id_etapa_processo, sub_etapa, prazo_dias}] }
  const { data } = await api.post('/api/v1/admin/prazos', payload, { baseURL: '' });
  return data;
}
