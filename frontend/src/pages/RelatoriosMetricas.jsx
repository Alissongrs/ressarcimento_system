// frontend/src/pages/RelatoriosMetricas.jsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  RefreshCcw, TrendingUp, Wallet, Award, Clock, Users,
  BarChart2, CheckCircle2, ArrowUpRight, X,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, BarChart, Bar, PieChart, Pie, Cell, Legend,
} from 'recharts';
import { getRelatoriosMetricas, getKanbanComposicao } from '../services/relatoriosService.js';
import { getConcessionariasParaFiltro } from '../services/requisicaoService.js';

/* ── helpers ── */
const safeNum = (v) => Number(v || 0) || 0;
const fmt    = (n) => safeNum(n).toLocaleString('pt-BR');
const fmtR$  = (n) => safeNum(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 });
const fmtMM  = (n) => { const v = safeNum(n); return v >= 1e6 ? `R$ ${(v / 1e6).toFixed(2)}MM` : fmtR$(v); };
const pct    = (a, b) => (b ? Math.round((a / b) * 100) : 0);

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

const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316'];
const hasPositive = (arr, key = 'total') => Array.isArray(arr) && arr.some((x) => safeNum(x?.[key]) > 0);

/* ── sub-components ── */
function EmptyChart({ title, hint }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2" style={{ opacity: 0.5 }}>
      <BarChart2 size={28} />
      <div style={{ fontSize: 12, fontWeight: 600 }}>{title}</div>
      {hint && <div style={{ fontSize: 11, textAlign: 'center', maxWidth: 280 }}>{hint}</div>}
    </div>
  );
}

function SectionCard({ title, subtitle, children, style }) {
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 12, overflow: 'hidden', ...style,
    }}>
      <div style={{ padding: '14px 16px 0' }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--fg)' }}>{title}</div>
        {subtitle && <div style={{ fontSize: 11, opacity: 0.55, marginTop: 2 }}>{subtitle}</div>}
      </div>
      <div style={{ padding: '10px 16px 14px' }}>{children}</div>
    </div>
  );
}

/* horizontal bar row helper */
function HBarRow({ label, value, displayValue, maxValue, color = 'var(--accent)', rank }) {
  const w = maxValue > 0 ? Math.max(2, (value / maxValue) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      {rank != null && (
        <span style={{ width: 18, fontSize: 11, opacity: 0.45, textAlign: 'right', flexShrink: 0 }}>
          {rank}
        </span>
      )}
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--fg)', opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <div style={{ width: 100, height: 6, borderRadius: 4, background: 'var(--border)', flexShrink: 0 }}>
        <div style={{ height: '100%', width: `${w}%`, borderRadius: 4, background: color, transition: 'width 400ms ease' }} />
      </div>
      <span style={{ width: 80, fontSize: 12, fontWeight: 700, textAlign: 'right', flexShrink: 0 }}>{displayValue}</span>
    </div>
  );
}

/* KPI hero card */
function KpiCard({ icon: Icon, label, value, sub, accentColor = 'var(--accent)', trend }) {
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
      padding: '16px', display: 'flex', flexDirection: 'column', gap: 8,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 3,
        background: `linear-gradient(90deg, ${accentColor}, transparent)`,
      }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 9, flexShrink: 0,
          background: `color-mix(in srgb, ${accentColor} 15%, transparent)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={16} style={{ color: accentColor }} />
        </div>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg)', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {label}
        </span>
        {trend != null && (
          <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: trend >= 0 ? 'var(--success)' : 'var(--danger)' }}>
            <ArrowUpRight size={12} style={{ display: 'inline', transform: trend < 0 ? 'rotate(90deg)' : undefined }} />
            {Math.abs(trend)}%
          </span>
        )}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--fg)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, opacity: 0.5 }}>{sub}</div>}
    </div>
  );
}

/* ── Main component ── */
export default function RelatoriosMetricas({ globalFilters }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [metricsModalOpen, setMetricsModalOpen] = useState(false);
  const [metricsTab, setMetricsTab] = useState('estrategicos');
  const [concessionarias, setConcessionarias] = useState([]);
  const [kanbanConcs, setKanbanConcs] = useState([]);
  const [kanbanConcSearch, setKanbanConcSearch] = useState('');
  const [kanbanCounts, setKanbanCounts] = useState(null);
  const [kanbanLoading, setKanbanLoading] = useState(false);
  const [kanbanSelected, setKanbanSelected] = useState(() => new Set(PROCESSOS_CARDS.map((p) => p.key)));

  const load = async (opts = {}) => {
    try {
      setLoading(true);
      setError('');
      const useGlobal = opts.globalFilters || globalFilters || {};
      const res = await getRelatoriosMetricas({
        dataIni: useGlobal?.dataIni || '',
        dataFim: useGlobal?.dataFim || '',
        concessionarias: [],
      });
      setData(res || null);
      setUpdatedAt(new Date());
    } catch (e) {
      setError(e?.message || 'Falha ao carregar métricas.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line
  useEffect(() => { load({ globalFilters }); }, [globalFilters?.dataIni, globalFilters?.dataFim]); // eslint-disable-line
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const list = await getConcessionariasParaFiltro();
        const base = Array.isArray(list) ? list : [];
        const normalized = base
          .map((c) => (typeof c === 'string' ? c : c?.nome ?? c?.concessionaria ?? c?.label ?? ''))
          .map((s) => String(s || '').trim()).filter(Boolean);
        if (mounted) setConcessionarias(Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b)));
      } catch { if (mounted) setConcessionarias([]); }
    })();
    return () => { mounted = false; };
  }, []);
  useEffect(() => { if (kanbanConcs.length === 0) setKanbanCounts(null); }, [kanbanConcs]);

  /* ── derived data ── */
  const processosCounts = data?.processos_counts || {};
  const statusCounts    = data?.status_counts    || {};
  const creditos        = data?.creditos         || {};
  const tendencia30d    = data?.tendencia_30d    || [];
  const agingBuckets    = data?.aging_buckets    || {};
  const tempoMedio      = data?.tempo_medio_dias_por_etapa || [];
  const topConcs        = data?.top_concessionarias || [];
  const topClientes     = data?.top_clientes       || [];
  const throughputSem   = data?.throughput_semana  || [];
  const throughputMes   = data?.throughput_mes     || [];
  const canaisDist      = data?.canais_dist_30d    || [];
  const wipGestores     = data?.wip_gestores        || [];
  const valorHist       = data?.valor_histogram     || [];
  const sla30d          = data?.sla_30d             || {};
  const tempoConcl      = data?.tempo_medio_conclusao_concessionaria || [];
  const repasseConcs    = data?.repasse_por_concessionaria || [];
  const repasseTotal    = safeNum(data?.repasse_total);

  const totalProcessos  = safeNum(data?.total_processos);
  const totalReqs       = safeNum(data?.total_requisicoes);
  const valorTotal      = safeNum(data?.valor_total_ressarcimento);
  const carteiraValor   = safeNum(data?.carteira_valor ?? data?.valor_em_carteira);
  const carteiraProcs   = safeNum(data?.carteira_processos ?? data?.processos_em_carteira);
  const deferidosN      = safeNum(processosCounts?.deferidos);
  const totalProcedente = safeNum(creditos.total_procedente);
  const onTime          = safeNum(sla30d.on_time);
  const late            = safeNum(sla30d.late);
  const totalSla        = onTime + late;
  const onTimePct       = pct(onTime, totalSla);

  /* kanban chart */
  const labelToKey = useMemo(() => new Map(PROCESSOS_CARDS.map((p) => [p.label, p.key])), []);
  const kanbanItems = Array.isArray(kanbanCounts?.items) ? kanbanCounts.items : null;
  const totalKanban = kanbanItems
    ? kanbanItems.reduce((s, it) => s + safeNum(it.total), 0)
    : PROCESSOS_CARDS.reduce((s, p) => s + safeNum(processosCounts[p.key]), 0);

  const kanbanPercentData = useMemo(() => {
    const items = kanbanItems
      ? kanbanItems
          .filter((it) => { const k = labelToKey.get(it.label); return k ? kanbanSelected.has(k) : false; })
          .map((it) => {
            const total = safeNum(it.total);
            const p = it.percent != null ? Number(it.percent) : totalKanban ? (total / totalKanban) * 100 : 0;
            return { key: labelToKey.get(it.label), label: it.label, total, percent: p };
          })
      : PROCESSOS_CARDS.filter((p) => kanbanSelected.has(p.key)).map((p) => {
          const total = safeNum(processosCounts[p.key]);
          return { key: p.key, label: p.label, total, percent: totalKanban ? (total / totalKanban) * 100 : 0 };
        });
    return items.sort((a, b) => b.total - a.total);
  }, [kanbanSelected, kanbanItems, labelToKey, processosCounts, totalKanban]);

  const totalStatus = STATUS_CARDS.reduce((s, x) => s + safeNum(statusCounts[x.key]), 0);
  const statusChart = STATUS_CARDS.map((s) => {
    const total = safeNum(statusCounts[s.key]);
    return { label: s.label, total, percent: totalStatus ? (total / totalStatus) * 100 : 0 };
  });
  const totalCreditos = safeNum(creditos.simples_total) + safeNum(creditos.dobro_total);
  const creditosChart = [
    { label: 'Simples', total: safeNum(creditos.simples_total), percent: totalCreditos ? (safeNum(creditos.simples_total) / totalCreditos) * 100 : 0 },
    { label: 'Dobro',   total: safeNum(creditos.dobro_total),   percent: totalCreditos ? (safeNum(creditos.dobro_total)   / totalCreditos) * 100 : 0 },
  ];
  const totalCanais = canaisDist.reduce((s, x) => s + safeNum(x.total), 0);
  const canaisChart = canaisDist.map((r) => ({ label: r.label, total: safeNum(r.total), percent: totalCanais ? (safeNum(r.total) / totalCanais) * 100 : 0 }));

  const tendenciaChart = tendencia30d.map((t) => ({ dia: t.dia, total: safeNum(t.total) }));
  const throughputSemChart = [...(throughputSem || [])].reverse().map((r) => ({ label: r.label, total: safeNum(r.total) }));
  const throughputMesChart = [...(throughputMes || [])].reverse().map((r) => ({ label: r.label, total: safeNum(r.total) }));
  const tempoConcChart = (tempoConcl || []).slice(0, 8).map((r) => ({ label: r.label, dias: safeNum(r.dias) }));
  const valorHistChart = (valorHist || []).map((r) => ({ label: r.label, total: safeNum(r.total) }));

  const taxaSucesso           = data?.taxa_sucesso_concessionarias || [];
  const taxaSucessoGeral      = safeNum(data?.taxa_sucesso_geral);
  const taxaSucessoPorTipo    = data?.taxa_sucesso_por_tipo || [];
  const ticketMedioReal       = safeNum(data?.ticket_medio);
  const taxaAneelPct          = safeNum(data?.taxa_aneel_pct);
  const backlogCount          = safeNum(data?.backlog_count);
  const resultadosRess        = data?.resultados_ressarcimento || {};
  const resultadosClientes    = data?.resultados_clientes || [];
  const sucess1aAnalisePct    = safeNum(data?.sucesso_primeira_analise_pct);
  const ticketMedio           = ticketMedioReal || (totalProcessos ? valorTotal / totalProcessos : 0);

  const maxTopConc = Math.max(1, ...topConcs.map((r) => safeNum(r.total)));
  const maxTopCli  = Math.max(1, ...topClientes.map((r) => safeNum(r.total)));
  const maxWip     = Math.max(1, ...wipGestores.map((r) => safeNum(r.total)));
  const maxTempo   = Math.max(1, ...tempoMedio.map((r) => safeNum(r.dias)));
  const maxRepasse = Math.max(1, ...repasseConcs.map((r) => safeNum(r.total)));

  const filteredKanbanConcs = useMemo(() => {
    const term = kanbanConcSearch.trim().toLowerCase();
    return term ? concessionarias.filter((c) => c.toLowerCase().includes(term)) : concessionarias;
  }, [concessionarias, kanbanConcSearch]);

  const applyKanbanConcs = async () => {
    setKanbanLoading(true);
    try {
      const res = await getKanbanComposicao({ dataIni: globalFilters?.dataIni || '', dataFim: globalFilters?.dataFim || '', concessionarias: kanbanConcs });
      setKanbanCounts(res || null);
    } catch { setKanbanCounts(null); }
    finally { setKanbanLoading(false); }
  };

  const pieTooltip = (totalRef) => ({ formatter: (v, _n, props) => {
    const p = safeNum(props?.payload?.percent);
    return [`${fmt(v)} (${p.toFixed(1)}%)`, 'Total'];
  }, contentStyle: { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 } });

  const axisStyle = { fill: 'var(--fg)', opacity: 0.5, fontSize: 10 };
  const gridStyle = { stroke: 'var(--border)', strokeDasharray: '3 3' };

  /* ────────────────────────── RENDER ────────────────────────── */
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 18, color: 'var(--fg)' }}>Métricas</div>
          <div style={{ fontSize: 11, opacity: 0.5, marginTop: 2 }}>
            {loading ? 'Atualizando...' : updatedAt ? `Atualizado ${updatedAt.toLocaleString('pt-BR')}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setMetricsModalOpen(true)}
            style={{ padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg)', cursor: 'pointer' }}
          >
            Guia de Métricas
          </button>
          <button
            onClick={() => load({ globalFilters })}
            disabled={loading}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, border: '1px solid var(--border)', background: loading ? 'var(--panel)' : 'linear-gradient(135deg,#1d4ed8,#3b82f6)', color: loading ? 'var(--fg)' : '#fff', cursor: loading ? 'not-allowed' : 'pointer' }}
          >
            <RefreshCcw size={13} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Atualizando...' : 'Atualizar'}
          </button>
        </div>
      </div>

      {/* Período aplicado */}
      {(globalFilters?.dataIni || globalFilters?.dataFim) && (
        <div style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel)', fontSize: 12, opacity: 0.7 }}>
          Período: {globalFilters.dataIni} → {globalFilters.dataFim}
        </div>
      )}

      {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}

      {/* ── KPI Hero strip ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
        <KpiCard icon={Wallet}       label="Carteira (R$)"      value={fmtMM(carteiraValor)}    sub={`${fmt(carteiraProcs)} processos`} accentColor="#3b82f6" />
        <KpiCard icon={TrendingUp}   label="Ticket médio"       value={fmtMM(ticketMedio)}       sub={`${fmt(totalProcessos)} processos`} accentColor="#10b981" />
        <KpiCard icon={Award}        label="% Sucesso geral"    value={`${taxaSucessoGeral.toFixed(1)}%`} sub={`${fmt(deferidosN)} deferidos`} accentColor="#f59e0b" />
        <KpiCard icon={CheckCircle2} label="SLA (7 dias)"       value={`${onTimePct}%`}          sub={`no prazo — ${fmt(late)} atrasados`} accentColor={onTimePct >= 80 ? '#10b981' : onTimePct >= 60 ? '#f59e0b' : '#ef4444'} />
        <KpiCard icon={Clock}        label="Backlog"            value={fmt(backlogCount)}         sub="+60 dias sem movimentação"        accentColor={backlogCount > 50 ? '#ef4444' : backlogCount > 20 ? '#f59e0b' : '#10b981'} />
        <KpiCard icon={Users}        label="Taxa Aneel"         value={`${taxaAneelPct.toFixed(1)}%`} sub="processos que foram à Aneel" accentColor="#8b5cf6" />
      </div>

      {/* ── Estratégicos: Resultados Ressarcimento ── */}
      <SectionCard title="Resultados Ressarcimento" subtitle="Gerado (deferidos+) / Faturado (aba Faturamento) / Caixa (Concluídos)">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {[
            { label: 'Gerado', value: safeNum(resultadosRess.gerado),   color: '#3b82f6', hint: 'Todos os processos que saíram de Ativos' },
            { label: 'Faturado', value: safeNum(resultadosRess.faturado), color: '#f59e0b', hint: 'Processos em Faturamento' },
            { label: 'Caixa', value: safeNum(resultadosRess.caixa),    color: '#10b981', hint: 'Processos Concluídos' },
          ].map((item) => (
            <div key={item.label} style={{ padding: '16px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--panel)', textAlign: 'center' }}>
              <div style={{ width: '100%', height: 3, borderRadius: 3, background: item.color, marginBottom: 12 }} />
              <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.55, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{item.label}</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--fg)' }}>{fmtMM(item.value)}</div>
              <div style={{ fontSize: 11, opacity: 0.45, marginTop: 4 }}>{item.hint}</div>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* ── Kanban + Status ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

        {/* Kanban pie */}
        <SectionCard title="Composição Kanban" subtitle="Distribuição dos processos por coluna">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ height: 260 }}>
              {kanbanSelected.size > 0 && hasPositive(kanbanPercentData, 'total') ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={kanbanPercentData} dataKey="total" nameKey="label" innerRadius={60} outerRadius={100} paddingAngle={2} labelLine={false}>
                      {kanbanPercentData.map((e, i) => <Cell key={e.label} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip {...pieTooltip(totalKanban)} />
                  </PieChart>
                </ResponsiveContainer>
              ) : <EmptyChart title="Sem dados (Kanban)" />}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {PROCESSOS_CARDS.map((p, i) => {
                const v = safeNum(processosCounts[p.key]);
                return (
                  <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
                    <input type="checkbox" checked={kanbanSelected.has(p.key)} onChange={(e) => setKanbanSelected((prev) => { const n = new Set(prev); e.target.checked ? n.add(p.key) : n.delete(p.key); return n; })} />
                    <span style={{ width: 10, height: 10, borderRadius: 3, flexShrink: 0, background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span style={{ flex: 1, opacity: 0.8 }}>{p.label}</span>
                    <span style={{ fontWeight: 700 }}>{fmt(v)}</span>
                  </label>
                );
              })}
              {/* Filtro concessionária */}
              <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>Filtrar por concessionária</div>
                <input type="text" value={kanbanConcSearch} onChange={(e) => setKanbanConcSearch(e.target.value)}
                  placeholder="Buscar..." style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--fg)', fontSize: 11, marginBottom: 4 }} />
                <div style={{ maxHeight: 80, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {filteredKanbanConcs.map((c) => (
                    <label key={c} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}>
                      <input type="checkbox" checked={kanbanConcs.includes(c)} onChange={(e) => { if (e.target.checked) setKanbanConcs((p) => [...p, c]); else setKanbanConcs((p) => p.filter((x) => x !== c)); }} />
                      <span style={{ truncate: true }}>{c}</span>
                    </label>
                  ))}
                </div>
                <button onClick={applyKanbanConcs} disabled={kanbanLoading} style={{ marginTop: 6, padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer' }}>
                  {kanbanLoading ? 'Aplicando...' : 'Aplicar filtro'}
                </button>
              </div>
            </div>
          </div>
        </SectionCard>

        {/* Status pie */}
        <SectionCard title="Status das Requisições" subtitle="Distribuição por status de triagem">
          <div style={{ height: 260 }}>
            {hasPositive(statusChart, 'total') ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={statusChart} dataKey="total" nameKey="label" innerRadius={60} outerRadius={100} paddingAngle={2}>
                    {statusChart.map((e, i) => <Cell key={e.label} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip {...pieTooltip(totalStatus)} />
                  <Legend layout="vertical" align="right" verticalAlign="middle"
                    formatter={(v, e) => { const t = safeNum(e?.payload?.payload?.total); const p = totalStatus ? (t / totalStatus * 100).toFixed(1) : 0; return `${v} — ${fmt(t)} (${p}%)`; }}
                    wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            ) : <EmptyChart title="Sem dados (Status)" hint="Verifique se os status batem com os padrões esperados." />}
          </div>
        </SectionCard>
      </div>

      {/* ── Tendência 30d ── */}
      <SectionCard title="Tendência de movimentações (30 dias)" subtitle="Volume diário de movimentações registradas">
        <div style={{ height: 200 }}>
          {tendenciaChart.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={tendenciaChart} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="dia" tick={axisStyle} minTickGap={20} />
                <YAxis tick={axisStyle} />
                <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} formatter={(v) => fmt(v)} />
                <Line type="monotone" dataKey="total" stroke="#3b82f6" strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : <EmptyChart title="Sem dados (Tendência)" />}
        </div>
      </SectionCard>

      {/* ── Throughput semana + mês ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="Throughput Semanal" subtitle="Novas requisições por semana">
          <div style={{ height: 200 }}>
            {hasPositive(throughputSemChart, 'total') ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={throughputSemChart.slice(-12)} margin={{ top: 4, right: 8, left: 0, bottom: 20 }}>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="label" tick={axisStyle} angle={-30} height={40} interval={0} />
                  <YAxis tick={axisStyle} />
                  <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} formatter={(v) => fmt(v)} />
                  <Bar dataKey="total" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyChart title="Sem dados" />}
          </div>
        </SectionCard>

        <SectionCard title="Throughput Mensal" subtitle="Novas requisições por mês">
          <div style={{ height: 200 }}>
            {hasPositive(throughputMesChart, 'total') ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={throughputMesChart.slice(-12)} margin={{ top: 4, right: 8, left: 0, bottom: 20 }}>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="label" tick={axisStyle} angle={-30} height={40} interval={0} />
                  <YAxis tick={axisStyle} />
                  <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} formatter={(v) => fmt(v)} />
                  <Bar dataKey="total" fill="#10b981" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyChart title="Sem dados" />}
          </div>
        </SectionCard>
      </div>

      {/* ── SLA + Aging + Créditos ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>

        {/* SLA */}
        <SectionCard title="SLA" subtitle={`Últimos ${sla30d.limite_dias || 7} dias`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 36, fontWeight: 800, color: onTimePct >= 80 ? 'var(--success)' : onTimePct >= 60 ? 'var(--warning)' : 'var(--danger)' }}>
                {onTimePct}%
              </div>
              <div style={{ fontSize: 11, opacity: 0.5 }}>dentro do prazo</div>
            </div>
            <div style={{ height: 8, borderRadius: 6, background: 'var(--border)' }}>
              <div style={{ height: '100%', borderRadius: 6, width: `${onTimePct}%`, background: onTimePct >= 80 ? 'var(--success)' : onTimePct >= 60 ? 'var(--warning)' : 'var(--danger)', transition: 'width 500ms ease' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <span style={{ color: 'var(--success)' }}>✓ {fmt(onTime)} no prazo</span>
              <span style={{ color: 'var(--danger)' }}>✗ {fmt(late)} atrasados</span>
            </div>
          </div>
        </SectionCard>

        {/* Aging */}
        <SectionCard title="Aging (sem movimentação)" subtitle="Distribuição por tempo parado">
          {[
            { label: '0 – 7 dias',   value: safeNum(agingBuckets['0_7']),    color: '#10b981' },
            { label: '8 – 15 dias',  value: safeNum(agingBuckets['8_15']),   color: '#f59e0b' },
            { label: '16 – 30 dias', value: safeNum(agingBuckets['16_30']),  color: '#f97316' },
            { label: '31+ dias',     value: safeNum(agingBuckets['31_mais']), color: '#ef4444' },
          ].map((b) => {
            const total = safeNum(agingBuckets['0_7']) + safeNum(agingBuckets['8_15']) + safeNum(agingBuckets['16_30']) + safeNum(agingBuckets['31_mais']);
            const w = total ? (b.value / total) * 100 : 0;
            return (
              <div key={b.label} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                  <span style={{ opacity: 0.7 }}>{b.label}</span>
                  <span style={{ fontWeight: 700, color: b.color }}>{fmt(b.value)}</span>
                </div>
                <div style={{ height: 6, borderRadius: 4, background: 'var(--border)' }}>
                  <div style={{ height: '100%', borderRadius: 4, width: `${w}%`, background: b.color, transition: 'width 400ms' }} />
                </div>
              </div>
            );
          })}
        </SectionCard>

        {/* Créditos */}
        <SectionCard title="Composição de Créditos" subtitle="Simples vs Dobro">
          <div style={{ height: 160 }}>
            {hasPositive(creditosChart, 'total') ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={creditosChart} dataKey="total" nameKey="label" innerRadius={45} outerRadius={70} paddingAngle={3}>
                    {creditosChart.map((e, i) => <Cell key={e.label} fill={PIE_COLORS[i]} />)}
                  </Pie>
                  <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                    formatter={(v) => { const p = totalCreditos ? (v / totalCreditos * 100).toFixed(1) : 0; return [`${fmtR$(v)} (${p}%)`, 'Valor']; }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            ) : <EmptyChart title="Sem dados (Créditos)" />}
          </div>
          {totalProcedente > 0 && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ opacity: 0.6 }}>Total procedente</span>
                <span style={{ fontWeight: 700 }}>{fmtR$(totalProcedente)}</span>
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      {/* ── Top Concessionárias + Clientes ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="Top Concessionárias" subtitle="Por valor estimado de ressarcimento">
          {topConcs.length > 0 ? topConcs.slice(0, 8).map((r, i) => (
            <HBarRow key={r.label} rank={i + 1} label={r.label} value={safeNum(r.total)} displayValue={fmtMM(r.total)} maxValue={maxTopConc} color="#3b82f6" />
          )) : <div style={{ fontSize: 12, opacity: 0.5 }}>Sem dados</div>}
        </SectionCard>

        <SectionCard title="Top Clientes" subtitle="Por valor estimado de ressarcimento">
          {topClientes.length > 0 ? topClientes.slice(0, 8).map((r, i) => (
            <HBarRow key={r.label} rank={i + 1} label={r.label} value={safeNum(r.total)} displayValue={fmtMM(r.total)} maxValue={maxTopCli} color="#10b981" />
          )) : <div style={{ fontSize: 12, opacity: 0.5 }}>Sem dados</div>}
        </SectionCard>
      </div>

      {/* ── Tempo médio etapa + WIP gestores ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="Tempo médio por etapa" subtitle="Dias em cada etapa (dwell time)">
          {tempoMedio.length > 0 ? tempoMedio.slice(0, 10).map((r) => (
            <HBarRow key={r.etapa} label={r.etapa} value={safeNum(r.dias)} displayValue={`${safeNum(r.dias).toFixed(1)}d`} maxValue={maxTempo} color="#f59e0b" />
          )) : <div style={{ fontSize: 12, opacity: 0.5 }}>Sem dados</div>}
        </SectionCard>

        <SectionCard title="WIP por Gestor" subtitle="Processos ativos em andamento por responsável">
          {wipGestores.length > 0 ? wipGestores.slice(0, 10).map((r) => (
            <HBarRow key={r.label} label={r.label} value={safeNum(r.total)} displayValue={fmt(r.total)} maxValue={maxWip} color="#8b5cf6" />
          )) : <div style={{ fontSize: 12, opacity: 0.5 }}>Sem dados</div>}
        </SectionCard>
      </div>

      {/* ── Taxa de sucesso por concessionária ── */}
      {taxaSucesso.length > 0 && (
        <SectionCard title="Taxa de Sucesso por Concessionária" subtitle="% de processos deferidos (mín. 2 processos concluídos)">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {taxaSucesso.map((r) => {
              const taxa = safeNum(r.taxa_pct);
              const color = taxa >= 70 ? '#10b981' : taxa >= 40 ? '#f59e0b' : '#ef4444';
              return (
                <div key={r.label} style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--panel)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
                      {r.label}
                    </span>
                    <span style={{ fontSize: 14, fontWeight: 800, color, flexShrink: 0 }}>{taxa.toFixed(0)}%</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 4, background: 'var(--border)', marginBottom: 4 }}>
                    <div style={{ height: '100%', borderRadius: 4, width: `${Math.min(100, taxa)}%`, background: color, transition: 'width 400ms' }} />
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.5 }}>
                    {fmt(r.deferidos)} deferidos / {fmt(r.total)} processos
                  </div>
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}

      {/* ── % Sucesso por tipo + Resultados clientes ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="% Sucesso por Tipo de Irregularidade" subtitle="Processos que avançaram além de Ativos por tipo">
          {taxaSucessoPorTipo.length > 0 ? taxaSucessoPorTipo.map((r) => {
            const taxa = safeNum(r.taxa_pct);
            const color = taxa >= 70 ? '#10b981' : taxa >= 40 ? '#f59e0b' : '#ef4444';
            return (
              <div key={r.label} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                  <span style={{ opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '65%' }}>{r.label}</span>
                  <span style={{ fontWeight: 700, color, flexShrink: 0 }}>{taxa.toFixed(0)}% <span style={{ opacity: 0.45, fontWeight: 400 }}>({fmt(r.sucesso)}/{fmt(r.total)})</span></span>
                </div>
                <div style={{ height: 6, borderRadius: 4, background: 'var(--border)' }}>
                  <div style={{ height: '100%', borderRadius: 4, width: `${Math.min(100, taxa)}%`, background: color, transition: 'width 400ms' }} />
                </div>
              </div>
            );
          }) : <div style={{ fontSize: 12, opacity: 0.5 }}>Sem dados</div>}
        </SectionCard>

        <SectionCard title="Resultados por Cliente" subtitle="Valor ressarcido (simples + dobro) por cliente">
          {resultadosClientes.length > 0 ? resultadosClientes.slice(0, 12).map((r, i) => {
            const total = safeNum(r.total);
            const maxCli = Math.max(1, ...resultadosClientes.map((x) => safeNum(x.total)));
            return (
              <div key={r.label} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                  <span style={{ opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%' }}>{i + 1}. {r.label}</span>
                  <span style={{ fontWeight: 700, flexShrink: 0 }}>
                    {fmtMM(total)}
                    <span style={{ fontSize: 10, opacity: 0.45, marginLeft: 4 }}>S:{fmtMM(r.simples)} D:{fmtMM(r.dobro)}</span>
                  </span>
                </div>
                <div style={{ height: 4, borderRadius: 3, background: 'var(--border)' }}>
                  <div style={{ height: '100%', borderRadius: 3, width: `${(total / maxCli) * 100}%`, background: '#3b82f6', transition: 'width 400ms' }} />
                </div>
              </div>
            );
          }) : <div style={{ fontSize: 12, opacity: 0.5 }}>Sem dados de clientes ressarcidos</div>}
        </SectionCard>
      </div>

      {/* ── % Sucesso 1ª análise ── */}
      {sucess1aAnalisePct > 0 && (
        <SectionCard title="% Sucesso na Primeira Análise" subtitle="Processos deferidos sem passar por etapa além da Distribuidora">
          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            <div style={{ textAlign: 'center', flexShrink: 0 }}>
              <div style={{ fontSize: 40, fontWeight: 800, color: sucess1aAnalisePct >= 50 ? 'var(--success)' : sucess1aAnalisePct >= 30 ? 'var(--warning)' : 'var(--danger)' }}>
                {sucess1aAnalisePct.toFixed(1)}%
              </div>
              <div style={{ fontSize: 11, opacity: 0.5 }}>dos deferidos</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ height: 10, borderRadius: 6, background: 'var(--border)' }}>
                <div style={{ height: '100%', borderRadius: 6, width: `${Math.min(100, sucess1aAnalisePct)}%`, background: sucess1aAnalisePct >= 50 ? 'var(--success)' : sucess1aAnalisePct >= 30 ? 'var(--warning)' : 'var(--danger)', transition: 'width 500ms ease' }} />
              </div>
              <div style={{ fontSize: 12, opacity: 0.55, marginTop: 8 }}>
                Processos aprovados apenas na etapa Distribuidora, sem necessidade de escalonamento
              </div>
            </div>
          </div>
        </SectionCard>
      )}

      {/* ── Histograma de valores + Canais ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="Histograma de Valores" subtitle="Concentração de processos por faixa de valor">
          <div style={{ height: 200 }}>
            {hasPositive(valorHistChart, 'total') ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={valorHistChart} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="label" tick={axisStyle} />
                  <YAxis tick={axisStyle} />
                  <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} formatter={(v) => fmt(v)} />
                  <Bar dataKey="total" fill="#06b6d4" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyChart title="Sem dados (Histograma)" />}
          </div>
        </SectionCard>

        <SectionCard title="Canais de Comunicação (30 dias)" subtitle="Distribuição de movimentações por canal">
          <div style={{ height: 200 }}>
            {hasPositive(canaisChart, 'total') ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={canaisChart} dataKey="total" nameKey="label" innerRadius={50} outerRadius={85} paddingAngle={3}>
                    {canaisChart.map((e, i) => <Cell key={e.label} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip {...pieTooltip(totalCanais)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            ) : <EmptyChart title="Sem dados (Canais)" />}
          </div>
        </SectionCard>
      </div>

      {/* ── Tempo conclusão por conc + Repasse ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="Tempo médio de conclusão" subtitle="Dias até encerramento por concessionária">
          <div style={{ height: 220 }}>
            {hasPositive(tempoConcChart, 'dias') ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={tempoConcChart} layout="vertical" margin={{ top: 4, right: 60, left: 0, bottom: 4 }}>
                  <CartesianGrid {...gridStyle} horizontal={false} />
                  <XAxis type="number" tick={axisStyle} />
                  <YAxis type="category" dataKey="label" tick={axisStyle} width={80} />
                  <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} formatter={(v) => `${safeNum(v).toFixed(1)} dias`} />
                  <Bar dataKey="dias" fill="#f97316" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyChart title="Sem dados (Conclusão por concessionária)" />}
          </div>
        </SectionCard>

        <SectionCard title="Repasse por Concessionária" subtitle={`Total: ${fmtMM(repasseTotal)}`}>
          {repasseConcs.length > 0 ? repasseConcs.slice(0, 8).map((r) => (
            <HBarRow key={r.label} label={r.label} value={safeNum(r.total)} displayValue={fmtMM(r.total)} maxValue={maxRepasse} color="#06b6d4" />
          )) : <div style={{ fontSize: 12, opacity: 0.5 }}>Sem dados de repasse no período.</div>}
        </SectionCard>
      </div>

      {/* warnings */}
      {Array.isArray(data?.warnings) && data.warnings.length > 0 && (
        <div style={{ fontSize: 11, opacity: 0.5 }}>Avisos: {data.warnings.join(' | ')}</div>
      )}

      {/* ── Modal Guia de Métricas ── */}
      {metricsModalOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setMetricsModalOpen(false); }}>
          <div style={{ width: '100%', maxWidth: 680, maxHeight: '90vh', overflow: 'auto', borderRadius: 14, background: 'var(--card)', border: '1px solid var(--border)', padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16 }}>Guia de Métricas</div>
                <div style={{ fontSize: 12, opacity: 0.5 }}>Selecione a categoria para ver as métricas</div>
              </div>
              <button onClick={() => setMetricsModalOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg)', opacity: 0.6 }}><X size={18} /></button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              {[{ key: 'estrategicos', label: 'Estratégicos' }, { key: 'taticos', label: 'Táticos' }, { key: 'operacionais', label: 'Operacionais' }].map((t) => (
                <button key={t.key} onClick={() => setMetricsTab(t.key)} style={{ padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid', borderColor: metricsTab === t.key ? 'var(--accent)' : 'var(--border)', background: metricsTab === t.key ? 'rgba(59,130,246,0.12)' : 'transparent', color: metricsTab === t.key ? 'var(--accent)' : 'var(--fg)' }}>
                  {t.label}
                </button>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {METRICAS_GUIA[metricsTab].map((item) => (
                <div key={item} style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel)', fontSize: 12 }}>
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
