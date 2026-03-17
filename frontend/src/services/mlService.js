import api from './apiClient';

/**
 * Busca Score de Progressão para um processo específico
 * @param {number|string} processoId - ID do processo
 * @returns {Promise<{score, label, percentual, prediction, timestamp} | null>}
 */
export async function getProcessoScore(processoId) {
  try {
    const { data } = await api.get(`/processos/${processoId}/score`);
    return data;
  } catch (error) {
    // Silenciosamente falha - Score é um enhancement, não bloqueador
    console.warn(`[Score] Erro ao buscar score para processo ${processoId}:`, error.message);
    return null;
  }
}
