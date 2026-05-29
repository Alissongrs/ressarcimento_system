// frontend/src/pages/RelatoriosMetricas.jsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  RefreshCcw, TrendingUp, Wallet, Award, Clock, Users,
  BarChart2, CheckCircle2, ArrowUpRight, X,
  Activity, AlertTriangle, Target, Zap, DollarSign, Filter,
  Sparkles,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, BarChart, Bar, PieChart, Pie, Cell, Legend, AreaChart, Area,
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

function SectionCard({ title, subtitle, children, style, icon: Icon, accent = 'var(--accent)' }) {
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 12, overflow: 'hidden', ...style,
    }}>
      <div style={{ padding: '14px 16px 0', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        {Icon && (
          <div style={{
            width: 30, height: 30, borderRadius: 8, flexShrink: 0,
            background: `color-mix(in srgb, ${accent} 14%, transparent)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon size={15} style={{ color: accent }} />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--fg)' }}>{title}</div>
          {subtitle && <div style={{ fontSize: 11, opacity: 0.55, marginTop: 2 }}>{subtitle}</div>}
        </div>
      </div>
      <div style={{ padding: '10px 16px 14px' }}>{children}</div>
    </div>
  );
}

/* mini sparkline para inserir dentro de KpiCard */
function Sparkline({ data, color = 'var(--accent)', height = 36 }) {
  const series = Array.isArray(data) && data.length > 0 ? data : [];
  if (series.length < 2) {
    return <div style={{ height, opacity: 0.3, fontSize: 10, display: 'flex', alignItems: 'center' }}>—</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={series} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`sparkfill-${color.replace(/[^a-z0-9]/gi, '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={color} fill={`url(#sparkfill-${color.replace(/[^a-z0-9]/gi, '')})`} strokeWidth={1.6} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* KPI hero — versão grande para os indicadores principais */
function KpiHeroCard({ icon: Icon, label, value, sub, accentColor = 'var(--accent)', sparkData, delta }) {
  const deltaColor = delta == null ? null : delta >= 0 ? '#10b981' : '#ef4444';
  return (
    <div style={{
      background: 'var(--card)', border: '2px solid var(--border)', borderRadius: 14,
      padding: '20px', display: 'flex', flexDirection: 'column', gap: 12,
      position: 'relative', overflow: 'hidden', minHeight: 180,
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 4,
        background: `linear-gradient(90deg, ${accentColor}, color-mix(in srgb, ${accentColor} 30%, transparent))`,
      }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 42, height: 42, borderRadius: 11, flexShrink: 0,
          background: `color-mix(in srgb, ${accentColor} 18%, transparent)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={20} style={{ color: accentColor }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {label}
          </div>
          {sub && <div style={{ fontSize: 11, opacity: 0.5, marginTop: 2 }}>{sub}</div>}
        </div>
        {delta != null && (
          <span style={{ fontSize: 12, fontWeight: 700, color: deltaColor, whiteSpace: 'nowrap', flexShrink: 0 }}>
            <ArrowUpRight size={13} style={{ display: 'inline', transform: delta < 0 ? 'rotate(90deg)' : undefined, marginRight: 2 }} />
            {Math.abs(delta).toFixed(1)}%
          </span>
        )}
      </div>
      <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--fg)', lineHeight: 1, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {Array.isArray(sparkData) && sparkData.length > 1 && (
        <div style={{ marginTop: 'auto' }}>
          <Sparkline data={sparkData} color={accentColor} height={40} />
        </div>
      )}
    </div>
  );
}

/* Resumo Executivo — narrativa em texto sobre o estado da operação */
function ExecutiveSummary({ items }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div style={{
      background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent) 8%, var(--card)), var(--card))',
      border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px',
      display: 'flex', alignItems: 'flex-start', gap: 14,
    }}>
      <div style={{
        width: 38, height: 38, borderRadius: 10, flexShrink: 0,
        background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Sparkles size={18} style={{ color: 'var(--accent)' }} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
          Resumo executivo
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '8px 18px' }}>
          {items.map((it, i) => (
            <div key={i} style={{ fontSize: 13, color: 'var(--fg)', lineHeight: 1.45 }}>
              {it.icon && <span style={{ marginRight: 6 }}>{it.icon}</span>}
              {it.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* Funil de conversão Ativos → ... → Caixa */
function ConversionFunnel({ stages }) {
  const valid = (stages || []).filter((s) => s);
  if (valid.length === 0) return null;
  const max = Math.max(1, ...valid.map((s) => safeNum(s.count)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {valid.map((s, i) => {
        const w = (safeNum(s.count) / max) * 100;
        const prev = i > 0 ? valid[i - 1] : null;
        const conv = prev && safeNum(prev.count) > 0 ? (safeNum(s.count) / safeNum(prev.count)) * 100 : null;
        return (
          <div key={s.label}>
            {prev && (
              <div style={{ fontSize: 10, opacity: 0.5, padding: '0 6px', textAlign: 'center', marginBottom: 2 }}>
                ↓ {conv != null ? `${conv.toFixed(1)}%` : '—'} convertem
              </div>
            )}
            <div style={{
              padding: '10px 14px', borderRadius: 10, background: 'var(--panel)',
              border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10,
              position: 'relative', overflow: 'hidden',
            }}>
              <div style={{
                position: 'absolute', top: 0, bottom: 0, left: 0, width: `${w}%`,
                background: `color-mix(in srgb, ${s.color} 18%, transparent)`,
                transition: 'width 500ms ease',
              }} />
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                <div style={{
                  width: 8, height: 28, borderRadius: 3, background: s.color, flexShrink: 0,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--fg)' }}>{s.label}</div>
                  {s.hint && <div style={{ fontSize: 10, opacity: 0.5 }}>{s.hint}</div>}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{fmt(s.count)}</div>
                  {s.value != null && <div style={{ fontSize: 11, opacity: 0.6, fontVariantNumeric: 'tabular-nums' }}>{fmtMM(s.value)}</div>}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* Painel de Saúde com KPIs operacionais */
function HealthIndicator({ icon: Icon, label, value, severity, hint }) {
  const sev = severity || 'neutral';
  const colors = {
    ok: { bg: 'rgba(16,185,129,0.10)', fg: '#10b981', border: 'rgba(16,185,129,0.35)' },
    warn: { bg: 'rgba(245,158,11,0.10)', fg: '#f59e0b', border: 'rgba(245,158,11,0.35)' },
    crit: { bg: 'rgba(239,68,68,0.10)', fg: '#ef4444', border: 'rgba(239,68,68,0.35)' },
    neutral: { bg: 'var(--panel)', fg: 'var(--fg)', border: 'var(--border)' },
  };
  const c = colors[sev];
  return (
    <div style={{
      padding: '12px 14px', borderRadius: 10, background: c.bg, border: `1px solid ${c.border}`,
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <Icon size={20} style={{ color: c.fg, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: c.fg, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        {hint && <div style={{ fontSize: 10, opacity: 0.5, marginTop: 2 }}>{hint}</div>}
      </div>
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
  const [viewTab, setViewTab] = useState('todos');
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

  const show = (...cats) => viewTab === 'todos' || cats.includes(viewTab);

  const VIEW_TABS = [
    { key: 'todos',        label: 'Todos' },
    { key: 'operacional',  label: 'Operacional' },
  ];

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

      {/* ── Abas de visão ── */}
      <div style={{ display: 'flex', gap: 4, padding: '4px', borderRadius: 10, background: 'var(--panel)', border: '1px solid var(--border)', width: 'fit-content' }}>
        {VIEW_TABS.map((t) => (
          <button key={t.key} onClick={() => setViewTab(t.key)} style={{
            padding: '6px 16px', borderRadius: 7, fontSize: 12, fontWeight: 600,
            cursor: 'pointer', border: 'none', transition: 'all 140ms',
            background: viewTab === t.key ? 'var(--accent)' : 'transparent',
            color: viewTab === t.key ? '#fff' : 'var(--fg)',
            opacity: viewTab === t.key ? 1 : 0.65,
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Período aplicado */}
      {(globalFilters?.dataIni || globalFilters?.dataFim) && (
        <div style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel)', fontSize: 12, opacity: 0.7 }}>
          Período: {globalFilters.dataIni} → {globalFilters.dataFim}
        </div>
      )}

      {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}

      {/* ── Resumo executivo (narrativa) ── */}
      {(() => {
        const summary = [];
        if (carteiraProcs > 0 || carteiraValor > 0) {
          summary.push({
            text: <>Carteira ativa de <b>{fmt(carteiraProcs)}</b> processos somando <b>{fmtMM(carteiraValor)}</b>.</>,
          });
        }
        if (resultadosRess.caixa > 0) {
          summary.push({
            text: <>Receita em caixa de <b>{fmtMM(resultadosRess.caixa)}</b> nos processos concluídos.</>,
          });
        }
        if (totalSla > 0) {
          summary.push({
            text: <><b>{onTimePct}%</b> dentro do prazo SLA — <b>{fmt(late)}</b> atrasados.</>,
          });
        }
        const travados = safeNum(agingBuckets['31_mais']);
        if (travados > 0) {
          summary.push({
            text: <>⚠️ <b>{fmt(travados)}</b> processos travados há mais de 30 dias precisam atenção.</>,
          });
        }
        if (taxaSucessoGeral > 0) {
          summary.push({
            text: <>Taxa de sucesso geral: <b>{taxaSucessoGeral.toFixed(1)}%</b> ({fmt(deferidosN)} deferidos).</>,
          });
        }
        return summary.length > 0 ? <ExecutiveSummary items={summary} /> : null;
      })()}

      {/* ── KPI Hero (2 cards principais grandes) ── */}
      {(() => {
        const sparkData = (tendencia30d || []).slice(-14).map((t) => ({ v: safeNum(t.total) }));
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14 }}>
            <KpiHeroCard
              icon={Wallet}
              label="Carteira em aberto"
              value={fmtMM(carteiraValor)}
              sub={`${fmt(carteiraProcs)} processos ativos`}
              accentColor="#3b82f6"
              sparkData={sparkData}
            />
            <KpiHeroCard
              icon={DollarSign}
              label="Receita em caixa"
              value={fmtMM(safeNum(resultadosRess.caixa))}
              sub={`Concluídos · gerado ${fmtMM(safeNum(resultadosRess.gerado))}`}
              accentColor="#10b981"
              sparkData={sparkData}
            />
          </div>
        );
      })()}

      {/* ── KPI strip secundário (cards menores) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
        <KpiCard icon={TrendingUp}   label="Ticket médio"       value={fmtMM(ticketMedio)}       sub={`${fmt(totalProcessos)} processos`} accentColor="#0ea5e9" />
        <KpiCard icon={Award}        label="% Sucesso geral"    value={`${taxaSucessoGeral.toFixed(1)}%`} sub={`${fmt(deferidosN)} deferidos`} accentColor="#f59e0b" />
        <KpiCard icon={CheckCircle2} label="SLA (7 dias)"       value={`${onTimePct}%`}          sub={`no prazo — ${fmt(late)} atrasados`} accentColor={onTimePct >= 80 ? '#10b981' : onTimePct >= 60 ? '#f59e0b' : '#ef4444'} />
        <KpiCard icon={Clock}        label="Backlog"            value={fmt(backlogCount)}         sub="+60 dias sem movimentação"        accentColor={backlogCount > 50 ? '#ef4444' : backlogCount > 20 ? '#f59e0b' : '#10b981'} />
        <KpiCard icon={Users}        label="Taxa Aneel"         value={`${taxaAneelPct.toFixed(1)}%`} sub="processos que foram à Aneel" accentColor="#8b5cf6" />
      </div>

      {/* ── Funil de conversão + Painel de saúde ── */}
      {show('estrategico', 'tatico') && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 16 }}>
          <SectionCard
            title="Funil de conversão"
            subtitle="Jornada Ativos → Caixa com taxa de avanço entre etapas"
            icon={Target}
            accent="#3b82f6"
          >
            <ConversionFunnel
              stages={[
                { label: 'Ativos',     count: safeNum(processosCounts.ativos),     value: null,                                  color: '#3b82f6', hint: 'Em andamento' },
                { label: 'Deferidos',  count: safeNum(processosCounts.deferidos),  value: safeNum(creditos.simples_total) + safeNum(creditos.dobro_total), color: '#8b5cf6', hint: 'Aprovação técnica' },
                { label: 'Fluxo',      count: safeNum(processosCounts.fluxo_ressarcimento), value: null,                          color: '#06b6d4', hint: 'Devolução em andamento' },
                { label: 'Faturamento',count: safeNum(processosCounts.faturamento),value: safeNum(resultadosRess.faturado),       color: '#f59e0b', hint: 'NF emitida' },
                { label: 'Caixa',      count: safeNum(processosCounts.concluidos), value: safeNum(resultadosRess.caixa),          color: '#10b981', hint: 'Recebido' },
              ]}
            />
          </SectionCard>

          <SectionCard
            title="Painel de saúde"
            subtitle="Indicadores que demandam atenção operacional"
            icon={Activity}
            accent="#ef4444"
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {(() => {
                const travados = safeNum(agingBuckets['31_mais']);
                const sev = travados > 50 ? 'crit' : travados > 10 ? 'warn' : travados > 0 ? 'warn' : 'ok';
                return (
                  <HealthIndicator
                    icon={AlertTriangle}
                    label="Travados +30d"
                    value={fmt(travados)}
                    severity={sev}
                    hint="Sem movimentação há mais de 30 dias"
                  />
                );
              })()}
              {(() => {
                const sev = backlogCount > 50 ? 'crit' : backlogCount > 20 ? 'warn' : backlogCount > 0 ? 'warn' : 'ok';
                return (
                  <HealthIndicator
                    icon={Clock}
                    label="Backlog"
                    value={fmt(backlogCount)}
                    severity={sev}
                    hint="+60 dias sem progredir"
                  />
                );
              })()}
              {(() => {
                const sev = late > 20 ? 'crit' : late > 5 ? 'warn' : late > 0 ? 'warn' : 'ok';
                return (
                  <HealthIndicator
                    icon={Zap}
                    label="Prazos vencidos"
                    value={fmt(late)}
                    severity={sev}
                    hint={`Limite: ${sla30d.limite_dias || 7}d`}
                  />
                );
              })()}
              {(() => {
                const cur = throughputSemChart[throughputSemChart.length - 1]?.total || 0;
                const prev = throughputSemChart[throughputSemChart.length - 2]?.total || 0;
                const delta = prev > 0 ? ((cur - prev) / prev) * 100 : null;
                const sev = delta == null ? 'neutral' : delta > 0 ? 'ok' : delta < -20 ? 'crit' : 'warn';
                return (
                  <HealthIndicator
                    icon={TrendingUp}
                    label="Throughput semanal"
                    value={fmt(cur)}
                    severity={sev}
                    hint={delta == null ? 'Sem comparativo' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% vs semana anterior`}
                  />
                );
              })()}
            </div>
          </SectionCard>
        </div>
      )}

      {/* ── Estratégicos: Resultados Ressarcimento ── */}
      {show('estrategico') && <SectionCard title="Resultados Ressarcimento" subtitle="Gerado (deferidos+) / Faturado (aba Faturamento) / Caixa (Concluídos)" icon={DollarSign} accent="#10b981">
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
      </SectionCard>}

      {/* ── Kanban + Status ── */}
      {show('estrategico', 'tatico') && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

        {/* Kanban pie */}
        <SectionCard title="Composição Kanban" subtitle="Distribuição dos processos por coluna" icon={BarChart2} accent="#3b82f6">
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
        <SectionCard title="Status das Requisições" subtitle="Distribuição por status de triagem" icon={Filter} accent="#8b5cf6">
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
      </div>}

      {/* ── Tendência 30d ── */}
      {show('tatico', 'operacional') && <SectionCard title="Tendência de movimentações (30 dias)" subtitle="Volume diário de movimentações registradas" icon={Activity} accent="#3b82f6">
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
      </SectionCard>}

      {/* ── Throughput semana + mês ── */}
      {show('tatico', 'operacional') && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="Throughput Semanal" subtitle="Novas requisições por semana" icon={TrendingUp} accent="#3b82f6">
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

        <SectionCard title="Throughput Mensal" subtitle="Novas requisições por mês" icon={TrendingUp} accent="#10b981">
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
      </div>}

      {/* ── SLA + Aging + Créditos ── */}
      {show('tatico') && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>

        {/* SLA */}
        <SectionCard title="SLA" subtitle={`Últimos ${sla30d.limite_dias || 7} dias`} icon={CheckCircle2} accent={onTimePct >= 80 ? '#10b981' : onTimePct >= 60 ? '#f59e0b' : '#ef4444'}>
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
        <SectionCard title="Aging (sem movimentação)" subtitle="Excluindo concluídos, indeferidos e suspensos" icon={Clock} accent="#f59e0b">
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
        <SectionCard title="Composição de Créditos" subtitle="Simples vs Dobro" icon={Wallet} accent="#06b6d4">
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
      </div>}

      {/* ── Top Concessionárias + Clientes ── */}
      {show('estrategico') && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="Top Concessionárias" subtitle="Por valor estimado de ressarcimento" icon={Award} accent="#3b82f6">
          {topConcs.length > 0 ? topConcs.slice(0, 8).map((r, i) => (
            <HBarRow key={r.label} rank={i + 1} label={r.label} value={safeNum(r.total)} displayValue={fmtMM(r.total)} maxValue={maxTopConc} color="#3b82f6" />
          )) : <div style={{ fontSize: 12, opacity: 0.5 }}>Sem dados</div>}
        </SectionCard>

        <SectionCard title="Top Clientes" subtitle="Por valor estimado de ressarcimento" icon={Award} accent="#10b981">
          {topClientes.length > 0 ? topClientes.slice(0, 8).map((r, i) => (
            <HBarRow key={r.label} rank={i + 1} label={r.label} value={safeNum(r.total)} displayValue={fmtMM(r.total)} maxValue={maxTopCli} color="#10b981" />
          )) : <div style={{ fontSize: 12, opacity: 0.5 }}>Sem dados</div>}
        </SectionCard>
      </div>}

      {/* ── Tempo médio etapa + WIP gestores ── */}
      {show('operacional') && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="Tempo médio por etapa" subtitle="Dias em cada etapa (dwell time)" icon={Clock} accent="#f59e0b">
          {tempoMedio.length > 0 ? tempoMedio.slice(0, 10).map((r) => (
            <HBarRow key={r.etapa} label={r.etapa} value={safeNum(r.dias)} displayValue={`${safeNum(r.dias).toFixed(1)}d`} maxValue={maxTempo} color="#f59e0b" />
          )) : <div style={{ fontSize: 12, opacity: 0.5 }}>Sem dados</div>}
        </SectionCard>

        <SectionCard title="WIP por Gestor" subtitle="Processos ativos em andamento por responsável" icon={Users} accent="#8b5cf6">
          {wipGestores.length > 0 ? wipGestores.slice(0, 10).map((r) => (
            <HBarRow key={r.label} label={r.label} value={safeNum(r.total)} displayValue={fmt(r.total)} maxValue={maxWip} color="#8b5cf6" />
          )) : <div style={{ fontSize: 12, opacity: 0.5 }}>Sem dados</div>}
        </SectionCard>
      </div>}

      {/* ── Taxa de sucesso por concessionária ── */}
      {show('tatico') && taxaSucesso.length > 0 && (
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
      {show('estrategico', 'tatico') && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
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
      </div>}

      {/* ── % Sucesso 1ª análise ── */}
      {show('tatico', 'operacional') && sucess1aAnalisePct > 0 && (
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
      {show('operacional') && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
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
      </div>}

      {/* ── Tempo conclusão por conc + Repasse ── */}
      {show('tatico', 'operacional') && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
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
      </div>}

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
