import api from './apiClient';

export async function getEtapas() {
  const { data } = await api.get('/filtros/etapas');
  return Array.isArray(data) ? data : [];
}

export async function getSubEtapas() {
  const { data } = await api.get('/filtros/subetapas');
  return Array.isArray(data) ? data : [];
}

export async function getEtapaSubMap() {
  const { data } = await api.get('/filtros/etapas-subetapas');
  return data?.map || {};
}
