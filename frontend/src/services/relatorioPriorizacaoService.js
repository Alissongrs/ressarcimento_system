import api from './apiClient';

// Relatório de priorização dos deferidos (Luana) — backend: handlers/relatorio_priorizacao_handler.go
export async function getRelatorioPriorizacao({ encerrados = false } = {}) {
  const { data } = await api.get('/relatorios/priorizacao', { params: encerrados ? { encerrados: 1 } : {} });
  return data;
}

export async function salvarPriorizacao(idProcesso, payload) {
  const { data } = await api.put(`/relatorios/priorizacao/${idProcesso}`, payload);
  return data;
}

export async function registrarComprovante(idProcesso, payload) {
  const { data } = await api.post(`/relatorios/priorizacao/${idProcesso}/comprovante`, payload);
  return data;
}

export async function apagarComprovante(idComprovante) {
  const { data } = await api.delete(`/relatorios/priorizacao/comprovante/${idComprovante}`);
  return data;
}
