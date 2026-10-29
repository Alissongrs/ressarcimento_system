// Service REST para as metas de deferimento (repasse) — barra de progressão.
//   GET /api/v2/metas/deferimento           → metas + repasse mês/ano + histórico
//   PUT /api/v2/metas/deferimento {..}       → calibra meta_mensal / meta_anual
import axios from 'axios';

const apiV2 = axios.create({
  baseURL:
    (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_API_BASE_V2) ||
    '/api/v2',
  withCredentials: true,
});

export async function getMetasDeferimento() {
  const { data } = await apiV2.get('/metas/deferimento');
  return data;
}

export async function updateMetasDeferimento(payload) {
  // payload: { meta_mensal?: number, meta_anual?: number }
  const { data } = await apiV2.put('/metas/deferimento', payload);
  return data;
}

// Resumo por empresa de um período. mes omitido/0 = ano inteiro (até agora).
//   GET /api/v2/metas/deferimento/detalhe?ano=AAAA[&mes=M]
export async function getMetasDeferimentoDetalhe(ano, mes) {
  const params = { ano };
  if (mes) params.mes = mes;
  const { data } = await apiV2.get('/metas/deferimento/detalhe', { params });
  return data; // { ano, mes, empresas:[{empresa,qtd,repasse}], total_qtd, total_repasse }
}
