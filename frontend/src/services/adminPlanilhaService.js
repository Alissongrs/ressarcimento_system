import api from './apiClient';

const normalizeParams = (params) => {
  if (!params) return {};
  if (typeof URLSearchParams !== 'undefined' && params instanceof URLSearchParams) {
    return Object.fromEntries(params.entries());
  }
  if (typeof params === 'string') {
    const raw = params.startsWith('?') ? params.slice(1) : params;
    return Object.fromEntries(new URLSearchParams(raw));
  }
  if (typeof params === 'object') return params;
  return {};
};

export async function listPlanilha(params = {}) {
  const normalized = normalizeParams(params);
  const { data } = await api.get('/admin/processos', { params: normalized });
  return Array.isArray(data?.rows) ? data.rows : [];
}

export async function bulkMover({ processo_ids = [], etapa, sub_etapa = '', comentario = '' }) {
  const payload = { processo_ids, etapa, sub_etapa, comentario };
  const { data } = await api.post('/admin/processos/bulk-mover', payload);
  return data;
}

export async function bulkComentarioReplace({ historico_ids = [], from = '', to = '' }) {
  const payload = { historico_ids, from, to };
  const { data } = await api.post('/admin/processos/bulk-comentario-replace', payload);
  return data;
}

export async function deleteHistorico(id) {
  if (!id) return { ok: false };
  const { data } = await api.delete(`/admin/historico/${id}`);
  return data ?? { ok: true };
}
