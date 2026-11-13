// src/services/divergenciasService.js
// Status × histórico: processos cujo espelho (FT_PROCESSOS) não bate com a última
// movimentação. Só administradores. Backend: handlers/v2/divergencias.go.
import apiV2 from './apiV2';

// GET /api/v2/divergencias/status → { total, itens: [...] }
export async function listarDivergencias() {
  const { data } = await apiV2.get('/divergencias/status');
  return data;
}

// POST /api/v2/divergencias/status/corrigir { id_processo, direcao }
// direcao: 'historico' (registra no histórico o estado do processo) | 'processo' (atualiza o processo pelo histórico)
export async function corrigirDivergencia(idProcesso, direcao) {
  const { data } = await apiV2.post('/divergencias/status/corrigir', { id_processo: idProcesso, direcao });
  return data;
}
