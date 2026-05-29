// src/pages/processos/ProcessosKanbanView.jsx
//
// View JSX-pura do Kanban de Processos. Recebe todo o state via props.
//
// Redesign visual:
//   1. Métricas em hierarquia — hero (HalfPieCard + Valor em carteira) + KPI strip compacta + charts.
//   2. Tabela escaneável — Cliente+UC mesclados, status pill sólida, score como mini-barra.
//   3. Filtros avançados em drawer lateral à direita + chips ativos no topo da tabela.
//
import React from 'react';
import { Activity, RefreshCcw, X, Pencil, SlidersHorizontal } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  KANBAN_COLUNAS,
  PROCESS_LIST_COLUMNS,
  formatCurrencyBR,
  pickFirst,
  toNumberValue,
  rowLastTs,
  norm,
} from './../utils/processosHelpers.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers visuais
// ─────────────────────────────────────────────────────────────────────────────

// Pill sólida de status colorida por etapa (legível em qualquer tema)
function StatusPill({ etapa, sub }) {
  const label = `${etapa || '-'}${sub ? ` · ${sub}` : ''}`;
  const k = norm(etapa);
  let bg = '#64748b'; // slate
  if (k.includes('distrib')) bg = '#3b82f6';
  else if (k.includes('ouvid')) bg = '#10b981';
  else if (k.includes('aneel')) bg = '#f59e0b';
  else if (k.includes('sma')) bg = '#a855f7';
  else if (k.includes('financeiro') || k.includes('enviado')) bg = '#0891b2';
  else if (k.includes('repasse') || k.includes('fatur')) bg = '#f97316';
  else if (k.includes('conclu')) bg = '#059669';
  else if (k.includes('indefer')) bg = '#ef4444';
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold leading-tight whitespace-nowrap"
      style={{ background: bg, color: '#fff' }}
      title={label}
    >
      {label}
    </span>
  );
}

// Mini-barra horizontal pra score de progressão
function ScoreBar({ score }) {
  if (score === undefined || score === null) {
    return <span className="text-[10px] opacity-40">—</span>;
  }
  const raw = typeof score === 'object' ? score?.percentual : score;
  if (raw === undefined || raw === null || Number.isNaN(Number(raw))) {
    return <span className="text-[10px] opacity-40">—</span>;
  }
  const pct = Math.max(0, Math.min(100, Number(raw)));
  const color = pct >= 70 ? '#10b981' : pct >= 40 ? '#f59e0b' : '#ef4444';
  return (
    <div className="w-full flex items-center gap-1.5">
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
        <div
          className="h-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="text-[10px] font-semibold tabular-nums opacity-80 w-7 text-right">
        {pct.toFixed(0)}
      </span>
    </div>
  );
}

// KPI compacto pra strip secundária
function KpiCompact({ label, value, accent }) {
  const accentColor =
    accent === 'red' ? 'text-red-500' :
    accent === 'amber' ? 'text-amber-500' :
    accent === 'emerald' ? 'text-emerald-500' :
    'text-[var(--fg)]';
  return (
    <div className="rounded-md border panel-border bg-[var(--panel)]/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide opacity-60 mb-0.5 truncate">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${accentColor}`}>{value}</div>
    </div>
  );
}

export default function ProcessosKanbanView({
  // Dados
  filteredRows,
  filteredRowsAll,
  ativosMetricas,
  ativosResumo,
  ativosEtapasResumo,
  scoreData,

  // UI state
  activeTab,
  showAtivosMetricas,
  setShowAtivosMetricas,
  selectedMonthIdx,
  setSelectedMonthIdx,
  monthLabels,
  q,
  setQ,
  qDebounced,
  showFilters,
  setShowFilters,
  sortField,
  setSortField,
  sortDir,
  setSortDir,
  showAllRows,
  setShowAllRows,
  kanbanFilter,
  setKanbanFilter,
  processColWidths,
  processSort,
  setProcessSort,
  processResizeRef,

  // Filtros avançados
  filtroCliente,
  setFiltroCliente,
  filtroConcessionaria,
  setFiltroConcessionaria,
  filtroUC,
  setFiltroUC,
  filtroId,
  setFiltroId,
  filtroEtapa,
  setFiltroEtapa,
  filtroSubEtapa,
  setFiltroSubEtapa,
  filtroRelevancia,
  setFiltroRelevancia,
  filtroSuspenso,
  setFiltroSuspenso,
  filtroDataIni,
  setFiltroDataIni,
  filtroDataFim,
  setFiltroDataFim,
  filtroValorMin,
  setFiltroValorMin,
  filtroValorMax,
  setFiltroValorMax,

  // Loading / busca
  loading,
  isSyncing,
  historyLoading,
  searchResultsCount,
  searchResultsSummary,
  historyMatchesSummary,

  // Modais
  setExportOpen,
  setImportOpen,

  // Handlers
  syncLoadAll,
  handleProcessCardOpen,
  openReqInfoEditFromRow,

  // Subcomponentes
  TabBar,
  HalfPieCard,
}) {
  // Chips ativos pra refletir filtros aplicados sem precisar abrir o drawer
  const activeFilters = [];
  if (filtroCliente) activeFilters.push({ label: `Cliente: ${filtroCliente}`, clear: () => setFiltroCliente('') });
  if (filtroConcessionaria) activeFilters.push({ label: `Concess.: ${filtroConcessionaria}`, clear: () => setFiltroConcessionaria('') });
  if (filtroUC) activeFilters.push({ label: `UC: ${filtroUC}`, clear: () => setFiltroUC('') });
  if (filtroId) activeFilters.push({ label: `ID: ${filtroId}`, clear: () => setFiltroId('') });
  if (filtroEtapa) activeFilters.push({ label: `Etapa: ${filtroEtapa}`, clear: () => setFiltroEtapa('') });
  if (filtroSubEtapa) activeFilters.push({ label: `Sub: ${filtroSubEtapa}`, clear: () => setFiltroSubEtapa('') });
  if (kanbanFilter) activeFilters.push({ label: `Coluna: ${kanbanFilter}`, clear: () => setKanbanFilter('') });
  if (filtroRelevancia && filtroRelevancia !== 'todos') {
    activeFilters.push({ label: `Relevância: ${filtroRelevancia === 'relevante' ? 'sim' : 'não'}`, clear: () => setFiltroRelevancia('todos') });
  }
  if (filtroSuspenso) activeFilters.push({ label: 'Somente suspensos', clear: () => setFiltroSuspenso(false) });
  if (filtroDataIni) activeFilters.push({ label: `De: ${filtroDataIni}`, clear: () => setFiltroDataIni('') });
  if (filtroDataFim) activeFilters.push({ label: `Até: ${filtroDataFim}`, clear: () => setFiltroDataFim('') });
  if (filtroValorMin) activeFilters.push({ label: `Min: ${filtroValorMin}`, clear: () => setFiltroValorMin('') });
  if (filtroValorMax) activeFilters.push({ label: `Max: ${filtroValorMax}`, clear: () => setFiltroValorMax('') });

  const clearAllFilters = () => {
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
    setKanbanFilter('');
  };

  return (
    <div className="space-y-3 px-1 sm:px-2">
      {activeTab === 'ATIVOS' ? (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button
              type="button"
              className="btn-outline text-xs"
              onClick={() => setShowAtivosMetricas((v) => !v)}
            >
              {showAtivosMetricas ? 'Ocultar métricas' : 'Mostrar métricas'}
            </button>
          </div>

          {showAtivosMetricas && (
            <div className="space-y-3">
              {ativosMetricas.loading ? (
                <div className="text-xs opacity-70 inline-flex items-center gap-2">
                  <Activity className="h-4 w-4 animate-spin opacity-70" />
                  Carregando métricas...
                </div>
              ) : null}

              {ativosMetricas.error ? (
                <div className="text-xs text-red-400">{ativosMetricas.error}</div>
              ) : null}

              {/* HERO ROW — Meta de ressarcimento + Valor em carteira */}
              <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-3 items-stretch">
                <HalfPieCard
                  title={`Meta de ressarcimento (${monthLabels[selectedMonthIdx]})`}
                  value={ativosResumo.ressarcimentoMonth}
                  goal={417000}
                  progressTotal={5000000}
                  progressValue={ativosResumo.ressarcimentoTotal}
                  progressLabel="Meta total"
                  className="border-2 shadow-lg h-full"
                  footer={(
                    <div className="flex flex-wrap gap-2">
                      {monthLabels.map((label, idx) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => setSelectedMonthIdx(idx)}
                          className={`px-2.5 py-1 rounded border text-xs font-semibold transition ${
                            selectedMonthIdx === idx
                              ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                              : 'bg-[var(--panel)] text-[var(--fg)] border-[var(--panel-border)] hover:bg-[var(--hover)]'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                />

                <div className="rounded-xl border-2 panel-border bg-gradient-to-br from-[var(--panel)] to-[var(--panel)]/50 p-5 shadow-lg flex flex-col justify-between min-h-[220px]">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider opacity-70 mb-1">Valor em carteira</div>
                    <div className="text-4xl lg:text-5xl font-extrabold tabular-nums text-[var(--accent)] leading-tight">
                      {formatCurrencyBR(ativosResumo.valorTotal)}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t panel-border">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide opacity-60">Ticket médio</div>
                      <div className="text-base font-semibold tabular-nums">{formatCurrencyBR(ativosResumo.ticketMedio)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide opacity-60">Em carteira</div>
                      <div className="text-base font-semibold tabular-nums">{ativosResumo.totalElegiveis ?? 0} processos</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* KPI STRIP — indicadores secundários compactos */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <KpiCompact
                  label="Processos no backlog"
                  value={`${ativosResumo.backlogTotal ?? 0} (${Number(ativosResumo.backlogPct || 0).toFixed(1)}%)`}
                  accent="amber"
                />
                <KpiCompact
                  label="Prazos vencidos"
                  value={ativosResumo.vencidos ?? 0}
                  accent="red"
                />
                <KpiCompact
                  label="Casos relevantes"
                  value={`${Number(ativosResumo.relevantesPct || 0).toFixed(1)}%`}
                />
                <KpiCompact
                  label="Total processos"
                  value={ativosResumo.totalProcessos ?? 0}
                />
              </div>

              {/* CHARTS ROW */}
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-3">
                <div className="sap-card border panel-border p-3">
                  <div className="text-xs uppercase opacity-70 mb-2">Ativos por etapa</div>
                  <div className="grid grid-cols-1 gap-2 text-sm">
                    {ativosEtapasResumo.length === 0 ? (
                      <div className="text-xs opacity-70">Sem dados de etapas para Ativos.</div>
                    ) : (
                      ativosEtapasResumo.map((item) => (
                        <div
                          key={item.label}
                          className="flex items-center justify-between gap-3 border panel-border rounded px-2 py-1"
                        >
                          <div className="truncate">{item.label}</div>
                          <div className="text-xs opacity-80">
                            {item.count} ({Number(item.percent || 0).toFixed(1)}%)
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="sap-card border panel-border p-3 h-full">
                  <div className="text-xs uppercase opacity-70 mb-2">
                    Tempo médio por etapa (dias)
                  </div>
                  <div className="h-[180px]">
                    {(ativosMetricas.all?.tempo_medio_dias_por_etapa || []).length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={[...(ativosMetricas.all?.tempo_medio_dias_por_etapa || [])].sort(
                            (a, b) => Number(b.dias || 0) - Number(a.dias || 0),
                          )}
                          margin={{ top: 8, right: 8, left: 0, bottom: 8 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                          <XAxis
                            dataKey="etapa"
                            tick={{ fontSize: 10 }}
                            interval={0}
                            angle={-10}
                            height={40}
                          />
                          <YAxis tick={{ fontSize: 11 }} />
                          <Tooltip formatter={(v) => `${Number(v || 0).toFixed(1)} dias`} />
                          <Bar dataKey="dias" fill="var(--accent)" radius={[6, 6, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="text-xs opacity-70">Sem dados de tempo médio.</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      <div className="p-3 rounded-xl border panel-border panel-bg-60">
        <div className="text-xs uppercase tracking-wide opacity-70 mb-3">Abas</div>
        <TabBar />
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full lg:w-[25%] min-w-[220px]">
            <div className="sap-card p-2 border panel-border">
              <div className="flex items-center gap-2">
                <input
                  className="input-themed w-full"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Buscar por ID, UC, cliente, etapa, comentário do histórico..."
                />
                <button
                  className="btn-outline"
                  type="button"
                  onClick={() => setQ('')}
                  title="Limpar"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
          </div>

          <button
            className="btn-outline text-xs inline-flex items-center gap-2"
            type="button"
            onClick={syncLoadAll}
            disabled={isSyncing || loading}
            title="Atualizar agora"
          >
            <RefreshCcw className={`h-4 w-4 ${isSyncing || loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>

          <button
            className="btn-outline text-xs inline-flex items-center gap-2 relative"
            type="button"
            onClick={() => setShowFilters(true)}
          >
            <SlidersHorizontal size={14} />
            Filtros avançados
            {activeFilters.length > 0 && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--accent)] text-white text-[10px] font-bold">
                {activeFilters.length}
              </span>
            )}
          </button>

          <button className="btn-outline text-xs" type="button" onClick={() => setExportOpen(true)}>
            Exportar CSV
          </button>

          <button className="btn-outline text-xs" type="button" onClick={() => setImportOpen(true)}>
            Importar CSV
          </button>

          <div className="ml-auto sap-card p-2 border panel-border">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold opacity-70">Ordenação / Visão</span>
              <select
                className="input-themed text-xs h-8 min-w-[170px]"
                value={sortField}
                onChange={(e) => setSortField(e.target.value)}
              >
                <option value="data">Data</option>
                <option value="id">ID</option>
                <option value="valor">Valor</option>
              </select>
              <select
                className="input-themed text-xs h-8 min-w-[96px]"
                value={sortDir}
                onChange={(e) => setSortDir(e.target.value)}
              >
                <option value="desc">Desc</option>
                <option value="asc">Asc</option>
              </select>
              <label className="flex items-center gap-2 text-xs opacity-80">
                <input
                  type="checkbox"
                  checked={showAllRows}
                  onChange={(e) => setShowAllRows(e.target.checked)}
                />
                Mostrar tudo
              </label>
              <span className="text-xs opacity-70">Modo: Full</span>
            </div>
          </div>
        </div>

        {/* Chips de filtros ativos */}
        {activeFilters.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {activeFilters.map((f, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--fg)]"
              >
                {f.label}
                <button
                  type="button"
                  onClick={f.clear}
                  className="opacity-60 hover:opacity-100 transition-opacity"
                  title="Remover filtro"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            <button
              type="button"
              className="text-[11px] opacity-70 hover:opacity-100 underline ml-1"
              onClick={clearAllFilters}
            >
              Limpar todos
            </button>
          </div>
        )}

        {qDebounced?.trim() ? (
          <div className="mt-2 text-xs opacity-70">
            <div>
              Resultados: <b>{searchResultsCount}</b>
              {historyLoading ? (
                <span className="inline-flex items-center gap-2 ml-2">
                  <Activity className="h-3.5 w-3.5 animate-spin opacity-70" />
                  Buscando no histórico...
                </span>
              ) : null}
            </div>
            {searchResultsSummary ? <div>Por aba: {searchResultsSummary}</div> : null}
            {historyMatchesSummary ? <div>Matches no histórico: {historyMatchesSummary}</div> : null}
          </div>
        ) : null}

        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="text-xs opacity-70">
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <Activity className="h-4 w-4 animate-spin opacity-70" />
                Carregando...
              </span>
            ) : (
              <span>
                Exibindo <b>{filteredRows.length}</b> de <b>{filteredRowsAll.length}</b>
              </span>
            )}
          </div>
        </div>

        <div className="mt-3 border panel-border rounded-lg overflow-hidden">
          <div
            className="grid text-xs font-semibold bg-[var(--panel)] sticky top-0 z-10"
            style={{ gridTemplateColumns: processColWidths.map((w) => `${w}px`).join(' ') }}
          >
            {PROCESS_LIST_COLUMNS.map((col, idx) => (
              <button
                key={col.key}
                type="button"
                onClick={() => {
                  if (!col.sortable) return;
                  setProcessSort((prev) => {
                    if (prev.key !== col.key) return { key: col.key, dir: 'asc' };
                    return { key: prev.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
                  });
                }}
                className="relative px-2 py-2 border-r panel-border uppercase tracking-wide select-none text-left"
                style={{ width: processColWidths[idx] }}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {processSort.key === col.key && (
                    <span className="text-[10px] opacity-70">
                      {processSort.dir === 'asc' ? '▲' : '▼'}
                    </span>
                  )}
                </span>
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    processResizeRef.current = {
                      idx,
                      startX: e.clientX,
                      startW: processColWidths[idx],
                    };
                  }}
                  className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                  title="Arraste para ajustar"
                />
              </button>
            ))}
          </div>
          <div className="max-h-[70vh] overflow-auto">
            {(() => {
              const sortedRows = [...(filteredRows || [])];
              const dir = processSort.dir === 'asc' ? 1 : -1;
              const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
              sortedRows.sort((a, b) => {
                const ha = a?.header || {};
                const hb = b?.header || {};
                switch (processSort.key) {
                  case 'id':
                    return (a.pid - b.pid) * dir;
                  case 'cliente': {
                    const va = pickFirst(ha, ['cliente', 'Cliente'], '');
                    const vb = pickFirst(hb, ['cliente', 'Cliente'], '');
                    return collator.compare(va, vb) * dir;
                  }
                  case 'valor': {
                    const va = Number(toNumberValue(pickFirst(ha, ['ressarcimento_estimado', 'valor_estimado', 'valor'], 0)) || 0);
                    const vb = Number(toNumberValue(pickFirst(hb, ['ressarcimento_estimado', 'valor_estimado', 'valor'], 0)) || 0);
                    return (va - vb) * dir;
                  }
                  case 'concessionaria': {
                    const va = pickFirst(ha, ['concessionaria', 'Concessionaria'], '');
                    const vb = pickFirst(hb, ['concessionaria', 'Concessionaria'], '');
                    return collator.compare(va, vb) * dir;
                  }
                  case 'status': {
                    const etapaA = pickFirst(ha, ['etapa_atual', 'etapa', 'Etapa'], '');
                    const etapaB = pickFirst(hb, ['etapa_atual', 'etapa', 'Etapa'], '');
                    const subA = pickFirst(ha, ['sub_etapa', 'SubEtapa'], '');
                    const subB = pickFirst(hb, ['sub_etapa', 'SubEtapa'], '');
                    const va = `${etapaA} ${subA}`.trim();
                    const vb = `${etapaB} ${subB}`.trim();
                    return collator.compare(va, vb) * dir;
                  }
                  case 'ultima': {
                    const va = rowLastTs(a);
                    const vb = rowLastTs(b);
                    return (va - vb) * dir;
                  }
                  case 'dias_sem': {
                    const va = rowLastTs(a);
                    const vb = rowLastTs(b);
                    const now = Date.now();
                    const da = va ? Math.floor((now - va) / 86400000) : -1;
                    const db = vb ? Math.floor((now - vb) / 86400000) : -1;
                    return (da - db) * dir;
                  }
                  default:
                    return 0;
                }
              });
              return sortedRows.map((row) => {
                const header = row?.header || {};
                const uc = pickFirst(header, ['uc', 'Uc', 'UC'], '-');
                const cliente = pickFirst(header, ['cliente', 'Cliente'], '-');
                const conc = pickFirst(header, ['concessionaria', 'Concessionaria'], '-');
                const estimado = formatCurrencyBR(
                  pickFirst(header, ['ressarcimento_estimado', 'valor_estimado', 'valor'], ''),
                );
                const etapaAtual = pickFirst(header, ['etapa_atual', 'etapa', 'Etapa'], '');
                const subAtual = pickFirst(header, ['sub_etapa', 'SubEtapa'], '');
                const lastTs = rowLastTs(row);
                const lastLabel = lastTs ? new Date(lastTs).toLocaleString('pt-BR') : '-';
                const diasSemNum = lastTs && Number.isFinite(lastTs)
                  ? Math.max(0, Math.floor((Date.now() - lastTs) / 86400000))
                  : null;
                const diasSemColor =
                  diasSemNum == null ? 'opacity-50' :
                  diasSemNum > 30 ? 'text-red-500 font-semibold' :
                  diasSemNum > 14 ? 'text-amber-500 font-semibold' :
                  'opacity-80';
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
                const warnMissingSteps =
                  (hasFaturamento && (!hasDeferimento || !hasFluxo)) ||
                  (hasFluxo && !hasDeferimento);
                return (
                  <button
                    key={row.pid}
                    type="button"
                    onClick={() => handleProcessCardOpen(row)}
                    className={`grid w-full text-left text-sm hover:bg-[var(--hover)] transition-colors ${warnMissingSteps ? 'bg-red-500/10' : ''}`}
                    style={{ gridTemplateColumns: processColWidths.map((w) => `${w}px`).join(' ') }}
                  >
                    <div className="px-2 py-2 border-t panel-border truncate font-mono text-xs">#{row.pid}</div>
                    <div className="px-2 py-2 border-t panel-border min-w-0">
                      <div className="font-semibold truncate">{cliente}</div>
                      <div className="text-[11px] opacity-60 truncate">UC {uc}</div>
                    </div>
                    <div className="px-2 py-2 border-t panel-border truncate tabular-nums">{estimado}</div>
                    <div className="px-2 py-2 border-t panel-border truncate">{conc}</div>
                    <div className="px-2 py-2 border-t panel-border min-w-0">
                      <StatusPill etapa={etapaAtual} sub={subAtual} />
                    </div>
                    <div className="px-2 py-2 border-t panel-border truncate text-xs opacity-80">{lastLabel}</div>
                    <div className={`px-2 py-2 border-t panel-border truncate text-xs ${diasSemColor}`}>
                      {diasSemNum == null ? '-' : `${diasSemNum} dias`}
                    </div>
                    <div className="px-2 py-2 border-t panel-border flex items-center min-w-0">
                      {activeTab === 'ATIVOS' ? (
                        <ScoreBar score={row.header?.score_percentual ?? scoreData[row.pid]} />
                      ) : (
                        <span className="text-xs opacity-50">—</span>
                      )}
                    </div>
                    <div className="px-1 py-2 border-t panel-border flex items-center justify-center">
                      <button
                        type="button"
                        title="Editar cabeçalho"
                        onClick={(e) => { e.stopPropagation(); openReqInfoEditFromRow(row); }}
                        className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-[var(--hover)] text-[var(--fg)] opacity-60 hover:opacity-100 transition-opacity"
                      >
                        <Pencil size={12} />
                      </button>
                    </div>
                  </button>
                );
              });
            })()}
          </div>
        </div>

        {(!filteredRows || filteredRows.length === 0) && (
          <div className="mt-6 text-center text-sm opacity-70">
            Nenhum processo encontrado com os filtros atuais.
          </div>
        )}
      </div>

      {/* DRAWER LATERAL — filtros avançados */}
      {showFilters && (
        <>
          <div
            className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm"
            onClick={() => setShowFilters(false)}
            aria-hidden="true"
          />
          <aside
            className="fixed top-0 right-0 h-full w-full sm:w-[440px] z-[61] bg-[var(--bg)] border-l panel-border shadow-2xl overflow-y-auto"
            role="dialog"
            aria-label="Filtros avançados"
          >
            <div className="sticky top-0 bg-[var(--bg)] border-b panel-border px-4 py-3 flex items-center justify-between z-10">
              <div className="flex items-center gap-2">
                <SlidersHorizontal size={16} className="text-[var(--accent)]" />
                <h2 className="text-sm font-bold uppercase tracking-wide">Filtros avançados</h2>
                {activeFilters.length > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full bg-[var(--accent)] text-white text-[10px] font-bold">
                    {activeFilters.length}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowFilters(false)}
                className="btn-outline w-8 h-8 p-0 inline-flex items-center justify-center"
                title="Fechar"
              >
                <X size={14} />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <section>
                <div className="text-[11px] uppercase tracking-wide opacity-60 mb-2">Identificação</div>
                <div className="grid grid-cols-1 gap-2">
                  <input className="input-themed" value={filtroId} onChange={(e) => setFiltroId(e.target.value)} placeholder="ID do processo" />
                  <input className="input-themed" value={filtroUC} onChange={(e) => setFiltroUC(e.target.value)} placeholder="UC" />
                  <input className="input-themed" value={filtroCliente} onChange={(e) => setFiltroCliente(e.target.value)} placeholder="Cliente" />
                  <input className="input-themed" value={filtroConcessionaria} onChange={(e) => setFiltroConcessionaria(e.target.value)} placeholder="Concessionária" />
                </div>
              </section>

              <section>
                <div className="text-[11px] uppercase tracking-wide opacity-60 mb-2">Etapa & coluna</div>
                <div className="grid grid-cols-1 gap-2">
                  <input className="input-themed" value={filtroEtapa} onChange={(e) => setFiltroEtapa(e.target.value)} placeholder="Etapa" />
                  <input className="input-themed" value={filtroSubEtapa} onChange={(e) => setFiltroSubEtapa(e.target.value)} placeholder="Sub-etapa" />
                  <select
                    className="input-themed"
                    value={kanbanFilter}
                    onChange={(e) => setKanbanFilter(e.target.value)}
                  >
                    <option value="">Coluna do kanban (qualquer)</option>
                    {KANBAN_COLUNAS.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </section>

              <section>
                <div className="text-[11px] uppercase tracking-wide opacity-60 mb-2">Status</div>
                <div className="grid grid-cols-1 gap-2">
                  <select
                    className="input-themed"
                    value={filtroRelevancia}
                    onChange={(e) => setFiltroRelevancia(e.target.value)}
                  >
                    <option value="todos">Relevância: todos</option>
                    <option value="relevante">Somente relevantes</option>
                    <option value="no_relevante">Somente não relevantes</option>
                  </select>
                  <label className="flex items-center gap-2 text-sm opacity-90 px-1">
                    <input
                      type="checkbox"
                      checked={filtroSuspenso}
                      onChange={(e) => setFiltroSuspenso(e.target.checked)}
                    />
                    Somente suspensos
                  </label>
                </div>
              </section>

              <section>
                <div className="text-[11px] uppercase tracking-wide opacity-60 mb-2">Período</div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    className="input-themed"
                    value={filtroDataIni}
                    onChange={(e) => setFiltroDataIni(e.target.value)}
                    title="Data inicial"
                  />
                  <input
                    type="date"
                    className="input-themed"
                    value={filtroDataFim}
                    onChange={(e) => setFiltroDataFim(e.target.value)}
                    title="Data final"
                  />
                </div>
              </section>

              <section>
                <div className="text-[11px] uppercase tracking-wide opacity-60 mb-2">Valor</div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    className="input-themed"
                    value={filtroValorMin}
                    onChange={(e) => setFiltroValorMin(e.target.value)}
                    placeholder="Mínimo"
                  />
                  <input
                    className="input-themed"
                    value={filtroValorMax}
                    onChange={(e) => setFiltroValorMax(e.target.value)}
                    placeholder="Máximo"
                  />
                </div>
              </section>
            </div>

            <div className="sticky bottom-0 bg-[var(--bg)] border-t panel-border px-4 py-3 flex items-center justify-between gap-2">
              <button
                className="btn-outline text-xs"
                type="button"
                onClick={clearAllFilters}
                disabled={activeFilters.length === 0}
              >
                Limpar todos
              </button>
              <button
                className="btn-themed text-xs"
                type="button"
                onClick={() => setShowFilters(false)}
              >
                Aplicar
              </button>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
