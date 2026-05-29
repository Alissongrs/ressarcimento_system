// src/pages/processos/useProcessoDrawerState.js
//
// Hook que bundla o STATE + callbacks puros do drawer/move/history/summary do processo.
// Callbacks com deps cruzadas (loadHistoryDetails, attachHistoryAnexo, handleSaveProcesso,
// handleConcluirProcesso, updateRelevancia, updateSuspenso, saveHistory, openEditHistory,
// openDrawer, deleteProcessoAnexo, requestPaneMove, etc.) ficam em AdminPlanilha porque
// dependem de muitos setters e services compartilhados — extração caso-a-caso.
//
// Extraído de AdminPlanilha.jsx — Etapa 2d.2d + 2d.2d.ii.
//
import { useCallback, useRef, useState } from 'react';
import { DEFAULT_CANAIS } from '../utils/processosHelpers.js';
import { getSummary, refreshSummary } from '../../services/summaryService';

export default function useProcessoDrawerState() {
  // Move
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

  // Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedPid, setSelectedPid] = useState(null);
  const [drawerPane, setDrawerPane] = useState('');

  // Edição de histórico
  const [historyEditOpen, setHistoryEditOpen] = useState(false);
  const [historyDraft, setHistoryDraft] = useState([]);
  const [historyDeletes, setHistoryDeletes] = useState([]);

  // Snapshot/header data
  const [snapshotHeaderData, setSnapshotHeaderData] = useState(null);
  const [requisicaoHeaderData, setRequisicaoHeaderData] = useState(null);
  const [processoAnexos, setProcessoAnexos] = useState([]);

  // IA summary
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
  const refreshTimerRef = useRef(null);

  // Busca global no histórico
  const [historyMatches, setHistoryMatches] = useState(new Set());
  const [historyLoading, setHistoryLoading] = useState(false);

  // Histórico detalhado por PID
  const [historyByPid, setHistoryByPid] = useState({});
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const [historyAnexoUploading, setHistoryAnexoUploading] = useState({});
  const historyLoadedRef = useRef(new Set());

  // ── Callbacks puros ──

  const removeHistoryRow = useCallback((idx) => {
    setHistoryDraft((prev) => {
      const arr = [...(prev || [])];
      const item = arr[idx];
      if (item?.id_historico) setHistoryDeletes((d) => [...(d || []), Number(item.id_historico)]);
      arr.splice(idx, 1);
      return arr;
    });
  }, []);

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
          if (status === 'ready' || status === 'error') stopSummaryPoll();
        } catch {
          stopSummaryPoll();
        }
      }, 3000);
    },
    [stopSummaryPoll],
  );

  const loadSummary = useCallback(
    async (pid) => {
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

        setSummaryState({ status, text, loading: false, error: '' });
        if (status === 'pending') startSummaryPoll(pid);
      } catch (err) {
        setSummaryState((prev) => ({
          ...prev,
          loading: false,
          error: err?.message || 'Falha ao carregar resumo.',
        }));
      }
    },
    [startSummaryPoll],
  );

  const closeDrawer = useCallback(() => {
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
  }, [stopSummaryPoll]);

  return {
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
  };
}
