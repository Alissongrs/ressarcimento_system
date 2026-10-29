// Assistente do solicitante — consultas determinísticas (/api/v2/assistente/*).
// Reaproveita o apiClient (anexa auth + cookie). Os paths começam com /api/ então
// o interceptor do apiClient NÃO os reprefixuga com /api/v1.
import api from './apiClient';

export const consultarProcesso = async (q) => {
  const { data } = await api.get('/api/v2/assistente/processo', { params: { q } });
  return data;
};

export const relatorioCliente = async (nome) => {
  const { data } = await api.get('/api/v2/assistente/cliente', { params: { nome } });
  return data;
};

// Lista de processos (frase livre → cliente/ano/deferidos resolvidos no servidor).
export const listaProcessos = async (q) => {
  const { data } = await api.get('/api/v2/assistente/lista', { params: { q } });
  return data;
};

export const tempoMedioConcessionaria = async (concessionaria) => {
  const { data } = await api.get('/api/v2/assistente/tempo-medio', { params: { concessionaria } });
  return data;
};
