import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Activity, Filter, RefreshCcw, Paperclip } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { getEtapaSubMap } from '../services/filtersService';
import { saveProcessoFull } from '../services/adminEditorService';
import { getHistoricoById, getProcessosKanbanFast, movimentarProcesso, searchGlobalHistorico } from '../services/requisicaoService';
import api from '../services/apiClient';
import { getProcessoSnapshot, mapSnapshotToForm } from '../services/processoSnapshotService';
import { getSummary, refreshSummary } from '../services/summaryService';
import { sendResumoFeedback } from '../services/resumoFeedbackService';
import Toast from '../components/Toast.jsx';
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
  { id: 'SUSPENSOS', label: 'Suspensos', etapa: 'SUSPENSOS' }
];
const KANBAN_COLUNAS = ETAPA_TABS.map((t) => t.label);
const MAPA_COLUNAS_PARA_ETAPAS = {
  Ativos: 'Distribuidora',
  Deferidos: 'Pendente',
  'Fluxo de Ressarcimento': 'Enviado ao Financeiro',
  Faturamento: 'Repasse Amee',
  'Concluídos': 'Concluí­do',
  Indeferidos: 'Indeferido',
  Suspensos: '',
};
const KANBAN_ETAPAS = {
  Ativos: ['Distribuidora', 'Ouvidoria', 'ANEEL', 'SMA'],
  Deferidos: ['Pendente', 'Em Conciliação', 'Em Contestação'],
  'Fluxo de Ressarcimento': ['Enviado ao Financeiro'],
  Faturamento: ['Repasse Amee'],
  'Concluídos': ['Concluí­do'],
  Indeferidos: ['Indeferido'],
  Suspensos: [],
};
const DEFAULT_CANAIS = {
  whatsapp: false,
  ligacao: false,
  email: false,
  sms: false,
  site: false,
  pessoal: false,
};
const CANAIS_UI = [
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'ligacao', label: 'Ligaçãoo' },
  { key: 'email', label: 'E-mail' },
  { key: 'sms', label: 'SMS' },
  { key: 'site', label: 'Site' },
  { key: 'pessoal', label: 'Pessoal' },
];
const RESUMO_PROMPT_VERSION = 'ressarcimento_v1';
// =======================
// HELPERS
// =======================
const determineProcessoCategory = (header, kanbanColuna) => {
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
  // Prioridade 0: coluna do kanban-fast
  if (kanbanColuna) {
    const mapped = normalizeKanbanName(kanbanColuna);
    if (mapped) return mapped;
  }
  // Prioridade 1: nome_coluna Ã© a fonte de verdade do Kanban
  if (header.nome_coluna) {
    const mapped = normalizeKanbanName(header.nome_coluna);
    if (mapped) return mapped;
  }
  // Prioridade 2: etapa_atual
  const etapaAtual = header.etapa_atual ?? header.etapaAtual ?? '';
  if (etapaAtual) {
    const mapped = normalizeKanbanName(etapaAtual);
    if (mapped) return mapped;
  }
  // Prioridade 3: etapa do Histórico (Ãšltima movimentaÃ§Ã£o)
  const etapaHist = header.etapa ?? '';
  if (etapaHist) {
    const mapped = normalizeKanbanName(etapaHist);
    if (mapped) return mapped;
  }
  // Prioridade 4: HeurÃ­stica baseada em dados
  const hasDeferimento = (header.credito_simples && Number(header.credito_simples) > 0) ||
                          (header.credito_dobro && Number(header.credito_dobro) > 0);
  const hasFluxo = header.valor_fluxo && Number(header.valor_fluxo) > 0;
  const hasNF = header.numero_nf && String(header.numero_nf).trim() !== '';
  const isPago = header.data_pagamento && String(header.data_pagamento).trim() !== '';
  const isSuspenso = (header.sub_etapa && String(header.sub_etapa).toLowerCase().includes('suspenso'));
  if (isSuspenso) return 'Suspensos';
  if (isPago) return 'Concluídos';
  if (hasNF && !isPago) return 'Faturamento';
  if (hasFluxo) return 'Fluxo de Ressarcimento';
  if (hasDeferimento) return 'Deferidos';
  return 'Ativos';
};
const toNumberValue = (value) => {
  if (value === '' || value == null) return '';
  const normalized = String(value).trim().replace(/\./g, '').replace(',', '.');
  const num = Number(normalized);
  return Number.isNaN(num) ? '' : num;
};
const formatCurrencyBR = (value) => {
  const n = Number(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};
const detailValue = (details, pid, field, fallback) =>
  details[pid]?.[field] ?? fallback ?? '';
const pickFirst = (obj, keys, fallback = '') => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return fallback;
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
      'ultima_atualizacao',
      'updated_at',
      'data_atualizacao',
      'data',
      'created_at',
      'data_criacao',
      'data_criacao_requisicao',
    ]),
  );
  const histTs = hist.reduce((max, h) => {
    const v = pickFirst(h, ['hist_data', 'data_movimentacao', 'data', 'created_at'], '');
    const ts = toTs(v);
    return ts > max ? ts : max;
  }, 0);
  return Math.max(headerTs, histTs);
};
const formatSnapshotValue = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Sim' : 'NÃ£o';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value.filter((v) => v != null && String(v).trim()).join(', ');
  }
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
const toDateTimeLocal = (dbValue) => {
  const s = String(dbValue || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (m) return `${m[1]}T${m[2]}`;
  if (s.includes('T')) return s.slice(0, 16);
  return '';
};
const fromDateTimeLocal = (inputValue) => {
  const s = String(inputValue || '').trim();
  if (!s) return '';
  if (s.includes('T')) return s.replace('T', ' ') + ':00';
  return s;
};
const nowDb = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const buildComentarioFinal = ({ texto }) => String(texto || '').trim();
const formatComentarioCanal = (value) => {
  const raw = String(value || '');
  const re = /\{(email|whatsapp|ligacao|sms|site|pessoal)\}/gi;
  const found = [];
  let cleaned = raw.replace(re, (_, key) => {
    const k = String(key || '').toLowerCase();
    if (!found.includes(k)) found.push(k);
    return '';
  });
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (found.length === 0) return cleaned;
  return `${cleaned}${cleaned ? ' ' : ''}(via ${found.join(', ')})`;
};
const buildRowsFromKanbanFast = (colunas = {}) => {
  const rows = [];
  const kanbanMap = {};
  const relMap = {};
  Object.entries(colunas || {}).forEach(([col, itens]) => {
    (itens || []).forEach((p) => {
      const id = p?.id ?? p?.ID ?? p?.processo_id ?? p?.processoId ?? p?.ProcessoID;
      if (id == null) return;
      kanbanMap[String(id)] = col;
      relMap[String(id)] = !!p?.relevancia;
      rows.push({
        processo_id: id,
        nome_coluna: col,
        etapa_atual: p?.etapa ?? '',
        etapa: p?.etapa ?? '',
        sub_etapa: p?.sub_etapa ?? '',
        cliente: p?.cliente ?? '',
        uc: p?.uc ?? '',
        concessionaria: p?.concessionaria ?? '',
        valor_estimado: p?.valor_estimado ?? null,
        credito_simples: p?.credito_simples ?? null,
        credito_dobro: p?.credito_dobro ?? null,
        relevancia: p?.relevancia ?? false,
        data_alerta: p?.data_alerta ?? null,
        ultima_atualizacao: p?.ultima_atualizacao ?? null,
        suspenso: p?.suspenso ?? null,
      });
    });
  });
  return { rows, kanbanMap, relMap };
};
const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',');
  return `{${body}}`;
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
// =======================
// SUB-COMPONENTES UI
// =======================
function ProcessoCard({ row, onOpen }) {
  const { pid, header, category } = row;
  const uc = pickFirst(header, ['uc', 'Uc', 'UC']);
  const cliente = pickFirst(header, ['cliente', 'Cliente']);
  const concess = pickFirst(header, ['concessionaria', 'Concessionaria']);
  const repasseSimples = header?.repasse_simples ?? '';
  const repasseDobro = header?.repasse_dobro ?? '';
  const showRepasse = String(repasseSimples || '').trim() || String(repasseDobro || '').trim();
  const estimadoRaw = pickFirst(header, ['ressarcimento_estimado', 'valor_estimado', 'valor'], '');
  const showEstimado = String(estimadoRaw || '').trim();
  return (
    <button
      onClick={() => onOpen(row)}
      className="text-left p-1.5 rounded-md border panel-border processo-card hover:opacity-95 transition min-h-[72px] text-[var(--fg)]"
      title="Abrir detalhes"
      type="button"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wide opacity-80">Processo</div>
        <div className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--muted)]/70 opacity-90">
          {category}
        </div>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between">
        <div className="text-lg font-bold leading-tight">{pid}</div>
        <div className="text-xs opacity-80 truncate max-w-[120px]">UC {uc}</div>
      </div>
      <div className="text-xs mt-1 truncate opacity-95">{cliente}</div>
      <div className="text-[11px] mt-0.5 truncate opacity-80">{concess}</div>
      {showEstimado ? (
        <div className="text-[11px] mt-0.5 truncate opacity-85">
          Estimado: {formatCurrencyBR(estimadoRaw)}
        </div>
      ) : null}
      {showRepasse ? (
        <div className="text-[11px] mt-0.5 truncate opacity-85">
          Repasse: {repasseSimples || '-'}{repasseDobro ? ` / ${repasseDobro}` : ''}
        </div>
      ) : null}
    </button>
  );
}
function CanaisSelector({ canais, onToggle }) {
  return (
    <div className="flex flex-wrap gap-2">
      {CANAIS_UI.map(({ key, label }) => {
        const ativo = !!canais?.[key];
        return (
          <button
            key={key}
            type="button"
            className={`sap-chip transition ${ativo ? 'sap-chip--active' : ''}`}
            onClick={() => onToggle(key)}
            title={`Registra no histórico como ${label}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
function Field({ label, hint, children }) {
  return (
    <div className="sap-field">
      <label className="sap-label">{label}</label>
      {children}
      {hint ? <div className="sap-hint">{hint}</div> : null}
    </div>
  );
}
// ExtraÃ­do para evitar recriaÃ§Ã£o no render do Drawer
function ProcessoDadosView({ header, snapshotData, requisicaoData, anexosData, estimadoValue, onChangeEstimado, onSaveEstimado, processoId, onDeleteAnexo }) {
  const [showMore, setShowMore] = useState(false);
  const anexos = Array.isArray(anexosData) ? anexosData : [];
  const merged = {
    ...(header || {}),
    ...(snapshotData || {}),
    ...(requisicaoData || {}),
  };
  return (
    <div className="mt-3 pt-3 border-t panel-border space-y-4">
      <div>
        <div className="text-base font-semibold uppercase tracking-wide mb-3">DADOS BÁSICOS</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-8">
          <div>
            <div className="text-[11px] uppercase font-semibold">UC</div>
            <div className="text-xs break-words">{formatSnapshotValue(pickFirst(merged, ['uc', 'Uc', 'UC']))}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase font-semibold">CLIENTE</div>
            <div className="text-xs break-words">{formatSnapshotValue(pickFirst(merged, ['cliente', 'Cliente']))}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase font-semibold">CONCESSIONÁRIA</div>
            <div className="text-xs break-words">
              {formatSnapshotValue(pickFirst(merged, ['concessionaria', 'Concessionaria']))}
            </div>
          </div>
          <div>
            <input
              className="input-themed text-xs mt-1 w-full"
              value={estimadoValue ?? ''}
              onChange={(e) => onChangeEstimado?.(e.target.value)}
              onBlur={() => onSaveEstimado?.()}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSaveEstimado?.(); } }}
              placeholder="0,00"
              inputMode="decimal"
            />
          </div>
          <div>
            <div className="text-[11px] uppercase font-semibold">LINK DE FATURA</div>
            <div className="text-xs break-words">
              {formatSnapshotValue(pickFirst(merged, ['link_fatura', 'linkFatura'])) || '<NA>'}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase font-semibold">PERÍODOS DE IRREGULARIDADE</div>
            <div className="text-xs break-words">
              {formatPeriodosIrregularidade(pickFirst(merged, ['periodos_irregularidade']))}
            </div>
          </div>
        </div>
      </div>
      <div>
        <div className="text-[11px] uppercase font-semibold mb-2">ANEXOS</div>
        {anexos.length === 0 ? (
          <div className="text-xs opacity-70">Sem anexos.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {anexos.map((a, idx) => {
              const path = String(a.caminho_arquivo || '').trim();
              const href = path.startsWith('http')
                ? path
                : path
                ? `/${path.replace(/^\/+/, '')}`
                : '';
              const nome = a.nome_arquivo || a.nome || `Anexo ${idx + 1}`;
              const anexoId = a.id ?? a.id_anexo ?? a.ID ?? null;
              return href ? (
                <div key={`${a.id ?? 'anexo'}-${idx}`} className="flex items-center gap-2">
                  <a
                    className="px-2 py-1 rounded border panel-border text-xs hover:opacity-90"
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {nome}
                  </a>
                  {anexoId && onDeleteAnexo ? (
                    <button
                      type="button"
                      className="text-[11px] opacity-70 hover:opacity-100"
                      onClick={() => onDeleteAnexo(processoId, anexoId)}
                    >
                      Remover
                    </button>
                  ) : null}
                </div>
              ) : (
                <span key={`${a.id ?? 'anexo'}-${idx}`} className="px-2 py-1 rounded border panel-border text-xs opacity-70">
                  {nome}
                </span>
              );
            })}
          </div>
        )}
      </div>
      <div>
        <button
          type="button"
          className="btn-outline text-xs"
          onClick={() => setShowMore((v) => !v)}
        >
          {showMore ? 'Mostrar menos' : '+ Mostrar mais'}
        </button>
        {showMore && (
          <>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-8">
              <div>
                <div className="text-[11px] uppercase font-semibold">CNPJ</div>
                <div className="text-xs break-words">{formatSnapshotValue(pickFirst(merged, ['cnpj']))}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase font-semibold">RAZÃƒO SOCIAL (FATURA)</div>
                <div className="text-xs break-words">
                  {formatSnapshotValue(pickFirst(merged, ['razao_social_fatura', 'razaoSocialFatura']))}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase font-semibold">DATA DA REQUISIÃ‡ÃƒO</div>
                <div className="text-xs break-words">
                  {formatSnapshotValue(pickFirst(merged, ['data_criacao', 'data_requisicao']))}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase font-semibold">IRREGULARIDADE</div>
                <div className="text-xs break-words">
                  {formatSnapshotValue(
                    pickFirst(merged, ['tipo_irregularidade', 'irregularidade_padrao', 'irregularidade']),
                  )}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase font-semibold">SUB IRREGULARIDADE</div>
                <div className="text-xs break-words">
                  {formatSnapshotValue(pickFirst(merged, ['subtipo_irregularidade', 'sub_irregularidade']))}
                </div>
              </div>
            </div>
            <div className="mt-4">
              <div className="text-[11px] uppercase font-semibold">DESCRIÇÃO</div>
              <div className="text-xs break-words">
                {formatSnapshotValue(pickFirst(merged, ['descricao_irregularidade', 'descricao']))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
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
  detailsByPid,
  setDetailsByPid,
  detailValue: detailValueLocal,
}) {
  if (!open || !row) return null;
  const { pid, header, category } = row;
  const anexos = Array.isArray(anexosData) ? anexosData : [];
  const historySource = Array.isArray(historyItems) && historyItems.length > 0
    ? historyItems
    : Array.isArray(row.history)
    ? row.history
    : [];
  const estimadoBase = pickFirst(
    { ...(header || {}), ...(snapshotData || {}), ...(requisicaoData || {}) },
    ['ressarcimento_estimado', 'valor_estimado', 'valor'],
    ''
  );
  const hasRight = !!pane;
  const ativosDate = useMemo(() => {
    const list = Array.isArray(row.history) ? [...row.history] : [];
    if (!list.length) return '';
    const parse = (s) => {
      if (!s) return null;
      const d = new Date(String(s).replace(' ', 'T'));
      return Number.isNaN(d.getTime()) ? null : d;
    };
    list.sort((a, b) => {
      const da = parse(pickFirst(a, ['hist_data', 'data_movimentacao', 'data'], ''));
      const db = parse(pickFirst(b, ['hist_data', 'data_movimentacao', 'data'], ''));
      if (!da || !db) return 0;
      return db - da;
    });
    const hit = list.find((h) => {
      const status = String(pickFirst(h, ['status_composto', 'status_novo', 'etapa_nova', 'etapa'], '')).toLowerCase();
      return status.includes('ativo');
    });
    return pickFirst(hit, ['hist_data', 'data_movimentacao', 'data'], '');
  }, [row]);
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
      toTsSafe(pickFirst(h, ['hist_data', 'data_movimentacao', 'data', 'created_at'], ''))
    );

    const candidates = anexos.filter((a) => {
      const name = a?.nome_arquivo || a?.nome || '';
      const path = a?.caminho_arquivo || a?.url || '';
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
        url: a?.caminho_arquivo || a?.url,
        data_upload: a?.data_upload || a?.DataUpload,
      };
      list[targetIdx].anexos = [...(list[targetIdx].anexos || []), link];
    });

    return list;
  }, [historySorted, anexos]);
  const detail = detailsByPid[pid] || {};
  const fluxoItens =
    Array.isArray(detail.fluxo_itens) && detail.fluxo_itens.length
      ? detail.fluxo_itens
      : [
          {
            forma_devolucao: detail.forma ?? header.forma_devolucao ?? '',
            valor: detail.valor_fluxo ?? header.valor_fluxo ?? '',
            data_devolucao: detail.data_fluxo ?? header.data_fluxo ?? '',
          },
        ];
  const faturamentoItens =
    Array.isArray(detail.faturamento_itens) && detail.faturamento_itens.length
      ? detail.faturamento_itens
      : [
          {
            numero_nf: detail.numero_nf ?? header.numero_nf ?? '',
            data_emissao: detail.data_emissao ?? header.data_emissao ?? '',
            data_vencimento: detail.data_vencimento ?? header.data_vencimento ?? '',
            data_pagamento: detail.data_pagamento ?? header.data_pagamento ?? '',
            valor: detail.valor_nf ?? header.valor_nf ?? '',
          },
        ];
  // Helper para atualizar itens de lista
  const updateList = (field, idx, key, val) => {
    setDetailsByPid((prev) => {
      const cur = prev[pid] || {};
      const itens = Array.isArray(cur[field]) && cur[field].length ? [...cur[field]] : (field === 'fluxo_itens' ? [...fluxoItens] : [...faturamentoItens]);
      itens[idx] = { ...(itens[idx] || {}), [key]: val };
      return { ...prev, [pid]: { ...cur, [field]: itens } };
    });
  };
  const manageList = (field, action, idx) => {
    setDetailsByPid((prev) => {
        const cur = prev[pid] || {};
        const defaultList = field === 'fluxo_itens' ? [...fluxoItens] : [...faturamentoItens];
        const itens = Array.isArray(cur[field]) && cur[field].length ? [...cur[field]] : defaultList;
        if (action === 'add') {
             if (field === 'fluxo_itens') itens.push({ forma_devolucao: '', valor: '', data_devolucao: '' });
             else itens.push({ numero_nf: '', data_emissao: '', data_vencimento: '', data_pagamento: '', valor: '' });
        } else if (action === 'remove') {
             if (itens.length > 1) itens.splice(idx, 1);
             else return prev;
        }
        return { ...prev, [pid]: { ...cur, [field]: itens } };
    });
  };
  const togglePane = (key, beforeOpen) => {
    setPane((prev) => {
      const next = prev === key ? '' : key;
      if (next === key) beforeOpen?.();
      return next;
    });
  };
  const paneBtn = (key) => `sap-tab ${pane === key ? 'sap-tab-active' : ''}`;
  const renderLeft = () => (
    <div className="space-y-4 pr-1">
      <div className="sap-section">
        <div className="sap-section-header flex items-center justify-between">
          <div className="font-semibold">Deferimento</div>
        </div>
        <div className="p-3 grid grid-cols-2 gap-4">
          <Field label="Valor deferido">
            <input
              className="input-themed text-sm"
              value={detailValueLocal(detailsByPid, pid, 'cs', header.credito_simples)}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...prev,
                  [pid]: { ...(prev[pid] || {}), cs: e.target.value },
                }))
              }
            />
          </Field>
          <Field label="Data deferimento">
            <input
              type="date"
              className="input-themed text-sm"
              value={detailValueLocal(detailsByPid, pid, 'ds', header.data_simples)}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...prev,
                  [pid]: { ...(prev[pid] || {}), ds: e.target.value },
                }))
              }
            />
          </Field>
          <Field label="Deferimento dobro">
            <input
              className="input-themed text-sm"
              value={detailValueLocal(detailsByPid, pid, 'cd', header.credito_dobro)}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...prev,
                  [pid]: { ...(prev[pid] || {}), cd: e.target.value },
                }))
              }
            />
          </Field>
          <Field label="Data dobro">
            <input
              type="date"
              className="input-themed text-sm"
              value={detailValueLocal(detailsByPid, pid, 'dd', header.data_dobro)}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...prev,
                  [pid]: { ...(prev[pid] || {}), dd: e.target.value },
                }))
              }
            />
          </Field>
          <Field label="Repasse Amee">
            <input
              className="input-themed text-sm"
              value={detailValueLocal(detailsByPid, pid, 'rs', header.repasse_simples)}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...prev,
                  [pid]: { ...(prev[pid] || {}), rs: e.target.value },
                }))
              }
            />
          </Field>
          <Field label="Repasse Dobro">
            <input
              className="input-themed text-sm"
              value={detailValueLocal(detailsByPid, pid, 'rd', header.repasse_dobro)}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...prev,
                  [pid]: { ...(prev[pid] || {}), rd: e.target.value },
                }))
              }
            />
          </Field>
        </div>
        <div className="flex justify-end p-3 pt-0">
          <button className="btn-themed" onClick={() => handleSaveProcesso(pid, header)} type="button">
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
                <Field label="Forma de devolução">
                  <input
                    className="input-themed text-sm"
                    value={item.forma_devolucao ?? ''}
                    onChange={(e) => updateList('fluxo_itens', idx, 'forma_devolucao', e.target.value)}
                  />
                </Field>
                <Field label="Valor">
                  <input
                    type="number"
                    step="0.01"
                    className="input-themed text-sm"
                    value={item.valor ?? ''}
                    onChange={(e) => updateList('fluxo_itens', idx, 'valor', e.target.value)}
                  />
                </Field>
                <Field label="Data devolução">
                  <input
                    type="date"
                    className="input-themed text-sm"
                    value={item.data_devolucao ?? ''}
                    onChange={(e) => updateList('fluxo_itens', idx, 'data_devolucao', e.target.value)}
                  />
                </Field>
              </div>
              {fluxoItens.length > 1 && (
                <div className="flex justify-end mt-2">
                  <button className="btn-outline text-xs" onClick={() => manageList('fluxo_itens', 'remove', idx)} type="button">
                    Remover
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-end p-3 pt-0">
          <button className="btn-themed" onClick={() => handleSaveProcesso(pid, header)} type="button">
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
                <Field label="Número NF">
                  <input
                    className="input-themed text-sm"
                    value={item.numero_nf ?? ''}
                    onChange={(e) => updateList('faturamento_itens', idx, 'numero_nf', e.target.value)}
                  />
                </Field>
                <Field label="Emissão">
                  <input
                    type="date"
                    className="input-themed text-sm"
                    value={item.data_emissao ?? ''}
                    onChange={(e) => updateList('faturamento_itens', idx, 'data_emissao', e.target.value)}
                  />
                </Field>
                <Field label="Vencimento">
                  <input
                    type="date"
                    className="input-themed text-sm"
                    value={item.data_vencimento ?? ''}
                    onChange={(e) => updateList('faturamento_itens', idx, 'data_vencimento', e.target.value)}
                  />
                </Field>
                <Field label="Pagamento">
                  <input
                    type="date"
                    className="input-themed text-sm"
                    value={item.data_pagamento ?? ''}
                    onChange={(e) => updateList('faturamento_itens', idx, 'data_pagamento', e.target.value)}
                  />
                </Field>
                <Field label="Valor NF">
                  <input
                    type="number"
                    step="0.01"
                    className="input-themed text-sm"
                    value={item.valor ?? ''}
                    onChange={(e) => updateList('faturamento_itens', idx, 'valor', e.target.value)}
                  />
                </Field>
              </div>
              {faturamentoItens.length > 1 && (
                <div className="flex justify-end mt-2">
                  <button className="btn-outline text-xs" onClick={() => manageList('faturamento_itens', 'remove', idx)} type="button">
                    Remover
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-end p-3 pt-0">
          <button className="btn-themed" onClick={() => handleSaveProcesso(pid, header)} type="button">
            Salvar faturamento
          </button>
        </div>
      </div>
    </div>
  );
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-7xl bg-[var(--panel-processos)] border-l panel-border shadow-lg p-4 overflow-hidden flex flex-col">
        <div className="flex items-start justify-between gap-3 pb-3 border-b panel-border">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-2xl font-bold leading-tight">#{pid}</div>
              <div className="sap-chip">
                {category}
              </div>
              {formatSnapshotValue(pickFirst(header, ['updated_at', 'updatedAt'])) ? (
                <div className="text-xs opacity-70">
                  Atualizado em: {formatSnapshotValue(pickFirst(header, ['updated_at', 'updatedAt']))}
                </div>
              ) : null}            </div>
            <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!relevanciaChecked}
                  onChange={(e) => onToggleRelevancia?.(e.target.checked)}
                />
                <span>Sinalizar como Relevante</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!suspensoChecked}
                  onChange={(e) => onToggleSuspenso?.(e.target.checked)}
                />
                <span>Suspender Processo</span>
              </label>
            </div>
            <ProcessoDadosView
              header={header}
              snapshotData={snapshotData}
              requisicaoData={requisicaoData}
              anexosData={anexosData}
              estimadoValue={detailValue(detailsByPid, pid, 're', estimadoBase)}
              processoId={pid}
              onDeleteAnexo={onDeleteAnexo}
              onChangeEstimado={(value) =>
                setDetailsByPid((prev) => ({
                  ...prev,
                  [pid]: { ...(prev[pid] || {}), re: value },
                }))
              }
              onSaveEstimado={() => handleSaveProcesso(pid, header)}
            />
          </div>
          <button className="btn-outline" onClick={onClose} type="button">
            Fechar
          </button>
        </div>
        <div className="sap-tabs mt-3 flex-wrap">
          <button className={paneBtn('resume')} type="button" onClick={() => togglePane('resume')}>
            Resumir com IA
          </button>
          <button className={paneBtn('move')} type="button" onClick={() => togglePane('move', onPrepareMove)}>
            Movimentar
          </button>
          <button className={paneBtn('history')} type="button" onClick={() => togglePane('history')}>
            Histórico
          </button>
        </div>
        <div className="mt-4 flex-1 overflow-hidden">
          {!hasRight ? (
            <div className="h-full overflow-auto">
              {renderLeft()}
            </div>
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
                          {historyDetailLoading && (
                            <Activity className="h-4 w-4 animate-spin opacity-70" />
                          )}
                        </div>
                        <button className="btn-outline text-xs" onClick={onEditHistory} type="button">
                          Editar histórico
                        </button>
                      </div>
                      {historyWithAnexos.length === 0 ? (
                        <div className="text-sm opacity-70">Nenhum histórico.</div>
                      ) : (
                        <div className="relative pl-4">
                          <div className="absolute left-1 top-0 bottom-0 w-px bg-[var(--border)]/60" />
                          <div className="space-y-4">
                            {historyWithAnexos.map((item, idx) => (
                              <div key={`hist-${pid}-${idx}`} className="relative pl-4">
                                <div className="absolute left-[-2px] top-1 w-2 h-2 rounded-full bg-[var(--accent)]" />
                                {(() => {
                                  const histId = item.id_historico ?? item.historico_id ?? item.hist_id ?? item.id ?? null;
                                  const uploading = histId && historyAnexoUploading?.[histId];
                                  return (
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="text-xs opacity-70">
                                        {pickFirst(item, ['hist_data', 'data_movimentacao', 'data'], '-')}
                                      </div>
                                      {histId ? (
                                        <label className="inline-flex items-center gap-1 text-xs opacity-80 cursor-pointer">
                                          <Paperclip size={12} />
                                          <input
                                            type="file"
                                            className="hidden"
                                            disabled={!!uploading}
                                            onChange={(e) => {
                                              const file = e.target.files?.[0];
                                              if (file && onAttachHistoryAnexo) {
                                                onAttachHistoryAnexo(pid, histId, file);
                                              }
                                              e.target.value = '';
                                            }}
                                          />
                                        </label>
                                      ) : null}
                                    </div>
                                  );
                                })()}
                                <div className="flex flex-wrap items-center gap-2 mt-1">
                                  <span className="sap-chip">
                                    {pickFirst(item, ['etapa_nova', 'etapa', 'Etapa'], '-')}
                                  </span>
                                  <span className="text-xs opacity-70">
                                    Sub-etapa: {getSubEtapaFromStatus(item) || '-'}
                                  </span>
                                </div>
                                <div className="text-sm mt-1 whitespace-pre-wrap">
                                  {formatComentarioCanal(pickFirst(item, ['hist_comentario', 'comentario'], '-'))}
                                </div>
                                {Array.isArray(item.anexos) && item.anexos.length > 0 && (
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    {item.anexos.map((anexo, anexoIdx) => {
                                      const path = String(anexo.url || anexo.caminho_arquivo || '').trim();
                                      const href = path.startsWith('http')
                                        ? path
                                        : path
                                        ? `/${path.replace(/^\/+/, '')}`
                                        : '';
                                      const nome = anexo.nome || anexo.nome_arquivo || `Anexo ${anexoIdx + 1}`;
                                      const match = anexos.find((a) => {
                                        const p = String(a.caminho_arquivo || a.url || '').trim();
                                        const n = a.nome_arquivo || a.nome || '';
                                        return p === path && n === nome;
                                      });
                                      const anexoId = match?.id ?? match?.id_anexo ?? null;
                                      return href ? (
                                        <div key={`hist-anexo-${idx}-${anexoIdx}`} className="inline-flex items-center gap-2">
                                          <a
                                            className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:opacity-90"
                                            href={href}
                                            target="_blank"
                                            rel="noreferrer"
                                          >
                                            <Paperclip size={10} />
                                            {nome}
                                          </a>
                                          {anexoId && onDeleteAnexo ? (
                                            <button
                                              type="button"
                                              className="text-[11px] opacity-70 hover:opacity-100"
                                              onClick={() => onDeleteAnexo(pid, anexoId)}
                                            >
                                              Remover
                                            </button>
                                          ) : null}
                                        </div>
                                      ) : (
                                        <span key={`hist-anexo-${idx}-${anexoIdx}`} className="text-xs opacity-70">
                                          {nome}
                                        </span>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {anexos.length > 0 && (
                        <div className="mt-4">
                          <div className="text-xs opacity-70 mb-1">Anexos</div>
                          <div className="flex flex-wrap gap-2">
                            {anexos.map((a, idx) => {
                              const path = String(a.caminho_arquivo || "").trim();
                              const href = path.startsWith("http")
                                ? path
                                : path
                                ? `/${path.replace(/^\/+/, "")}`
                                : "";
                              const nome = a.nome_arquivo || a.nome || `Anexo ${idx + 1}`;
                              return href ? (
                                <a
                                  key={`${a.id ?? "anexo"}-${idx}`}
                                  className="px-2 py-1 rounded border panel-border text-xs hover:opacity-90"
                                  href={href}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {nome}
                                </a>
                              ) : (
                                <span key={`${a.id ?? "anexo"}-${idx}`} className="px-2 py-1 rounded border panel-border text-xs opacity-70">
                                  {nome}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      )}

                    </div>
                  ) : (
                    rightPane || <div className="text-sm opacity-70">Selecione uma opÃ§Ã£o.</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
function EditHistoricoModal({
  open,
  processoId,
  draft,
  setDraft,
  onAddRow,
  onRemoveRow,
  onClose,
  onSave,
  historyItems,
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
                        if (file && onAttachHistoryAnexo) {
                          onAttachHistoryAnexo(processoId, h.id_historico, file);
                        }
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}
                <button className="btn-outline text-xs" onClick={() => onRemoveRow(idx)} type="button">
                  Remover
                </button>
              </div>
              {h.id_historico && Array.isArray(historyItems) && (
                <div className="col-span-12 pt-1">
                  {(() => {
                    const match = historyItems.find((it) =>
                      String(it?.id_historico ?? it?.historico_id ?? it?.hist_id ?? it?.id ?? '') ===
                      String(h.id_historico)
                    );
                    const list = match?.anexos || [];
                    if (!Array.isArray(list) || list.length === 0) return null;
                    return (
                      <div className="flex flex-wrap gap-2 text-xs">
                        {list.map((anexo, aidx) => {
                          const path = String(anexo.url || anexo.caminho_arquivo || '').trim();
                          const href = path.startsWith('http')
                            ? path
                            : path
                            ? `/${path.replace(/^\/+/, '')}`
                            : '';
                          const nome = anexo.nome || anexo.nome_arquivo || `Anexo ${aidx + 1}`;
                          return href ? (
                            <a
                              key={`hist-edit-anexo-${h.id_historico}-${aidx}`}
                              className="inline-flex items-center gap-1 text-[var(--accent)] hover:opacity-90"
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <Paperclip size={10} />
                              {nome}
                            </a>
                          ) : (
                            <span key={`hist-edit-anexo-${h.id_historico}-${aidx}`} className="opacity-70">
                              {nome}
                            </span>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          ))}
          {!draft?.length && (
            <div className="p-3 text-sm opacity-70">Sem histórico carregado.</div>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button className="btn-outline" onClick={onClose} type="button">
            Cancelar
          </button>
          <button className="btn-themed" onClick={onSave} type="button">
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
function MovePane({
  pid,
  etapaSubMap,
  moveTarget,
  moveColuna,
  setMoveColuna,
  moveColunaAtual,
  setMoveColunaAtual,
  moveEtapaAtual,
  setMoveEtapaAtual,
  moveEtapa,
  setMoveEtapa,
  moveSub,
  setMoveSub,
  moveComentario,
  setMoveComentario,
  moveAdvanceOpen,
  setMoveAdvanceOpen,
  moveCanais,
  setMoveCanais,
  moveArquivo,
  setMoveArquivo,
  setToast,
  setLoading,
  load,
  onAfterMove,
  onClosePane,
}) {
  const etapasPorColuna = KANBAN_ETAPAS[moveColuna] || [];
  const mappedEtapa = MAPA_COLUNAS_PARA_ETAPAS[moveColuna] || etapasPorColuna[0] || '';
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b panel-border">
        <div className="min-w-0">
          <div className="font-semibold">
            Movimentar processo #{pid}
          </div>
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
                setMoveSub('');
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
              value={moveEtapa || mappedEtapa}
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
          <Field label="Sub-etapa">
            <select
              className="input-themed w-full"
              value={moveSub}
              onChange={(e) => setMoveSub(e.target.value)}
              disabled={!moveColuna || !((moveEtapa || mappedEtapa))}
            >
              <option value="">
                {moveColuna ? '(opcional)' : 'Selecione uma coluna'}
              </option>
              {(etapaSubMap?.[
                (moveEtapa || mappedEtapa) || moveColuna
              ] || []).map((s) => (
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
          <Field label="Canais de comunicaÃ§Ã£o">
            <CanaisSelector
              canais={moveCanais}
              onToggle={(key) => setMoveCanais((prev) => ({ ...(prev || {}), [key]: !prev?.[key] }))}
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
              alert('Preencha os campos obrigatÃ³rios.');
              return;
            }
            const comentarioFinal = buildComentarioFinal({ texto: moveComentario });
            const canais = Object.entries(moveCanais || {})
              .filter(([, v]) => !!v)
              .map(([k]) => k);
            setLoading(true);
            try {
              const fd = new FormData();
              fd.append('etapa_atual', etapaDestino);
              if (String(moveSub || '').trim()) fd.append('sub_etapa', String(moveSub || '').trim());
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
              await load(true);
              if (onAfterMove) await onAfterMove(id);
            } catch (err) {
              setToast({ open: true, type: 'error', text: err?.message || 'Erro ao mover processo.' });
            } finally {
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
export default function AdminPlanilha() {
  const location = useLocation();
  const openedFromQueryRef = useRef(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [kanbanMap, setKanbanMap] = useState({});
  const [relevanciaMap, setRelevanciaMap] = useState({});
  const offsetRef = useRef(0);
  // Filtros
  const [q, setQ] = useState('');
  const [etapa, setEtapa] = useState('');
  const [sub, setSub] = useState('');
  const [ini, setIni] = useState('');
  const [fim, setFim] = useState('');
  const [kanbanFilter, setKanbanFilter] = useState('');
  const [showSearch, setShowSearch] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [showAllRows, setShowAllRows] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importLoading, setImportLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('ATIVOS');
  const [toast, setToast] = useState({ open: false, type: 'info', text: '' });
  const [mvByPid, setMvByPid] = useState({});
  const [detailsByPid, setDetailsByPid] = useState({});
  // Bulk Actions
  const [bulkEtapa, setBulkEtapa] = useState('');
  const [bulkSub, setBulkSub] = useState('');
  const [bulkComentario, setBulkComentario] = useState('');
  // Move / Edit States
  const [etapaSubMap, setEtapaSubMap] = useState({});
  const [moveTarget, setMoveTarget] = useState(null);
  const [moveColuna, setMoveColuna] = useState('');
  const [moveColunaAtual, setMoveColunaAtual] = useState('');
  const [moveEtapaAtual, setMoveEtapaAtual] = useState('');
  const [moveEtapa, setMoveEtapa] = useState('');
  const [moveSub, setMoveSub] = useState('');
  const [moveComentario, setMoveComentario] = useState('');
  const [moveAdvanceOpen, setMoveAdvanceOpen] = useState(false);
  const [moveCanais, setMoveCanais] = useState(DEFAULT_CANAIS);
  const [moveArquivo, setMoveArquivo] = useState(null);
  // Drawer / Modal States
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedPid, setSelectedPid] = useState(null);
  const [drawerPane, setDrawerPane] = useState('');
  const [historyEditOpen, setHistoryEditOpen] = useState(false);
  const [historyDraft, setHistoryDraft] = useState([]);
  const [historyDeletes, setHistoryDeletes] = useState([]);
  const [snapshotHeaderData, setSnapshotHeaderData] = useState(null);
  const [requisicaoHeaderData, setRequisicaoHeaderData] = useState(null);
  const [processoAnexos, setProcessoAnexos] = useState([]);
  const [summaryState, setSummaryState] = useState({
    status: 'none',
    text: '',
    loading: false,
    error: '',
  });
  const [summaryFeedback, setSummaryFeedback] = useState({
    sending: false,
    label: '',
    error: '',
  });
  const summaryPollRef = useRef(null);
  const [historyMatches, setHistoryMatches] = useState(new Set());
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyByPid, setHistoryByPid] = useState({});
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const [historyAnexoUploading, setHistoryAnexoUploading] = useState({});
  const [filtroDataIni, setFiltroDataIni] = useState('');
  const [filtroDataFim, setFiltroDataFim] = useState('');
  const [filtroEtapa, setFiltroEtapa] = useState('');
  const [filtroSubEtapa, setFiltroSubEtapa] = useState('');
  const [filtroConcessionaria, setFiltroConcessionaria] = useState('');
  const [filtroSuspenso, setFiltroSuspenso] = useState(false);
  const [filtroCliente, setFiltroCliente] = useState('');
  const [filtroUC, setFiltroUC] = useState('');
  const [filtroId, setFiltroId] = useState('');
  const [filtroRelevancia, setFiltroRelevancia] = useState('todos');
  const [filtroValorMin, setFiltroValorMin] = useState('');
  const [filtroValorMax, setFiltroValorMax] = useState('');
  const [sortField, setSortField] = useState('data');
  const [sortDir, setSortDir] = useState('desc');
  const deferredSearch = useDeferredValue(q);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getProcessosKanbanFast();
      const colunas = data?.colunas || {};
      const built = buildRowsFromKanbanFast(colunas);
      setRows(built.rows);
      setKanbanMap(built.kanbanMap);
      setRelevanciaMap(built.relMap);
      offsetRef.current = built.rows.length;
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const term = String(deferredSearch || '').trim();
    if (!term) {
      setHistoryMatches(new Set());
      setHistoryLoading(false);
      return;
    }
    let canceled = false;
    (async () => {
      try {
        setHistoryLoading(true);
        const data = await searchGlobalHistorico(term, 500, 0);
        const hits = new Set();
        const arr = Array.isArray(data?.results) ? data.results : [];
        for (const it of arr) {
          const pid = String(it?.processo_id ?? it?.ProcessoID ?? it?.id ?? it?.ID ?? '');
          if (pid) hits.add(pid);
        }
        if (!canceled) setHistoryMatches(hits);
      } catch {
        if (!canceled) setHistoryMatches(new Set());
      } finally {
        if (!canceled) setHistoryLoading(false);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [deferredSearch]);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const subMap = await getEtapaSubMap();
        if (!mounted) return;
        setEtapaSubMap(subMap || {});
      } catch (err) {
        console.warn('Falha ao carregar etapas/sub-etapas:', err?.message || err);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);
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
    return groups.map(([pid, g]) => ({
      pid,
      header: g.header,
      history: g.hist,
      category: determineProcessoCategory(g.header, kanbanMap[String(pid)]),
    }));
  }, [groups, kanbanMap]);
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
  useEffect(() => {
    if (!queryPid || openedFromQueryRef.current) return;
    const row = tableRows.find((r) => Number(r.pid) === queryPid);
    if (!row) return;
    const tab = ETAPA_TABS.find((t) => t.label === row.category);
    if (tab) setActiveTab(tab.id);
    openDrawer(row);
    openedFromQueryRef.current = true;
  }, [queryPid, tableRows]);
  const [headerFlags, setHeaderFlags] = useState({ relevancia: false, suspenso: false });
  useEffect(() => {
    if (!selectedRow) {
      setHeaderFlags({ relevancia: false, suspenso: false });
      return;
    }
    const susp = String(selectedRow.header?.sub_etapa || '').toLowerCase().includes('suspenso');
    setHeaderFlags({
      relevancia: isRelevante(selectedRow.header, selectedRow.pid, relevanciaMap),
      suspenso: susp,
    });
  }, [selectedRow, relevanciaMap]);
  const stopSummaryPoll = useCallback(() => {
    if (summaryPollRef.current) {
      clearInterval(summaryPollRef.current);
      summaryPollRef.current = null;
    }
  }, []);
const startSummaryPoll = useCallback(
    (pid) => {
      stopSummaryPoll();
      summaryPollRef.current = setInterval(async () => {
        try {
          const data = await getSummary(pid);
          const status = data?.status || 'none';
          const text = data?.summary_text || '';
          setSummaryState((prev) => ({
            ...prev,
            status,
            text,
            loading: status === 'pending' || status === 'none',
            error: '',
          }));
          if (status === 'ready' || status === 'error') {
            stopSummaryPoll();
          }
        } catch {
          stopSummaryPoll();
        }
      }, 3000);
    },
    [stopSummaryPoll]
  );
const loadSummary = useCallback(async (pid) => {
    setSummaryState((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const data = await getSummary(pid);
      const status = data?.status || 'none';
      const text = data?.summary_text || '';
      if (status === 'none') {
        await refreshSummary(pid);
        setSummaryState({ status: 'pending', text: '', loading: true, error: '' });
        startSummaryPoll(pid);
        return;
      }
      setSummaryState({
        status,
        text,
        loading: false,
        error: '',
      });
      if (status === 'pending') {
        startSummaryPoll(pid);
      }
    } catch (err) {
      setSummaryState((prev) => ({
        ...prev,
        loading: false,
        error: err?.message || 'Falha ao carregar resumo.',
      }));
    }
  }, [startSummaryPoll]);
      const openDrawer = (row) => {
    setSelectedPid(row.pid);
    setDrawerOpen(true);
    setDrawerPane('');
  };
  const closeDrawer = () => {
    stopSummaryPoll();
    setDrawerOpen(false);
    setSelectedPid(null);
    setDrawerPane('');
    setHistoryEditOpen(false);
    setSnapshotHeaderData(null);
    setRequisicaoHeaderData(null);
    setProcessoAnexos([]);
    setSummaryState({ status: 'none', text: '', loading: false, error: '' });
    setSummaryFeedback({ sending: false, label: '', error: '' });
  };
  useEffect(() => {
    if (!selectedPid) return;
    let mounted = true;
    (async () => {
      try {
        const [snapResp, reqResp, anexosResp] = await Promise.allSettled([
          getProcessoSnapshot(selectedPid),
          api.get(`/requisicoes/${selectedPid}`),
          api.get(`/requisicoes/${selectedPid}/anexos`),
        ]);
        if (!mounted) return;
        const snap = snapResp.status === 'fulfilled' ? mapSnapshotToForm(snapResp.value) : null;
        const req = reqResp.status === 'fulfilled' ? (reqResp.value?.data || null) : null;
        const anexosList =
          anexosResp.status === 'fulfilled' && Array.isArray(anexosResp.value?.data)
            ? anexosResp.value.data
            : [];
        setSnapshotHeaderData(snap);
        setRequisicaoHeaderData(req);
        setProcessoAnexos(anexosList);
      } catch (err) {
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
      if (!force && Array.isArray(historyByPid[pid]) && historyByPid[pid].length > 0) return;
      setHistoryDetailLoading(true);
      try {
        const data = await getHistoricoById(pid);
        setHistoryByPid((prev) => ({ ...(prev || {}), [pid]: data || [] }));
      } catch {
        setHistoryByPid((prev) => ({ ...(prev || {}), [pid]: [] }));
      } finally {
        setHistoryDetailLoading(false);
      }
    },
    [historyByPid],
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
  const deleteProcessoAnexo = useCallback(
    async (pid, anexoId) => {
      if (!pid || !anexoId) return;
      if (!window.confirm('Remover este anexo?')) return;
      try {
        await api.delete(`/requisicoes/${pid}/anexos/${anexoId}`);
        const anexosResp = await api.get(`/requisicoes/${pid}/anexos`);
        const anexosList = Array.isArray(anexosResp?.data) ? anexosResp.data : [];
        setProcessoAnexos(anexosList);
        await loadHistoryDetails(pid, true);
        setToast({ open: true, type: 'success', text: 'Anexo removido.' });
      } catch (err) {
        setToast({ open: true, type: 'error', text: err?.message || 'Falha ao remover anexo.' });
      }
    },
    [loadHistoryDetails],
  );
  useEffect(() => {
    if (!drawerOpen || !selectedPid) return;
    loadHistoryDetails(selectedPid, true);
  }, [drawerOpen, selectedPid, loadHistoryDetails]);
  useEffect(() => {
    if (!drawerOpen || drawerPane !== 'resume' || !selectedPid) return;
    loadSummary(selectedPid);
  }, [drawerOpen, drawerPane, selectedPid, loadSummary]);
  useEffect(() => {
    if (drawerPane !== 'resume') {
      stopSummaryPoll();
    }
  }, [drawerPane, stopSummaryPoll]);
  const requestResumo = async () => {
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
  };
  const handleExport = async () => {
    try {
      const params = {
        q: String(q || '').trim() || undefined,
        etapa: String(filtroEtapa || '').trim() || undefined,
        sub: String(filtroSubEtapa || '').trim() || undefined,
        ini: String(filtroDataIni || '').trim() || undefined,
        fim: String(filtroDataFim || '').trim() || undefined,
        coluna: String(kanbanFilter || '').trim() || undefined,
      };
      const resp = await api.get('/admin/planilha/export', { params, responseType: 'blob' });
      const blob = new Blob([resp.data], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `admin_planilha_export_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao exportar.' });
    }
  };
  const handleDownloadTemplate = () => {
    const header = [
      'processo_id','uc','cnpj','concessionaria','cliente','coluna_kanban','etapa','sub_etapa',
      'credito_simples','data_simples','credito_dobro','data_dobro',
      'forma_devolucao','valor_fluxo','data_fluxo',
      'numero_nf','data_emissao','data_vencimento','data_pagamento','valor_nf',
      'comentario'
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
  };
  const handleImport = async () => {
    if (!importFile) {
      setToast({ open: true, type: 'warning', text: 'Selecione um arquivo CSV.' });
      return;
    }
    setImportLoading(true);
    try {
      const form = new FormData();
      form.append('file', importFile);
      await api.post('/admin/planilha/import', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setToast({ open: true, type: 'success', text: 'Importa��o conclu�da.' });
      setImportOpen(false);
      setImportFile(null);
      await load(true);
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao importar.' });
    } finally {
      setImportLoading(false);
    }
  };
  const submitResumoFeedback = async (label) => {
    if (!selectedRow || !summaryState.text) return;
    const inputPayload = buildResumoInputPayload(selectedRow);
    if (!inputPayload) return;
    setSummaryFeedback({ sending: true, label, error: '' });
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
    }
  };
  const tabCounts = useMemo(() => {
    const counts = {};
    ETAPA_TABS.forEach(tab => {
      counts[tab.id] = tableRows.filter(row => row.category === tab.label).length;
    });
    counts.RELEVANTES = tableRows.filter((row) => isRelevante(row.header, row.pid, relevanciaMap)).length;
    return counts;
  }, [tableRows, relevanciaMap]);
  const filteredRowsAll = useMemo(() => {
    const term = norm(deferredSearch);
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
      if (filtroSuspenso) {
        const isSuspenso = String(subVal || '').toLowerCase().includes('suspenso');
        if (!isSuspenso) return false;
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
      const valorNum = valorRaw !== null && valorRaw !== undefined ? Number(String(valorRaw).replace(',', '.')) : null;
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
    deferredSearch,
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
  const filteredRows = useMemo(
    () => (showAllRows ? filteredRowsAll : filteredRowsAll.slice(0, 10)),
    [filteredRowsAll, showAllRows],
  );
  useEffect(() => {
    const term = String(deferredSearch || '').trim();
    if (!term || !filteredRowsAll.length) return;
    const target = filteredRowsAll[0]?.category || '';
    if (!target) return;
    const tab = ETAPA_TABS.find((t) => t.label === target);
    if (tab && activeTab !== tab.id) {
      setActiveTab(tab.id);
    }
  }, [deferredSearch, filteredRowsAll, activeTab]);
  const candidatePIDs = useMemo(() => filteredRows.map((row) => row.pid), [filteredRows]);
  const searchResultsSummary = useMemo(() => {
    const term = String(deferredSearch || '').trim();
    if (!term) return '';
    const counts = {};
    filteredRowsAll.forEach((row) => {
      const label = row.category || 'Sem aba';
      counts[label] = (counts[label] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([label, count]) => `${label} (${count})`)
      .join(', ');
  }, [deferredSearch, filteredRowsAll]);
  const searchResultsCount = useMemo(() => {
    const term = String(deferredSearch || '').trim();
    if (!term) return 0;
    if (historyMatches.size) return historyMatches.size;
    return filteredRowsAll.length;
  }, [deferredSearch, historyMatches, filteredRowsAll]);
  const openEditHistory = async () => {
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
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao carregar hist¢rico.' });
    } finally {
      setHistoryDetailLoading(false);
    }
  };
  const addHistoryRow = () => {
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
  };
  const removeHistoryRow = (idx) => {
    setHistoryDraft((prev) => {
      const arr = [...(prev || [])];
      const item = arr[idx];
      if (item?.id_historico) setHistoryDeletes((d) => [...(d || []), Number(item.id_historico)]);
      arr.splice(idx, 1);
      return arr;
    });
  };
  const saveHistory = async () => {
    if (!selectedPid) return;
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
      await load(true);
      await loadHistoryDetails(selectedPid, true);
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao salvar histórico.' });
    } finally {
      setLoading(false);
    }
  };
  const handleSaveProcesso = async (pid, header) => {
    const detail = detailsByPid[pid] || {};
    const cs = detail.cs ?? header.credito_simples ?? '';
    const ds = detail.ds ?? header.data_simples ?? '';
    const cd = detail.cd ?? header.credito_dobro ?? '';
    const dd = detail.dd ?? header.data_dobro ?? '';
    const rs = detail.rs ?? header.repasse_simples ?? '';
    const rd = detail.rd ?? header.repasse_dobro ?? '';
    const re = detail.re ?? header.ressarcimento_estimado ?? header.valor_estimado ?? '';
    const reParsed = toNumberValue(re);
    // Prepare Fluxo
    const fluxoItensRaw = Array.isArray(detail.fluxo_itens)
      ? detail.fluxo_itens
      : [{ forma_devolucao: detail.forma ?? header.forma_devolucao ?? '', valor: detail.valor_fluxo ?? header.valor_fluxo ?? '', data_devolucao: detail.data_fluxo ?? header.data_fluxo ?? '' }];
    const fluxoItens = fluxoItensRaw
      .map((it) => ({
        forma_devolucao: it.forma_devolucao ?? it.forma ?? '',
        valor: toNumberValue(it.valor ?? it.valor_fluxo ?? ''),
        data_devolucao: it.data_devolucao ?? it.data_fluxo ?? '',
      }))
      .filter((it) => it.forma_devolucao || it.valor || it.data_devolucao);
    // Prepare Faturamento
    const faturamentoItensRaw = Array.isArray(detail.faturamento_itens)
      ? detail.faturamento_itens
      : [{ numero_nf: detail.numero_nf ?? header.numero_nf ?? '', data_emissao: detail.data_emissao ?? header.data_emissao ?? '', data_vencimento: detail.data_vencimento ?? header.data_vencimento ?? '', data_pagamento: detail.data_pagamento ?? header.data_pagamento ?? '', valor: detail.valor_nf ?? header.valor_nf ?? '' }];
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
      if (!p && n) historicoMsgs.push(`${label} preenchido`);
      else if (p && n && p !== n) historicoMsgs.push(`${label} alterado`);
    };
    const addMsgNum = (label, prevVal, nextVal) => {
      const p = prevVal === '' || prevVal == null ? null : Number(prevVal);
      const n = nextVal === '' || nextVal == null ? null : Number(nextVal);
      if (p == null && n != null) historicoMsgs.push(`${label} preenchido`);
      else if (p != null && n != null && p !== n) historicoMsgs.push(`${label} alterado`);
    };
    addMsgNum('Crédito simples', header?.credito_simples, cs);
    addMsg('Data simples', header?.data_simples, ds);
    addMsgNum('Crédito dobro', header?.credito_dobro, cd);
    addMsg('Data dobro', header?.data_dobro, dd);
    addMsgNum('Repasse Amee', header?.repasse_simples, rs);
    addMsgNum('Repasse Dobro', header?.repasse_dobro, rd);
    addMsgNum('Ressarcimento estimado', header?.ressarcimento_estimado ?? header?.valor_estimado, reParsed);
    if (reParsed !== '' && reParsed != null && !Number.isNaN(Number(reParsed))) {
      payload.ressarcimento_estimado = Number(reParsed);
    }
    const fluxoBase = fluxoItensRaw[0] || {};
    addMsg('Forma de devolução', header?.forma_devolucao, fluxoBase.forma_devolucao ?? fluxoBase.forma);
    addMsgNum('Valor de devolução', header?.valor_fluxo, fluxoBase.valor ?? fluxoBase.valor_fluxo);
    addMsg('Data de devolução', header?.data_fluxo, fluxoBase.data_devolucao ?? fluxoBase.data_fluxo);
    const fatBase = faturamentoItensRaw[0] || {};
    addMsg('Número NF', header?.numero_nf, fatBase.numero_nf);
    addMsg('Data Emissão', header?.data_emissao, fatBase.data_emissao);
    addMsg('Data vencimento', header?.data_vencimento, fatBase.data_vencimento);
    addMsg('Data pagamento', header?.data_pagamento, fatBase.data_pagamento);
    addMsgNum('Valor NF', header?.valor_nf, fatBase.valor);
    const deferimentoHas =
      (ds && ds !== '') ||
      (dd && dd !== '') ||
      (cs !== '' && Number(cs) !== 0) ||
      (cd !== '' && Number(cd) !== 0) ||
      (rs !== '' && Number(rs) !== 0) ||
      (rd !== '' && Number(rd) !== 0);
    if (deferimentoHas) {
      payload.deferimento = JSON.stringify({
        data_procedencia: ds || '',
        credito_simples: cs === '' ? undefined : Number(cs),
        credito_dobro: cd === '' ? undefined : Number(cd),
        data_credito_dobro: dd || '',
        repasse_simples: rs === '' ? undefined : Number(rs),
        repasse_dobro: rd === '' ? undefined : Number(rd),
      });
    }
    if (historicoMsgs.length) {
      payload.historico = historicoMsgs.map((msg) => ({
        data: nowDb(),
        comentario: msg,
        etapa_nova: header?.etapa ?? null,
        sub_etapa: header?.sub_etapa ?? null,
      }));
    }
    payload.fluxo_ressarcimento = JSON.stringify({ itens: fluxoItens });
    payload.faturamento = JSON.stringify({ itens: faturamentoItens });
    try {
      await saveProcessoFull(payload);
      setToast({ open: true, type: 'success', text: `Dados salvos para ${pid}.` });
      await load(true);
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao salvar processo.' });
    }
  };
  const openMoveModal = (pid, header) => {
    const cached = mvByPid[pid] || {};
    const etapaAtual = header?.etapa_atual || header?.etapa || '';
    const colunaAtual = KANBAN_COLUNAS.find(
      col => MAPA_COLUNAS_PARA_ETAPAS[col]?.toLowerCase() === etapaAtual.toLowerCase()
    ) || cached.etapa || header?.nome_coluna || '';
    const subAtual = (cached.sub || header?.sub_etapa || '').trim();
    setMoveTarget({ pid, header });
    setMoveColuna(colunaAtual);
    const etapas = KANBAN_ETAPAS[colunaAtual] || [];
    const etapaDefault = MAPA_COLUNAS_PARA_ETAPAS[colunaAtual] || etapas[0] || etapaAtual;
    setMoveEtapa(cached.etapa || etapaDefault);
    setMoveColunaAtual(colunaAtual);
    setMoveEtapaAtual(etapaAtual);
    setMoveSub(subAtual);
    setMoveComentario((cached.comentario || '').trim());
    setMoveAdvanceOpen(false);
    setMoveCanais(DEFAULT_CANAIS);
    setMoveArquivo(null);
  };
  const updateRelevancia = async (checked) => {
    if (!selectedRow) return;
    const pid = selectedRow.pid;
    const etapaAtual = pickFirst(selectedRow.header, ['etapa_atual', 'etapa', 'Etapa'], '');
    try {
      setLoading(true);
      const fd = new FormData();
      if (etapaAtual) fd.append('etapa_atual', etapaAtual);
      fd.append('relevancia', checked ? '1' : '0');
      fd.append(
        'comentario',
        checked ? 'Processo sinalizado como relevante' : 'Processo marcado como não relevante',
      );
      await movimentarProcesso(pid, fd);
      setHeaderFlags((prev) => ({ ...prev, relevancia: checked }));
      setToast({ open: true, type: 'success', text: 'Relevância atualizada.' });
      await load(true);
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao atualizar relevância.' });
    } finally {
      setLoading(false);
    }
  };
  const updateSuspenso = async (checked) => {
    if (!selectedRow) return;
    const pid = selectedRow.pid;
    const etapaAtual = pickFirst(selectedRow.header, ['etapa_atual', 'etapa', 'Etapa'], '');
    try {
      setLoading(true);
      const fd = new FormData();
      if (etapaAtual) fd.append('etapa_atual', etapaAtual);
      fd.append('sub_etapa', checked ? 'Suspenso' : '');
      fd.append('comentario', checked ? 'Processo suspenso' : 'Suspensão removida');
      await movimentarProcesso(pid, fd);
      setHeaderFlags((prev) => ({ ...prev, suspenso: checked }));
      setToast({ open: true, type: 'success', text: 'Suspensão atualizada.' });
      await load(true);
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao atualizar suspensão.' });
    } finally {
      setLoading(false);
    }
  };
  const TabBar = () => (
    <div className="border-b border-[var(--border)] bg-[var(--card)] sticky top-0 z-10">
      <div className="flex w-full overflow-x-auto scrollbar-thin">
        <div className="flex">
          {ETAPA_TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            const count = tabCounts[tab.id] || 0;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  px-4 py-3 text-sm font-medium whitespace-nowrap
                  border-b-2 transition-colors duration-200
                  ${isActive
                    ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10'
                    : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--hover)]'
                  }
                `}
              >
                {tab.label}
                <span className={`ml-2 px-2 py-0.5 rounded-full text-xs ${
                  isActive
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--muted)] text-[var(--fg-muted)]'
                }`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        <div className="ml-auto">
          {(() => {
            const isActive = activeTab === 'RELEVANTES';
            const count = tabCounts.RELEVANTES || 0;
            return (
              <button
                key="tab-relevantes"
                onClick={() => setActiveTab('RELEVANTES')}
                className={`
                  px-4 py-3 text-sm font-medium whitespace-nowrap
                  border-b-2 transition-colors duration-200
                  ${isActive
                    ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10'
                    : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--hover)]'
                  }
                `}
              >
                Relevantes
                <span className={`ml-2 px-2 py-0.5 rounded-full text-xs ${
                  isActive
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--muted)] text-[var(--fg-muted)]'
                }`}>
                  {count}
                </span>
              </button>
            );
          })()}
        </div>
      </div>
    </div>
  );
  return (
  <div className="p-4 border rounded panel-bg-60 panel-border space-y-4">
    <div
      className="mb-4 lg:mb-6 mt-2 rounded-xl shadow-elevated p-4 border-2 sticky top-0 z-40 relative"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 40,
        background: 'var(--header-bg)',
        borderColor: 'var(--header-border)',
        color: 'var(--header-fg)',
      }}
    >
      <h1 className="text-2xl lg:text-3xl font-extrabold flex items-center justify-center gap-3 text-center">
        Controle de Processos
      </h1>
      <div className="absolute right-4 top-4 flex gap-2">
        <button
          onClick={() => setExportOpen(true)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border panel-border panel-bg-60 hover:opacity-90 text-[var(--header-fg)] transition-smooth"
          title="Exportar planilha"
        >
          Exportar Excel
        </button>
        <button
          onClick={() => setImportOpen(true)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border panel-border panel-bg-60 hover:opacity-90 text-[var(--header-fg)] transition-smooth"
          title="Importar planilha"
        >
          Importar Excel
        </button>
      </div>
      <div className="mt-3 flex items-center justify-center gap-2">
        <button
          onClick={() => setShowSearch((s) => !s)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border panel-border panel-bg-60 hover:opacity-90 text-[var(--header-fg)] transition-smooth"
          title="Mostrar/ocultar busca"
        >
          <Activity size={16} />
          Pesquisar
        </button>
        <button
          onClick={() => setShowFilters((s) => !s)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border panel-border panel-bg-60 hover:opacity-90 text-[var(--header-fg)] transition-smooth"
          title="Mostrar/ocultar filtros avanÃ§ados"
        >
          <Filter size={16} />
          Filtros
        </button>
        <button
          onClick={() => {
            setQ('');
            setEtapa('');
            setSub('');
            setIni('');
            setFim('');
            setKanbanFilter('');
            setHistoryMatches(new Set());
            setFiltroDataIni('');
            setFiltroDataFim('');
            setFiltroEtapa('');
            setFiltroSubEtapa('');
            setFiltroConcessionaria('');
            setFiltroSuspenso(false);
            setFiltroCliente('');
            setFiltroUC('');
            setFiltroId('');
            setFiltroRelevancia('todos');
            setFiltroValorMin('');
            setFiltroValorMax('');
            setSortField('data');
            setSortDir('desc');
            load();
          }}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border panel-border panel-bg-60 hover:opacity-90 text-[var(--header-fg)] transition-smooth"
          title="Limpar todas as buscas e filtros"
        >
          <RefreshCcw size={16} />
          Limpar Tudo
        </button>
        <button
          onClick={() => setShowAllRows(true)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border panel-border panel-bg-60 hover:opacity-90 text-[var(--header-fg)] transition-smooth"
          title="Carregar todos os processos da aba"
          disabled={showAllRows}
        >
          Carregar tudo
        </button>
      </div>
      {showSearch && (
        <div className="mt-3 flex col items-center justify-center gap-2">
          <input
            type="text"
            placeholder="Pesquisar (Cliente, UC, ID, status, etapa, sub-etapa, concessionária, histórico)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full sm:w-[480px] px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />
          {!!String(q || '').trim() && (
            <div className="w-full sm:w-[480px] text-xs opacity-80 mt-1 flex items-center justify-between">
              {historyLoading ? (
                <span>Buscando em históricos...</span>
              ) : (
                <span>
                  {searchResultsCount === 1
                    ? 'Encontrado 1 processo'
                    : `Encontrados ${searchResultsCount} processos`}
                  {historyMatchesSummary || searchResultsSummary ? (
                    <span className="ml-2">
                      em {historyMatchesSummary || searchResultsSummary}
                    </span>
                  ) : null}
                </span>
              )}
              <button
                type="button"
                onClick={() => {
                  setQ('');
                  setHistoryMatches(new Set());
                }}
                className="px-2 py-0.5 rounded border panel-border panel-bg-60 hover:opacity-90"
                title="Limpar busca"
              >
                Limpar
              </button>
            </div>
          )}
        </div>
      )}
      {showFilters && (
        <div className="mb-6 p-3 lg:p-4 bg-[var(--panel-processos)]/40 border panel-border rounded-xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs opacity-70 mb-1">Data da última movimentação (início)</label>
              <input
                type="date"
                value={filtroDataIni}
                onChange={(e) => setFiltroDataIni(e.target.value)}
                className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              />
            </div>
            <div>
              <label className="block text-xs opacity-70 mb-1">Data da última movimentação (fim)</label>
              <input
                type="date"
                value={filtroDataFim}
                onChange={(e) => setFiltroDataFim(e.target.value)}
                className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              />
            </div>
            <div>
              <label className="block text-xs opacity-70 mb-1">Etapa</label>
              <select
                value={filtroEtapa}
                onChange={(e) => setFiltroEtapa(e.target.value)}
                className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              >
                <option value="">Todas</option>
                {Object.keys(etapaSubMap || {}).map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs opacity-70 mb-1">Sub-etapa</label>
              <select
                value={filtroSubEtapa}
                onChange={(e) => setFiltroSubEtapa(e.target.value)}
                className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                disabled={!filtroEtapa}
              >
                <option value="">{filtroEtapa ? 'Todas' : 'Selecione uma etapa'}</option>
                {(etapaSubMap?.[filtroEtapa] || []).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs opacity-70 mb-1">Concessionária</label>
              <input
                type="text"
                placeholder="ex.: ENEL"
                value={filtroConcessionaria}
                onChange={(e) => setFiltroConcessionaria(e.target.value)}
                className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              />
            </div>
            <div className="flex items-center gap-2 mt-6">
              <input
                id="flt-susp"
                type="checkbox"
                checked={filtroSuspenso}
                onChange={(e) => setFiltroSuspenso(e.target.checked)}
              />
              <label htmlFor="flt-susp" className="text-xs opacity-70">
                Somente suspensos
              </label>
            </div>
            <div>
              <label className="block text-xs opacity-70 mb-1">Cliente</label>
              <input
                type="text"
                value={filtroCliente}
                onChange={(e) => setFiltroCliente(e.target.value)}
                className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              />
            </div>
            <div>
              <label className="block text-xs opacity-70 mb-1">UC</label>
              <input
                type="text"
                value={filtroUC}
                onChange={(e) => setFiltroUC(e.target.value)}
                className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              />
            </div>
            <div>
              <label className="block text-xs opacity-70 mb-1">ID</label>
              <input
                type="text"
                value={filtroId}
                onChange={(e) => setFiltroId(e.target.value)}
                className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              />
            </div>
            <div>
              <label className="block text-xs opacity-70 mb-1">Relevância</label>
              <select
                value={filtroRelevancia}
                onChange={(e) => setFiltroRelevancia(e.target.value)}
                className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              >
                <option value="todos">Todos</option>
                <option value="relevante">Relevante</option>
                <option value="no_relevante">Não relevante</option>
              </select>
            </div>
            <div>
              <label className="block text-xs opacity-70 mb-1">Valor (min.)</label>
              <input
                type="number"
                step="0.01"
                value={filtroValorMin}
                onChange={(e) => setFiltroValorMin(e.target.value)}
                className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="block text-xs opacity-70 mb-1">Valor (max.)</label>
              <input
                type="number"
                step="0.01"
                value={filtroValorMax}
                onChange={(e) => setFiltroValorMax(e.target.value)}
                className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                placeholder="999999.99"
              />
            </div>
            <div>
              <label className="block text-xs opacity-70 mb-1">Ordenar por</label>
              <select
                value={sortField}
                onChange={(e) => setSortField(e.target.value)}
                className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              >
                <option value="data">Última movimentação</option>
                <option value="id">ID</option>
                <option value="valor">Valor</option>
              </select>
            </div>
            <div>
              <label className="block text-xs opacity-70 mb-1">Direção</label>
              <select
                value={sortDir}
                onChange={(e) => setSortDir(e.target.value)}
                className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              >
                <option value="desc">Descendente</option>
                <option value="asc">Crescente</option>
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
    <TabBar />
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {filteredRows.map((row) => (
          <ProcessoCard key={`card-${row.pid}`} row={row} onOpen={openDrawer} />
        ))}
      </div>
            {exportOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="sap-card w-full max-w-xl p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-bold">Exportar Excel</h2>
              <button className="btn-outline" type="button" onClick={() => setExportOpen(false)}>
                Fechar
              </button>
            </div>
            <div className="text-sm opacity-70 mt-2">
              Exporta os dados atuais da planilha em CSV (abr�vel no Excel).
            </div>
            <div className="flex flex-wrap gap-2 mt-4">
              <button className="btn-outline" type="button" onClick={handleDownloadTemplate}>
                Baixar modelo
              </button>
              <button
                className="btn-themed"
                type="button"
                onClick={async () => {
                  await handleExport();
                  setExportOpen(false);
                }}
              >
                Exportar
              </button>
            </div>
          </div>
        </div>
      )}
      {importOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="sap-card w-full max-w-xl p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-bold">Importar Excel</h2>
              <button className="btn-outline" type="button" onClick={() => setImportOpen(false)}>
                Fechar
              </button>
            </div>
            <div className="text-sm opacity-70 mt-2">
              Envie um CSV no modelo da planilha. Campos vazios ser�o ignorados.
            </div>
            <div className="mt-4 space-y-3">
              <label className="btn-outline cursor-pointer w-fit">
                Selecionar arquivo
                <input
                  type="file"
                  className="hidden"
                  accept=".csv"
                  onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                />
              </label>
              {importFile?.name && (
                <div className="text-xs opacity-70">{importFile.name}</div>
              )}
            </div>
            <div className="flex flex-wrap gap-2 mt-4">
              <button className="btn-outline" type="button" onClick={handleDownloadTemplate}>
                Baixar modelo
              </button>
              <button className="btn-themed" type="button" onClick={handleImport} disabled={importLoading}>
                {importLoading ? 'Importando...' : 'Importar'}
              </button>
            </div>
          </div>
        </div>
      )}
{createPortal(
        <>
          <ProcessoDrawer
            open={drawerOpen}
            row={selectedRow}
            onClose={closeDrawer}
            pane={drawerPane}
            setPane={setDrawerPane}
            onPrepareMove={() => {
              if (!selectedRow) return;
              openMoveModal(selectedRow.pid, selectedRow.header);
              setMoveAdvanceOpen(false);
            }}
            onEditHistory={openEditHistory}
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
            rightPane={
              drawerPane === 'move' ? (
                <MovePane
                  pid={selectedRow?.pid}
                  etapaSubMap={etapaSubMap}
                  moveTarget={moveTarget}
                  moveColuna={moveColuna}
                  setMoveColuna={setMoveColuna}
                  moveColunaAtual={moveColunaAtual}
                  setMoveColunaAtual={setMoveColunaAtual}
                  moveEtapaAtual={moveEtapaAtual}
                  setMoveEtapaAtual={setMoveEtapaAtual}
                  moveEtapa={moveEtapa}
                  setMoveEtapa={setMoveEtapa}
                  moveSub={moveSub}
                  setMoveSub={setMoveSub}
                  moveComentario={moveComentario}
                  setMoveComentario={setMoveComentario}
                  moveAdvanceOpen={moveAdvanceOpen}
                  setMoveAdvanceOpen={setMoveAdvanceOpen}
                  moveCanais={moveCanais}
                  setMoveCanais={setMoveCanais}
                  moveArquivo={moveArquivo}
                  setMoveArquivo={setMoveArquivo}
                  setToast={setToast}
                  setLoading={setLoading}
                  load={load}
                  onAfterMove={(id) => loadHistoryDetails(id, true)}
                  onClosePane={() => setDrawerPane('')}
                />
              ) : drawerPane === 'resume' ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold">Resumir com IA</div>
                    <button
                      className="btn-themed"
                      type="button"
                      onClick={requestResumo}
                      disabled={summaryState.loading}
                    >
                      {summaryState.loading ? 'Gerando...' : 'Gerar resumo'}
                    </button>
                  </div>
                  {summaryState.error && (
                    <div className="text-sm text-red-500">{summaryState.error}</div>
                  )}
                  <div className="sap-card p-3 space-y-2">
                    <div className="text-xs uppercase tracking-wide opacity-70">
                      Status: {summaryState.status || 'none'}
                    </div>
                    {summaryState.status === 'pending' && (
                      <div className="flex items-center gap-2 text-sm opacity-80">
                        <Activity className="h-4 w-4 animate-spin" />
                        Gerando resumo...
                      </div>
                    )}
                    {summaryState.status === 'none' && !summaryState.loading && (
                      <div className="text-sm opacity-70">Nenhum resumo disponível</div>
                    )}
                    {summaryState.text && (
                      <pre className="whitespace-pre-wrap text-sm">{summaryState.text}</pre>
                    )}
                  </div>
                  <div className="sap-card p-3 space-y-2">
                    <div className="text-sm font-semibold">Feedback do resumo</div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="btn-outline"
                        type="button"
                        onClick={() => submitResumoFeedback('aceitar')}
                        disabled={summaryFeedback.sending || summaryState.status !== 'ready' || !summaryState.text}
                      >
                        Aceitar
                      </button>
                      <button
                        className="btn-outline"
                        type="button"
                        onClick={() => submitResumoFeedback('parcial')}
                        disabled={summaryFeedback.sending || summaryState.status !== 'ready' || !summaryState.text}
                      >
                        Faz sentido parcialmente
                      </button>
                      <button
                        className="btn-outline"
                        type="button"
                        onClick={() => submitResumoFeedback('nada_a_ver')}
                        disabled={summaryFeedback.sending || summaryState.status !== 'ready' || !summaryState.text}
                      >
                        Nada a ver
                      </button>
                    </div>
                    {summaryFeedback.error && (
                      <div className="text-sm text-red-500">{summaryFeedback.error}</div>
                    )}
                    {summaryFeedback.label && !summaryFeedback.error && (
                      <div className="text-xs opacity-70">
                        Feedback registrado: {summaryFeedback.label}
                      </div>
                    )}
                  </div>
                </div>
              ) : null
            }
            handleSaveProcesso={handleSaveProcesso}
            detailsByPid={detailsByPid}
            setDetailsByPid={setDetailsByPid}
            detailValue={detailValue}
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
            historyItems={historyItems}
            historyAnexoUploading={historyAnexoUploading}
            onAttachHistoryAnexo={attachHistoryAnexo}
          />
        </>
      , document.body)}
      <Toast open={toast.open} type={toast.type} message={toast.text} onClose={() => setToast((t) => ({ ...t, open: false }))} />
      <div className="py-4 text-center">
        {loading && (
          <div className="text-sm opacity-70 sap-loading">Carregando processos...</div>
        )}
      </div>
    </div>
  );
}



