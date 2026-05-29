// src/pages/utils/processosHelpers.js
//
// Helpers e constantes compartilhados entre Requisicoes.jsx, ControleProcessos.jsx
// e AdminPlanilha.jsx (legado).
//
// Originalmente definidos em AdminPlanilha.jsx (linhas 48-1047). Extraídos para
// arquivo próprio na Etapa 2a do desacoplamento.
//
// Não há mudança de comportamento — apenas mudança de localização.
//
import { useEffect, useState } from 'react';

// =======================
// CONSTANTES & CONFIG
// =======================
export const ETAPA_TABS = [
  { id: 'ATIVOS', label: 'Ativos', etapa: 'ATIVOS' },
  { id: 'DEFERIDOS', label: 'Deferidos', etapa: 'DEFERIDOS' },
  { id: 'FLUXO', label: 'Fluxo de Ressarcimento', etapa: 'FLUXO DE RESSARCIMENTO' },
  { id: 'FATURAMENTO', label: 'Faturamento', etapa: 'FATURAMENTO' },
  { id: 'CONCLUIDOS', label: 'Concluídos', etapa: 'CONCLUIDOS' },
  { id: 'INDEFERIDOS', label: 'Indeferidos', etapa: 'INDEFERIDOS' },
  { id: 'SUSPENSOS', label: 'Suspensos', etapa: 'SUSPENSOS' },
];

export const KANBAN_COLUNAS = ETAPA_TABS.map((t) => t.label);

export const MAPA_COLUNAS_PARA_ETAPAS = {
  Ativos: 'Distribuidora',
  Deferidos: 'Distribuidora',
  'Fluxo de Ressarcimento': 'Enviado ao Financeiro',
  Faturamento: 'Repasse Amee',
  'Concluídos': 'Concluído',
  Indeferidos: 'Indeferido',
  Suspensos: '',
};

export const KANBAN_ETAPAS = {
  Ativos: ['Distribuidora', 'Ouvidoria', 'ANEEL', 'SMA'],
  Deferidos: ['Distribuidora', 'Ouvidoria', 'ANEEL', 'SMA'],
  'Fluxo de Ressarcimento': ['Enviado ao Financeiro'],
  Faturamento: ['Repasse Amee'],
  'Concluídos': ['Concluído'],
  Indeferidos: ['Indeferido'],
  Suspensos: [],
};

export const DEFAULT_CANAIS = {
  whatsapp: false,
  ligacao: false,
  email: false,
  sms: false,
  site: false,
  pessoal: false,
};

export const EMAIL_EDITOR_MODULES = {
  toolbar: [
    ['bold', 'italic', 'underline', 'strike'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    [{ align: [] }],
    ['link'],
    ['clean'],
  ],
};

export const CANAIS_UI = [
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'ligacao', label: 'Ligação' },
  { key: 'email', label: 'E-mail' },
  { key: 'sms', label: 'SMS' },
  { key: 'site', label: 'Site' },
  { key: 'pessoal', label: 'Pessoal' },
];

export const RESUMO_PROMPT_VERSION = 'ressarcimento_v1';

// TROCA AQUI: antes estava 0 (load more nunca funcionava)
export const INITIAL_COLUMN_LIMIT = 200;

export const PROCESS_LIST_COLUMNS = [
  { key: 'id', label: 'Processo', sortable: true },
  { key: 'cliente', label: 'Cliente / UC', sortable: true },
  { key: 'valor', label: 'Ressarcimento estimado', sortable: true },
  { key: 'concessionaria', label: 'Concessionária', sortable: true },
  { key: 'status', label: 'Status atual', sortable: true },
  { key: 'ultima', label: 'Última movimentação', sortable: true },
  { key: 'dias_sem', label: 'Dias sem movimentar', sortable: true },
  { key: 'score_progressao', label: 'Score', sortable: false },
  { key: 'editar', label: '', sortable: false },
];

export const SUBETAPAS_DEFERIDOS = [
  'Em contestação - Em elaboração',
  'Em contestação - Aguardando retorno',
  'Em contestação - Em análise',
  'Em contestação - Pendente',
  'Em conciliação - Em elaboração',
  'Em Conciliação - Aguardando retorno',
  'Em Conciliação - Em análise',
  'Em Conciliação - Pendente',
  'Processo descontinuado',
];

export const METRICAS_PIE_COLOR = '#4f83ff';

export const MESES_PT = [
  'janeiro','fevereiro','março','abril','maio','junho',
  'julho','agosto','setembro','outubro','novembro','dezembro',
];

export const INFO_HISTORY_RE =
  /credito|repasse|ressarcimento estimado|data simples|data dobro|valor nf|numero nf|data emiss|data venc|data pag|forma de devolucao|fluxo|faturamento/i;

// =======================
// HELPERS — string / encoding
// =======================
export const norm = (v) => {
  try {
    return String(v || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
  } catch {
    return String(v || '').toLowerCase();
  }
};

// Mojibake / encoding repair (safe)
// Fixes strings like "RequisiÃ§Ã£o" (UTF-8 bytes interpreted as latin1),
// and even double-encoded variants like "RequisiÃƒÂ§ÃƒÂ£o".
export const looksLikeMojibake = (v) => {
  if (v == null) return false;
  const s = String(v);
  // Ã + continuation, Â + continuation, or the Unicode replacement char
  return /[ÃÂ][-¿]|�/.test(s) || s.includes('ÃƒÂ');
};

export const latin1ToUtf8 = (v) => {
  try {
    const s = String(v ?? '');
    const bytes = Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return v;
  }
};

export const fixMojibake = (v) => {
  if (v == null) return v;
  const s0 = String(v);
  if (!looksLikeMojibake(s0)) return v;

  let s = s0;
  // up to 2 passes handles double-encoding
  for (let i = 0; i < 2; i++) {
    const dec = latin1ToUtf8(s);
    if (dec === s) break;
    s = dec;
  }

  // normalize NBSP -> space (common after copy/paste)
  s = s.replace(/ /g, ' ');

  return s;
};

export const unwrapDbValue = (value) => {
  try {
    if (value == null) return '';
    if (typeof value === 'object') {
      if (value.Valid === false) return '';
      if (typeof value.String === 'string') return fixMojibake(value.String);
      if (typeof value.Int64 === 'number') return String(value.Int64);
      if (typeof value.Float64 === 'number') return String(value.Float64);
    }
    if (typeof value === 'string') return fixMojibake(value);
    return String(value);
  } catch {
    return '';
  }
};

export const pickFirst = (obj, keys, fallback = '') => {
  for (const k of keys) {
    const v = unwrapDbValue(obj?.[k]);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return fallback;
};

// =======================
// HELPERS — normalização (kanban / status / forma)
// =======================
export const normalizeKanbanName = (value) => {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('indefer')) return 'Indeferidos';
  if (s.includes('defer')) return 'Deferidos';
  if (s.includes('fluxo')) return 'Fluxo de Ressarcimento';
  if (s.includes('fatur')) return 'Faturamento';
  if (s.includes('conclu')) return 'Concluídos';
  if (s.includes('suspens')) return 'Suspensos';
  if (s.includes('ativo')) return 'Ativos';
  return '';
};

export const normalizeReqStatusValue = (value) => {
  const n = norm(unwrapDbValue(value));
  if (n.includes('nova requisicao') || n.includes('pendente')) return 'Nova Requisição';
  if (n.includes('analise')) return 'Em Análise';
  if (n.includes('aprov')) return 'Aprovado';
  if (n.includes('rejeit')) return 'Rejeitado';
  return value || '';
};

export const normalizeFormaDevolucao = (v) => {
  const s = norm(v);
  if (!s) return '';
  if (s.includes('fatura')) return 'Fatura';
  if (s === 'gd') return 'GD';
  if (s.startsWith('dep')) return 'Deposito';
  return String(v || '').trim();
};

// =======================
// HELPERS — datas
// =======================
export const toISODateFromPt = (pt) => {
  if (!pt) return '';
  const s = String(pt).trim();
  const m = s.match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/);
  if (!m) return s;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
};

export const toISODateTimeFromPt = (pt) => {
  if (!pt) return '';
  const s = String(pt).trim();
  const m = s.match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*$/);
  if (!m) return s;
  const [, d, mo, y, h, mi] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi.padStart(2, '0')}`;
};

export const toDateInput = (value) => {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^0{4}-0{2}-0{2}/.test(s) || /^0001-01-01/.test(s)) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return '';
};

export const toDateTimeLocal = (dbValue) => {
  const s = String(dbValue || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (m) return `${m[1]}T${m[2]}`;
  if (s.includes('T')) return s.slice(0, 16);
  return '';
};

export const formatDateTimeBR = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '-';
  let iso = raw.replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(iso)) iso = `${iso}Z`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return raw;
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'America/Sao_Paulo',
  }).format(parsed);
};

export const fromDateTimeLocal = (inputValue) => {
  const s = String(inputValue || '').trim();
  if (!s) return '';
  if (s.includes('T')) return s.replace('T', ' ') + ':00';
  return s;
};

export const nowDb = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export const formatDateBR = (date) => {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
};

export const getMonthRange = (year, monthIndex) => {
  const start = new Date(year, monthIndex, 1);
  const end = new Date(year, monthIndex + 1, 0);
  return { start, end };
};

export const getLast12MonthsRange = () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { start, end };
};

// Formata "2025-05" → "maio/2025" ou "05/2025" → "maio/2025"
export const formatMesRef = (mesRef) => {
  const s = String(mesRef || '').trim();
  if (!s) return '';
  // formato YYYY-MM
  const m1 = s.match(/^(\d{4})-(\d{2})$/);
  if (m1) {
    const nome = MESES_PT[parseInt(m1[2], 10) - 1];
    return nome ? `${nome}/${m1[1]}` : s;
  }
  // formato MM/YYYY
  const m2 = s.match(/^(\d{2})\/(\d{4})$/);
  if (m2) {
    const nome = MESES_PT[parseInt(m2[1], 10) - 1];
    return nome ? `${nome}/${m2[2]}` : s;
  }
  return s;
};

// =======================
// HELPERS — números / dinheiro
// =======================
export const toNumberValue = (value) => {
  if (value === '' || value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  const raw = String(value).trim();
  if (!raw) return '';
  const hasComma = raw.includes(',');
  const hasDot = raw.includes('.');
  let normalized = raw;
  if (hasComma && hasDot) {
    normalized = raw.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    normalized = raw.replace(',', '.');
  } else if (hasDot) {
    const last = raw.split('.').pop();
    normalized = last && last.length === 3 ? raw.replace(/\./g, '') : raw;
  }
  normalized = normalized.replace(/\s/g, '');
  const num = Number(normalized);
  return Number.isNaN(num) ? '' : num;
};

export const formatDecimalInput = (value) => {
  if (value === '' || value == null) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const num = toNumberValue(value);
  if (num === '' || !Number.isFinite(num)) return String(value ?? '');
  return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const formatCurrencyBR = (value) => {
  const n = toNumberValue(value);
  if (n === '' || !Number.isFinite(Number(n))) return '-';
  return Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

export const formatListMoney = (value) => {
  if (value === '' || value == null) return '';
  if (typeof value === 'number') return formatDecimalInput(value);
  return String(value);
};

// =======================
// HELPERS — detalhes / categoria do processo
// =======================
export const detailValue = (details, pid, field, fallback) =>
  details?.[pid]?.[field] ?? fallback ?? '';

export const detailValueMoney = (details, pid, field, fallback) => {
  const hasLocal = Object.prototype.hasOwnProperty.call(details?.[pid] || {}, field);
  const raw = detailValue(details, pid, field, fallback);
  if (raw === '' || raw == null) return '';
  if (hasLocal) return raw;
  return formatDecimalInput(raw);
};

export const determineProcessoCategory = (header, kanbanColuna) => {
  if (kanbanColuna) {
    const mapped = normalizeKanbanName(kanbanColuna);
    if (mapped) return mapped;
  }
  const idColunaRaw =
    header?.id_coluna ??
    header?.id_coluna_kanban ??
    header?.IdColunaKanban ??
    header?.idColunaKanban ??
    null;
  const idEtapaRaw =
    header?.id_etapa_processo ??
    header?.IdEtapaProcesso ??
    header?.idEtapaProcesso ??
    null;
  if (Number(idEtapaRaw) === 11) return 'Indeferidos';
  const nomeColunaTxt = String(header?.nome_coluna || '').toLowerCase();
  if (Number(idColunaRaw) === 5 && nomeColunaTxt.includes('conclu')) {
    return 'Concluídos';
  }

  const hasDeferimento =
    (header?.credito_simples && Number(header.credito_simples) > 0) ||
    (header?.credito_dobro && Number(header.credito_dobro) > 0) ||
    String(header?.data_simples || header?.data_procedencia || '').trim() !== '' ||
    String(header?.data_dobro || header?.data_credito_dobro || '').trim() !== '';

  const hasFluxo =
    (header?.valor_fluxo && Number(header.valor_fluxo) > 0) ||
    String(header?.data_devolucao || '').trim() !== '' ||
    String(header?.data_envio_financeiro || '').trim() !== '' ||
    String(header?.forma_devolucao || '').trim() !== '';
  const hasFaturamento =
    String(header?.numero_nf || '').trim() !== '' ||
    String(header?.data_emissao || '').trim() !== '' ||
    String(header?.data_vencimento || '').trim() !== '' ||
    String(header?.data_pagamento || '').trim() !== '' ||
    String(header?.valor_nf || header?.valor_faturamento || header?.valor_fat || '').trim() !== '';
  const isPago = String(header?.data_pagamento || '').trim() !== '';
  const isSuspenso =
    header?.suspenso === true ||
    header?.suspenso === 1 ||
    String(header?.suspenso || '').trim() === '1' ||
    String(header?.sub_etapa || '').toLowerCase().includes('suspenso');

  const etapaTxt = String(header?.etapa || header?.etapa_atual || '').toLowerCase();
  const subEtapaTxt = String(header?.sub_etapa || '').toLowerCase();
  if (etapaTxt.includes('enviado ao financeiro') || subEtapaTxt.includes('enviado ao financeiro')) {
    if (subEtapaTxt.includes('enviado') && hasFluxo) return 'Faturamento';
    return 'Fluxo de Ressarcimento';
  }
  if (etapaTxt.includes('repasse amee') || subEtapaTxt.includes('repasse amee')) {
    return 'Faturamento';
  }

  if (isSuspenso) return 'Suspensos';
  if (isPago) return 'Concluídos';
  if (hasFaturamento) return 'Faturamento';
  if (hasFluxo) return 'Fluxo de Ressarcimento';
  if (hasDeferimento) return 'Deferidos';

  if (Number(idColunaRaw) === 2) return 'Deferidos';
  if (Number(idColunaRaw) === 1) {
    const subId = Number(
      header?.id_sub_etapa_processo ??
        header?.IdSubEtapaProcesso ??
        header?.idSubEtapaProcesso ??
        header?.id_subetapa_processo ??
        0,
    );
    const subTxt = String(header?.sub_etapa || '').toLowerCase().trim();
    if (subId === 1 || subTxt.includes('primeira reclamação da etapa - em elaboração')) return '';
    return 'Ativos';
  }
  if (Number(idColunaRaw) === 3) return 'Fluxo de Ressarcimento';
  if (Number(idColunaRaw) === 4) return 'Faturamento';
  if (Number(idColunaRaw) === 5) return 'Concluídos';
  if (Number(idColunaRaw) === 6) return 'Indeferidos';

  if (header?.nome_coluna) {
    const mapped = normalizeKanbanName(header.nome_coluna);
    if (mapped) return mapped;
  }
  const etapaAtual = header?.etapa_atual ?? header?.etapaAtual ?? '';
  if (etapaAtual) {
    const mapped = normalizeKanbanName(etapaAtual);
    if (mapped) return mapped;
  }
  const etapaHist = header?.etapa ?? '';
  if (etapaHist) {
    const mapped = normalizeKanbanName(etapaHist);
    if (mapped) return mapped;
  }
  return 'Ativos';
};

export const getDeferimentoDefaults = (header, snapshotData, requisicaoData) => {
  const sources = [header, snapshotData, requisicaoData];

  const pickFromSources = (keys) => {
    for (const src of sources) {
      const value = pickFirst(src || {}, keys, '');
      if (value == null) continue;
      const raw = String(value).trim();
      if (!raw) continue;
      if (/^0{4}-0{2}-0{2}/.test(raw) || /^0001-01-01/.test(raw)) continue;
      return value;
    }
    return '';
  };

  return {
    cs: pickFromSources(['credito_simples', 'creditoSimples', 'deferimento_simples']),
    ds: pickFromSources(['data_simples', 'data_procedencia', 'dataSimples']),
    cd: pickFromSources(['credito_dobro', 'creditoDobro', 'deferimento_dobro']),
    dd: pickFromSources(['data_dobro', 'data_credito_dobro', 'dataDobro']),
    rs: pickFromSources(['repasse_simples', 'repasse_amee', 'repasseSimples']),
    rd: pickFromSources(['repasse_dobro', 'repasseDobro']),
  };
};

// =======================
// HELPERS — histórico / etapas
// =======================
export const getSubEtapaFromStatus = (item) => {
  const direct = pickFirst(item, ['sub_etapa_nova', 'sub_etapa', 'SubEtapa'], '');
  if (String(direct || '').trim()) return direct;
  const status = pickFirst(item, ['status_composto', 'status_novo', 'status'], '');
  if (!status || !String(status).includes(' - ')) return '';
  const parts = String(status).split(' - ');
  if (parts.length < 2) return '';
  const sub = parts.slice(1).join(' - ').trim();
  return sub.replace(/\s+via\s+.*$/i, '').trim();
};

export const toSentenceCase = (value) => {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
};

export const getEtapaFromStatusComp = (item) => {
  const status = pickFirst(item, ['status_composto', 'status_novo', 'status'], '');
  if (!status || !String(status).includes(' - ')) return '';
  const parts = String(status).split(' - ');
  return parts.length ? parts[0].trim() : '';
};

export const getHistoryEtapaSub = (item) => {
  const etapa =
    pickFirst(item, ['etapa_nova', 'etapa', 'Etapa', 'etapa_atual', 'etapa_anterior'], '') ||
    getEtapaFromStatusComp(item);
  const sub = getSubEtapaFromStatus(item);
  return { etapa: String(etapa || '').trim(), sub: String(sub || '').trim() };
};

export const isInfoHistoryItem = (item) => {
  const tipo = String(pickFirst(item, ['tipo_movimentacao', 'tipo', 'Tipo'], '')).toLowerCase();
  const comentario = String(pickFirst(item, ['hist_comentario', 'comentario'], '')).toLowerCase();
  if (!comentario) return false;
  if (['auto', 'update', 'deferimento', 'faturamento', 'fluxo'].includes(tipo)) return true;
  // Movimentacao com sub-etapa de status real (ex: "Indeferido - Processo descontinuado")
  // NUNCA e item informativo, mesmo que o texto livre mencione "faturamento"/"credito"/
  // "fluxo" etc. Sem isso, esses comentarios fariam a movimentacao sumir da timeline.
  if (String(getSubEtapaFromStatus(item) || '').trim()) return false;
  return INFO_HISTORY_RE.test(comentario);
};

export const splitHistoryItems = (items) => {
  const info = [];
  const display = [];
  (items || []).forEach((item) => {
    if (isInfoHistoryItem(item)) info.push(item);
    else display.push(item);
  });
  return { info, display };
};

export const groupHistoryByStage = (items) => {
  const out = [];
  (items || []).forEach((item) => {
    const { etapa } = getHistoryEtapaSub(item);
    const key = etapa || 'Sem etapa';
    const last = out[out.length - 1];
    if (!last || last.etapa !== key) {
      out.push({ etapa: key, items: [item] });
      return;
    }
    last.items.push(item);
  });
  return out;
};

export const isProcessoCriadoHistory = (item) => {
  const comentario = String(pickFirst(item, ['hist_comentario', 'comentario', 'descricao'], '')).toLowerCase().trim();
  if (!comentario) return false;
  if (comentario.includes('processo criado')) return true;
  // bloco informativo inicial (UC/Cliente/Concessionária/Valor/etc)
  if (
    comentario.includes('uc:') &&
    comentario.includes('cliente:') &&
    comentario.includes('concession') &&
    comentario.includes('valor estimado')
  ) {
    return true;
  }
  return false;
};

export const formatHistoryComentarioLines = (comentario) => {
  if (!comentario) return [];
  const text = String(comentario).trim();
  if (!text) return [];
  if (text.includes('UC:') || text.includes('Cliente:')) {
    // quebra por chaves conhecidas, preservando o texto
    return text
      .replace(/(UC:|Cliente:|Concessionária:|Valor estimado:|Criado em:|Período:|Classificação:|Irregularidade:|Sub irregularidade:|Fatura:|Anexos:|Descrição:)/g, '\n$1')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
};

export const isRelevante = (header, pid, relMap) => {
  if (pid != null && relMap && Object.prototype.hasOwnProperty.call(relMap, String(pid))) {
    return !!relMap[String(pid)];
  }
  const raw = header?.relevancia ?? header?.relevante ?? header?.relevancia_nova;
  if (raw === true) return true;
  if (raw === false) return false;
  const s = String(raw || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'sim';
};

// =======================
// HELPERS — timestamps / linha
// =======================
export const toTs = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const ts = new Date(raw.replace(' ', 'T')).getTime();
  return Number.isNaN(ts) ? 0 : ts;
};

export const rowLastTs = (row) => {
  const header = row?.header || {};
  const hist = Array.isArray(row?.history) ? row.history : [];

  const headerTs = toTs(
    pickFirst(header, [
      'data_ultima_movimentacao',
      'ultima_movimentacao',
      'dataUltimaMovimentacao',
      'ultimaMovimentacao',
    ]),
  );

  const histTs = hist.reduce((max, h) => {
    const etapaVal = pickFirst(h, ['etapa', 'etapa_nova', 'Etapa'], '');
    const subVal = getSubEtapaFromStatus(h);
    if (!String(etapaVal || '').trim() && !String(subVal || '').trim()) return max;
    const v = pickFirst(h, ['hist_data', 'data_movimentacao', 'data', 'created_at'], '');
    const ts = toTs(v);
    return ts > max ? ts : max;
  }, 0);

  return Math.max(headerTs, histTs);
};

// =======================
// HELPERS — snapshots / períodos / resumo
// =======================
export const formatSnapshotValue = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.filter((v) => v != null && String(v).trim()).join(', ');
  return String(value).trim();
};

export const formatPeriodosIrregularidade = (value) => {
  if (value == null) return '';
  let data = value;

  if (typeof data === 'string') {
    const s = data.trim();
    if (!s) return '';
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        data = JSON.parse(s);
      } catch {
        return s;
      }
    } else {
      return s;
    }
  }

  if (Array.isArray(data)) {
    const out = data
      .map((it) => {
        if (it == null) return '';
        if (typeof it === 'string') return it.trim();
        if (typeof it === 'object') {
          return String(
            it.raw ??
              it.periodo ??
              it.periodo_irregularidade ??
              it.periodoIrregularidade ??
              it.valor ??
              '',
          ).trim();
        }
        return String(it).trim();
      })
      .filter(Boolean);
    return out.join(', ');
  }

  if (typeof data === 'object') {
    const single = data.raw ?? data.periodo ?? data.periodo_irregularidade ?? data.periodoIrregularidade;
    return formatSnapshotValue(single ?? data);
  }

  return formatSnapshotValue(data);
};

export const buildComentarioFinal = ({ texto }) => String(texto || '').trim();

export const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',');
  return `{${body}}`;
};

export const cleanToken = (t) => String(t || '').trim().replace(/^['"]+|['"]+$/g, '');

export const getAuthToken = () => {
  try {
    return cleanToken(localStorage.getItem('userToken') || '');
  } catch {
    return '';
  }
};

export const sha256Hex = async (text) => {
  if (!globalThis.crypto?.subtle) return '';
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = Array.from(new Uint8Array(hash));
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
};

export const buildResumoInputPayload = (row) => {
  if (!row) return null;
  const header = row.header || {};
  const history = Array.isArray(row.history) ? row.history : [];
  const historyItems = history.slice(0, 200).map((h) => ({
    data: pickFirst(h, ['hist_data', 'data_movimentacao', 'data', 'created_at'], ''),
    etapa: pickFirst(h, ['etapa', 'etapa_nova', 'Etapa'], ''),
    sub_etapa: pickFirst(h, ['sub_etapa', 'SubEtapa'], ''),
    comentario: pickFirst(h, ['hist_comentario', 'comentario'], ''),
  }));

  return {
    processo_id: row.pid,
    cliente: pickFirst(header, ['cliente', 'Cliente']),
    concessionaria: pickFirst(header, ['concessionaria', 'concessionaria_nome', 'Concessionaria']),
    unidade: pickFirst(header, ['uc', 'Uc', 'UC']),
    etapa_atual: pickFirst(header, ['etapa_atual', 'etapa', 'Etapa']),
    subetapa_atual: pickFirst(header, ['sub_etapa', 'subetapa', 'SubEtapa']),
    coluna_kanban: row.category || '',
    status_analise: pickFirst(header, ['status', 'status_analise', 'status_processo']),
    credito_simples: header.credito_simples ?? '',
    credito_dobro: header.credito_dobro ?? '',
    repasse_simples: header.repasse_simples ?? header.repasse_amee ?? '',
    repasse_dobro: header.repasse_dobro ?? '',
    data_procedencia: header.data_procedencia ?? header.data_simples ?? '',
    data_credito_dobro: header.data_credito_dobro ?? header.data_dobro ?? '',
    historico: historyItems,
  };
};

export const findValorPorColuna = (metricas, label) => {
  const rows = Array.isArray(metricas?.valor_por_coluna)
    ? metricas.valor_por_coluna
    : Array.isArray(metricas?.valorPorColuna)
    ? metricas.valorPorColuna
    : [];
  const target = String(label || '').toLowerCase();
  const hit = rows.find((r) => String(r?.label || '').toLowerCase().includes(target));
  const total = hit?.total ?? hit?.valor ?? 0;
  return Number.isFinite(Number(total)) ? Number(total) : 0;
};

export const buildRowsFromKanbanFast = (data) => {
  const colunasRaw = data?.colunas || data?.columns || null;
  const colunas =
    colunasRaw && !Array.isArray(colunasRaw) && typeof colunasRaw === 'object'
      ? colunasRaw
      : Array.isArray(data?.rows) || Array.isArray(data)
      ? (Array.isArray(data?.rows) ? data.rows : data).reduce((acc, item) => {
          const col =
            item?.coluna ||
            item?.coluna_kanban ||
            item?.nome_coluna ||
            item?.kanban_coluna ||
            'Ativos';
          if (!acc[col]) acc[col] = [];
          acc[col].push(item);
          return acc;
        }, {})
      : {};
  const rows = [];
  const map = {};
  const relMap = {};

  Object.entries(colunas).forEach(([col, itens]) => {
    (itens || []).forEach((p) => {
      const id = p?.id ?? p?.ID ?? p?.processo_id ?? p?.processoId ?? p?.ProcessoID;
      if (id == null || id === '') return;

      map[String(id)] = col;
      relMap[String(id)] = !!p?.relevancia;

      const header = {
        processo_id: id,
        id_processo: id,
        uc: p?.uc ?? p?.UC ?? '',
        cliente: p?.cliente ?? p?.Cliente ?? '',
        concessionaria: p?.concessionaria ?? p?.Concessionaria ?? '',
        ressarcimento_estimado: p?.valor_estimado ?? p?.valorEstimado ?? '',
        valor_estimado: p?.valor_estimado ?? p?.valorEstimado ?? '',
        credito_simples: p?.credito_simples ?? p?.creditoSimples ?? '',
        credito_dobro: p?.credito_dobro ?? p?.creditoDobro ?? '',
        sub_etapa: p?.sub_etapa ?? p?.subEtapa ?? '',
        etapa_atual: p?.etapa ?? p?.Etapa ?? '',
        nome_coluna: col,
        id_coluna: p?.id_coluna ?? p?.id_coluna_kanban ?? p?.idColunaKanban ?? p?.IdColunaKanban ?? '',
        id_etapa_processo: p?.id_etapa_processo ?? p?.idEtapaProcesso ?? p?.IdEtapaProcesso ?? '',
        relevancia: p?.relevancia ?? false,
        data_alerta: p?.data_alerta ?? p?.dataAlerta ?? '',
        ultima_atualizacao: p?.ultima_atualizacao ?? p?.ultimaAtualizacao ?? '',
        data_ultima_movimentacao: p?.data_ultima_movimentacao ?? p?.dataUltimaMovimentacao ?? '',
        suspenso: p?.suspenso ?? false,
        repasse_simples: p?.repasse_simples ?? p?.repasseSimples ?? '',
        repasse_dobro: p?.repasse_dobro ?? p?.repasseDobro ?? '',
        data_procedencia: p?.data_procedencia ?? p?.dataProcedencia ?? p?.data_simples ?? p?.dataSimples ?? '',
        data_simples: p?.data_simples ?? p?.dataSimples ?? p?.data_procedencia ?? p?.dataProcedencia ?? '',
        data_credito_dobro: p?.data_credito_dobro ?? p?.dataCreditoDobro ?? p?.data_dobro ?? p?.dataDobro ?? '',
        data_dobro: p?.data_dobro ?? p?.dataDobro ?? p?.data_credito_dobro ?? p?.dataCreditoDobro ?? '',
        score_percentual: p?.score_percentual ?? null,
      };

      rows.push(header);
    });
  });

  return { rows, map, relMap };
};

export const mergeRowsByColumn = (prev, incoming, columnLabel) => {
  if (!columnLabel) return [...incoming];
  const keep = [];
  for (const row of prev || []) {
    const header = row || {};
    const col = header?.nome_coluna || '';
    if (col !== columnLabel) keep.push(row);
  }
  return [...keep, ...incoming];
};

// =======================
// HOOKS — utilitários React
// =======================
export const useTimer = (refreshInterval = 60000) => {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), refreshInterval);
    return () => clearInterval(id);
  }, [refreshInterval]);
  return time;
};

export const useDebouncedValue = (value, delay = 350) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return debounced;
};

export const useChunkedRender = (items, { initial = 120, step = 160, enabled = true } = {}) => {
  const [count, setCount] = useState(initial);

  useEffect(() => {
    if (!enabled) {
      setCount(items.length);
      return;
    }
    setCount(Math.min(initial, items.length));
  }, [items.length, enabled, initial]);

  useEffect(() => {
    if (!enabled) return;
    if (count >= items.length) return;

    let cancel = null;
    const schedule = () => setCount((c) => Math.min(c + step, items.length));

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      const id = window.requestIdleCallback(schedule, { timeout: 120 });
      cancel = () => window.cancelIdleCallback(id);
    } else {
      const id = window.setTimeout(schedule, 16);
      cancel = () => window.clearTimeout(id);
    }

    return () => cancel?.();
  }, [count, items.length, enabled, step]);

  return items.slice(0, count);
};
