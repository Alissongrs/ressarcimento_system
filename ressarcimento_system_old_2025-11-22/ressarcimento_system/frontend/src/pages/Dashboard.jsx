// src/pages/Dashboard.jsx
import React, { useEffect, useMemo, useState } from 'react';
import { SkeletonLine, SkeletonBlock } from '../components/Skeleton.jsx';
import { getDashboardStats, getMovimentacoesPeriodo } from '../services/requisicaoService';
import {
  biProcessCounts,
  biStatusCounts,
  biValueEstimate,
  biCreditsTotals,
  biFunnel,
  biThroughputWeek,
  biThroughputMonth,
  biTopConcessionarias,
  biTopClientes,
  biAgingBuckets,
  biSLA,
  biHeatmapWeek,
  biWipGestores,
  biHistValor,
} from '../services/biService';
import StatCard from '../components/StatCard';
import Donut from '../components/charts/Donut';
import SimpleBar from '../components/charts/SimpleBar';
import Funnel from '../components/charts/Funnel';
import Sparkline from '../components/charts/Sparkline';
import LineChart from '../components/charts/LineChart';
import BubbleChart from '../components/charts/BubbleChart';
import ParetoChart from '../components/charts/ParetoChart';
// Opcional: só renderiza se existir o componente
let HeatmapWeek;
try {
  // se você criou o componente, ele entra; se não, segue sem heatmap
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  HeatmapWeek = require('../components/charts/HeatmapWeek').default;
} catch (_) {
  HeatmapWeek = null;
}

const fmtBRL = (n) =>
  (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 });

const toNum = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const [ini, setIni] = useState('');
  const [fim, setFim] = useState('');
  const [incluirSuspensos, setIncluirSuspensos] = useState(false);
  const [apenasRelevantes, setApenasRelevantes] = useState(false);
  const [cliente, setCliente] = useState('');
  const [concessionaria, setConcessionaria] = useState('');
  const [gestorId, setGestorId] = useState('');

  // --- BI (Python) state ---
  const [biLoading, setBiLoading] = useState(false);
  const [biErr, setBiErr] = useState('');
  const [bi, setBi] = useState({});
  const [bubbleGroup, setBubbleGroup] = useState('concessionaria');
  const [paretoGroup, setParetoGroup] = useState('concessionaria');
  const [insights, setInsights] = useState(null);
  const [forecastW, setForecastW] = useState(null);
  const [forecastM, setForecastM] = useState(null);
  const [biHealth, setBiHealth] = useState(null);

  // Ação manual: Recarregar BI (refetch + ping)
  const reloadBI = async () => {
    try {
      await loadBI();
      const svc = await import('../services/biService');
      const pong = await svc.biPing();
      setBiHealth(pong?.ok === true ? 'ok' : 'fail');
    } catch (_) {
      setBiHealth('fail');
    }
  };
  const [movs, setMovs] = useState([]);
  const [loadingMovs, setLoadingMovs] = useState(false);
  const [errMovs, setErrMovs] = useState('');

  const load = async () => {
    try {
      setLoading(true); setErr('');
      const data = await getDashboardStats({
        incluir_suspensos: incluirSuspensos ? 1 : 0,
        apenas_relevantes: apenasRelevantes ? 1 : 0,
        ini: ini || undefined,
        fim: fim || undefined,
        cliente: cliente || undefined,
        concessionaria: concessionaria || undefined,
        gestor_id: gestorId || undefined,
      });
      // diagnóstico: veja exatamente o que o backend mandou
      console.debug('[Dashboard] /dashboard/stats payload =>', data);
      setStats(data);
    } catch (e) {
      console.error('[Dashboard] Falha no getDashboardStats:', e);
      setErr('Falha ao carregar o dashboard.');
      setStats(null);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [incluirSuspensos, apenasRelevantes, ini, fim, cliente, concessionaria, gestorId]);

  const buildBiFilters = () => ({
    incluir_suspensos: incluirSuspensos ? 1 : 0,
    apenas_relevantes: apenasRelevantes ? 1 : 0,
    ini: ini || undefined,
    fim: fim || undefined,
    cliente: cliente || undefined,
    concessionaria: concessionaria || undefined,
    gestor_id: gestorId || undefined,
  });

  const loadBI = async () => {
    try {
      setBiLoading(true); setBiErr('');
      const f = buildBiFilters();
      const [pc, sc, ve, cr, fn, tw, tm, tc, tcl, ag, sla, hm, wip, hv, ins, fcw, fcm] = await Promise.all([
        biProcessCounts(f),
        biStatusCounts(f),
        biValueEstimate(f),
        biCreditsTotals(f),
        biFunnel(f),
        biThroughputWeek(f),
        biThroughputMonth(f),
        biTopConcessionarias(f),
        biTopClientes(f),
        biAgingBuckets(f),
        biSLA(f),
        biHeatmapWeek(f),
        biWipGestores(f),
        biHistValor(f),
        (await import('../services/biService')).biInsightsSummary(f),
        (await import('../services/biService')).biThroughputForecast(f, 'week', 8),
        (await import('../services/biService')).biThroughputForecast(f, 'month', 6),
      ]);
      setBi({ pc, sc, ve, cr, fn, tw, tm, tc, tcl, ag, sla, hm, wip, hv });
      setInsights(ins); setForecastW(fcw); setForecastM(fcm);
    } catch (e) {
      console.error('[Dashboard BI] Falha no loadBI:', e);
      setBiErr('Falha ao carregar dados do BI Python.');
    } finally { setBiLoading(false); }
  };

  useEffect(() => { loadBI(); }, [incluirSuspensos, apenasRelevantes, ini, fim, cliente, concessionaria, gestorId]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const svc = await import('../services/biService');
        const pong = await svc.biPing();
        if (mounted) setBiHealth(pong?.ok === true ? 'ok' : 'fail');
      } catch {
        if (mounted) setBiHealth('fail');
      }
    })();
    return () => { mounted = false };
  }, []);

  // ---- FALLBACKS/DERIVAÇÕES ----
  // 1) status_counts (pode vir faltando ou em outro formato)
  const statusCounts = useMemo(() => {
    const sc = stats?.status_counts || stats?.status || {};
    return {
      pendente:    toNum(sc.pendente ?? sc.PENDENTE ?? sc.Pendente),
      em_analise:  toNum(sc.em_analise ?? sc.EM_ANALISE ?? sc['Em Análise'] ?? sc.EmAnalise),
      aprovado:    toNum(sc.aprovado ?? sc.APROVADO ?? sc.Aprovado ?? sc.procedente ?? sc.Procedente),
      rejeitado:   toNum(sc.rejeitado ?? sc.REJEITADO ?? sc.Rejeitado ?? sc.improcedente ?? sc.Improcedente),
    };
  }, [stats]);

  // 2) processos_counts:
  //    Se não vier pronto (ex.: {ativos, deferidos, ...}),
  //    tento derivar de 'colunas' (retorno comum do kanban-fast) ou equivalentes.
  const procCounts = useMemo(() => {
    const pc = stats?.processos_counts;
    if (pc && Object.keys(pc).length > 0) {
      return {
        ativos:              toNum(pc.ativos),
        deferidos:           toNum(pc.deferidos),
        fluxo_ressarcimento: toNum(pc.fluxo_ressarcimento ?? pc.fluxo ?? pc['fluxo-ressarcimento']),
        faturamento:         toNum(pc.faturamento),
        concluidos:          toNum(pc.concluidos ?? pc.concluídos),
        indeferidos:         toNum(pc.indeferidos),
      };
    }
    // Deriva de objetos alternativos
    const col = stats?.colunas || stats?.kanban || stats?.kanban_fast || stats?.processos || {};
    const len = (obj, key) => {
      const v = obj?.[key];
      if (Array.isArray(v)) return v.length;
      // alguns backends devolvem { total: N }
      if (v && typeof v === 'object' && 'total' in v) return toNum(v.total);
      // alguns devolvem só um número
      return toNum(v, 0);
    };
    return {
      ativos:              len(col, 'ativos') || len(col, 'Ativos'),
      deferidos:           len(col, 'deferidos') || len(col, 'Deferidos'),
      fluxo_ressarcimento: len(col, 'fluxo_ressarcimento') || len(col, 'fluxo') || len(col, 'Fluxo de Ressarcimento'),
      faturamento:         len(col, 'faturamento') || len(col, 'Faturamento'),
      concluidos:          len(col, 'concluidos') || len(col, 'Concluídos') || len(col, 'concluidos_total'),
      indeferidos:         len(col, 'indeferidos') || len(col, 'Indeferidos'),
    };
  }, [stats]);

  // 3) donut data a partir do procCounts (sempre numérico)
  const donutData = useMemo(() => ([
    { label: 'Ativos',         value: toNum(procCounts.ativos),              color: 'var(--accent)' },
    { label: 'Deferidos',      value: toNum(procCounts.deferidos),           color: '#10b981' },
    { label: 'Fluxo',          value: toNum(procCounts.fluxo_ressarcimento), color: '#f59e0b' },
    { label: 'Faturamento',    value: toNum(procCounts.faturamento),         color: '#06b6d4' },
    { label: 'Concluídos',     value: toNum(procCounts.concluidos),          color: '#9ca3af' },
    { label: 'Indeferidos',    value: toNum(procCounts.indeferidos),         color: '#ef4444' },
  ]), [procCounts]);

  const totalRequisicoes = toNum(stats?.total_requisicoes);
  const totalProcessos   = toNum(stats?.total_processos);

  // Funil por status (fallback para statusCounts)
  const funil = useMemo(() => {
    const f = stats?.funil;
    const rows = Array.isArray(f) && f.length > 0 ? f : [
      { label: 'Pendente', total: toNum(statusCounts.pendente) },
      { label: 'Em Análise', total: toNum(statusCounts.em_analise) },
      { label: 'Aprovado', total: toNum(statusCounts.aprovado) },
      { label: 'Rejeitado', total: toNum(statusCounts.rejeitado) },
    ];
    return rows;
  }, [stats, statusCounts]);

  // Throughput (semana/mês)
  const throughput = stats?.throughput_semana || stats?.throughput_mes || [];

  // Top concessionárias/clientes
  const topConcessionarias = stats?.top_concessionarias || [];
  const topClientes = stats?.top_clientes || [];

  // Aging buckets (geral)
  const aging = stats?.aging_buckets || [];

  // SLA
  const slaOk = toNum(stats?.sla?.on_time);
  const slaLate = toNum(stats?.sla?.late);

  // extrai sparklines de tendência (30d) só com valores
  const trendVals = (stats?.tendencia_30d || [])
    .map(d => toNum(d?.total))
    .filter(n => Number.isFinite(n));

  if (loading) {
    return (
      <div className="p-4 md:p-8 bg-background text-foreground min-h-screen">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {[0,1,2,3].map(i => (
            <div key={i} className="glass-card gradient-card shadow-medium p-4 rounded-lg border">
              <SkeletonLine width="40%" />
              <div className="mt-3"><SkeletonLine width="60%" height={28} /></div>
              <div className="mt-3"><SkeletonLine width="80%" height={20} /></div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SkeletonBlock h={280} />
          <SkeletonBlock h={280} />
        </div>
      </div>
    );
  }
  if (err || !stats) {
    return (
      <div className="p-8 text-center">
        <p className="text-danger">{err || 'Sem dados'}</p>
        <button onClick={load} className="mt-4 px-4 py-2 bg-[var(--accent)] rounded hover:opacity-90">
          Tentar novamente
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 bg-background text-foreground min-h-screen">
      <div className="rounded-xl shadow-elevated p-4 mb-6 border-2" style={{ background:'var(--header-bg)', borderColor:'var(--header-border)', color:'var(--header-fg)' }}>
        <h2 className="text-lg md:text-xl font-extrabold tracking-tight">Dashboard</h2>
        <p className="opacity-90 text-sm mt-1">Visão geral de processos e requisições</p>
      </div>
      {/* Filtros */}
      <div className="glass-card gradient-card shadow-medium p-4 rounded-lg border mb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-end">
          <div className="flex items-center gap-2">
            <input id="chk-susp" type="checkbox" checked={incluirSuspensos} onChange={e=>setIncluirSuspensos(e.target.checked)} />
            <label htmlFor="chk-susp" className="text-sm">Incluir suspensos</label>
          </div>
          <div className="flex items-center gap-2">
            <input id="chk-rel" type="checkbox" checked={apenasRelevantes} onChange={e=>setApenasRelevantes(e.target.checked)} />
            <label htmlFor="chk-rel" className="text-sm">Apenas relevantes</label>
          </div>
          <div>
            <label className="block text-xs opacity-70">Data inicial</label>
            <input type="date" value={ini} onChange={e=>setIni(e.target.value)} className="w-full p-2 rounded border border-[var(--border)] bg-transparent" />
          </div>
          <div>
            <label className="block text-xs opacity-70">Data final</label>
            <input type="date" value={fim} onChange={e=>setFim(e.target.value)} className="w-full p-2 rounded border border-[var(--border)] bg-transparent" />
          </div>
          <div>
            <label className="block text-xs opacity-70">Cliente</label>
            <input type="text" placeholder="contém..." value={cliente} onChange={e=>setCliente(e.target.value)} className="w-full p-2 rounded border border-[var(--border)] bg-transparent" />
          </div>
          <div>
            <label className="block text-xs opacity-70">Concessionária</label>
            <input type="text" placeholder="contém..." value={concessionaria} onChange={e=>setConcessionaria(e.target.value)} className="w-full p-2 rounded border border-[var(--border)] bg-transparent" />
          </div>
          <div>
            <label className="block text-xs opacity-70">Gestor (ID)</label>
            <input type="number" min="0" value={gestorId} onChange={e=>setGestorId(e.target.value)} className="w-full p-2 rounded border border-[var(--border)] bg-transparent" />
          </div>
          <div className="flex items-end"><button onClick={load} className="px-3 py-2 rounded bg-[var(--accent)] hover:opacity-90 text-[var(--fg)]">Aplicar</button></div>
        </div>
      </div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Dashboard (BI)</h1>
        <p className="opacity-60 text-xs">
          {apenasRelevantes ? 'Filtrando apenas relevantes' : 'Inclui relevantes e não relevantes'}
          {' · '}
          {incluirSuspensos ? 'incluindo suspensos' : 'excluindo suspensos'}
        </p>
        <p className="opacity-80">Visão estratégica, tática e operacional</p>

        {/* Alerta leve para quando processos_counts não vier do backend */}
        {!stats.processos_counts && (stats.colunas || stats.kanban || stats.kanban_fast) && (
          <p className="mt-2 text-xs opacity-70">
            Observação: derivando as contagens a partir de <code>colunas</code> (kanban-fast) porque <code>processos_counts</code> não veio do backend.
          </p>
        )}
      </div>

      {/* ----- BI (Python) ----- */}
      <div className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-2xl font-bold">BI (Python)</h2>
          <button onClick={reloadBI} className="px-3 py-2 rounded bg-[var(--accent)] hover:opacity-90 text-[var(--fg)] disabled:opacity-60" disabled={!!biLoading}>
            {biLoading ? 'Carregando...' : 'Recarregar BI'}
          </button>
        </div>
        {biErr && <p className="text-danger text-sm mt-2">{biErr}</p>}
      </div>

      {/* Health + KPIs: Valor estimado e Créditos */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <StatCard title="BI" value={biHealth==='ok' ? 'Conectado' : 'Offline'} color={biHealth==='ok' ? 'success' : 'danger'} />
        <StatCard title="Valor Estimado" value={fmtBRL(bi?.ve?.total)} color="accent" />
        <StatCard title="Crédito Simples" value={fmtBRL(bi?.cr?.simples_total)} color="success" />
        <StatCard title="Crédito em Dobro" value={fmtBRL(bi?.cr?.dobro_total)} color="warning" />
      </div>

      {/* Padrões (crescimento e previsão) */}
      {insights && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <StatCard title="Conversão" value={`${Number(insights.conversion_rate_pct||0).toFixed(1)}%`} color="success" />
          <StatCard title="Rejeição" value={`${Number(insights.rejection_rate_pct||0).toFixed(1)}%`} color="danger" />
          <StatCard title="Crescimento (semana)" value={Number(insights.growth_week_slope||0).toFixed(2)} color="accent" />
          <StatCard title="Crescimento (mês)" value={Number(insights.growth_month_slope||0).toFixed(2)} color="accent" />
        </div>
      )}
      {(forecastW || forecastM) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          {forecastW && <StatCard title="Prev. próximos (semana)" value={Math.round(forecastW?.forecast?.[0]?.y||0)} subtitle="Próxima semana" color="neutral" />}
          {forecastM && <StatCard title="Prev. próximos (mês)" value={Math.round(forecastM?.forecast?.[0]?.y||0)} subtitle="Próximo mês" color="neutral" />}
        </div>
      )}

      {/* Pipeline (Donut) + Funil */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        <div className="glass-card p-6 rounded-lg border flex items-center gap-6">
          <Donut data={[
            { label: 'Ativos', value: Number(bi?.pc?.ativos||0) },
            { label: 'Deferidos', value: Number(bi?.pc?.deferidos||0) },
            { label: 'Fluxo', value: Number(bi?.pc?.fluxo||0) },
            { label: 'Faturamento', value: Number(bi?.pc?.faturamento||0) },
            { label: 'Concluídos', value: Number(bi?.pc?.concluidos||0) },
            { label: 'Indeferidos', value: Number(bi?.pc?.indeferidos||0) },
          ]} centerLabel="Pipeline" />
        </div>
        {Array.isArray(bi?.fn) && bi.fn.length>0 && (
          <Funnel title="Funil por Status" data={bi.fn} />
        )}
      </div>

      {/* Top N e Throughput */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        {Array.isArray(bi?.tc) && bi.tc.length>0 && (
          <SimpleBar title="Top Concessionárias (R$)" data={bi.tc} valueFmt={fmtBRL} />
        )}
        {Array.isArray(bi?.tcl) && bi.tcl.length>0 && (
          <SimpleBar title="Top Clientes (R$)" data={bi.tcl} valueFmt={fmtBRL} />
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        {Array.isArray(bi?.tw) && bi.tw.length>0 && (
          <LineChart title="Throughput (semanal)" data={bi.tw} />
        )}
        {Array.isArray(bi?.tm) && bi.tm.length>0 && (
          <LineChart title="Throughput (mensal)" data={bi.tm} />
        )}
      </div>

      {/* Aging e SLA */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        {bi?.ag && (
          <SimpleBar title="Aging (dias)" data={[
            { label: '0-7', total: Number(bi.ag.b0_7||0) },
            { label: '8-15', total: Number(bi.ag.b8_15||0) },
            { label: '16-30', total: Number(bi.ag.b16_30||0) },
            { label: '31+', total: Number(bi.ag.b31mais||0) },
          ]} />
        )}
        {bi?.sla && (
          <div className="glass-card p-6 rounded-lg border flex items-center gap-6">
            <Donut data={[
              { label: 'No prazo', value: Number(bi.sla.on_time||0), color: '#16a34a' },
              { label: 'Fora do prazo', value: Number(bi.sla.late||0), color: '#ef4444' },
            ]} centerLabel={`${((Number(bi.sla.on_time||0)/(Number(bi.sla.on_time||0)+Number(bi.sla.late||0)||1))*100).toFixed(0)}%`} />
          </div>
        )}
      </div>

      {/* Heatmap & WIP Gestores */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        {HeatmapWeek && Array.isArray(bi?.hm) && bi.hm.length>0 && (
          <div className="glass-card p-6 rounded-lg border">
            <h3 className="text-xl font-semibold mb-4">Heatmap (semana×hora)</h3>
            <HeatmapWeek data={bi.hm} />
          </div>
        )}
        {Array.isArray(bi?.wip) && bi.wip.length>0 && (
          <SimpleBar title="WIP por Gestor" data={bi.wip} />
        )}
      </div>

      {/* Histograma Valor Estimado */}
      <div className="mb-12">
        {Array.isArray(bi?.hv) && bi.hv.length>0 && (
          <SimpleBar title="Histograma de Valor Estimado (faixas)" data={bi.hv} />
        )}
      </div>

      {/* Bolhas (agrupamento por valores) */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h3 className="text-xl font-semibold">Agrupamento por valores (bolhas)</h3>
          <select value={bubbleGroup} onChange={e=>setBubbleGroup(e.target.value)} className="p-1 rounded bg-transparent border border-[var(--border)]">
            <option value="concessionaria">Concessionária</option>
            <option value="cliente">Cliente</option>
          </select>
        </div>
        <BubbleSection group={bubbleGroup} filters={buildBiFilters()} />
      </div>

      {/* Pareto 80/20 */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h3 className="text-xl font-semibold">Pareto 80/20</h3>
          <select value={paretoGroup} onChange={e=>setParetoGroup(e.target.value)} className="p-1 rounded bg-transparent border border-[var(--border)]">
            <option value="concessionaria">Concessionária</option>
            <option value="cliente">Cliente</option>
          </select>
        </div>
        <ParetoSection group={paretoGroup} filters={buildBiFilters()} />
      </div>
      {/* Funil por Status + Throughput */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        {Array.isArray(funil) && funil.length > 0 && (
          <SimpleBar title="Funil por Status" data={funil} />
        )}
        {Array.isArray(throughput) && throughput.length > 0 && (
          <SimpleBar title="Throughput (itens por período)" data={throughput} />
        )}
      </div>

      {/* Top Concessionárias / Top Clientes */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        {Array.isArray(topConcessionarias) && topConcessionarias.length > 0 && (
          <SimpleBar title="Top Concessionárias (R$)" data={topConcessionarias} valueFmt={fmtBRL} />
        )}
        {Array.isArray(topClientes) && topClientes.length > 0 && (
          <SimpleBar title="Top Clientes (R$)" data={topClientes} valueFmt={fmtBRL} />
        )}
      </div>

      {/* Aging e SLA */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        {Array.isArray(aging) && aging.length > 0 && (
          <SimpleBar title="Aging por Faixa (dias)" data={aging} />
        )}
        {(slaOk + slaLate) > 0 && (
          <div className="glass-card p-6 rounded-lg border flex items-center gap-6">
            <div className="flex-1">
              <h3 className="text-xl font-semibold mb-2">SLA de Movimentação</h3>
              <p className="text-sm opacity-70 mb-4">% movimentações dentro do prazo definido.</p>
              <div className="flex items-center gap-6">
                <Donut data={[
                  { label: 'No prazo', value: slaOk, color: '#16a34a' },
                  { label: 'Fora do prazo', value: slaLate, color: '#ef4444' },
                ]} centerLabel={`${((slaOk/(slaOk+slaLate))*100).toFixed(0)}%`} />
                <div className="grid grid-cols-1 gap-3">
                  <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full" style={{background:'#16a34a'}}></span><span className="text-sm">No prazo</span><span className="ml-auto text-sm font-semibold">{slaOk}</span></div>
                  <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full" style={{background:'#ef4444'}}></span><span className="text-sm">Fora do prazo</span><span className="ml-auto text-sm font-semibold">{slaLate}</span></div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Estratégico */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatCard
          title="Total de Requisições"
          value={totalRequisicoes}
          color="accent"
          defHint="Volume total de requisições registradas."
          trend={trendVals}
        />
        <StatCard
          title="Total de Processos"
          value={totalProcessos}
          color="success"
          defHint="Processos ativos no funil (todas as colunas)."
        />
        <StatCard
          title="Valor Estimado"
          value={fmtBRL(stats?.valor_total_ressarcimento)}
          color="accent"
          defHint="Soma de valor_estimado das requisições."
          trend={trendVals}
        />
        <StatCard
          title="Taxa de Procedência"
          value={`${totalRequisicoes > 0 ? ((toNum(statusCounts.aprovado) / totalRequisicoes) * 100).toFixed(1) : '0'}%`}
          subtitle={`${toNum(statusCounts.aprovado)} de ${totalRequisicoes}`}
          color="success"
          defHint="Aprovadas/Procedentes dividido por total de requisições."
        />
      </div>

      {/* Pipeline por coluna (donut) + Créditos */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        <div className="glass-card p-6 rounded-lg border">
          <h3 className="text-xl font-semibold mb-2">Pipeline por coluna</h3>
          <p className="text-sm opacity-70 mb-4">Clique nas métricas para ver a definição</p>
          <div className="flex items-center gap-6">
            <Donut data={donutData} centerLabel={`${donutData.reduce((s,d)=>s + toNum(d.value), 0)} proc.`} />
            <div className="flex-1 grid grid-cols-2 gap-3">
              {donutData.map((d, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full" style={{ background: d.color }} />
                  <span className="text-sm">{d.label}</span>
                  <span className="ml-auto text-sm font-semibold">{toNum(d.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="glass-card p-6 rounded-lg border">
          <h3 className="text-xl font-semibold mb-4">Créditos Procedentes</h3>
          <div className="grid grid-cols-3 gap-4">
            <StatCard
              title="Simples (R$)"
              value={fmtBRL(stats?.creditos?.simples_total)}
              color="neutral"
              defHint="Soma de crédito simples (FT_DEFERIMENTOS)."
            />
            <StatCard
              title="Dobro (R$)"
              value={fmtBRL(stats?.creditos?.dobro_total)}
              color="warning"
              defHint="Soma de crédito em dobro (FT_DEFERIMENTOS)."
            />
            <StatCard
              title="Total Procedente (R$)"
              value={fmtBRL(stats?.creditos?.total_procedente)}
              color="success"
              defHint="Simples + Dobro."
            />
          </div>
        </div>
      </div>

      {/* (Opcional) Heatmap Semana × Hora — só renderiza se stats.heatmap_semana existir */}
      {HeatmapWeek && Array.isArray(stats?.heatmap_semana) && stats.heatmap_semana.length > 0 && (
        <div className="glass-card p-6 rounded-lg border mb-8">
          <h3 className="text-xl font-semibold mb-4">Heatmap de Movimentações (Semana × Hora)</h3>
          <p className="text-sm opacity-70 mb-4">Concentração de movimentações por dia da semana e hora do dia.</p>
          <HeatmapWeek data={stats.heatmap_semana} />
        </div>
      )}

      {/* Tático: Tempo médio por etapa + Aging */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        <div className="glass-card p-6 rounded-lg border">
          <h3 className="text-xl font-semibold mb-4">Tempo médio por etapa (dias)</h3>
          <div className="space-y-3">
            {(stats?.tempo_medio_dias_por_etapa || []).map((row, idx) => (
              <div key={idx} className="flex items-center gap-3">
                <div className="w-40 text-sm opacity-80 truncate">{row?.etapa || '-'}</div>
                <div className="flex-1 h-3 rounded-full bg-[var(--border)]/30">
                  <div
                    className="h-3 rounded-full bg-[var(--accent)]"
                    style={{ width: `${Math.min(100, (toNum(row?.dias) || 0) * 10)}%` }}
                  />
                </div>
                <div className="w-16 text-right text-sm font-semibold">{(toNum(row?.dias) || 0).toFixed(1)}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="glass-card p-6 rounded-lg border">
          <h3 className="text-xl font-semibold mb-4">Aging (dias sem movimentação)</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard title="0–7"  value={toNum(stats?.aging_por_coluna?.['0_7'])}   color="success" />
            <StatCard title="8–15" value={toNum(stats?.aging_por_coluna?.['8_15'])}  color="accent"  />
            <StatCard title="16–30" value={toNum(stats?.aging_por_coluna?.['16_30'])} color="warning" />
            <StatCard title="31+"  value={toNum(stats?.aging_por_coluna?.['31_mais'])} color="danger" />
          </div>
        </div>
      </div>

      {/* Operacional: Movimentações por período */}
      <div className="glass-card p-6 rounded-lg border">
        <h3 className="text-xl font-semibold mb-4">Movimentações por período</h3>
        <div className="flex flex-col sm:flex-row gap-3 mb-4 items-end">
          <div className="flex-1">
            <label className="block text-sm opacity-70 mb-1">Início</label>
            <input type="date" value={ini} onChange={(e)=>setIni(e.target.value)} className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded" />
          </div>
          <div className="flex-1">
            <label className="block text-sm opacity-70 mb-1">Fim</label>
            <input type="date" value={fim} onChange={(e)=>setFim(e.target.value)} className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded" />
          </div>
          <button
            onClick={async ()=>{
              try {
                setLoadingMovs(true); setErrMovs('');
                const data = await getMovimentacoesPeriodo(ini, fim);
                console.debug('[Dashboard] /dashboard/movimentacoes payload =>', data);
                setMovs(Array.isArray(data) ? data : []);
              } catch (e) { 
                console.error('[Dashboard] Falha no getMovimentacoesPeriodo:', e);
                setErrMovs('Falha ao carregar movimentações'); 
              }
              finally { setLoadingMovs(false); }
            }}
            className="px-4 py-2 bg-[var(--accent)] text-[var(--fg)] rounded hover:opacity-90"
            disabled={!ini || !fim || loadingMovs}
          >
            {loadingMovs ? 'Carregando...' : 'Buscar'}
          </button>
        </div>

        {errMovs && <p className="text-danger text-sm">{errMovs}</p>}
        {!errMovs && movs?.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left opacity-70">Data</th>
                  <th className="px-3 py-2 text-left opacity-70">Processo</th>
                  <th className="px-3 py-2 text-left opacity-70">Usuário</th>
                  <th className="px-3 py-2 text-left opacity-70">De / Para</th>
                  <th className="px-3 py-2 text-left opacity-70">Comentário</th>
                </tr>
              </thead>
              <tbody>
                {movs.map((m, idx) => (
                  <tr key={idx} className="hover:opacity-90">
                    <td className="px-3 py-2 whitespace-nowrap">
                      {m?.data_movimentacao ? new Date(m.data_movimentacao).toLocaleString('pt-BR') : '-'}
                    </td>
                    <td className="px-3 py-2">{m?.id_requisicao ?? m?.processo_id ?? '-'}</td>
                    <td className="px-3 py-2">{m?.usuario_nome ?? m?.nome_usuario ?? '-'}</td>
                    <td className="px-3 py-2">{[m?.etapa_anterior, m?.etapa_nova].filter(Boolean).join(' ⭢ ')}</td>
                    <td className="px-3 py-2">{m?.comentario ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!errMovs && (!movs || movs.length === 0) && (ini && fim) && (
          <p className="text-sm opacity-70">Sem movimentações no período.</p>
        )}
      </div>
    </div>
  );
}

function BubbleSection({ group, filters }) {
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    let mounted = true;
    async function run() {
      try {
        setLoading(true); setErr('');
        const data = group === 'cliente' ? await (await import('../services/biService')).biBubblesClientes(filters) : await (await import('../services/biService')).biBubblesConcessionarias(filters);
        if (mounted) setRows(data || []);
      } catch (e) {
        if (mounted) setErr('Falha ao carregar bolhas');
      } finally { if (mounted) setLoading(false); }
    }
    run();
    return () => { mounted = false };
  }, [group, JSON.stringify(filters)]);

  if (err) return <p className="text-danger text-sm">{err}</p>;
  return (
    <BubbleChart title={`Bolhas por ${group}`} data={rows} />
  );
}

function ParetoSection({ group, filters }) {
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    let mounted = true;
    async function run() {
      try {
        setLoading(true); setErr('');
        const svc = await import('../services/biService');
        const data = await svc.biPareto(filters, group);
        if (mounted) setRows(data || []);
      } catch (e) {
        if (mounted) setErr('Falha ao carregar Pareto');
      } finally { if (mounted) setLoading(false); }
    }
    run();
    return () => { mounted = false };
  }, [group, JSON.stringify(filters)]);

  if (err) return <p className="text-danger text-sm">{err}</p>;
  return (
    <ParetoChart title={`Pareto por ${group}`} data={rows} />
  );
}
