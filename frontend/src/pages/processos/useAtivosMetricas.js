// src/pages/processos/useAtivosMetricas.js
//
// Hook que encapsula o fetch das métricas da aba ATIVOS (cards do topo + meta + tempo médio).
// State + loadAtivosMetricas + boot effect. Os memos ativosResumo/ativosEtapasResumo ficam
// inline em AdminPlanilha porque dependem de tableRows (computado mais abaixo).
//
// Extraído de AdminPlanilha.jsx — Etapa 2d.2a.
//
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getMonthRange,
  formatDateBR,
} from '../utils/processosHelpers.js';
import { getRelatoriosMetricasBatch } from '../../services/relatoriosService';
import { getBacklog, getProcessosComPrazo } from '../../services/requisicaoService';

export default function useAtivosMetricas() {
  const [ativosMetricas, setAtivosMetricas] = useState({
    loading: true,
    all: null,
    month: null,
    meses12: null,
    ytd: null,
    backlog: null,
    prazos: null,
    error: '',
  });
  const [selectedMonthIdx, setSelectedMonthIdx] = useState(() => new Date().getMonth());
  const monthLabels = useMemo(
    () => ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
    [],
  );

  const loadAtivosMetricas = useCallback(async (signal) => {
    setAtivosMetricas((prev) => ({ ...prev, loading: true, error: '' }));

    const baseYear = 2026;
    const monthRange = getMonthRange(baseYear, selectedMonthIdx);
    const ytdRange = {
      start: new Date(baseYear, 0, 1),
      end: new Date(baseYear, selectedMonthIdx + 1, 0),
    };
    const meses12Range = {
      start: new Date(baseYear, selectedMonthIdx - 11, 1),
      end: new Date(baseYear, selectedMonthIdx + 1, 0),
    };

    const batchReqs = [
      { key: 'all' },
      { key: 'month', data_ini: formatDateBR(monthRange.start), data_fim: formatDateBR(monthRange.end) },
      { key: 'ytd',   data_ini: formatDateBR(ytdRange.start),   data_fim: formatDateBR(ytdRange.end) },
      { key: 'meses12', data_ini: formatDateBR(meses12Range.start), data_fim: formatDateBR(meses12Range.end) },
    ];

    const [batchRes, backlogRes, prazosRes] = await Promise.allSettled([
      getRelatoriosMetricasBatch(batchReqs),
      getBacklog(),
      getProcessosComPrazo(),
    ]);

    const batch = batchRes.status === 'fulfilled' ? batchRes.value : {};
    const next = {
      loading: false,
      all: batch.all ?? null,
      month: batch.month ?? null,
      ytd: batch.ytd ?? null,
      meses12: batch.meses12 ?? null,
      backlog: backlogRes.status === 'fulfilled' ? backlogRes.value : null,
      prazos: prazosRes.status === 'fulfilled' ? prazosRes.value : null,
      error: '',
    };

    if (batchRes.status === 'rejected') {
      next.error = 'Falha ao carregar métricas.';
    }

    if (signal?.aborted) return;
    setAtivosMetricas(next);
  }, [selectedMonthIdx]);

  useEffect(() => {
    const controller = new AbortController();
    loadAtivosMetricas(controller.signal);
    return () => controller.abort();
  }, [loadAtivosMetricas]);

  return {
    ativosMetricas,
    selectedMonthIdx,
    setSelectedMonthIdx,
    monthLabels,
    loadAtivosMetricas,
  };
}
