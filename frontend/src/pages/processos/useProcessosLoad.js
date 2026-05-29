// src/pages/processos/useProcessosLoad.js
//
// Hook que encapsula o carregamento (loadAll/syncLoadAll) e o state de paginação
// (columnLimits, fullLoadEnabled) da view de processos.
// Recebe setters compartilhados (rows, kanbanMap, relevanciaMap, loading, toast,
// isSyncing) como deps, e a função loadAtivosMetricas (vinda de useAtivosMetricas)
// para encadeamento em syncLoadAll.
//
// Extraído de AdminPlanilha.jsx — Etapa 2d.2e.
//
import { useCallback, useRef, useState } from 'react';
import {
  ETAPA_TABS,
  INITIAL_COLUMN_LIMIT,
  buildRowsFromKanbanFast,
} from '../utils/processosHelpers.js';
import { getProcessosKanbanFast } from '../../services/requisicaoService';

export default function useProcessosLoad({
  setRows,
  setKanbanMap,
  setRelevanciaMap,
  setLoading,
  setLoadingAll,
  setToast,
  setIsSyncing,
  loadAtivosMetricas,
}) {
  const [columnLimits, setColumnLimits] = useState(
    () => Object.fromEntries(ETAPA_TABS.map((t) => [t.label, INITIAL_COLUMN_LIMIT])),
  );
  const [fullLoadEnabled, setFullLoadEnabled] = useState(true);
  const loadingAllRef = useRef(false);

  const loadAll = useCallback(
    async (opts = {}) => {
      const shouldFull = opts.full ?? fullLoadEnabled;
      const force = !!opts.force;

      if (loadingAllRef.current && !force) return;
      loadingAllRef.current = true;

      setLoadingAll(true);
      setLoading(true);

      try {
        const data = await getProcessosKanbanFast({ limit: shouldFull ? 0 : INITIAL_COLUMN_LIMIT });

        const built = buildRowsFromKanbanFast(data);

        setRows(built.rows);
        setKanbanMap(built.map);
        setRelevanciaMap(built.relMap);

        setColumnLimits(
          Object.fromEntries(
            ETAPA_TABS.map((t) => [t.label, shouldFull ? 0 : INITIAL_COLUMN_LIMIT]),
          ),
        );
        setFullLoadEnabled(shouldFull);
      } catch (err) {
        console.error('Falha ao carregar processos (kanban-fast):', err);
        setRows([]);
        setKanbanMap({});
        setRelevanciaMap({});
        setToast({ open: true, type: 'error', text: err?.message || 'Falha ao carregar processos.' });
      } finally {
        setLoading(false);
        setLoadingAll(false);
        loadingAllRef.current = false;
      }
    },
    [fullLoadEnabled, setRows, setKanbanMap, setRelevanciaMap, setLoading, setLoadingAll, setToast],
  );

  const load = useCallback(async (opts = {}) => loadAll(opts), [loadAll]);

  const syncLoadAll = useCallback(async () => {
    setIsSyncing(true);
    try {
      await loadAll({ force: true });
      await loadAtivosMetricas();
    } finally {
      setIsSyncing(false);
    }
  }, [loadAll, loadAtivosMetricas, setIsSyncing]);

  return {
    columnLimits,
    setColumnLimits,
    fullLoadEnabled,
    setFullLoadEnabled,
    loadingAllRef,
    loadAll,
    load,
    syncLoadAll,
  };
}
