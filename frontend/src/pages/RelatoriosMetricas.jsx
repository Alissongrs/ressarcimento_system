// frontend/src/pages/RelatoriosMetricas.jsx
import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCcw } from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { getRelatoriosMetricas, getKanbanComposicao } from '../services/relatoriosService.js';
import { getConcessionariasParaFiltro } from '../services/requisicaoService.js';

const safeNum = (v) => Number(v || 0) || 0;

const formatNumber = (n) => safeNum(n).toLocaleString('pt-BR');
const formatCurrency = (n) =>
  safeNum(n).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  });

const PROCESSOS_CARDS = [
  { label: 'Ativos', key: 'ativos' },
  { label: 'Deferidos', key: 'deferidos' },
  { label: 'Fluxo', key: 'fluxo_ressarcimento' },
  { label: 'Faturamento', key: 'faturamento' },
  { label: 'Concluídos', key: 'concluidos' },
  { label: 'Indeferidos', key: 'indeferidos' },
];

const STATUS_CARDS = [
  { label: 'Pendente', key: 'pendente' },
  { label: 'Em análise', key: 'em_analise' },
  { label: 'Aprovado', key: 'aprovado' },
  { label: 'Rejeitado', key: 'rejeitado' },
];

const METRICAS_GUIA = {
  estrategicos: [
    'Carteira (Volumetria)',
    'Carteira (R$MM)',
    'Resultados Ressarcimento: Gerado/Faturado/Caixa',
    'Resultados clientes',
    "Relação Erros X UC's (%)",
    '% Financeiro: Erros (R$)/Faturas (R$)',
    '% Financeiro: Faturado/conquistado (R$)/Faturas (R$)',
    '% Financeiro (Mercado): Erros (R$)/Faturas (R$)',
  ],
  taticos: [
    '% Sucesso Geral e por nível de solicitação',
    'Ticket médio',
    'Qtde novos erros encontrados/mês (Ressarcimento)',
    'TM Deferimento',
    'TM Ressarcimento',
    'Taxa de reanálise',
    'Taxa de processos Aneel',
    'Backlog',
    'Quantidade dos processos X ressarcidos',
    'Qtde processos gerados mês por canal',
    '% Análises no prazo',
    'Taxa de conversão de deferidos/concessionária',
  ],
  operacionais: [
    'TM etapas',
    'Qtde processos realizados/dia',
    'Qtde e-mails respondidos/dia',
    'Qtde novos erros/dia',
    '% Sucesso primeira análise',
    '% de processos/horas automatizadas',
  ],
};

const hasPositive = (arr, key = 'total') => Array.isArray(arr) && arr.some((x) => safeNum(x?.[key]) > 0);

function EmptyChart({ title, hint }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-xs opacity-70 gap-2">
      <div className="font-semibold opacity-80">{title}</div>
      <div className="text-center max-w-[320px]">
        {hint || 'Sem dados para compor este gráfico (todos os valores vieram 0 no payload).'}
      </div>
    </div>
  );
}

export default function RelatoriosMetricas({ globalFilters }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [metricsModalOpen, setMetricsModalOpen] = useState(false);
  const [metricsTab, setMetricsTab] = useState('estrategicos');

  const [concessionarias, setConcessionarias] = useState([]);

  // filtro (somente para o gráfico de Kanban)
  const [kanbanConcs, setKanbanConcs] = useState([]);
  const [kanbanConcSearch, setKanbanConcSearch] = useState('');
  const [kanbanCounts, setKanbanCounts] = useState(null);
  const [kanbanLoading, setKanbanLoading] = useState(false);
  const [kanbanSelected, setKanbanSelected] = useState(() => new Set());

  const load = async (opts = {}) => {
    try {
      setLoading(true);
      setError('');
      const useGlobal = opts.globalFilters || globalFilters || {};
      const useConcs = opts.concessionarias ?? [];
      const res = await getRelatoriosMetricas({
        dataIni: useGlobal?.dataIni || '',
        dataFim: useGlobal?.dataFim || '',
        concessionarias: useConcs || [],
      });

      setData(res || null);
      setUpdatedAt(new Date());
    } catch (e) {
      setError(e?.message || 'Falha ao carregar métricas.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const list = await getConcessionariasParaFiltro();
        const base = Array.isArray(list) ? list : [];
        const normalized = base
          .map((c) => (typeof c === 'string' ? c : c?.nome ?? c?.concessionaria ?? c?.label ?? ''))
          .map((s) => String(s || '').trim())
          .filter(Boolean);
        const unique = Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b));
        if (mounted) setConcessionarias(unique);
      } catch {
        if (mounted) setConcessionarias([]);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    setKanbanSelected(new Set(PROCESSOS_CARDS.map((p) => p.key)));
  }, []);

  useEffect(() => {
    load({ globalFilters });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFilters?.dataIni, globalFilters?.dataFim]);

  useEffect(() => {
    if (kanbanConcs.length === 0) setKanbanCounts(null);
  }, [kanbanConcs]);

  // payload
  const processosCounts = data?.processos_counts || {};
  const kanbanItems = Array.isArray(kanbanCounts?.items) ? kanbanCounts.items : null;
  const labelToKey = useMemo(
    () => new Map(PROCESSOS_CARDS.map((p) => [p.label, p.key])),
    [],
  );

  const statusCounts = data?.status_counts || {};
  const creditos = data?.creditos || {};
  const tendencia30d = data?.tendencia_30d || [];
  const agingBuckets = data?.aging_buckets || {};
  const tempoMedio = data?.tempo_medio_dias_por_etapa || [];

  const topConcessionarias = data?.top_concessionarias || [];
  const topClientes = data?.top_clientes || [];
  const throughputSemana = data?.throughput_semana || [];
  const throughputMes = data?.throughput_mes || [];
  const canaisDist = data?.canais_dist_30d || [];
  const wipGestores = data?.wip_gestores || [];
  const valorHistogram = data?.valor_histogram || [];
  const sla30d = data?.sla_30d || {};
  const tempoConclusaoConcs = data?.tempo_medio_conclusao_concessionaria || [];

  const repassePorConcs = data?.repasse_por_concessionaria || [];
  const repasseTotal = safeNum(data?.repasse_total);

  // datasets
  const tendenciaChart = tendencia30d.map((t) => ({ dia: t.dia, total: safeNum(t.total) }));
  const trendMax = Math.max(1, ...tendencia30d.map((t) => safeNum(t.total)));

  // Status com %
  const totalStatus = STATUS_CARDS.reduce((s, x) => s + safeNum(statusCounts[x.key]), 0);
  const statusChart = STATUS_CARDS.map((s) => {
    const total = safeNum(statusCounts[s.key]);
    return { label: s.label, total, percent: totalStatus ? (total / totalStatus) * 100 : 0 };
  });

  // Créditos com %
  const totalCreditos = safeNum(creditos.simples_total) + safeNum(creditos.dobro_total);
  const creditosChart = [
    {
      label: 'Simples',
      total: safeNum(creditos.simples_total),
      percent: totalCreditos ? (safeNum(creditos.simples_total) / totalCreditos) * 100 : 0,
    },
    {
      label: 'Dobro',
      total: safeNum(creditos.dobro_total),
      percent: totalCreditos ? (safeNum(creditos.dobro_total) / totalCreditos) * 100 : 0,
    },
  ];

  // Canais com %
  const totalCanais = (canaisDist || []).reduce((s, x) => s + safeNum(x.total), 0);
  const canaisChart = (canaisDist || []).map((r) => {
    const total = safeNum(r.total);
    return { label: r.label, total, percent: totalCanais ? (total / totalCanais) * 100 : 0 };
  });

  // Kanban composição
  const totalKanban = kanbanItems
    ? kanbanItems.reduce((sum, it) => sum + safeNum(it.total), 0)
    : PROCESSOS_CARDS.reduce((sum, p) => sum + safeNum(processosCounts[p.key]), 0);

  const kanbanPercentData = useMemo(() => {
    const items = kanbanItems
      ? kanbanItems
          .filter((it) => {
            const key = labelToKey.get(it.label);
            return key ? kanbanSelected.has(key) : false;
          })
          .map((it) => {
            const total = safeNum(it.total);
            const percent =
              it.percent != null
                ? Number(it.percent)
                : totalKanban
                ? (total / totalKanban) * 100
                : 0;
            return { key: labelToKey.get(it.label), label: it.label, total, percent };
          })
      : PROCESSOS_CARDS.filter((p) => kanbanSelected.has(p.key)).map((p) => {
          const total = safeNum(processosCounts[p.key]);
          const percent = totalKanban ? (total / totalKanban) * 100 : 0;
          return { key: p.key, label: p.label, total, percent };
        });
    return items.sort((a, b) => b.total - a.total);
  }, [kanbanSelected, kanbanItems, labelToKey, processosCounts, totalKanban]);

  const kanbanPieData = kanbanPercentData.map((k) => ({ label: k.label, total: k.total, percent: k.percent }));

  const renderKanbanPercentLabel = (props) => {
    const pct = safeNum(props?.payload?.percent);
    if (pct < 4) return null;
    return `${pct.toFixed(0)}%`;
  };

  // KPIs
  const totalProcessos = safeNum(data?.total_processos);
  const totalRequisicoes = safeNum(data?.total_requisicoes);
  const valorTotal = safeNum(data?.valor_total_ressarcimento);
  const carteiraValor = safeNum(data?.carteira_valor ?? data?.valor_em_carteira);
  const carteiraProcessos = safeNum(data?.carteira_processos ?? data?.processos_em_carteira);

  const deferidosN = safeNum(processosCounts?.deferidos);
  const indeferidosN = safeNum(processosCounts?.indeferidos);
  const taxaDeferimento = totalProcessos ? deferidosN / totalProcessos : 0;
  const taxaIndeferimento = totalProcessos ? indeferidosN / totalProcessos : 0;

  const ticketMedioPorProcesso = totalProcessos ? valorTotal / totalProcessos : 0;
  const ticketMedioPorRequisicao = totalRequisicoes ? valorTotal / totalRequisicoes : 0;

  const totalProcedente = safeNum(creditos.total_procedente);
  const pctDobroNoProcedente = totalProcedente ? safeNum(creditos.dobro_total) / totalProcedente : 0;
  const pctRepasseNoProcedente = totalProcedente ? repasseTotal / totalProcedente : 0;
  const repasseMedioPorProcesso = totalProcessos ? repasseTotal / totalProcessos : 0;

  const onTime = safeNum(sla30d.on_time);
  const late = safeNum(sla30d.late);
  const totalSla = onTime + late;
  const onTimePct = totalSla ? Math.round((onTime / totalSla) * 100) : 0;

  const cardsTop = useMemo(
    () => [
      { label: 'Carteira (Volumetria)', value: formatNumber(carteiraProcessos) },
      { label: 'Carteira (R$MM)', value: formatCurrency(carteiraValor) },
      { label: 'Total de Processos', value: formatNumber(totalProcessos) },
      { label: 'Total de Requisições', value: formatNumber(totalRequisicoes) },
      { label: 'Valor Total Estimado', value: formatCurrency(valorTotal) },
      { label: 'Créditos Simples', value: formatCurrency(creditos.simples_total) },
      { label: 'Créditos em Dobro', value: formatCurrency(creditos.dobro_total) },
      { label: 'Total Procedente', value: formatCurrency(creditos.total_procedente) },
      { label: 'Ticket médio (por processo)', value: formatCurrency(ticketMedioPorProcesso) },
      { label: 'Ticket médio (por requisição)', value: formatCurrency(ticketMedioPorRequisicao) },
      { label: '% Deferimento', value: `${Math.round(taxaDeferimento * 100)}%` },
      { label: '% Indeferimento', value: `${Math.round(taxaIndeferimento * 100)}%` },
      { label: '% Dobro (do procedente)', value: `${Math.round(pctDobroNoProcedente * 100)}%` },
      { label: '% Repasse (do procedente)', value: `${Math.round(pctRepasseNoProcedente * 100)}%` },
      { label: 'Repasse médio (por processo)', value: formatCurrency(repasseMedioPorProcesso) },
    ],
    [
      totalProcessos,
      totalRequisicoes,
      valorTotal,
      creditos,
      ticketMedioPorProcesso,
      ticketMedioPorRequisicao,
      taxaDeferimento,
      taxaIndeferimento,
      pctDobroNoProcedente,
      pctRepasseNoProcedente,
      repasseMedioPorProcesso,
      carteiraProcessos,
      carteiraValor,
    ],
  );

  const tempoConclusaoChart = (tempoConclusaoConcs || []).map((r) => ({
    label: r.label,
    dias: safeNum(r.dias),
  }));

  const repasseChart = (repassePorConcs || []).map((r) => ({
    label: r.label,
    total: safeNum(r.total),
  }));

  const repasseRows = useMemo(() => {
    const base = (repasseChart || []).filter((x) => x && x.label);
    const total = base.reduce((s, x) => s + safeNum(x.total), 0);
    const sorted = base.slice().sort((a, b) => safeNum(b.total) - safeNum(a.total));
    return { total, rows: sorted };
  }, [repasseChart]);

  const kanbanConcsLabel = kanbanConcs.length ? `${kanbanConcs.length} selecionada(s)` : 'sem filtro';

  const filteredKanbanConcs = useMemo(() => {
    const term = kanbanConcSearch.trim().toLowerCase();
    if (!term) return concessionarias;
    return concessionarias.filter((c) => c.toLowerCase().includes(term));
  }, [concessionarias, kanbanConcSearch]);

  const applyKanbanConcs = async () => {
    setKanbanLoading(true);
    try {
      const res = await getKanbanComposicao({
        dataIni: globalFilters?.dataIni || '',
        dataFim: globalFilters?.dataFim || '',
        concessionarias: kanbanConcs,
      });
      setKanbanCounts(res || null);
    } catch {
      setKanbanCounts(null);
    } finally {
      setKanbanLoading(false);
    }
  };

  const pieColors = ['#4f83ff', '#20c997', '#f6c343', '#ff7a7a', '#8f6bff', '#4dd4ff', '#ffb86b'];

  const getLegendPayload = (entry) => entry?.payload?.payload || entry?.payload || {};
  const getTotalFromLegendEntry = (entry) => safeNum(getLegendPayload(entry)?.total);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Métricas</h2>
          <div className="text-xs opacity-70">
            {updatedAt ? `Atualizado em ${updatedAt.toLocaleString('pt-BR')}` : 'Carregando...'}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMetricsModalOpen(true)}
            className="px-3 py-2 rounded-md border border-[var(--border)] hover:bg-[var(--menu-hover)] text-sm"
          >
            Guia de Métricas
          </button>

          <button
            type="button"
            onClick={() => load({ globalFilters })}
            className="flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--border)] hover:bg-[var(--menu-hover)]"
            disabled={loading}
          >
            <RefreshCcw size={14} />
            {loading ? 'Atualizando...' : 'Atualizar'}
          </button>
        </div>
      </div>

      <div className="p-4 rounded-lg border panel-border panel-bg-60 space-y-2">
        <div className="text-sm font-semibold">Filtros da página</div>
        <div className="text-xs opacity-70">
          Período aplicado:{' '}
          {globalFilters?.dataIni && globalFilters?.dataFim
            ? `${globalFilters.dataIni} até ${globalFilters.dataFim}`
            : 'sem filtro de data'}
        </div>
      </div>

      {error && <div className="text-sm text-red-500">{error}</div>}

      {metricsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-3xl rounded-xl border panel-border bg-[var(--card)] p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">Guia de Métricas</div>
                <div className="text-xs opacity-70">
                  Selecione a categoria para ver a lista completa de métricas solicitadas.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMetricsModalOpen(false)}
                className="px-3 py-1.5 rounded-md border panel-border panel-bg-60 hover:opacity-90 text-sm"
              >
                Fechar
              </button>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {[
                { key: 'estrategicos', label: 'Estratégicos' },
                { key: 'taticos', label: 'Táticos' },
                { key: 'operacionais', label: 'Operacionais' },
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setMetricsTab(item.key)}
                  className={`px-3 py-2 rounded-md border text-sm ${
                    metricsTab === item.key
                      ? 'bg-[var(--menu-hover)] border-[var(--menu-hover)]'
                      : 'panel-border panel-bg-60'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              {METRICAS_GUIA[metricsTab].map((item) => (
                <div key={`${metricsTab}-${item}`} className="rounded-md border panel-border panel-bg-60 p-3">
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {cardsTop.map((c) => (
          <div key={c.label} className="p-4 rounded-lg border panel-border panel-bg-60">
            <div className="text-xs uppercase opacity-70">{c.label}</div>
            <div className="text-2xl font-semibold mt-1">{c.value}</div>
          </div>
        ))}
      </div>

      {/* Kanban composição + Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="p-4 rounded-lg border panel-border panel-bg-60">
          <div className="text-sm font-semibold mb-1">Composição de Processos (Kanban)</div>
          <div className="text-xs opacity-70 mb-3">
            Mostra a porcentagem de cada coluna para compor os processos. Filtro aplicado: {kanbanConcsLabel}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="h-[300px]">
              {kanbanSelected.size === 0 ? (
                <EmptyChart title="Nenhuma coluna selecionada" hint="Marque ao menos uma coluna para ver o gráfico." />
              ) : hasPositive(kanbanPieData, 'total') ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={kanbanPieData}
                      dataKey="total"
                      nameKey="label"
                      innerRadius={60}
                      outerRadius={110}
                      paddingAngle={2}
                      labelLine={false}
                      label={renderKanbanPercentLabel}
                    >
                      {kanbanPieData.map((entry, idx) => (
                        <Cell key={`kanban-cell-${entry.label}`} fill={pieColors[idx % pieColors.length]} />
                      ))}
                    </Pie>

                    <Tooltip
                      formatter={(v, _name, props) => {
                        const pct = safeNum(props?.payload?.percent);
                        return [`${formatNumber(v)} (${pct.toFixed(1)}%)`, 'Total'];
                      }}
                    />

                    <Legend
                      layout="vertical"
                      align="right"
                      verticalAlign="middle"
                      formatter={(value, entry) => {
                        const tot = getTotalFromLegendEntry(entry);
                        const pct = totalKanban ? (tot / totalKanban) * 100 : 0;
                        return `${value} — ${formatNumber(tot)} (${pct.toFixed(1)}%)`;
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <EmptyChart
                  title="Sem dados (Kanban)"
                  hint="O payload veio com processos_counts zerado. Se Total de Processos aparece > 0, provavelmente a query do backend está retornando 0 para os counts."
                />
              )}
            </div>

            <div>
              <div className="text-xs opacity-70 mb-2">Colunas incluídas</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                {PROCESSOS_CARDS.map((p) => (
                  <label key={`kanban-${p.key}`} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={kanbanSelected.has(p.key)}
                      onChange={(e) => {
                        setKanbanSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(p.key);
                          else next.delete(p.key);
                          return next;
                        });
                      }}
                    />
                    <span className="opacity-80">{p.label}</span>
                  </label>
                ))}
              </div>

              <div className="mt-3 space-y-1 text-sm">
                {kanbanPercentData.map((k) => (
                  <div key={`kanban-row-${k.key}`} className="flex items-center justify-between">
                    <span className="opacity-80">{k.label}</span>
                    <span className="font-semibold">
                      {formatNumber(k.total)} <span className="opacity-70">({k.percent.toFixed(1)}%)</span>
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-4">
                <div className="text-xs opacity-70 mb-2">Concessionárias (filtro apenas para este gráfico)</div>

                <div className="flex flex-wrap gap-2 mb-2">
                  <input
                    type="text"
                    value={kanbanConcSearch}
                    onChange={(e) => setKanbanConcSearch(e.target.value)}
                    placeholder="Buscar concessionária"
                    className="px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded w-full sm:w-56 text-xs"
                  />

                  <button
                    type="button"
                    onClick={() => setKanbanConcs(concessionarias)}
                    className="px-3 py-2 rounded-md border panel-border panel-bg-60 hover:opacity-90 text-xs"
                  >
                    Selecionar todas
                  </button>

                  <button
                    type="button"
                    onClick={() => setKanbanConcs([])}
                    className="px-3 py-2 rounded-md border panel-border panel-bg-60 hover:opacity-90 text-xs"
                  >
                    Limpar seleção
                  </button>

                  <button
                    type="button"
                    onClick={applyKanbanConcs}
                    className="px-3 py-2 rounded-md border panel-border panel-bg-60 hover:opacity-90 text-xs"
                    disabled={kanbanLoading}
                  >
                    {kanbanLoading ? 'Aplicando...' : 'Aplicar'}
                  </button>
                </div>

                <div className="max-h-32 overflow-auto grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  {filteredKanbanConcs.map((c) => (
                    <label key={`kanban-conc-${c}`} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={kanbanConcs.includes(c)}
                        onChange={(e) => {
                          if (e.target.checked) setKanbanConcs((prev) => [...prev, c]);
                          else setKanbanConcs((prev) => prev.filter((x) => x !== c));
                        }}
                      />
                      <span className="truncate">{c}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Status */}
        <div className="p-4 rounded-lg border panel-border panel-bg-60">
          <div className="text-sm font-semibold mb-3">Status das requisições</div>
          <div className="h-[300px]">
            {hasPositive(statusChart, 'total') ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={statusChart} dataKey="total" nameKey="label" innerRadius={60} outerRadius={110} paddingAngle={2}>
                    {statusChart.map((entry, idx) => (
                      <Cell key={`status-${entry.label}`} fill={pieColors[idx % pieColors.length]} />
                    ))}
                  </Pie>

                  <Tooltip
                    formatter={(v, _name, props) => {
                      const pct = safeNum(props?.payload?.percent);
                      return [`${formatNumber(v)} (${pct.toFixed(1)}%)`, 'Total'];
                    }}
                  />

                  <Legend
                    layout="vertical"
                    align="right"
                    verticalAlign="middle"
                    formatter={(value, entry) => {
                      const tot = getTotalFromLegendEntry(entry);
                      const pct = totalStatus ? (tot / totalStatus) * 100 : 0;
                      return `${value} — ${formatNumber(tot)} (${pct.toFixed(1)}%)`;
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart
                title="Sem dados (Status)"
                hint="O payload veio com status_counts zerado. Verifique se a regex do backend está batendo com os seus status reais."
              />
            )}
          </div>
        </div>
      </div>

      {/* Tendência */}
      <div className="p-4 rounded-lg border panel-border panel-bg-60">
        <div className="text-sm font-semibold mb-3">Tendência 30 dias (movimentações)</div>
        <div className="h-[240px]">
          {Array.isArray(tendenciaChart) && tendenciaChart.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={tendenciaChart} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="dia" tick={{ fontSize: 10 }} minTickGap={16} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => formatNumber(v)} />
                <Line type="monotone" dataKey="total" stroke="var(--accent)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart title="Sem dados (Tendência)" hint="Sem linhas para o período/30 dias." />
          )}
        </div>
      </div>

      {/* Créditos + SLA/aging + etc */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Créditos */}
        <div className="p-4 rounded-lg border panel-border panel-bg-60">
          <div className="text-sm font-semibold mb-3">Composição de Créditos</div>
          <div className="h-[240px]">
            {hasPositive(creditosChart, 'total') ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={creditosChart} dataKey="total" nameKey="label" innerRadius={55} outerRadius={95} paddingAngle={2}>
                    {creditosChart.map((entry, idx) => (
                      <Cell key={`cred-${entry.label}`} fill={pieColors[idx % pieColors.length]} />
                    ))}
                  </Pie>

                  <Tooltip
                    formatter={(v) => {
                      const vv = safeNum(v);
                      const pct = totalCreditos ? (vv / totalCreditos) * 100 : 0;
                      return [`${formatCurrency(vv)} (${pct.toFixed(1)}%)`, 'Valor'];
                    }}
                  />

                  <Legend
                    layout="vertical"
                    align="right"
                    verticalAlign="middle"
                    formatter={(value, entry) => {
                      const tot = getTotalFromLegendEntry(entry);
                      const pct = totalCreditos ? (tot / totalCreditos) * 100 : 0;
                      return `${value} — ${formatCurrency(tot)} (${pct.toFixed(1)}%)`;
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart title="Sem dados (Créditos)" />
            )}
          </div>
        </div>

        {/* SLA */}
        <div className="p-4 rounded-lg border panel-border panel-bg-60">
          <div className="text-sm font-semibold mb-3">SLA (últimos {sla30d.limite_dias || 7} dias)</div>
          <div className="text-sm mb-2">
            No prazo: <strong>{formatNumber(onTime)}</strong> | Atrasados: <strong>{formatNumber(late)}</strong>
          </div>
          <div className="h-2 rounded-full bg-[var(--border)]/60">
            <div className="h-2 rounded-full bg-green-500" style={{ width: `${onTimePct}%` }} />
          </div>
          <div className="text-xs opacity-70 mt-1">{onTimePct}% dentro do prazo</div>

          <div className="mt-4 text-xs opacity-70">
            Aging: 0-7 {formatNumber(agingBuckets['0_7'])} | 8-15 {formatNumber(agingBuckets['8_15'])} | 16-30{' '}
            {formatNumber(agingBuckets['16_30'])} | 31+ {formatNumber(agingBuckets['31_mais'])}
          </div>
        </div>
      </div>

      {/* Canais (pie) + Histograma */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 rounded-lg border panel-border panel-bg-60">
          <div className="text-sm font-semibold mb-3">Canais (30 dias)</div>
          <div className="h-[240px]">
            {hasPositive(canaisChart, 'total') ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={canaisChart} dataKey="total" nameKey="label" innerRadius={50} outerRadius={95} paddingAngle={2}>
                    {canaisChart.map((entry, idx) => (
                      <Cell key={`canal-${entry.label}`} fill={pieColors[idx % pieColors.length]} />
                    ))}
                  </Pie>

                  <Tooltip
                    formatter={(v, _name, props) => {
                      const pct = safeNum(props?.payload?.percent);
                      return [`${formatNumber(v)} (${pct.toFixed(1)}%)`, 'Total'];
                    }}
                  />

                  <Legend
                    layout="vertical"
                    align="right"
                    verticalAlign="middle"
                    formatter={(value, entry) => {
                      const tot = getTotalFromLegendEntry(entry);
                      const pct = totalCanais ? (tot / totalCanais) * 100 : 0;
                      return `${value} — ${formatNumber(tot)} (${pct.toFixed(1)}%)`;
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart title="Sem dados (Canais)" />
            )}
          </div>
        </div>

        <div className="p-4 rounded-lg border panel-border panel-bg-60">
          <div className="text-sm font-semibold mb-3">Histograma de valores</div>
          <div className="space-y-2 text-sm">
            {valorHistogram.map((r, idx) => (
              <div key={`${r.label}-${idx}`} className="flex items-center justify-between">
                <span className="opacity-80">{r.label}</span>
                <span className="font-semibold">{formatNumber(r.total)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Tempo médio + WIP */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 rounded-lg border panel-border panel-bg-60">
          <div className="text-sm font-semibold mb-3">Tempo médio por etapa (dias)</div>
          <div className="space-y-2 text-sm">
            {tempoMedio.slice(0, 10).map((r, idx) => (
              <div key={`${r.etapa}-${idx}`} className="flex items-center justify-between">
                <span className="opacity-80">{r.etapa}</span>
                <span className="font-semibold">{safeNum(r.dias).toFixed(1)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="p-4 rounded-lg border panel-border panel-bg-60">
          <div className="text-sm font-semibold mb-3">WIP por gestor</div>
          <div className="space-y-2 text-sm">
            {wipGestores.slice(0, 10).map((r, idx) => (
              <div key={`${r.label}-${idx}`} className="flex items-center justify-between">
                <span className="opacity-80">{r.label}</span>
                <span className="font-semibold">{formatNumber(r.total)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Conclusão + Repasse */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 rounded-lg border panel-border panel-bg-60">
          <div className="text-sm font-semibold mb-3">Tempo médio de conclusão por concessionária</div>
          <div className="h-[260px]">
            {hasPositive(tempoConclusaoChart, 'dias') ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={tempoConclusaoChart.slice(0, 10)} margin={{ top: 10, right: 12, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} angle={-15} height={40} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v) => `${safeNum(v).toFixed(1)} dias`} />
                  <Bar dataKey="dias" fill="var(--accent)" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart title="Sem dados (Conclusão por concessionária)" />
            )}
          </div>
        </div>

        <div className="p-4 rounded-lg border panel-border panel-bg-60">
          <div className="text-sm font-semibold mb-1">Repasse</div>
          <div className="text-2xl font-semibold mb-2">{formatCurrency(repasseTotal)}</div>
          <div className="text-xs opacity-70 mb-3">Valor total de repasse + empresas que compõem esse valor</div>

          <div className="space-y-1 text-sm max-h-64 overflow-auto">
            {repasseRows.rows.map((r) => {
              const pct = repasseRows.total ? (safeNum(r.total) / repasseRows.total) * 100 : 0;
              return (
                <div key={`rep-${r.label}`} className="flex items-center justify-between gap-2">
                  <span className="truncate opacity-80">{r.label}</span>
                  <span className="font-semibold">
                    {formatCurrency(r.total)} <span className="opacity-70">({pct.toFixed(1)}%)</span>
                  </span>
                </div>
              );
            })}
            {repasseRows.rows.length === 0 && <div className="text-xs opacity-70">Sem dados de repasse no período.</div>}
          </div>
        </div>
      </div>

      {/* Tops */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 rounded-lg border panel-border panel-bg-60">
          <div className="text-sm font-semibold mb-3">Top Concessionárias (valor)</div>
          <div className="space-y-2 text-sm">
            {topConcessionarias.slice(0, 10).map((r, idx) => (
              <div key={`${r.label}-${idx}`} className="flex items-center justify-between">
                <span className="opacity-80">{r.label}</span>
                <span className="font-semibold">{formatCurrency(r.total)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="p-4 rounded-lg border panel-border panel-bg-60">
          <div className="text-sm font-semibold mb-3">Top Clientes (valor)</div>
          <div className="space-y-2 text-sm">
            {topClientes.slice(0, 10).map((r, idx) => (
              <div key={`${r.label}-${idx}`} className="flex items-center justify-between">
                <span className="opacity-80">{r.label}</span>
                <span className="font-semibold">{formatCurrency(r.total)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Throughput (texto, como estava) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 rounded-lg border panel-border panel-bg-60">
          <div className="text-sm font-semibold mb-3">Throughput semanal</div>
          <div className="space-y-2 text-sm">
            {(throughputSemana || []).slice(0, 10).map((r, idx) => (
              <div key={`${r.label}-${idx}`} className="flex items-center justify-between">
                <span className="opacity-80">{r.label}</span>
                <span className="font-semibold">{formatNumber(r.total)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="p-4 rounded-lg border panel-border panel-bg-60">
          <div className="text-sm font-semibold mb-3">Throughput mensal</div>
          <div className="space-y-2 text-sm">
            {(throughputMes || []).slice(0, 10).map((r, idx) => (
              <div key={`${r.label}-${idx}`} className="flex items-center justify-between">
                <span className="opacity-80">{r.label}</span>
                <span className="font-semibold">{formatNumber(r.total)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Tendência mini */}
      <div className="p-4 rounded-lg border panel-border panel-bg-60">
        <div className="text-sm font-semibold mb-3">Tendência 30 dias (últimos 12 pontos)</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs">
          {tendencia30d.slice(-12).map((t) => {
            const width = Math.max(4, Math.round((safeNum(t.total) / trendMax) * 100));
            return (
              <div key={t.dia} className="flex items-center gap-2">
                <span className="w-16 opacity-70">{t.dia}</span>
                <div className="flex-1 h-2 rounded-full bg-[var(--border)]/60">
                  <div className="h-2 rounded-full bg-[var(--accent)]" style={{ width: `${width}%` }} />
                </div>
                <span className="w-10 text-right">{formatNumber(t.total)}</span>
              </div>
            );
          })}
        </div>
      </div>

      {Array.isArray(data?.warnings) && data.warnings.length > 0 && (
        <div className="text-xs opacity-70">Avisos: {data.warnings.join(' | ')}</div>
      )}
    </div>
  );
}
