/**
 * GlobalChatWidget — Chat flutuante global com acesso ao banco de dados
 * Responde perguntas sobre processos de ressarcimento em tempo real.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Bot,
  ChevronDown,
  Download,
  Info,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  Send,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import {
  AreaChart, Area,
  BarChart, Bar,
  PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip,
  ResponsiveContainer,
} from 'recharts';
import api from '../services/apiClient.js';
import { sanitizeChat } from '../utils/safeHtml.js';

// ─── Markdown simples (sem dependência extra) ──────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';
  return text
    // Negrito
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Itálico
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Código inline
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 5px;border-radius:3px;font-family:monospace;font-size:0.9em;">$1</code>')
    // Headers ## e ###
    .replace(/^### (.+)$/gm, '<div style="font-weight:700;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.08em;opacity:0.7;margin:10px 0 4px;">$1</div>')
    .replace(/^## (.+)$/gm, '<div style="font-weight:700;font-size:0.9rem;margin:10px 0 4px;color:var(--accent);">$1</div>')
    // Itens de lista
    .replace(/^- (.+)$/gm, '<div style="padding-left:14px;position:relative;"><span style="position:absolute;left:4px;opacity:0.5">›</span>$1</div>')
    // Quebras de linha
    .replace(/\n/g, '<br/>');
}

// ─── Sugestões rápidas ─────────────────────────────────────────────────────
const SUGESTOES = [
  { label: 'Parados há 30+ dias', q: 'Quais processos estão parados há mais de 30 dias?' },
  { label: 'Alertas vencidos', q: 'Quais alertas estão vencidos ou vencem hoje?' },
  { label: 'Processos recentes', q: 'Quais processos foram criados nos últimos 7 dias?' },
  { label: 'Resumo geral', q: 'Me dê um resumo geral dos processos ativos.' },
  { label: 'Totais financeiros', q: 'Qual é o valor total deferido em ressarcimentos?' },
  { label: 'Por etapa', q: 'Como estão distribuídos os processos por etapa?' },
];

// ─── Paleta de cores dos gráficos ─────────────────────────────────────────
const CHART_COLORS = ['#6366f1','#3b82f6','#06b6d4','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899'];
const fmtBRL = (v) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
const fmtNum = (v) => Number(v).toLocaleString('pt-BR');

// ─── Exportar contexto como CSV ───────────────────────────────────────────
function exportCSV(context) {
  const sections = [];
  if (context.ressarcimento_mensal?.length) {
    sections.push('Ressarcimento Mensal\nMês,Valor (R$)');
    context.ressarcimento_mensal.forEach(r => sections.push(`${r.mes},${r.valor}`));
    sections.push('');
  }
  if (context.por_etapa?.length) {
    sections.push('Processos por Etapa\nEtapa,Total');
    context.por_etapa.forEach(r => sections.push(`${r.Etapa},${r.Total}`));
    sections.push('');
  }
  if (context.por_cliente?.length) {
    sections.push('Top Clientes\nCliente,Processos');
    context.por_cliente.forEach(r => sections.push(`"${r.cliente}",${r.total}`));
    sections.push('');
  }
  if (context.por_concessionaria?.length) {
    sections.push('Por Concessionária\nConcessionária,Processos,Valor Total (R$)');
    context.por_concessionaria.forEach(r => sections.push(`"${r.concessionaria}",${r.total},${r.valor_total}`));
    sections.push('');
  }
  if (context.media_movimentacoes?.length) {
    sections.push('Média de Movimentações por Etapa\nEtapa,Média,Máximo');
    context.media_movimentacoes.forEach(r => sections.push(`"${r.etapa}",${r.media},${r.maximo}`));
    sections.push('');
  }
  if (!sections.length) return;
  const blob = new Blob(['\uFEFF' + sections.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `aisure_relatorio_${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

// ─── Tooltip customizado ──────────────────────────────────────────────────
const ChartTooltip = ({ active, payload, label, isCurrency }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#1e293b', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 8, padding: '6px 10px', fontSize: 11 }}>
      {label && <div style={{ color: 'rgba(255,255,255,0.5)', marginBottom: 3 }}>{label}</div>}
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || '#818cf8', fontWeight: 600 }}>
          {isCurrency ? fmtBRL(p.value) : fmtNum(p.value)}
        </div>
      ))}
    </div>
  );
};

// ─── Componente de gráficos do chat ──────────────────────────────────────
function ChartToggle({ msgId, context, expanded }) {
  const [show, setShow] = React.useState(false);
  const hasData = context && (
    context.ressarcimento_mensal?.length > 1 ||
    context.abertura_mensal?.length > 1 ||
    context.por_etapa?.length ||
    context.por_cliente?.length ||
    context.por_concessionaria?.length ||
    context.media_movimentacoes?.length ||
    context.tempo_por_etapa?.length
  );
  if (!hasData) return null;
  return (
    <div>
      <button
        onClick={() => setShow(v => !v)}
        style={{
          marginTop: 4,
          fontSize: 11,
          padding: '3px 10px',
          borderRadius: 8,
          border: '1px solid rgba(99,102,241,0.4)',
          background: show ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.07)',
          color: '#a5b4fc',
          cursor: 'pointer',
        }}
      >
        {show ? '✕ Fechar gráfico' : '📊 Visualizar como gráfico'}
      </button>
      {show && <MessageCharts context={context} expanded={expanded} />}
    </div>
  );
}

function MessageCharts({ context, expanded }) {
  if (!context) return null;

  const charts = [];
  const chartH = expanded ? 200 : 160;

  // 1. Ressarcimento mensal — AreaChart
  if (context.ressarcimento_mensal?.length > 1) {
    charts.push(
      <div key="res-mensal" style={{ marginBottom: 12 }}>
        <p style={{ margin: '0 0 6px', fontSize: 10.5, fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          💰 Ressarcimento mensal
        </p>
        <ResponsiveContainer width="100%" height={chartH}>
          <AreaChart data={context.ressarcimento_mensal} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
            <defs>
              <linearGradient id="gradRes" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="mes" tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} axisLine={false} tickLine={false} tickFormatter={v => `R$${(v/1000).toFixed(0)}k`} width={40} />
            <Tooltip content={<ChartTooltip isCurrency />} />
            <Area type="monotone" dataKey="valor" stroke="#6366f1" strokeWidth={2} fill="url(#gradRes)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // 2. Abertura mensal de processos — AreaChart
  if (context.abertura_mensal?.length > 1) {
    charts.push(
      <div key="abertura" style={{ marginBottom: 12 }}>
        <p style={{ margin: '0 0 6px', fontSize: 10.5, fontWeight: 700, color: '#06b6d4', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          📋 Abertura de processos / mês
        </p>
        <ResponsiveContainer width="100%" height={chartH}>
          <AreaChart data={context.abertura_mensal} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
            <defs>
              <linearGradient id="gradAb" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="mes" tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} axisLine={false} tickLine={false} width={30} />
            <Tooltip content={<ChartTooltip />} />
            <Area type="monotone" dataKey="total" stroke="#06b6d4" strokeWidth={2} fill="url(#gradAb)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // 3. Por etapa — PieChart
  if (context.por_etapa?.length) {
    charts.push(
      <div key="por-etapa" style={{ marginBottom: 12 }}>
        <p style={{ margin: '0 0 6px', fontSize: 10.5, fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          📊 Distribuição por etapa
        </p>
        <ResponsiveContainer width="100%" height={chartH}>
          <PieChart>
            <Pie data={context.por_etapa} dataKey="Total" nameKey="Etapa" cx="50%" cy="50%" outerRadius={expanded ? 75 : 58} paddingAngle={2} label={({ Etapa, percent }) => `${Etapa} ${(percent*100).toFixed(0)}%`} labelLine={false} fontSize={9}>
              {context.por_etapa.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Pie>
            <Tooltip formatter={(v, n) => [fmtNum(v), n]} contentStyle={{ background: '#1e293b', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 8, fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // 4. Top clientes — BarChart horizontal
  if (context.por_cliente?.length) {
    charts.push(
      <div key="por-cliente" style={{ marginBottom: 12 }}>
        <p style={{ margin: '0 0 6px', fontSize: 10.5, fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          🏢 Top clientes
        </p>
        <ResponsiveContainer width="100%" height={Math.max(chartH, context.por_cliente.length * 22 + 20)}>
          <BarChart data={context.por_cliente} layout="vertical" margin={{ top: 4, right: 20, left: 4, bottom: 4 }}>
            <XAxis type="number" tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="cliente" tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.6)' }} axisLine={false} tickLine={false} width={90} />
            <Tooltip content={<ChartTooltip />} />
            <Bar dataKey="total" radius={[0, 4, 4, 0]}>
              {context.por_cliente.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // 5. Por concessionária — BarChart
  if (context.por_concessionaria?.length) {
    charts.push(
      <div key="por-conc" style={{ marginBottom: 12 }}>
        <p style={{ margin: '0 0 6px', fontSize: 10.5, fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          ⚡ Por concessionária
        </p>
        <ResponsiveContainer width="100%" height={chartH}>
          <BarChart data={context.por_concessionaria} margin={{ top: 4, right: 4, left: 4, bottom: 20 }}>
            <XAxis dataKey="concessionaria" tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)', angle: -30, textAnchor: 'end' }} axisLine={false} tickLine={false} />
            <YAxis yAxisId="left" tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} axisLine={false} tickLine={false} width={30} />
            <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 8, fontSize: 11 }} formatter={(v, n) => [n === 'valor_total' ? fmtBRL(v) : fmtNum(v), n === 'valor_total' ? 'Valor' : 'Processos']} />
            <Bar yAxisId="left" dataKey="total" fill="#ef4444" radius={[4, 4, 0, 0]} name="Processos" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // 6. Média de movimentações por etapa — BarChart
  if (context.media_movimentacoes?.length) {
    charts.push(
      <div key="media-mov" style={{ marginBottom: 12 }}>
        <p style={{ margin: '0 0 6px', fontSize: 10.5, fontWeight: 700, color: '#8b5cf6', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          🔄 Média de movimentações / etapa
        </p>
        <ResponsiveContainer width="100%" height={chartH}>
          <BarChart data={context.media_movimentacoes} margin={{ top: 4, right: 4, left: 4, bottom: 20 }}>
            <XAxis dataKey="etapa" tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)', angle: -30, textAnchor: 'end' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} axisLine={false} tickLine={false} width={25} />
            <Tooltip content={<ChartTooltip />} />
            <Bar dataKey="media" fill="#8b5cf6" radius={[4, 4, 0, 0]}>
              {context.media_movimentacoes.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // 7. Tempo médio por etapa — BarChart
  if (context.tempo_por_etapa?.length) {
    charts.push(
      <div key="tempo-etapa" style={{ marginBottom: 12 }}>
        <p style={{ margin: '0 0 6px', fontSize: 10.5, fontWeight: 700, color: '#ec4899', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          ⏱ Tempo médio por etapa (dias)
        </p>
        <ResponsiveContainer width="100%" height={chartH}>
          <BarChart data={context.tempo_por_etapa} margin={{ top: 4, right: 4, left: 4, bottom: 20 }}>
            <XAxis dataKey="etapa" tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)', angle: -30, textAnchor: 'end' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} axisLine={false} tickLine={false} width={30} />
            <Tooltip content={<ChartTooltip />} formatter={v => [`${v} dias`]} />
            <Bar dataKey="media_dias" fill="#ec4899" radius={[4, 4, 0, 0]}>
              {context.tempo_por_etapa.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (!charts.length) return null;

  return (
    <div style={{
      marginTop: 10,
      padding: '10px 12px',
      background: 'rgba(0,0,0,0.2)',
      borderRadius: 10,
      border: '1px solid rgba(99,102,241,0.15)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Dados em tempo real
        </span>
        <button
          type="button"
          onClick={() => exportCSV(context)}
          title="Exportar CSV"
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)',
            borderRadius: 6, padding: '3px 8px', fontSize: 10, color: '#818cf8', cursor: 'pointer',
          }}
        >
          <Download size={10} /> CSV
        </button>
      </div>
      {charts}
    </div>
  );
}

// ─── Componente principal ──────────────────────────────────────────────────
export default function GlobalChatWidget() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [pulse, setPulse] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);

  // Scroll automático para o fim
  useEffect(() => {
    if (open && !minimized) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, open, minimized]);

  // Foco no input ao abrir
  useEffect(() => {
    if (open && !minimized) {
      setTimeout(() => inputRef.current?.focus(), 120);
    }
  }, [open, minimized]);

  // Pulsa o botão quando chega resposta enquanto minimizado
  useEffect(() => {
    if (!open || minimized) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'assistant') {
        setPulse(true);
        const t = setTimeout(() => setPulse(false), 3000);
        return () => clearTimeout(t);
      }
    }
  }, [messages, open, minimized]);

  const sendMessage = useCallback(async (text) => {
    const question = (text || input).trim();
    if (!question || loading) return;

    // Monta histórico para a API
    const historyForAPI = messages
      .filter((m) => m.role !== 'system')
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [
      ...prev,
      { id: Date.now(), role: 'user', content: question },
    ]);
    setInput('');
    setLoading(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const resp = await api.post(
        '/chat/processos',
        { question, history: historyForAPI },
        { signal: ctrl.signal, timeout: 60000 },
      );
      const answer = resp.data?.answer || 'Sem resposta.';
      setMessages((prev) => [
        ...prev,
        { id: Date.now() + 1, role: 'assistant', content: answer, context: resp.data?.context || null },
      ]);
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'CanceledError') return;
      const msg =
        err?.response?.data?.error ||
        'Não foi possível obter resposta. Tente novamente.';
      setMessages((prev) => [
        ...prev,
        { id: Date.now() + 1, role: 'error', content: msg },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, messages, loading]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
    if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const handleClose = () => {
    abortRef.current?.abort();
    setOpen(false);
    setMinimized(false);
  };

  const clearHistory = () => {
    abortRef.current?.abort();
    setMessages([]);
    setLoading(false);
  };

  // ── FAB (botão flutuante) ─────────────────────────────────────────────────
  const hiddenRoutes = ['/caixa-de-email'];
  if (hiddenRoutes.some((r) => pathname.startsWith(r))) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="AISURE — Assistente de processos"
        style={{
          position: 'fixed',
          bottom: '72px',
          right: '16px',
          zIndex: 200,
          width: 52,
          height: 52,
          borderRadius: '50%',
          border: '2px solid rgba(99,102,241,0.5)',
          background: 'linear-gradient(135deg, #1e3a8a 0%, #1e3a5f 50%, #0d1b2a 100%)',
          color: '#fff',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: pulse
            ? '0 0 0 6px rgba(99,102,241,0.3), 0 4px 20px rgba(99,102,241,0.4)'
            : '0 4px 20px rgba(0,0,0,0.5), 0 0 0 1px rgba(99,102,241,0.2)',
          transition: 'box-shadow 0.3s ease, transform 0.2s ease',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.08)')}
        onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
      >
        {pulse ? (
          <Sparkles size={22} color="#818cf8" strokeWidth={2} />
        ) : (
          <Bot size={22} color="#ffffff" strokeWidth={2} />
        )}
        {messages.length > 0 && (
          <span
            style={{
              position: 'absolute',
              top: 3,
              right: 3,
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: '#6366f1',
              border: '2px solid #0d1b2a',
            }}
          />
        )}
      </button>
    );
  }

  // ── Painel do chat ─────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 72,
        right: 16,
        zIndex: 200,
        width: minimized ? 280 : expanded ? 680 : 420,
        maxHeight: minimized ? 52 : expanded ? 'calc(100vh - 100px)' : 580,
        background: 'var(--bg, #0d1b2a)',
        border: '1px solid rgba(99,102,241,0.25)',
        borderRadius: 16,
        boxShadow: '0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'all 0.25s cubic-bezier(0.4,0,0.2,1)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div
        style={{
          background: 'linear-gradient(135deg, #1e3a5f 0%, #0d1b2a 100%)',
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderBottom: '1px solid rgba(99,102,241,0.2)',
          cursor: minimized ? 'pointer' : 'default',
          flexShrink: 0,
        }}
        onClick={() => minimized && setMinimized(false)}
        title={minimized ? 'Expandir chat' : undefined}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: 'rgba(99,102,241,0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Bot size={16} style={{ color: '#818cf8' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', lineHeight: 1.2 }}>
            AISURE
          </div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', letterSpacing: '0.06em' }}>
            {loading ? 'Consultando banco...' : 'Assistente de processos'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {!minimized && (
            <button
              type="button"
              onClick={() => setShowInfo((v) => !v)}
              title="O que o AISURE pode fazer?"
              style={{
                background: showInfo ? 'rgba(99,102,241,0.25)' : 'transparent',
                border: 'none',
                color: showInfo ? '#818cf8' : 'rgba(255,255,255,0.5)',
                cursor: 'pointer',
                padding: 4,
                borderRadius: 6,
                display: 'flex',
              }}
            >
              <Info size={14} />
            </button>
          )}
          {messages.length > 0 && !minimized && (
            <button
              type="button"
              onClick={clearHistory}
              title="Limpar conversa"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'rgba(255,255,255,0.4)',
                cursor: 'pointer',
                padding: '4px 6px',
                borderRadius: 6,
                fontSize: 11,
                letterSpacing: '0.04em',
              }}
            >
              limpar
            </button>
          )}
          {!minimized && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? 'Tamanho normal' : 'Ampliar janela'}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'rgba(255,255,255,0.5)',
                cursor: 'pointer',
                padding: 4,
                borderRadius: 6,
                display: 'flex',
              }}
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          )}
          <button
            type="button"
            onClick={() => setMinimized((v) => !v)}
            title={minimized ? 'Expandir' : 'Minimizar'}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'rgba(255,255,255,0.5)',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 6,
              display: 'flex',
            }}
          >
            <ChevronDown
              size={15}
              style={{
                transform: minimized ? 'rotate(180deg)' : 'none',
                transition: 'transform 0.2s',
              }}
            />
          </button>
          <button
            type="button"
            onClick={handleClose}
            title="Fechar"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'rgba(255,255,255,0.5)',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 6,
              display: 'flex',
            }}
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* ── Painel de informações ──────────────────────────────────────────── */}
      {showInfo && !minimized && (
        <div style={{
          padding: '14px 16px',
          background: 'rgba(99,102,241,0.07)',
          borderBottom: '1px solid rgba(99,102,241,0.18)',
          overflowY: 'auto',
          maxHeight: 320,
        }}>
          <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 700, color: '#818cf8', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Bot size={13} /> O que o AISURE pode fazer?
          </p>

          {[
            {
              emoji: '📋', titulo: 'Visão geral dos processos',
              itens: ['Quantos processos estão em cada etapa', 'Processos criados nos últimos 7 ou 30 dias', 'Processos parados há mais de 30 dias sem movimentação'],
            },
            {
              emoji: '💰', titulo: 'Financeiro e ressarcimento',
              itens: ['Valor total deferido (ressarcido) por período', 'Evolução mensal dos ressarcimentos', 'Valor por concessionária'],
            },
            {
              emoji: '🔍', titulo: 'Consulta específica',
              itens: ['Detalhes de um processo: "me fale sobre o proc 42"', 'Todos os processos de uma UC: "UC 94122288"', 'Histórico de movimentações de um processo'],
            },
            {
              emoji: '🏢', titulo: 'Clientes e concessionárias',
              itens: ['Top clientes com mais processos', 'Distribuição por concessionária (CEMIG, COPEL, ENEL...)', 'Processos por cliente específico'],
            },
            {
              emoji: '⏱', titulo: 'Desempenho operacional',
              itens: ['Tempo médio de permanência em cada etapa', 'Média de movimentações por processo', 'Alertas vencidos ou vencendo hoje'],
            },
            {
              emoji: '📊', titulo: 'Gráficos automáticos',
              itens: ['Toda resposta vem com gráficos de área, barras e pizza', 'Botão CSV para exportar os dados da resposta', 'Amplie a janela para ver gráficos maiores'],
            },
          ].map(({ emoji, titulo, itens }) => (
            <div key={titulo} style={{ marginBottom: 10 }}>
              <p style={{ margin: '0 0 4px', fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.75)' }}>
                {emoji} {titulo}
              </p>
              <ul style={{ margin: 0, paddingLeft: 14 }}>
                {itens.map((item) => (
                  <li key={item} style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', lineHeight: 1.6 }}>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div style={{ marginTop: 10, padding: '8px 10px', background: 'rgba(99,102,241,0.12)', borderRadius: 8, border: '1px solid rgba(99,102,241,0.2)' }}>
            <p style={{ margin: 0, fontSize: 10.5, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
              💡 <strong style={{ color: 'rgba(255,255,255,0.6)' }}>Dica:</strong> pergunte de forma natural.
              Ex: <em>"Qual cliente tem mais processos?"</em>, <em>"Mostre os alertas de hoje"</em> ou <em>"Como está a carteira?"</em>
            </p>
          </div>
        </div>
      )}

      {/* ── Corpo (hidden when minimized) ──────────────────────────────────── */}
      {!minimized && (
        <>
          {/* ── Área de mensagens ─────────────────────────────────────────── */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              minHeight: 200,
              scrollbarWidth: 'thin',
              scrollbarColor: 'rgba(99,102,241,0.3) transparent',
            }}
          >
            {/* Estado vazio */}
            {messages.length === 0 && !loading && (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <Zap size={28} style={{ color: 'rgba(99,102,241,0.5)', margin: '0 auto 8px' }} />
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 16 }}>
                  Pergunte sobre processos, alertas, valores ou clientes.
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    justifyContent: 'center',
                  }}
                >
                  {SUGESTOES.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      onClick={() => sendMessage(s.q)}
                      style={{
                        background: 'rgba(99,102,241,0.12)',
                        border: '1px solid rgba(99,102,241,0.25)',
                        borderRadius: 20,
                        padding: '4px 10px',
                        fontSize: 11,
                        color: '#818cf8',
                        cursor: 'pointer',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(99,102,241,0.22)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(99,102,241,0.12)')}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Mensagens */}
            {messages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  display: 'flex',
                  flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
                  gap: 8,
                  alignItems: 'flex-start',
                }}
              >
                {/* Avatar */}
                <div
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background:
                      msg.role === 'user'
                        ? 'rgba(30,58,95,0.8)'
                        : msg.role === 'error'
                        ? 'rgba(239,68,68,0.2)'
                        : 'rgba(99,102,241,0.2)',
                    border:
                      msg.role === 'user'
                        ? '1px solid rgba(30,58,95,0.8)'
                        : '1px solid rgba(99,102,241,0.3)',
                    marginTop: 2,
                  }}
                >
                  {msg.role === 'user' ? (
                    <MessageSquare size={12} style={{ color: '#93c5fd' }} />
                  ) : msg.role === 'error' ? (
                    <X size={12} style={{ color: '#f87171' }} />
                  ) : (
                    <Bot size={12} style={{ color: '#818cf8' }} />
                  )}
                </div>

                {/* Balão + gráficos */}
                <div style={{ maxWidth: msg.role === 'assistant' && msg.context ? '95%' : '80%', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div
                    style={{
                      padding: '8px 11px',
                      borderRadius:
                        msg.role === 'user' ? '12px 4px 12px 12px' : '4px 12px 12px 12px',
                      fontSize: 12.5,
                      lineHeight: 1.55,
                      background:
                        msg.role === 'user'
                          ? 'rgba(30,58,95,0.6)'
                          : msg.role === 'error'
                          ? 'rgba(239,68,68,0.12)'
                          : 'rgba(255,255,255,0.05)',
                      border:
                        msg.role === 'user'
                          ? '1px solid rgba(30,58,95,0.8)'
                          : msg.role === 'error'
                          ? '1px solid rgba(239,68,68,0.3)'
                          : '1px solid rgba(255,255,255,0.08)',
                      color:
                        msg.role === 'error' ? '#fca5a5' : 'rgba(255,255,255,0.88)',
                      wordBreak: 'break-word',
                    }}
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: sanitizeChat(renderMarkdown(msg.content)) }}
                  />
                  {msg.role === 'assistant' && msg.context && (
                    <ChartToggle msgId={msg.id} context={msg.context} expanded={expanded} />
                  )}
                </div>
              </div>
            ))}

            {/* Indicador de digitação */}
            {loading && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <div
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    background: 'rgba(99,102,241,0.2)',
                    border: '1px solid rgba(99,102,241,0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                >
                  <Bot size={12} style={{ color: '#818cf8' }} />
                </div>
                <div
                  style={{
                    padding: '8px 14px',
                    borderRadius: '4px 12px 12px 12px',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Loader2 size={13} style={{ color: '#818cf8', animation: 'spin 1s linear infinite' }} />
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
                    Consultando dados...
                  </span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* ── Sugestões rápidas (após 1ª mensagem) ─────────────────────── */}
          {messages.length > 0 && messages.length < 4 && !loading && (
            <div
              style={{
                padding: '4px 14px 8px',
                display: 'flex',
                gap: 5,
                flexWrap: 'wrap',
                borderTop: '1px solid rgba(255,255,255,0.05)',
              }}
            >
              {SUGESTOES.slice(0, 3).map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => sendMessage(s.q)}
                  style={{
                    background: 'rgba(99,102,241,0.1)',
                    border: '1px solid rgba(99,102,241,0.2)',
                    borderRadius: 20,
                    padding: '3px 9px',
                    fontSize: 10.5,
                    color: '#818cf8',
                    cursor: 'pointer',
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {/* ── Input ────────────────────────────────────────────────────── */}
          <div
            style={{
              padding: '10px 12px',
              borderTop: '1px solid rgba(255,255,255,0.07)',
              display: 'flex',
              gap: 8,
              alignItems: 'flex-end',
              background: 'rgba(0,0,0,0.15)',
              flexShrink: 0,
            }}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // Auto-resize
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
              }}
              onKeyDown={handleKeyDown}
              placeholder="Pergunte sobre processos, clientes, alertas..."
              disabled={loading}
              style={{
                flex: 1,
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 10,
                padding: '7px 11px',
                fontSize: 12.5,
                color: 'rgba(255,255,255,0.9)',
                outline: 'none',
                resize: 'none',
                lineHeight: 1.5,
                minHeight: 34,
                maxHeight: 100,
                overflow: 'hidden',
                fontFamily: 'inherit',
                transition: 'border-color 0.15s',
              }}
              onFocus={(e) => (e.target.style.borderColor = 'rgba(99,102,241,0.5)')}
              onBlur={(e) => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')}
            />
            <button
              type="button"
              onClick={() => sendMessage()}
              disabled={!input.trim() || loading}
              title="Enviar (Enter)"
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                border: 'none',
                background:
                  input.trim() && !loading
                    ? 'linear-gradient(135deg, #6366f1, #4f46e5)'
                    : 'rgba(255,255,255,0.08)',
                color: input.trim() && !loading ? '#fff' : 'rgba(255,255,255,0.25)',
                cursor: input.trim() && !loading ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                transition: 'all 0.15s',
              }}
            >
              <Send size={14} />
            </button>
          </div>
        </>
      )}

      {/* CSS global para animação do Loader2 */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
