// src/services/processoV2Service.js
// Wrapper axios para a nova API /api/v2 (banco refatorado).
// Suporta modo MOCK (VITE_USE_V2_MOCK=true) com fixtures locais
// enquanto o backend Go ainda não expõe os endpoints.

import axios from 'axios';
import { getRawToken } from './api';
import processosMock from './fixtures/processos.v2.json';
import dimensoesMock from './fixtures/dimensoes.v2.json';
import detalhesMock from './fixtures/detalhes.v2.json';

// ----- flags -----
const USE_MOCK =
  String(import.meta?.env?.VITE_USE_V2_MOCK || '').toLowerCase() === 'true';

// Mesma origin do v1 (o backend Go serve as duas rotas no mesmo host).
// VITE_API_BASE no projeto aponta pra /api/v1 — só trocamos o sufixo.
function v2BaseURL() {
  const base = String(import.meta?.env?.VITE_API_BASE || '/api/v1').trim();
  return base.replace(/\/api\/v1\/?$/, '/api/v2');
}

const apiV2 = axios.create({
  baseURL: v2BaseURL(),
  withCredentials: true,
});

apiV2.interceptors.request.use((config) => {
  const token = String(getRawToken() || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '');
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ----- helpers -----
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function buildErrorPayload(err) {
  const resp = err?.response?.data;
  if (resp?.error) return resp.error;
  return {
    code: 'ERRO_REDE',
    message: err?.message || 'Falha de comunicação com o servidor.',
    details: null,
  };
}

async function safe(fn) {
  try {
    return await fn();
  } catch (err) {
    const payload = buildErrorPayload(err);
    const e = new Error(payload.message);
    e.code = payload.code;
    e.details = payload.details;
    e.httpStatus = err?.response?.status;
    throw e;
  }
}

// ===== Mock helpers (filtros/paginação no client) =====
function filtrarMock(filtros = {}) {
  const items = clone(processosMock.items);
  const {
    etapa,
    instancia,
    status,
    aprovacao,
    distribuidora,
    suspenso,
    q,
  } = filtros;
  const ql = q ? String(q).toLowerCase().trim() : '';
  return items.filter((p) => {
    if (etapa != null && p.etapa?.id !== Number(etapa)) return false;
    if (instancia != null && p.instancia?.id !== Number(instancia)) return false;
    if (status != null && p.status?.id !== Number(status)) return false;
    if (aprovacao != null && p.aprovacao?.id !== Number(aprovacao)) return false;
    if (distribuidora != null && p.id_distribuidora !== Number(distribuidora))
      return false;
    if (suspenso === true && !p.suspenso) return false;
    if (suspenso === false && p.suspenso) return false;
    if (ql) {
      const hay = `${p.codigo_publico} ${p.cliente} ${p.cliente_doc} ${p.distribuidora} ${p.codigo_uc} ${p.codigo_instalacao}`.toLowerCase();
      if (!hay.includes(ql)) return false;
    }
    return true;
  });
}

function montaDetalheMock(idProcesso) {
  const item = processosMock.items.find(
    (p) => p.id_processo === Number(idProcesso),
  );
  if (!item) return null;
  const extras = detalhesMock.extras?.[String(idProcesso)] || {};
  const counts = {
    historico: extras.historico?.length || 0,
    anexos: extras.anexos?.length || 0,
    deferimento: extras.deferimento ? 1 : 0,
    faturamento: extras.faturamento?.length || 0,
    repasse: extras.repasse?.length || 0,
  };
  return {
    id_processo: item.id_processo,
    codigo_publico: item.codigo_publico,
    id_processo_origem: extras.id_processo_origem || null,
    cliente: {
      id: item.id_processo,
      razao_social: item.cliente,
      cnpj_cpf_mascarado: item.cliente_doc,
      tipo_pessoa: 'PJ',
    },
    uc: {
      id: item.id_processo,
      codigo_uc: item.codigo_uc,
      codigo_instalacao: item.codigo_instalacao,
      endereco: extras.endereco_uc || null,
      cep: extras.cep_uc || null,
      municipio: extras.municipio_uc || null,
      uf: extras.uf_uc || null,
      grupo_subgrupo: extras.grupo_subgrupo || null,
      modalidade_tarifaria: extras.modalidade_tarifaria || null,
    },
    distribuidora: {
      id: item.id_distribuidora,
      nome: item.distribuidora,
      cnpj: null,
    },
    etapa_atual: item.etapa,
    instancia_atual: item.instancia,
    status_atual: item.status,
    aprovacao_atual: item.aprovacao,
    prioridade: item.prioridade,
    responsavel: item.responsavel
      ? { id: 0, nome: item.responsavel, email: null }
      : null,
    tipo_irregularidade: extras.tipo_irregularidade || null,
    subtipo_irregularidade: extras.subtipo_irregularidade || null,
    tese_juridica: extras.tese_juridica || null,
    suspenso: item.suspenso,
    ressarcimento_estimado: item.ressarcimento_estimado,
    motivo_objeto: extras.motivo_objeto || null,
    numero_protocolo: extras.numero_protocolo || null,
    data_abertura: item.data_abertura,
    data_alerta: extras.data_alerta || null,
    data_ultima_movimentacao: item.data_ultima_movimentacao,
    counts,
  };
}

// ===== API pública =====

/** Lista processos com filtros, busca, paginação. */
export async function listProcessos(filtros = {}) {
  if (USE_MOCK) {
    const filtrados = filtrarMock(filtros);
    const page = Math.max(1, Number(filtros.page) || 1);
    const pageSize = Math.max(1, Number(filtros.page_size) || 50);
    const start = (page - 1) * pageSize;
    return {
      total: filtrados.length,
      page,
      page_size: pageSize,
      items: filtrados.slice(start, start + pageSize),
    };
  }
  return safe(async () => {
    const { data } = await apiV2.get('/processos', { params: filtros });
    return data;
  });
}

/**
 * Histórico global (tela /historico OU usado pelo export com histórico).
 * params: { processos: "1,2,3", limit: 50000, etapa, instancia, status, distribuidora, uc, q }
 */
export async function getHistoricoGlobal(params = {}) {
  return safe(async () => {
    const { data } = await apiV2.get('/historico', { params });
    return data;
  });
}

/** Detalhes (aba Resumo). */
export async function getProcesso(idProcesso) {
  if (USE_MOCK) {
    const det = montaDetalheMock(idProcesso);
    if (!det) {
      const e = new Error('Processo não encontrado');
      e.code = 'NOT_FOUND';
      e.httpStatus = 404;
      throw e;
    }
    return det;
  }
  return safe(async () => {
    const { data } = await apiV2.get(`/processos/${idProcesso}`);
    return data;
  });
}

/** Histórico (timeline). */
export async function getHistorico(idProcesso) {
  if (USE_MOCK) {
    const extras = detalhesMock.extras?.[String(idProcesso)] || {};
    return { items: clone(extras.historico || []) };
  }
  return safe(async () => {
    const { data } = await apiV2.get(`/processos/${idProcesso}/historico`);
    return data;
  });
}

/** Anexos. */
export async function getAnexos(idProcesso) {
  if (USE_MOCK) {
    const extras = detalhesMock.extras?.[String(idProcesso)] || {};
    return { items: clone(extras.anexos || []) };
  }
  return safe(async () => {
    const { data } = await apiV2.get(`/processos/${idProcesso}/anexos`);
    return data;
  });
}

/** Upload de anexo (multipart). */
export async function uploadAnexo(idProcesso, file, descricao = '') {
  if (USE_MOCK) {
    // Stub: simula adicionando memoria local (não persiste entre reloads)
    const extras =
      detalhesMock.extras[String(idProcesso)] ||
      (detalhesMock.extras[String(idProcesso)] = { anexos: [] });
    if (!extras.anexos) extras.anexos = [];
    extras.anexos.unshift({
      id_anexo: Math.floor(Math.random() * 1e6),
      nome_arquivo: file?.name || 'arquivo.bin',
      tamanho_bytes: file?.size || 0,
      mime_type: file?.type || 'application/octet-stream',
      url_download: '#',
      uploaded_by: { id: 0, nome: 'Você' },
      uploaded_at: new Date().toISOString(),
    });
    return { ok: true };
  }
  return safe(async () => {
    const fd = new FormData();
    fd.append('file', file);
    if (descricao) fd.append('descricao', descricao);
    const { data } = await apiV2.post(`/processos/${idProcesso}/anexos`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
  });
}

/** Relatório de auditoria — TODOS os processos com todos os campos pertinentes. */
export async function getAuditoriaProcessos() {
  if (USE_MOCK) return { items: [] };
  return safe(async () => {
    const { data } = await apiV2.get('/auditoria/processos');
    return data;
  });
}

/** Edita TODOS os dados do processo (patch — só os campos enviados). */
export async function atualizarProcessoCompleto(idProcesso, payload) {
  if (USE_MOCK) return { ok: true, id_processo: idProcesso };
  return safe(async () => {
    const { data } = await apiV2.put(`/processos/${idProcesso}/full`, payload);
    return data;
  });
}

/** Edita o comentário de uma movimentação do histórico (com auditoria no backend). */
export async function editarComentarioHistorico(idHistorico, payload) {
  if (USE_MOCK) return { ok: true, id_historico: idHistorico };
  return safe(async () => {
    const { data } = await apiV2.put(`/historico/${idHistorico}/comentario`, payload);
    return data;
  });
}

/** Exclui um anexo do processo. */
export async function deleteAnexo(idProcesso, anexoId) {
  if (USE_MOCK) {
    const extras = detalhesMock.extras?.[String(idProcesso)];
    if (extras?.anexos) {
      extras.anexos = extras.anexos.filter((a) => a.id_anexo !== anexoId);
    }
    return { ok: true };
  }
  return safe(async () => {
    const { data } = await apiV2.delete(`/processos/${idProcesso}/anexos/${anexoId}`);
    return data;
  });
}

/** Deferimento (1 por processo). */
export async function getDeferimento(idProcesso) {
  if (USE_MOCK) {
    const extras = detalhesMock.extras?.[String(idProcesso)] || {};
    return extras.deferimento ? clone(extras.deferimento) : null;
  }
  return safe(async () => {
    const { data } = await apiV2.get(`/processos/${idProcesso}/deferimento`);
    return data;
  });
}

export async function saveDeferimento(idProcesso, payload) {
  if (USE_MOCK) {
    const extras =
      detalhesMock.extras[String(idProcesso)] ||
      (detalhesMock.extras[String(idProcesso)] = {});
    extras.deferimento = {
      id_deferimento: extras.deferimento?.id_deferimento || Math.floor(Math.random() * 1e6),
      aprovacao: payload.aprovacao_id
        ? dimensoesMock.aprovacoes.find((a) => a.id === Number(payload.aprovacao_id))
        : null,
      instancia: payload.instancia_id
        ? dimensoesMock.instancias.find((i) => i.id === Number(payload.instancia_id))
        : null,
      data_procedencia: payload.data_procedencia || null,
      credito_simples: Number(payload.credito_simples) || 0,
      credito_dobro: Number(payload.credito_dobro) || 0,
      data_credito_dobro: payload.data_credito_dobro || null,
      observacoes: payload.observacoes || null,
    };
    return clone(extras.deferimento);
  }
  return safe(async () => {
    const { data } = await apiV2.post(
      `/processos/${idProcesso}/deferimento`,
      payload,
    );
    return data;
  });
}

/** Faturamento (N por processo). */
export async function getFaturamento(idProcesso) {
  if (USE_MOCK) {
    const extras = detalhesMock.extras?.[String(idProcesso)] || {};
    return { items: clone(extras.faturamento || []) };
  }
  return safe(async () => {
    const { data } = await apiV2.get(`/processos/${idProcesso}/faturamento`);
    return data;
  });
}

export async function createFaturamento(idProcesso, payload) {
  if (USE_MOCK) {
    const extras =
      detalhesMock.extras[String(idProcesso)] ||
      (detalhesMock.extras[String(idProcesso)] = {});
    if (!extras.faturamento) extras.faturamento = [];
    const novo = {
      id_faturamento: Math.floor(Math.random() * 1e6),
      ...payload,
    };
    extras.faturamento.push(novo);
    return novo;
  }
  return safe(async () => {
    const { data } = await apiV2.post(
      `/processos/${idProcesso}/faturamento`,
      payload,
    );
    return data;
  });
}

export async function updateFaturamento(idFaturamento, payload) {
  if (USE_MOCK) {
    for (const key of Object.keys(detalhesMock.extras)) {
      const list = detalhesMock.extras[key].faturamento || [];
      const idx = list.findIndex((x) => x.id_faturamento === Number(idFaturamento));
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...payload, id_faturamento: list[idx].id_faturamento };
        return clone(list[idx]);
      }
    }
    const e = new Error('Faturamento não encontrado');
    e.code = 'NOT_FOUND';
    throw e;
  }
  return safe(async () => {
    const { data } = await apiV2.put(`/faturamento/${idFaturamento}`, payload);
    return data;
  });
}

export async function deleteFaturamento(idFaturamento) {
  if (USE_MOCK) {
    for (const key of Object.keys(detalhesMock.extras)) {
      const list = detalhesMock.extras[key].faturamento || [];
      const idx = list.findIndex((x) => x.id_faturamento === Number(idFaturamento));
      if (idx >= 0) {
        list.splice(idx, 1);
        return { ok: true };
      }
    }
    return { ok: true };
  }
  return safe(async () => {
    const { data } = await apiV2.delete(`/faturamento/${idFaturamento}`);
    return data;
  });
}

/** Repasse (N por processo). */
export async function getRepasse(idProcesso) {
  if (USE_MOCK) {
    const extras = detalhesMock.extras?.[String(idProcesso)] || {};
    return { items: clone(extras.repasse || []) };
  }
  return safe(async () => {
    const { data } = await apiV2.get(`/processos/${idProcesso}/repasse`);
    return data;
  });
}

export async function createRepasse(idProcesso, payload) {
  if (USE_MOCK) {
    const extras =
      detalhesMock.extras[String(idProcesso)] ||
      (detalhesMock.extras[String(idProcesso)] = {});
    if (!extras.repasse) extras.repasse = [];
    const novo = {
      id_repasse: Math.floor(Math.random() * 1e6),
      ...payload,
      forma_devolucao: payload.forma_devolucao_id
        ? dimensoesMock.formas_devolucao.find(
            (f) => f.id === Number(payload.forma_devolucao_id),
          )
        : null,
    };
    extras.repasse.push(novo);
    return novo;
  }
  return safe(async () => {
    const { data } = await apiV2.post(
      `/processos/${idProcesso}/repasse`,
      payload,
    );
    return data;
  });
}

export async function updateRepasse(idRepasse, payload) {
  if (USE_MOCK) {
    for (const key of Object.keys(detalhesMock.extras)) {
      const list = detalhesMock.extras[key].repasse || [];
      const idx = list.findIndex((x) => x.id_repasse === Number(idRepasse));
      if (idx >= 0) {
        list[idx] = {
          ...list[idx],
          ...payload,
          id_repasse: list[idx].id_repasse,
          forma_devolucao: payload.forma_devolucao_id
            ? dimensoesMock.formas_devolucao.find(
                (f) => f.id === Number(payload.forma_devolucao_id),
              )
            : list[idx].forma_devolucao,
        };
        return clone(list[idx]);
      }
    }
    const e = new Error('Repasse não encontrado');
    e.code = 'NOT_FOUND';
    throw e;
  }
  return safe(async () => {
    const { data } = await apiV2.put(`/repasse/${idRepasse}`, payload);
    return data;
  });
}

export async function deleteRepasse(idRepasse) {
  if (USE_MOCK) {
    for (const key of Object.keys(detalhesMock.extras)) {
      const list = detalhesMock.extras[key].repasse || [];
      const idx = list.findIndex((x) => x.id_repasse === Number(idRepasse));
      if (idx >= 0) {
        list.splice(idx, 1);
        return { ok: true };
      }
    }
    return { ok: true };
  }
  return safe(async () => {
    const { data } = await apiV2.delete(`/repasse/${idRepasse}`);
    return data;
  });
}

/** Encerramento (1 por processo). */
export async function getEncerramento(idProcesso) {
  if (USE_MOCK) {
    const extras = detalhesMock.extras?.[String(idProcesso)] || {};
    return extras.encerramento ? clone(extras.encerramento) : null;
  }
  return safe(async () => {
    const { data } = await apiV2.get(`/processos/${idProcesso}/encerramento`);
    return data;
  });
}

export async function saveEncerramento(idProcesso, payload) {
  if (USE_MOCK) {
    const extras =
      detalhesMock.extras[String(idProcesso)] ||
      (detalhesMock.extras[String(idProcesso)] = {});
    extras.encerramento = {
      id_encerramento:
        extras.encerramento?.id_encerramento || Math.floor(Math.random() * 1e6),
      data_encerramento: payload.data_encerramento,
      motivo: payload.motivo,
      aprovacao_final: payload.aprovacao_id
        ? dimensoesMock.aprovacoes.find((a) => a.id === Number(payload.aprovacao_id))
        : null,
      parecer_final: payload.parecer_final || null,
    };
    // sincroniza processo: encerrado
    const proc = processosMock.items.find(
      (p) => p.id_processo === Number(idProcesso),
    );
    if (proc) {
      proc.etapa = { id: 6, nome: 'Encerramento' };
      proc.status = { id: 7, nome: 'Encerrado' };
      proc.instancia = null;
      proc.data_ultima_movimentacao = new Date().toISOString();
    }
    return clone(extras.encerramento);
  }
  return safe(async () => {
    const { data } = await apiV2.post(
      `/processos/${idProcesso}/encerramento`,
      payload,
    );
    return data;
  });
}

/** Marca/desmarca processo como relevante. PATCH /processos/:id/relevancia */
export async function setRelevancia(idProcesso, relevante) {
  const { data } = await apiV2.patch(`/processos/${idProcesso}/relevancia`, {
    relevante: !!relevante,
  });
  return data;
}

/** Movimentação. */
export async function movimentar(idProcesso, payload) {
  if (USE_MOCK) {
    const proc = processosMock.items.find(
      (p) => p.id_processo === Number(idProcesso),
    );
    if (!proc) {
      const e = new Error('Processo não encontrado');
      e.code = 'NOT_FOUND';
      throw e;
    }
    const etapaAlvo = dimensoesMock.etapas.find(
      (x) => x.id === Number(payload.etapa_id),
    );
    if (!etapaAlvo) {
      const e = new Error('Etapa inválida');
      e.code = 'ETAPA_INVALIDA';
      throw e;
    }
    // gate: só adjacente
    const ordemAtual = proc.etapa?.id || 1;
    if (Math.abs(etapaAlvo.id - ordemAtual) > 1) {
      const e = new Error(
        `Não é permitido pular de ${proc.etapa?.nome} para ${etapaAlvo.nome}`,
      );
      e.code = 'ETAPA_INVALIDA';
      throw e;
    }
    if (etapaAlvo.id === 6 && !payload.aprovacao_id) {
      const e = new Error('Encerramento exige status de aprovação.');
      e.code = 'CAMPO_OBRIGATORIO';
      throw e;
    }
    const novaEtapa = etapaAlvo;
    const novaInst =
      etapaAlvo.id >= 4
        ? null
        : dimensoesMock.instancias.find(
            (i) => i.id === Number(payload.instancia_id),
          ) || null;
    const novoStatus =
      dimensoesMock.status.find((s) => s.id === Number(payload.status_id)) ||
      proc.status;
    const novaAprov = payload.aprovacao_id
      ? dimensoesMock.aprovacoes.find(
          (a) => a.id === Number(payload.aprovacao_id),
        )
      : proc.aprovacao || null;

    // grava movimentação no histórico
    const extras =
      detalhesMock.extras[String(idProcesso)] ||
      (detalhesMock.extras[String(idProcesso)] = {});
    if (!extras.historico) extras.historico = [];
    extras.historico.unshift({
      id_movimentacao: Math.floor(Math.random() * 1e6),
      data_movimentacao: new Date().toISOString(),
      tipo_movimentacao: 'manual',
      usuario: { id: 0, nome: 'Você' },
      de: {
        etapa: proc.etapa,
        instancia: proc.instancia,
        status: proc.status,
        aprovacao: proc.aprovacao,
      },
      para: {
        etapa: novaEtapa,
        instancia: novaInst,
        status: novoStatus,
        aprovacao: novaAprov,
      },
      comentario: payload.comentario || null,
      justificativa_atraso: payload.justificativa_atraso || null,
    });

    proc.etapa = novaEtapa;
    proc.instancia = novaInst;
    proc.status = novoStatus;
    proc.aprovacao = novaAprov;
    proc.data_ultima_movimentacao = new Date().toISOString();

    return montaDetalheMock(idProcesso);
  }
  return safe(async () => {
    const { data } = await apiV2.post(
      `/processos/${idProcesso}/movimentar`,
      payload,
    );
    // ⭐ Sinaliza que a instância/etapa/status do processo mudou — telas que dependem
    // disso (ex.: página Prazos) escutam e refazem o fetch. Evita lista de prazos velha.
    try {
      window.dispatchEvent(
        new CustomEvent('processo:atualizado', { detail: { id: Number(idProcesso) } }),
      );
    } catch { /* ambiente sem window */ }
    return data;
  });
}

/** Dimensões (catálogos). Chamado 1x por sessão pelo react-query. */
export async function getDimensoes() {
  if (USE_MOCK) {
    return clone(dimensoesMock);
  }
  return safe(async () => {
    const { data } = await apiV2.get('/dimensoes');
    return data;
  });
}

export default {
  listProcessos,
  getProcesso,
  getHistorico,
  getHistoricoGlobal,
  getAnexos,
  uploadAnexo,
  getDeferimento,
  saveDeferimento,
  getFaturamento,
  createFaturamento,
  updateFaturamento,
  deleteFaturamento,
  getRepasse,
  createRepasse,
  updateRepasse,
  deleteRepasse,
  getEncerramento,
  saveEncerramento,
  movimentar,
  getDimensoes,
};
