import api from './api';

export const listDesvioKwhFponta = async ({
  limit = 500,
  offset = 0,
  status,
  tp_tensao = [],
  concessionaria = [],
  cliente = [],
  q,
} = {}) => {
  const params = { limit, offset };
  if (status) params.status = status;
  if (tp_tensao.length) params.tp_tensao = tp_tensao.join(',');
  if (concessionaria.length) params.concessionaria = concessionaria.join(',');
  if (cliente.length) params.cliente = cliente.join(',');
  if (q) params.q = q;
  const { data } = await api.get('/desvio-kwh-fponta', { params });
  return data;
};

export const listDesvioKwhOptions = async () => {
  const { data } = await api.get('/desvio-kwh-fponta/options');
  return data;
};

export const updateDesvioKwhFlags = async (id, payload) =>
  api.post(`/desvio-kwh-fponta/${id}/flags`, payload);

export const createProcessoFromDesvioKwh = async (id) =>
  api.post(`/desvio-kwh-fponta/${id}/create-processo`, {});
