import React, { useEffect, useMemo, useState } from 'react';
import {
  getDashboardDeferidos,
  getDashboardStats,
  getProcessosKanbanFast,
  getPythonClassification,
  getPythonConcluded,
  getPythonDashboardOverview,
  getPythonKanbanProcesses,
} from '../services/requisicaoService';

const formatCurrency = (n) =>
  (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 });

const activeStatuses = new Set(['Ainda não compensado', 'Em tratativa sobre o valor', 'Restituído']);

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [kanbanColumns, setKanbanColumns] = useState({});
  const [kanbanLoading, setKanbanLoading] = useState(true);
  const [kanbanError, setKanbanError] = useState('');
  const [selectedColumn, setSelectedColumn] = useState('');
  const [selectedEtapa, setSelectedEtapa] = useState('');
  const [selectedSubEtapa, setSelectedSubEtapa] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [pythonOverview, setPythonOverview] = useState(null);
  const [pythonClassification, setPythonClassification] = useState([]);
  const [pythonProcesses, setPythonProcesses] = useState({});
  const [pythonConcluded, setPythonConcluded] = useState(null);
  const [statsData, setStatsData] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await getDashboardDeferidos();
        setData(res);
      } catch (e) {
        console.error(e);
        setError('Não foi possível carregar os dados.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setKanbanLoading(true);
        const res = await getProcessosKanbanFast();
        if (res?.colunas) {
          setKanbanColumns(res.colunas);
          if (!selectedColumn) {
            const first = Object.keys(res.colunas)[0];
            setSelectedColumn(first || '');
          }
        } else {
          setKanbanColumns({});
        }
      } catch (e) {
        console.error('kanban-fast', e);
        setKanbanError('Falha ao carregar colunas do Kanban.');
      } finally {
        setKanbanLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    setSelectedEtapa('');
    setSelectedSubEtapa('');
  }, [selectedColumn]);

  useEffect(() => {
    (async () => {
      try {
        setStatsLoading(true);
        const res = await getDashboardStats();
        setStatsData(res);
      } catch (e) {
        console.error('dashboard/stats', e);
        setStatsError('Não foi possível carregar os totais gerais.');
      } finally {
        setStatsLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [
          overview,
          classification,
          processes,
          concluded,
        ] = await Promise.all([
          getPythonDashboardOverview(),
          getPythonClassification(),
          getPythonKanbanProcesses(),
          getPythonConcluded(),
        ]);
        setPythonOverview(overview);
        setPythonClassification(classification?.classificacoes || []);
        setPythonProcesses(processes || {});
        setPythonConcluded(concluded || null);
      } catch (e) {
        console.error('python dashboard', e);
      }
    })();
  }, []);

  const statusActiveCount = useMemo(() => {
    if (!data?.status_counts) return 0;
    return Object.entries(data.status_counts).reduce(
      (acc, [status, value]) => (activeStatuses.has(status) ? acc + Number(value || 0) : acc),
      0
    );
  }, [data]);

  const pieData = useMemo(() => {
    if (!data?.status_creditos) return [];
    const total = Object.values(data.status_creditos).reduce((sum, v) => sum + Number(v || 0), 0);
    if (!total) return [];
    let cumulative = 0;
    return Object.entries(data.status_creditos).map(([status, value]) => {
      const v = Number(value || 0);
      const start = cumulative / total;
      cumulative += v;
      const end = cumulative / total;
      return { status, value: v, start, end };
    });
  }, [data]);

  const barMax = useMemo(() => {
    if (!data?.barra?.length) return 1;
    return Math.max(...data.barra.map((item) => Number(item.credito || 0)));
  }, [data]);

  const safeNum = (input) => {
    const n = typeof input === 'number' ? input : Number(input);
    return Number.isFinite(n) ? n : 0;
  };

  const pythonApiBase =
    (import.meta.env.VITE_PYTHON_DASHBOARD_BASE_URL || '').replace(/\/$/, '') ||
    'http://localhost:5200/api/dashboard';
  const pythonChartUrl = `${pythonApiBase}/graphs/status?cacheBust=${Date.now()}`;
  const trendData =
    statsData?.tendencia30d ?? statsData?.tendencia_30d ?? [];
  const trendMax = Math.max(
    1,
    ...trendData.map((point) => Number(point.total || point.valor || point.total || 0)),
  );
  const topConcessionarias =
    statsData?.top_concessionarias ?? statsData?.topConcessionarias ?? [];
  const topClientes = statsData?.top_clientes ?? statsData?.topClientes ?? [];
  const creditTotals = statsData?.creditos || {};
  const columnDistribution = pythonOverview?.processos_por_coluna || [];
  const columnTotal =
    columnDistribution.reduce((sum, item) => sum + Number(item.processos || 0), 0) || 1;

  const columnSummaries = useMemo(() => {
    return Object.entries(kanbanColumns).map(([column, itens]) => {
      const count = Array.isArray(itens) ? itens.length : 0;
      let total = 0;
      const etapas = new Set();
      const subetapas = new Set();
      (Array.isArray(itens) ? itens : []).forEach((item) => {
        const credito =
          safeNum(item.credito_simples) + safeNum(item.credito_dobro) + safeNum(item.credito || 0);
        total += credito;
        if (item.etapa) etapas.add(item.etapa);
        if (item.sub_etapa) subetapas.add(item.sub_etapa);
      });
      return {
        column,
        count,
        total,
        etapas: Array.from(etapas),
        subetapas: Array.from(subetapas),
      };
    });
  }, [kanbanColumns]);

  const approvedColumnCount = useMemo(() => {
    const target = columnSummaries.find((item) => /aprovado/i.test(item.column));
    return target?.count ?? 0;
  }, [columnSummaries]);

  const activeCount = approvedColumnCount || statusActiveCount;

  const allProcesses = useMemo(() => {
    const list = [];
    Object.entries(kanbanColumns).forEach(([column, itens]) => {
      if (!Array.isArray(itens)) return;
      itens.forEach((item) => list.push({ ...item, coluna: column }));
    });
    return list;
  }, [kanbanColumns]);

  const filteredProcesses = useMemo(() => {
    if (!allProcesses.length) return [];
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    return allProcesses.filter((item) => {
      if (selectedColumn && item.coluna !== selectedColumn) return false;
      if (selectedEtapa && item.etapa !== selectedEtapa) return false;
      if (selectedSubEtapa && item.sub_etapa !== selectedSubEtapa) return false;
      if (start || end) {
        const raw = item.data_ultima_movimentacao || item.ultima_atualizacao;
        if (!raw) return false;
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) return false;
        if (start && date < start) return false;
        if (end && date > end) return false;
      }
      return true;
    });
  }, [
    allProcesses,
    selectedColumn,
    selectedEtapa,
    selectedSubEtapa,
    startDate,
    endDate,
  ]);

  const currentColumn = columnSummaries.find((item) => item.column === selectedColumn);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-[var(--fg)]">
        Carregando painel...
      </div>
    );
  }
  if (error) {
    return <div className="text-sm text-red-500 p-4">{error}</div>;
  }

  return (
    <div className="p-6 space-y-6">
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-sm">
          <p className="text-xs uppercase tracking-[0.4em] text-slate-400 mb-2">Processos ativos</p>
          <p className="text-3xl font-bold">{activeCount}</p>
          <p className="text-xs text-slate-500 mt-1">Status selecionados ainda não compensados / em tratativa.</p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-sm">
          <p className="text-xs uppercase tracking-[0.4em] text-slate-400 mb-2">Carteira (previsto)</p>
          <p className="text-3xl font-bold">{formatCurrency(data?.total_credito)}</p>
          <p className="text-xs text-slate-500 mt-1">Soma de crédito simples + crédito dobro.</p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-sm">
          <p className="text-xs uppercase tracking-[0.4em] text-slate-400 mb-2">Concessionárias</p>
          <div className="grid gap-1 text-xs text-slate-700">
            {(data?.concessionarias || []).slice(0, 4).map((item, idx) => (
              <div key={`${item.concessionaria}-${idx}`} className="flex justify-between">
                <span>{item.concessionaria}</span>
                <span className="font-semibold">{item.count} proc.</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-700">Insights Python</h2>
          <p className="text-xs text-slate-500">Dados crus servidos pelo serviço FastAPI</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="card">
            <small>Total de requisições (Python)</small>
            <div className="stat">{pythonOverview?.total_requisicoes?.toLocaleString() ?? '—'}</div>
          </div>
          <div className="card">
            <small>Total Italiano</small>
            <div className="stat">{pythonOverview?.processos_por_coluna?.length ?? '—'} colunas</div>
          </div>
          <div className="card">
            <small>Processos concluídos</small>
            <div className="stat">{pythonConcluded?.total_processos_concluidos ?? '—'}</div>
          </div>
          <div className="card">
            <small>Crédito concluído</small>
            <div className="stat accent">{formatCurrency((pythonConcluded?.total_credito || 0).toFixed(2))}</div>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="card space-y-2">
            <small>Classificações de erro</small>
            <div className="overflow-auto max-h-32 text-xs">
              <table className="w-full">
                <thead className="text-[10px] text-slate-400 uppercase tracking-[0.15em]">
                  <tr>
                    <th>Tipo</th>
                    <th>Subtipo</th>
                    <th>Total</th>
                    <th>%</th>
                  </tr>
                </thead>
                <tbody>
                  {pythonClassification.slice(0, 6).map((item) => (
                    <tr key={`${item.tipo}-${item.subtipo}`} className="border-b border-[var(--border)] hover:bg-white/5">
                      <td className="py-2">{item.tipo}</td>
                      <td>{item.subtipo}</td>
                      <td>{item.total}</td>
                      <td>{item.percentual}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card space-y-2">
            <small>Histórico de etapas até conclusão</small>
            <p className="text-sm text-slate-400">
              Média de {pythonConcluded?.media_movimentacoes_historico?.toFixed(2) ?? '0'} itens
              ({pythonConcluded?.historico_etapas?.length ?? 0} combinações).
            </p>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              {(pythonConcluded?.historico_etapas || []).slice(0, 4).map((row, idx) => (
                <div key={`${row.etapa_nova}-${row.sub_etapa}-${idx}`} className="border border-[var(--border)] rounded p-2">
                  <div className="text-xs text-slate-400">{row.etapa_nova}</div>
                  <strong>{row.sub_etapa || '—'}</strong>
                  <div className="text-[10px] text-slate-500">{row.ocorrencias} ocorr.</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="chart-frame h-48">
          <img
            src={pythonChartUrl}
            alt="Gráfico de status Python"
            className="w-full h-full object-contain"
          />
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-700">Visão BI</h2>
          <p className="text-xs text-slate-500">Explorando tendências, crédito e rankings.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="card">
            <small>Crédito simples total</small>
            <div className="stat">{formatCurrency(creditTotals.simples_total ?? 0)}</div>
          </div>
          <div className="card">
            <small>Crédito dobro total</small>
            <div className="stat accent">{formatCurrency(creditTotals.dobro_total ?? 0)}</div>
          </div>
          <div className="card">
            <small>Total carteira (previsto)</small>
            <div className="stat">{formatCurrency(creditTotals.total_procedente ?? 0)}</div>
          </div>
          <div className="card">
            <small>Processos por coluna</small>
            <div className="stat">{statsData?.processos_counts?.ativos ?? 0}</div>
            <p className="text-xs text-slate-400">Apenas ativos + deferidos etc.</p>
          </div>
        </div>
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <small>Movimentações 30 dias</small>
              <h3 className="text-lg font-semibold text-slate-100">Tendência diária</h3>
            </div>
            <span className="text-xs text-slate-400">
              {trendData.length ? trendData[trendData.length - 1].dia : '—'}
            </span>
          </div>
          <div className="flex items-end gap-2 mt-4 h-24">
            {trendData.map((point, idx) => {
              const height = Math.max(3, (point.total || point.valor || 0) * 100 / trendMax);
              return (
                <div
                  key={`${point.dia}-${idx}`}
                  style={{
                    height: `${height}%`,
                    width: `${100 / Math.max(trendData.length, 1)}%`,
                    background: '#38bdf8',
                    borderRadius: '999px',
                  }}
                  title={`${point.dia}: ${point.total ?? point.valor ?? 0}`}
                ></div>
              );
            })}
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="card">
            <small>Top Concessionárias (valor)</small>
            <div className="space-y-2 mt-4 text-sm">
              {(topConcessionarias || []).map((item, idx) => {
                const percent =
                  (Number(item.total || 0) /
                    Math.max(
                      topConcessionarias.reduce((acc, cur) => acc + Number(cur.total || 0), 0),
                      1,
                    )) *
                  100;
                return (
                  <div key={`${item.label}-${idx}`}>
                    <div className="flex justify-between">
                      <span>{item.label}</span>
                      <span className="text-xs text-slate-400">{formatCurrency(item.total)}</span>
                    </div>
                    <div
                      className="h-1 rounded-full bg-slate-800 mt-1"
                      style={{ position: 'relative' }}
                    >
                      <span
                        className="absolute inset-0 rounded-full bg-gradient-to-r from-[#22c55e] to-[#0ea5e9]"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="card">
            <small>Top Clientes (valor)</small>
            <div className="space-y-2 mt-4 text-sm">
              {(topClientes || []).slice(0, 6).map((item, idx) => (
                <div key={`${item.label}-${idx}`} className="flex justify-between">
                  <span>{item.label}</span>
                  <span className="text-xs text-slate-400">{formatCurrency(item.total)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-700">Distribuição por coluna</h2>
          <span className="text-xs text-slate-400">{columnDistribution.length} colunas monitoradas</span>
        </div>
        <div className="grid gap-3">
          {columnDistribution.map((col) => {
            const width = Math.min(100, (Number(col.processos) / columnTotal) * 100);
            return (
              <div
                key={col.coluna}
                className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-2"
              >
                <div className="flex justify-between text-xs text-slate-400">
                  <span>{col.coluna}</span>
                  <span>{col.processos.toLocaleString()} processos</span>
                </div>
                <div className="h-2 rounded-full bg-slate-800 relative">
                  <span
                    className="absolute inset-0 rounded-full bg-gradient-to-r from-[#22c55e] to-[#0ea5e9]"
                    style={{ width: `${width}%` }}
                  ></span>
                </div>
                <div className="text-[11px] text-slate-500">
                  {width.toFixed(1)}% do painel de requisições
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-700">Classificações rápidas</h2>
          <span className="text-xs text-slate-400">{pythonClassification.length} categorias</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {pythonClassification.slice(0, 4).map((item) => (
            <div
              key={`${item.tipo}-${item.subtipo}`}
              className="card"
            >
              <small>{item.tipo}</small>
              <div className="stat">{item.total}</div>
              <p className="text-xs text-slate-400">{item.percentual}% do total</p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-700">Requisições por status</h2>
          {statsLoading && <span className="text-xs text-slate-500">Carregando...</span>}
        </div>
        {statsError ? (
          <div className="text-sm text-red-500">{statsError}</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-sm">
              <p className="text-xs uppercase tracking-[0.3em] text-slate-400 mb-2">Total de requisições</p>
              <p className="text-2xl font-bold">{statsData?.total_requisicoes ?? '-'}</p>
            </div>
            {[
              { label: 'Nova Requisição', value: statsData?.status_counts?.pendente ?? 0 },
              { label: 'Em análise', value: statsData?.status_counts?.em_analise ?? 0 },
              { label: 'Aprovado', value: statsData?.status_counts?.aprovado ?? 0 },
              { label: 'Rejeitado', value: statsData?.status_counts?.rejeitado ?? 0 },
            ].map((entry) => (
              <div key={entry.label} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-sm">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-400 mb-2">{entry.label}</p>
                <p className="text-2xl font-bold">{entry.value}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-700">Colunas do Kanban</h2>
          <p className="text-xs text-slate-500">Clique em uma coluna para ver os processos ativos</p>
        </div>
        {kanbanLoading ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-6 text-sm text-center text-slate-500">
            Carregando colunas do Kanban...
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {columnSummaries.map((item) => (
              <button
                key={item.column}
                type="button"
                onClick={() => setSelectedColumn(item.column)}
                className={`text-left rounded-xl border p-4 shadow-sm transition ${
                  selectedColumn === item.column
                    ? 'border-[var(--accent)] bg-[var(--panel)]'
                    : 'border-[var(--border)] bg-[var(--panel)]'
                }`}
              >
                <p className="text-xs uppercase tracking-[0.4em] text-slate-400 mb-2">{item.column}</p>
                <p className="text-2xl font-bold">{item.count} processos</p>
                <p className="text-sm text-slate-500">{formatCurrency(item.total)}</p>
                <p className="text-[11px] text-slate-400 mt-2">
                  Etapas: {item.etapas.slice(0, 2).join(', ') || '–'}
                </p>
              </button>
            ))}
          </div>
        )}
        {kanbanError && (
          <div className="text-sm text-red-500 border border-red-200 rounded p-2">{kanbanError}</div>
        )}
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-sm space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex flex-col text-xs text-slate-500">
            Coluna
            <select
              value={selectedColumn}
              onChange={(e) => setSelectedColumn(e.target.value)}
              className="mt-1 rounded border px-2 py-1 text-sm"
            >
              <option value="">Todas</option>
              {columnSummaries.map((item) => (
                <option key={item.column} value={item.column}>
                  {item.column}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            Etapa
            <select
              value={selectedEtapa}
              onChange={(e) => setSelectedEtapa(e.target.value)}
              className="mt-1 rounded border px-2 py-1 text-sm"
            >
              <option value="">Todas</option>
              {(currentColumn?.etapas || []).map((etapa) => (
                <option key={etapa} value={etapa}>
                  {etapa}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            Subetapa
            <select
              value={selectedSubEtapa}
              onChange={(e) => setSelectedSubEtapa(e.target.value)}
              className="mt-1 rounded border px-2 py-1 text-sm"
            >
              <option value="">Todas</option>
              {(currentColumn?.subetapas || []).map((sub) => (
                <option key={sub} value={sub}>
                  {sub}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            Data de atualização (início)
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 rounded border px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            Data de atualização (fim)
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="mt-1 rounded border px-2 py-1 text-sm"
            />
          </label>
        </div>
        <div className="overflow-auto max-h-[260px] text-xs">
          <table className="w-full text-left">
            <thead className="text-slate-500 text-[10px] uppercase tracking-[0.2em] sticky top-0 bg-[var(--panel)]">
              <tr>
                <th className="px-2 py-1">ID</th>
                <th className="px-2 py-1">Cliente</th>
                <th className="px-2 py-1">Concessionária</th>
                <th className="px-2 py-1">Etapa</th>
                <th className="px-2 py-1">Subetapa</th>
                <th className="px-2 py-1">Crédito</th>
                <th className="px-2 py-1">Simples</th>
                <th className="px-2 py-1">Dobro</th>
                <th className="px-2 py-1">Atualização</th>
              </tr>
            </thead>
            <tbody>
              {filteredProcesses.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-2 py-3 text-center text-slate-500">
                    Nenhum processo encontrado com os filtros selecionados.
                  </td>
                </tr>
              ) : (
                filteredProcesses.map((proc) => (
                  <tr
                    key={`${proc.id}-${proc.coluna}-${proc.cliente || proc.uc || proc.id}`}
                    className="border-b border-[var(--border)] last:border-b-0 text-[11px]"
                  >
                    <td className="px-2 py-1">{proc.id}</td>
                    <td className="px-2 py-1">{proc.cliente || proc.uc || '-'}</td>
                    <td className="px-2 py-1">{proc.concessionaria || '-'}</td>
                    <td className="px-2 py-1">{proc.etapa || '-'}</td>
                    <td className="px-2 py-1">{proc.sub_etapa || '-'}</td>
                    <td className="px-2 py-1">{formatCurrency(safeNum(proc.credito))}</td>
                    <td className="px-2 py-1">{formatCurrency(safeNum(proc.credito_simples))}</td>
                    <td className="px-2 py-1">{formatCurrency(safeNum(proc.credito_dobro))}</td>
                    <td className="px-2 py-1">
                      {(() => {
                        const raw = proc.data_ultima_movimentacao || proc.ultima_atualizacao;
                        if (!raw) return '-';
                        const d = new Date(raw);
                        return Number.isNaN(d.getTime())
                          ? '-'
                          : d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                      })()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-sm space-y-4">
          <h2 className="text-sm uppercase tracking-[0.3em] text-slate-400">Tabela consolidada</h2>
          <div className="overflow-auto max-h-96">
            <table className="w-full text-xs">
              <thead className="text-left text-slate-500 sticky top-0 bg-[var(--panel)]">
                <tr>
                  <th className="px-2 py-1">Concessionária</th>
                  <th className="px-2 py-1">Processos</th>
                  <th className="px-2 py-1">Crédito total</th>
                </tr>
              </thead>
              <tbody>
                {(data?.concessionarias || []).map((item, idx) => (
                  <tr key={`${item.concessionaria}-${idx}`} className="border-b border-[var(--border)] last:border-b-0">
                    <td className="px-2 py-1">{item.concessionaria}</td>
                    <td className="px-2 py-1">{item.count}</td>
                    <td className="px-2 py-1">{formatCurrency(item.credito)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm uppercase tracking-[0.3em] text-slate-400">Status (pizza)</h2>
            <span className="text-[10px] uppercase text-slate-500">Crédito</span>
          </div>
          <div className="flex items-center gap-4 mt-4">
            <div className="relative w-32 h-32">
              <div
                className="rounded-full w-full h-full"
                style={{
                  background: pieData.length
                    ? `conic-gradient(${pieData
                        .map(
                          (segment, idx) =>
                            `${['#22c55e', '#38bdf8', '#facc15', '#f97316', '#a855f7'][idx % 5]} ${segment.start *
                              100}% ${segment.end * 100}%`
                        )
                        .join(', ')})`
                    : '#f3f4f6',
                }}
              />
              <div className="absolute inset-8 rounded-full bg-[var(--panel)] flex items-center justify-center text-xs text-slate-500">
                {formatCurrency(data?.total_credito)}
              </div>
            </div>
            <div className="text-xs space-y-2 flex-1">
              {pieData.map((segment) => (
                <div key={segment.status} className="flex items-center justify-between">
                  <span>{segment.status}</span>
                  <span className="font-semibold">{formatCurrency(segment.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[2fr,1fr]">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-sm space-y-3">
          <h2 className="text-sm uppercase tracking-[0.3em] text-slate-400">Gráfico de barras</h2>
          <div className="space-y-3">
            {(data?.barra || []).slice(0, 5).map((item, idx) => {
              const width = barMax ? (Number(item.credito || 0) / barMax) * 100 : 0;
              return (
                <div key={`${item.cliente}-${item.concessionaria}-${idx}`} className="space-y-1">
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>{item.cliente || '—'}</span>
                    <span>{formatCurrency(item.credito)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
                    <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${width}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-sm">
          <h2 className="text-sm uppercase tracking-[0.3em] text-slate-400 mb-2">Detalhes</h2>
          <div className="overflow-auto max-h-[320px] text-xs">
            <table className="w-full text-left">
              <thead className="text-slate-500 text-[10px] uppercase tracking-[0.2em] sticky top-0 bg-[var(--panel)]">
                <tr>
                  <th className="px-2 py-1">Cliente</th>
                  <th className="px-2 py-1">Crédito</th>
                  <th className="px-2 py-1">Simples</th>
                  <th className="px-2 py-1">Dobro</th>
                  <th className="px-2 py-1">Procedência simples</th>
                  <th className="px-2 py-1">Procedência dobro</th>
                </tr>
              </thead>
              <tbody>
                {(data?.detalhes || []).slice(0, 10).map((row, idx) => (
                  <tr key={`${row.cliente}-${idx}`} className="border-b border-[var(--border)] last:border-b-0">
                    <td className="px-2 py-1">{row.cliente || '-'}</td>
                    <td className="px-2 py-1">{formatCurrency(row.credito)}</td>
                    <td className="px-2 py-1">{formatCurrency(row.credito_simples)}</td>
                    <td className="px-2 py-1">{formatCurrency(row.credito_dobro)}</td>
                    <td className="px-2 py-1">{row.data_procedencia_simples || '-'}</td>
                    <td className="px-2 py-1">{row.data_procedencia_dobro || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
