// src/services/irregularidadeService.js
import api from "./apiClient"; // <- o mesmo cliente axios que você já usa nos outros services

// Busca todos os tipos de irregularidade
export async function getTiposIrregularidade() {
  const response = await api.get("/tipos-irregularidade");
  return response.data;
}

// Busca os subtipos de acordo com o tipo selecionado
export async function getSubtiposIrregularidade(tipoId) {
  const response = await api.get(`/tipos-irregularidade/${tipoId}/subtipos`);
  return response.data;
}

