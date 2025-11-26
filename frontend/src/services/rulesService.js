import api from './apiClient';

export async function getRules() {
  if (import.meta?.env?.DEV) console.info('[Rules] GET /api/v1/rules');
  const { data } = await api.get('/rules');
  return data?.items || [];
}

export async function getActiveRules() {
  if (import.meta?.env?.DEV) console.info('[Rules] GET /api/v1/rules/active');
  const { data } = await api.get('/rules/active');
  return data?.items || [];
}

export async function createRule(rule) {
  if (import.meta?.env?.DEV) console.info('[Rules] POST /api/v1/rules', rule);
  const { data } = await api.post('/rules', rule);
  return data;
}

export async function updateRule(id, rule) {
  if (import.meta?.env?.DEV) console.info('[Rules] PUT /api/v1/rules/' + id, rule);
  const { data } = await api.put(`/rules/${id}`, rule);
  return data;
}

export async function deleteRule(id) {
  if (import.meta?.env?.DEV) console.info('[Rules] DELETE /api/v1/rules/' + id);
  const { data } = await api.delete(`/rules/${id}`);
  return data?.ok === true;
}

export async function interpretRule(text) {
  if (import.meta?.env?.DEV) console.info('[Rules] POST /api/v1/rules/interpret');
  const { data } = await api.post('/rules/interpret', { text });
  return data?.message || '';
}
