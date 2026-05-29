// src/pages/processos/useProcessosFiltros.js
//
// Hook que encapsula todo o state de filtros + ordenação da view de processos.
// Extraído de AdminPlanilha.jsx — Etapa 2d.2b.
//
import { useState } from 'react';

export default function useProcessosFiltros() {
  const [kanbanFilter, setKanbanFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [showAllRows, setShowAllRows] = useState(true);

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

  return {
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
  };
}
