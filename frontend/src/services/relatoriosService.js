import api from './apiClient';

export const getRelatoriosMetricas = async (filters = {}) => {
  const params = {};
  if (filters.dataIni && filters.dataFim) {
    params.data_ini = filters.dataIni;
    params.data_fim = filters.dataFim;
  }
  if (Array.isArray(filters.concessionarias) && filters.concessionarias.length > 0) {
    params.concessionarias = filters.concessionarias.join(',');
  }
  const { data } = await api.get('/relatorios/metricas', { params });
  return data;
};

/**
 * Busca métricas para múltiplos períodos em uma única requisição.
 * @param {Array<{key: string, data_ini?: string, data_fim?: string, concessionarias?: string}>} reqs
 * @returns {Promise<Record<string, object>>}
 */
export const getRelatoriosMetricasBatch = async (reqs) => {
  const { data } = await api.post('/relatorios/metricas-batch', reqs);
  return data;
};

export const getKanbanComposicao = async (filters = {}) => {
  const params = {};
  if (filters.dataIni && filters.dataFim) {
    params.data_ini = filters.dataIni;
    params.data_fim = filters.dataFim;
  }
  if (Array.isArray(filters.concessionarias) && filters.concessionarias.length > 0) {
    params.concessionarias = filters.concessionarias.join(',');
  }
  const { data } = await api.get('/relatorios/kanban-composicao', { params });
  return data;
};

