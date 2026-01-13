// src/services/processoSnapshotService.js
// Service para interagir com FT_PROCESSO_SNAPSHOT

import api from './apiClient';

/**
 * Recupera dados completos de um processo do snapshot
 * @param {number} idProcesso - ID do processo
 * @returns {Promise<Object>} Dados do processo
 */
export async function getProcessoSnapshot(idProcesso) {
  if (!idProcesso) throw new Error('ID do processo é obrigatório');
  const { data } = await api.get(`/processo-snapshot/${idProcesso}`);
  return data?.data || {};
}

/**
 * Atualiza um processo no snapshot (com sincronização automática)
 * @param {number} idProcesso - ID do processo
 * @param {Object} updateData - Dados a atualizar
 * @returns {Promise<Object>} Resposta com dados atualizados
 */
export async function updateProcessoSnapshot(idProcesso, updateData) {
  if (!idProcesso) throw new Error('ID do processo é obrigatório');
  if (!updateData || typeof updateData !== 'object') {
    throw new Error('Dados de atualização inválidos');
  }

  const { data } = await api.post(`/processo-snapshot/${idProcesso}`, updateData);
  return data;
}

/**
 * Força sincronização manual de um processo
 * @param {number} idProcesso - ID do processo
 * @returns {Promise<Object>} Resposta da sincronização
 */
export async function syncProcessoSnapshot(idProcesso) {
  if (!idProcesso) throw new Error('ID do processo é obrigatório');
  const { data } = await api.post(`/processo-snapshot/${idProcesso}/sync`);
  return data;
}

/**
 * Valida dados antes de atualizar o snapshot
 * @param {Object} updateData - Dados a validar
 * @returns {Object} { valid: boolean, errors: Array<string> }
 */
export function validateSnapshotUpdate(updateData) {
  const errors = [];

  if (!updateData) {
    return { valid: false, errors: ['Dados de atualização são obrigatórios'] };
  }

  // Validações de campos específicos
  if (updateData.suspenso === 1 && (!updateData.suspenso_motivo || updateData.suspenso_motivo.trim() === '')) {
    errors.push('Motivo de suspensão é obrigatório quando suspenso = 1');
  }

  if (updateData.credito_simples !== undefined && updateData.credito_simples !== null) {
    if (isNaN(updateData.credito_simples) || updateData.credito_simples < 0) {
      errors.push('Crédito simples deve ser um número positivo');
    }
  }

  if (updateData.credito_dobro !== undefined && updateData.credito_dobro !== null) {
    if (isNaN(updateData.credito_dobro) || updateData.credito_dobro < 0) {
      errors.push('Crédito dobro deve ser um número positivo');
    }
  }

  if (updateData.valor_ressarcimento !== undefined && updateData.valor_ressarcimento !== null) {
    if (isNaN(updateData.valor_ressarcimento) || updateData.valor_ressarcimento < 0) {
      errors.push('Valor de ressarcimento deve ser um número positivo');
    }
  }

  // Validações de data
  const dateFields = ['data_devolucao', 'data_envio_financeiro'];
  for (const field of dateFields) {
    if (updateData[field]) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(updateData[field])) {
        errors.push(`${field} deve estar no formato YYYY-MM-DD`);
      }
    }
  }

  // Validações de enum
  if (updateData.forma_devolucao) {
    const validFormas = ['Fatura', 'GD', 'Deposito'];
    if (!validFormas.includes(updateData.forma_devolucao)) {
      errors.push(`Forma de devolução deve ser: ${validFormas.join(', ')}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Normaliza dados de atualização (convert strings, etc)
 * @param {Object} updateData - Dados brutos
 * @returns {Object} Dados normalizados
 */
export function normalizeSnapshotUpdate(updateData) {
  if (!updateData) return {};

  const normalized = { ...updateData };

  // Converter strings numéricas em números
  if (normalized.credito_simples !== undefined && normalized.credito_simples !== null) {
    normalized.credito_simples = parseFloat(normalized.credito_simples);
  }

  if (normalized.credito_dobro !== undefined && normalized.credito_dobro !== null) {
    normalized.credito_dobro = parseFloat(normalized.credito_dobro);
  }

  if (normalized.valor_ressarcimento !== undefined && normalized.valor_ressarcimento !== null) {
    normalized.valor_ressarcimento = parseFloat(normalized.valor_ressarcimento);
  }

  // Converter suspenso em número
  if (normalized.suspenso !== undefined && normalized.suspenso !== null) {
    normalized.suspenso = normalized.suspenso ? 1 : 0;
  }

  // Remover campos vazios/null (para evitar sobrescrever com NULL)
  Object.keys(normalized).forEach((key) => {
    if (normalized[key] === '' || normalized[key] === null) {
      delete normalized[key];
    }
  });

  return normalized;
}

/**
 * Prepara dados do formulário para salvar no snapshot
 * Converte formatos de data BR para ISO, etc.
 * @param {Object} formData - Dados do formulário
 * @returns {Object} Dados prontos para enviar
 */
export function prepareSnapshotData(formData) {
  if (!formData) return {};

  const prepared = { ...formData };

  // Converter datas BR (dd/mm/yyyy) para ISO (yyyy-mm-dd)
  const dateFields = ['data_devolucao', 'data_envio_financeiro', 'data_dobro', 'data_simples'];
  for (const field of dateFields) {
    if (prepared[field]) {
      const dateStr = String(prepared[field]).trim();
      // Se já está em formato ISO, manter
      if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
        continue;
      }
      // Converter de dd/mm/yyyy para yyyy-mm-dd
      const match = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      if (match) {
        const [, day, month, year] = match;
        prepared[field] = `${year}-${month}-${day}`;
      }
    }
  }

  return normalizeSnapshotUpdate(prepared);
}

/**
 * Mapeia dados do snapshot para o formulário (formatação BR)
 * @param {Object} snapshotData - Dados do snapshot (formato ISO)
 * @returns {Object} Dados formatados para exibição
 */
export function mapSnapshotToForm(snapshotData) {
  if (!snapshotData) return {};

  const mapped = { ...snapshotData };

  // Converter datas ISO para BR
  const dateFields = ['data_devolucao', 'data_envio_financeiro', 'data_dobro', 'data_simples'];
  for (const field of dateFields) {
    if (mapped[field]) {
      const dateStr = String(mapped[field]).trim();
      const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (match) {
        const [, year, month, day] = match;
        mapped[field] = `${day}/${month}/${year}`;
      }
    }
  }

  // Suspenso: converter para boolean para checkbox
  if (mapped.suspenso !== undefined) {
    mapped.suspenso = mapped.suspenso === 1 || mapped.suspenso === true;
  }

  return mapped;
}

/**
 * Detecta quais campos foram alterados
 * @param {Object} original - Dados originais
 * @param {Object} updated - Dados atualizados
 * @returns {Object} Apenas os campos que mudaram
 */
export function getChangedFields(original, updated) {
  const changed = {};

  for (const key of Object.keys(updated)) {
    if (original[key] !== updated[key]) {
      changed[key] = {
        old: original[key],
        new: updated[key],
      };
    }
  }

  return changed;
}
