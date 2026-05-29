// src/pages/ControleProcessos.jsx
//
// Página de Controle de Processos. Originalmente um wrapper de AdminPlanilha,
// agora componente standalone — Etapa 2d.3.
//
// O branch requisicoes ainda está presente como dead code, mas nunca renderiza
// porque forceViewMode='processos' está hardcoded. A poda final será feita em
// uma etapa futura sem risco.
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import { createPortal } from 'react-dom';
import { Activity, RefreshCcw, Paperclip, X, Mail, Clock, FileText, Trash2, Sparkles, Pencil } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, Customized, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';

import { getEtapas, getEtapaSubMap } from '../services/filtersService';
import { saveProcessoFull } from '../services/adminEditorService';
import {
  getAllRequisicoes,
  getHistoricoById,
  getRequisicaoById,
  buscarFaturasPorUnidadeMeses,
  atualizarRequisicaoCompleta,
  getProcessosKanbanFast,
  getBacklog,
  getProcessosComPrazo,
  comentarProcesso,
  movimentarProcesso,
  searchGlobalHistorico,
} from '../services/requisicaoService';
import api, { withAuthToken } from '../services/apiClient';
import { getSummary, refreshSummary } from '../services/summaryService';
import { sendResumoFeedback } from '../services/resumoFeedbackService';
import { getRelatoriosMetricasBatch } from '../services/relatoriosService';
import { sendMailMessage, linkMailToProcess } from '../services/mailService';
import { deleteHistorico } from '../services/adminPlanilhaService';
import { getProcessoScore } from '../services/mlService';
import { scoreQueue } from '../services/requestQueueService';
import { getTiposIrregularidade, getSubtiposIrregularidade } from '../services/irregularidadeService';
import Toast from '../components/Toast.jsx';
import { confirmAction } from '../utils/confirm.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useEmailCompose } from '../context/EmailComposeContext.jsx';
import { sanitizeEmail } from '../utils/safeHtml.js';
import ProcessosKanbanView from './processos/ProcessosKanbanView.jsx';
import useAtivosMetricas from './processos/useAtivosMetricas.js';
import useProcessosFiltros from './processos/useProcessosFiltros.js';
import useProcessosTabela from './processos/useProcessosTabela.js';
import useProcessoDrawerState from './processos/useProcessoDrawerState.js';
import useProcessosLoad from './processos/useProcessosLoad.js';

// =======================
// CONSTANTES & CONFIG
// =======================
const ETAPA_TABS = [
  { id: 'ATIVOS', label: 'Ativos', etapa: 'ATIVOS' },
  { id: 'DEFERIDOS', label: 'Deferidos', etapa: 'DEFERIDOS' },
  { id: 'FLUXO', label: 'Fluxo de Ressarcimento', etapa: 'FLUXO DE RESSARCIMENTO' },
  { id: 'FATURAMENTO', label: 'Faturamento', etapa: 'FATURAMENTO' },
  { id: 'CONCLUIDOS', label: 'Concluídos', etapa: 'CONCLUIDOS' },
  { id: 'INDEFERIDOS', label: 'Indeferidos', etapa: 'INDEFERIDOS' },
  { id: 'SUSPENSOS', label: 'Suspensos', etapa: 'SUSPENSOS' },
];

const KANBAN_COLUNAS = ETAPA_TABS.map((t) => t.label);

const MAPA_COLUNAS_PARA_ETAPAS = {
  Ativos: 'Distribuidora',
  Deferidos: 'Distribuidora',
  'Fluxo de Ressarcimento': 'Enviado ao Financeiro',
  Faturamento: 'Repasse Amee',
  'Concluídos': 'Concluído',
  Indeferidos: 'Indeferido',
  Suspensos: '',
};

const KANBAN_ETAPAS = {
  Ativos: ['Distribuidora', 'Ouvidoria', 'ANEEL', 'SMA'],
  Deferidos: ['Distribuidora', 'Ouvidoria', 'ANEEL', 'SMA'],
  'Fluxo de Ressarcimento': ['Enviado ao Financeiro'],
  Faturamento: ['Repasse Amee'],
  'Concluídos': ['Concluído'],
  Indeferidos: ['Indeferido'],
  Suspensos: [],
};

// Fallback hardcoded das subetapas por etapa — espelha o que o backend monta
// em GetEtapaSubCombinacoes (etapas_sub_handler.go) a partir de
// DM_SUBETAPA_PROCESSOS. Usado quando getEtapaSubMap() falha silenciosamente
// (ex: token expirado retorna {} no catch) e a select ficaria vazia.
const SUBETAPAS_FALLBACK = {
  Distribuidora: [
    'Primeira reclamação - Aguardando retorno',
    'Primeira reclamação - Em análise',
    'Primeira reclamação - Pendente',
  ],
  Ouvidoria: [
    'Em contestação - Em elaboração',
    'Em contestação - Aguardando retorno',
    'Em contestação - Em análise',
    'Em contestação - Pendente',
    'Em conciliação - Em elaboração',
    'Em Conciliação - Aguardando retorno',
    'Em Conciliação - Em análise',
    'Em Conciliação - Pendente',
  ],
  ANEEL: [
    'Em contestação - Em elaboração',
    'Em contestação - Aguardando retorno',
    'Em contestação - Em análise',
    'Em contestação - Pendente',
  ],
  SMA: [
    'Em contestação - Em elaboração',
    'Em contestação - Aguardando retorno',
    'Em contestação - Em análise',
    'Em contestação - Pendente',
  ],
  'Enviado ao Financeiro': ['Aguardando envio financeiro', 'Enviado'],
  'Repasse Amee': ['Aguardando pagamento NF'],
  Indeferido: ['Processo descontinuado'],
};

const DEFAULT_CANAIS = {
  whatsapp: false,
  ligacao: false,
  email: false,
  sms: false,
  site: false,
  pessoal: false,
};

const EMAIL_EDITOR_MODULES = {
  toolbar: [
    ['bold', 'italic', 'underline', 'strike'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    [{ align: [] }],
    ['link'],
    ['clean'],
  ],
};

const CANAIS_UI = [
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'ligacao', label: 'Ligação' },
  { key: 'email', label: 'E-mail' },
  { key: 'sms', label: 'SMS' },
  { key: 'site', label: 'Site' },
  { key: 'pessoal', label: 'Pessoal' },
];

const RESUMO_PROMPT_VERSION = 'ressarcimento_v1';

// TROCA AQUI: antes estava 0 (load more nunca funcionava)
const INITIAL_COLUMN_LIMIT = 200;

// =======================
// HELPERS (perf + util)
// =======================
const norm = (v) => {
  try {
    return String(v || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  } catch {
    return String(v || '').toLowerCase();
  }
};

// =======================
// Mojibake / encoding repair (safe)
// =======================
// Fixes strings like "Requisi\u00C3\u00A7\u00C3\u00A3o" (UTF-8 bytes interpreted as latin1),
// and even double-encoded variants like "Requisi\u00C3\u0192\u00C2\u00A7\u00C3\u0192\u00C2\u00A3o".
const looksLikeMojibake = (v) => {
  if (v == null) return false;
  const s = String(v);
  // Ã + continuation, Â + continuation, or the Unicode replacement char
  return /[\u00C3\u00C2][\u0080-\u00BF]|\uFFFD/.test(s) || s.includes('\u00C3\u0192\u00C2');
};

const latin1ToUtf8 = (v) => {
  try {
    const s = String(v ?? '');
    const bytes = Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return v;
  }
};

const fixMojibake = (v) => {
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
  s = s.replace(/\u00A0/g, ' ');

  return s;
};

const unwrapDbValue = (value) => {
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


const pickFirst = (obj, keys, fallback = '') => {
  for (const k of keys) {
    const v = unwrapDbValue(obj?.[k]);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return fallback;
};

const normalizeKanbanName = (value) => {
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

const normalizeReqStatusValue = (value) => {
  const n = norm(unwrapDbValue(value));
  if (n.includes('nova requisicao') || n.includes('pendente')) return 'Nova Requisição';
  if (n.includes('analise')) return 'Em Análise';
  if (n.includes('aprov')) return 'Aprovado';
  if (n.includes('rejeit')) return 'Rejeitado';
  return value || '';
};

const toISODateFromPt = (pt) => {
  if (!pt) return '';
  const s = String(pt).trim();
  const m = s.match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/);
  if (!m) return s;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
};

const toISODateTimeFromPt = (pt) => {
  if (!pt) return '';
  const s = String(pt).trim();
  const m = s.match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*$/);
  if (!m) return s;
  const [, d, mo, y, h, mi] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi.padStart(2, '0')}`;
};

const useTimer = (refreshInterval = 60000) => {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), refreshInterval);
    return () => clearInterval(id);
  }, [refreshInterval]);
  return time;
};

const determineProcessoCategory = (header, kanbanColuna) => {
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

const toNumberValue = (value) => {
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

const formatDecimalInput = (value) => {
  if (value === '' || value == null) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const num = toNumberValue(value);
  if (num === '' || !Number.isFinite(num)) return String(value ?? '');
  return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const formatCurrencyBR = (value) => {
  const n = toNumberValue(value);
  if (n === '' || !Number.isFinite(Number(n))) return '-';
  return Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

const formatListMoney = (value) => {
  if (value === '' || value == null) return '';
  if (typeof value === 'number') return formatDecimalInput(value);
  return String(value);
};

const toDateInput = (value) => {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^0{4}-0{2}-0{2}/.test(s) || /^0001-01-01/.test(s)) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return '';
};

const detailValue = (details, pid, field, fallback) =>
  details?.[pid]?.[field] ?? fallback ?? '';

const detailValueMoney = (details, pid, field, fallback) => {
  const hasLocal = Object.prototype.hasOwnProperty.call(details?.[pid] || {}, field);
  const raw = detailValue(details, pid, field, fallback);
  if (raw === '' || raw == null) return '';
  if (hasLocal) return raw;
  return formatDecimalInput(raw);
};

const getDeferimentoDefaults = (header, snapshotData, requisicaoData) => {
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

const normalizeFormaDevolucao = (v) => {
  const s = norm(v);
  if (!s) return '';
  if (s.includes('fatura')) return 'Fatura';
  if (s === 'gd') return 'GD';
  if (s.startsWith('dep')) return 'Deposito';
  return String(v || '').trim();
};

const getSubEtapaFromStatus = (item) => {
  const direct = pickFirst(item, ['sub_etapa_nova', 'sub_etapa', 'SubEtapa'], '');
  if (String(direct || '').trim()) return direct;
  const status = pickFirst(item, ['status_composto', 'status_novo', 'status'], '');
  if (!status || !String(status).includes(' - ')) return '';
  const parts = String(status).split(' - ');
  if (parts.length < 2) return '';
  const sub = parts.slice(1).join(' - ').trim();
  return sub.replace(/\s+via\s+.*$/i, '').trim();
};

const PROCESS_LIST_COLUMNS = [
  { key: 'id', label: 'Processo', sortable: true },
  { key: 'uc', label: 'UC', sortable: true },
  { key: 'cliente', label: 'Cliente', sortable: true },
  { key: 'valor', label: 'Ressarcimento estimado', sortable: true },
  { key: 'concessionaria', label: 'Concessionária', sortable: true },
  { key: 'status', label: 'Status atual', sortable: true },
  { key: 'ultima', label: 'Última movimentação', sortable: true },
  { key: 'dias_sem', label: 'Dias sem movimentar', sortable: true },
  { key: 'score_progressao', label: 'Score de Progressão', sortable: false },
  { key: 'editar', label: '', sortable: false },
];

const SUBETAPAS_DEFERIDOS = [
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

const toSentenceCase = (value) => {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
};

const getEtapaFromStatusComp = (item) => {
  const status = pickFirst(item, ['status_composto', 'status_novo', 'status'], '');
  if (!status || !String(status).includes(' - ')) return '';
  const parts = String(status).split(' - ');
  return parts.length ? parts[0].trim() : '';
};

const getHistoryEtapaSub = (item) => {
  const etapa =
    pickFirst(item, ['etapa_nova', 'etapa', 'Etapa', 'etapa_atual', 'etapa_anterior'], '') ||
    getEtapaFromStatusComp(item);
  const sub = getSubEtapaFromStatus(item);
  return { etapa: String(etapa || '').trim(), sub: String(sub || '').trim() };
};

const INFO_HISTORY_RE =
  /credito|repasse|ressarcimento estimado|data simples|data dobro|valor nf|numero nf|data emiss|data venc|data pag|forma de devolucao|fluxo|faturamento/i;

const isInfoHistoryItem = (item) => {
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

const splitHistoryItems = (items) => {
  const info = [];
  const display = [];
  (items || []).forEach((item) => {
    if (isInfoHistoryItem(item)) info.push(item);
    else display.push(item);
  });
  return { info, display };
};

const groupHistoryByStage = (items) => {
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

const isProcessoCriadoHistory = (item) => {
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

const formatHistoryComentarioLines = (comentario) => {
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

const isRelevante = (header, pid, relMap) => {
  if (pid != null && relMap && Object.prototype.hasOwnProperty.call(relMap, String(pid))) {
    return !!relMap[String(pid)];
  }
  const raw = header?.relevancia ?? header?.relevante ?? header?.relevancia_nova;
  if (raw === true) return true;
  if (raw === false) return false;
  const s = String(raw || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'sim';
};

const toTs = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const ts = new Date(raw.replace(' ', 'T')).getTime();
  return Number.isNaN(ts) ? 0 : ts;
};

const rowLastTs = (row) => {
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

const formatSnapshotValue = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.filter((v) => v != null && String(v).trim()).join(', ');
  return String(value).trim();
};

const formatPeriodosIrregularidade = (value) => {
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

// Formata "2025-05" → "maio/2025" ou "05/2025" → "maio/2025"
const MESES_PT = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const formatMesRef = (mesRef) => {
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

const toDateTimeLocal = (dbValue) => {
  const s = String(dbValue || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (m) return `${m[1]}T${m[2]}`;
  if (s.includes('T')) return s.slice(0, 16);
  return '';
};

const formatDateTimeBR = (value) => {
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

const fromDateTimeLocal = (inputValue) => {
  const s = String(inputValue || '').trim();
  if (!s) return '';
  if (s.includes('T')) return s.replace('T', ' ') + ':00';
  return s;
};

const nowDb = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const buildComentarioFinal = ({ texto }) => String(texto || '').trim();
const METRICAS_PIE_COLOR = '#4f83ff';
const formatDateBR = (date) => {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
};
const getMonthRange = (year, monthIndex) => {
  const start = new Date(year, monthIndex, 1);
  const end = new Date(year, monthIndex + 1, 0);
  return { start, end };
};
const getLast12MonthsRange = () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { start, end };
};

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',');
  return `{${body}}`;
};

const cleanToken = (t) => String(t || '').trim().replace(/^['"]+|['"]+$/g, '');

const getAuthToken = () => {
  try {
    return cleanToken(localStorage.getItem('userToken') || '');
  } catch {
    return '';
  }
};

const sha256Hex = async (text) => {
  if (!globalThis.crypto?.subtle) return '';
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = Array.from(new Uint8Array(hash));
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
};

const buildResumoInputPayload = (row) => {
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

const findValorPorColuna = (metricas, label) => {
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

const buildRowsFromKanbanFast = (data) => {
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

const mergeRowsByColumn = (prev, incoming, columnLabel) => {
  if (!columnLabel) return [...incoming];
  const keep = [];
  for (const row of prev || []) {
    const header = row || {};
    const col = header?.nome_coluna || '';
    if (col !== columnLabel) keep.push(row);
  }
  return [...keep, ...incoming];
};

const useDebouncedValue = (value, delay = 350) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return debounced;
};

const useChunkedRender = (items, { initial = 120, step = 160, enabled = true } = {}) => {
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

// =======================
// SUB-COMPONENTES UI (memo)
// =======================

// Score de Progressão Badge Component
const ScoreBadge = memo(function ScoreBadge({ score }) {
  if (score === undefined || score === null) return <span className="text-xs opacity-40">-</span>;

  if (score?.erro) {
    return <span className="text-[9px] text-red-500 opacity-40">erro</span>;
  }

  const percentage = typeof score === 'number' ? score : score?.percentual || score?.percentage || 0;
  const displayPercent = Math.round(percentage);

  let bgColor = 'bg-gray-300 text-gray-600'; // default/low
  if (displayPercent >= 70) bgColor = 'bg-green-500 text-white'; // high
  else if (displayPercent >= 40) bgColor = 'bg-yellow-500 text-white'; // medium

  return (
    <div
      className={`w-9 h-9 rounded-full flex items-center justify-center text-[10px] font-semibold ${bgColor} opacity-70`}
      title={`Score de Progressão: ${displayPercent}%`}
    >
      {displayPercent}%
    </div>
  );
});

const ProcessoCard = memo(function ProcessoCard({ row, onOpen, onIndeferir }) {
  const { pid, header, category } = row;
  const uc = pickFirst(header, ['uc', 'Uc', 'UC']);
  const cliente = pickFirst(header, ['cliente', 'Cliente']);
  const concess = pickFirst(header, ['concessionaria', 'Concessionaria']);
  const lastMoveTs = useMemo(() => {
    const hist = Array.isArray(row?.history) ? row.history : [];
    let max = 0;
    hist.forEach((h) => {
      const etapaVal = pickFirst(h, ['etapa', 'etapa_nova', 'Etapa'], '');
      const subVal = getSubEtapaFromStatus(h);
      if (!String(etapaVal || '').trim() && !String(subVal || '').trim()) return;
      const dtRaw = pickFirst(h, ['hist_data', 'data_movimentacao', 'data', 'created_at'], '');
      const ts = toTs(dtRaw);
      if (ts > max) max = ts;
    });
    return max || 0;
  }, [row?.history]);
  const lastDays = lastMoveTs ? Math.max(0, Math.floor((Date.now() - lastMoveTs) / (1000 * 60 * 60 * 24))) : null;

  const repasseSimples = header?.repasse_simples ?? '';
  const repasseDobro = header?.repasse_dobro ?? '';
  const showRepasse = String(repasseSimples || '').trim() || String(repasseDobro || '').trim();

  const estimadoRaw = pickFirst(header, ['ressarcimento_estimado', 'valor_estimado', 'valor'], '');
  const showEstimado = String(estimadoRaw || '').trim();

  const hasSeqError = (() => {
    const h = header || {};
    const hasDefer = String(h.data_simples || h.data_procedencia || h.data_dobro || h.data_credito_dobro || '').trim();
    const hasFluxo = String(h.valor_fluxo || h.data_envio_financeiro || '').trim();
    const hasFat = String(h.numero_nf || h.data_emissao || h.data_vencimento || h.data_pagamento || h.valor_nf || '').trim();
    return (hasFluxo || hasFat) && !hasDefer;
  })();

  return (
    <button
      onClick={() => onOpen(row)}
      className="text-left p-2 rounded-xl border panel-border processo-card hover:opacity-95 transition min-h-[84px] text-[var(--fg)]"
      title={hasSeqError ? 'Sequência incompleta: Fluxo/Faturamento sem Deferidos' : 'Abrir detalhes'}
      type="button"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wide opacity-80">Processo</div>
        <div className="flex items-center gap-2">
          {hasSeqError && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded border border-red-500 text-red-500"
              title="Sequência incompleta: Fluxo/Faturamento sem Deferidos"
            >
              Sequência
            </span>
          )}
          <span
            role="button"
            tabIndex={0}
            className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-red-500/10"
            title="Indeferir processo"
            onClick={(e) => {
              e.stopPropagation();
              onIndeferir?.(row);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onIndeferir?.(row);
              }
            }}
          >
            <Trash2 size={12} className="text-red-500 opacity-90" />
          </span>
          <div className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--muted)]/70 opacity-90">
            {category}
          </div>
        </div>
      </div>

      <div className="mt-1 flex items-baseline justify-between gap-2">
        <div className="text-lg font-extrabold leading-tight">#{pid}</div>
        <div className="text-xs opacity-80 truncate max-w-[140px]">UC {uc}</div>
      </div>

      <div className="text-xs mt-1 truncate opacity-95">{cliente}</div>
      <div className="text-[11px] mt-0.5 truncate opacity-80">{concess}</div>
      {lastDays != null && (
        <div className="text-[11px] mt-1 opacity-75">Última mov.: {lastDays} dias</div>
      )}

      {showEstimado ? (
        <div className="text-[11px] mt-1 truncate opacity-85">
          Estimado: {formatCurrencyBR(estimadoRaw)}
        </div>
      ) : null}

      {showRepasse ? (
        <div className="text-[11px] mt-0.5 truncate opacity-85">
          Repasse: {formatDecimalInput(repasseSimples) || '-'}
          {repasseDobro ? ` / ${formatDecimalInput(repasseDobro)}` : ''}
        </div>
      ) : null}
    </button>
  );
});

const CanaisSelector = memo(function CanaisSelector({ canais, onToggle }) {
  return (
    <div className="flex items-center gap-3">
      <img src="/Icones/contato.png" alt="" className="h-16 w-16 object-contain opacity-90" />
      <div className="grid grid-cols-3 gap-2">
        {CANAIS_UI.map(({ key, label }) => {
          const ativo = !!canais?.[key];
          return (
            <button
              key={key}
              type="button"
              className={`sap-chip transition ${ativo ? 'sap-chip--active' : ''}`}
              onClick={() => onToggle(key)}
              title={`Registrar no histórico como ${label}`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
});

const Field = memo(function Field({ label, hint, children }) {
  return (
    <div className="sap-field">
      <label className="sap-label">{label}</label>
      {children}
      {hint ? <div className="sap-hint">{hint}</div> : null}
    </div>
  );
});

const ProcessoDadosView = memo(function ProcessoDadosView({
  header,
  snapshotData,
  requisicaoData,
  anexosData,
  infoHistoryItems,
  estimadoValue,
  onChangeEstimado,
  onSaveEstimado,
  onDeleteAnexo,
  onEditInfo,
}) {
  const anexos = Array.isArray(anexosData) ? anexosData : [];

  const merged = useMemo(
    () => ({ ...(header || {}), ...(snapshotData || {}), ...(requisicaoData || {}) }),
    [header, snapshotData, requisicaoData],
  );
  const infoPeriodo = formatPeriodosIrregularidade(
    pickFirst(merged, ['periodos_irregularidade', 'periodosIrregularidade']),
  );
  const infoIrregularidade = pickFirst(merged, ['tipo_irregularidade', 'irregularidade', 'tipoIrregularidade'], '');
  const infoSubIrregularidade = pickFirst(
    merged,
    ['subtipo_irregularidade', 'sub_irregularidade', 'subtipoIrregularidade'],
    '',
  );
  const infoValor = pickFirst(merged, ['ressarcimento_estimado', 'valor_estimado'], '');
  const infoCriado = pickFirst(merged, ['data_criacao', 'dataCriacao', 'created_at'], '');
  const infoLink = pickFirst(merged, ['link_fatura', 'linkFatura', 'link'], '');
  const infoDescricao = pickFirst(merged, ['descricao_irregularidade', 'descricaoIrregularidade'], '');
  const infoLinksDetalhes = pickFirst(merged, ['links_faturas_detalhes', 'LinksFaturasDetalhes'], null);
  const infoLinksSimples = pickFirst(merged, ['links_faturas', 'LinksFaturas'], null);
  const infoFaturas =
    Array.isArray(infoLinksDetalhes) ? infoLinksDetalhes : Array.isArray(infoLinksSimples) ? infoLinksSimples : [];

  return (
    <div className="mt-3 pt-3 border-t panel-border space-y-4">
      <div>
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="text-base font-semibold uppercase tracking-wide">Informações</div>
          {onEditInfo && (
            <button
              type="button"
              onClick={onEditInfo}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-[var(--panel-border)] bg-[var(--panel)] hover:bg-[var(--hover)] transition-colors"
            >
              <Pencil size={10} />
              Editar
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 gap-1 text-xs mb-4">
          <div><b>UC:</b> {formatSnapshotValue(pickFirst(merged, ['uc', 'Uc', 'UC'])) || '-'}</div>
          <div><b>Cliente:</b> {formatSnapshotValue(pickFirst(merged, ['cliente', 'Cliente'])) || '-'}</div>
          <div><b>Concessionária:</b> {formatSnapshotValue(pickFirst(merged, ['concessionaria', 'Concessionaria'])) || '-'}</div>
          <div><b>Irregularidade / Subirregularidade:</b> {toSentenceCase(infoIrregularidade) || '-'} {infoSubIrregularidade ? `/ ${infoSubIrregularidade}` : ''}</div>
          <div><b>Valor estimado:</b> {formatCurrencyBR(infoValor)}</div>
          <div><b>Criado em:</b> {formatDateTimeBR(infoCriado)}</div>
          <div><b>Período:</b> {infoPeriodo || '-'}</div>
          <div><b>Fatura:</b> {infoLink || '-'}</div>
          <div><b>Faturas:</b> {infoFaturas.length} {infoPeriodo ? `(${infoPeriodo})` : ''}</div>
          <div>
            <b>Descrição:</b>
            <div style={{ whiteSpace: 'pre-wrap', maxHeight: '8.4em', lineHeight: '1.4em', overflowY: 'auto' }}
              className="mt-0.5 text-[11px] opacity-75 border border-[var(--border)] rounded px-1.5 py-0.5 bg-[var(--bg)]">
              {infoDescricao || '-'}
            </div>
          </div>
        </div>

        {null}
      </div>

      {null}
    </div>
  );
});

// =======================
// Drawer
// =======================
function ProcessoDrawer({
  open,
  row,
  onClose,
  pane,
  setPane,
  onPrepareMove,
  onEditHistory,
  rightPane,
  snapshotData,
  requisicaoData,
  anexosData,
  historyItems,
  historyDetailLoading,
  historyAnexoUploading,
  onAttachHistoryAnexo,
  onDeleteAnexo,
  relevanciaChecked,
  suspensoChecked,
  onToggleRelevancia,
  onToggleSuspenso,
  handleSaveProcesso,
  onConcluirProcesso,
  detailsByPid,
  setDetailsByPid,
  detailValue: detailValueLocal,
  scoreData,
  activeTab,
  onEditInfo,
  instanciasDeferimento,
}) {
  const [emailExtract, setEmailExtract] = useState({});
  const [docConfirmOpen, setDocConfirmOpen] = useState(false);
  const currentRow = row || {};
  const { pid, header, category } = currentRow;
  const safeHeader = header || {};
  const anexos = Array.isArray(anexosData) ? anexosData : [];

  // Condição para exibir o banner de ofício CEMIG
  const docUC = pickFirst(safeHeader, ['uc', 'UC', 'Uc'], '');
  const docConc = pickFirst(safeHeader, ['concessionaria', 'Concessionaria'], '');
  const docEtapa = pickFirst(safeHeader, ['etapa_atual', 'etapa', 'sub_etapa'], '');
  const showDocBanner =
    activeTab === 'ATIVOS' &&
    docConc.toLowerCase().includes('cemig') &&
    (docEtapa.toLowerCase().includes('distribuidora') || docEtapa.toLowerCase().includes('ouvidoria'));
  const docFilename = `Ouvidoria ${docUC} - ${docConc}.docx`;

  const historySource =
    Array.isArray(historyItems) && historyItems.length > 0
      ? historyItems
      : Array.isArray(currentRow.history)
      ? currentRow.history
      : [];

  const estimadoBase = pickFirst(
    { ...safeHeader, ...(snapshotData || {}), ...(requisicaoData || {}) },
    ['ressarcimento_estimado', 'valor_estimado', 'valor'],
    '',
  );

  const deferimentoDefaults = useMemo(
    () => getDeferimentoDefaults(safeHeader, snapshotData, requisicaoData),
    [safeHeader, snapshotData, requisicaoData],
  );

  const hasRight = !!pane;

  const historySorted = useMemo(() => {
    const list = Array.isArray(historySource) ? [...historySource] : [];
    const parseDate = (h) => {
      const raw = pickFirst(h, ['hist_data', 'data_movimentacao', 'data', 'created_at'], '');
      if (!raw || String(raw).startsWith('0001-01-01')) return 0;
      const ts = new Date(String(raw).replace(' ', 'T')).getTime();
      return Number.isNaN(ts) ? 0 : ts;
    };

    const filtered = list.filter((h) => {
      const raw = pickFirst(h, ['hist_data', 'data_movimentacao', 'data', 'created_at'], '');
      const hasDate = !!raw && !String(raw).startsWith('0001-01-01');

      const etapaVal = pickFirst(h, ['etapa_nova', 'etapa', 'Etapa'], '');
      const subVal = getSubEtapaFromStatus(h);
      const comentarioVal = pickFirst(h, ['hist_comentario', 'comentario'], '');

      const hasComentario = !!String(comentarioVal || '').trim();
      const hasSub = !!String(subVal || '').trim();
      const hasEtapa = !!String(etapaVal || '').trim();

      if (hasDate) return true;
      return hasComentario || hasSub || hasEtapa;
    });

    return filtered.sort((a, b) => parseDate(b) - parseDate(a));
  }, [historySource]);

  const historyWithAnexos = useMemo(() => {
    const list = historySorted.map((item) => ({
      ...item,
      anexos: Array.isArray(item.anexos) ? [...item.anexos] : [],
    }));

    if (!anexos.length || list.length === 0) return list;

    const used = new Set();
    list.forEach((item) => {
      (item.anexos || []).forEach((a) => {
        const name = a?.nome || a?.nome_arquivo || '';
        const path = a?.url || a?.caminho_arquivo || '';
        used.add(`${name}|${path}`);
      });
    });

    const toTsSafe = (value) => {
      const raw = String(value || '').trim();
      if (!raw || raw.startsWith('0001-01-01')) return 0;
      const ts = new Date(raw.replace(' ', 'T')).getTime();
      return Number.isNaN(ts) ? 0 : ts;
    };

    const histTs = list.map((h) =>
      toTsSafe(pickFirst(h, ['hist_data', 'data_movimentacao', 'data', 'created_at'], '')),
    );

    const candidates = anexos.filter((a) => {
      const name = a?.nome_arquivo || a?.nome || '';
      const path = a?.url || a?.caminho_arquivo || '';
      return !used.has(`${name}|${path}`);
    });

    candidates.forEach((a) => {
      const uploadTs = toTsSafe(a?.data_upload || a?.DataUpload || '');
      let targetIdx = 0;

      if (uploadTs) {
        let minDiff = Number.POSITIVE_INFINITY;
        histTs.forEach((ts, idx) => {
          if (!ts) return;
          const diff = Math.abs(ts - uploadTs);
          if (diff < minDiff) {
            minDiff = diff;
            targetIdx = idx;
          }
        });
      }

      const link = {
        nome: a?.nome_arquivo || a?.nome,
        url: a?.url || a?.caminho_arquivo,
        data_upload: a?.data_upload || a?.DataUpload,
      };

      list[targetIdx].anexos = [...(list[targetIdx].anexos || []), link];
    });

    return list;
  }, [historySorted, anexos]);

  const { info: historyInfoItems, display: historyDisplayItems } = useMemo(
    () => splitHistoryItems(historyWithAnexos),
    [historyWithAnexos],
  );

  const historyGroups = useMemo(
    () => groupHistoryByStage(historyDisplayItems),
    [historyDisplayItems],
  );

  const fieldStampMap = useMemo(() => {
    const map = new Map();
    const setStamp = (key, dtRaw) => {
      const ts = toTs(dtRaw);
      if (!ts) return;
      const prev = map.get(key);
      if (!prev || ts > prev.ts) {
        map.set(key, { ts, label: formatDateTimeBR(dtRaw) });
      }
    };
    (historyInfoItems || []).forEach((item) => {
      const comentario = norm(pickFirst(item, ['hist_comentario', 'comentario'], ''));
      if (!comentario) return;
      const dtRaw = pickFirst(item, ['hist_data', 'data_movimentacao', 'data'], '');
      if (comentario.includes('data simples')) setStamp('data_simples', dtRaw);
      if (comentario.includes('data dobro')) setStamp('data_dobro', dtRaw);
      if (comentario.includes('repasse simples')) setStamp('repasse_simples', dtRaw);
      if (comentario.includes('repasse dobro')) setStamp('repasse_dobro', dtRaw);
      if (comentario.includes('credito simples')) setStamp('credito_simples', dtRaw);
      if (comentario.includes('credito dobro')) setStamp('credito_dobro', dtRaw);
      if (comentario.includes('ressarcimento estimado')) setStamp('ressarcimento_estimado', dtRaw);
      if (comentario.includes('numero nf') || comentario.includes('número nf')) setStamp('numero_nf', dtRaw);
      if (comentario.includes('data emiss')) setStamp('data_emissao', dtRaw);
      if (comentario.includes('data venc')) setStamp('data_vencimento', dtRaw);
      if (comentario.includes('data pag')) setStamp('data_pagamento', dtRaw);
      if (comentario.includes('valor nf')) setStamp('valor_nf', dtRaw);
      if (comentario.includes('forma de devolucao')) setStamp('forma_devolucao', dtRaw);
      if (comentario.includes('valor de devolucao')) setStamp('valor_fluxo', dtRaw);
      if (comentario.includes('data de devolucao')) setStamp('data_fluxo', dtRaw);
      if (comentario.includes('envio ao financeiro')) setStamp('data_envio_financeiro', dtRaw);
    });
    return map;
  }, [historyInfoItems]);

  const labelWithStamp = useCallback(
    (label, key) => {
      const stamp = fieldStampMap.get(key)?.label;
      if (!stamp) return label;
      return (
        <span className="inline-flex items-center gap-1">
          <span>{label}</span>
          <span className="text-[10px] opacity-70">({stamp})</span>
        </span>
      );
    },
    [fieldStampMap],
  );

  const detail = detailsByPid?.[pid] || {};

  const isMoneyFilled = useCallback((val) => {
    const n = toNumberValue(val);
    return n !== '' && Number(n) > 0;
  }, []);

  const isDateFilled = useCallback((val) => {
    return !!toDateInput(val);
  }, []);

  const isTextFilled = useCallback((val) => String(val || '').trim() !== '', []);

  const fluxoItens =
    Array.isArray(detail.fluxo_itens) && detail.fluxo_itens.length
      ? detail.fluxo_itens
      : [
          {
            forma_devolucao: normalizeFormaDevolucao(detail.forma ?? safeHeader.forma_devolucao ?? ''),
            valor: detail.valor_fluxo ?? safeHeader.valor_fluxo ?? '',
            simples: detail.simples ?? safeHeader.fluxo_simples ?? 0,
            dobro: detail.dobro ?? safeHeader.fluxo_dobro ?? 0,
            simples_dobro: detail.simples_dobro ?? safeHeader.fluxo_simples_dobro ?? 0,
            data_devolucao: detail.data_fluxo ?? safeHeader.data_fluxo ?? '',
            data_envio_financeiro: detail.data_envio_financeiro ?? safeHeader.data_envio_financeiro ?? '',
          },
        ];

  const faturamentoItens =
    Array.isArray(detail.faturamento_itens) && detail.faturamento_itens.length
      ? detail.faturamento_itens
      : [
          {
            numero_nf: detail.numero_nf ?? safeHeader.numero_nf ?? '',
            data_emissao: detail.data_emissao ?? safeHeader.data_emissao ?? '',
            data_vencimento: detail.data_vencimento ?? safeHeader.data_vencimento ?? '',
            data_pagamento: detail.data_pagamento ?? safeHeader.data_pagamento ?? '',
            valor: detail.valor_nf ?? safeHeader.valor_nf ?? '',
          },
        ];

  const isInFaturamento = normalizeKanbanName(category) === 'Faturamento';

  const deferimentoCompleto = useMemo(() => {
    const cs = detailValueMoney(detailsByPid, pid, 'cs', deferimentoDefaults.cs);
    const ds = detailValueLocal(detailsByPid, pid, 'ds', deferimentoDefaults.ds);
    const cd = detailValueMoney(detailsByPid, pid, 'cd', deferimentoDefaults.cd);
    const dd = detailValueLocal(detailsByPid, pid, 'dd', deferimentoDefaults.dd);
    const rs = detailValueMoney(detailsByPid, pid, 'rs', deferimentoDefaults.rs);
    const rd = detailValueMoney(detailsByPid, pid, 'rd', deferimentoDefaults.rd);
    return (
      isMoneyFilled(cs) &&
      isDateFilled(ds) &&
      isMoneyFilled(cd) &&
      isDateFilled(dd) &&
      isMoneyFilled(rs) &&
      isMoneyFilled(rd)
    );
  }, [
    detailsByPid,
    pid,
    deferimentoDefaults,
    detailValueLocal,
    isMoneyFilled,
    isDateFilled,
  ]);

  const fluxoCompleto = useMemo(
    () =>
      fluxoItens.length > 0 &&
      fluxoItens.every((item) => {
        const hasTipo = !!(item.simples || item.dobro || item.simples_dobro);
        return (
          hasTipo &&
          isMoneyFilled(item.valor) &&
          isTextFilled(item.forma_devolucao) &&
          isDateFilled(item.data_devolucao) &&
          isDateFilled(item.data_envio_financeiro)
        );
      }),
    [fluxoItens, isMoneyFilled, isTextFilled, isDateFilled],
  );

  const faturamentoCompleto = useMemo(
    () =>
      faturamentoItens.length > 0 &&
      faturamentoItens.some((item) => isMoneyFilled(item.valor)),
    [faturamentoItens, isMoneyFilled],
  );

  const podeConcluir = isInFaturamento && faturamentoCompleto;

  const updateList = useCallback(
    (field, idx, key, val) => {
      setDetailsByPid((prev) => {
        const cur = prev?.[pid] || {};
        const defaultList = field === 'fluxo_itens' ? [...fluxoItens] : [...faturamentoItens];
        const itens =
          Array.isArray(cur[field]) && cur[field].length ? [...cur[field]] : defaultList;

        itens[idx] = { ...(itens[idx] || {}), [key]: val };
        return { ...(prev || {}), [pid]: { ...cur, [field]: itens } };
      });
    },
    [pid, setDetailsByPid, fluxoItens, faturamentoItens],
  );

  const manageList = useCallback(
    (field, action, idx) => {
      setDetailsByPid((prev) => {
        const cur = prev?.[pid] || {};
        const defaultList = field === 'fluxo_itens' ? [...fluxoItens] : [...faturamentoItens];
        const itens =
          Array.isArray(cur[field]) && cur[field].length ? [...cur[field]] : defaultList;

        if (action === 'add') {
          if (field === 'fluxo_itens') {
            itens.push({
              forma_devolucao: '',
              valor: '',
              simples: 0,
              dobro: 0,
              simples_dobro: 0,
              data_devolucao: '',
              data_envio_financeiro: '',
            });
          } else {
            itens.push({ numero_nf: '', data_emissao: '', data_vencimento: '', data_pagamento: '', valor: '' });
          }
        } else if (action === 'remove') {
          if (itens.length > 1) itens.splice(idx, 1);
          else return prev;
        }

        return { ...(prev || {}), [pid]: { ...cur, [field]: itens } };
      });
    },
    [pid, setDetailsByPid, fluxoItens, faturamentoItens],
  );

  const togglePane = useCallback(
    (key, beforeOpen) => {
      setPane((prev) => {
        const next = prev === key ? '' : key;
        if (next === key) beforeOpen?.();
        return next;
      });
    },
    [setPane],
  );

  const paneBtn = (key) => `sap-tab ${pane === key ? 'sap-tab-active' : ''}`;

  if (!open || !row) return null;

  const renderLeft = () => (
    <div className="space-y-4 pr-1">
      <div className="sap-section">
        <div className="sap-section-header flex items-center justify-between">
          <div className="font-semibold">Deferimento</div>
        </div>

        <div className="p-3 grid grid-cols-2 gap-4">
          <Field label={labelWithStamp('Deferimento simples', 'credito_simples')}>
            <input
              className="input-themed text-sm"
              value={detailValueMoney(detailsByPid, pid, 'cs', deferimentoDefaults.cs)}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...(prev || {}),
                  [pid]: { ...((prev || {})[pid] || {}), cs: e.target.value },
                }))
              }
            />
          </Field>

          <Field label={labelWithStamp('Data simples', 'data_simples')}>
            <input
              type="date"
              className="input-themed text-sm"
              value={detailValueLocal(
                detailsByPid,
                pid,
                'ds',
                toDateInput(deferimentoDefaults.ds) || deferimentoDefaults.ds,
              )}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...(prev || {}),
                  [pid]: { ...((prev || {})[pid] || {}), ds: e.target.value },
                }))
              }
            />
          </Field>

          <Field label={labelWithStamp('Deferimento dobro', 'credito_dobro')}>
            <input
              className="input-themed text-sm"
              value={detailValueMoney(detailsByPid, pid, 'cd', deferimentoDefaults.cd)}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...(prev || {}),
                  [pid]: { ...((prev || {})[pid] || {}), cd: e.target.value },
                }))
              }
            />
          </Field>

          <Field label={labelWithStamp('Data dobro', 'data_dobro')}>
            <input
              type="date"
              className="input-themed text-sm"
              value={detailValueLocal(
                detailsByPid,
                pid,
                'dd',
                toDateInput(deferimentoDefaults.dd) || deferimentoDefaults.dd,
              )}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...(prev || {}),
                  [pid]: { ...((prev || {})[pid] || {}), dd: e.target.value },
                }))
              }
            />
          </Field>

          <Field label={labelWithStamp('Repasse simples', 'repasse_simples')}>
            <input
              className="input-themed text-sm"
              value={detailValueMoney(detailsByPid, pid, 'rs', deferimentoDefaults.rs)}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...(prev || {}),
                  [pid]: { ...((prev || {})[pid] || {}), rs: e.target.value },
                }))
              }
            />
          </Field>

          <Field label={labelWithStamp('Repasse dobro', 'repasse_dobro')}>
            <input
              className="input-themed text-sm"
              value={detailValueMoney(detailsByPid, pid, 'rd', deferimentoDefaults.rd)}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...(prev || {}),
                  [pid]: { ...((prev || {})[pid] || {}), rd: e.target.value },
                }))
              }
            />
          </Field>

        </div>

        <div className="flex items-center justify-end gap-3 p-3 pt-0">
          <div className="flex items-center gap-2">
            <label className="text-[11px] uppercase opacity-70 whitespace-nowrap">
              Instância de deferimento
            </label>
            <select
              className="input-themed text-sm min-w-[160px]"
              value={
                detailsByPid?.[pid]?.idef ??
                (safeHeader.instancia_deferimento || requisicaoData?.instancia_deferimento || '')
              }
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...(prev || {}),
                  [pid]: { ...((prev || {})[pid] || {}), idef: e.target.value },
                }))
              }
            >
              <option value="">— selecione —</option>
              {(instanciasDeferimento || []).map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.nome}
                </option>
              ))}
            </select>
          </div>
          <button className="btn-themed" onClick={() => handleSaveProcesso(pid, header, 'deferimento')} type="button">
            Salvar campos
          </button>
        </div>
      </div>

      <div className="sap-section">
        <div className="sap-section-header flex items-center justify-between">
          <div className="font-semibold">Fluxo de Ressarcimento</div>
          <button className="btn-outline text-xs" onClick={() => manageList('fluxo_itens', 'add')} type="button">
            + Adicionar
          </button>
        </div>

        <div className="p-3 space-y-3">
          {fluxoItens.map((item, idx) => (
            <div key={`fluxo-${pid}-${idx}`} className="sap-card p-3">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 flex items-center gap-4 py-1">
                  <span className="text-[11px] uppercase font-semibold">Tipo:</span>
                  <div className="flex items-center gap-4">
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={!!(item.simples || item.simples_dobro)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setDetailsByPid((prev) => {
                            const cur = prev?.[pid] || {};
                            const itens =
                              Array.isArray(cur.fluxo_itens) && cur.fluxo_itens.length
                                ? [...cur.fluxo_itens]
                                : [...fluxoItens];
                            const atual = { ...(itens[idx] || {}) };
                            const dobroMarcado = !!(atual.dobro || atual.simples_dobro);
                            atual.simples = checked ? 1 : 0;
                            atual.simples_dobro = checked && dobroMarcado ? 1 : 0;
                            itens[idx] = atual;
                            return { ...(prev || {}), [pid]: { ...cur, fluxo_itens: itens } };
                          });
                        }}
                      />
                      Simples
                    </label>
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={!!(item.dobro || item.simples_dobro)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setDetailsByPid((prev) => {
                            const cur = prev?.[pid] || {};
                            const itens =
                              Array.isArray(cur.fluxo_itens) && cur.fluxo_itens.length
                                ? [...cur.fluxo_itens]
                                : [...fluxoItens];
                            const atual = { ...(itens[idx] || {}) };
                            const simplesMarcado = !!(atual.simples || atual.simples_dobro);
                            atual.dobro = checked ? 1 : 0;
                            atual.simples_dobro = checked && simplesMarcado ? 1 : 0;
                            itens[idx] = atual;
                            return { ...(prev || {}), [pid]: { ...cur, fluxo_itens: itens } };
                          });
                        }}
                      />
                      Dobro
                    </label>
                  </div>
                </div>

                <Field label={labelWithStamp('Valor', 'valor_fluxo')}>
                  <input
                    className="input-themed text-sm"
                    value={formatListMoney(item.valor ?? '')}
                    onChange={(e) => updateList('fluxo_itens', idx, 'valor', e.target.value)}
                    placeholder="0,00"
                  />
                </Field>

                <Field label={labelWithStamp('Forma de devolução', 'forma_devolucao')}>
                  <select
                    className="input-themed text-sm"
                    value={normalizeFormaDevolucao(item.forma_devolucao ?? '')}
                    onChange={(e) =>
                      updateList('fluxo_itens', idx, 'forma_devolucao', normalizeFormaDevolucao(e.target.value))
                    }
                  >
                    <option value="">Selecione...</option>
                    <option value="Fatura">Fatura</option>
                    <option value="GD">GD</option>
                    <option value="Deposito">Depósito</option>
                  </select>
                </Field>

                <Field label={labelWithStamp('Data devolução', 'data_fluxo')}>
                  <input
                    type="date"
                    className="input-themed text-sm"
                    value={toDateInput(item.data_devolucao)}
                    onChange={(e) => updateList('fluxo_itens', idx, 'data_devolucao', e.target.value)}
                  />
                </Field>

                <Field label={labelWithStamp('Envio ao financeiro', 'data_envio_financeiro')}>
                  <input
                    type="date"
                    className="input-themed text-sm"
                    value={toDateInput(item.data_envio_financeiro)}
                    onChange={(e) => updateList('fluxo_itens', idx, 'data_envio_financeiro', e.target.value)}
                  />
                </Field>
              </div>

              {fluxoItens.length > 1 && (
                <div className="flex justify-end mt-2">
                  <button
                    className="btn-outline text-xs"
                    onClick={() => manageList('fluxo_itens', 'remove', idx)}
                    type="button"
                  >
                    Remover
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end p-3 pt-0">
          <button className="btn-themed" onClick={() => handleSaveProcesso(pid, header, 'fluxo')} type="button">
            Salvar fluxo
          </button>
        </div>
      </div>

      <div className="sap-section">
        <div className="sap-section-header flex items-center justify-between">
          <div className="font-semibold">Faturamento</div>
          <button className="btn-outline text-xs" onClick={() => manageList('faturamento_itens', 'add')} type="button">
            + Adicionar
          </button>
        </div>

        <div className="p-3 space-y-3">
          {faturamentoItens.map((item, idx) => (
            <div key={`fat-${pid}-${idx}`} className="sap-card p-3">
              <div className="grid grid-cols-2 gap-4">
                <Field label={labelWithStamp('Número NF', 'numero_nf')}>
                  <input
                    className="input-themed text-sm"
                    value={item.numero_nf ?? ''}
                    onChange={(e) => updateList('faturamento_itens', idx, 'numero_nf', e.target.value)}
                  />
                </Field>

                <Field label={labelWithStamp('Emissão', 'data_emissao')}>
                  <input
                    type="date"
                    className="input-themed text-sm"
                    value={toDateInput(item.data_emissao)}
                    onChange={(e) => updateList('faturamento_itens', idx, 'data_emissao', e.target.value)}
                  />
                </Field>

                <Field label={labelWithStamp('Vencimento', 'data_vencimento')}>
                  <input
                    type="date"
                    className="input-themed text-sm"
                    value={toDateInput(item.data_vencimento)}
                    onChange={(e) => updateList('faturamento_itens', idx, 'data_vencimento', e.target.value)}
                  />
                </Field>

                <Field label={labelWithStamp('Pagamento', 'data_pagamento')}>
                  <input
                    type="date"
                    className="input-themed text-sm"
                    value={toDateInput(item.data_pagamento)}
                    onChange={(e) => updateList('faturamento_itens', idx, 'data_pagamento', e.target.value)}
                  />
                </Field>

                <Field label={labelWithStamp('Valor NF', 'valor_nf')}>
                  <input
                    className="input-themed text-sm"
                    value={formatListMoney(item.valor ?? '')}
                    onChange={(e) => updateList('faturamento_itens', idx, 'valor', e.target.value)}
                    placeholder="0,00"
                  />
                </Field>
              </div>

              {faturamentoItens.length > 1 && (
                <div className="flex justify-end mt-2">
                  <button
                    className="btn-outline text-xs"
                    onClick={() => manageList('faturamento_itens', 'remove', idx)}
                    type="button"
                  >
                    Remover
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end p-3 pt-0">
          <button className="btn-themed" onClick={() => handleSaveProcesso(pid, header, 'faturamento')} type="button">
            Salvar faturamento
          </button>
        </div>

        {isInFaturamento && (
          <div className="flex justify-end p-3 pt-0">
            <button
              className="btn-press req-btn-aprovar px-3 py-1.5 rounded-md border"
              type="button"
              disabled={!podeConcluir}
              title={!podeConcluir ? 'Preencha todos os campos de Deferidos, Fluxo e Faturamento.' : ''}
              onClick={() => onConcluirProcesso?.(pid)}
            >
              Concluir
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-7xl bg-[var(--panel-processos)] border-l panel-border shadow-lg p-4 overflow-hidden flex flex-col">
        <div className="flex items-start justify-between gap-3 pb-3 border-b panel-border">
          <div className="w-full">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-2xl font-bold leading-tight">#{pid}</div>
              <div className="sap-chip">{category}</div>

              {formatSnapshotValue(pickFirst(header, ['updated_at', 'updatedAt'])) ? (
                <div className="text-xs opacity-70">
                  Atualizado em: {formatSnapshotValue(pickFirst(header, ['updated_at', 'updatedAt']))}
                </div>
              ) : null}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!relevanciaChecked}
                  onChange={(e) => onToggleRelevancia?.(e.target.checked)}
                />
                <span>Sinalizar como relevante</span>
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!suspensoChecked}
                  onChange={(e) => onToggleSuspenso?.(e.target.checked)}
                />
                <span>Suspender processo</span>
              </label>
            </div>

            <ProcessoDadosView
              header={header}
              snapshotData={snapshotData}
              requisicaoData={requisicaoData}
              anexosData={anexosData}
              infoHistoryItems={historyInfoItems}
              estimadoValue={detailValueMoney(detailsByPid, pid, 're', estimadoBase)}
              onDeleteAnexo={onDeleteAnexo ? (anexoId) => onDeleteAnexo(pid, anexoId) : undefined}
              onChangeEstimado={(value) =>
                setDetailsByPid((prev) => ({
                  ...(prev || {}),
                  [pid]: { ...((prev || {})[pid] || {}), re: value },
                }))
              }
              onSaveEstimado={() => handleSaveProcesso(pid, header, 'deferimento')}
              onEditInfo={onEditInfo}
            />

            {showDocBanner && (
              <div className="mt-3 flex items-center gap-2 rounded border border-[var(--accent)] bg-[var(--accent)]/10 px-3 py-2 text-xs">
                <FileText size={14} className="shrink-0 text-[var(--accent)]" />
                <span className="flex-1 font-medium text-[var(--accent)]">Ofício disponível — {docFilename}</span>
                <button
                  type="button"
                  className="btn-outline text-xs"
                  onClick={() => setDocConfirmOpen(true)}
                >
                  Baixar
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="sap-tabs mt-3 flex-wrap">
          <button className={paneBtn('resume')} type="button" onClick={() => togglePane('resume')}>
            Resumir
          </button>

          <button className={paneBtn('move')} type="button" onClick={() => togglePane('move', onPrepareMove)}>
            Movimentar
          </button>

          <button className={paneBtn('history')} type="button" onClick={() => togglePane('history')}>
            Histórico
          </button>

          {activeTab === 'ATIVOS' && (
            <button className={paneBtn('score')} type="button" onClick={() => togglePane('score')}>
              Score
            </button>
          )}

        </div>

        <div className="mt-4 flex-1 overflow-hidden">
          {!hasRight ? (
            <div className="h-full overflow-auto">{renderLeft()}</div>
          ) : (
            <div className="h-full grid grid-cols-1 lg:grid-cols-[1fr_12px_1.4fr] gap-0">
              <div className="h-full overflow-auto pr-4">{renderLeft()}</div>
              <div className="hidden lg:block h-full sap-divider" />
              <div className="h-full overflow-auto pl-4">
                <div className="sap-pane">
                  {pane === 'history' ? (
                    <div className="h-full flex flex-col">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <div className="font-semibold">Histórico</div>
                          {historyDetailLoading && <Activity className="h-4 w-4 animate-spin opacity-70" />}
                        </div>
                        <button className="btn-outline text-xs" onClick={onEditHistory} type="button">
                          Editar histórico
                        </button>
                      </div>

                      {historyGroups.length === 0 ? (
                        <div className="text-sm opacity-70">Nenhum histórico.</div>
                      ) : (
                        <div className="space-y-3">
                          {historyGroups.map((group, gidx) => (
                            <div
                              key={`hist-group-${pid}-${gidx}`}
                              className="rounded-xl border panel-border bg-[var(--panel)]/30 p-3"
                            >
                              <div className="text-[11px] uppercase font-semibold mb-2">
                                <b>Etapa:</b> {group.etapa}
                              </div>
                              <div className="space-y-3">
                                {group.items.map((item, idx) => {
                                  const histId =
                                    item.id_historico ?? item.historico_id ?? item.hist_id ?? item.id ?? null;
                                  const uploading = histId && historyAnexoUploading?.[histId];
                                  const usuarioNome = pickFirst(
                                    item,
                                    ['usuario_nome', 'nome_usuario', 'user_name', 'userName', 'usuario'],
                                    '',
                                  );
                                  const usuarioId = pickFirst(
                                    item,
                                    ['id_usuario_gestor', 'gestor_id', 'usuario_id', 'user_id'],
                                    '',
                                  );
                                  const usuarioLabel = usuarioNome || (usuarioId ? `ID ${usuarioId}` : 'Sistema');
                                  const dt = formatDateTimeBR(
                                    pickFirst(item, ['hist_data', 'data_movimentacao', 'data'], '-'),
                                  );
                                  const sub = getSubEtapaFromStatus(item) || '-';
                                  const comentario = pickFirst(item, ['hist_comentario', 'comentario'], '-');
                                  const tipoMov = String(item.tipo_movimentacao || '').toUpperCase();
                                  const isEmail = tipoMov === 'EMAIL';
                                  const extState = histId ? emailExtract[histId] : null;

                                  return (
                                    <div key={`hist-${pid}-${gidx}-${idx}`} className="text-xs space-y-1">
                                      <div>
                                        {dt} - <b>Sub-etapa</b> {sub}{!isEmail && ` - ${comentario}`}
                                      </div>
                                      {isEmail && comentario && comentario !== '-' && (
                                        <div
                                          className="p-2 rounded border border-[var(--border)] bg-[var(--panel)] overflow-auto text-[var(--fg)]"
                                          style={{ maxHeight: 200, fontSize: 12, lineHeight: 1.5 }}
                                          dangerouslySetInnerHTML={{ __html: sanitizeEmail(comentario) }}
                                        />
                                      )}
                                      {isEmail && histId && (
                                        <div className="space-y-1">
                                          <button
                                            type="button"
                                            disabled={extState?.loading}
                                            onClick={() => {
                                              if (!extState?.data) {
                                                setEmailExtract(prev => ({ ...prev, [histId]: { loading: true, data: null, error: null } }));
                                                import('../services/apiClient').then(m =>
                                                  m.default.post(`/processos/${pid}/historico/${histId}/extrair-email`)
                                                ).then(({ data }) => {
                                                  setEmailExtract(prev => ({ ...prev, [histId]: { loading: false, data, error: null } }));
                                                }).catch(() => {
                                                  setEmailExtract(prev => ({ ...prev, [histId]: { loading: false, data: null, error: 'Falha ao extrair dados.' } }));
                                                });
                                              }
                                            }}
                                            className="flex items-center gap-1 px-2 py-1 rounded border text-[10px]"
                                            style={{ borderColor: 'var(--accent)', color: extState?.data ? 'var(--success)' : 'var(--accent)', background: 'transparent', cursor: extState?.data ? 'default' : 'pointer', opacity: extState?.loading ? 0.6 : 1 }}
                                          >
                                            {extState?.loading ? (
                                              <><span style={{ width: 10, height: 10, border: '1.5px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} /> Analisando...</>
                                            ) : extState?.data ? (
                                              <><Sparkles size={10} /> Analisado</>
                                            ) : (
                                              <><Sparkles size={10} /> Extrair dados com IA</>
                                            )}
                                          </button>
                                          {extState?.data && (() => {
                                            const d = extState.data;
                                            const tipoColors = { deferido: '#22c55e', indeferido: '#ef4444', em_analise: '#f59e0b', solicita_documentos: '#3b82f6', outros: '#6b7280' };
                                            const tipoLabels = { deferido: 'Deferido', indeferido: 'Indeferido', em_analise: 'Em Análise', solicita_documentos: 'Solicita Documentos', outros: 'Outros' };
                                            const color = tipoColors[d.tipo_resposta] || tipoColors.outros;
                                            const label = tipoLabels[d.tipo_resposta] || d.tipo_resposta;
                                            return (
                                              <div style={{ border: `1px solid ${color}40`, borderRadius: 8, padding: '8px 10px', background: `${color}10`, fontSize: 11 }}>
                                                <div style={{ fontWeight: 700, color, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                                                  <Sparkles size={10} /> {label}
                                                </div>
                                                <div style={{ color: 'var(--fg)', opacity: 0.9 }}>{d.resumo}</div>
                                                {(d.valor != null || d.prazo || d.numero_protocolo) && (
                                                  <div style={{ marginTop: 4, display: 'flex', gap: 10, opacity: 0.75, flexWrap: 'wrap' }}>
                                                    {d.valor != null && <span>Valor: <b>R$ {Number(d.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</b></span>}
                                                    {d.prazo && <span>Prazo: <b>{d.prazo}</b></span>}
                                                    {d.numero_protocolo && <span>Protocolo: <b>{d.numero_protocolo}</b></span>}
                                                  </div>
                                                )}
                                              </div>
                                            );
                                          })()}
                                          {extState?.error && <div style={{ color: 'var(--danger)', fontSize: 10 }}>{extState.error}</div>}
                                        </div>
                                      )}
                                      <div>
                                        <b>Por:</b> {usuarioLabel}
                                      </div>

                                      {Array.isArray(item.anexos) && item.anexos.length > 0 && (
                                        <div className="flex flex-wrap gap-2">
                                          {item.anexos.map((anexo, anexoIdx) => {
                                            const path = String(anexo.url || anexo.caminho_arquivo || '').trim();
                                            const href = path.startsWith('http')
                                              ? path
                                              : path
                                              ? `/${path.replace(/^\/+/, '')}`
                                              : '';
                                            const nome = anexo.nome || anexo.nome_arquivo || `Anexo ${anexoIdx + 1}`;
                                            const anexoId =
                                              anexo.id ?? anexo.ID ?? anexo.id_anexo ?? anexo.idAnexo ?? null;

                                            return href ? (
                                              <div key={`hist-anexo-${gidx}-${idx}-${anexoIdx}`} className="flex items-center gap-2">
                                                <a
                                                  className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:opacity-90"
                                                  href={withAuthToken(href)}
                                                  target="_blank"
                                                  rel="noreferrer"
                                                >
                                                  {nome}
                                                </a>
                                                {anexoId != null && onDeleteAnexo ? (
                                                  <button
                                                    type="button"
                                                    className="btn-outline text-xs"
                                                    onClick={() => onDeleteAnexo(pid, anexoId)}
                                                  >
                                                    Excluir
                                                  </button>
                                                ) : null}
                                              </div>
                                            ) : (
                                              <span key={`hist-anexo-${gidx}-${idx}-${anexoIdx}`} className="text-xs opacity-70">
                                                {nome}
                                              </span>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {anexos.length > 0 && (
                        <div className="mt-4">
                          <div className="text-xs opacity-70 mb-1">Anexos</div>
                          <div className="flex flex-wrap gap-2">
                            {anexos.map((a, idx) => {
                              const path = String(a.url || a.caminho_arquivo || '').trim();
                              const href = path.startsWith('http')
                                ? path
                                : path
                                ? `/${path.replace(/^\/+/, '')}`
                                : '';
                              const nome = a.nome_arquivo || a.nome || `Anexo ${idx + 1}`;
                              const anexoId = a.id ?? a.ID ?? a.id_anexo ?? a.idAnexo ?? null;

                              return href ? (
                                <div key={`${a.id ?? 'anexo'}-${idx}`} className="flex items-center gap-2">
                                  <a
                                    className="px-2 py-1 rounded border panel-border text-xs hover:opacity-90"
                                    href={withAuthToken(href)}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {nome}
                                  </a>
                                  {anexoId != null && onDeleteAnexo ? (
                                    <button
                                      type="button"
                                      className="btn-outline text-xs"
                                      onClick={() => onDeleteAnexo(pid, anexoId)}
                                    >
                                      Excluir
                                    </button>
                                  ) : null}
                                </div>
                              ) : (
                                <span
                                  key={`${a.id ?? 'anexo'}-${idx}`}
                                  className="px-2 py-1 rounded border panel-border text-xs opacity-70"
                                >
                                  {nome}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : pane === 'score' ? (
                    (() => {
                      const rawPct = header?.score_percentual ?? scoreData?.[pid]?.percentual ?? null;
                      const pct = rawPct != null ? Math.round(Number(rawPct)) : null;
                      const labelColor =
                        pct === null ? 'text-gray-400' :
                        pct >= 70 ? 'text-green-500' :
                        pct >= 40 ? 'text-yellow-500' : 'text-red-400';
                      const barColor =
                        pct === null ? 'bg-gray-300' :
                        pct >= 70 ? 'bg-green-500' :
                        pct >= 40 ? 'bg-yellow-500' : 'bg-red-400';

                      return (
                        <div className="flex flex-col gap-4 pt-1">
                          <div className="font-semibold">Score de Progressão</div>
                          <p className="text-xs opacity-60">
                            Probabilidade de avançar para Fluxo, Faturamento ou Concluídos.
                          </p>

                          {pct === null ? (
                            <div className="text-sm opacity-50">Score não calculado para este processo.</div>
                          ) : (
                            <>
                              <div className={`text-5xl font-bold ${labelColor}`}>
                                {pct}%
                              </div>

                              <div className={`text-sm font-semibold ${labelColor}`}>
                                {pct >= 70 ? 'Alta' : pct >= 40 ? 'Média' : 'Baixa'}
                              </div>

                              <div className="w-full bg-[var(--border)] rounded-full h-3">
                                <div
                                  className={`${barColor} h-3 rounded-full transition-all duration-500`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })()
                  ) : (
                    rightPane || <div className="text-sm opacity-70">Selecione uma opção.</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modal de confirmação de download do ofício */}
      {docConfirmOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDocConfirmOpen(false)} />
          <div className="relative w-full max-w-sm bg-[var(--panel)] border border-[var(--panel-border)] rounded-lg shadow-xl p-5">
            <div className="text-base font-bold mb-1">Baixar ofício</div>
            <div className="text-sm opacity-80 mb-4">
              Deseja baixar o documento <span className="font-medium">{docFilename}</span>?
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-outline text-sm"
                onClick={() => setDocConfirmOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn-themed text-sm"
                onClick={async () => {
                  setDocConfirmOpen(false);
                  try {
                    const token = (localStorage.getItem('userToken') || '')
                      .replace(/^['"]+|['"]+$/g, '')
                      .trim();
                    const base = (import.meta?.env?.VITE_API_BASE || '/api/v1').trim();
                    const resp = await fetch(`${base}/processos/${pid}/documento`, {
                      headers: token ? { Authorization: `Bearer ${token}` } : {},
                    });
                    if (!resp.ok) throw new Error('Erro ao baixar documento');
                    const blob = await resp.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = docFilename;
                    a.click();
                    URL.revokeObjectURL(url);
                  } catch (err) {
                    console.error('[documento]', err);
                  }
                }}
              >
                Baixar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =======================
// Modal: Editar Histórico
// =======================
function EditHistoricoModal({
  open,
  processoId,
  draft,
  setDraft,
  onAddRow,
  onRemoveRow,
  onClose,
  onSave,
  historyAnexoUploading,
  onAttachHistoryAnexo,
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--panel-processos)] border panel-border text-[var(--fg)] p-5 rounded-lg shadow-xl w-full max-w-5xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Editar histórico do processo #{processoId}</h2>
          <button className="btn-outline" onClick={onClose} type="button">
            Fechar
          </button>
        </div>

        <div className="flex gap-2 mt-3">
          <button className="btn-themed" onClick={onAddRow} type="button">
            + Adicionar linha
          </button>
          <button className="btn-outline" onClick={onSave} type="button">
            Salvar histórico
          </button>
        </div>

        <div className="mt-4 max-h-[60vh] overflow-auto border panel-border rounded">
          <div className="grid grid-cols-12 gap-2 p-2 text-xs font-semibold opacity-70 border-b panel-border">
            <div className="col-span-3">Data</div>
            <div className="col-span-2">Etapa</div>
            <div className="col-span-2">Sub-etapa</div>
            <div className="col-span-4">Comentário</div>
            <div className="col-span-1 text-right"></div>
          </div>

          {(draft || []).map((h, idx) => (
            <div key={`h-${idx}`} className="grid grid-cols-12 gap-2 p-2 border-b panel-border items-start">
              <input
                type="datetime-local"
                className="input-themed text-xs col-span-3"
                value={toDateTimeLocal(h.data)}
                onChange={(e) =>
                  setDraft((prev) => {
                    const arr = [...(prev || [])];
                    arr[idx] = { ...(arr[idx] || {}), data: fromDateTimeLocal(e.target.value) };
                    return arr;
                  })
                }
              />

              <input
                className="input-themed text-xs col-span-2"
                value={h.etapa_nova || ''}
                onChange={(e) =>
                  setDraft((prev) => {
                    const arr = [...(prev || [])];
                    arr[idx] = { ...(arr[idx] || {}), etapa_nova: e.target.value };
                    return arr;
                  })
                }
                placeholder="Etapa"
              />

              <input
                className="input-themed text-xs col-span-2"
                value={h.sub_etapa || ''}
                onChange={(e) =>
                  setDraft((prev) => {
                    const arr = [...(prev || [])];
                    arr[idx] = { ...(arr[idx] || {}), sub_etapa: e.target.value };
                    return arr;
                  })
                }
                placeholder="Sub-etapa"
              />

              <input
                className="input-themed text-xs col-span-4"
                value={h.comentario || ''}
                onChange={(e) =>
                  setDraft((prev) => {
                    const arr = [...(prev || [])];
                    arr[idx] = { ...(arr[idx] || {}), comentario: e.target.value };
                    return arr;
                  })
                }
                placeholder="Comentário"
              />

              <div className="col-span-1 flex justify-end gap-2">
                {h.id_historico && (
                  <label className="btn-outline text-xs cursor-pointer">
                    <Paperclip size={12} />
                    <input
                      type="file"
                      className="hidden"
                      disabled={!!historyAnexoUploading?.[h.id_historico]}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file && onAttachHistoryAnexo) onAttachHistoryAnexo(processoId, h.id_historico, file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}

                <button className="btn-outline text-xs" onClick={() => onRemoveRow(idx)} type="button">
                  Remover
                </button>
              </div>
            </div>
          ))}

          {!draft?.length && <div className="p-3 text-sm opacity-70">Sem histórico carregado.</div>}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button className="btn-outline" onClick={onClose} type="button">
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

// =======================
// Pane: Movimentar
// =======================
function MovePane({
  pid,
  etapaSubMap,
  moveTarget,
  moveColuna,
  setMoveColuna,
  setMoveColunaAtual,
  setMoveEtapaAtual,
  moveEtapa,
  setMoveEtapa,
  moveSub,
  setMoveSub,
  moveComentario,
  setMoveComentario,
  setMoveAdvanceOpen,
  moveCanais,
  setMoveCanais,
  moveArquivo,
  setMoveArquivo,
  setToast,
  setLoading,
  load,
  scheduleQuickConfirm,
  notifyNetworkChange,
  scheduleSuccessModal,
  onAfterMove,
  onClosePane,
}) {
  const etapasPorColuna = KANBAN_ETAPAS[moveColuna] || [];
  const mappedEtapa = MAPA_COLUNAS_PARA_ETAPAS[moveColuna] || etapasPorColuna[0] || '';
  const etapaSelecionada = etapasPorColuna.includes(moveEtapa) ? moveEtapa : mappedEtapa;
  const isDeferidos = String(moveColuna || '').trim().toLowerCase() === 'deferidos';
  // Fallback: se o map vier vazio (api falhou silenciosamente, token expirado,
  // etc.) usamos a lista hardcoded SUBETAPAS_FALLBACK para garantir que a
  // select de subetapa nunca apareça vazia.
  const subFromMap = etapaSelecionada ? (etapaSubMap?.[etapaSelecionada] || []) : [];
  const subFromFallback = etapaSelecionada ? (SUBETAPAS_FALLBACK[etapaSelecionada] || []) : [];
  const subetapasDisponiveis = isDeferidos
    ? SUBETAPAS_DEFERIDOS
    : (subFromMap.length ? subFromMap : subFromFallback);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b panel-border">
        <div className="min-w-0">
          <div className="font-semibold">Movimentar processo #{pid}</div>
          <div className="text-xs opacity-70 truncate">
            {pickFirst(moveTarget?.header || {}, ['cliente', 'Cliente'], '')}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto pr-1">
        <div className="grid gap-4">
          <Field label="Coluna do Kanban">
            <select
              className="input-themed w-full"
              value={moveColuna}
              onChange={(e) => {
                const nextColuna = e.target.value;
                setMoveColuna(nextColuna);

                const etapas = KANBAN_ETAPAS[nextColuna] || [];
                const etapaDefault = MAPA_COLUNAS_PARA_ETAPAS[nextColuna] || etapas[0] || '';
                setMoveEtapa(etapaDefault);

                if (String(nextColuna || '').toLowerCase().includes('suspens')) {
                  setMoveSub('Suspenso');
                } else if (String(moveSub || '').toLowerCase() === 'suspenso') {
                  setMoveSub('');
                } else {
                  setMoveSub('');
                }
              }}
            >
              <option value="">Selecione...</option>
              {KANBAN_COLUNAS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Etapa">
            <select
              className="input-themed w-full"
              value={etapaSelecionada}
              onChange={(e) => {
                setMoveEtapa(e.target.value);
                setMoveSub('');
              }}
              disabled={!moveColuna || etapasPorColuna.length === 0}
            >
              <option value="">
                {!moveColuna ? 'Selecione uma coluna' : etapasPorColuna.length ? 'Selecione...' : 'Sem etapas'}
              </option>
              {etapasPorColuna.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>

          <Field label={`Sub-etapa${String(moveColuna || '').toLowerCase().includes('conclu') ? ' (opcional)' : ' *'}`}>
            <select
              className="input-themed w-full"
              value={moveSub}
              onChange={(e) => setMoveSub(e.target.value)}
              disabled={!moveColuna || !(moveEtapa || mappedEtapa)}
            >
              <option value="">
                {!moveColuna
                  ? 'Selecione uma coluna'
                  : String(moveColuna || '').toLowerCase().includes('conclu')
                  ? '— sem sub-etapa —'
                  : 'Selecione...'}
              </option>
              {subetapasDisponiveis.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Comentário">
            <textarea
              rows={3}
              className="input-themed w-full"
              value={moveComentario}
              onChange={(e) => setMoveComentario(e.target.value)}
              placeholder="Comentário para o histórico"
            />
          </Field>

          <Field label="Canais de comunicação">
            <CanaisSelector
              canais={moveCanais}
              onToggle={(key) =>
                setMoveCanais((prev) => ({ ...(prev || {}), [key]: !prev?.[key] }))
              }
            />
          </Field>

          <Field label="Anexo">
            <div className="flex items-center justify-between gap-2">
              <label className="btn-outline cursor-pointer">
                Anexar
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => setMoveArquivo(e.target.files?.[0] || null)}
                />
              </label>
              {moveArquivo?.name && (
                <div className="text-xs opacity-70 truncate max-w-[240px]">{moveArquivo.name}</div>
              )}
            </div>
          </Field>
        </div>
      </div>

      <div className="flex justify-end gap-3 mt-4 pt-3 border-t panel-border">
        <button
          onClick={onClosePane}
          className="px-4 py-2 panel-bg-60 rounded border panel-border hover:opacity-90"
          type="button"
        >
          Cancelar
        </button>

        <button
          type="button"
          onClick={async () => {
            const id = moveTarget?.pid;
            const colunaDestino = String(moveColuna || '').trim();
            const etapaDestino =
              String(moveEtapa || '').trim() ||
              MAPA_COLUNAS_PARA_ETAPAS[colunaDestino] ||
              colunaDestino;

            if (!id || !colunaDestino || !etapaDestino) {
              alert('Preencha os campos obrigatórios.');
              return;
            }

            const canais = Object.entries(moveCanais || {})
              .filter(([, v]) => !!v)
              .map(([k]) => k);

            let stopQuick;
            let stopSuccess;
            try {
              if (!(await confirmAction(`Deseja mover o processo #${id} para "${colunaDestino}"?`))) return;
              setLoading(true);
              stopQuick = scheduleQuickConfirm();
              stopSuccess = scheduleSuccessModal(`Processo ${id} movido.`);
              const fd = new FormData();
              fd.append('etapa_atual', etapaDestino);

              const subTrim = String(moveSub || '').trim();
              const comentarioFinal =
                buildComentarioFinal({ texto: moveComentario }) ||
                `Movimentado para ${colunaDestino}${subTrim ? ` (${subTrim})` : ''}`;
              const isSuspensosCol = String(colunaDestino || '').toLowerCase().includes('suspens');
              // Concluídos é a única coluna onde sub-etapa pode ficar em branco
              // (etapa = "Concluído" basta). Demais colunas exigem sub-etapa.
              const isConcluidosCol = String(colunaDestino || '').toLowerCase().includes('conclu');

              if (!subTrim && !isConcluidosCol) {
                setToast({ open: true, type: 'warning', text: 'Sub-etapa é obrigatória.' });
                return;
              }

              if (isSuspensosCol) {
                fd.append('sub_etapa', subTrim || 'Suspenso');
              } else if (isConcluidosCol) {
                // Sub-etapa opcional aqui — manda vazia se não preencheu, ou
                // o valor digitado se houver.
                fd.append('sub_etapa', subTrim);
              } else if (subTrim && subTrim.toLowerCase() !== 'suspenso') {
                fd.append('sub_etapa', subTrim);
              }

              if (comentarioFinal) fd.append('comentario', comentarioFinal);
              if (canais.length > 0) fd.append('canais', JSON.stringify(canais));
              if (moveArquivo) fd.append('anexos', moveArquivo);

              await movimentarProcesso(id, fd);
              setToast({ open: true, type: 'success', text: `Processo ${id} movido.` });

              onClosePane();
              setMoveColuna('');
              setMoveColunaAtual('');
              setMoveEtapaAtual('');
              setMoveEtapa('');
              setMoveSub('');
              setMoveComentario('');
              setMoveAdvanceOpen(false);
              setMoveCanais(DEFAULT_CANAIS);
              setMoveArquivo(null);

              await load({ force: true });

              if (onAfterMove) await onAfterMove(id);
            } catch (err) {
              setToast({ open: true, type: 'error', text: err?.message || 'Erro ao mover processo.' });
              notifyNetworkChange(err);
              if (typeof stopSuccess === 'function') stopSuccess();
              // eslint-disable-next-line no-undef
              setSaveModal({ open: false, mensagem: '' });
            } finally {
              if (typeof stopQuick === 'function') stopQuick();
              setLoading(false);
            }
          }}
          className="px-4 py-2 bg-[var(--accent)] text-[var(--fg)] font-bold rounded hover:opacity-90"
        >
          Mover
        </button>
      </div>
    </div>
  );
}


// =======================
// MAIN COMPONENT
// =======================
export default function ControleProcessos({ forceViewMode = 'processos', hideViewToggle = true } = {}) {
  const location = useLocation();
  const openedFromQueryRef = useRef(false);
  const { user } = useAuth();
  const isAdmin = String(user?.tipo_conta || '').toLowerCase() === 'admin';

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const [loadingAll, setLoadingAll] = useState(false);

  const [kanbanMap, setKanbanMap] = useState({});
  const [relevanciaMap, setRelevanciaMap] = useState({});
  const [scoreData, setScoreData] = useState({});

  // filtros / UI
  const [q, setQ] = useState('');
  const qDebounced = useDebouncedValue(q, 350);

  // Pre-populate q from URL ?q= param (e.g., navigated from CommandPalette search result)
  useEffect(() => {
    if (openedFromQueryRef.current) return;
    const sp = new URLSearchParams(location.search);
    const qParam = (sp.get('q') || '').trim();
    if (qParam) {
      openedFromQueryRef.current = true;
      setQ(qParam);
    }
  }, [location.search]);

  const {
    processColWidths,
    setProcessColWidths,
    processResizeRef,
    processSort,
    setProcessSort,
  } = useProcessosTabela();

  const [exportOpen, setExportOpen] = useState(false);
  const [exportFilters, setExportFilters] = useState({
    uc: '',
    id_requisicao: '',
    cliente: '',
    concessionaria: '',
    data_criacao_ini: '',
    data_criacao_fim: '',
    id_status: '',
    status: '',
    ultima_atualizacao_ini: '',
    ultima_atualizacao_fim: '',
    ultima_movimentacao_ini: '',
    ultima_movimentacao_fim: '',
    etapa_historico: '',
    sub_etapa_historico: '',
    suspenso: '',
    data_deferido_simples_ini: '',
    data_deferido_simples_fim: '',
    data_deferido_dobro_ini: '',
    data_deferido_dobro_fim: '',
    forma_devolucao: '',
    data_envio_financeiro_ini: '',
    data_envio_financeiro_fim: '',
    primeira_nf: '',
    ressarcimento_estimado_min: '',
    ressarcimento_estimado_max: '',
    qtde_deferidos_min: '',
    qtde_deferidos_max: '',
    credito_simples_min: '',
    credito_simples_max: '',
    credito_dobro_min: '',
    credito_dobro_max: '',
    total_cliente_min: '',
    total_cliente_max: '',
    repasse_simples_min: '',
    repasse_simples_max: '',
    repasse_dobro_min: '',
    repasse_dobro_max: '',
    total_amee_min: '',
    total_amee_max: '',
    qtde_registros_fluxo_min: '',
    qtde_registros_fluxo_max: '',
    valor_fluxo_min: '',
    valor_fluxo_max: '',
    qtde_registros_faturamento_min: '',
    qtde_registros_faturamento_max: '',
    valor_fat_min: '',
    valor_fat_max: '',
  });
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importLoading, setImportLoading] = useState(false);

  const [activeTab, setActiveTab] = useState('ATIVOS');
  const [toast, setToast] = useState({ open: false, type: 'info', text: '' });
  const [viewMode, setViewMode] = useState(forceViewMode || 'processos'); // 'requisicoes' | 'processos'

  // Quando forceViewMode mudar (ou ControleProcessos/Requisicoes montar), respeita o forçado
  useEffect(() => {
    if (forceViewMode && viewMode !== forceViewMode) {
      setViewMode(forceViewMode);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceViewMode]);

  // Requisições (painel lateral)
  const [reqItems, setReqItems] = useState([]);
  const [reqColumns, setReqColumns] = useState({
    'Nova Requisição': [],
    'Em Análise': [],
    Aprovado: [],
    Rejeitado: [],
  });
  const [reqLoading, setReqLoading] = useState(false);
  const [reqQuery, setReqQuery] = useState('');
  const [reqDrawerOpen, setReqDrawerOpen] = useState(false);
  const [reqNovaModalOpen, setReqNovaModalOpen] = useState(false);
  const [reqEmailModalOpen, setReqEmailModalOpen] = useState(false);
  const reqNovaLockRef = useRef(false);
  const [selectedReqId, setSelectedReqId] = useState(null);
  const [reqDetails, setReqDetails] = useState(null);
  const [reqCounts, setReqCounts] = useState({ anexos: 0, faturas: 0, periodo: '' });
  const [reqComentario, setReqComentario] = useState('');
  const [reqCanais, setReqCanais] = useState(DEFAULT_CANAIS);
  const [reqSaving, setReqSaving] = useState(false);
  const [reqAnexoUploading, setReqAnexoUploading] = useState(false);
  const reqAnexoInputRef = useRef(null);
  const [reqAnexosOpen, setReqAnexosOpen] = useState(false);
  const [reqAnexosList, setReqAnexosList] = useState([]);
  const [reqEmail, setReqEmail] = useState({
    to: '',
    cc: '',
    subject: '',
    body: '',
    attachments: [],
  });
  const [reqEmailOpen, setReqEmailOpen] = useState(false);
  const [reqEmailMinimized, setReqEmailMinimized] = useState(false);
  const [reqEmailPos, setReqEmailPos] = useState({ x: 0, y: 0 });
  const reqEmailDragRef = useRef({ dragging: false, startX: 0, startY: 0, baseX: 0, baseY: 0 });
  const [reqInfoEditOpen, setReqInfoEditOpen] = useState(false);
  const [reqInfoDraft, setReqInfoDraft] = useState({
    cliente: '',
    uc: '',
    concessionaria: '',
    valor_estimado: '',
    link_fatura: '',
    descricao_irregularidade: '',
    periodos_irregularidade: '',
    endereco_completo: '',
    id_tipo_irregularidade: '',
    id_subtipo_irregularidade: '',
  });
  const [reqTiposIrregularidade, setReqTiposIrregularidade] = useState([]);
  const [reqSubtiposIrregularidade, setReqSubtiposIrregularidade] = useState([]);
  const reqTiposCacheRef = useRef(null);
  const reqSubtiposCacheRef = useRef(new Map());
  const [reqHistorico, setReqHistorico] = useState([]);
  const [reqHistoricoOpen, setReqHistoricoOpen] = useState(false);
  const [reqHistoricoLoading, setReqHistoricoLoading] = useState(false);
  const [reqFaturas, setReqFaturas] = useState([]);
  const [reqMoveOpen, setReqMoveOpen] = useState(false);
  const [reqMoveTarget, setReqMoveTarget] = useState({ id: null, destino: '' });
  const [reqMoveComment, setReqMoveComment] = useState('');
  const [reqDestinoStatus, setReqDestinoStatus] = useState('Aprovado');
  const [reqDestinoEtapa, setReqDestinoEtapa] = useState('');
  const [reqDestinoSub, setReqDestinoSub] = useState('');
  const [reqDestinoColuna, setReqDestinoColuna] = useState('');
  const [reqPreencherDeferimento, setReqPreencherDeferimento] = useState(false);
  const [reqDefData, setReqDefData] = useState('');
  const [reqDefSimples, setReqDefSimples] = useState('');
  const [reqDefDobro, setReqDefDobro] = useState('');
  const [reqDefDataDobro, setReqDefDataDobro] = useState('');
  const [reqEtapas, setReqEtapas] = useState([]);
  const reqStatusLabel = normalizeReqStatusValue(reqDetails?.status || reqDetails?.Status || 'Nova Requisição');
  const isNovaRequisicao = norm(reqStatusLabel).includes('nova requisicao') || norm(reqStatusLabel).includes('pendente');
  const [showAtivosMetricas, setShowAtivosMetricas] = useState(false);

  const scheduleQuickConfirm = useCallback((text = 'Salvamento enviado. Aguarde confirmação.') => {
    let done = false;
    let fired = false;
    const t = window.setTimeout(() => {
      if (done) return;
      fired = true;
      setToast({ open: true, type: 'info', text });
    }, 500);
    return () => {
      done = true;
      if (!fired) window.clearTimeout(t);
    };
  }, []);

  const notifyNetworkChange = useCallback((err) => {
    const msg = String(err?.message || err || '');
    const code = String(err?.code || '');
    if (
      msg.includes('ERR_NETWORK_CHANGED') ||
      msg.includes('Network Error') ||
      msg.includes('ERR_NETWORK') ||
      msg.includes('ERR_CONNECTION_REFUSED') ||
      code.includes('ERR_NETWORK')
    ) {
      setToast({ open: true, type: 'warning', text: 'Conexão alterada. Recarregue a página se houver erro.' });
    }
  }, []);

  const scheduleSuccessModal = useCallback((mensagem) => {
    const t = window.setTimeout(() => {
      setSaveModal({ open: true, mensagem: mensagem || 'Dados salvos.' });
    }, 1000);
    return () => window.clearTimeout(t);
  }, []);

  // Carrega score de progressão para um processo (via fila)
  const fetchScoreForRow = useCallback((pid) => {
    setScoreData((prev) => {
      if (prev[pid] !== undefined) return prev; // já carregado ou carregando — sem re-render
      // Evita crescimento ilimitado: mantém no máximo 300 entradas (FIFO)
      const entries = Object.entries(prev);
      const trimmed = entries.length >= 300
        ? Object.fromEntries(entries.slice(entries.length - 299))
        : prev;
      scoreQueue.add(`score_${pid}`, async () => {
        try {
          const data = await getProcessoScore(pid);
          setScoreData((p) => ({ ...p, [pid]: data }));
        } catch (err) {
          console.warn('[Score] Erro ao buscar score:', err);
          setScoreData((p) => ({ ...p, [pid]: { erro: 'Indisponível' } }));
        }
      });
      return { ...trimmed, [pid]: null }; // null = carregando
    });
  }, []);

  // Move / Edit
  const [mvByPid] = useState({}); // mantido (compat)
  const [detailsByPid, setDetailsByPid] = useState({});
  const [etapaSubMap, setEtapaSubMap] = useState({});

  const {
    moveTarget, setMoveTarget,
    moveColuna, setMoveColuna,
    moveColunaAtual, setMoveColunaAtual,
    moveEtapaAtual, setMoveEtapaAtual,
    moveEtapa, setMoveEtapa,
    moveSub, setMoveSub,
    moveComentario, setMoveComentario,
    moveAdvanceOpen, setMoveAdvanceOpen,
    moveCanais, setMoveCanais,
    moveArquivo, setMoveArquivo,
    drawerOpen, setDrawerOpen,
    selectedPid, setSelectedPid,
    drawerPane, setDrawerPane,
    historyEditOpen, setHistoryEditOpen,
    historyDraft, setHistoryDraft,
    historyDeletes, setHistoryDeletes,
    snapshotHeaderData, setSnapshotHeaderData,
    requisicaoHeaderData, setRequisicaoHeaderData,
    processoAnexos, setProcessoAnexos,
    summaryState, setSummaryState,
    summaryFeedback, setSummaryFeedback,
    summaryPollRef,
    refreshTimerRef,
    historyMatches, setHistoryMatches,
    historyLoading, setHistoryLoading,
    historyByPid, setHistoryByPid,
    historyDetailLoading, setHistoryDetailLoading,
    historyAnexoUploading, setHistoryAnexoUploading,
    historyLoadedRef,
    removeHistoryRow,
    stopSummaryPoll,
    startSummaryPoll,
    loadSummary,
    closeDrawer,
  } = useProcessoDrawerState();

  const [isSyncing, setIsSyncing] = useState(false);
  const [alertModal, setAlertModal] = useState({ open: false, mensagem: '', processoId: null });
  const [saveModal, setSaveModal] = useState({ open: false, mensagem: '' });


  const {
    ativosMetricas,
    selectedMonthIdx,
    setSelectedMonthIdx,
    monthLabels,
    loadAtivosMetricas,
  } = useAtivosMetricas();

  const {
    kanbanFilter, setKanbanFilter,
    showFilters, setShowFilters,
    showAllRows, setShowAllRows,
    filtroDataIni, setFiltroDataIni,
    filtroDataFim, setFiltroDataFim,
    filtroEtapa, setFiltroEtapa,
    filtroSubEtapa, setFiltroSubEtapa,
    filtroConcessionaria, setFiltroConcessionaria,
    filtroSuspenso, setFiltroSuspenso,
    filtroCliente, setFiltroCliente,
    filtroUC, setFiltroUC,
    filtroId, setFiltroId,
    filtroRelevancia, setFiltroRelevancia,
    filtroValorMin, setFiltroValorMin,
    filtroValorMax, setFiltroValorMax,
    sortField, setSortField,
    sortDir, setSortDir,
  } = useProcessosFiltros();

  const {
    columnLimits,
    setColumnLimits,
    fullLoadEnabled,
    setFullLoadEnabled,
    loadingAllRef,
    loadAll,
    load,
    syncLoadAll,
  } = useProcessosLoad({
    setRows,
    setKanbanMap,
    setRelevanciaMap,
    setLoading,
    setLoadingAll,
    setToast,
    setIsSyncing,
    loadAtivosMetricas,
  });

  const requestRealtimeRefresh = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = window.setTimeout(async () => {
      refreshTimerRef.current = null;
      await syncLoadAll();
    }, 400);
  }, [syncLoadAll]);

  // boot + refresh interval
  useEffect(() => {
    syncLoadAll();
    if (typeof window === 'undefined') return undefined;

    const handleFocus = () => syncLoadAll();
    const intervalId = window.setInterval(() => {
      syncLoadAll();
    }, 120000);

    window.addEventListener('focus', handleFocus);

    return () => {
      window.removeEventListener('focus', handleFocus);
      window.clearInterval(intervalId);
    };
  }, [syncLoadAll]);

  // Busca global no histórico (debounced)
  useEffect(() => {
    const term = String(qDebounced || '').trim();
    if (!term) {
      setHistoryMatches(new Set());
      setHistoryLoading(false);
      return;
    }

    const controller = new AbortController();

    (async () => {
      try {
        setHistoryLoading(true);
        const data = await searchGlobalHistorico(term, 500, 0, controller.signal);
        const hits = new Set();
        const arr = Array.isArray(data?.results) ? data.results : [];
        for (const it of arr) {
          const pid = String(it?.processo_id ?? it?.ProcessoID ?? it?.id ?? it?.ID ?? '');
          if (pid) hits.add(pid);
        }
        setHistoryMatches(hits);
      } catch (err) {
        if (err?.code !== 'ERR_CANCELED' && err?.name !== 'AbortError') {
          setHistoryMatches(new Set());
        }
      } finally {
        if (!controller.signal.aborted) setHistoryLoading(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [qDebounced]);

  // Etapas/Sub-etapas
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const etapas = await getEtapas();
        const subMap = await getEtapaSubMap();
        if (!mounted) return;
        setReqEtapas(Array.isArray(etapas) ? etapas : []);
        setEtapaSubMap(subMap || {});
        if (!subMap || Object.keys(subMap).length === 0) {
          console.warn(
            '[ControleProcessos] etapaSubMap veio vazio de /filtros/etapas-subetapas — usando SUBETAPAS_FALLBACK no MovePane.',
          );
        }
      } catch (err) {
        console.warn('Falha ao carregar etapas/sub-etapas:', err?.message || err);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Instâncias de deferimento (Distribuidora/Ouvidoria/ANEEL/SMA) — usadas
  // pela select no card Deferimento do drawer.
  const [instanciasDeferimento, setInstanciasDeferimento] = useState([]);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const r = await api.get('/instancias-deferimento');
        if (!mounted) return;
        setInstanciasDeferimento(Array.isArray(r?.data) ? r.data : []);
      } catch (err) {
        console.warn('Falha ao carregar instâncias de deferimento:', err?.message || err);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // SSE (updates + alertas)
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const token = getAuthToken();
    if (!token) return undefined;

    const withToken = (path) =>
      `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

    const globalSource = new EventSource(withToken('/api/v1/events'));
    const alertsSource = new EventSource(withToken('/api/v1/alertas/stream'));

    const handleUpdate = (event) => {
      try {
        const data = JSON.parse(event?.data || '{}');
        if (data?.type === 'processo_update') requestRealtimeRefresh();
      } catch {}
    };

    const handleAlert = (event) => {
      try {
        const data = JSON.parse(event?.data || '{}');
        if (data?.type !== 'alerta_novo') return;
        const msg = data?.payload?.mensagem || '';
        if (!msg) return;
        setAlertModal({
          open: true,
          mensagem: msg,
          processoId: data?.payload?.processo_id ?? null,
        });
      } catch {}
    };

    globalSource.addEventListener('update', handleUpdate);
    alertsSource.addEventListener('alerta', handleAlert);

    return () => {
      globalSource.removeEventListener('update', handleUpdate);
      alertsSource.removeEventListener('alerta', handleAlert);
      globalSource.close();
      alertsSource.close();
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [requestRealtimeRefresh]);

  const groups = useMemo(() => {
    const map = new Map();
    (rows || []).forEach((r) => {
      const pid = Number(r.processo_id ?? r.ProcessoID ?? r.processoId ?? r.id ?? 0) || 0;
      if (!map.has(pid)) map.set(pid, { header: r, hist: [] });
      map.get(pid).hist.push(r);
    });
    return Array.from(map.entries());
  }, [rows]);

  const tableRows = useMemo(() => {
    return groups
      .map(([pid, g]) => {
        const category = determineProcessoCategory(g.header, kanbanMap[String(pid)]);
        if (!category) return null;
        return {
          pid,
          header: g.header,
          history: g.hist,
          category,
        };
      })
      .filter(Boolean);
  }, [groups, kanbanMap]);

  const selectedRow = useMemo(() => {
    if (!selectedPid) return null;
    return tableRows.find((r) => r.pid === selectedPid) || null;
  }, [tableRows, selectedPid]);

  const historyItems = useMemo(() => {
    if (!selectedPid) return null;
    return historyByPid[selectedPid] || null;
  }, [historyByPid, selectedPid]);

  const queryPid = useMemo(() => {
    const params = new URLSearchParams(location.search || '');
    const raw = params.get('pid');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [location.search]);

  const queryReqId = useMemo(() => {
    const params = new URLSearchParams(location.search || '');
    const raw = params.get('req');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [location.search]);

  const queryView = useMemo(() => {
    const params = new URLSearchParams(location.search || '');
    return String(params.get('view') || '').toLowerCase();
  }, [location.search]);

  const openDrawer = useCallback((row) => {
    setSelectedPid(row.pid);
    setDrawerOpen(true);
    setDrawerPane('history');
    // Carrega score de progressão para processos em ATIVOS (para a tabela)
    if (activeTab === 'ATIVOS') {
      fetchScoreForRow(row.pid);
    }
  }, [fetchScoreForRow, activeTab]);


  useEffect(() => {
    if (!queryPid || openedFromQueryRef.current) return;
    const row = tableRows.find((r) => Number(r.pid) === queryPid);
    if (!row) return;
    const tab = ETAPA_TABS.find((t) => t.label === row.category);
    if (tab) setActiveTab(tab.id);
    openDrawer(row);
    openedFromQueryRef.current = true;
  }, [queryPid, tableRows, openDrawer]);


  const [headerFlags, setHeaderFlags] = useState({ relevancia: false, suspenso: false });
  useEffect(() => {
    if (!selectedRow) {
      setHeaderFlags({ relevancia: false, suspenso: false });
      return;
    }
    const susp =
      selectedRow.header?.suspenso === true ||
      selectedRow.header?.suspenso === 1 ||
      String(selectedRow.header?.suspenso || '').trim() === '1' ||
      String(selectedRow.header?.sub_etapa || '').toLowerCase().includes('suspenso');
    setHeaderFlags({
      relevancia: isRelevante(selectedRow.header, selectedRow.pid, relevanciaMap),
      suspenso: susp,
    });
  }, [selectedRow, relevanciaMap]);


  // carrega dados do processo no Drawer
  useEffect(() => {
    if (!selectedPid) return;
    let mounted = true;

    (async () => {
      try {
        const [reqResp, anexosResp, fluxoResp, fatResp] = await Promise.allSettled([
          api.get(`/requisicoes/${selectedPid}`),
          api.get(`/requisicoes/${selectedPid}/anexos`),
          api.get(`/fluxo-ressarcimento/${selectedPid}`),
          api.get(`/faturamento/${selectedPid}`),
        ]);

        if (!mounted) return;

        const req = reqResp.status === 'fulfilled' ? (reqResp.value?.data || null) : null;

        const anexosList =
          anexosResp.status === 'fulfilled' && Array.isArray(anexosResp.value?.data)
            ? anexosResp.value.data
            : [];

        const fluxoRaw = fluxoResp.status === 'fulfilled' ? (fluxoResp.value?.data || null) : null;
        const fatRaw = fatResp.status === 'fulfilled' ? (fatResp.value?.data || null) : null;

        setSnapshotHeaderData(null);
        setRequisicaoHeaderData(req);
        setProcessoAnexos(anexosList);

        const snap = null;
        setDetailsByPid((prev) => {
          const cur = prev?.[selectedPid] || {};
          const hasLocal = (key) => Object.prototype.hasOwnProperty.call(cur, key);

          const defaults = {
            cs: pickFirst({ ...(snap || {}), ...(req || {}) }, [
              'credito_simples',
              'creditoSimples',
              'deferimento_simples',
            ]),
            ds: pickFirst({ ...(snap || {}), ...(req || {}) }, [
              'data_simples',
              'data_procedencia',
              'dataSimples',
            ]),
            cd: pickFirst({ ...(snap || {}), ...(req || {}) }, [
              'credito_dobro',
              'creditoDobro',
              'deferimento_dobro',
            ]),
            dd: pickFirst({ ...(snap || {}), ...(req || {}) }, [
              'data_dobro',
              'data_credito_dobro',
              'dataDobro',
            ]),
            rs: pickFirst({ ...(snap || {}), ...(req || {}) }, [
              'repasse_simples',
              'repasse_amee',
              'repasseSimples',
            ]),
            rd: pickFirst({ ...(snap || {}), ...(req || {}) }, [
              'repasse_dobro',
              'repasseDobro',
            ]),
            // FK DM_INSTANCIA_DEFERIMENTO (1=Distribuidora, 2=Ouvidoria, 3=ANEEL, 4=SMA)
            idef: pickFirst({ ...(snap || {}), ...(req || {}) }, [
              'instancia_deferimento',
              'instanciaDeferimento',
            ]),
          };

          if (defaults.ds) defaults.ds = toDateInput(defaults.ds);
          if (defaults.dd) defaults.dd = toDateInput(defaults.dd);

          let changed = false;
          const next = { ...cur };

          Object.entries(defaults).forEach(([key, value]) => {
            if (hasLocal(key)) return;
            if (value == null || String(value).trim() === '') return;
            next[key] = value;
            changed = true;
          });

          if (!changed) return prev;
          return { ...(prev || {}), [selectedPid]: next };
        });

        const parseItens = (raw) => {
          if (!raw) return [];
          let data = raw;
          if (typeof data === 'string') {
            try {
              data = JSON.parse(data);
            } catch {
              return [];
            }
          }
          if (Array.isArray(data)) return data;
          if (Array.isArray(data.itens)) return data.itens;
          return [];
        };

        const fluxoItens = parseItens(fluxoRaw).map((it) => ({
          forma_devolucao: normalizeFormaDevolucao(it?.forma_devolucao ?? it?.forma ?? ''),
          valor: it?.valor ?? it?.valor_fluxo ?? '',
          simples: Number(it?.simples ?? it?.fluxo_simples ?? 0),
          dobro: Number(it?.dobro ?? it?.fluxo_dobro ?? 0),
          simples_dobro: Number(it?.simples_dobro ?? it?.fluxo_simples_dobro ?? 0),
          data_devolucao: it?.data_devolucao ?? it?.data_fluxo ?? '',
          data_envio_financeiro: it?.data_envio_financeiro ?? it?.data_envio ?? '',
        }));

        const faturamentoItens = parseItens(fatRaw).map((it) => ({
          numero_nf: it?.numero_nf ?? '',
          data_emissao: it?.data_emissao ?? '',
          data_vencimento: it?.data_vencimento ?? '',
          data_pagamento: it?.data_pagamento ?? '',
          valor: it?.valor ?? it?.valor_nf ?? '',
        }));

        if (fluxoItens.length || faturamentoItens.length) {
          setDetailsByPid((prev) => {
            const existing = prev?.[selectedPid] || {};
            let changed = false;
            const next = { ...existing };

            if ((!Array.isArray(existing.fluxo_itens) || existing.fluxo_itens.length === 0) && fluxoItens.length) {
              next.fluxo_itens = fluxoItens;
              changed = true;
            }

            if ((!Array.isArray(existing.faturamento_itens) || existing.faturamento_itens.length === 0) && faturamentoItens.length) {
              next.faturamento_itens = faturamentoItens;
              changed = true;
            }

            if (!changed) return prev;
            return { ...(prev || {}), [selectedPid]: next };
          });
        }
      } catch {
        if (!mounted) return;
        setSnapshotHeaderData(null);
        setRequisicaoHeaderData(null);
        setProcessoAnexos([]);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [selectedPid]);

  const loadHistoryDetails = useCallback(
    async (pid, force = false) => {
      if (!pid) return;
      if (!force && historyLoadedRef.current.has(pid)) return;

      if (force) historyLoadedRef.current.delete(pid);
      historyLoadedRef.current.add(pid);
      setHistoryDetailLoading(true);
      try {
        const data = await getHistoricoById(pid);
        setHistoryByPid((prev) => ({ ...(prev || {}), [pid]: data || [] }));
      } catch {
        historyLoadedRef.current.delete(pid); // permite retry em caso de erro
        setHistoryByPid((prev) => ({ ...(prev || {}), [pid]: [] }));
      } finally {
        setHistoryDetailLoading(false);
      }
    },
    [], // ref não precisa estar nas deps
  );

  const attachHistoryAnexo = useCallback(
    async (pid, histId, file) => {
      if (!pid || !histId || !file) return;
      setHistoryAnexoUploading((prev) => ({ ...(prev || {}), [histId]: true }));
      try {
        const fd = new FormData();
        fd.append('anexos', file);
        await api.post(`/processos/${pid}/historico/${histId}/anexos`, fd);

        await loadHistoryDetails(pid, true);

        const anexosResp = await api.get(`/requisicoes/${pid}/anexos`);
        const anexosList = Array.isArray(anexosResp?.data) ? anexosResp.data : [];
        setProcessoAnexos(anexosList);
      } catch (err) {
        setToast({ open: true, type: 'error', text: err?.message || 'Falha ao anexar arquivo.' });
      } finally {
        setHistoryAnexoUploading((prev) => ({ ...(prev || {}), [histId]: false }));
      }
    },
    [loadHistoryDetails],
  );

  const loadRequisicoes = useCallback(async (signal) => {
    setReqLoading(true);

    try {
      const rows = await getAllRequisicoes();
      if (signal?.aborted) return;
      const safeRows = Array.isArray(rows) ? rows : [];
      setReqItems(safeRows);

      const cols = {
        'Nova Requisição': [],
        'Em Análise': [],
        Aprovado: [],
        Rejeitado: [],
      };

      safeRows.forEach((req) => {
        const k = norm(normalizeReqStatusValue(req?.status || 'Nova Requisição'));

        // Regra especial: aprovado só conta se estiver na etapa/sub-etapa certa
        if (k.includes('aprov')) {
          const triagem = Number(pickFirst(req || {}, ['triagem', 'Triagem'], 0)) || 0;
          const criado = Number(pickFirst(req || {}, ['processo_criado', 'processoCriado'], 0)) || 0;
          if (triagem === 1 && criado === 1) cols.Aprovado.push(req);
          return;
        }

        if (k.includes('nova requisicao') || k.includes('pendente')) cols['Nova Requisição'].push(req);
        else if (k.includes('analise')) cols['Em Análise'].push(req);
        else if (k.includes('rejeit')) cols.Rejeitado.push(req);
        else cols['Nova Requisição'].push(req);
      });

      setReqColumns(cols);
    } catch (err) {
      console.warn('Falha ao carregar requisi\u00E7\u00F5es:', err?.message || err);
      setReqItems([]);
      setReqColumns({
        'Nova Requisição': [],
        'Em Análise': [],
        Aprovado: [],
        Rejeitado: [],
      });
    } finally {
      setReqLoading(false);
    }
  }, []);

  const reqCountsByCol = useMemo(() => {
    const out = { pendente: 0, em_analise: 0, aprovado: 0, rejeitado: 0 };
    try {
      Object.entries(reqColumns || {}).forEach(([k, arr]) => {
        const nk = norm(k);
        if (nk.includes('nova requisicao')) out.pendente = (arr || []).length;
        else if (nk.includes('analise')) out.em_analise = (arr || []).length;
        else if (nk.includes('aprov')) out.aprovado = (arr || []).length;
        else if (nk.includes('rejeit')) out.rejeitado = (arr || []).length;
      });
    } catch {}
    return out;
  }, [reqColumns]);

  const reqTotalByCols =
    reqCountsByCol.pendente + reqCountsByCol.em_analise + reqCountsByCol.aprovado + reqCountsByCol.rejeitado;

  const reqFilteredColumns = useMemo(() => {
    const base =
      reqColumns || {
        'Nova Requisição': [],
        'Em Análise': [],
        Aprovado: [],
        Rejeitado: [],
      };

    const needle = norm(reqQuery);
    if (!needle) return base;

    const matcher = (r) => {
      const id = r?.id || r?.id_requisicao || r?.ID || '';
      const uc = unwrapDbValue(r?.uc) || '';
      const cliente = unwrapDbValue(r?.cliente) || '';
      const conc = unwrapDbValue(r?.concessionaria) || '';
      const texto = `${id} ${uc} ${cliente} ${conc}`.toLowerCase();
      return texto.includes(needle);
    };

    const out = {};
    Object.entries(base).forEach(([col, arr]) => {
      out[col] = (arr || []).filter(matcher);
    });
    return out;
  }, [reqColumns, reqQuery]);

  const reqFilteredCount = useMemo(() => {
    try {
      return Object.values(reqFilteredColumns || {}).reduce((acc, arr) => acc + (arr || []).length, 0);
    } catch {
      return 0;
    }
  }, [reqFilteredColumns]);

  const closeReqDrawer = useCallback(() => {
    setReqDrawerOpen(false);
    setReqNovaModalOpen(false);
    reqNovaLockRef.current = false;
    setSelectedReqId(null);
    setReqDetails(null);
    setReqCounts({ anexos: 0, faturas: 0, periodo: '' });
    setReqFaturas([]);
    setReqComentario('');
    setReqCanais(DEFAULT_CANAIS);
    setReqEmail({ to: '', subject: '', body: '', attachments: [] });
    setReqEmailOpen(false);
    setReqEmailMinimized(false);
    setReqInfoEditOpen(false);
    setReqTiposIrregularidade([]);
    setReqSubtiposIrregularidade([]);
    setReqHistorico([]);
    setReqHistoricoOpen(false);
    setReqHistoricoLoading(false);
  }, []);

  useEffect(() => {
    if (!reqInfoEditOpen && !reqNovaModalOpen) return;
    let active = true;
    (async () => {
      try {
        if (reqTiposCacheRef.current) {
          setReqTiposIrregularidade(reqTiposCacheRef.current);
          return;
        }
        const tipos = await getTiposIrregularidade();
        if (!active) return;
        const list = Array.isArray(tipos) ? tipos : [];
        reqTiposCacheRef.current = list;
        setReqTiposIrregularidade(list);
      } catch {
        if (!active) return;
        setReqTiposIrregularidade([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [reqInfoEditOpen, reqNovaModalOpen]);

  useEffect(() => {
    if (!reqInfoEditOpen && !reqNovaModalOpen) return;
    const tipoId = reqInfoDraft.id_tipo_irregularidade;
    if (!tipoId) {
      setReqSubtiposIrregularidade([]);
      return;
    }
    let active = true;
    (async () => {
      try {
        const cached = reqSubtiposCacheRef.current.get(tipoId);
        if (cached) {
          setReqSubtiposIrregularidade(cached);
          return;
        }
        const subs = await getSubtiposIrregularidade(tipoId);
        if (!active) return;
        const list = Array.isArray(subs) ? subs : [];
        reqSubtiposCacheRef.current.set(tipoId, list);
        setReqSubtiposIrregularidade(list);
      } catch {
        if (!active) return;
        setReqSubtiposIrregularidade([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [reqInfoEditOpen, reqNovaModalOpen, reqInfoDraft.id_tipo_irregularidade]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const tipos = await getTiposIrregularidade();
        if (!active) return;
        const list = Array.isArray(tipos) ? tipos : [];
        reqTiposCacheRef.current = list;
        setReqTiposIrregularidade(list);
      } catch {}
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (reqNovaModalOpen) {
      setReqDrawerOpen(false);
    }
  }, [reqNovaModalOpen]);

  const isReqNovaStatus = useCallback((reqObj) => {
    const raw = normalizeReqStatusValue(reqObj?.status || reqObj?.Status || 'Nova Requisição');
    const n = norm(raw);
    return n.includes('nova requisicao') || n.includes('pendente');
  }, []);

  const openReqDrawer = useCallback(async (req) => {
    const id = req?.id || req?.id_requisicao || req?.ID || req?.Id;
    if (!id) return;
    setViewMode('requisicoes');
    setDrawerOpen(false);
    setSelectedPid(null);
    setDrawerPane('');
    const isNova = isReqNovaStatus(req);
    reqNovaLockRef.current = isNova;
    setSelectedReqId(Number(id));
    setReqDrawerOpen(!isNova);
    setReqNovaModalOpen(isNova);
    setReqDetails(req);
    setReqHistoricoOpen(false);
    setReqHistoricoLoading(true);
    // carrega histórico em paralelo para não travar o modal
    (async () => {
      try {
        const hist = await getHistoricoById(id);
        setReqHistorico(Array.isArray(hist) ? hist : []);
      } catch {
        setReqHistorico([]);
      } finally {
        setReqHistoricoLoading(false);
      }
    })();
    try {
      const [det, anexosResp, faturasResp] = await Promise.all([
        getRequisicaoById(id),
        api.get(`/requisicoes/${id}/anexos`),
        api.get(`/requisicoes/${id}/faturas`),
      ]);
      const anexosCount = Array.isArray(anexosResp?.data) ? anexosResp.data.length : 0;
      const faturasList =
        Array.isArray(faturasResp?.data?.faturas) ? faturasResp.data.faturas : [];
      setReqFaturas(faturasList);
      const mergedReq = { ...(req || {}), ...(det || {}) };
      if (reqNovaLockRef.current) {
        setReqDrawerOpen(false);
        setReqNovaModalOpen(true);
      } else {
        const isNovaDet = isReqNovaStatus(mergedReq);
        setReqDrawerOpen(!isNovaDet);
        setReqNovaModalOpen(isNovaDet);
      }
      setReqDetails(mergedReq);
      setReqInfoDraft((prev) => ({
        ...prev,
        id_tipo_irregularidade: pickFirst(
          mergedReq,
          ['id_tipo_irregularidade', 'idTipoIrregularidade', 'id_tipo', 'tipo_id'],
          prev?.id_tipo_irregularidade || '',
        ),
        id_subtipo_irregularidade: pickFirst(
          mergedReq,
          ['id_subtipo_irregularidade', 'idSubtipoIrregularidade', 'id_subtipo', 'subtipo_id'],
          prev?.id_subtipo_irregularidade || '',
        ),
      }));
      // período rápido (sem bloquear UI)
      let periodoLabel = '';
      try {
        const raw = det?.periodos_irregularidade || det?.PeriodosIrregularidade || '';
        if (raw) {
          const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const refs = Array.isArray(arr)
            ? arr
                .map((p) => {
                  const y = String(p?.ano ?? p?.Ano ?? '').trim();
                  const m = String(p?.mes ?? p?.Mes ?? '').trim();
                  if (!y || !m) return null;
                  return `${y}-${String(m).padStart(2, '0')}`;
                })
                .filter(Boolean)
            : [];
          const sorted = [...refs].sort();
          if (sorted.length) periodoLabel = `${sorted[0]} a ${sorted[sorted.length - 1]}`;
        }
      } catch {}
      setReqCounts({
        anexos: anexosCount,
        faturas: faturasList.length,
        periodo: periodoLabel,
      });

      // busca detalhada de faturas em background
      (async () => {
        try {
          const uc = det?.uc || det?.UC || '';
          let arr = [];
          const raw = det?.periodos_irregularidade || det?.PeriodosIrregularidade || '';
          if (raw) arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const refs = Array.isArray(arr)
            ? arr
                .map((p) => {
                  const y = String(p?.ano ?? p?.Ano ?? '').trim();
                  const m = String(p?.mes ?? p?.Mes ?? '').trim();
                  if (!y || !m) return null;
                  return `${y}-${String(m).padStart(2, '0')}`;
                })
                .filter(Boolean)
            : [];
          if (uc && refs.length) {
            const dados = await buscarFaturasPorUnidadeMeses(uc, refs);
            const links =
              (Array.isArray(dados?.links_faturas_detalhes) && dados.links_faturas_detalhes) ||
              (Array.isArray(dados?.links_faturas) && dados.links_faturas) ||
              [];
            if (links.length) {
              const list = links.map((link, idx) => ({ link, mes_ref: refs[idx] || '' }));
              setReqFaturas(list);
            }
            const count = Array.isArray(dados?.faturas)
              ? dados.faturas.length
              : Array.isArray(dados?.links_faturas_detalhes)
              ? dados.links_faturas_detalhes.length
              : Array.isArray(dados?.links_faturas)
              ? dados.links_faturas.length
              : 0;
            setReqCounts((prev) => ({ ...prev, faturas: count }));
          }
        } catch {}
      })();
    } catch (err) {
      console.warn('Falha ao carregar detalhes da requisição:', err?.message || err);
      setReqFaturas([]);
    }
  }, [isReqNovaStatus]);

  useEffect(() => {
    if (!queryReqId || openedFromQueryRef.current) return;
    setViewMode('requisicoes');
    const row = (reqItems || []).find(
      (r) => Number(r.id || r.id_requisicao || r.ID || r.Id) === queryReqId,
    );
    if (row) openReqDrawer(row);
    openedFromQueryRef.current = true;
  }, [queryReqId, reqItems, openReqDrawer]);

  const reqSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 10 } }),
  );

  const reqColToEtapa = useMemo(
    () => ({
      Ativos: 'Distribuidora',
      Deferidos: 'Distribuidora',
      'Fluxo de Ressarcimento': 'Enviado ao Financeiro',
      Faturamento: 'Ressarcimento',
      'Concluídos': 'Concluído',
      Indeferidos: 'Indeferido',
    }),
    [],
  );

  const handleUpdateRequisicao = useCallback(
    async (reqOrId, newStatus, comentario, extra = {}) => {
      const statusValue = normalizeReqStatusValue(newStatus);
      const isApproved = norm(statusValue).includes('aprov');
      const req = reqOrId && typeof reqOrId === 'object' ? reqOrId : null;
      const id = req?.id ?? reqOrId;
      let processoId =
        extra?.processoId ??
        req?.processo_id ??
        req?.id_processo ??
        req?.processoId ??
        req?.ProcessoID ??
        null;
      let found = null;
      if (!processoId) {
        const all = Object.values(reqColumns || {}).flat();
        found = all.find((r) => String(r?.id) === String(id)) || null;
        processoId =
          found?.processo_id ??
          found?.id_processo ??
          found?.processoId ??
          found?.ProcessoID ??
          processoId;
      }
      const reqRef = req || found || {};
      const tipoId = pickFirst(reqRef, ['id_tipo_irregularidade', 'idTipoIrregularidade', 'id_tipo', 'tipo_id'], '');
      const subtipoId = pickFirst(reqRef, ['id_subtipo_irregularidade', 'idSubtipoIrregularidade', 'id_subtipo', 'subtipo_id'], '');
      if (isApproved && !(extra?.etapa || extra?.sub_etapa)) {
        extra = {
          ...(extra || {}),
          etapa: 'Distribuidora',
          sub_etapa: 'Primeira reclamação da etapa - Em elaboração',
        };
      }
      const formData = new FormData();
      formData.append('status', statusValue);
      formData.append('comentario', comentario || '');
      if (isApproved) {
        if (extra?.etapa) formData.append('etapa', extra.etapa);
        if (extra?.sub_etapa) formData.append('sub_etapa', extra.sub_etapa);
        formData.append('triagem', '1');
        formData.append('processo_criado', '1');
        if (tipoId) formData.append('id_tipo_irregularidade', tipoId);
        if (subtipoId) formData.append('id_subtipo_irregularidade', subtipoId);
      }
      if (!(await confirmAction(`Deseja atualizar a requisição #${id}?`))) return;
      try {
        await atualizarRequisicaoCompleta(id, formData);
        if (isApproved && (extra?.etapa || extra?.sub_etapa) && processoId) {
          setTimeout(async () => {
            try {
              const fd = new FormData();
              if (extra?.etapa) fd.append('etapa_atual', extra.etapa);
              if (extra?.sub_etapa) fd.append('sub_etapa', extra.sub_etapa);
              fd.append('comentario', comentario || 'Destino definido na aprovação');
              if (extra?.deferimento) {
                fd.append('deferimento', JSON.stringify(extra.deferimento));
              }
              await movimentarProcesso(processoId, fd);
            } catch {}
          }, 300);
        }
        await loadRequisicoes();
        setToast({ open: true, type: 'success', text: `Requisição #${id} movida para "${statusValue}"` });
        closeReqDrawer();
      } catch (err) {
        setToast({ open: true, type: 'error', text: 'Falha ao atualizar o status da requisição.' });
        console.error('Erro ao atualizar requisição:', err);
      }
    },
    [reqColumns, loadRequisicoes, closeReqDrawer],
  );

  const handleReqDragEnd = useCallback(
    (event) => {
      if (!isAdmin) return;
      const { active, over } = event || {};
      if (!active || !over) return;
      const reqId = active.id;
      const destino = over.id;
      const allowed = Object.keys(reqColumns || {});
      if (!allowed.includes(destino)) return;
      setReqMoveTarget({ id: reqId, destino });
      setReqMoveComment('');
      setReqDestinoStatus(destino);
      if (destino === 'Aprovado') {
        setReqDestinoEtapa('Distribuidora');
        setReqDestinoSub('Primeira reclamação da etapa - Em elaboração');
      }
      setReqMoveOpen(true);
    },
    [isAdmin, reqColumns],
  );

  const getReqIdFromRow = useCallback((row) => {
    const header = row?.header || {};
    const raw = pickFirst(
      header,
      [
        'id_requisicao',
        'requisicao_id',
        'requisicaoId',
        'idReq',
        'req_id',
        'ID_REQUISICAO',
      ],
      '',
    );
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, []);

  const handleProcessCardOpen = useCallback(
    (row) => {
      if (activeTab === 'DEFERIDOS') {
        const reqId = getReqIdFromRow(row);
        if (reqId) {
          setViewMode('requisicoes');
          openReqDrawer({ id: reqId, id_requisicao: reqId });
          return;
        }
      }
      openDrawer(row);
    },
    [activeTab, getReqIdFromRow, openReqDrawer, openDrawer],
  );

  const toggleReqCanal = useCallback((key) => {
    setReqCanais((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  }, []);

  const handleReqComment = useCallback(async () => {
    if (!selectedReqId) return;
    const comentario = String(reqComentario || '').trim();
    if (!comentario) {
      setToast({ open: true, type: 'warning', text: 'Informe um comentário.' });
      return;
    }
    const canais = Object.entries(reqCanais || {})
      .filter(([, v]) => v)
      .map(([k]) => k);
    setReqSaving(true);
    try {
      await comentarProcesso(selectedReqId, { comentario, canais });
      setReqComentario('');
      setToast({ open: true, type: 'success', text: 'Comentário registrado.' });
      try {
        const hist = await getHistoricoById(selectedReqId);
        setReqHistorico(Array.isArray(hist) ? hist : []);
      } catch {}
    } catch (err) {
      setToast({
        open: true,
        type: 'error',
        text: err?.response?.data?.error || err?.message || 'Falha ao comentar.',
      });
      notifyNetworkChange(err);
    } finally {
      setReqSaving(false);
    }
  }, [selectedReqId, reqComentario, reqCanais, notifyNetworkChange]);

  const handleReqAnexar = useCallback(
    async (file) => {
      if (!selectedReqId || !file) return;
      setReqAnexoUploading(true);
      try {
        const fd = new FormData();
        fd.append('anexos', file);
        await api.post(`/requisicoes/${selectedReqId}/anexos`, fd);
        setToast({ open: true, type: 'success', text: 'Anexo enviado.' });
        try {
          const anexosResp = await api.get(`/requisicoes/${selectedReqId}/anexos`);
          const anexosCount = Array.isArray(anexosResp?.data) ? anexosResp.data.length : 0;
          setReqCounts((prev) => ({ ...(prev || {}), anexos: anexosCount }));
        } catch {}
      } catch (err) {
        setToast({
          open: true,
          type: 'error',
          text: err?.response?.data?.error || err?.message || 'Falha ao anexar.',
        });
        notifyNetworkChange(err);
      } finally {
        setReqAnexoUploading(false);
      }
    },
    [selectedReqId, notifyNetworkChange],
  );

  const handleRejectRequisicao = useCallback(
    async (req) => {
      const id = req?.id ?? req?.id_requisicao ?? req?.ID ?? '';
      if (!id) return;
      await handleUpdateRequisicao(req, 'Rejeitado', 'Requisição rejeitada no card');
    },
    [handleUpdateRequisicao],
  );

  const handleIndeferirProcesso = useCallback(
    async (row) => {
      const pid = row?.pid ?? row?.header?.processo_id ?? row?.header?.id_processo ?? null;
      if (!pid) return;
      if (!(await confirmAction(`Deseja indeferir o processo #${pid}?`))) return;
      setLoading(true);
      try {
        const fd = new FormData();
        fd.append('etapa_atual', 'Indeferido');
        fd.append('sub_etapa', '');
        fd.append('comentario', 'Processo indeferido via card.');
        await movimentarProcesso(pid, fd);
        await load({ force: true });
        setToast({ open: true, type: 'success', text: `Processo #${pid} indeferido.` });
      } catch (err) {
        setToast({
          open: true,
          type: 'error',
          text: err?.response?.data?.error || err?.message || 'Falha ao indeferir processo.',
        });
        notifyNetworkChange(err);
      } finally {
        setLoading(false);
      }
    },
    [load, notifyNetworkChange],
  );

  const handleConcluirProcesso = useCallback(
    async (pid) => {
      if (!pid) return;
      if (!(await confirmAction(`Deseja concluir o processo #${pid}?`))) return;
      setLoading(true);
      try {
        const fd = new FormData();
        fd.append('etapa_atual', 'Concluídos');
        fd.append('sub_etapa', '');
        fd.append('comentario', 'Processo concluído via Faturamento.');
        await movimentarProcesso(pid, fd);
        await load({ force: true });
        setToast({ open: true, type: 'success', text: `Processo #${pid} concluído.` });
      } catch (err) {
        setToast({
          open: true,
          type: 'error',
          text: err?.response?.data?.error || err?.message || 'Falha ao concluir processo.',
        });
        notifyNetworkChange(err);
      } finally {
        setLoading(false);
      }
    },
    [load, notifyNetworkChange],
  );

  const openReqAnexos = useCallback(async () => {
    if (!selectedReqId) return;
    setReqAnexosOpen(true);
    try {
      const anexosResp = await api.get(`/requisicoes/${selectedReqId}/anexos`);
      const list = Array.isArray(anexosResp?.data) ? anexosResp.data : [];
      setReqAnexosList(list);
    } catch (err) {
      setReqAnexosList([]);
      setToast({
        open: true,
        type: 'error',
        text: err?.message || 'Falha ao carregar anexos.',
      });
      notifyNetworkChange(err);
    }
  }, [selectedReqId, notifyNetworkChange]);

  const handleReqSendEmail = useCallback(async () => {
    const id = selectedReqId;
    if (!id) return;
    const to = String(reqEmail.to || '').trim();
    const cc = String(reqEmail.cc || '').trim();
    const subject = String(reqEmail.subject || '').trim();
    const body = String(reqEmail.body || '').trim();
    const signatureHtml =
      '<br/><br/><img src="/assinatura_complaint.png" alt="assinatura" style="max-width:260px;height:auto;" />';
    const bodyWithSignature = body.includes('assinatura_complaint.png')
      ? body
      : `${body || ''}${signatureHtml}`;
    if (!to) {
      setToast({ open: true, type: 'warning', text: 'Informe o destinatário.' });
      return;
    }
    if (!subject) {
      setToast({ open: true, type: 'warning', text: 'Informe o assunto.' });
      return;
    }
    setReqSaving(true);
    try {
      const fd = new FormData();
      fd.append('to', to);
      fd.append('subject', subject);
      if (cc) fd.append('cc', cc);
      fd.append('body', bodyWithSignature || ' ');
      fd.append('body_type', 'HTML');
      (reqEmail.attachments || []).forEach((f) => fd.append('attachments', f));
      const resp = await sendMailMessage(fd);
      const data = resp?.data || resp || {};
      const messageId = data?.message_id || data?.messageId || data?.id || '';
      if (messageId) {
        await linkMailToProcess(messageId, {
          processoId: Number(id),
          attachBodyPdf: true,
          attachAttachments: true,
          moveToLinkedFolderId: '',
          note: 'E-mail enviado via Triagem de Requisição',
        });
      }
      setReqEmail((prev) => ({
        ...prev,
        to: '',
        cc: '',
        subject: '',
        body: '',
        attachments: [],
      }));
      setToast({
        open: true,
        type: 'success',
        text: messageId
          ? 'E-mail enviado e vinculado ao processo.'
          : 'E-mail enviado.',
      });
    } catch (err) {
      setToast({
        open: true,
        type: 'error',
        text:
          err?.response?.data?.error ||
          err?.response?.data?.detail ||
          err?.message ||
          'Falha ao enviar e-mail.',
      });
      notifyNetworkChange(err);
    } finally {
      setReqSaving(false);
    }
  }, [selectedReqId, reqEmail, notifyNetworkChange]);

  const handleReqEnviarAtivos = useCallback(async () => {
    if (!selectedReqId) return;
    if (
      !window.confirm(
        'Deseja tornar esta requisição um processo e enviar para Ativos (Distribuidora / Primeira reclamação da etapa - Aguardando retorno)?',
      )
    ) {
      return;
    }
    setReqSaving(true);
    try {
      const fd = new FormData();
      fd.append('etapa_atual', 'Distribuidora');
      fd.append('sub_etapa', 'Primeira reclamação da etapa - Aguardando retorno');
      fd.append('comentario', 'Processo aprovado na triagem de Requisi\u00E7\u00F5es.');
      await movimentarProcesso(selectedReqId, fd);
      try {
        await atualizarRequisicaoCompleta(selectedReqId, { processo_criado: 1, triagem: 0 });
      } catch {}
      await loadRequisicoes();
      setToast({ open: true, type: 'success', text: 'Processo enviado para Ativos.' });
      closeReqDrawer();
    } catch (err) {
      setToast({
        open: true,
        type: 'error',
        text: err?.response?.data?.error || err?.message || 'Falha ao mover processo.',
      });
      notifyNetworkChange(err);
    } finally {
      setReqSaving(false);
    }
  }, [selectedReqId, notifyNetworkChange, loadRequisicoes, closeReqDrawer]);

  const handleReqDeleteHistorico = useCallback(
    async (histId) => {
      if (!histId || !(await confirmAction('Excluir item do histórico?'))) return;
      setReqSaving(true);
      try {
        await deleteHistorico(histId);
        const hist = await getHistoricoById(selectedReqId);
        setReqHistorico(Array.isArray(hist) ? hist : []);
        setToast({ open: true, type: 'success', text: 'Histórico removido.' });
      } catch (err) {
        setToast({
          open: true,
          type: 'error',
          text: err?.message || 'Falha ao remover histórico.',
        });
        notifyNetworkChange(err);
      } finally {
        setReqSaving(false);
      }
    },
    [selectedReqId, notifyNetworkChange],
  );

  const openReqInfoEdit = useCallback(() => {
    const info = reqDetails || {};
    setReqInfoDraft({
      cliente: pickFirst(info, ['cliente', 'Cliente'], ''),
      uc: pickFirst(info, ['uc', 'UC', 'Uc'], ''),
      concessionaria: pickFirst(info, ['concessionaria', 'Concessionaria'], ''),
      valor_estimado: String(pickFirst(info, ['ressarcimento_estimado', 'valor_estimado'], '') || ''),
      link_fatura: pickFirst(info, ['link_fatura', 'linkFatura', 'link'], ''),
      descricao_irregularidade: pickFirst(info, ['descricao_irregularidade', 'descricaoIrregularidade'], ''),
      periodos_irregularidade: pickFirst(info, ['periodos_irregularidade', 'periodosIrregularidade'], ''),
      endereco_completo: pickFirst(info, ['endereco_completo', 'enderecoCompleto'], ''),
      id_tipo_irregularidade: pickFirst(
        info,
        ['id_tipo_irregularidade', 'idTipoIrregularidade', 'id_tipo', 'tipo_id'],
        '',
      ),
      id_subtipo_irregularidade: pickFirst(
        info,
        ['id_subtipo_irregularidade', 'idSubtipoIrregularidade', 'id_subtipo', 'subtipo_id'],
        '',
      ),
    });
    setReqInfoEditOpen(true);
  }, [reqDetails]);

  // Abre o modal de edição diretamente a partir de uma linha da tabela ou drawer.
  // Mescla row.header + dados assíncronos (snapshotHeaderData / requisicaoHeaderData)
  // para garantir que os campos apareçam preenchidos mesmo quando o drawer já está aberto.
  const openReqInfoEditFromRow = useCallback((row) => {
    const id = row?.pid || row?.id || row?.id_requisicao;
    if (!id) return;
    setSelectedReqId(Number(id));
    // Prioridade: dados do req carregado > snapshot > header da linha
    const h = {
      ...(row?.header || {}),
      ...(snapshotHeaderData || {}),
      ...(requisicaoHeaderData || {}),
    };
    setReqInfoDraft({
      cliente: pickFirst(h, ['cliente', 'Cliente'], ''),
      uc: pickFirst(h, ['uc', 'UC', 'Uc'], ''),
      concessionaria: pickFirst(h, ['concessionaria', 'Concessionaria'], ''),
      valor_estimado: String(pickFirst(h, ['ressarcimento_estimado', 'valor_estimado'], '') || ''),
      link_fatura: pickFirst(h, ['link_fatura', 'linkFatura', 'link'], ''),
      descricao_irregularidade: pickFirst(h, ['descricao_irregularidade', 'descricaoIrregularidade'], ''),
      periodos_irregularidade: pickFirst(h, ['periodos_irregularidade', 'periodosIrregularidade'], ''),
      endereco_completo: pickFirst(h, ['endereco_completo', 'enderecoCompleto'], ''),
      id_tipo_irregularidade: pickFirst(h, ['id_tipo_irregularidade', 'idTipoIrregularidade', 'id_tipo', 'tipo_id'], ''),
      id_subtipo_irregularidade: pickFirst(h, ['id_subtipo_irregularidade', 'idSubtipoIrregularidade', 'id_subtipo', 'subtipo_id'], ''),
    });
    setReqInfoEditOpen(true);
  }, [snapshotHeaderData, requisicaoHeaderData]);

  const saveReqInfoEdit = useCallback(async () => {
    if (!selectedReqId) return;
    setReqSaving(true);
    try {
      const payload = {
        cliente: reqInfoDraft.cliente ?? '',
        uc: reqInfoDraft.uc ?? '',
        concessionaria: reqInfoDraft.concessionaria ?? '',
        ressarcimento_estimado: reqInfoDraft.valor_estimado ?? '',
        link_fatura: reqInfoDraft.link_fatura ?? '',
        descricao_irregularidade: reqInfoDraft.descricao_irregularidade ?? '',
        endereco_completo: reqInfoDraft.endereco_completo ?? '',
        id_tipo_irregularidade: reqInfoDraft.id_tipo_irregularidade || null,
        id_subtipo_irregularidade: reqInfoDraft.id_subtipo_irregularidade || null,
      };
      const rawPeriodo = (reqInfoDraft.periodos_irregularidade ?? '').trim();
      if (rawPeriodo) {
        payload.periodos_irregularidade = rawPeriodo;
      }
      await atualizarRequisicaoCompleta(selectedReqId, payload);
      const det = await getRequisicaoById(selectedReqId);
      setReqDetails(det || reqDetails);
      await loadRequisicoes();
      setReqInfoEditOpen(false);
      setToast({ open: true, type: 'success', text: 'Informações atualizadas.' });
    } catch (err) {
      setToast({
        open: true,
        type: 'error',
        text: err?.response?.data?.error || err?.message || 'Falha ao atualizar informações.',
      });
      notifyNetworkChange(err);
    } finally {
      setReqSaving(false);
    }
  }, [selectedReqId, reqInfoDraft, reqDetails, loadRequisicoes, notifyNetworkChange]);

  const saveReqClassificacao = useCallback(async () => {
    if (!selectedReqId) return;
    setReqSaving(true);
    try {
      await atualizarRequisicaoCompleta(selectedReqId, {
        id_tipo_irregularidade: reqInfoDraft.id_tipo_irregularidade || null,
        id_subtipo_irregularidade: reqInfoDraft.id_subtipo_irregularidade || null,
      });
      const det = await getRequisicaoById(selectedReqId);
      setReqDetails(det || reqDetails);
      await loadRequisicoes();
      setToast({ open: true, type: 'success', text: 'Classificação atualizada.' });
    } catch (err) {
      setToast({
        open: true,
        type: 'error',
        text: err?.response?.data?.error || err?.message || 'Falha ao atualizar classificação.',
      });
      notifyNetworkChange(err);
    } finally {
      setReqSaving(false);
    }
  }, [selectedReqId, reqInfoDraft.id_tipo_irregularidade, reqInfoDraft.id_subtipo_irregularidade, reqDetails, loadRequisicoes, notifyNetworkChange]);

  const deleteProcessoAnexo = useCallback(
    async (pid, anexoId) => {
      if (!pid || !anexoId) return;
      if (!(await confirmAction('Excluir este anexo?'))) return;
      const stopQuick = scheduleQuickConfirm();
      try {
        setLoading(true);
        await api.delete(`/requisicoes/${pid}/anexos/${anexoId}`);
        setProcessoAnexos((prev) =>
          (prev || []).filter((a) => {
            const id = a?.id ?? a?.ID ?? a?.id_anexo ?? a?.idAnexo;
            return String(id) !== String(anexoId);
          }),
        );
        setToast({ open: true, type: 'success', text: 'Anexo removido.' });
      } catch (err) {
        setToast({ open: true, type: 'error', text: err?.message || 'Falha ao remover anexo.' });
        notifyNetworkChange(err);
      } finally {
        stopQuick();
        setLoading(false);
      }
    },
    [scheduleQuickConfirm, notifyNetworkChange],
  );

  useEffect(() => {
    if (!drawerOpen || drawerPane !== 'history' || !selectedPid) return;
    loadHistoryDetails(selectedPid, true);
  }, [drawerOpen, drawerPane, selectedPid, loadHistoryDetails]);

  useEffect(() => {
    if (!drawerOpen || drawerPane !== 'resume' || !selectedPid) return;
    loadSummary(selectedPid);
  }, [drawerOpen, drawerPane, selectedPid, loadSummary]);

  useEffect(() => {
    if (drawerPane !== 'resume') stopSummaryPoll();
  }, [drawerPane, stopSummaryPoll]);

  const requestResumo = useCallback(async () => {
    if (!selectedPid) return;
    setSummaryState((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      await refreshSummary(selectedPid);
      setSummaryState((prev) => ({ ...prev, status: 'pending', loading: true }));
      startSummaryPoll(selectedPid);
    } catch (err) {
      setSummaryState((prev) => ({
        ...prev,
        loading: false,
        error: err?.message || 'Falha ao solicitar resumo.',
      }));
    }
  }, [selectedPid, startSummaryPoll]);

  const handleExport = useCallback(async () => {
    const stopQuick = scheduleQuickConfirm();
    try {
      const params = {
        q: String(q || '').trim() || undefined,
        etapa: String(filtroEtapa || '').trim() || undefined,
        sub: String(filtroSubEtapa || '').trim() || undefined,
        ini: String(filtroDataIni || '').trim() || undefined,
        fim: String(filtroDataFim || '').trim() || undefined,
        coluna: String(kanbanFilter || '').trim() || undefined,
        ...Object.entries(exportFilters).reduce((acc, [key, value]) => {
          const v = String(value || '').trim();
          if (v !== '') acc[key] = v;
          return acc;
        }, {}),
      };
      const resp = await api.get('/admin/processos/export', { params, responseType: 'blob' });
      const blob = new Blob([resp.data], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `admin_planilha_export_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      URL.revokeObjectURL(url);
      setToast({ open: true, type: 'success', text: 'Exportação concluída.' });
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao exportar.' });
      notifyNetworkChange(err);
    } finally {
      stopQuick();
    }
  }, [
    q,
    filtroEtapa,
    filtroSubEtapa,
    filtroDataIni,
    filtroDataFim,
    kanbanFilter,
    exportFilters,
    scheduleQuickConfirm,
    notifyNetworkChange,
  ]);

  const handleDownloadTemplate = useCallback(() => {
    const header = [
      'processo_id',
      'uc',
      'cnpj',
      'concessionaria',
      'cliente',
      'coluna_kanban',
      'etapa',
      'sub_etapa',
      'credito_simples',
      'data_simples',
      'credito_dobro',
      'data_dobro',
      'repasse_simples',
      'repasse_dobro',
      'forma_devolucao',
      'valor_fluxo',
      'data_fluxo',
      'data_envio_financeiro',
      'numero_nf',
      'data_emissao',
      'data_vencimento',
      'data_pagamento',
      'valor_nf',
      'comentario',
    ];
    const csv = `${header.join(';')}\n`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'admin_planilha_modelo.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);
  }, []);

  const handleImport = useCallback(async () => {
    if (!importFile) {
      setToast({ open: true, type: 'warning', text: 'Selecione um arquivo CSV.' });
      return;
    }
    if (!(await confirmAction('Deseja importar esta planilha?'))) return;
    setImportLoading(true);
    const stopQuick = scheduleQuickConfirm();
    try {
      const form = new FormData();
      form.append('file', importFile);
      await api.post('/admin/processos/import', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setToast({ open: true, type: 'success', text: 'Importação concluída.' });
      setImportOpen(false);
      setImportFile(null);
      await load({ force: true });
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao importar.' });
      notifyNetworkChange(err);
    } finally {
      stopQuick();
      setImportLoading(false);
    }
  }, [importFile, load, scheduleQuickConfirm, notifyNetworkChange]);

  const submitResumoFeedback = useCallback(
    async (label) => {
      if (!selectedRow || !summaryState.text) return;
      const inputPayload = buildResumoInputPayload(selectedRow);
      if (!inputPayload) return;

      setSummaryFeedback({ sending: true, label, error: '' });
      const stopQuick = scheduleQuickConfirm();
      try {
        const hashBase = stableStringify({
          model: 'gpt-5-nano',
          prompt_version: RESUMO_PROMPT_VERSION,
          input_payload: inputPayload,
        });
        const inputHash = await sha256Hex(hashBase);

        await sendResumoFeedback({
          processo_id: selectedRow.pid,
          model: 'gpt-5-nano',
          prompt_version: RESUMO_PROMPT_VERSION,
          input_hash: inputHash,
          input_payload: inputPayload,
          output_text: summaryState.text,
          label,
        });

        setSummaryFeedback({ sending: false, label, error: '' });
        setToast({ open: true, type: 'success', text: 'Feedback registrado.' });
      } catch (err) {
        setSummaryFeedback({
          sending: false,
          label: '',
          error: err?.message || 'Falha ao salvar feedback.',
        });
        notifyNetworkChange(err);
      } finally {
        stopQuick();
      }
    },
    [selectedRow, summaryState.text, scheduleQuickConfirm, notifyNetworkChange],
  );

  const tabCounts = useMemo(() => {
    const counts = {};
    ETAPA_TABS.forEach((tab) => {
      counts[tab.id] = tableRows.filter((row) => row.category === tab.label).length;
    });
    counts.RELEVANTES = tableRows.filter((row) => isRelevante(row.header, row.pid, relevanciaMap)).length;
    return counts;
  }, [tableRows, relevanciaMap]);

  const totalTabs = useMemo(
    () => ETAPA_TABS.reduce((sum, tab) => sum + (tabCounts[tab.id] || 0), 0),
    [tabCounts],
  );

  useEffect(() => {
    const term = String(qDebounced || '').trim();
    if (term) return;
    if (!tableRows.length) return;
    if ((tabCounts[activeTab] || 0) > 0) return;
    const next = ETAPA_TABS.find((t) => (tabCounts[t.id] || 0) > 0);
    if (next && next.id !== activeTab) setActiveTab(next.id);
  }, [qDebounced, tableRows.length, tabCounts, activeTab]);

  const ativosResumo = useMemo(() => {
    const all = ativosMetricas.all || {};
    const month = ativosMetricas.month || {};
    const meses12 = ativosMetricas.meses12 || {};
    const ytd = ativosMetricas.ytd || {};
    const backlog = ativosMetricas.backlog || {};
    const prazos = ativosMetricas.prazos || {};

    const nonSuspensos = tableRows.filter((row) => row.category !== 'Suspensos');
    const totalProcessos = nonSuspensos.length;
    const ativosRows = tableRows.filter((row) => row.category === 'Ativos');
    const deferidosRows = tableRows.filter((row) => row.category === 'Deferidos');
    const valorAtivos = ativosRows.reduce((sum, row) => {
      const h = row.header || {};
      const raw = pickFirst(h, ['ressarcimento_estimado', 'valor_estimado', 'valor'], 0);
      const num = Number(toNumberValue(raw) || 0);
      return sum + (Number.isFinite(num) ? num : 0);
    }, 0);
    const valorDeferidos = deferidosRows.reduce((sum, row) => {
      const h = row.header || {};
      const cs = Number(toNumberValue(h?.credito_simples ?? 0) || 0);
      const cd = Number(toNumberValue(h?.credito_dobro ?? 0) || 0);
      return sum + cs + cd;
    }, 0);
    const valorTotalDb = Number(all.valor_em_carteira || 0);
    const totalElegiveisDb = Number(all.processos_em_carteira || 0);
    const valorTotal = valorTotalDb > 0 ? valorTotalDb : (valorAtivos + valorDeferidos);
    const totalElegiveis = totalElegiveisDb > 0 ? totalElegiveisDb : (ativosRows.length + deferidosRows.length);
    const ticketMedio = totalElegiveis > 0 ? valorTotal / totalElegiveis : 0;

    const backlogTotal = Number(backlog.total || 0);
    const backlogPct = totalProcessos > 0 ? (backlogTotal / totalProcessos) * 100 : 0;
    const prazosRows = Array.isArray(prazos.rows) ? prazos.rows : [];
    const vencidos = prazosRows.filter((p) => p?.atrasado).length;

    const relevantesCount = nonSuspensos.filter((row) =>
      isRelevante(row.header, row.pid, relevanciaMap),
    ).length;
    const relevantesPct = totalProcessos > 0 ? (relevantesCount / totalProcessos) * 100 : 0;

    const ressarcimentoMonth = Number(month.ressarcimento_envio_financeiro_total || 0);
    const ressarcimentoTotal = Number(ytd.ressarcimento_envio_financeiro_total || 0);
    const fluxo12 = findValorPorColuna(meses12, 'fluxo');
    const total12 = Number(meses12.valor_total_ressarcimento || 0);
    const fluxo12Pct = total12 > 0 ? (fluxo12 / total12) * 100 : 0;

    return {
      totalProcessos,
      valorTotal,
      ticketMedio,
      backlogTotal,
      backlogPct,
      vencidos,
      relevantesCount,
      relevantesPct,
      totalElegiveis,
      ressarcimentoMonth,
      ressarcimentoTotal,
      fluxo12,
      total12,
      fluxo12Pct,
    };
  }, [ativosMetricas, tableRows, relevanciaMap]);

  const ativosEtapasResumo = useMemo(() => {
    const rows = tableRows.filter((row) => row.category === 'Ativos');
    const total = rows.length || 1;
    const map = new Map();
    rows.forEach((row) => {
      const h = row.header || {};
      const etapaVal = pickFirst(h, ['etapa_atual', 'etapa', 'Etapa'], '').trim() || 'Sem etapa';
      map.set(etapaVal, (map.get(etapaVal) || 0) + 1);
    });
    const ordered = ['Distribuidora', 'Ouvidoria', 'ANEEL', 'SMA'];
    return ordered.map((label) => {
      const count = map.get(label) || 0;
      return {
        label,
        count,
        percent: (count / total) * 100,
      };
    });
  }, [tableRows]);

  const filteredRowsAll = useMemo(() => {
    const term = norm(qDebounced);
    const hasSearch = !!term;

    const base = hasSearch
      ? tableRows
      : !activeTab
      ? tableRows
      : activeTab === 'RELEVANTES'
      ? tableRows.filter((row) => isRelevante(row.header, row.pid, relevanciaMap))
      : (() => {
          const selectedTab = ETAPA_TABS.find((t) => t.id === activeTab);
          if (!selectedTab) return tableRows;
          return tableRows.filter((row) => row.category === selectedTab.label);
        })();

    const start = filtroDataIni ? new Date(`${filtroDataIni}T00:00:00`) : null;
    const end = filtroDataFim ? new Date(`${filtroDataFim}T23:59:59`) : null;
    const valorMin = filtroValorMin !== '' ? Number(filtroValorMin) : null;
    const valorMax = filtroValorMax !== '' ? Number(filtroValorMax) : null;

    const filtered = base.filter((row) => {
      const h = row.header || {};
      const pidStr = String(row.pid || '');

      const etapaVal = pickFirst(h, ['etapa_atual', 'etapa', 'Etapa'], '');
      const subVal = pickFirst(h, ['sub_etapa', 'SubEtapa'], '');
      const concVal = pickFirst(h, ['concessionaria', 'Concessionaria'], '');
      const clienteVal = pickFirst(h, ['cliente', 'Cliente'], '');
      const ucVal = pickFirst(h, ['uc', 'UC', 'Uc'], '');

      let searchOk = true;

      if (term) {
        const hay = [
          pidStr,
          etapaVal,
          subVal,
          concVal,
          clienteVal,
          ucVal,
          row.category,
          pickFirst(h, ['status', 'status_atual', 'status_novo'], ''),
        ]
          .map(norm)
          .join(' ');

        searchOk = hay.includes(term);

        if (!searchOk && historyMatches.has(pidStr)) searchOk = true;

        if (!searchOk) {
          const hist = Array.isArray(row.history) ? row.history : [];
          const hasComment = hist.some((it) => {
            const c = pickFirst(it, ['hist_comentario', 'comentario'], '');
            return norm(c).includes(term);
          });
          if (hasComment) searchOk = true;
        }
      }

      if (!searchOk) return false;

      if (filtroCliente && !norm(clienteVal).includes(norm(filtroCliente))) return false;
      if (filtroUC && !norm(ucVal).includes(norm(filtroUC))) return false;
      if (filtroId && !pidStr.includes(String(filtroId))) return false;
      if (filtroConcessionaria && !norm(concVal).includes(norm(filtroConcessionaria))) return false;
      if (filtroEtapa && !norm(etapaVal).includes(norm(filtroEtapa))) return false;
      if (filtroSubEtapa && !norm(subVal).includes(norm(filtroSubEtapa))) return false;

      if (kanbanFilter) {
        const selected = normalizeKanbanName(kanbanFilter) || String(kanbanFilter).trim();
        const rowCol = row.category || normalizeKanbanName(h.nome_coluna) || '';
        if (normalizeKanbanName(rowCol) !== normalizeKanbanName(selected) && rowCol !== selected) return false;
      }

      if (filtroSuspenso) {
        const isSusp = String(subVal || '').toLowerCase().includes('suspenso');
        if (!isSusp) return false;
      }

      if (filtroRelevancia !== 'todos') {
        const rel = isRelevante(h, row.pid, relevanciaMap);
        if (filtroRelevancia === 'relevante' && !rel) return false;
        if (filtroRelevancia === 'no_relevante' && rel) return false;
      }

      const valorRaw =
        h.valor_estimado ??
        h.ressarcimento_estimado ??
        h.valor ??
        h.valor_total ??
        h.valor_nf ??
        null;

      const valorNum =
        valorRaw !== null && valorRaw !== undefined
          ? Number(String(valorRaw).replace(',', '.'))
          : null;

      if (valorMin !== null && (valorNum == null || valorNum < valorMin)) return false;
      if (valorMax !== null && (valorNum == null || valorNum > valorMax)) return false;

      if (start || end) {
        const ts = rowLastTs(row);
        if (!ts) return false;
        const d = new Date(ts);
        if (start && d < start) return false;
        if (end && d > end) return false;
      }

      return true;
    });

    const sorted = [...filtered].sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      if (sortField === 'id') return dir * (Number(a.pid || 0) - Number(b.pid || 0));
      if (sortField === 'valor') {
        const va = Number(a.header?.valor_estimado ?? a.header?.ressarcimento_estimado ?? a.header?.valor ?? 0);
        const vb = Number(b.header?.valor_estimado ?? b.header?.ressarcimento_estimado ?? b.header?.valor ?? 0);
        return dir * (va - vb);
      }
      return dir * (rowLastTs(a) - rowLastTs(b));
    });

    return sorted;
  }, [
    tableRows,
    activeTab,
    qDebounced,
    historyMatches,
    relevanciaMap,
    filtroDataIni,
    filtroDataFim,
    filtroEtapa,
    filtroSubEtapa,
    filtroConcessionaria,
    filtroSuspenso,
    filtroCliente,
    filtroUC,
    filtroId,
    filtroRelevancia,
    filtroValorMin,
    filtroValorMax,
    sortField,
    sortDir,
  ]);

  const shouldChunk = useMemo(() => {
    const term = String(qDebounced || '').trim();
    return !!term || showAllRows || filteredRowsAll.length > 250;
  }, [qDebounced, showAllRows, filteredRowsAll.length]);

  const limitedBaseRows = useMemo(() => filteredRowsAll, [filteredRowsAll]);

  const filteredRows = useChunkedRender(limitedBaseRows, {
    initial: limitedBaseRows.length <= 12 ? 12 : 140,
    step: 180,
    enabled: shouldChunk && limitedBaseRows.length > 160,
  });

  useEffect(() => {
    const term = String(qDebounced || '').trim();
    if (!term || !filteredRowsAll.length) return;
    const target = filteredRowsAll[0]?.category || '';
    if (!target) return;
    const tab = ETAPA_TABS.find((t) => t.label === target);
    if (tab && activeTab !== tab.id) setActiveTab(tab.id);
  }, [qDebounced, filteredRowsAll, activeTab]);

  const searchResultsSummary = useMemo(() => {
    const term = String(qDebounced || '').trim();
    if (!term) return '';
    const counts = {};
    filteredRowsAll.forEach((row) => {
      const label = row.category || 'Sem aba';
      counts[label] = (counts[label] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([label, count]) => `${label} (${count})`)
      .join(', ');
  }, [qDebounced, filteredRowsAll]);

  const searchResultsCount = useMemo(() => {
    const term = String(qDebounced || '').trim();
    if (!term) return 0;
    if (historyMatches.size) return historyMatches.size;
    return filteredRowsAll.length;
  }, [qDebounced, historyMatches, filteredRowsAll]);

  const historyMatchesSummary = useMemo(() => {
    if (!historyMatches || historyMatches.size === 0) return '';
    const counts = {};
    tableRows.forEach((row) => {
      const pidStr = String(row.pid || '');
      if (!historyMatches.has(pidStr)) return;
      const label = row.category || 'Sem aba';
      counts[label] = (counts[label] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([label, count]) => `${label} (${count})`)
      .join(', ');
  }, [historyMatches, tableRows]);

  const handleAlertOpenProcess = useCallback(() => {
    const pid = alertModal.processoId;
    if (!pid) {
      setAlertModal({ open: false, mensagem: '', processoId: null });
      return;
    }
    const row = tableRows.find((r) => Number(r.pid) === Number(pid));
    if (row) {
      const tab = ETAPA_TABS.find((t) => t.label === row.category);
      if (tab) setActiveTab(tab.id);
      openDrawer(row);
    } else {
      setQ(String(pid));
      requestRealtimeRefresh();
    }
    setAlertModal({ open: false, mensagem: '', processoId: null });
  }, [alertModal.processoId, tableRows, openDrawer, requestRealtimeRefresh]);

  const handleLoadMoreActive = useCallback(async () => {
    if (fullLoadEnabled) return;

    const tab = ETAPA_TABS.find((t) => t.id === activeTab);
    const label = tab?.label || '';
    if (!label) return;

    const nextLimit = (columnLimits[label] || INITIAL_COLUMN_LIMIT) + INITIAL_COLUMN_LIMIT;
    setColumnLimits((prev) => ({ ...(prev || {}), [label]: nextLimit }));

    setLoading(true);
    try {
      const data = await getProcessosKanbanFast({ limit: nextLimit, coluna: label });
      const built = buildRowsFromKanbanFast(data);

      setRows((prev) => mergeRowsByColumn(prev, built.rows, label));
      setKanbanMap((prev) => ({ ...(prev || {}), ...built.map }));
      setRelevanciaMap((prev) => ({ ...(prev || {}), ...built.relMap }));
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao carregar mais.' });
    } finally {
      setLoading(false);
    }
  }, [activeTab, columnLimits, fullLoadEnabled]);

  const handleLoadAllProcessos = useCallback(async () => {
    await loadAll({ full: true, force: true });
  }, [loadAll]);

  const openEditHistory = useCallback(async () => {
    if (!selectedPid) return;
    setHistoryDetailLoading(true);
    try {
      const list = await getHistoricoById(selectedPid);
      setHistoryByPid((prev) => ({ ...(prev || {}), [selectedPid]: list || [] }));

      const parse = (h) => {
        const raw = pickFirst(h, ['hist_data', 'data_movimentacao', 'data', 'created_at'], '');
        const ts = new Date(String(raw).replace(' ', 'T')).getTime();
        return Number.isNaN(ts) ? 0 : ts;
      };

      const filtered = (list || []).filter((h) => {
        const raw = pickFirst(h, ['hist_data', 'data_movimentacao', 'data', 'created_at'], '');
        const hasDate = !!raw && !String(raw).startsWith('0001-01-01');

        const etapaVal = pickFirst(h, ['etapa_nova', 'etapa', 'Etapa'], '');
        const subVal = getSubEtapaFromStatus(h);
        const comentarioVal = pickFirst(h, ['comentario', 'hist_comentario'], '');

        const hasComentario = !!String(comentarioVal || '').trim();
        const hasSub = !!String(subVal || '').trim();
        const hasEtapa = !!String(etapaVal || '').trim();

        if (hasDate) return true;
        return hasComentario || hasSub || hasEtapa;
      });

      filtered.sort((a, b) => parse(b) - parse(a));

      const mapped = filtered.map((it) => ({
        id_historico: it.id_historico ?? it.historico_id ?? it.hist_id ?? it.id ?? null,
        data: pickFirst(it, ['hist_data', 'data', 'data_movimentacao', 'created_at'], ''),
        etapa_nova: pickFirst(it, ['etapa_nova', 'etapa', 'Etapa'], ''),
        sub_etapa: (() => {
          const direct = pickFirst(it, ['sub_etapa_nova', 'sub_etapa', 'SubEtapa'], '');
          if (String(direct || '').trim()) return direct;
          return getSubEtapaFromStatus(it);
        })(),
        comentario: pickFirst(it, ['comentario', 'hist_comentario'], ''),
      }));

      setHistoryDraft(mapped);
      setHistoryDeletes([]);
      setHistoryEditOpen(true);
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao carregar histórico.' });
    } finally {
      setHistoryDetailLoading(false);
    }
  }, [selectedPid]);

  const addHistoryRow = useCallback(() => {
    setHistoryDraft((prev) => [
      ...(prev || []),
      {
        id_historico: null,
        data: nowDb(),
        etapa_nova: pickFirst(selectedRow?.header, ['etapa', 'etapa_atual'], ''),
        sub_etapa: pickFirst(selectedRow?.header, ['sub_etapa'], ''),
        comentario: '',
      },
    ]);
  }, [selectedRow]);

  const saveHistory = useCallback(async () => {
    if (!selectedPid) return;
      if (!(await confirmAction('Deseja salvar as alterações do Histórico?'))) return;
    const stopQuick = scheduleQuickConfirm();
    const stopSuccess = scheduleSuccessModal('Histórico salvo.');
    try {
      setLoading(true);
      await saveProcessoFull({
        processo_id: selectedPid,
        historico: (historyDraft || [])
          .filter((x) => String(x.data || '').trim())
          .map((x) => ({
            id_historico: x.id_historico || undefined,
            data: x.data,
            comentario: x.comentario || '',
            etapa_nova: x.etapa_nova || null,
            sub_etapa: x.sub_etapa || null,
          })),
        historico_delete_ids: historyDeletes || [],
      });

      setToast({ open: true, type: 'success', text: 'Histórico salvo.' });
      setHistoryEditOpen(false);
      await load({ force: true });
      await loadHistoryDetails(selectedPid, true);
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao salvar histórico.' });
      notifyNetworkChange(err);
      stopSuccess();
      setSaveModal({ open: false, mensagem: '' });
    } finally {
      stopQuick();
      setLoading(false);
    }
  }, [selectedPid, historyDraft, historyDeletes, load, loadHistoryDetails, scheduleQuickConfirm, notifyNetworkChange, scheduleSuccessModal]);

  useEffect(() => {
    const handleOffline = () => {
      setToast({ open: true, type: 'warning', text: 'Conexão perdida. Recarregue a página se houver erro.' });
    };
    window.addEventListener('offline', handleOffline);
    return () => window.removeEventListener('offline', handleOffline);
  }, []);

  const openMoveModal = useCallback((pid, header) => {
    const cached = mvByPid[pid] || {};
    const etapaAtual = header?.etapa_atual || header?.etapa || '';

    const colunaAtual =
      KANBAN_COLUNAS.find((col) => MAPA_COLUNAS_PARA_ETAPAS[col]?.toLowerCase() === etapaAtual.toLowerCase()) ||
      cached.etapa ||
      header?.nome_coluna ||
      '';

    let subAtual = (cached.sub || header?.sub_etapa || '').trim();

    setMoveTarget({ pid, header });
    setMoveColuna(colunaAtual);

    const etapas = KANBAN_ETAPAS[colunaAtual] || [];
    const etapaDefault = MAPA_COLUNAS_PARA_ETAPAS[colunaAtual] || etapas[0] || etapaAtual;

    setMoveEtapa(cached.etapa || etapaDefault);
    setMoveColunaAtual(colunaAtual);
    setMoveEtapaAtual(etapaAtual);

    if (!String(colunaAtual || '').toLowerCase().includes('suspens') && subAtual.toLowerCase() === 'suspenso') {
      subAtual = '';
    }
    setMoveSub(subAtual);

    setMoveComentario((cached.comentario || '').trim());
    setMoveAdvanceOpen(false);
    setMoveCanais(DEFAULT_CANAIS);
    setMoveArquivo(null);
  }, [mvByPid]);

  const updateRelevancia = useCallback(async (checked) => {
    if (!selectedRow) return;
    const pid = selectedRow.pid;
    const etapaAtual = pickFirst(selectedRow.header, ['etapa_atual', 'etapa', 'Etapa'], '');
    const stopQuick = scheduleQuickConfirm();

    try {
      setLoading(true);

      const fd = new FormData();
      if (etapaAtual) fd.append('etapa_atual', etapaAtual);
      fd.append('relevancia', checked ? '1' : '0');
      fd.append('comentario', checked ? 'Processo sinalizado como relevante' : 'Processo marcado como não relevante');

      await movimentarProcesso(pid, fd);

      setHeaderFlags((prev) => ({ ...prev, relevancia: checked }));
      setToast({ open: true, type: 'success', text: 'Relevância atualizada.' });

      await load({ force: true });
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao atualizar relevância.' });
      notifyNetworkChange(err);
    } finally {
      stopQuick();
      setLoading(false);
    }
  }, [selectedRow, load, scheduleQuickConfirm, notifyNetworkChange]);

  const updateSuspenso = useCallback(async (checked) => {
    if (!selectedRow) return;
    const pid = selectedRow.pid;
    const stopQuick = scheduleQuickConfirm();

    try {
      setLoading(true);

      const { suspenderProcesso, retomarProcesso } = await import('../services/requisicaoService');
      if (checked) {
        if (!(await confirmAction('Deseja suspender este processo?'))) return;
        await suspenderProcesso(pid, 'Processo suspenso');
      } else {
        if (!(await confirmAction('Deseja retomar este processo?'))) return;
        await retomarProcesso(pid, 'Suspensão removida');
      }

      setHeaderFlags((prev) => ({ ...prev, suspenso: checked }));
      setToast({ open: true, type: 'success', text: 'Suspensão atualizada.' });

      await load({ force: true });
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao atualizar suspensão.' });
      notifyNetworkChange(err);
    } finally {
      stopQuick();
      setLoading(false);
    }
  }, [selectedRow, load, scheduleQuickConfirm, notifyNetworkChange]);

  const handleSaveProcesso = useCallback(async (pid, header, section = 'deferimento') => {
    const label =
      section === 'fluxo'
        ? 'Fluxo de Ressarcimento'
        : section === 'faturamento'
        ? 'Faturamento'
        : 'Deferimento';
    const detail = detailsByPid?.[pid] || {};

    const base =
      pid === selectedPid
        ? getDeferimentoDefaults(header, snapshotHeaderData, requisicaoHeaderData)
        : getDeferimentoDefaults(header, null, null);

    const cs = detail.cs ?? base.cs ?? '';
    const ds = detail.ds ?? base.ds ?? '';
    const cd = detail.cd ?? base.cd ?? '';
    const dd = detail.dd ?? base.dd ?? '';
    const rs = detail.rs ?? base.rs ?? '';
    const rd = detail.rd ?? base.rd ?? '';

    const dsNormalized = toDateInput(ds) || ds;
    const ddNormalized = toDateInput(dd) || dd;

    const csNum = toNumberValue(cs);
    const cdNum = toNumberValue(cd);
    const rsNum = toNumberValue(rs);
    const rdNum = toNumberValue(rd);

    const re = detail.re ?? header.ressarcimento_estimado ?? header.valor_estimado ?? '';
    const reParsed = toNumberValue(re);

    const fluxoItensRaw = Array.isArray(detail.fluxo_itens)
      ? detail.fluxo_itens
      : [{
          forma_devolucao: normalizeFormaDevolucao(detail.forma ?? header.forma_devolucao ?? ''),
          valor: detail.valor_fluxo ?? header.valor_fluxo ?? '',
          simples: detail.simples ?? header.fluxo_simples ?? 0,
          dobro: detail.dobro ?? header.fluxo_dobro ?? 0,
          simples_dobro: detail.simples_dobro ?? header.fluxo_simples_dobro ?? 0,
          data_devolucao: detail.data_fluxo ?? header.data_fluxo ?? '',
          data_envio_financeiro: detail.data_envio_financeiro ?? header.data_envio_financeiro ?? '',
        }];

    const fluxoItens = fluxoItensRaw
      .map((it) => ({
        forma_devolucao: normalizeFormaDevolucao(it.forma_devolucao ?? it.forma ?? ''),
        valor: toNumberValue(it.valor ?? it.valor_fluxo ?? ''),
        simples: Number(it.simples ?? it.fluxo_simples ?? 0),
        dobro: Number(it.dobro ?? it.fluxo_dobro ?? 0),
        simples_dobro: Number(it.simples_dobro ?? it.fluxo_simples_dobro ?? 0),
        data_devolucao: it.data_devolucao ?? it.data_fluxo ?? '',
        data_envio_financeiro: it.data_envio_financeiro ?? '',
      }))
      .filter((it) =>
        it.forma_devolucao ||
        it.valor ||
        it.simples ||
        it.dobro ||
        it.simples_dobro ||
        it.data_devolucao ||
        it.data_envio_financeiro
      );

    const faturamentoItensRaw = Array.isArray(detail.faturamento_itens)
      ? detail.faturamento_itens
      : [{
          numero_nf: detail.numero_nf ?? header.numero_nf ?? '',
          data_emissao: detail.data_emissao ?? header.data_emissao ?? '',
          data_vencimento: detail.data_vencimento ?? header.data_vencimento ?? '',
          data_pagamento: detail.data_pagamento ?? header.data_pagamento ?? '',
          valor: detail.valor_nf ?? header.valor_nf ?? '',
        }];

    const faturamentoItens = faturamentoItensRaw
      .map((it) => ({
        numero_nf: it.numero_nf ?? '',
        data_emissao: it.data_emissao ?? '',
        data_vencimento: it.data_vencimento ?? '',
        data_pagamento: it.data_pagamento ?? '',
        valor: toNumberValue(it.valor ?? ''),
      }))
      .filter((it) => it.numero_nf || it.data_emissao || it.data_vencimento || it.data_pagamento || it.valor);

    const payload = { processo_id: pid };
    const historicoMsgs = [];

    const addMsg = (label, prevVal, nextVal) => {
      const p = prevVal == null ? '' : String(prevVal).trim();
      const n = nextVal == null ? '' : String(nextVal).trim();
      if (!p && !n) return;
      if (!p && n) historicoMsgs.push(`${label} preenchido`);
      else if (p && !n) historicoMsgs.push(`${label} removido`);
      else if (p !== n) historicoMsgs.push(`${label} alterado`);
    };

    const addMsgNum = (label, prevVal, nextVal) => {
      const pRaw = toNumberValue(prevVal);
      const nRaw = toNumberValue(nextVal);
      const p = pRaw === '' || pRaw == null ? null : Number(pRaw);
      const n = nRaw === '' || nRaw == null ? null : Number(nRaw);
      if (p == null && n == null) return;
      if (p == null && n != null) historicoMsgs.push(`${label} preenchido`);
      else if (p != null && n == null) historicoMsgs.push(`${label} removido`);
      else if (p !== n) historicoMsgs.push(`${label} alterado`);
    };

    const hasDefer =
      String(dsNormalized || '').trim() !== '' ||
      String(ddNormalized || '').trim() !== '' ||
      String(csNum || '').trim() !== '' ||
      String(cdNum || '').trim() !== '' ||
      String(rsNum || '').trim() !== '' ||
      String(rdNum || '').trim() !== '';
    const hasFluxo = fluxoItens.length > 0;
    const hasFat = faturamentoItens.length > 0;

    let targetCol = '';
    if (hasFat) targetCol = 'Faturamento';
    else if (hasFluxo) targetCol = 'Fluxo de Ressarcimento';
    else if (hasDefer) targetCol = 'Deferidos';

    const currentColRaw =
      header?.nome_coluna ||
      header?.coluna_kanban ||
      header?.etapa_atual ||
      header?.etapa ||
      '';
    const currentCol = normalizeKanbanName(currentColRaw);
    const ordem = {
      Ativos: 1,
      Deferidos: 2,
      'Fluxo de Ressarcimento': 3,
      Faturamento: 4,
      Concluídos: 5,
      Indeferidos: 6,
      Suspensos: 99,
    };
    const targetOrder = targetCol ? ordem[targetCol] || 0 : 0;
    const currentOrder = currentCol ? ordem[currentCol] || 0 : 0;

    if (targetOrder > currentOrder) {
      if (
        !(await confirmAction(
          `Detectamos dados de ${targetCol}. Ao salvar, o processo irá para ${targetCol}. Confirmar?`,
        ))
      )
        return;
    } else {
      if (!(await confirmAction(`Deseja salvar as alterações de ${label}?`))) return;
    }

    if (section === 'deferimento') {
      addMsgNum('Crédito simples', base.cs, csNum);
      addMsg('Data simples', toDateInput(base.ds) || base.ds, dsNormalized);
      addMsgNum('Crédito dobro', base.cd, cdNum);
      addMsg('Data dobro', toDateInput(base.dd) || base.dd, ddNormalized);
      addMsgNum('Repasse simples', base.rs, rsNum);
      addMsgNum('Repasse dobro', base.rd, rdNum);
      addMsgNum('Ressarcimento estimado', header?.ressarcimento_estimado ?? header?.valor_estimado, reParsed);
    }

    if (section === 'deferimento' && reParsed !== '' && reParsed != null && !Number.isNaN(Number(reParsed))) {
      payload.ressarcimento_estimado = Number(reParsed);
    }

    if (section === 'fluxo') {
      const fluxoBase = fluxoItensRaw[0] || {};
      addMsg('Forma de devolução', header?.forma_devolucao, fluxoBase.forma_devolucao ?? fluxoBase.forma);
      addMsgNum('Valor de devolução', header?.valor_fluxo, fluxoBase.valor ?? fluxoBase.valor_fluxo);
      addMsg('Data de devolução', header?.data_fluxo, fluxoBase.data_devolucao ?? fluxoBase.data_fluxo);
      addMsg('Envio ao financeiro', header?.data_envio_financeiro, fluxoBase.data_envio_financeiro);
    }

    if (section === 'faturamento') {
      const fatBase = faturamentoItensRaw[0] || {};
      addMsg('Número NF', header?.numero_nf, fatBase.numero_nf);
      addMsg('Data Emissão', header?.data_emissao, fatBase.data_emissao);
      addMsg('Data vencimento', header?.data_vencimento, fatBase.data_vencimento);
      addMsg('Data pagamento', header?.data_pagamento, fatBase.data_pagamento);
      addMsgNum('Valor NF', header?.valor_nf, fatBase.valor);
    }

    // Instância do deferimento (FK DM_INSTANCIA_DEFERIMENTO).
    // Convertemos pra Number; '' / 0 / NaN mandam null pro backend (limpa o
    // campo). Valores 1-4 (Distribuidora/Ouvidoria/ANEEL/SMA) vão como int.
    const idefRaw = detail.idef;
    const idefNum = idefRaw === '' || idefRaw == null ? null : Number(idefRaw);
    const idefValido = Number.isFinite(idefNum) && idefNum > 0 ? idefNum : null;

    const deferimentoHas =
      (ds && ds !== '') ||
      (dd && dd !== '') ||
      (csNum !== '' && Number(csNum) !== 0) ||
      (cdNum !== '' && Number(cdNum) !== 0) ||
      (rsNum !== '' && Number(rsNum) !== 0) ||
      (rdNum !== '' && Number(rdNum) !== 0) ||
      idefValido != null;

    if (section === 'deferimento' && deferimentoHas) {
      payload.deferimento = {
        data_procedencia: dsNormalized || '',
        credito_simples: csNum === '' ? undefined : csNum,
        credito_dobro: cdNum === '' ? undefined : cdNum,
        data_credito_dobro: ddNormalized || '',
        repasse_simples: rsNum === '' ? undefined : rsNum,
        repasse_dobro: rdNum === '' ? undefined : rdNum,
        instancia_deferimento: idefValido,
      };
    }

    if (historicoMsgs.length) {
      payload.historico = historicoMsgs.map((msg) => ({
        data: nowDb(),
        comentario: msg,
        etapa_nova: header?.etapa ?? header?.etapa_atual ?? null,
        sub_etapa: header?.sub_etapa ?? null,
      }));
    }

    if (section === 'fluxo') {
      payload.fluxo_ressarcimento = { itens: fluxoItens };
    }
    if (section === 'faturamento') {
      payload.faturamento = { itens: faturamentoItens };
    }

    const stopQuick = scheduleQuickConfirm();
    const stopSuccess = scheduleSuccessModal(`Dados salvos para o processo #${pid}.`);
    try {
      await saveProcessoFull(payload);
      setToast({ open: true, type: 'success', text: `Dados salvos para ${pid}.` });

      const h = header || {};
      const deferFlag = !!(
        String(dsNormalized || '').trim() ||
        String(ddNormalized || '').trim() ||
        String(detail.ds || detail.data_simples || h.data_simples || h.data_procedencia || '').trim() ||
        String(detail.dd || detail.data_dobro || h.data_dobro || h.data_credito_dobro || '').trim() ||
        String(payload?.deferimento?.data_procedencia || '').trim() ||
        String(payload?.deferimento?.data_credito_dobro || '').trim()
      );
      const fluxoFlag = !!(
        String(detail.data_envio_financeiro || h.data_envio_financeiro || '').trim() ||
        String(detail.valor_fluxo || h.valor_fluxo || '').trim()
      );
      const fatFlag = !!(
        String(detail.numero_nf || h.numero_nf || '').trim() ||
        String(detail.data_emissao || h.data_emissao || '').trim() ||
        String(detail.data_vencimento || h.data_vencimento || '').trim() ||
        String(detail.data_pagamento || h.data_pagamento || '').trim() ||
        String(detail.valor_nf || h.valor_nf || '').trim()
      );

      const currentCol = normalizeKanbanName(h?.nome_coluna || h?.etapa_atual || '');
      let targetCol = '';
      if (fatFlag) targetCol = 'Faturamento';
      else if (fluxoFlag) targetCol = 'Fluxo de Ressarcimento';
      else if (deferFlag) targetCol = 'Deferidos';

      if (targetCol && currentCol !== targetCol) {
        const etapaDestino = MAPA_COLUNAS_PARA_ETAPAS[targetCol] || targetCol;
        const fdMove = new FormData();
        fdMove.append('etapa_atual', etapaDestino);
        if (h?.sub_etapa) {
          fdMove.append('sub_etapa', h.sub_etapa);
        } else if (targetCol === 'Deferidos') {
          fdMove.append('sub_etapa', 'Primeira reclamação da etapa - Em elaboração');
        }
        await movimentarProcesso(pid, fdMove);
      }

      await load({ force: true });
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao salvar processo.' });
      notifyNetworkChange(err);
      stopSuccess();
      setSaveModal({ open: false, mensagem: '' });
    } finally {
      stopQuick();
    }
  }, [detailsByPid, load, requisicaoHeaderData, selectedPid, snapshotHeaderData, scheduleQuickConfirm, notifyNetworkChange, scheduleSuccessModal]);

  const TabBar = useCallback(() => (
    <div className="flex flex-wrap gap-2 justify-center">
      {ETAPA_TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        const count = tabCounts[tab.id] || 0;
        const pct = totalTabs > 0 ? Math.round((count / totalTabs) * 100) : 0;
        return (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`min-w-[150px] flex items-center justify-between gap-3 px-3 py-2 rounded border-2 text-sm font-semibold transition-colors ${
              isActive
                ? 'text-white border-[var(--accent)]'
                : 'text-[var(--fg)] border-[var(--panel-border)] hover:bg-[var(--hover)]'
            }`}
            style={{
              background: isActive ? 'var(--accent)' : 'var(--panel)',
              boxShadow: isActive
                ? 'inset 0 1px 0 rgba(255,255,255,0.25), 0 2px 6px rgba(0,0,0,0.12)'
                : 'inset 0 1px 0 rgba(255,255,255,0.8)',
            }}
          >
            <div className="text-left">
              <div className="truncate">{tab.label}</div>
              <div className={`text-[11px] ${isActive ? 'text-white/80' : 'text-[var(--fg-muted)]'}`}>
                {pct}%
              </div>
            </div>
            <span
              className={`px-2 py-0.5 rounded text-xs font-bold ${
                isActive ? 'bg-white/20 text-white' : 'bg-[var(--muted)] text-[var(--fg-muted)]'
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}

      {(() => {
        const isActive = activeTab === 'RELEVANTES';
        const count = tabCounts.RELEVANTES || 0;
        const pct = totalTabs > 0 ? Math.round((count / totalTabs) * 100) : 0;
        return (
          <button
            key="tab-relevantes"
            onClick={() => setActiveTab('RELEVANTES')}
            className={`min-w-[150px] flex items-center justify-between gap-3 px-3 py-2 rounded border-2 text-sm font-semibold transition-colors ${
              isActive
                ? 'text-white border-[var(--accent)]'
                : 'text-[var(--fg)] border-[var(--panel-border)] hover:bg-[var(--hover)]'
            }`}
            style={{
              background: isActive ? 'var(--accent)' : 'var(--panel)',
              boxShadow: isActive
                ? 'inset 0 1px 0 rgba(255,255,255,0.25), 0 2px 6px rgba(0,0,0,0.12)'
                : 'inset 0 1px 0 rgba(255,255,255,0.8)',
            }}
          >
            <div className="text-left">
              <div className="truncate">Relevantes</div>
              <div className={`text-[11px] ${isActive ? 'text-white/80' : 'text-[var(--fg-muted)]'}`}>
                {pct}%
              </div>
            </div>
            <span
              className={`px-2 py-0.5 rounded text-xs font-bold ${
                isActive ? 'bg-white/20 text-white' : 'bg-[var(--muted)] text-[var(--fg-muted)]'
              }`}
            >
              {count}
            </span>
          </button>
        );
      })()}
    </div>
  ), [activeTab, tabCounts, totalTabs]);

  const requestPaneMove = useCallback(() => {
    if (!selectedRow) return;
    openMoveModal(selectedRow.pid, selectedRow.header);
  }, [selectedRow, openMoveModal]);

  const rightPane = useMemo(() => {
    if (!selectedRow) return null;

    if (drawerPane === 'move') {
      return (
        <MovePane
          pid={selectedRow.pid}
          etapaSubMap={etapaSubMap}
          moveTarget={moveTarget}
          moveColuna={moveColuna}
          setMoveColuna={setMoveColuna}
          setMoveColunaAtual={setMoveColunaAtual}
          setMoveEtapaAtual={setMoveEtapaAtual}
          moveEtapa={moveEtapa}
          setMoveEtapa={setMoveEtapa}
          moveSub={moveSub}
          setMoveSub={setMoveSub}
          moveComentario={moveComentario}
          setMoveComentario={setMoveComentario}
          setMoveAdvanceOpen={setMoveAdvanceOpen}
          moveCanais={moveCanais}
          setMoveCanais={setMoveCanais}
          moveArquivo={moveArquivo}
          setMoveArquivo={setMoveArquivo}
          setToast={setToast}
          setLoading={setLoading}
          load={load}
          scheduleQuickConfirm={scheduleQuickConfirm}
          notifyNetworkChange={notifyNetworkChange}
          scheduleSuccessModal={scheduleSuccessModal}
          onAfterMove={async () => {
            if (selectedRow?.pid) await loadHistoryDetails(selectedRow.pid, true);
          }}
          onClosePane={() => setDrawerPane('')}
        />
      );
    }

    if (drawerPane === 'resume') {
      const canSend = !!selectedRow?.pid && !summaryState.loading && !summaryFeedback.sending;

      return (
        <div className="h-full flex flex-col">
          <div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b panel-border">
            <div className="min-w-0">
              <div className="font-semibold">Resumo</div>
              <div className="text-xs opacity-70 truncate">
                Processo #{selectedRow.pid} - {pickFirst(selectedRow?.header || {}, ['cliente', 'Cliente'], '')}
              </div>
            </div>

            <button
              className="btn-outline text-xs"
              type="button"
              onClick={requestResumo}
              disabled={summaryState.loading}
              title="Gerar/atualizar resumo"
            >
              {summaryState.loading ? (
                <span className="inline-flex items-center gap-2">
                  <Activity className="h-4 w-4 animate-spin opacity-70" />
                  Gerando...
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <RefreshCcw className="h-4 w-4 opacity-70" />
                  Resumir
                </span>
              )}
            </button>
          </div>

          {summaryState.error ? (
            <div className="sap-card p-3 text-sm border panel-border">
              <div className="font-semibold mb-1">Erro</div>
              <div className="opacity-80">{summaryState.error}</div>
              <div className="mt-3">
                <button className="btn-themed" type="button" onClick={requestResumo}>
                  Tentar novamente
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-auto pr-1">
              <div className="sap-card p-3 border panel-border">
                <div className="text-xs uppercase font-semibold opacity-70 mb-2">
                  Status: {summaryState.status}
                </div>

                {summaryState.loading && !summaryState.text ? (
                  <div className="text-sm opacity-75 inline-flex items-center gap-2">
                    <Activity className="h-4 w-4 animate-spin opacity-70" />
                    Gerando resumo...
                  </div>
                ) : summaryState.text ? (
                  <div className="text-sm whitespace-pre-wrap leading-relaxed">{summaryState.text}</div>
                ) : (
                  <div className="text-sm opacity-70">
                    Ainda não há resumo. Clique em <b>Resumir</b>.
                  </div>
                )}

                {summaryState.text ? (
                  <div className="mt-4 pt-3 border-t panel-border">
                    <div className="text-xs uppercase font-semibold opacity-70 mb-2">
                      Feedback (treino)
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        className="btn-themed"
                        type="button"
                        disabled={!canSend}
                        onClick={() => submitResumoFeedback('aceitar')}
                        title="Conteúdo bom / correto"
                      >
                        {summaryFeedback.sending && summaryFeedback.label === 'aceitar'
                          ? 'Enviando...'
                          : 'Aceitar'}
                      </button>

                      <button
                        className="btn-outline"
                        type="button"
                        disabled={!canSend}
                        onClick={() => submitResumoFeedback('faz_sentido_parcialmente')}
                        title="Parte faz sentido"
                      >
                        {summaryFeedback.sending && summaryFeedback.label === 'faz_sentido_parcialmente'
                          ? 'Enviando...'
                          : 'Faz sentido parcialmente'}
                      </button>

                      <button
                        className="btn-outline"
                        type="button"
                        disabled={!canSend}
                        onClick={() => submitResumoFeedback('nada_a_ver')}
                        title="Conteúdo ruim / errado"
                      >
                        {summaryFeedback.sending && summaryFeedback.label === 'nada_a_ver'
                          ? 'Enviando...'
                          : 'Nada a ver'}
                      </button>
                    </div>

                    {summaryFeedback.error ? (
                      <div className="text-xs text-red-400 mt-2">{summaryFeedback.error}</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      );
    }

    return null;
  }, [
    selectedRow,
    drawerPane,
    etapaSubMap,
    moveTarget,
    moveColuna,
    moveEtapa,
    moveSub,
    moveComentario,
    moveCanais,
    moveArquivo,
    load,
    loadHistoryDetails,
    requestResumo,
    submitResumoFeedback,
    summaryState,
    summaryFeedback,
  ]);

  // =======================
  // UI: Import modal
  // =======================
  const ImportModal = useMemo(() => {
    if (!importOpen) return null;

    return createPortal(
      <div className="fixed inset-0 z-50">
        <div className="absolute inset-0 bg-black/60" onClick={() => setImportOpen(false)} />
        <div className="absolute inset-x-0 top-10 mx-auto w-[min(900px,calc(100%-32px))] bg-[var(--panel-processos)] border panel-border rounded-lg shadow-xl p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-lg font-bold">Importar CSV</div>
              <div className="text-xs opacity-70">
                Use o modelo para evitar erros. Separador: <b>;</b>
              </div>
            </div>

            <button className="btn-outline" type="button" onClick={() => setImportOpen(false)}>
              Fechar
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button className="btn-outline" type="button" onClick={handleDownloadTemplate}>
              Baixar modelo
            </button>

            <label className="btn-themed cursor-pointer">
              Selecionar arquivo
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => setImportFile(e.target.files?.[0] || null)}
              />
            </label>

            <div className="text-xs opacity-70 truncate max-w-[420px]">
              {importFile?.name ? importFile.name : 'Nenhum arquivo selecionado'}
            </div>

            <div className="ml-auto flex gap-2">
              <button
                className="btn-outline"
                type="button"
                disabled={importLoading}
                onClick={() => {
                  setImportFile(null);
                  setImportOpen(false);
                }}
              >
                Cancelar
              </button>
              <button className="btn-themed" type="button" disabled={importLoading} onClick={handleImport}>
                {importLoading ? 'Importando...' : 'Importar'}
              </button>
            </div>
          </div>

          <div className="mt-4 text-xs opacity-70">
            Dica: para atualizar deferimento/repasse/fluxo/faturamento em lote, preencha somente as colunas necessárias.
          </div>
        </div>
      </div>,
      document.body,
    );
  }, [importOpen, importFile, importLoading, handleImport, handleDownloadTemplate]);

  // =======================
  // UI: Export modal
  // =======================
  const ExportModal = useMemo(() => {
    if (!exportOpen) return null;

    const textFields = [
      { key: 'uc', label: 'UC' },
      { key: 'id_requisicao', label: 'ID Requisição' },
      { key: 'cliente', label: 'Cliente' },
      { key: 'concessionaria', label: 'Concessionária' },
      { key: 'id_status', label: 'ID Status' },
      { key: 'status', label: 'Status' },
      { key: 'etapa_historico', label: 'Etapa histórico' },
      { key: 'sub_etapa_historico', label: 'Sub-etapa histórico' },
      { key: 'forma_devolucao', label: 'Forma de devolução' },
      { key: 'primeira_nf', label: 'Primeira NF' },
    ];

    const dateRanges = [
      { key: 'data_criacao', label: 'Data criação' },
      { key: 'ultima_atualizacao', label: 'Última atualização' },
      { key: 'ultima_movimentacao', label: 'Última movimentação' },
      { key: 'data_deferido_simples', label: 'Deferido simples' },
      { key: 'data_deferido_dobro', label: 'Deferido dobro' },
      { key: 'data_envio_financeiro', label: 'Envio financeiro' },
    ];

    const numberRanges = [
      { key: 'ressarcimento_estimado', label: 'Ressarcimento estimado' },
      { key: 'qtde_deferidos', label: 'Qtde. deferidos' },
      { key: 'credito_simples', label: 'Crédito simples' },
      { key: 'credito_dobro', label: 'Crédito dobro' },
      { key: 'total_cliente', label: 'Total cliente' },
      { key: 'repasse_simples', label: 'Repasse simples' },
      { key: 'repasse_dobro', label: 'Repasse dobro' },
      { key: 'total_amee', label: 'Total AMEE' },
      { key: 'qtde_registros_fluxo', label: 'Qtde. fluxo' },
      { key: 'valor_fluxo', label: 'Valor fluxo' },
      { key: 'qtde_registros_faturamento', label: 'Qtde. faturamento' },
      { key: 'valor_fat', label: 'Valor faturamento' },
    ];

    const setField = (key, value) =>
      setExportFilters((prev) => ({ ...prev, [key]: value }));

    const clearFilters = () =>
      setExportFilters((prev) =>
        Object.keys(prev).reduce((acc, k) => ({ ...acc, [k]: '' }), {}),
      );

    return createPortal(
      <div className="fixed inset-0 z-50">
        <div className="absolute inset-0 bg-black/60" onClick={() => setExportOpen(false)} />
        <div className="absolute inset-x-0 top-8 mx-auto w-[min(1100px,calc(100%-32px))] bg-[var(--panel-processos)] border panel-border rounded-lg shadow-xl p-5 max-h-[85vh] overflow-auto">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-lg font-bold">Exportar CSV</div>
              <div className="text-xs opacity-70">Filtros completos do relatório.</div>
            </div>

            <button className="btn-outline" type="button" onClick={() => setExportOpen(false)}>
              Fechar
            </button>
          </div>

          <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="sap-card p-3 border panel-border space-y-2">
              <div className="text-xs font-semibold opacity-70">Filtros de texto</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {textFields.map((f) => (
                  <div key={f.key}>
                    <label className="text-[11px] uppercase tracking-wide">{f.label}</label>
                    <input
                      className="input-themed w-full mt-1"
                      value={exportFilters[f.key] || ''}
                      onChange={(e) => setField(f.key, e.target.value)}
                    />
                  </div>
                ))}
                <div>
                  <label className="text-[11px] uppercase tracking-wide">Suspenso</label>
                  <select
                    className="input-themed w-full mt-1"
                    value={exportFilters.suspenso || ''}
                    onChange={(e) => setField('suspenso', e.target.value)}
                  >
                    <option value="">Todos</option>
                    <option value="1">Suspenso</option>
                    <option value="0">Não suspenso</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="sap-card p-3 border panel-border space-y-2">
              <div className="text-xs font-semibold opacity-70">Filtros por data</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {dateRanges.map((f) => (
                  <div key={f.key} className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wide">{f.label}</div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="date"
                        className="input-themed"
                        value={exportFilters[`${f.key}_ini`] || ''}
                        onChange={(e) => setField(`${f.key}_ini`, e.target.value)}
                      />
                      <input
                        type="date"
                        className="input-themed"
                        value={exportFilters[`${f.key}_fim`] || ''}
                        onChange={(e) => setField(`${f.key}_fim`, e.target.value)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 sap-card p-3 border panel-border space-y-2">
            <div className="text-xs font-semibold opacity-70">Filtros numéricos (min / max)</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {numberRanges.map((f) => (
                <div key={f.key} className="space-y-1">
                  <div className="text-[11px] uppercase tracking-wide">{f.label}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      className="input-themed"
                      placeholder="min"
                      value={exportFilters[`${f.key}_min`] || ''}
                      onChange={(e) => setField(`${f.key}_min`, e.target.value)}
                    />
                    <input
                      className="input-themed"
                      placeholder="max"
                      value={exportFilters[`${f.key}_max`] || ''}
                      onChange={(e) => setField(`${f.key}_max`, e.target.value)}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-outline" type="button" onClick={clearFilters}>
              Limpar filtros do relatório
            </button>
            <button
              className="btn-themed"
              type="button"
              onClick={() => {
                handleExport();
                setExportOpen(false);
              }}
            >
              Exportar
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }, [exportOpen, exportFilters, handleExport]);

  // =======================
  // UI: Alert modal
  // =======================
  const AlertModal = useMemo(() => {
    if (!alertModal.open) return null;

    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/60" onClick={() => setAlertModal({ open: false, mensagem: '', processoId: null })} />
        <div className="relative w-full max-w-xl bg-[var(--panel-processos)] border panel-border rounded-lg shadow-xl p-5">
          <div className="flex items-center justify-between">
            <div className="text-lg font-bold">Novo alerta</div>
            <button
              className="btn-outline"
              type="button"
              onClick={() => setAlertModal({ open: false, mensagem: '', processoId: null })}
            >
              Fechar
            </button>
          </div>

          <div className="mt-3 text-sm whitespace-pre-wrap">{alertModal.mensagem}</div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              className="btn-outline"
              type="button"
              onClick={() => setAlertModal({ open: false, mensagem: '', processoId: null })}
            >
              Ok
            </button>
            {alertModal.processoId ? (
              <button className="btn-themed" type="button" onClick={handleAlertOpenProcess}>
                Abrir processo #{alertModal.processoId}
              </button>
            ) : null}
          </div>
        </div>
      </div>,
      document.body,
    );
  }, [alertModal, handleAlertOpenProcess]);

  const SaveModal = useMemo(() => {
    if (!saveModal.open) return null;

    return createPortal(
      <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/70" />
        <div className="relative w-full max-w-md bg-[var(--panel-processos)] border panel-border rounded-lg shadow-xl p-5">
          <div className="text-lg font-bold mb-2">Dados salvos</div>
          <div className="text-sm opacity-90">{saveModal.mensagem}</div>
          <div className="mt-4 flex justify-end">
            <button
              className="btn-themed"
              type="button"
              onClick={() => setSaveModal({ open: false, mensagem: '' })}
            >
              Ok
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }, [saveModal]);

  const HalfPieCard = useCallback(
    ({
      title,
      value,
      goal,
      subtitle,
      valueLabel,
      footer,
      className,
      progressTotal,
      progressValue,
      progressLabel,
    }) => {
      const safeGoal = Number(goal || 0) > 0 ? Number(goal) : 1;
      const safeValue = Number(value || 0);
      const filled = Math.min(safeValue, safeGoal);
      const rest = Math.max(safeGoal - filled, 0);
      const percent = safeGoal > 0 ? Math.min(100, (safeValue / safeGoal) * 100) : 0;
      const progressMax = Number(progressTotal || 0);
      const progressVal = Number(progressValue || 0);
      const progressPct = progressMax > 0 ? Math.min(100, (progressVal / progressMax) * 100) : 0;
      const data = [
        { name: 'Valor', value: filled },
        { name: 'Restante', value: rest },
      ];

      return (
        <div className={`sap-card border panel-border p-2 ${className || ''}`}>
          <div className="text-xs font-semibold uppercase opacity-70 mb-2">{title}</div>
          <div className="h-[190px] mt-6">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  startAngle={180}
                  endAngle={0}
                  innerRadius={60}
                  outerRadius={95}
                  paddingAngle={2}
                  stroke="none"
                >
                  <Cell fill={METRICAS_PIE_COLOR} />
                  <Cell fill="var(--muted)" />
                </Pie>
                <text x="50%" y="58%" textAnchor="middle" className="fill-current text-[13px] font-bold">
                  {valueLabel || formatCurrencyBR(safeValue)}
                </text>
                <text x="50%" y="72%" textAnchor="middle" className="fill-current text-[11px] font-bold opacity-80">
                  {percent.toFixed(1)}%
                </text>
                <text x="50%" y="90%" textAnchor="middle" className="fill-current text-[11px] opacity-70">
                  Meta mensal: {formatCurrencyBR(safeGoal)}
                </text>
              </PieChart>
            </ResponsiveContainer>
          </div>
          {subtitle ? <div className="text-[11px] opacity-70 mt-1">{subtitle}</div> : null}
          {progressMax > 0 ? (
            <div className="mt-2">
              <div className="flex items-center justify-between text-[11px] opacity-80 mb-1">
                <span className="font-semibold">{progressLabel || 'Meta total'}</span>
                <span className="font-semibold">
                  {formatCurrencyBR(progressVal)} / {formatCurrencyBR(progressMax)}
                </span>
              </div>
              <div className="h-2 rounded-full overflow-hidden flex border panel-border">
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${Math.max(0, Math.min(100, progressPct))}%`,
                    backgroundColor: '#39ff14',
                  }}
                />
                <div
                  className="h-full"
                  style={{
                    width: `${Math.max(0, 100 - Math.max(0, Math.min(100, progressPct)))}%`,
                    backgroundColor: 'var(--muted)',
                  }}
                />
              </div>
            </div>
          ) : null}
          {footer ? <div className="mt-2">{footer}</div> : null}
        </div>
      );
    },
    [],
  );

  // =======================
  // Render
  // =======================
  const reqInfo = reqDetails || {};
  const reqUc = pickFirst(reqInfo, ['uc', 'UC']);
  const reqCliente = pickFirst(reqInfo, ['cliente', 'Cliente', 'razao_social_fatura', 'Razao Social Fatura']);
  const reqConc = pickFirst(reqInfo, ['concessionaria', 'Concessionaria']);
  const reqValor = pickFirst(reqInfo, ['ressarcimento_estimado', 'valor_estimado', 'valorEstimado']);
  const reqCriado = pickFirst(reqInfo, ['data_criacao', 'dataCriacao', 'created_at']);
  const reqPeriodo = formatPeriodosIrregularidade(
    reqInfo.periodos_irregularidade ?? reqInfo.periodosIrregularidade,
  );
  const reqDescricao = pickFirst(reqInfo, ['descricao_irregularidade', 'descricaoIrregularidade']);
  const reqLink = pickFirst(reqInfo, ['link_fatura', 'linkFatura', 'link']);
  const reqIrregularidade = pickFirst(reqInfo, ['tipo_irregularidade', 'irregularidade', 'tipoIrregularidade'], '');
  const reqSubIrregularidade = pickFirst(
    reqInfo,
    ['subtipo_irregularidade', 'sub_irregularidade', 'subtipoIrregularidade'],
    '',
  );
  const { info: reqInfoHistoryItems, display: reqHistoryDisplayItems } = useMemo(
    () => splitHistoryItems(reqHistorico || []),
    [reqHistorico],
  );
  const reqHistoryGroups = useMemo(
    () => groupHistoryByStage(reqHistoryDisplayItems),
    [reqHistoryDisplayItems],
  );

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <div className="px-3 sm:px-4 py-3 space-y-4">
        <div className="flex items-center gap-2">
          {!hideViewToggle && (
          <button
            type="button"
            className={`px-2 py-2 rounded border border-[var(--border)] bg-[var(--card)] inline-flex items-center gap-2 ${
              viewMode === 'requisicoes' ? 'ml-auto' : ''
            }`}
            onClick={() =>
              setViewMode((prev) => (prev === 'processos' ? 'requisicoes' : 'processos'))
            }
            title="Alternar visão"
          >
            {viewMode === 'processos' ? (
              <>
                <img
                  src="/Icones/seta-esquerda.png"
                  alt="Ir para Requisições"
                  className="h-5 w-5 object-contain"
                />
                <span className="text-sm font-semibold">Requisições</span>
              </>
            ) : (
              <>
                <span className="text-sm font-semibold">Processos</span>
                <img
                  src="/Icones/seta-direita.png"
                  alt="Ir para Processos"
                  className="h-5 w-5 object-contain"
                />
              </>
            )}
          </button>
          )}
        </div>

        <div>
          {viewMode === 'processos' ? (
            <ProcessosKanbanView
              filteredRows={filteredRows}
              filteredRowsAll={filteredRowsAll}
              ativosMetricas={ativosMetricas}
              ativosResumo={ativosResumo}
              ativosEtapasResumo={ativosEtapasResumo}
              scoreData={scoreData}
              activeTab={activeTab}
              showAtivosMetricas={showAtivosMetricas}
              setShowAtivosMetricas={setShowAtivosMetricas}
              selectedMonthIdx={selectedMonthIdx}
              setSelectedMonthIdx={setSelectedMonthIdx}
              monthLabels={monthLabels}
              q={q}
              setQ={setQ}
              qDebounced={qDebounced}
              showFilters={showFilters}
              setShowFilters={setShowFilters}
              sortField={sortField}
              setSortField={setSortField}
              sortDir={sortDir}
              setSortDir={setSortDir}
              showAllRows={showAllRows}
              setShowAllRows={setShowAllRows}
              kanbanFilter={kanbanFilter}
              setKanbanFilter={setKanbanFilter}
              processColWidths={processColWidths}
              processSort={processSort}
              setProcessSort={setProcessSort}
              processResizeRef={processResizeRef}
              filtroCliente={filtroCliente}
              setFiltroCliente={setFiltroCliente}
              filtroConcessionaria={filtroConcessionaria}
              setFiltroConcessionaria={setFiltroConcessionaria}
              filtroUC={filtroUC}
              setFiltroUC={setFiltroUC}
              filtroId={filtroId}
              setFiltroId={setFiltroId}
              filtroEtapa={filtroEtapa}
              setFiltroEtapa={setFiltroEtapa}
              filtroSubEtapa={filtroSubEtapa}
              setFiltroSubEtapa={setFiltroSubEtapa}
              filtroRelevancia={filtroRelevancia}
              setFiltroRelevancia={setFiltroRelevancia}
              filtroSuspenso={filtroSuspenso}
              setFiltroSuspenso={setFiltroSuspenso}
              filtroDataIni={filtroDataIni}
              setFiltroDataIni={setFiltroDataIni}
              filtroDataFim={filtroDataFim}
              setFiltroDataFim={setFiltroDataFim}
              filtroValorMin={filtroValorMin}
              setFiltroValorMin={setFiltroValorMin}
              filtroValorMax={filtroValorMax}
              setFiltroValorMax={setFiltroValorMax}
              loading={loading}
              isSyncing={isSyncing}
              historyLoading={historyLoading}
              searchResultsCount={searchResultsCount}
              searchResultsSummary={searchResultsSummary}
              historyMatchesSummary={historyMatchesSummary}
              setExportOpen={setExportOpen}
              setImportOpen={setImportOpen}
              syncLoadAll={syncLoadAll}
              handleProcessCardOpen={handleProcessCardOpen}
              openReqInfoEditFromRow={openReqInfoEditFromRow}
              TabBar={TabBar}
              HalfPieCard={HalfPieCard}
            />
          ) : null}
        </div>

      </div>

      {ExportModal}
      {ImportModal}
      {AlertModal}
      {SaveModal}

      {createPortal(
        <>
          <ProcessoDrawer
            open={drawerOpen}
            row={selectedRow}
            onClose={closeDrawer}
            pane={drawerPane}
            setPane={setDrawerPane}
            onPrepareMove={requestPaneMove}
            onEditHistory={openEditHistory}
            rightPane={rightPane}
            snapshotData={snapshotHeaderData}
            requisicaoData={requisicaoHeaderData}
            anexosData={processoAnexos}
            historyItems={historyItems}
            historyDetailLoading={historyDetailLoading}
            historyAnexoUploading={historyAnexoUploading}
            onAttachHistoryAnexo={attachHistoryAnexo}
            onDeleteAnexo={deleteProcessoAnexo}
            relevanciaChecked={headerFlags.relevancia}
            suspensoChecked={headerFlags.suspenso}
            onToggleRelevancia={updateRelevancia}
            onToggleSuspenso={updateSuspenso}
            handleSaveProcesso={handleSaveProcesso}
            onConcluirProcesso={handleConcluirProcesso}
            detailsByPid={detailsByPid}
            setDetailsByPid={setDetailsByPid}
            detailValue={detailValue}
            scoreData={scoreData}
            activeTab={activeTab}
            onEditInfo={selectedRow ? () => openReqInfoEditFromRow(selectedRow) : undefined}
            instanciasDeferimento={instanciasDeferimento}
          />





          <EditHistoricoModal
            open={historyEditOpen}
            processoId={selectedPid}
            draft={historyDraft}
            setDraft={setHistoryDraft}
            onAddRow={addHistoryRow}
            onRemoveRow={removeHistoryRow}
            onClose={() => setHistoryEditOpen(false)}
            onSave={saveHistory}
            historyAnexoUploading={historyAnexoUploading}
            onAttachHistoryAnexo={attachHistoryAnexo}
          />
        </>,
        document.body,
      )}

      <style>{`
        .btn-action { padding: 6px 10px; border-radius: 6px; color: white; font-size: 12px; font-weight: bold; display: flex; align-items: center; gap: 6px; justify-content: center; }
        .btn-press { transition: transform 120ms ease, box-shadow 120ms ease; }
        .btn-press:active { transform: translateY(1px); box-shadow: inset 0 2px 4px rgba(0,0,0,0.15); }
        .req-btn-email { background: #e8ddc9; color: #111; }
        .req-btn-ativos { background: #1f7a3a; border-color: #d4af37; color: #d4af37; }
        .req-btn-analise { background: #f4d44d; border-color: #c9a83a; color: #3a2c00; }
        .req-btn-aprovar { background: #1f7a3a; border-color: #0f5a2a; color: #f5f0c5; }
        .req-btn-rejeitar { background: #b02020; border-color: #7a1414; color: #fff2f2; }
      `}</style>
    </div>
  );
}
