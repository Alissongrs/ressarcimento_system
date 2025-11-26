import api from './apiClient';

export async function listPlanilha(params = {}) {
  const { data } = await api.get('/admin/planilha', { params });
  return Array.isArray(data?.rows) ? data.rows : [];
}

export async function bulkMover({ processo_ids = [], etapa, sub_etapa = '', comentario = '' }) {
  const payload = { processo_ids, etapa, sub_etapa, comentario };
  const { data } = await api.post('/admin/planilha/bulk-mover', payload);
  return data;
}

export async function bulkComentarioReplace({ historico_ids = [], from = '', to = '' }) {
  const payload = { historico_ids, from, to };
  const { data } = await api.post('/admin/planilha/bulk-comentario-replace', payload);
  return data;
}

export async function deleteHistorico(id) {
  if (!id) return { ok: false };
  const { data } = await api.delete(`/admin/historico/${id}`);
  return data ?? { ok: true };
}
