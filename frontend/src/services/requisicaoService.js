// src/services/requisicaoService.js (cleaned)

import api, { withAuthToken } from './apiClient';
import { normalizeCreditoValue } from '../utils/brl';

// ======================= Auth & usuario =======================
export const login = (email, password) => api.post('/login', { email, password });
export const register = (userData) => api.post('/register', userData);

// ======================= Departamentos =======================
export const getDepartamentos = async () => {
  const res = await api.get('/departamentos');
  const d = res?.data;
  let list = [];
  if (Array.isArray(d)) list = d;
  else if (Array.isArray(d?.departamentos)) list = d.departamentos;
  else if (Array.isArray(d?.data)) list = d.data;
  else if (d && typeof d === 'object') list = [d];

  const normalize = (dep) => {
    const id =
      dep?.['id_departamen\u00e7o'] ??
      dep?.id_departamento ??
      dep?.idDepartamento ??
      dep?.id ??
      dep?.ID ??
      null;
    const nome = dep?.nome ?? dep?.name ?? dep?.descricao ?? dep?.description ?? '';
    return {
      ...dep,
      ['id_departamen\u00e7o']: dep?.['id_departamen\u00e7o'] ?? id,
      id_departamento: dep?.id_departamento ?? id,
      nome,
    };
  };
  return list.map(normalize);
};

// ======================= Requisicoes =======================
export const criarRequisicao = (formData) =>
  api.post('/requisicoes', formData, { headers: { 'Content-Type': 'multipart/form-data' } });

export const getAllRequisicoes = async () => {
  const { data } = await api.get('/requisicoes');
  const normalizar = (r) => {
    const toBox = (val) => (val != null && val !== '' ? { String: String(val), Valid: true } : val);
    const cliente =
      (r?.cliente && (r.cliente.String ?? r.cliente)) ||
      (r?.nome_cliente && (r.nome_cliente.String ?? r.nome_cliente)) ||
      (r?.razao_social_fatura && (r.razao_social_fatura.String ?? r.razao_social_fatura)) ||
      null;
    const uc = r?.uc && (r.uc.String ?? r.uc);
    const concessionaria = r?.concessionaria && (r.concessionaria.String ?? r.concessionaria);
    const out = { ...r };
    if (cliente) out.cliente = toBox(cliente);
    if (uc) out.uc = toBox(uc);
    if (concessionaria) out.concessionaria = toBox(concessionaria);
    return out;
  };
  return Array.isArray(data) ? data.map(normalizar) : data;
};

// Requisições visíveis por departamento (admin/gestor veem todas)
export const getRequisicoesDepartamento = async (params = {}) => {
  const { data } = await api.get('/requisicoes/departamento', { params });
  return Array.isArray(data) ? data : [];
};

// Minhas requisições (solicitante): tenta usar o backend quando suportado, senão filtra no cliente
export const getMinhasRequisicoes = async (me) => {
  try {
    const params = me ? { mine: 1 } : {};
    const { data } = await api.get('/requisicoes', { params });
    return Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [];
  } catch {
    return [];
  }
};

export const getRequisicaoById = async (id) => {
  const { data } = await api.get(`/requisicoes/${id}`);
  try {
    const fast = await getProcessosKanbanFast();
    const colunas = fast?.colunas || {};
    let found = null;
    for (const [nomeColuna, itens] of Object.entries(colunas)) {
      const hit = (itens || []).find((x) => String(x?.id) === String(id));
      if (hit) {
        found = { nome: nomeColuna };
        break;
      }
    }
    if (found) {
      data.coluna_kanban_nome = found.nome;
      const mapNome = (n) => {
        const s = String(n || '').toLowerCase();
        if (s.includes('ativo')) return 1;
        if (s.includes('deferid')) return 2;
        if (s.includes('fluxo')) return 3;
        if (s.includes('fatur')) return 4;
        if (s.includes('conclu')) return 5;
        if (s.includes('indefer')) return 6;
        return null;
      };
      const idCol = mapNome(found.nome);
      if (idCol) data.coluna_kanban_id = idCol;
      if (idCol && (data.coluna_kanban === undefined || data.coluna_kanban === null))
        data.coluna_kanban = idCol;
    }
  } catch (e) {
    console.warn('Aviso: falha ao enriquecer com kanban-fast:', e?.message || e);
  }
  if (data && !Array.isArray(data)) {
    const normalizeStr = (v) =>
      v && typeof v === 'object' && 'String' in v ? v.String ?? '' : v;
    if (data.valor_estimado === undefined) {
      data.valor_estimado =
        data.ressarcimento_estimado ??
        data.ressarcimentoEstimado ??
        data.valorEstimado ??
        null;
    }
    data.concessionaria = normalizeStr(
      data.concessionaria ?? data.concessionaria_sigla ?? data.concessionariaSigla,
    );
  }
  return data;
};

// Deferimento de um processo (FT_DEFERIMENTOS)
export const getDeferimentoByProcesso = async (id) => {
  try {
    const { data } = await api.get(`/processos/${id}/deferimento`);
    if (!data) return null;
    const unwrapDate = (v) => {
      if (!v) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'object') {
        if (v.Valid === false) return '';
        return v.Time || v.time || '';
      }
      return '';
    };
    const unwrapNumber = (v) => {
      if (v == null) return null;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const n = Number(v.replace(',', '.'));
        return isNaN(n) ? null : n;
      }
      if (typeof v === 'object') {
        if (v.Valid === false) return null;
        if (typeof v.Float64 === 'number') return v.Float64;
        if (typeof v.Float32 === 'number') return v.Float32;
      }
      return '';
    };
    const src = Array.isArray(data) ? data[0] : data.deferimento || data;
    const csRaw = unwrapNumber(src.credito_simples ?? src.creditoSimples ?? src.CreditoSimples);
    const cdRaw = unwrapNumber(src.credito_dobro ?? src.creditoDobro ?? src.CreditoDobro);
    const out = {
      data_procedencia:
        unwrapDate(src.data_procedencia || src.dataProcedencia || src.DataProcedencia) || '',
      credito_simples: normalizeCreditoValue(csRaw ?? ''),
      credito_dobro: normalizeCreditoValue(cdRaw ?? ''),
      data_credito_dobro:
        unwrapDate(src.data_credito_dobro || src.dataCreditoDobro || src.DataCreditoDobro) || '',
      status_analise: src.status_analise || src.statusAnalise || src.status || '',
    };
    return out;
  } catch {
    return null;
  }
};

// Histórico do processo/requisição
export const getHistoricoById = async (id) => {
  const [reqResp, procResp] = await Promise.allSettled([
    api.get(`/requisicoes/${id}/historico`),
    api.get(`/processos/${id}/historico`),
  ]);
  const reqList =
    reqResp.status === 'fulfilled' && Array.isArray(reqResp.value?.data)
      ? reqResp.value.data
      : [];
  const procList =
    procResp.status === 'fulfilled' && Array.isArray(procResp.value?.data)
      ? procResp.value.data
      : [];

  const getKey = (h) =>
    h?.id_historico ?? h?.historico_id ?? h?.hist_id ?? h?.id ?? h?.ID ?? null;

  const procMap = new Map();
  procList.forEach((h) => {
    const key = getKey(h);
    if (key != null) procMap.set(String(key), h);
  });

  const merged = reqList.map((h) => {
    const key = getKey(h);
    const extras = key != null ? procMap.get(String(key)) : null;
    const combined = { ...(extras || {}), ...(h || {}) };
    const prefer = (val, fallback) =>
      val != null && String(val).trim() !== '' ? val : fallback;
    if (extras) {
      ['etapa_nova', 'etapa_anterior', 'sub_etapa', 'sub_etapa_nova', 'sub_etapa_anterior',
       'status_novo', 'status_anterior', 'status_composto'].forEach((f) => {
        combined[f] = prefer(combined[f], extras[f]);
      });
    }
    if (extras?.anexos) combined.anexos = extras.anexos;
    if (extras?.canais) combined.canais = extras.canais;
    if (extras?.canal_comunicacao) combined.canal_comunicacao = extras.canal_comunicacao;
    return combined;
  });

  procList.forEach((h) => {
    const key = getKey(h);
    if (key == null) return;
    const exists = merged.some((m) => String(getKey(m)) === String(key));
    if (!exists) merged.push(h);
  });

  const sorted = merged.slice().sort((a, b) => {
    const getDate = (x) =>
      x?.data_movimentacao ||
      x?.dataMovimentacao ||
      x?.quando ||
      x?.data ||
      x?.data_criacao ||
      x?.dataCriacao ||
      '';
    const da = Date.parse(getDate(a));
    const db = Date.parse(getDate(b));
    if (!Number.isNaN(da) && !Number.isNaN(db)) return db - da;
    if (!Number.isNaN(db)) return 1;
    if (!Number.isNaN(da)) return -1;
    const ida = Number(getKey(a) ?? 0);
    const idb = Number(getKey(b) ?? 0);
    if (!Number.isNaN(ida) && !Number.isNaN(idb)) return idb - ida;
    return 0;
  });

  return sorted.map((h) => {
    const arr = Array.isArray(h.canais)
      ? h.canais
      : h.canal_comunicacao
      ? String(h.canal_comunicacao)
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : [];
    const csv =
      Array.isArray(h.canais) && h.canais.length
        ? h.canais.join(', ')
        : h.canal_comunicacao
        ? String(h.canal_comunicacao)
        : undefined;
    return { ...h, canais: arr, canal_comunicacao: csv };
  });
};

// ======================= Meta em lote (cards) =======================
export const getProcessosCardsMeta = async (ids = []) => {
  const list = Array.from(
    new Set(
      (ids || [])
        .map((x) => String(x).trim())
        .filter(Boolean),
    ),
  );
  if (list.length === 0) return [];
  const { data } = await api.get('/processos/cards-meta', {
    params: { ids: list.join(',') },
  });
  return Array.isArray(data) ? data : [];
};

// Atualiza todos os campos da requisição (rota do backend: POST /requisicoes/:id/update)
export const atualizarRequisicaoCompleta = async (id, payload) => {
  const { data } = await api.post(`/requisicoes/${id}/update`, payload);
  return data;
};

export async function getUltimasMovimentacoesBulk(ids) {
  if (!ids || ids.length === 0) return {};
  const { data } = await api.post('/requisicoes/historico/ultimas', { ids });
  return data || {};
}

// ======================= Processos / Kanban =======================
export const getProcessosKanban = async () =>
  (await api.get('/processos/kanban')).data;

export async function getProcessosKanbanFast(params = {}) {
  return (await api.get('/processos/kanban-fast', { params })).data;
}

export const getProcessoById = async (id) => getRequisicaoById(id);

// Busca fluxo já salvo
export const getFluxoRessarcimento = async (processoId) => {
  const { data } = await api.get(`/fluxo-ressarcimento/${processoId}`);
  return data;
};

// Busca faturamento já salvo
export const getFaturamento = async (processoId) => {
  const { data } = await api.get(`/faturamento/${processoId}`);
  return data;
};

export const movimentarProcesso = (id, data) => {
  const url = withAuthToken(`/processos/${id}/movimentar`);
  if (typeof FormData !== 'undefined' && data instanceof FormData) {
    return api.post(url, data);
  }
  return api.post(url, data);
};

export const descartarProcesso = (id, payload) =>
  api.post(`/processos/${id}/descartar`, payload);
export const excluirProcesso = (id) => api.delete(`/processos/${id}`);

// ======================= Fluxo & Faturamento =======================
export const salvarFluxoRessarcimento = async (processoId, payload) =>
  (await api.post(`/fluxo-ressarcimento/${processoId}`, payload)).data;

export const salvarDataAlerta = (processoId, data) =>
  api.post(`/processos/${processoId}/alerta`, data);

export const criarAlertaProcesso = async (processoId, mensagem) =>
  (await api.post(`/processos/${processoId}/alertas`, { mensagem })).data;

// ======================= Deferimento (autosave) =======================
export async function salvarDeferimento(processoId, deferimento) {
  const id = String(processoId || '').trim();
  if (!id) return { ok: false };
  const payload = { ...deferimento };
  const { data } = await api.post(`/processos/${id}/deferimento`, payload);
  return data || { ok: true };
}

// ======================= Filtros =======================
export const getFaturas = async (filters) => {
  const params = new URLSearchParams(filters || {}).toString();
  return (await api.get(`/faturas?${params}`)).data;
};

export const getConcessionariasParaFiltro = async () =>
  (await api.get('/filtros/concessionarias')).data;
export const getTensaoParaFiltro = async () =>
  (await api.get('/filtros/tensao')).data;
export const getEmpresasParaFiltro = async () =>
  (await api.get('/filtros/empresas')).data;

// ======================= UC =======================
export const buscarUC = async (numero, mesesRefs = []) => {
  const params = new URLSearchParams();
  (mesesRefs || []).forEach((m) => {
    if (m) params.append('mes_ref', m);
  });
  const qs = params.toString();
  const url = qs ? `/uc/${numero}?${qs}` : `/uc/${numero}`;
  return (await api.get(url)).data;
};

// Lista de opções de UC (quando há múltiplas combinações UC/Empresa/Concessionária)
export const getUCOpcoes = async (numero) => {
  const { data } = await api.get(`/uc/${numero}/opcoes`);
  if (Array.isArray(data?.opcoes)) return data.opcoes;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.rows)) return data.rows;
    const empresas =
      data.empresas ||
      data.Empresas ||
      data.empresas_uc ||
      data.empresas_da_uc ||
      [];
    if (Array.isArray(empresas) && empresas.length) {
      return empresas.map((e) => ({
        id_uc: String(data.id_uc || data.uc || data.unidade || numero),
        id_empresa: String(
          e.id_empresa || e.id || e.cod_empresa || e.codigo || e.cod || '',
        ),
        cliente: String(
          e.nome ||
            e.razao ||
            e.razao_social ||
            e.razaoSocial ||
            e.nome_fantasia ||
            '',
        ),
      }));
    }
  }
  return [];
};

export const buscarFaturasUC = async (numero, meses = []) => {
  const params = new URLSearchParams();
  (meses || []).forEach((m) => {
    if (m) params.append('mes', m);
  });
  const qs = params.toString();
  return (await api.get(`/uc/${numero}/faturas${qs ? `?${qs}` : ''}`)).data;
};

// Busca faturas por unidade (UC) e meses usando o alias publico /faturas-uc
export const buscarFaturasPorUnidadeMeses = async (unidade, meses = []) => {
  const params = new URLSearchParams();
  if (unidade) params.append('unidade', unidade);
  (meses || []).forEach((m) => {
    if (m) params.append('mes', m);
  });
  const qs = params.toString();
  return (await api.get(`/faturas-uc?${qs}`)).data;
};

// Anos disponíveis em Faturas_Implantadas para um trio (id_uc, id_empresa, id_concessionaria)
export const getFaturasAnos = async ({ id_uc, id_empresa, id_concessionaria }) => {
  const params = {};
  if (id_uc) params.id_uc = String(id_uc);
  if (id_empresa) params.id_empresa = String(id_empresa);
  if (id_concessionaria) params.id_concessionaria = String(id_concessionaria);
  const { data } = await api.get('/faturas-anos', { params });
  return Array.isArray(data?.anos) ? data.anos : [];
};

// ======================= Alertas =======================
export const getAlertas = async () => (await api.get('/alertas')).data;
export const marcarAlertasComoLidos = (alertaIds) =>
  api.post('/alertas/marcar-lido', { alerta_ids: alertaIds });

// ======================= E-mails =======================
export const enviarEmailProcesso = (processoId, emailData) => {
  const isForm = typeof FormData !== 'undefined' && emailData instanceof FormData;
  return api.post(`/processos/${processoId}/emails`, emailData, {
    headers: isForm ? { 'Content-Type': 'multipart/form-data' } : undefined,
  });
};
export const getEmailsByProcessoID = async (processoId) =>
  (await api.get(`/processos/${processoId}/emails`)).data;
export const marcarEmailProcessoLido = async (processoId, emailId) =>
  (await api.post(`/processos/${processoId}/emails/${emailId}/read`)).data;

// ======================= Tags =======================
export const getAllTags = async () => (await api.get('/tags')).data;
export const createTag = async (nome, cor) =>
  (await api.post('/tags', { nome, cor })).data;
export const updateProcessoTags = (processoId, tagIds) =>
  api.put(`/processos/${processoId}/tags`, tagIds);

// ======================= Dashboard =======================
export const getDashboardStats = async (filters = {}) => {
  const params = new URLSearchParams();
  Object.entries(filters || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') params.append(k, v);
  });
  const qs = params.toString();
  const url = qs ? `/dashboard/stats?${qs}` : '/dashboard/stats';
  const { data } = await api.get(url);
  try {
    if (data && data.valor_total_ressarcimento !== undefined && data !== null) {
      data['valor_total_ressarcimen\u00e7o'] = data.valor_total_ressarcimento;
    }
    if (data && data.processos_counts) {
      const pc = data.processos_counts;
      if (pc && pc.fluxo_ressarcimento !== undefined)
        pc['fluxo_ressarcimen\u00e7o'] = pc.fluxo_ressarcimento;
      if (pc && pc.faturamento !== undefined)
        pc['faturamen\u00e7o'] = pc.faturamento;
    }
  } catch {}
  return data;
};

// Movimentações no período (ini/fim em YYYY-MM-DD)
export const getMovimentacoesPeriodo = async (ini, fim) => {
  const qs = `ini=${encodeURIComponent(ini)}&fim=${encodeURIComponent(fim)}`;
  const { data } = await api.get(`/dashboard/movimentacoes?${qs}`);
  return data;
};

export const suspenderProcesso = async (id, comentario = '') =>
  (await api.post(`/processos/${id}/suspender`, { comentario })).data;
export const retomarProcesso = async (id, comentario = '') =>
  (await api.post(`/processos/${id}/retomar`, { comentario })).data;

// ======================= Historico =======================
export const getUltimoHistorico = async (id) => {
  try {
    const { data } = await api.get(`/requisicoes/${id}/historico`);
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch (error) {
    console.error('Erro ao buscar ultimo Historico:', error);
    return null;
  }
};

// ======================= Busca Global (históricos) =======================
export const searchGlobalHistorico = async (q, limit = 200, offset = 0, signal = undefined) => {
  const query = String(q ?? '').trim();
  if (!query) return { results: [], count: 0 };
  const params = { q: query };
  if (limit != null) params.limit = String(limit);
  if (offset != null) params.offset = String(offset);
  const { data } = await api.get('/api/v1/search/global', {
    params,
    baseURL: '',
    signal,
  });
  return data || { results: [], count: 0 };
};

// ======================= Dashboard helpers =======================
export function normalizeDashboardStats(data) {
  const def = {
    total_requisicoes: 0,
    total_processos: 0,
    valor_total_ressarcimento: 0,
    processos_counts: {
      ativos: 0,
      deferidos: 0,
      fluxo_ressarcimento: 0,
      faturamento: 0,
      concluidos: 0,
      indeferidos: 0,
    },
    status_counts: {
      pendente: 0,
      em_analise: 0,
      aprovado: 0,
      rejeitado: 0,
    },
    creditos: {
      simples_total: 0,
      dobro_total: 0,
      total_procedente: 0,
    },
    tempo_medio_dias_por_etapa: [],
    aging_por_coluna: { '0_7': 0, '8_15': 0, '16_30': 0, '31_mais': 0 },
    tendencia_30d: [],
    heatmap_semana: [],
  };
  const safeNum = (v) => (v == null || v === '' ? 0 : Number(v));
  const out = { ...def, ...(data || {}) };

  if (
    out['valor_total_ressarcimen\u00e7o'] != null &&
    out.valor_total_ressarcimento == null
  )
    out.valor_total_ressarcimento = safeNum(
      out['valor_total_ressarcimen\u00e7o'],
    );

  out.total_requisicoes = safeNum(out.total_requisicoes);
  out.total_processos = safeNum(out.total_processos);
  out.valor_total_ressarcimento = safeNum(out.valor_total_ressarcimento);

  out.processos_counts = {
    ...def.processos_counts,
    ...(out.processos_counts || {}),
  };
  if (
    out.processos_counts['fluxo_ressarcimen\u00e7o'] != null &&
    out.processos_counts.fluxo_ressarcimento == null
  )
    out.processos_counts.fluxo_ressarcimento = safeNum(
      out.processos_counts['fluxo_ressarcimen\u00e7o'],
    );
  if (
    out.processos_counts['faturamen\u00e7o'] != null &&
    out.processos_counts.faturamento == null
  )
    out.processos_counts.faturamento = safeNum(
      out.processos_counts['faturamen\u00e7o'],
    );
  Object.keys(out.processos_counts).forEach((k) => {
    out.processos_counts[k] = safeNum(out.processos_counts[k]);
  });

  out.status_counts = {
    ...def.status_counts,
    ...(out.status_counts || {}),
  };
  Object.keys(out.status_counts).forEach((k) => {
    out.status_counts[k] = safeNum(out.status_counts[k]);
  });

  out.creditos = { ...def.creditos, ...(out.creditos || {}) };
  out.creditos.simples_total = safeNum(out.creditos.simples_total);
  out.creditos.dobro_total = safeNum(out.creditos.dobro_total);
  if (out.creditos.total_procedente == null)
    out.creditos.total_procedente =
      out.creditos.simples_total + out.creditos.dobro_total;
  else out.creditos.total_procedente = safeNum(out.creditos.total_procedente);

  out.tempo_medio_dias_por_etapa = Array.isArray(
    out.tempo_medio_dias_por_etapa,
  )
    ? out.tempo_medio_dias_por_etapa
    : [];
  out.aging_por_coluna = {
    ...def.aging_por_coluna,
    ...(out.aging_por_coluna || {}),
  };
  Object.keys(out.aging_por_coluna).forEach((k) => {
    out.aging_por_coluna[k] = safeNum(out.aging_por_coluna[k]);
  });

  out.tendencia_30d = Array.isArray(out.tendencia_30d)
    ? out.tendencia_30d
    : [];
  out.heatmap_semana = Array.isArray(out.heatmap_semana)
    ? out.heatmap_semana
    : [];

  return out;
}

export const getDashboardStatsBI = async () =>
  normalizeDashboardStats(await getDashboardStats());
export const getDashboardHeatmapSemana = async () =>
  (await getDashboardStatsBI()).heatmap_semana;
export const getDashboardTendencia30d = async () =>
  (await getDashboardStatsBI()).tendencia_30d;
export const getDashboardTempoMedioPorEtapa = async () =>
  (await getDashboardStatsBI()).tempo_medio_dias_por_etapa;
export const getDashboardAgingPorColuna = async () =>
  (await getDashboardStatsBI()).aging_por_coluna;

// ======================= Prazos críticos =======================
export const getProcessosComPrazo = async () => {
  const { data } = await api.get('/processos/prazos');
  const rows = Array.isArray(data?.rows)
    ? data.rows
    : Array.isArray(data)
    ? data
    : [];
  const grupos = {};
  for (const r of rows) {
    const etapa = String(r?.etapa || '').trim() || 'Etapa';
    if (!grupos[etapa]) grupos[etapa] = [];
    grupos[etapa].push(r);
  }
  return { rows, grupos, count: rows.length };
};

// Backlog
export const getBacklog = async (limit) => {
  const params = {};
  if (limit) params.limit = limit;
  const { data } = await api.get('/processos/backlog', { params });
  const rows = Array.isArray(data?.rows) ? data.rows : Array.isArray(data) ? data : [];
  return {
    rows,
    total: Number(data?.total ?? rows.length),
    tratados: Number(data?.tratados ?? 0),
    nao_tratados: Number(data?.nao_tratados ?? rows.length),
  };
};

export const toggleBacklogCheck = async (id, checked) =>
  api.post(`/processos/${id}/backlog-check`, { checked });



// Garantir exportacoes explicitas (evita problemas em builds case-sensitive)

// ======================= Aliases e comentarios =======================
export const getUsuariosMencoes = async (q = '') =>
  (await api.get('/usuarios/mencoes', { params: { q } })).data || [];

export const comentarProcesso = async (id, { comentario = '', canais = [] } = {}) => {
  const payload = { comentario: comentario || '' };
  if (Array.isArray(canais) && canais.length > 0) payload.canais = canais;
  return (await api.post(`/processos/${id}/comentar`, payload)).data;
};

// ======================= NOVO: helpers por id_uc (Faturas_Implantadas) =======================

/**
 * Conta faturas para um id_uc.
 */
export async function contarFaturasPorIdUc(idUc) {
  if (!idUc) return 0;

  // 1) Tenta endpoints de contagem
  const countCandidates = [
    { url: '/faturas-implantadas/count', params: { id_uc: String(idUc) } },
    { url: '/faturas/count', params: { id_uc: String(idUc) } },
  ];

  for (const c of countCandidates) {
    try {
      const { data, status } = await api.get(c.url, { params: c.params });
      if (status >= 200 && status < 300) {
        const n = Number(data?.count ?? data?.qtde ?? data?.qtd ?? data);
        if (Number.isFinite(n)) return n;
      }
    } catch {}
  }

  // 2) Fallback: lista e conta
  const listCandidates = [
    { url: '/faturas-implantadas', params: { id_uc: String(idUc) } },
    { url: '/faturas', params: { id_uc: String(idUc) } },
    { url: '/faturas-uc', params: { unidade: String(idUc) } },
  ];

  for (const c of listCandidates) {
    try {
      const { data, status } = await api.get(c.url, { params: c.params });
      if (!(status >= 200 && status < 300)) continue;

      if (Array.isArray(data?.faturas)) return data.faturas.length;
      if (Array.isArray(data?.links_faturas_detalhes))
        return data.links_faturas_detalhes.length;
      if (Array.isArray(data?.links_faturas)) return data.links_faturas.length;
      if (Array.isArray(data)) return data.length;
    } catch {}
  }

  return 0;
}

/**
 * Busca faturas por id_uc e meses.
 */
export async function buscarFaturasPorIdUcMeses(
  idUc,
  mesesRefs = [],
  idEmpresa = '',
  idConcess = '',
) {
  if (!idUc) return { faturas: [] };

  const id = String(idUc);
  const emp = String(idEmpresa || '').trim();
  const conc = String(idConcess || '').trim();
  const params = { id_uc: id };
  if (Array.isArray(mesesRefs) && mesesRefs.length)
    params.meses = mesesRefs.join(',');
  if (emp) {
    params.id_empresa = emp;
    params.empresa_id = emp;
  }
  if (conc) {
    params.id_concess = conc;
    params.id_concessionaria = conc;
  }

  const filterByIds = (arr) => {
    const out = [];
    const seen = new Set();
    for (const f of Array.isArray(arr) ? arr : []) {
      const fid = String(
        f?.id_uc ?? f?.IdUC ?? f?.IDUC ?? f?.uc ?? f?.UC ?? f?.unidade ?? '',
      ).trim();
      if (fid && fid !== id) continue;
      if (emp) {
        const fe = String(
          f?.id_empresa ?? f?.IdEmpresa ?? f?.IDEmpresa ?? '',
        ).trim();
        if (fe && fe !== emp) continue;
      }
      if (conc) {
        const fc = String(
          f?.id_concessionaria ??
            f?.IdConcessionaria ??
            f?.IDConcessionaria ??
            f?.id_concess ??
            '',
        ).trim();
        if (fc && fc !== conc) continue;
      }
      const key = [
        String(f?.mes_ref ?? ''),
        String(f?.dt_vencimento ?? ''),
        String(f?.link ?? ''),
      ].join('|');
      if (!seen.has(key)) {
        seen.add(key);
        out.push(f);
      }
    }
    return out;
  };

  const strictCandidates = [
    { url: '/faturas-implantadas', params },
    { url: '/faturas-implantadas/todas', params },
  ];
  for (const c of strictCandidates) {
    try {
      const { data, status } = await api.get(c.url, { params: c.params });
      if (!(status >= 200 && status < 300)) continue;
      if (Array.isArray(data?.faturas))
        return { faturas: filterByIds(data.faturas) };
      if (Array.isArray(data)) return { faturas: filterByIds(data) };
    } catch {}
  }

  const fallbackByUnidade = (() => {
    const p = { unidade: id };
    if (mesesRefs.length) p.meses = mesesRefs.join(',');
    return [
      { url: '/faturas-uc', params: p },
      {
        url: '/faturas',
        params: {
          id_uc: id,
          id_empresa: emp || undefined,
          id_concess: conc || undefined,
          meses: params.meses,
        },
      },
    ];
  })();

  for (const c of fallbackByUnidade) {
    try {
      const { data, status } = await api.get(c.url, { params: c.params });
      if (!(status >= 200 && status < 300)) continue;
      if (Array.isArray(data?.faturas))
        return { faturas: filterByIds(data.faturas) };
      if (Array.isArray(data?.links_faturas_detalhes))
        return { faturas: filterByIds(data.links_faturas_detalhes) };
      if (Array.isArray(data?.links_faturas))
        return {
          faturas: data.links_faturas.map((l) => ({ link: l, mes_ref: '' })),
        };
      if (Array.isArray(data)) return { faturas: filterByIds(data) };
      if (data && typeof data === 'object' && (data.link || data.mes_ref)) {
        return {
          faturas: [{ link: data.link ?? '', mes_ref: data.mes_ref ?? '' }],
        };
      }
    } catch {}
  }

  return { faturas: [] };
}

/**
 * Lista todas as faturas de um id_uc (sem LIMIT), ordenadas por Mes_Ref ASC.
 */
export async function listarTodasFaturasPorIdUc(
  idUc,
  idEmpresa = '',
  idConcess = '',
) {
  const id = String(idUc || '').trim();
  if (!id) return { faturas: [] };
  const params = { id_uc: id };
  const emp = String(idEmpresa || '').trim();
  const conc = String(idConcess || '').trim();
  if (emp) {
    params.id_empresa = emp;
    params.empresa_id = emp;
  }
  if (conc) {
    params.id_concess = conc;
    params.id_concessionaria = conc;
  }
  const candidates = [{ url: '/faturas-implantadas/todas', params }];
  for (const c of candidates) {
    try {
      const { data, status } = await api.get(c.url, { params: c.params });
      if (!(status >= 200 && status < 300)) continue;
      const arr = Array.isArray(data?.faturas)
        ? data.faturas
        : Array.isArray(data)
        ? data
        : [];
      const out = [];
      const seen = new Set();
      for (const f of arr) {
        const fid = String(f?.id_uc ?? f?.IdUC ?? f?.uc ?? '').trim();
        if (fid && fid !== id) continue;
        if (emp) {
          const fe = String(f?.id_empresa ?? f?.IdEmpresa ?? '').trim();
          if (fe && fe !== emp) continue;
        }
        if (conc) {
          const fc = String(f?.id_concess ?? f?.IdConcess ?? '').trim();
          if (fc && fc !== conc) continue;
        }
        const key = [
          String(f?.mes_ref ?? ''),
          String(f?.dt_vencimento ?? ''),
          String(f?.link ?? ''),
        ].join('|');
        if (!seen.has(key)) {
          seen.add(key);
          out.push(f);
        }
      }
      return { faturas: out };
    } catch {}
  }
  return { faturas: [] };
}

/**
 * Retorna meses (YYYY-MM) distintos de Mes_Ref para um id_uc.
 */
export async function getMesesPorIdUc(idUcOrParams) {
  let params = {};
  if (idUcOrParams && typeof idUcOrParams === 'object') {
    const id = String(idUcOrParams.id_uc || idUcOrParams.idUc || '').trim();
    const emp = String(
      idUcOrParams.id_empresa || idUcOrParams.empresa_id || '',
    ).trim();
    const conc = String(
      idUcOrParams.id_concess || idUcOrParams.id_concessionaria || '',
    ).trim();
    const ano = String(idUcOrParams.ano || '').trim();
    if (id) params.id_uc = id;
    if (emp) {
      params.id_empresa = emp;
      params.empresa_id = emp;
    }
    if (conc) {
      params.id_concess = conc;
      params.id_concessionaria = conc;
    }
    if (ano) params.ano = ano;
  } else {
    const id = String(idUcOrParams || '').trim();
    if (id) params.id_uc = id;
  }
  if (!params.id_uc) return { meses: [] };
  try {
    const { data, status } = await api.get('/faturas-implantadas/meses', {
      params,
    });
    if (!(status >= 200 && status < 300)) return { meses: [] };
    const arr = Array.isArray(data?.meses) ? data.meses : Array.isArray(data) ? data : [];
    const meses = arr
      .map((s) => String(s).slice(0, 7))
      .filter(Boolean)
      .sort();
    return { meses };
  } catch {
    return { meses: [] };
  }
}


