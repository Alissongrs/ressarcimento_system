import api from './apiClient';

// Catálogo de Regras (fichas F01–F61) — /api/v1/fichas-regras
// Texto editável (interpretação/aplicação) + "Testar" uma fatura PDF contra as regras
// escolhidas (o teste entra numa fila e é processado pelo agente Claude da VPS).

export async function listarFichasRegras() {
  const { data } = await api.get('/fichas-regras');
  return data?.items || [];
}

// cria a próxima regra do catálogo (F62, F63…) — devolve o item criado
export async function criarFichaRegra(campos) {
  const { data } = await api.post('/fichas-regras', campos);
  return data?.item;
}

export async function atualizarFichaRegra(codigo, campos) {
  const { data } = await api.put(`/fichas-regras/${codigo}`, campos);
  return data?.item;
}

// IA interpreta o texto alterado e devolve uma versão melhorada (não grava — a pessoa revisa e salva)
export async function melhorarFichaRegra(codigo, campos) {
  const { data } = await api.post(`/fichas-regras/${codigo}/melhorar`, campos);
  return data?.sugestao; // {interpretacao, faturas_necessarias, criterios, aplicacao, base_legal, observacoes}
}

// arquivos: 1 a 13 PDFs de faturas da MESMA unidade consumidora
export async function criarTesteRegra(arquivos, codigos) {
  const fd = new FormData();
  arquivos.forEach((f) => fd.append('arquivos', f));
  fd.append('fichas', codigos.join(','));
  const { data } = await api.post('/fichas-regras/testes', fd);
  return data; // { id, status, qtd_arquivos }
}

export async function statusTesteRegra(id) {
  const { data } = await api.get(`/fichas-regras/testes/${id}`);
  return data;
}

export async function cancelarTesteRegra(id) {
  const { data } = await api.post(`/fichas-regras/testes/${id}/cancelar`);
  return data;
}

export async function salvarTesteRegra(id) {
  const { data } = await api.post(`/fichas-regras/testes/${id}/salvar`);
  return data;
}

export async function listarTestesSalvos(codigo) {
  const { data } = await api.get('/fichas-regras/testes', { params: codigo ? { codigo } : {} });
  return data?.items || [];
}
