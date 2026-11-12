// src/pages/Requisicoes.jsx
//
// Página de Requisições. Originalmente um wrapper de AdminPlanilha,
// agora componente standalone — Etapa 2e.
//
// O branch processos ainda está presente como dead code, mas nunca renderiza
// porque forceViewMode='requisicoes' está hardcoded. A poda final será feita
// em uma etapa futura sem risco.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import { createPortal } from 'react-dom';
import { Activity, Mail, Paperclip, Pencil, RefreshCcw } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { getEtapas, getEtapaSubMap } from '../services/filtersService';
import { saveProcessoFull } from '../services/adminEditorService';
import { atualizarRequisicaoCompleta, buscarFaturasPorUnidadeMeses, comentarProcesso, getAllRequisicoes, getHistoricoById, getProcessosKanbanFast, getRequisicaoById, movimentarProcesso, searchGlobalHistorico } from '../services/requisicaoService';
import { movimentar as movimentarV2 } from '../services/processoV2Service.js';
import api, { withAuthToken } from '../services/apiClient';
import { refreshSummary } from '../services/summaryService';
import { sendResumoFeedback } from '../services/resumoFeedbackService';
import { linkMailToProcess, sendMailMessage } from '../services/mailService';
import { deleteHistorico } from '../services/adminPlanilhaService';
import { getProcessoScore } from '../services/mlService';
import { scoreQueue } from '../services/requestQueueService';
import { getSubtiposIrregularidade, getTiposIrregularidade } from '../services/irregularidadeService';
import { confirmAction } from '../utils/confirm.js';
import { useAuth } from '../context/AuthContext.jsx';
import useAtivosMetricas from './processos/useAtivosMetricas.js';
import useProcessosFiltros from './processos/useProcessosFiltros.js';
import useProcessosTabela from './processos/useProcessosTabela.js';
import useProcessoDrawerState from './processos/useProcessoDrawerState.js';
import useProcessosLoad from './processos/useProcessosLoad.js';
import { DEFAULT_CANAIS, EMAIL_EDITOR_MODULES, ETAPA_TABS, INITIAL_COLUMN_LIMIT, KANBAN_COLUNAS, KANBAN_ETAPAS, MAPA_COLUNAS_PARA_ETAPAS, RESUMO_PROMPT_VERSION } from './requisicoes/constantes.js';
import { norm, normalizeKanbanName, normalizeReqStatusValue, pickFirst, toISODateFromPt, toISODateTimeFromPt, unwrapDbValue } from './requisicoes/util.js';
import { ReqDraggableCard, ReqDroppableColumn, RequisicaoCard } from './requisicoes/RequisicaoCard.jsx';
import { buildResumoInputPayload, buildRowsFromKanbanFast, determineProcessoCategory, formatCurrencyBR, formatDateTimeBR, formatHistoryComentarioLines, formatMesRef, formatPeriodosIrregularidade, getAuthToken, getDeferimentoDefaults, getSubEtapaFromStatus, groupHistoryByStage, isProcessoCriadoHistory, isRelevante, mergeRowsByColumn, METRICAS_PIE_COLOR, normalizeFormaDevolucao, nowDb, rowLastTs, sha256Hex, splitHistoryItems, stableStringify, toDateInput, toNumberValue, toSentenceCase, useChunkedRender, useDebouncedValue } from './requisicoes/processoHelpers.js';
import { CanaisSelector } from './requisicoes/ProcessoDadosView.jsx';
import { MovePane } from './requisicoes/MovePane.jsx';
import { ReqEmailModal } from './requisicoes/ReqEmailModal.jsx';


// =======================
// MAIN COMPONENT
// =======================
export default function Requisicoes({ forceViewMode = 'requisicoes', hideViewToggle = true } = {}) {
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
  // Pré-decisão = requisição ainda em triagem (Nova Requisição OU Em Análise): mostra
  // Comentário + Aprovar/Rejeitar. A tratativa com a distribuidora (Registrar comentário/
  // Enviar e-mail) só aparece DEPOIS de Aprovado (fluxo 2 passos). Água movida p/ "Em Análise"
  // (aguardando doc técnica de vazamento + foto do hidrômetro) precisa manter Aprovar/Rejeitar.
  const isPreDecisao = isNovaRequisicao || reqStatusLabel === 'Em Análise';
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
      } catch (err) {
        console.warn('Falha ao carregar etapas/sub-etapas:', err?.message || err);
      }
    })();
    return () => {
      mounted = false;
    };
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

        // Fluxo 2 passos (07/2026): aprovar só muda id_status=3; o processo nasce
        // num passo separado ("Criar processo"). Requisições Aprovadas continuam
        // aparecendo na coluna Aprovado até serem promovidas a processo.
        if (k.includes('nova requisicao') || k.includes('pendente')) cols['Nova Requisição'].push(req);
        else if (k.includes('analise')) cols['Em Análise'].push(req);
        else if (k.includes('aprov')) {
          // Aprovado só mostra requisições APROVADAS que AINDA NÃO viraram processo.
          // Sinal confiável = não existir linha em FT_PROCESSOS (etapa vazia no join).
          // (triagem/processo_criado não são confiáveis no dado atual.)
          const jaTemProcesso = !!String(req?.etapa || '').trim();
          if (!jaTemProcesso) cols.Aprovado.push(req);
        }
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

  useEffect(() => {
    const controller = new AbortController();
    loadRequisicoes(controller.signal);
    return () => controller.abort();
  }, [loadRequisicoes]);

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

  // Cria processo a partir da requisição: aplica destino canônico no v2
  // → Instância: Distribuidora (id=1) · Etapa: Reclamação (id=1) · Status: Aguardando retorno (id=3)
  const handleReqCriarProcesso = useCallback(async () => {
    if (!selectedReqId) return;
    if (
      !window.confirm(
        'Deseja tornar esta requisição um processo? Destino: Distribuidora · Reclamação · Aguardando retorno.',
      )
    ) {
      return;
    }
    setReqSaving(true);
    try {
      await movimentarV2(selectedReqId, {
        etapa_id: 1,        // Reclama\u00E7\u00E3o
        instancia_id: 1,    // Distribuidora
        status_id: 3,       // Aguardando retorno
        aprovacao_id: null,
        comentario: 'Processo criado a partir da triagem de Requisi\u00E7\u00F5es.',
      });
      try {
        await atualizarRequisicaoCompleta(selectedReqId, { processo_criado: 1, triagem: 0 });
      } catch {}
      await loadRequisicoes();
      setToast({ open: true, type: 'success', text: 'Processo criado.' });
      closeReqDrawer();
    } catch (err) {
      setToast({
        open: true,
        type: 'error',
        text: err?.response?.data?.error || err?.message || 'Falha ao criar processo.',
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

  const saveReqClassificacao = useCallback(async (tipoArg, subtipoArg) => {
    if (!selectedReqId) return;
    const tipoId = tipoArg !== undefined ? tipoArg : reqInfoDraft.id_tipo_irregularidade;
    const subtipoId = subtipoArg !== undefined ? subtipoArg : reqInfoDraft.id_subtipo_irregularidade;
    setReqSaving(true);
    try {
      await atualizarRequisicaoCompleta(selectedReqId, {
        id_tipo_irregularidade: tipoId || null,
        id_subtipo_irregularidade: subtipoId || null,
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

    const deferimentoHas =
      (ds && ds !== '') ||
      (dd && dd !== '') ||
      (csNum !== '' && Number(csNum) !== 0) ||
      (cdNum !== '' && Number(cdNum) !== 0) ||
      (rsNum !== '' && Number(rsNum) !== 0) ||
      (rdNum !== '' && Number(rdNum) !== 0);

    if (section === 'deferimento' && deferimentoHas) {
      payload.deferimento = {
        data_procedencia: dsNormalized || '',
        credito_simples: csNum === '' ? undefined : csNum,
        credito_dobro: cdNum === '' ? undefined : cdNum,
        data_credito_dobro: ddNormalized || '',
        repasse_simples: rsNum === '' ? undefined : rsNum,
        repasse_dobro: rdNum === '' ? undefined : rdNum,
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
                      <div className="text-xs text-[var(--danger)] mt-2">{summaryFeedback.error}</div>
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
                    backgroundColor: 'var(--success)',
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

          {viewMode === 'requisicoes' ? (
            <div className="space-y-3 px-1 sm:px-2 bg-[var(--bg)]">
              <div className="sap-card border panel-border p-3 bg-[var(--card)]">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold">Requisições</div>
                  <div className="text-xs opacity-70">
                    {reqLoading
                      ? 'Carregando...'
                      : `Exibindo ${reqFilteredCount} de ${reqTotalByCols}`}
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    className="input-themed w-full"
                    value={reqQuery}
                    onChange={(e) => setReqQuery(e.target.value)}
                    placeholder="Buscar por UC, cliente, concessionária..."
                  />
                  <button
                    type="button"
                    className="btn-outline text-xs"
                    onClick={() => setReqQuery('')}
                  >
                    Limpar
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="panel-bg-60 border panel-border rounded-lg p-3 text-center">
                  <div className="text-xs opacity-70">Nova Requisição</div>
                  <div className="text-lg font-bold text-[var(--fg)]">{reqCountsByCol.pendente}</div>
                </div>
                <div className="panel-bg-60 border panel-border rounded-lg p-3 text-center">
                  <div className="text-xs opacity-70">Em Análise</div>
                  <div className="text-lg font-bold text-[var(--fg)]">{reqCountsByCol.em_analise}</div>
                </div>
                <div className="panel-bg-60 border panel-border rounded-lg p-3 text-center">
                  <div className="text-xs opacity-70">Aprovado</div>
                  <div className="text-lg font-bold text-[var(--fg)]">{reqCountsByCol.aprovado}</div>
                </div>
                <div className="panel-bg-60 border panel-border rounded-lg p-3 text-center">
                  <div className="text-xs opacity-70">Rejeitado</div>
                  <div className="text-lg font-bold text-[var(--fg)]">{reqCountsByCol.rejeitado}</div>
                </div>
                <div className="col-span-2 sm:col-span-4 text-center text-xs opacity-70">
                  Total de requisições: {reqTotalByCols}
                </div>
              </div>

              {reqLoading ? (
                <div className="text-xs opacity-70 inline-flex items-center gap-2">
                  <Activity className="h-4 w-4 animate-spin opacity-70" />
                  Carregando requisições...
                </div>
              ) : null}

              <DndContext sensors={reqSensors} onDragEnd={handleReqDragEnd}>
                <div className="kanban-board flex justify-center gap-6 overflow-x-auto pb-2">
                  {Object.keys(reqFilteredColumns || {}).map((columnId) => (
                    <div
                      key={columnId}
                      className="glass-card border border-[var(--border)] text-[var(--fg)] rounded-lg p-3 w-80 flex-shrink-0 flex flex-col"
                    >
                      <h3 className="font-bold mb-4 px-2 text-sm uppercase tracking-wider flex items-center justify-center gap-2 text-center">
                        {columnId === 'Nova Requisição' && (
                          <img src="/Icones/requisicao.png" alt="" className="h-6 w-6 opacity-95" />
                        )}
                        {columnId === 'Em Análise' && (
                          <img src="/Icones/em_analise.png" alt="" className="h-4 w-4 opacity-90" />
                        )}
                        {columnId === 'Aprovado' && (
                          <img src="/Icones/aprovado.png" alt="" className="h-4 w-4 opacity-90" />
                        )}
                        {columnId === 'Rejeitado' && (
                          <img src="/Icones/rejeitado.png" alt="" className="h-4 w-4 opacity-90" />
                        )}
                        {columnId}
                      </h3>
                      <ReqDroppableColumn id={columnId}>
                        <div className="min-h-0 space-y-3 p-1 overflow-y-auto">
                          {(reqFilteredColumns[columnId] || []).map((req, idx) => {
                            const reqId = req?.id ?? req?.id_requisicao ?? req?.ID ?? req?.Id ?? `${columnId}-${idx}`;
                            return (
                              <ReqDraggableCard key={reqId} id={reqId} disabled={!isAdmin}>
                                <RequisicaoCard
                                  requisicao={req}
                                  onOpen={() =>
                                    openReqDrawer({
                                      ...(req || {}),
                                      id: req?.id ?? req?.id_requisicao ?? reqId,
                                      status: req?.status ?? columnId,
                                    })
                                  }
                                  onReject={handleRejectRequisicao}
                                  scoreData={scoreData}
                                  onScoreLoad={fetchScoreForRow}
                                />
                              </ReqDraggableCard>
                            );
                          })}
                        </div>
                      </ReqDroppableColumn>
                    </div>
                  ))}
                </div>
              </DndContext>

              {!reqLoading && reqFilteredCount === 0 && (
                <div className="mt-6 text-center text-sm opacity-70">
                  Nenhuma requisição encontrada com os filtros atuais.
                </div>
              )}
            </div>
          ) : null}
        </div>

      {reqMoveOpen && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md bg-[var(--panel)] text-[var(--fg)] border border-[var(--panel-border)] rounded-lg shadow-lg p-4">
            <h2 className="text-lg font-semibold mb-2">Mover requisição</h2>
            <p className="text-sm opacity-80 mb-3">Confirme a movimentação abaixo:</p>
            <div className="text-sm mb-3">
              <div><strong>ID:</strong> #{reqMoveTarget?.id ?? '-'}</div>
              <div className="mt-2">
                <label className="block text-sm font-medium mb-1">Status destino</label>
                <select
                  value={reqDestinoStatus}
                  onChange={(e) => setReqDestinoStatus(e.target.value)}
                  className="w-full p-2 rounded-md border border-[var(--panel-border)] bg-transparent"
                >
                  <option>Nova Requisição</option>
                  <option>Em Análise</option>
                  <option>Aprovado</option>
                  <option>Rejeitado</option>
                </select>
                <div className="flex flex-wrap gap-2 mt-2">
                  {['Nova Requisição', 'Em Análise', 'Aprovado', 'Rejeitado'].map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setReqDestinoStatus(s)}
                      className={`px-2 py-1 rounded border ${reqDestinoStatus === s ? 'bg-[var(--accent)] text-[var(--fg)]' : 'border-[var(--panel-border)]'}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-3">
                <label className="block text-sm font-medium mb-1">Coluna do processo</label>
                <div className="flex flex-wrap gap-2">
                  {['Ativos', 'Deferidos', 'Fluxo de Ressarcimento', 'Faturamento', 'Concluídos', 'Indeferidos'].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => {
                        setReqDestinoColuna(c);
                        const e = reqColToEtapa[c];
                        if (e) setReqDestinoEtapa(e);
                        if (c === 'Ativos' && reqDestinoStatus === 'Aprovado') {
                          setReqDestinoSub('Primeira reclamação da etapa - Aguardando retorno');
                        }
                      }}
                      className={`px-2 py-1 rounded border ${reqDestinoColuna === c ? 'bg-[var(--accent)] text-[var(--fg)]' : 'border-[var(--panel-border)]'}`}
                    >
                      {c.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {reqDestinoStatus === 'Aprovado' && (
              <div className="mb-3">
                <label className="block text-sm font-medium mb-1">Etapa inicial do processo</label>
                <select
                  value={reqDestinoEtapa}
                  onChange={(e) => { setReqDestinoEtapa(e.target.value); setReqDestinoSub(''); }}
                  className="w-full p-2 rounded-md border border-[var(--border)] bg-transparent mb-2"
                >
                  <option value="">(opcional)</option>
                  {reqEtapas.map((n) => (<option key={n} value={n}>{n}</option>))}
                </select>
                <label className="block text-sm font-medium mb-1">Sub-etapa</label>
                <input
                  list="dl-sub-dest-req"
                  value={reqDestinoSub}
                  onChange={(e) => setReqDestinoSub(e.target.value)}
                  className="w-full p-2 rounded-md border border-[var(--border)] bg-transparent"
                  placeholder="(opcional)"
                />
                <datalist id="dl-sub-dest-req">
                  {((etapaSubMap?.[reqDestinoEtapa || ''] || [])).map((s, i) => (<option key={i} value={s} />))}
                </datalist>
                <div className="mt-3">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={reqPreencherDeferimento} onChange={(e) => setReqPreencherDeferimento(e.target.checked)} />
                    Informar deferimento agora
                  </label>
                </div>
                {reqPreencherDeferimento && (
                  <div className="grid grid-cols-1 gap-2 mt-2">
                    <div>
                      <label className="block text-sm">Data da Procedência</label>
                      <input type="date" value={reqDefData} onChange={(e) => setReqDefData(e.target.value)} className="w-full p-2 rounded-md border border-[var(--border)] bg-transparent" />
                    </div>
                    <div>
                      <label className="block text-sm">Crédito Simples (R$)</label>
                      <input type="number" value={reqDefSimples} onChange={(e) => setReqDefSimples(e.target.value)} className="w-full p-2 rounded-md border border-[var(--border)] bg-transparent" />
                    </div>
                    <div>
                      <label className="block text-sm">Crédito em Dobro (R$)</label>
                      <input type="number" value={reqDefDobro} onChange={(e) => setReqDefDobro(e.target.value)} className="w-full p-2 rounded-md border border-[var(--border)] bg-transparent" />
                    </div>
                    <div>
                      <label className="block text-sm">Data do Crédito em Dobro</label>
                      <input type="datetime-local" value={reqDefDataDobro} onChange={(e) => setReqDefDataDobro(e.target.value)} className="w-full p-2 rounded-md border border-[var(--border)] bg-transparent" />
                    </div>
                  </div>
                )}
              </div>
            )}

            <label className="block text-sm font-medium mb-1">Comentário (opcional)</label>
            <textarea
              value={reqMoveComment}
              onChange={(e) => setReqMoveComment(e.target.value)}
              rows={3}
              className="w-full p-2 rounded-md border border-[var(--border)] bg-transparent focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              placeholder="Escreva um comentário para o histórico..."
            />
            <div className="mt-4 flex gap-2 justify-end">
              <button onClick={() => setReqMoveOpen(false)} className="px-3 py-2 rounded-md border border-[var(--border)] hover:bg-[var(--border)]/20">Cancelar</button>
              <button
                onClick={() => {
                  setReqMoveOpen(false);
                  const extra = reqDestinoStatus === 'Aprovado' ? {
                    etapa: reqDestinoEtapa,
                    sub_etapa: reqDestinoSub,
                    deferimento: (reqPreencherDeferimento ? {
                      DataProcedencia: toISODateFromPt(reqDefData) || '',
                      CreditoSimples: reqDefSimples !== '' ? Number(reqDefSimples) : null,
                      CreditoDobro: reqDefDobro !== '' ? Number(reqDefDobro) : null,
                      DataCreditoDobro: toISODateTimeFromPt(reqDefDataDobro) || '',
                    } : null),
                  } : {};
                  handleUpdateRequisicao(reqMoveTarget.id, reqDestinoStatus, reqMoveComment, extra);
                }}
                className="px-3 py-2 rounded-md bg-[var(--accent)] text-[var(--fg)]"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}

      </div>

      {ExportModal}
      {ImportModal}
      {AlertModal}
      {SaveModal}

      {createPortal(
        <>

          {reqNovaModalOpen && (
            <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" onClick={closeReqDrawer}>
              <div className="absolute inset-0 bg-black/50" />
              <div
                className="relative w-full max-w-6xl bg-[var(--panel-processos)] border panel-border rounded-lg shadow-xl p-5"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between gap-2 pb-3 border-b panel-border">
                  <div className="text-lg font-bold">Nova Requisição</div>
                  <button type="button" className="btn-outline" onClick={closeReqDrawer}>
                    Fechar
                  </button>
                </div>

                <div className="mt-4 grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr] gap-4">
                  <div className="space-y-3">
                    <div className="sap-card border panel-border p-3">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <div className="text-xs font-semibold">Informações</div>
                        <button
                          type="button"
                          onClick={openReqInfoEdit}
                          className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-[var(--panel-border)] bg-[var(--panel)] hover:bg-[var(--hover)] transition-colors"
                        >
                          <Pencil size={10} />
                          Alterar dados
                        </button>
                      </div>
                      <div className="grid grid-cols-1 gap-1 text-xs">
                        <div><b>UC:</b> {reqUc || '-'}</div>
                        <div><b>Cliente:</b> {reqCliente || '-'}</div>
                        <div><b>Concessionária:</b> {reqConc || '-'}</div>
                        <div><b>Irregularidade / Subirregularidade:</b> {toSentenceCase(reqIrregularidade) || '-'} {reqSubIrregularidade ? `/ ${reqSubIrregularidade}` : ''}</div>
                        <div><b>Valor estimado:</b> {formatCurrencyBR(reqValor)}</div>
                        <div><b>Criado em:</b> {formatDateTimeBR(reqCriado)}</div>
                        <div><b>Período:</b> {reqPeriodo || reqCounts.periodo || '-'}</div>
                        <div><b>Fatura:</b> {reqLink || '-'}</div>
                        <div><b>Anexos:</b> {reqCounts.anexos ?? 0}</div>
                        <div><b>Faturas:</b> {reqCounts.faturas ?? 0} {reqCounts.periodo ? `(${reqCounts.periodo})` : ''}</div>
                        <div>
                          <b>Descrição:</b>
                          <div style={{ whiteSpace: 'pre-wrap', maxHeight: '8.4em', lineHeight: '1.4em', overflowY: 'auto' }}
                            className="mt-0.5 text-[11px] opacity-75 border border-[var(--border)] rounded px-1.5 py-0.5 bg-[var(--bg)]">
                            {reqDescricao || '-'}
                          </div>
                        </div>
                      </div>
                      {Array.isArray(reqFaturas) && reqFaturas.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] uppercase font-semibold mb-1">Links de faturas</div>
                          <div className="space-y-1 text-[11px]">
                            {reqFaturas.map((f, idx) => {
                              const link = String(f?.link || f?.Link || '').trim();
                              const mes = formatMesRef(f?.mes_ref || f?.MesRef || '');
                              if (!link) return null;
                              return (
                                <div key={`req-fat-modal-${idx}`} className="flex items-center gap-1">
                                  {mes && <span className="font-medium">{mes}</span>}
                                  {mes && <span className="opacity-40">—</span>}
                                  <a className="text-[var(--accent)] underline" href={link} target="_blank" rel="noreferrer">
                                    Link
                                  </a>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="sap-card border panel-border p-3">
                      <div className="text-[11px] uppercase font-semibold mb-2">Classificação</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <select
                          className="input-themed w-full"
                          value={reqInfoDraft.id_tipo_irregularidade}
                          onChange={(e) => {
                            const v = e.target.value;
                            setReqInfoDraft((prev) => ({
                              ...prev,
                              id_tipo_irregularidade: v,
                              id_subtipo_irregularidade: '',
                            }));
                            saveReqClassificacao(v, '');
                          }}
                        >
                          <option value="">Irregularidade</option>
                          {reqTiposIrregularidade.map((t, idx) => {
                            const id = t?.id ?? t?.ID ?? t?.id_tipo ?? '';
                            const nome = t?.nome ?? t?.descricao ?? t?.name ?? '';
                            return (
                              <option key={`tipo-modal-${id}-${idx}`} value={id}>
                                {nome || `Tipo ${id}`}
                              </option>
                            );
                          })}
                        </select>
                        <select
                          className="input-themed w-full"
                          value={reqInfoDraft.id_subtipo_irregularidade}
                          onChange={(e) => {
                            const v = e.target.value;
                            setReqInfoDraft((prev) => ({ ...prev, id_subtipo_irregularidade: v }));
                            saveReqClassificacao(reqInfoDraft.id_tipo_irregularidade, v);
                          }}
                          disabled={!reqInfoDraft.id_tipo_irregularidade}
                        >
                          <option value="">Subirregularidade</option>
                          {reqSubtiposIrregularidade.map((s, idx) => {
                            const id = s?.id ?? s?.ID ?? s?.id_subtipo ?? '';
                            const nome = s?.nome ?? s?.descricao ?? s?.name ?? '';
                            return (
                              <option key={`subtipo-modal-${id}-${idx}`} value={id}>
                                {nome || `Subtipo ${id}`}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                      <div className="mt-1 text-[10px] opacity-60">Salva automaticamente ao selecionar.</div>
                    </div>

                    <div className="sap-card border panel-border p-3">
                      <div className="text-xs font-semibold mb-2">Comentário</div>
                      <textarea
                        rows={3}
                        value={reqComentario}
                        onChange={(e) => setReqComentario(e.target.value)}
                        placeholder="Comentário para o histórico"
                        className="w-full p-2 rounded border border-[var(--panel-border)] bg-[var(--panel)] text-[var(--fg)] text-xs mb-2"
                      />
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          className="btn-press px-2 py-1.5 rounded border border-[var(--panel-border)] bg-[var(--panel)] hover:opacity-90"
                          disabled={reqAnexoUploading}
                          onClick={() => reqAnexoInputRef.current?.click()}
                          title="Anexar"
                        >
                          <Paperclip size={14} />
                        </button>
                        <button
                          type="button"
                          className="btn-press text-[10px] px-2 py-1 rounded border border-[var(--panel-border)] bg-[var(--panel)] hover:opacity-90"
                          onClick={openReqAnexos}
                        >
                          Ver anexos
                        </button>
                        <button
                          type="button"
                          className="btn-press text-[10px] px-2 py-1 rounded border border-[var(--panel-border)] bg-[var(--panel)] hover:opacity-90"
                          onClick={handleReqComment}
                        >
                          Comentar
                        </button>
                      </div>
                      <input
                        ref={reqAnexoInputRef}
                        type="file"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleReqAnexar(file);
                          e.target.value = '';
                        }}
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="sap-card border panel-border p-3">
                      <div className="text-xs font-semibold mb-2">Histórico</div>
                      <div className="mt-2 space-y-2 text-xs max-h-[50vh] overflow-auto">
                        {reqHistoricoLoading ? (
                          <div className="opacity-70">Carregando histórico...</div>
                        ) : reqHistoryGroups.length === 0 ? (
                          <div className="opacity-70">Nenhum histórico.</div>
                        ) : (
                          reqHistoryGroups.map((group, gidx) => {
                            const items = (group.items || []).filter((h) => !isProcessoCriadoHistory(h));
                            if (!items.length) return null;
                            return (
                              <div
                                key={`req-modal-h-${gidx}`}
                                className="rounded-xl border panel-border bg-[var(--panel)]/30 p-2"
                              >
                                <div className="text-[11px] uppercase font-semibold mb-2">
                                  <b>Etapa:</b> {group.etapa}
                                </div>
                                <div className="space-y-2">
                                  {items.map((h, idx) => {
                                    const sub = h?.sub_etapa || h?.sub_etapa_nova || '';
                                    const comentario = h?.comentario || h?.descricao || '';
                                    const data = h?.data_movimentacao || h?.quando || h?.data || '';
                                    const usuarioNome =
                                      h?.usuario_nome || h?.nome_usuario || h?.user_name || h?.userName || '';
                                    const lines = formatHistoryComentarioLines(comentario);
                                    return (
                                      <div key={`req-modal-h-item-${gidx}-${idx}`} className="text-xs space-y-1">
                                        <div>
                                          {formatDateTimeBR(data)} - <b>Sub-etapa</b> {sub || '-'}
                                        </div>
                                        {lines.length > 0 ? (
                                          <div className="space-y-1">
                                            {lines.map((l, li) => (
                                              <div key={`req-modal-h-line-${gidx}-${idx}-${li}`}>{l}</div>
                                            ))}
                                          </div>
                                        ) : (
                                          <div>{comentario || '-'}</div>
                                        )}
                                        <div>
                                          <b>Por:</b> {usuarioNome || 'Sistema'}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>

                    <div className="sap-card border panel-border p-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <button
                          type="button"
                          className="btn-press req-btn-analise px-3 py-1.5 rounded-md border"
                          disabled={reqSaving}
                          onClick={() => handleUpdateRequisicao(reqDetails || selectedReqId, 'Em Análise', reqComentario)}
                        >
                          Em análise
                        </button>
                        <button
                          type="button"
                          className="btn-press req-btn-aprovar px-3 py-1.5 rounded-md border"
                          disabled={reqSaving}
                          onClick={() => handleUpdateRequisicao(reqDetails || selectedReqId, 'Aprovado', reqComentario)}
                        >
                          Aprovar
                        </button>
                        <button
                          type="button"
                          className="btn-press req-btn-rejeitar px-3 py-1.5 rounded-md border"
                          disabled={reqSaving}
                          onClick={() => handleUpdateRequisicao(reqDetails || selectedReqId, 'Rejeitado', reqComentario)}
                        >
                          Rejeitar
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {reqDrawerOpen && !reqNovaModalOpen && (
            <div className="fixed inset-0 z-[70]" onClick={closeReqDrawer}>
              <div className="absolute inset-0 bg-black/40" />
              <div
                className="absolute right-0 top-0 h-full w-full max-w-7xl bg-[var(--bg)] border-l border-[var(--border)] shadow-xl overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold">Triagem de Requisição</div>
                  <button
                    type="button"
                    onClick={closeReqDrawer}
                    className="px-2 py-1 rounded border border-[var(--border)] hover:bg-[var(--hover)]"
                  >
                    Fechar
                  </button>
                </div>

                <div className={`p-4 ${reqHistoricoOpen ? 'grid grid-cols-1 lg:grid-cols-[1fr_12px_1.4fr] gap-0' : 'space-y-4'}`}>
                  <div className={reqHistoricoOpen ? 'h-full overflow-auto pr-4 space-y-4' : 'space-y-4'}>
                  {(
                  <div className="sap-card border panel-border p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="text-xs font-semibold">Informações</div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setReqEmailModalOpen(true)}
                          className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg border font-semibold transition-colors"
                          style={{ borderColor: 'var(--accent)', color: 'var(--accent-2)', backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}
                          title="Gerar rascunho de email com IA baseado nesta requisição"
                        >
                          <Mail size={12} />
                          Gerar Email com IA
                        </button>
                        <button
                          type="button"
                          className="text-[11px] px-2 py-0.5 rounded border border-[var(--panel-border)] bg-[var(--panel)]"
                          onClick={openReqInfoEdit}
                        >
                          Editar
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-1 text-xs">
                      <div><b>UC:</b> {reqUc || '-'}</div>
                      <div><b>Cliente:</b> {reqCliente || '-'}</div>
                      <div><b>Concessionária:</b> {reqConc || '-'}</div>
                      <div><b>Irregularidade / Subirregularidade:</b> {toSentenceCase(reqIrregularidade) || '-'} {reqSubIrregularidade ? `/ ${reqSubIrregularidade}` : ''}</div>
                      <div><b>Valor estimado:</b> {formatCurrencyBR(reqValor)}</div>
                      <div><b>Criado em:</b> {formatDateTimeBR(reqCriado)}</div>
                      <div><b>Período:</b> {reqPeriodo || reqCounts.periodo || '-'}</div>
                      <div><b>Fatura:</b> {reqLink || '-'}</div>
                      {Array.isArray(reqFaturas) && reqFaturas.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] uppercase font-semibold mb-1">Links de faturas</div>
                          <div className="space-y-1 text-[11px]">
                            {reqFaturas.map((f, idx) => {
                              const link = String(f?.link || f?.Link || '').trim();
                              const mes = formatMesRef(f?.mes_ref || f?.MesRef || '');
                              if (!link) return null;
                              return (
                                <div key={`req-fat-${idx}`} className="flex items-center gap-1">
                                  {mes && <span className="font-medium">{mes}</span>}
                                  {mes && <span className="opacity-40">—</span>}
                                  <a className="text-[var(--accent)] underline" href={link} target="_blank" rel="noreferrer">
                                    Link
                                  </a>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      <div><b>Anexos:</b> {reqCounts.anexos ?? 0}</div>
                      <div><b>Faturas:</b> {reqCounts.faturas ?? 0} {reqCounts.periodo ? `(${reqCounts.periodo})` : ''}</div>
                      <div>
                        <b>Descrição:</b>
                        <div style={{ whiteSpace: 'pre-wrap', maxHeight: '8.4em', lineHeight: '1.4em', overflowY: 'auto' }}
                          className="mt-0.5 text-[11px] opacity-75 border border-[var(--border)] rounded px-1.5 py-0.5 bg-[var(--bg)]">
                          {reqDescricao || '-'}
                        </div>
                      </div>
                    </div>

                    {reqInfoHistoryItems.length > 0 ? (
                      <div className="mt-3">
                        <div className="text-[11px] uppercase font-semibold mb-2">Atualizações da requisição</div>
                        <div className="space-y-2">
                          {reqInfoHistoryItems.map((item, idx) => {
                            const dt = formatDateTimeBR(
                              pickFirst(item, ['hist_data', 'data_movimentacao', 'data', 'quando'], ''),
                            );
                            const comentario = pickFirst(item, ['hist_comentario', 'comentario', 'descricao'], '-');
                            return (
                              <div key={`req-info-${idx}`} className="text-xs rounded border panel-border p-2 bg-[var(--panel)]/40">
                                <div className="opacity-70">{dt}</div>
                                <div className="mt-1">{comentario}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  )}

                  <div className="sap-card border panel-border p-3">
                    <div className="text-xs font-semibold mb-2">
                      {isPreDecisao ? 'Comentário' : 'Tratativa da primeira reclamação'}
                    </div>
                    <textarea
                      rows={3}
                      value={reqComentario}
                      onChange={(e) => setReqComentario(e.target.value)}
                      placeholder="Comentário para o histórico"
                      className="w-full p-2 rounded border border-[var(--panel-border)] bg-[var(--panel)] text-[var(--fg)] text-xs mb-2"
                    />

                    <div className="flex items-center justify-between mb-2">
                      <button
                        type="button"
                        className="btn-press px-2 py-1.5 rounded border border-[var(--panel-border)] bg-[var(--panel)] hover:opacity-90"
                        disabled={reqAnexoUploading}
                        onClick={() => reqAnexoInputRef.current?.click()}
                        title="Anexar"
                      >
                        <Paperclip size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn-press text-[10px] px-2 py-1 rounded border border-[var(--panel-border)] bg-[var(--panel)] hover:opacity-90"
                        onClick={openReqAnexos}
                      >
                        Ver anexos
                      </button>
                      <input
                        ref={reqAnexoInputRef}
                        type="file"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleReqAnexar(file);
                          e.target.value = '';
                        }}
                      />
                    </div>

                    {!isPreDecisao && (
                      <div className="mb-3">
                        <div className="text-[11px] font-semibold mb-1">Canais de comunicação</div>
                        <CanaisSelector canais={reqCanais} onToggle={toggleReqCanal} />
                      </div>
                    )}

                    {isPreDecisao ? (
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <button
                          type="button"
                          className="btn-press req-btn-analise px-3 py-1.5 rounded-md border"
                          disabled={reqSaving}
                          onClick={() => handleUpdateRequisicao(reqDetails || selectedReqId, 'Em Análise', reqComentario)}
                        >
                          Em análise
                        </button>
                        <button
                          type="button"
                          className="btn-press req-btn-aprovar px-3 py-1.5 rounded-md border"
                          disabled={reqSaving}
                          onClick={() => handleUpdateRequisicao(reqDetails || selectedReqId, 'Aprovado', reqComentario)}
                        >
                          Aprovar
                        </button>
                        <button
                          type="button"
                          className="btn-press req-btn-rejeitar px-3 py-1.5 rounded-md border"
                          disabled={reqSaving}
                          onClick={() => handleUpdateRequisicao(reqDetails || selectedReqId, 'Rejeitado', reqComentario)}
                        >
                          Rejeitar
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <button
                          type="button"
                          className="btn-press px-3 py-1.5 rounded border border-[var(--panel-border)] bg-[var(--panel)] hover:opacity-90"
                          disabled={reqSaving}
                          onClick={handleReqComment}
                        >
                          Registrar comentário
                        </button>
                        <button
                          type="button"
                          className="btn-press req-btn-email px-3 py-1.5 rounded-md border border-[var(--panel-border)]"
                          onClick={() => {
                            setReqEmailOpen(true);
                            setReqEmailMinimized(false);
                          }}
                        >
                          Enviar e-mail
                        </button>
                        <button
                          type="button"
                          className="btn-press req-btn-ativos px-3 py-1.5 rounded-md border"
                          disabled={reqSaving}
                          onClick={handleReqCriarProcesso}
                        >
                          Criar processo
                        </button>
                      </div>
                    )}
                  </div>

                  </div>
                  {reqHistoricoOpen && (
                    <>
                      <div className="hidden lg:block h-full sap-divider" />
                      <div className="h-full overflow-auto pl-4">
                        <div className="sap-card border panel-border p-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-xs font-semibold">Histórico</div>
                            <button
                              type="button"
                              className="text-[11px] px-2 py-0.5 rounded border border-[var(--panel-border)] bg-[var(--panel)]"
                              onClick={() => setReqHistoricoOpen((prev) => !prev)}
                            >
                              Ocultar
                            </button>
                          </div>

                          <div className="mt-3 space-y-3 text-xs">
                            <div className="rounded-xl border panel-border bg-[var(--panel)]/30 p-2">
                              <div className="flex items-center justify-between gap-2 mb-2">
                                <div className="text-[11px] uppercase font-semibold">Informações</div>
                                <button
                                  type="button"
                                  onClick={openReqInfoEdit}
                                  className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-[var(--panel-border)] bg-[var(--panel)] hover:bg-[var(--hover)] transition-colors"
                                >
                                  <Pencil size={10} />
                                  Alterar dados
                                </button>
                              </div>
                              <div className="grid grid-cols-1 gap-1 text-xs">
                                <div><b>UC:</b> {reqUc || '-'}</div>
                                <div><b>Cliente:</b> {reqCliente || '-'}</div>
                                <div><b>Concessionária:</b> {reqConc || '-'}</div>
                                <div><b>Irregularidade / Subirregularidade:</b> {toSentenceCase(reqIrregularidade) || '-'} {reqSubIrregularidade ? `/ ${reqSubIrregularidade}` : ''}</div>
                                <div><b>Valor estimado:</b> {formatCurrencyBR(reqValor)}</div>
                                <div><b>Criado em:</b> {formatDateTimeBR(reqCriado)}</div>
                                <div><b>Período:</b> {reqPeriodo || reqCounts.periodo || '-'}</div>
                                <div><b>Faturas:</b> {reqCounts.faturas ?? 0}
                                  {Array.isArray(reqFaturas) && reqFaturas.length > 0 && (
                                    <span className="ml-1">
                                      {reqFaturas.map((f, idx) => {
                                        const link = String(f?.link || f?.Link || '').trim();
                                        const mes = formatMesRef(f?.mes_ref || f?.MesRef || '');
                                        if (!link) return null;
                                        return (
                                          <span key={`req-fat-c-${idx}`} className="ml-2">
                                            {mes && <span className="font-medium">{mes} — </span>}
                                            <a className="text-[var(--accent)] underline" href={link} target="_blank" rel="noreferrer">Link</a>
                                          </span>
                                        );
                                      })}
                                    </span>
                                  )}
                                </div>
                                <div><b>Anexos:</b> {reqCounts.anexos ?? 0}</div>
                                <div>
                          <b>Descrição:</b>
                          <div style={{ whiteSpace: 'pre-wrap', maxHeight: '8.4em', lineHeight: '1.4em', overflowY: 'auto' }}
                            className="mt-0.5 text-[11px] opacity-75 border border-[var(--border)] rounded px-1.5 py-0.5 bg-[var(--bg)]">
                            {reqDescricao || '-'}
                          </div>
                        </div>
                              </div>
                            </div>

                            {reqHistoricoLoading ? (
                              <div className="opacity-70">Carregando histórico...</div>
                            ) : reqHistoryGroups.length === 0 ? (
                              <div className="opacity-70">Nenhum histórico.</div>
                            ) : (
                              reqHistoryGroups.map((group, gidx) => (
                                <div
                                  key={`req-h-group-${gidx}`}
                                  className="rounded-xl border panel-border bg-[var(--panel)]/30 p-2"
                                >
                                  <div className="text-[11px] uppercase font-semibold mb-2">
                                    <b>Etapa:</b> {group.etapa}
                                  </div>
                                  <div className="space-y-2">
                                    {group.items.map((h, idx) => {
                                      const hid =
                                        h?.id_historico ?? h?.historico_id ?? h?.hist_id ?? h?.id ?? idx;
                                      const sub = h?.sub_etapa || h?.sub_etapa_nova || '';
                                      const comentario = h?.comentario || h?.descricao || '';
                                      const data = h?.data_movimentacao || h?.quando || h?.data || '';
                                      const usuarioNome =
                                        h?.usuario_nome || h?.nome_usuario || h?.user_name || h?.userName || '';
                                      return (
                                        <div
                                          key={`req-h-${hid}-${gidx}-${idx}`}
                                          className="text-xs space-y-1"
                                        >
                                          <div>
                                            {formatDateTimeBR(data)} - <b>Sub-etapa</b> {sub || '-'} - {comentario || '-'}
                                          </div>
                                          <div>
                                            <b>Por:</b> {usuarioNome || 'Sistema'}
                                          </div>
                                          {hid && (
                                            <button
                                              type="button"
                                              className="mt-2 text-[10px] px-2 py-0.5 rounded border border-[var(--panel-border)] bg-[var(--card)]"
                                              onClick={() => handleReqDeleteHistorico(hid)}
                                            >
                                              Excluir
                                            </button>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </div>
                    </>
                  )}

          {reqEmailOpen && reqEmailMinimized && (
            <button
              type="button"
              className="fixed right-5 bottom-5 z-[85] px-3 py-2 rounded-lg border border-[var(--panel-border)] bg-[var(--panel)] shadow-lg text-xs"
              onClick={() => setReqEmailMinimized(false)}
            >
              E-mail (minimizado)
            </button>
          )}

          {reqAnexosOpen && (
            <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/50" onClick={() => setReqAnexosOpen(false)} />
              <div className="relative w-full max-w-xl bg-[var(--panel)] border border-[var(--panel-border)] rounded-lg shadow-xl p-5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-lg font-bold">Anexos da requisição</div>
                  <button
                    type="button"
                    className="btn-outline text-xs"
                    onClick={() => setReqAnexosOpen(false)}
                  >
                    Fechar
                  </button>
                </div>
                <div className="mt-3 space-y-2 max-h-[60vh] overflow-auto text-sm">
                  {reqAnexosList.length === 0 ? (
                    <div className="opacity-70">Sem anexos.</div>
                  ) : (
                    reqAnexosList.map((a, idx) => {
                      const path = String(a.url || a.caminho_arquivo || '').trim();
                      const href = path.startsWith('http')
                        ? path
                        : path
                        ? `/${path.replace(/^\/+/, '')}`
                        : '';
                      const nome = a.nome_arquivo || a.nome || `Anexo ${idx + 1}`;
                      return (
                        <div key={`req-anx-${idx}`} className="flex items-center gap-2">
                          <Paperclip size={14} />
                          {href ? (
                            <a
                              className="text-[var(--accent)] underline break-all"
                              href={withAuthToken(href)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {nome}
                            </a>
                          ) : (
                            <span className="break-all">{nome}</span>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          {reqSaving && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center">
              <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
              <div className="relative flex items-center gap-3 rounded-lg border border-[var(--panel-border)] bg-[var(--panel)] px-4 py-3 shadow-lg">
                <div className="h-5 w-5 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
                <div className="text-sm font-medium">Processando...</div>
              </div>
            </div>
          )}

                  {!reqHistoricoOpen && (
                    <div className="sap-card border panel-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-semibold">Histórico</div>
                        <button
                          type="button"
                          className="text-[11px] px-2 py-0.5 rounded border border-[var(--panel-border)] bg-[var(--panel)]"
                          onClick={() => setReqHistoricoOpen(true)}
                        >
                          Histórico
                        </button>
                      </div>
                      <div className="text-[11px] opacity-70 mt-2">
                        Clique em Histórico para abrir ao lado.
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {reqInfoEditOpen && (
            <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/60" onClick={() => setReqInfoEditOpen(false)} />
              <div className="relative w-full max-w-3xl bg-[var(--panel-processos)] border panel-border rounded-lg shadow-xl p-5">
                <div className="flex items-center justify-between">
                  <div className="text-lg font-bold">Editar informações da requisição</div>
                  <button
                    className="btn-outline"
                    type="button"
                    onClick={() => setReqInfoEditOpen(false)}
                  >
                    Fechar
                  </button>
                </div>

                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] uppercase tracking-wide">UC</label>
                    <input
                      className="input-themed w-full mt-1"
                      value={reqInfoDraft.uc}
                      onChange={(e) => setReqInfoDraft((prev) => ({ ...prev, uc: e.target.value }))}
                      onBlur={async (e) => {
                        // Busca automática no sgeeasy (UC + UCs_Anteriores) ao sair do campo.
                        const ucv = String(e.target.value || '').trim();
                        if (ucv.replace(/\D/g, '').length < 4) return;
                        try {
                          const { data } = await api.get('/api/v1/faturas/buscar-uc', { params: { uc: ucv } });
                          if (data) {
                            setReqInfoDraft((prev) => ({
                              ...prev,
                              cliente: prev.cliente || data.cliente || data.razao_social || '',
                              concessionaria: prev.concessionaria || data.concessionaria || '',
                              link_fatura: prev.link_fatura || data.ultimo_link || '',
                            }));
                          }
                        } catch { /* UC não encontrada no sgeeasy — ignora */ }
                      }}
                    />
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-wide">Cliente</label>
                    <input
                      className="input-themed w-full mt-1"
                      value={reqInfoDraft.cliente}
                      onChange={(e) => setReqInfoDraft((prev) => ({ ...prev, cliente: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-wide">Concessionária</label>
                    <input
                      className="input-themed w-full mt-1"
                      value={reqInfoDraft.concessionaria}
                      onChange={(e) => setReqInfoDraft((prev) => ({ ...prev, concessionaria: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-wide">Valor estimado</label>
                    <input
                      className="input-themed w-full mt-1"
                      value={reqInfoDraft.valor_estimado}
                      onChange={(e) => setReqInfoDraft((prev) => ({ ...prev, valor_estimado: e.target.value }))}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-[11px] uppercase tracking-wide">Link de fatura</label>
                    <input
                      className="input-themed w-full mt-1"
                      value={reqInfoDraft.link_fatura}
                      onChange={(e) => setReqInfoDraft((prev) => ({ ...prev, link_fatura: e.target.value }))}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-[11px] uppercase tracking-wide">Períodos de irregularidade</label>
                    <input
                      className="input-themed w-full mt-1"
                      value={reqInfoDraft.periodos_irregularidade}
                      onChange={(e) =>
                        setReqInfoDraft((prev) => ({ ...prev, periodos_irregularidade: e.target.value }))
                      }
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-[11px] uppercase tracking-wide">Descrição</label>
                    <textarea
                      rows={3}
                      className="input-themed w-full mt-1"
                      value={reqInfoDraft.descricao_irregularidade}
                      onChange={(e) =>
                        setReqInfoDraft((prev) => ({ ...prev, descricao_irregularidade: e.target.value }))
                      }
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-[11px] uppercase tracking-wide">Endereço completo</label>
                    <textarea
                      rows={2}
                      className="input-themed w-full mt-1"
                      value={reqInfoDraft.endereco_completo}
                      onChange={(e) =>
                        setReqInfoDraft((prev) => ({ ...prev, endereco_completo: e.target.value }))
                      }
                    />
                  </div>
                </div>

                <div className="mt-4 flex justify-end gap-2">
                  <button className="btn-outline" type="button" onClick={() => setReqInfoEditOpen(false)}>
                    Cancelar
                  </button>
                  <button className="btn-themed" type="button" disabled={reqSaving} onClick={saveReqInfoEdit}>
                    Salvar
                  </button>
                </div>
              </div>
            </div>
          )}

          {reqEmailOpen && !reqEmailMinimized && (
            <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/50" onClick={() => setReqEmailOpen(false)} />
              <div
                className="relative w-full max-w-6xl bg-[var(--panel)] border border-[var(--panel-border)] rounded-lg shadow-xl p-5"
                style={{
                  transform: `translate(${reqEmailPos.x}px, ${reqEmailPos.y}px)`,
                }}
              >
                <div
                  className="flex items-center justify-between gap-2 cursor-move select-none"
                  onMouseDown={(e) => {
                    const ref = reqEmailDragRef.current;
                    ref.dragging = true;
                    ref.startX = e.clientX;
                    ref.startY = e.clientY;
                    ref.baseX = reqEmailPos.x;
                    ref.baseY = reqEmailPos.y;
                    const handleMove = (ev) => {
                      if (!ref.dragging) return;
                      const dx = ev.clientX - ref.startX;
                      const dy = ev.clientY - ref.startY;
                      setReqEmailPos({ x: ref.baseX + dx, y: ref.baseY + dy });
                    };
                    const handleUp = () => {
                      ref.dragging = false;
                      window.removeEventListener('mousemove', handleMove);
                      window.removeEventListener('mouseup', handleUp);
                    };
                    window.addEventListener('mousemove', handleMove);
                    window.addEventListener('mouseup', handleUp);
                  }}
                >
                  <div className="text-lg font-bold">E-mail</div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="btn-outline text-xs"
                      onClick={() => setReqEmailMinimized(true)}
                    >
                      Minimizar
                    </button>
                    <button
                      type="button"
                      className="btn-outline text-xs"
                      onClick={() => setReqEmailOpen(false)}
                    >
                      Fechar
                    </button>
                  </div>
                </div>
                <div className="mt-4 space-y-2">
                  <input
                    className="input-themed w-full"
                    placeholder="Destinatário"
                    value={reqEmail.to}
                    onChange={(e) => setReqEmail((prev) => ({ ...prev, to: e.target.value }))}
                  />
                  <input
                    className="input-themed w-full"
                    placeholder="Cc (opcional)"
                    value={reqEmail.cc}
                    onChange={(e) => setReqEmail((prev) => ({ ...prev, cc: e.target.value }))}
                  />
                  <input
                    className="input-themed w-full"
                    placeholder="Assunto"
                    value={reqEmail.subject}
                    onChange={(e) =>
                      setReqEmail((prev) => ({ ...prev, subject: e.target.value }))
                    }
                  />
                  <ReactQuill
                    theme="snow"
                    value={reqEmail.body}
                    onChange={(value) => setReqEmail((prev) => ({ ...prev, body: value }))}
                    modules={EMAIL_EDITOR_MODULES}
                    className="bg-[var(--panel)] text-[var(--fg)] rounded border panel-border min-h-[280px]"
                  />
                  <div className="rounded border panel-border bg-[var(--panel)]/20 p-2 text-xs">
                    <div className="text-[11px] uppercase font-semibold opacity-70 mb-1">Assinatura fixa</div>
                    <img src="/assinatura_complaint.png" alt="assinatura" className="max-w-[260px] h-auto" />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="btn-outline text-xs cursor-pointer inline-flex items-center gap-2">
                      <Paperclip size={14} />
                      Anexar arquivos
                      <input
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) =>
                          setReqEmail((prev) => ({
                            ...prev,
                            attachments: Array.from(e.target.files || []),
                          }))
                        }
                      />
                    </label>
                    <div className="text-[11px] opacity-70">
                      {reqEmail.attachments?.length
                        ? `${reqEmail.attachments.length} arquivo(s)`
                        : 'Sem anexos'}
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      className="btn-themed text-xs"
                      disabled={reqSaving}
                      onClick={handleReqSendEmail}
                    >
                      Enviar e vincular
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

        </>,
        document.body,
      )}
      {reqEmailModalOpen && (
        <ReqEmailModal
          reqInfo={reqDetails || {}}
          reqFaturas={reqFaturas || []}
          onClose={() => setReqEmailModalOpen(false)}
        />
      )}

      <style>{`
        .btn-action { padding: 6px 10px; border-radius: 6px; color: white; font-size: 12px; font-weight: bold; display: flex; align-items: center; gap: 6px; justify-content: center; }
        .btn-press { transition: transform 120ms ease, box-shadow 120ms ease; }
        .btn-press:active { transform: translateY(1px); box-shadow: inset 0 2px 4px rgba(0,0,0,0.15); }
        .req-btn-email { background: #e8ddc9; color: #111; }
        .req-btn-ativos { background: var(--success); border-color: #d4af37; color: #d4af37; }
        .req-btn-analise { background: var(--warning); border-color: color-mix(in srgb, var(--warning) 70%, black); color: #3a2c00; }
        .req-btn-aprovar { background: var(--success); border-color: color-mix(in srgb, var(--success) 70%, black); color: #f5f0c5; }
        .req-btn-rejeitar { background: var(--danger); border-color: color-mix(in srgb, var(--danger) 70%, black); color: #fff2f2; }
      `}</style>
    </div>
  );
}
