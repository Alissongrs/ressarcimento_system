// Serviço do Informativo do sistema (janelinha de avisos).
//   GET /api/v1/informativo            → { versao, titulo, aviso, ativo }
//   PUT /api/v1/informativo {..}       → publica/edita (admin); incrementa a versão
import api from './apiClient';

export async function getInformativo() {
  const { data } = await api.get('/informativo');
  return data;
}

export async function salvarInformativo(payload) {
  // payload: { titulo?, aviso?, ativo? }
  const { data } = await api.put('/informativo', payload);
  return data;
}
