/**
 * GlobalChatWidget — Chat flutuante global com acesso ao banco de dados
 * Responde perguntas sobre processos de ressarcimento em tempo real.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import {
  AudioLines,
  Bot,
  ChevronDown,
  Download,
  History,
  Info,
  Loader2,
  Maximize2,
  MessageSquare,
  Mic,
  Minimize2,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
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
import { respostaParaExcel } from '../utils/respostaParaExcel.js';
import CobrancaLoteModal from './CobrancaLoteModal.jsx';

// Pedido de e-mail de SR/cobrança no chat: precisa citar SR/cobrança E pedir um e-mail.
// "nova tarefa / novo pedido / nova solicitação" (opcionalmente com "sure," antes) = #sistema
const reNovaTarefa = /^\s*(?:(?:oi|ol[aá]|ei)?[,\s]*sure[,\s]+)?(nova\s+tarefa|novo\s+pedido|nova\s+solicita[cç][aã]o)(?![a-zà-ú])[\s:,.\-–—]*/i;
// ── Andamento do pedido (barra "estimada"): o servidor não informa o progresso, então as
// ETAPAS vêm do que foi perguntado e o avanço segue o TEMPO MÉDIO real desse tipo de pedido
// (medido no uso, guardado no navegador). Só chega a 100% quando a resposta chega.
const TEMPO_KEY = 'sure_tempo_medio_v1';
const TEMPO_PADRAO = { qa: 7000, sr: 60000 };
function tempoMedio(tipo) {
  try { const t = JSON.parse(localStorage.getItem(TEMPO_KEY) || '{}'); return t[tipo] || TEMPO_PADRAO[tipo] || 8000; }
  catch { return TEMPO_PADRAO[tipo] || 8000; }
}
function registrarTempo(tipo, ms) {
  if (!(ms > 300)) return;
  try {
    const t = JSON.parse(localStorage.getItem(TEMPO_KEY) || '{}');
    t[tipo] = Math.round(t[tipo] ? t[tipo] * 0.7 + ms * 0.3 : ms); // média móvel
    localStorage.setItem(TEMPO_KEY, JSON.stringify(t));
  } catch { /* ignore */ }
}
function etapasDaPergunta(q) {
  const n = String(q || '').toLowerCase();
  const e = ['Entendendo o pedido…'];
  if (/e-?mail|caixa de entrada|respond|resposta|assunto|chegou|chegaram/.test(n)) e.push('Consultando a caixa de e-mails…');
  if (/meta|objetivo|quanto falta|percentual/.test(n)) e.push('Calculando o repasse e a meta…');
  if (/prazo|vencid|vence|atras|sla/.test(n)) e.push('Verificando os prazos por concessionária…');
  if (/processo|pr-\d|\buc\b|unidade/.test(n)) e.push('Buscando os processos…');
  if (e.length === 1) e.push('Consultando os dados dos processos…');
  e.push('Escrevendo a resposta…');
  return e;
}
function ProgressoPedido({ prog }) {
  const [, setTick] = React.useState(0);
  React.useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 200); return () => clearInterval(t); }, []);
  const dec = Date.now() - prog.inicio;
  const r = dec / prog.media;
  // até ~90% no tempo médio; depois vai devagar até 97% (nunca "mente" que acabou)
  const pct = Math.min(97, r <= 1 ? r * 90 : 90 + 7 * (1 - Math.exp(-(r - 1) * 1.5)));
  const idx = Math.min(prog.etapas.length - 1, Math.floor((pct / 100) * prog.etapas.length));
  return (
    <div style={{ display: 'grid', gap: 5, minWidth: 210 }}>
      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>{prog.etapas[idx]}</span>
      <div style={{ height: 5, borderRadius: 4, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--gradient-primary, var(--accent))', transition: 'width .2s linear' }} />
      </div>
      <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.4)' }}>
        {Math.round(pct)}% · estimado · {Math.round(dec / 1000)}s{prog.media > 15000 ? ` de ~${Math.round(prog.media / 1000)}s` : ''}
      </span>
    </div>
  );
}

const reEmailSR = /\b(sr|sem retorno|sem resposta|cobran[cç]a|cobrar|cobre)\b/i;
const reEmailVerbo = /\b(e-?mails?|escrev\w*|redij\w*|redigir|mont\w*|prepar\w*|ger\w*)\b/i;
// Aviso de retenção dos arquivos gerados (Excel/PDF/Word/zip) — 20 dias, depois são removidos.
const AVISO_ARQUIVO_20D = '⚠️ Os arquivos gerados ficam disponíveis por 20 dias; depois são removidos automaticamente. Se precisar depois, é só pedir para gerar novamente.';

// Chave do histórico do chat de perguntas (Q&A) no navegador.
const CHAT_HIST_KEY = 'sure_chat_hist';

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
// Paleta categórica intencional: cores fixas para distinguir séries num mesmo
// gráfico/legenda. Não converter para var() — colapsaria índices diferentes
// (ex: indigo e blue) na mesma cor do tema e destruiria a distinção visual.
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
    <div style={{ background: '#1e293b', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)', borderRadius: 8, padding: '6px 10px', fontSize: 11 }}>
      {label && <div style={{ color: 'rgba(255,255,255,0.5)', marginBottom: 3 }}>{label}</div>}
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || 'var(--accent)', fontWeight: 600 }}>
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
          border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)',
          background: show ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'color-mix(in srgb, var(--accent) 7%, transparent)',
          color: 'var(--accent)',
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
        <p style={{ margin: '0 0 6px', fontSize: 10.5, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          💰 Ressarcimento mensal
        </p>
        <ResponsiveContainer width="100%" height={chartH}>
          <AreaChart data={context.ressarcimento_mensal} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
            <defs>
              <linearGradient id="gradRes" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="mes" tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} axisLine={false} tickLine={false} tickFormatter={v => `R$${(v/1000).toFixed(0)}k`} width={40} />
            <Tooltip content={<ChartTooltip isCurrency />} />
            <Area type="monotone" dataKey="valor" stroke="var(--accent)" strokeWidth={2} fill="url(#gradRes)" />
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
        <p style={{ margin: '0 0 6px', fontSize: 10.5, fontWeight: 700, color: 'var(--success)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          📊 Distribuição por etapa
        </p>
        <ResponsiveContainer width="100%" height={chartH}>
          <PieChart>
            <Pie data={context.por_etapa} dataKey="Total" nameKey="Etapa" cx="50%" cy="50%" outerRadius={expanded ? 75 : 58} paddingAngle={2} label={({ Etapa, percent }) => `${Etapa} ${(percent*100).toFixed(0)}%`} labelLine={false} fontSize={9}>
              {context.por_etapa.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Pie>
            <Tooltip formatter={(v, n) => [fmtNum(v), n]} contentStyle={{ background: '#1e293b', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)', borderRadius: 8, fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // 4. Top clientes — BarChart horizontal
  if (context.por_cliente?.length) {
    charts.push(
      <div key="por-cliente" style={{ marginBottom: 12 }}>
        <p style={{ margin: '0 0 6px', fontSize: 10.5, fontWeight: 700, color: 'var(--warning)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
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
        <p style={{ margin: '0 0 6px', fontSize: 10.5, fontWeight: 700, color: 'var(--danger)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          ⚡ Por concessionária
        </p>
        <ResponsiveContainer width="100%" height={chartH}>
          <BarChart data={context.por_concessionaria} margin={{ top: 4, right: 4, left: 4, bottom: 20 }}>
            <XAxis dataKey="concessionaria" tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)', angle: -30, textAnchor: 'end' }} axisLine={false} tickLine={false} />
            <YAxis yAxisId="left" tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} axisLine={false} tickLine={false} width={30} />
            <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)', borderRadius: 8, fontSize: 11 }} formatter={(v, n) => [n === 'valor_total' ? fmtBRL(v) : fmtNum(v), n === 'valor_total' ? 'Valor' : 'Processos']} />
            <Bar yAxisId="left" dataKey="total" fill="var(--danger)" radius={[4, 4, 0, 0]} name="Processos" />
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
      border: '1px solid color-mix(in srgb, var(--accent) 15%, transparent)',
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
            background: 'color-mix(in srgb, var(--accent) 15%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
            borderRadius: 6, padding: '3px 8px', fontSize: 10, color: 'var(--accent)', cursor: 'pointer',
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
  const { user } = useAuth() || {};
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(true); // abre sempre ampliada (barra lateral de conversas visível)
  const [showInfo, setShowInfo] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [pendingSolic, setPendingSolic] = useState(null); // pedido #sistema aguardando sim/não
  const aguardandoTarefaRef = useRef(false); // disse "nova tarefa" sem a tarefa → próxima msg vira #sistema
  // #rotina / lembrete / "sincronize os e-mails…": {etapa:'descricao'|'confirmar', tipo:'rotina'|'lembrete', texto, deRotina}
  const rotinaRef = useRef(null);
  // Dica de rotinas (analistas): some ao fechar e não volta (por navegador).
  const [dicaRotinasOk, setDicaRotinasOk] = useState(() => {
    try { return localStorage.getItem('sure.dicaRotinas.ok') === '1'; } catch { return false; }
  });
  const fecharDicaRotinas = () => {
    setDicaRotinasOk(true);
    try { localStorage.setItem('sure.dicaRotinas.ok', '1'); } catch { /* sem storage: só esconde nesta sessão */ }
  };
  const [progresso, setProgresso] = useState(null); // {etapas, inicio, media} do pedido em andamento
  const [cobrancaLote, setCobrancaLote] = useState(null); // janela de e-mails de SR (resultado do cobranca-lote)
  const [pendingRevert, setPendingRevert] = useState(null); // protocolo aguardando confirmação de reversão
  const [loading, setLoading] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [solicNotif, setSolicNotif] = useState(0); // pedidos #sistema que ficaram prontos (badge)
  const [listening, setListening] = useState(false); // microfone ativo (speech-to-text)
  const [voiceOn, setVoiceOn] = useState(false);     // SURE responde por voz — DESLIGADA ao abrir (pedido do Alisson 21/10/2026); liga no 🔊
  const [convMode, setConvMode] = useState(false);   // modo conversa (mãos livres: fala → resposta → volta a ouvir)
  const [minhas, setMinhas] = useState([]);          // pedidos #sistema do próprio usuário
  const [activeTab, setActiveTab] = useState('conversa'); // 'conversa' | <id do pedido>
  const [tabBusy, setTabBusy] = useState(null);      // id de pedido com ação em andamento
  const [corrigindo, setCorrigindo] = useState(null); // id do pedido em correção (conversa aberta)
  const [txtCorrecao, setTxtCorrecao] = useState('');
  const [respConf, setRespConf] = useState({});       // respostas às perguntas do worker { "<sid>:<i>": valor }
  const [anexoPendente, setAnexoPendente] = useState(null); // arquivo a anexar no próximo #sistema
  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const recogRef = useRef(null);
  const lastSpokenRef = useRef(null);
  const sendMessageRef = useRef(null);
  const pendingSolicRef = useRef(null);
  const convModeRef = useRef(false);

  // Voz do navegador (Web Speech API): no Chrome o reconhecimento é o do Google. Para FALAR
  // usamos só voz FEMININA pt-BR, escolhendo a mais natural disponível ("Google português do
  // Brasil" no Chrome; Francisca/Thalita "Natural"/Online no Edge) em vez da voz padrão do
  // sistema, que é robótica. Vozes masculinas (Antonio, Daniel…) ficam de fora.
  const voiceSupported = typeof window !== 'undefined' &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);
  const vozPtRef = useRef(null);
  // voz neural (edge-tts no backend): áudio único e fluido; se falhar, volta p/ a do navegador
  const vozNeuralRef = useRef(true);
  const audioRef = useRef(null);
  const falaSeqRef = useRef(0);
  const pararAudio = useCallback(() => {
    try { audioRef.current?.pause(); } catch { /* ignore */ }
    audioRef.current = null;
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return undefined;
    const MASC = /antonio|ant[oô]nio|daniel|male|masculin|homem|ricardo|paulo|felipe|fabio|julio|humberto|nicolau|valerio/i;
    const escolher = () => {
      const vs = window.speechSynthesis.getVoices()
        .filter((v) => /^pt[-_]BR/i.test(v.lang) && !MASC.test(v.name));
      const nota = (v) => (/google/i.test(v.name) ? 40 : 0) + (/natural|online|neural/i.test(v.name) ? 30 : 0)
        + (/francisca|thalita|maria|luciana|leticia|brenda|elza|giovanna|manuela|yara/i.test(v.name) ? 15 : 0)
        + (v.localService ? 0 : 5);
      vozPtRef.current = vs.sort((a, b) => nota(b) - nota(a))[0] || null;
    };
    escolher();
    window.speechSynthesis.addEventListener?.('voiceschanged', escolher);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', escolher);
  }, []);

  const pushMsg = useCallback((role, content) => {
    setMessages((prev) => [...prev, { id: Date.now() + Math.random(), role, content }]);
  }, []);

  // Traduz o erro do reconhecimento de voz em mensagem clara p/ o usuário.
  const voiceErro = useCallback((err) => {
    // Fora de HTTPS/localhost o navegador bloqueia o microfone de vez (não há cadeado
    // nem opção de permitir) — explica isso em vez de mandar procurar o cadeado.
    const inseguro = typeof window !== 'undefined' && window.isSecureContext === false;
    if (inseguro && (err === 'not-allowed' || err === 'service-not-allowed')) {
      pushMsg('error', '🎙️ O navegador só libera o microfone em sites com HTTPS (cadeado). Este endereço abre por http ("Não seguro" na barra), então o ditado por voz fica bloqueado aqui — digite a mensagem. Para liberar a voz, o SURE precisa ser acessado por um endereço https.');
      return;
    }
    const map = {
      'not-allowed': '🎙️ Microfone bloqueado. Clique no ícone à esquerda do endereço (cadeado ou "Configurações do site") e permita o microfone para este site.',
      'service-not-allowed': '🎙️ Microfone bloqueado pelo navegador/sistema. Verifique as permissões.',
      'no-speech': '🎙️ Não ouvi nada. Clique no microfone e fale mais perto.',
      'audio-capture': '🎙️ Nenhum microfone encontrado. Conecte/habilite um microfone.',
      'network': '🎙️ Sem conexão para o reconhecimento de voz. Verifique a internet.',
    };
    pushMsg('error', map[err] || `🎙️ Não consegui ouvir (erro: ${err || 'desconhecido'}). O ditado por voz funciona no Chrome/Edge, em HTTPS, com permissão de microfone.`);
  }, [pushMsg]);

  const silencioTimerRef = useRef(null);
  const stopListening = useCallback(() => {
    clearTimeout(silencioTimerRef.current);
    try { recogRef.current?.stop(); } catch { /* ignore */ }
    setListening(false);
  }, []);

  // Ditado: escuta CONTÍNUO (não corta na primeira pausa) e encerra sozinho depois de
  // ~1,6 s de silêncio — ou quando a pessoa clica no microfone de novo. Aí envia.
  const startListening = useCallback(() => {
    const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) {
      pushMsg('error', '🎙️ Este navegador não tem ditado por voz. Use o Chrome ou o Edge (em HTTPS).');
      return;
    }
    pararAudio(); // para a voz do SURE antes de ouvir
    const rec = new SR();
    rec.lang = 'pt-BR';
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    let finalTxt = '';
    const armarSilencio = (ms) => {
      clearTimeout(silencioTimerRef.current);
      silencioTimerRef.current = setTimeout(() => { try { rec.stop(); } catch { /* ignore */ } }, ms);
    };
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalTxt += (finalTxt ? ' ' : '') + t.trim(); else interim += t;
      }
      setInput((finalTxt + ' ' + interim).trim());
      armarSilencio(1600); // a cada trecho reconhecido, espera mais 1,6 s de silêncio
    };
    rec.onerror = (e) => {
      clearTimeout(silencioTimerRef.current);
      setListening(false);
      if (e?.error === 'no-speech') { if (!finalTxt) voiceErro('no-speech'); return; }
      if (e?.error && e.error !== 'aborted') voiceErro(e.error);
    };
    rec.onend = () => {
      clearTimeout(silencioTimerRef.current);
      setListening(false);
      const txt = finalTxt.trim();
      if (txt) sendMessageRef.current?.(txt); // envia direto (a confirmação/preview protege)
    };
    recogRef.current = rec;
    setListening(true);
    armarSilencio(8000); // se ninguém falar em 8 s, encerra
    try { rec.start(); } catch { setListening(false); voiceErro('start'); }
  }, [pushMsg, voiceErro, pararAudio]);

  // Fala do SURE (TTS) com voz feminina pt-BR. Fala em frases (o Chrome corta falas longas
  // no meio) e ignora o que não faz sentido em voz (tabelas, links, marcações).
  const speak = useCallback((raw) => {
    if (!(voiceOn || convMode) || typeof window === 'undefined' || !window.speechSynthesis) return;
    let t = String(raw || '')
      .replace(/\|.*\|/g, ' ')            // remove linhas de tabela markdown
      .replace(/https?:\/\/\S+/g, ' ')    // links não se leem em voz
      .replace(/[*_`#>•]/g, '')           // remove marcações
      .replace(/\s+/g, ' ')
      .trim();
    if (t.length > 600) t = t.slice(0, 600).replace(/[^.!?]*$/, ''); // até ~600 caracteres, em frase inteira
    if (!t) return;
    // reserva: voz do navegador (Google), frase a frase
    const falarNavegador = () => {
      const frases = t.match(/[^.!?;:]+[.!?;:]*/g) || [t];
      try {
        window.speechSynthesis.cancel();
        frases.map((f) => f.trim()).filter(Boolean).forEach((f) => {
          const u = new SpeechSynthesisUtterance(f);
          u.lang = 'pt-BR';
          if (vozPtRef.current) u.voice = vozPtRef.current;
          u.rate = 1.05;
          u.pitch = 1.05;
          window.speechSynthesis.speak(u);
        });
      } catch { /* ignore */ }
    };
    // principal: voz neural feminina (edge-tts no backend) — um áudio só, sem pausas
    if (vozNeuralRef.current) {
      pararAudio();
      const meu = ++falaSeqRef.current;
      // o áudio vem por URL do próprio site (/api/v1/voz/audio/:id) — a política de
      // segurança do site já permite; com "blob:" o navegador bloqueava (media-src).
      api.post('/voz/falar?url=1', { texto: t }, { timeout: 45000 })
        .then(({ data }) => {
          if (meu !== falaSeqRef.current) return; // já chegou outra fala depois
          if (!data?.url) throw new Error('sem áudio');
          const a = new Audio(data.url);
          audioRef.current = a;
          a.onended = () => { if (audioRef.current === a) audioRef.current = null; };
          return a.play();
        })
        .catch((e) => {
          vozNeuralRef.current = false; // até recarregar a página, usa a do navegador
          // eslint-disable-next-line no-console
          console.warn('[voz] voz neural indisponível, usando a do navegador:', e?.response?.status || e?.message);
          falarNavegador();
        });
      return;
    }
    falarNavegador();
  }, [voiceOn, convMode, pararAudio]);

  // Saudação do 1º uso do dia (SURE): "Bom dia/Boa tarde/Boa noite, {nome}!" + data, horário e
  // temperatura (localização do navegador; sem ela, Sorocaba). Para quem cuida de SR (Eliane),
  // vem também o resumo da página Prazos com recomendações. Gerada no servidor (/chat/saudacao).
  useEffect(() => {
    if (!open || !user) return;
    const hoje = new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD no fuso do navegador
    const chave = `sure_saudacao_${user.user_id || user.email || 'u'}`;
    let ultima = null;
    try { ultima = localStorage.getItem(chave); } catch { /* sem storage */ }
    if (ultima === hoje) return;
    try { localStorage.setItem(chave, hoje); } catch { /* sem storage */ }
    (async () => {
      const coords = await new Promise((resolve) => {
        if (!navigator.geolocation) { resolve(null); return; }
        // se a política do site bloqueia geolocalização, nem tenta (evita o aviso no console) → Sorocaba
        const pol = document.permissionsPolicy || document.featurePolicy;
        try { if (pol?.allowsFeature && !pol.allowsFeature('geolocation')) { resolve(null); return; } } catch { /* segue */ }
        let feito = false;
        const fim = (v) => { if (!feito) { feito = true; resolve(v); } };
        setTimeout(() => fim(null), 4000);
        try {
          navigator.geolocation.getCurrentPosition((p) => fim(p.coords), () => fim(null), { timeout: 3500, maximumAge: 3600000 });
        } catch { fim(null); }
      });
      let texto = '';
      try {
        const { data } = await api.get('/chat/saudacao', {
          params: coords ? { lat: coords.latitude, lon: coords.longitude } : {}, timeout: 35000,
        });
        texto = String(data?.texto || '').trim();
      } catch { /* cai no cumprimento simples */ }
      if (!texto) {
        const h = new Date().getHours();
        const periodo = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
        const nome = String(user.nome || '').trim().split(/\s+/)[0] || '';
        texto = `${periodo}${nome ? `, ${nome}` : ''}! 😊 Como posso te ajudar hoje?`;
      }
      pushMsg('assistant', texto);
    })();
  }, [open, user, pushMsg]);

  // Fala a última mensagem do assistente quando a voz (ou o modo conversa) está ligada.
  useEffect(() => {
    if (!(voiceOn || convMode) || !messages.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && last.id !== lastSpokenRef.current) {
      lastSpokenRef.current = last.id;
      speak(last.content);
    }
  }, [messages, voiceOn, convMode, speak]);

  // Mantém refs sincronizados (usados dentro do reconhecimento contínuo).
  useEffect(() => { pendingSolicRef.current = pendingSolic; }, [pendingSolic]);
  useEffect(() => { convModeRef.current = convMode; }, [convMode]);

  // MODO CONVERSA (mãos livres, estilo conversa por voz do ChatGPT), sempre chamando a
  // pessoa pelo primeiro nome:
  //  • ouve; quando a pessoa para de falar (~2,5 s de silêncio — dá tempo de pensar) envia
  //    como mensagem NORMAL (pergunta, "nova tarefa…", "sim"/"não" de confirmação);
  //  • espera a SURE responder e TERMINAR de falar, e volta a ouvir;
  //  • 10 s em silêncio depois da resposta → "{Nome}, somente isso?";
  //  • mais 15 s sem resposta (ou "só isso"/"obrigado") → despede e DESLIGA — para voltar,
  //    só pelo botão. "encerrar conversa"/"tchau" também desliga.
  const loadingRef = useRef(false);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  const [convOuvindo, setConvOuvindo] = useState(false);
  const primeiroNomeUser = String(user?.nome || '').trim().split(/\s+/)[0] || '';
  useEffect(() => {
    const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!convMode || !SR) {
      setConvOuvindo(false);
      return undefined;
    }
    const nome = primeiroNomeUser;
    const comNome = (txt) => (nome ? `${nome}, ${txt.charAt(0).toLowerCase()}${txt.slice(1)}` : txt);
    let ativo = true;
    let rec = null;
    let timer = null;
    let errosSeguidos = 0;
    const sureFalando = () => !!(window.speechSynthesis?.speaking
      || (audioRef.current && !audioRef.current.paused && !audioRef.current.ended));
    // espera a resposta chegar e a voz da SURE terminar (a fala começa alguns instantes depois)
    const esperarVez = () => new Promise((resolve) => {
      let viuFala = false;
      const inicio = Date.now();
      const tick = () => {
        if (!ativo) { resolve(false); return; }
        const falando = sureFalando();
        if (falando) viuFala = true;
        const aindaPodeComecar = !viuFala && Date.now() - inicio < 6000;
        if (loadingRef.current || falando || aindaPodeComecar) { setTimeout(tick, 250); return; }
        resolve(true);
      };
      setTimeout(tick, 400);
    });
    const despedir = (txt) => {
      ativo = false;
      pushMsg('assistant', txt);
      // deixa a despedida ser falada antes de soltar o microfone
      setTimeout(() => setConvMode(false), 200);
    };
    const normaliza = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    // fase: 'inicio' | 'apos' (logo depois de uma resposta) | 'somente' (perguntou "somente isso?")
    const ouvir = (fase) => {
      if (!ativo) return;
      rec = new SR();
      rec.lang = 'pt-BR';
      rec.continuous = true;
      rec.interimResults = true;
      let finalTxt = '';
      let interimTxt = '';
      let falou = false;
      const armar = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => { try { rec.stop(); } catch { /* ignore */ } }, ms);
      };
      rec.onresult = (e) => {
        if (sureFalando()) return; // não reage à própria voz
        falou = true;
        interimTxt = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalTxt += (finalTxt ? ' ' : '') + t.trim(); else interimTxt += t;
        }
        setInput((finalTxt + ' ' + interimTxt).trim());
        armar(2500); // pausa de ~2,5 s = terminou de falar (conversa fluida, sem envio instantâneo)
      };
      rec.onerror = (e) => {
        if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e?.error)) {
          ativo = false;
          setConvMode(false);
          voiceErro(e.error);
        } else if (e?.error === 'network') {
          errosSeguidos += 1;
        }
      };
      rec.onend = async () => {
        clearTimeout(timer);
        setConvOuvindo(false);
        if (!ativo) return;
        const txt = (finalTxt + ' ' + interimTxt).trim();
        setInput('');
        if (!txt || !falou) {
          if (errosSeguidos >= 3) { ativo = false; setConvMode(false); voiceErro('network'); return; }
          if (fase === 'apos') {
            // 10 s de silêncio depois da resposta → "somente isso?"
            pushMsg('assistant', comNome('Somente isso?'));
            if (!(await esperarVez())) return;
            ouvir('somente');
            return;
          }
          if (fase === 'somente') {
            despedir(nome ? `Tudo bem, ${nome}! Vou encerrar o modo conversa. Quando precisar, é só apertar o botão. Até mais!`
              : 'Tudo bem! Vou encerrar o modo conversa. Quando precisar, é só apertar o botão.');
            return;
          }
          setTimeout(() => ouvir('inicio'), errosSeguidos ? 1500 : 150);
          return;
        }
        errosSeguidos = 0;
        const n = normaliza(txt);
        if (/\b(encerra\w*|finaliza\w*|termina\w*|desliga\w*|sair)\s+(a\s+|o\s+)?(conversa|modo)/.test(n) || /^\s*tchau\b/.test(n)) {
          despedir(nome ? `Até mais, ${nome}! Modo conversa encerrado.` : 'Até mais! Modo conversa encerrado.');
          return;
        }
        // resposta ao "somente isso?" (se não houver pedido esperando confirmação)
        if (fase === 'somente' && !pendingSolicRef.current) {
          if (/^(sim|so isso|somente|e isso|isso mesmo|obrigad\w*|valeu|pode encerrar|ta bom|ok|beleza)\b/.test(n)) {
            despedir(nome ? `Perfeito, ${nome}! Qualquer coisa, é só me chamar pelo botão. Até mais!` : 'Perfeito! Qualquer coisa, é só me chamar. Até mais!');
            return;
          }
          if (/^(nao|tenho|tem|quero|mais uma)\b/.test(n) && n.split(' ').length <= 3) {
            pushMsg('assistant', comNome('Pode falar, estou ouvindo.'));
            if (!(await esperarVez())) return;
            ouvir('inicio');
            return;
          }
        }
        // "oi sure, …" no começo é só cumprimento — tira e manda o resto
        const limpo = txt.replace(/^\s*(?:oi|ol[aá]|ei|opa)?[,\s]*sure\b[,\s]*/i, '').trim() || txt;
        sendMessageRef.current?.(limpo);
        if (!(await esperarVez())) return;
        ouvir('apos');
      };
      setConvOuvindo(true);
      armar(fase === 'apos' ? 10000 : 15000);
      try { rec.start(); } catch { setTimeout(() => ouvir(fase), 800); }
    };
    ouvir('inicio');
    return () => {
      ativo = false;
      clearTimeout(timer);
      try { rec?.abort(); } catch { /* ignore */ }
      setConvOuvindo(false);
    };
  }, [convMode, voiceErro, pushMsg, primeiroNomeUser]);

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

  // Carrega os pedidos do próprio usuário (abas "Meus pedidos") e avisa quando algum
  // fica pronto. Na 1ª vez só marca os já-finalizados como vistos (sem anunciar antigos).
  const carregarMinhas = useCallback(async () => {
    try {
      const { data } = await api.get('/solicitacoes', { params: { mine: 1 } });
      const mine = data?.data || [];
      setMinhas(mine);
      const KEY = 'solic_notif_seen', DONE = ['executado', 'erro', 'revertido'];
      let seen;
      try { seen = new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { seen = new Set(); }
      const save = () => { try { localStorage.setItem(KEY, JSON.stringify([...seen])); } catch { /* ignore */ } };
      // Pendentes de aviso = prontos, ainda não avaliados, que o usuário não viu.
      // No 1º load (seen vazio) os prontos acumulados são anunciados UMA vez (até 10 mais
      // recentes) e todos marcados como vistos → depois só anuncia os novos. Isso reentrega
      // naturalmente os pedidos já respondidos quando a feature entra no ar.
      const pend = mine.filter((s) => DONE.includes(s.status) && s.executado_em && !s.feedback_solicitante && !seen.has(s.id));
      if (pend.length) {
        pend.sort((a, b) => a.id - b.id);
        const anunciar = pend.slice(-10);
        anunciar.forEach((s) => {
          const ic = s.status === 'executado' ? '✅' : s.status === 'erro' ? '⚠️' : '↩️';
          setMessages((prev) => [...prev, {
            id: Date.now() + Math.random(),
            role: s.status === 'erro' ? 'error' : 'assistant',
            content: `${ic} **Seu pedido #${s.id} ficou pronto.** Abra a aba **#${s.id}** acima para ver, baixar o Excel e aprovar/rejeitar.`,
          }]);
        });
        pend.forEach((s) => seen.add(s.id));
        save();
        setSolicNotif((n) => n + anunciar.length);
        setPulse(true);
      }
      // pedidos aguardando confirmação do solicitante (worker fez perguntas simples)
      const CKEY = 'solic_conf_seen';
      let cseen;
      try { cseen = new Set(JSON.parse(localStorage.getItem(CKEY) || '[]')); } catch { cseen = new Set(); }
      // re-anuncia enquanto estiver em preciso_confirmar; marca por (id+perguntas) p/ não repetir
      const confPend = mine.filter((s) => s.status === 'preciso_confirmar' && s.perguntas);
      const confNovos = confPend.filter((s) => !cseen.has(s.id));
      if (confNovos.length) {
        confNovos.forEach((s) => {
          setMessages((prev) => [...prev, {
            id: Date.now() + Math.random(), role: 'assistant',
            content: `❓ **Preciso de uma confirmação sua no pedido #${s.id}.** Abra a aba **#${s.id}** acima e responda — é rapidinho, aí eu termino.`,
          }]);
          cseen.add(s.id);
        });
        try { localStorage.setItem(CKEY, JSON.stringify([...cseen])); } catch { /* ignore */ }
        setSolicNotif((n) => n + confNovos.length);
        setPulse(true);
      }
      // quando sai de preciso_confirmar, limpa o "visto" p/ futuras perguntas re-notificarem
      const aindaConf = new Set(confPend.map((s) => s.id));
      const limpos = [...cseen].filter((id) => !aindaConf.has(id));
      if (limpos.length !== cseen.size) {
        try { localStorage.setItem(CKEY, JSON.stringify([...aindaConf])); } catch { /* ignore */ }
      }
      return mine;
    } catch { return []; }
  }, []);

  useEffect(() => {
    let stop = false;
    carregarMinhas();
    const t = setInterval(() => { if (!stop) carregarMinhas(); }, 25000);
    return () => { stop = true; clearInterval(t); };
  }, [carregarMinhas]);

  // Se a aba ativa for um pedido que não existe mais (ex.: excluído), volta p/ a
  // Conversa. Pedidos JÁ avaliados continuam acessíveis (pela aba Histórico), então
  // só reseta quando o id some de 'minhas' por completo.
  useEffect(() => {
    if (typeof activeTab === 'number' && !minhas.some((s) => s.id === activeTab)) {
      setActiveTab('conversa');
    }
  }, [minhas, activeTab]);

  // Persistência do chat de PERGUNTAS (Q&A). Durável no SERVIDOR (cross-device) via
  // /chat/historico, com o localStorage como cache offline. Guarda só {id, role,
  // content} (sem os gráficos 'context', que são pesados).
  const chatLoadedRef = useRef(false);
  const chatSaveTimer = useRef(null);
  // Conversas com a SURE gravadas no servidor por 3 dias (FT_CHAT_CONVERSAS), por sessão —
  // dá para listar e RETOMAR uma conversa recente. Cada mensagem nova (pessoa/SURE) é enviada
  // uma vez; mensagens carregadas do histórico não são regravadas.
  const novaSessao = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const sessaoRef = useRef(null);
  if (!sessaoRef.current) {
    let s = null;
    try { s = sessionStorage.getItem('sure_sessao'); } catch { /* ignore */ }
    sessaoRef.current = s || novaSessao();
    try { sessionStorage.setItem('sure_sessao', sessaoRef.current); } catch { /* ignore */ }
  }
  const trocarSessao = (s) => {
    sessaoRef.current = s || novaSessao();
    try { sessionStorage.setItem('sure_sessao', sessaoRef.current); } catch { /* ignore */ }
  };
  const logadosRef = useRef(new Set());
  useEffect(() => {
    if (!chatLoadedRef.current) return;
    messages.forEach((m) => {
      if ((m.role !== 'user' && m.role !== 'assistant') || logadosRef.current.has(m.id)) return;
      logadosRef.current.add(m.id);
      const conteudo = String(m.content || '').trim();
      if (!conteudo) return;
      api.post('/chat/conversas/msg', {
        sessao: sessaoRef.current, role: m.role, conteudo,
        modo: convModeRef.current ? 'conversa' : 'texto',
      }).catch(() => { /* offline: segue */ });
    });
  }, [messages]);
  const [conversasAbertas, setConversasAbertas] = useState(false);
  const [conversas, setConversas] = useState(null);
  const [convDias, setConvDias] = useState(90);
  const [renomeando, setRenomeando] = useState(null); // sessao em edição de nome
  const [tituloEdit, setTituloEdit] = useState('');
  const carregarConversas = useCallback(async () => {
    try {
      const { data } = await api.get('/chat/conversas');
      setConversas(data?.conversas || []);
      if (data?.dias) setConvDias(data.dias);
    } catch { setConversas((c) => c || []); }
  }, []);
  const abrirConversas = async () => {
    setConversasAbertas(true);
    setConversas(null);
    await carregarConversas();
  };
  const salvarTitulo = async (sessao) => {
    const t = tituloEdit.trim();
    if (!t) { setRenomeando(null); return; }
    setConversas((cv) => (cv || []).map((x) => (x.sessao === sessao ? { ...x, titulo: t } : x)));
    setRenomeando(null); setTituloEdit('');
    try { await api.put(`/chat/conversas/${encodeURIComponent(sessao)}/titulo`, { titulo: t }); }
    catch { pushMsg('error', 'Não consegui renomear a conversa.'); carregarConversas(); }
  };
  const retomarConversa = async (sessao) => {
    try {
      const { data } = await api.get(`/chat/conversas/${encodeURIComponent(sessao)}`);
      const msgs = (data?.mensagens || []).map((m) => ({ id: `h${m.id}`, role: m.role, content: m.content }));
      msgs.forEach((m) => logadosRef.current.add(m.id));
      lastSpokenRef.current = msgs.length ? msgs[msgs.length - 1].id : lastSpokenRef.current; // não relê em voz
      trocarSessao(sessao);
      setMessages(msgs);
      setActiveTab('conversa');
      setConversasAbertas(false);
    } catch { pushMsg('error', 'Não consegui abrir essa conversa.'); }
  };
  // Nova conversa (estilo Claude web): a atual fica salva no histórico; começa uma do zero.
  const novaConversa = () => {
    trocarSessao();
    logadosRef.current = new Set();
    setMessages([]);
    try { localStorage.removeItem(CHAT_HIST_KEY); } catch { /* ignore */ }
    api.delete('/chat/historico').catch(() => { /* ignore */ });
    setConversasAbertas(false);
    setActiveTab('conversa');
  };
  const excluirConversa = async (sessao, e) => {
    if (e) e.stopPropagation();
    try {
      await api.delete(`/chat/conversas/${encodeURIComponent(sessao)}`);
      setConversas((cv) => (cv || []).filter((x) => x.sessao !== sessao));
      // se excluiu a conversa aberta agora, começa uma nova em branco
      if (sessao === sessaoRef.current) novaConversa();
    } catch { pushMsg('error', 'Não consegui excluir a conversa.'); }
  };
  // Quando a janela está ampliada, a barra lateral mostra o histórico — mantém atualizado.
  useEffect(() => {
    if (expanded && open && !minimized) carregarConversas();
  }, [expanded, open, minimized, messages.length, carregarConversas]);
  useEffect(() => {
    let stop = false;
    (async () => {
      let carregou = false;
      try {
        const { data } = await api.get('/chat/historico');
        const arr = data?.mensagens;
        if (!stop && Array.isArray(arr) && arr.length) { arr.forEach((m) => logadosRef.current.add(m.id)); setMessages(arr); lastSpokenRef.current = arr[arr.length - 1].id; carregou = true; }
      } catch { /* servidor indisponível → usa cache local */ }
      if (!stop && !carregou) {
        try {
          const raw = localStorage.getItem(CHAT_HIST_KEY);
          const arr = raw ? JSON.parse(raw) : null;
          if (Array.isArray(arr) && arr.length) { arr.forEach((m) => logadosRef.current.add(m.id)); setMessages(arr); lastSpokenRef.current = arr[arr.length - 1].id; }
        } catch { /* ignore */ }
      }
      if (!stop) chatLoadedRef.current = true;
    })();
    return () => { stop = true; };
  }, []);
  useEffect(() => {
    if (!chatLoadedRef.current) return; // não sobrescreve antes de carregar
    const slim = messages.slice(-120).map((m) => ({ id: m.id, role: m.role, content: m.content }));
    try { localStorage.setItem(CHAT_HIST_KEY, JSON.stringify(slim)); } catch { /* ignore */ }
    clearTimeout(chatSaveTimer.current);
    chatSaveTimer.current = setTimeout(() => {
      api.put('/chat/historico', { mensagens: slim }).catch(() => { /* offline: fica o cache local */ });
    }, 1500);
    return () => clearTimeout(chatSaveTimer.current);
  }, [messages]);

  // Ao abrir o chat, zera o badge de avisos.
  useEffect(() => { if (open && !minimized) setSolicNotif(0); }, [open, minimized]);

  const sendMessage = useCallback(async (text) => {
    let question = (text || input).trim();
    if (!question || loading) return;

    const addMsg = (role, content) =>
      setMessages((prev) => [...prev, { id: Date.now() + Math.random(), role, content }]);

    // ── Rotinas (#rotina), lembretes e sincronização de e-mails ──
    // O servidor interpreta e devolve um resumo; só grava depois do "sim". Rotina de quem não é
    // admin fica aguardando a aprovação do administrador.
    const previaRotina = async (tipo, texto, deRotina) => {
      try {
        const url = tipo === 'lembrete' ? '/lembretes/interpretar' : '/rotinas/interpretar';
        const { data } = await api.post(url, { texto, de_rotina: deRotina });
        if (!data?.ok) {
          const nomes = (data?.candidatos || []).map((c) => c.nome).join(', ');
          addMsg('assistant', `🤔 ${data?.erro || 'Não entendi.'}${nomes && !String(data?.erro || '').includes(nomes) ? `\n\nPessoas encontradas: ${nomes}` : ''}\n\nPode escrever de novo (ou **cancelar**).`);
          rotinaRef.current = { etapa: 'descricao', tipo, deRotina };
          return;
        }
        rotinaRef.current = { etapa: 'confirmar', tipo, texto, deRotina };
        const titulo = tipo === 'lembrete' ? '⏰ **Lembrete**' : (deRotina ? '🔁 **Nova rotina**' : '📨 **Sincronizar e-mails com processos**');
        addMsg('assistant', `${titulo}\n\n${data.resumo}${data.aviso ? `\n\n_${data.aviso}_` : ''}\n\nConfirma? Digite **sim** para criar ou **não** para cancelar — ou escreva de novo para corrigir.`);
      } catch (e) {
        addMsg('error', 'Falha ao interpretar: ' + (e?.response?.data?.error || e.message));
      }
    };
    if (rotinaRef.current) {
      const pr = rotinaRef.current;
      addMsg('user', question);
      setInput('');
      if (/^\s*(cancela\w*|n[aã]o|esquece|deixa)\b/i.test(question)) {
        rotinaRef.current = null;
        addMsg('assistant', 'Tudo bem, cancelei — nada foi gravado.');
        return;
      }
      rotinaRef.current = null;
      if (pr.etapa === 'confirmar' && /^\s*sim\b/i.test(question)) {
        try {
          const url = pr.tipo === 'lembrete' ? '/lembretes' : '/rotinas';
          const { data } = await api.post(url, { texto: pr.texto, de_rotina: pr.deRotina });
          addMsg('assistant', '✅ ' + (data?.mensagem || 'Feito.') + (pr.tipo === 'rotina' ? '\n\nPara ver suas rotinas: **#rotinas**.' : ''));
        } catch (e) {
          addMsg('error', 'Falha ao gravar: ' + (e?.response?.data?.error || e.message));
        }
        return;
      }
      // descrição (ou correção da prévia)
      await previaRotina(pr.tipo || 'rotina', question, pr.tipo === 'lembrete' ? false : (pr.deRotina ?? true));
      return;
    }
    // "traga em excel" / "manda em planilha" logo após uma resposta → o próprio front gera o .xlsx
    // da última resposta (antes a IA do chat respondia que "não consegue gerar Excel").
    if (question.length <= 80 && /\b(excel|planilha|xlsx)\b/i.test(question)
        && !/^[#@]sistema\b/i.test(question) && !/\b(processo|cliente|relat[óo]rio d[aoe]|uc)\s+\S/i.test(question)) {
      const ultima = [...messages].reverse().find((m) => m.role === 'assistant' && String(m.content || '').length > 80);
      if (ultima) {
        addMsg('user', question);
        setInput('');
        try {
          const abas = respostaParaExcel(ultima.content, 'SURE_resposta');
          addMsg('assistant', `📥 Pronto! Baixei a planilha com a resposta anterior (aba${abas.length > 1 ? 's' : ''}: ${abas.join(', ')}). Confira a pasta de Downloads.\n\nPara relatórios grandes ou com dados novos, peça com **#sistema** (ex.: _#sistema relatório em excel dos processos da Claro deferidos em 2026_).`);
        } catch (e) {
          addMsg('error', 'Não consegui montar a planilha: ' + (e?.message || e));
        }
        return;
      }
    }
    if (/^#rotinas\b/i.test(question)) {
      addMsg('user', question);
      setInput('');
      try {
        const { data } = await api.get('/rotinas');
        const rot = { aguardando_aprovacao: '⏳ aguardando aprovação', ativa: '🟢 ativa', pausada: '⏸️ pausada', desativada: '⛔ desativada', rejeitada: '❌ rejeitada', concluida: '✔️ concluída' };
        const linhas = (Array.isArray(data) ? data : []).slice(0, 30).map((r) =>
          `- **#${r.id_rotina}** · ${rot[r.status] || r.status}${r.nome_usuario ? ` · ${r.nome_usuario}` : ''}\n  ${r.resumo}`);
        addMsg('assistant', linhas.length ? `🔁 **Rotinas**\n\n${linhas.join('\n')}` : 'Nenhuma rotina ainda. Para criar, digite **#rotina**.');
      } catch (e) {
        addMsg('error', 'Falha ao listar rotinas: ' + (e?.response?.data?.error || e.message));
      }
      return;
    }
    if (/^#rotina\b/i.test(question)) {
      addMsg('user', question);
      setInput('');
      const resto = question.replace(/^#rotina\b[:\s-]*/i, '').trim();
      if (!resto) {
        rotinaRef.current = { etapa: 'descricao', tipo: 'rotina', deRotina: true };
        addMsg('assistant', '🔁 O que você quer que vire rotina? Descreva a tarefa e os horários.\n\nExemplos:\n- _vincular os e-mails do dia anterior aos processos às 14:00 e às 18:00_\n- _lembrete para a Luana Nascimento toda segunda às 9h sobre os prazos da semana_\n\nA rotina vai para aprovação do administrador antes de começar.');
        return;
      }
      await previaRotina('rotina', resto, true);
      return;
    }
    if (!pendingSolic && !pendingRevert && !/^[#@]sistema\b/i.test(question)) {
      const ehLembrete = /\blembrete\b|\blembr(e|ar)\b|\bme lembr/i.test(question)
        && /\b(para|pra|me)\b/i.test(question)
        && /amanh|hoje|\bàs?\b|\bas\b|\d{1,2}\s*[:h]|\d{1,2}\/\d{1,2}|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo/i.test(question);
      const ehSync = /^\s*(por favor,?\s*)?(sincroniz|vincul)\w*\b.*e-?mails?/i.test(question);
      if (ehLembrete || ehSync) {
        addMsg('user', question);
        setInput('');
        await previaRotina(ehLembrete ? 'lembrete' : 'rotina', question, false);
        return;
      }
    }

    // "Nova tarefa" = atalho falado/digitado para #sistema (pedido ao sistema, com prévia e
    // aprovação). "Nova tarefa: mover o processo X…" já vira o pedido; "nova tarefa" sozinho
    // pede a tarefa e a PRÓXIMA mensagem vira o pedido.
    if (!pendingSolic) {
      if (aguardandoTarefaRef.current && !/^[#@]sistema\b/i.test(question)) {
        aguardandoTarefaRef.current = false;
        if (/^\s*(cancela\w*|deixa|esquece|nada|n[aã]o)\b/i.test(question)) {
          addMsg('user', question);
          setInput('');
          addMsg('assistant', 'Tudo bem, cancelei. É só dizer **"nova tarefa"** quando precisar.');
          return;
        }
        question = '#sistema ' + question;
      }
      const mNova = question.match(reNovaTarefa);
      if (mNova) {
        const resto = question.slice(mNova[0].length).trim();
        if (!resto) {
          addMsg('user', question);
          setInput('');
          aguardandoTarefaRef.current = true;
          addMsg('assistant', '📝 Certo! Pode falar a tarefa — ela vai como **pedido ao sistema** (mostro a prévia e só executa depois da aprovação).');
          return;
        }
        question = '#sistema ' + resto;
      }
    }

    // ── Fluxo #sistema: pedido ao sistema → fila de aprovação do gestor ──
    // 1) responde a uma confirmação pendente (sim/não). Se, em vez de sim/não, a pessoa escreve
    //    um pedido novo (#sistema … ou uma frase), o pedido antigo é deixado de lado e o novo
    //    segue o fluxo normal — antes o chat travava respondendo "Não entendi" a tudo.
    let descartouPendente = false;
    if (pendingSolic && !/^\s*(sim|n[ãa]o)\b/i.test(question)
        && (/^[#@]sistema\b/i.test(question) || question.trim().split(/\s+/).length >= 4)) {
      setPendingSolic(null);
      setAnexoPendente(null);
      descartouPendente = true;
    }
    if (pendingSolic && !descartouPendente) {
      addMsg('user', question);
      setInput('');
      if (/^\s*sim\b/i.test(question)) {
        try {
          const { data } = await api.post('/solicitacoes', { mensagem: pendingSolic });
          const sid = data?.id;
          if (sid && anexoPendente) {
            try {
              const fd = new FormData();
              fd.append('arquivo', anexoPendente);
              await api.post(`/solicitacoes/${sid}/anexo`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
            } catch { addMsg('error', 'Pedido criado, mas o anexo falhou (arquivo muito grande?).'); }
          }
          const vocativo = primeiroNomeUser ? `, ${primeiroNomeUser}` : '';
          if (data?.precisa_aprovacao === false) {
            // consulta/relatório: sem aprovação — já está sendo levantado
            addMsg('assistant', `🔎 Pedido #${sid || ''} é uma consulta, então não precisa de aprovação${vocativo}. Já estou levantando — o resultado aparece na aba **#${sid || ''}** acima. (Se for uma consulta muito pesada, aviso e peço a aprovação do Alisson Stark.)`);
          } else {
            addMsg('assistant', `✅ Pedido #${sid || ''} registrado${anexoPendente ? ' (com anexo)' : ''}. Estou enviando para o Alisson Stark aprovar${vocativo}. Acompanhe na aba **#${sid || ''}** acima.`);
          }
          carregarMinhas();
        } catch (e) {
          addMsg('error', 'Falha ao enviar: ' + (e?.response?.data?.error || e.message));
        }
        setPendingSolic(null);
        setAnexoPendente(null);
      } else if (/^\s*n[ãa]o\b/i.test(question)) {
        addMsg('assistant', 'Pedido cancelado — nada foi enviado.');
        setPendingSolic(null);
        setAnexoPendente(null);
      } else {
        addMsg('assistant', 'Não entendi. Digite **sim** para enviar para produção ou **não** para cancelar.');
      }
      return;
    }
    // ── Fluxo #protocolo: consultar/reverter uma solicitação já executada ──
    // 1b) responde confirmação de reversão pendente (sim/não)
    if (pendingRevert) {
      addMsg('user', question);
      setInput('');
      if (/^\s*sim\b/i.test(question)) {
        try {
          const r = await api.post(`/solicitacoes/${pendingRevert}/reverter`);
          addMsg('assistant', `↩️ **Protocolo #${pendingRevert} revertido.** ${r.data?.campos_revertidos || 0} campo(s) restaurado(s) ao valor anterior.`);
        } catch (e) {
          addMsg('error', 'Falha ao reverter: ' + (e?.response?.data?.error || e.message));
        }
        setPendingRevert(null);
      } else if (/^\s*n[ãa]o\b/i.test(question)) {
        addMsg('assistant', 'Reversão cancelada — nada foi alterado.');
        setPendingRevert(null);
      } else {
        addMsg('assistant', 'Digite **sim** para reverter ou **não** para cancelar.');
      }
      return;
    }
    // 1c) consulta de protocolo: "#protocolo 123"
    if (/^#protocolo\b/i.test(question)) {
      const pid = (question.match(/#protocolo\s*#?\s*(\d+)/i) || [])[1];
      addMsg('user', question);
      setInput('');
      if (!pid) {
        addMsg('assistant', 'Informe o número. Ex.: `#protocolo 123`');
        return;
      }
      try {
        const { data } = await api.get(`/solicitacoes/${pid}/protocolo`);
        const s = data?.solicitacao || {};
        const alt = data?.alteracoes || [];
        let txt = `🧾 **Protocolo #${data.protocolo}**\n\n` +
          `• **Pedido:** "${s.mensagem || ''}"\n` +
          `• **Solicitante:** ${s.usuario_nome || '—'}\n` +
          `• **Status:** ${s.status || '—'}\n` +
          `• **Aprovado por:** ${s.aprovado_por || '—'}\n` +
          `• **Executado em:** ${s.executado_em || '—'}\n` +
          `• **Resultado:** ${s.resultado || '—'}\n`;
        if (alt.length) {
          txt += `\n**Alterações feitas:**\n` + alt.map((a) =>
            `- ${a.tabela}.${a.coluna}: \`${a.valor_antigo}\` → \`${a.valor_novo}\`` +
            ` (por ${a.usuario_nome || '—'} em ${a.criado_em || '—'})` +
            (a.revertido_em ? ` — ↩️ revertido em ${a.revertido_em}` : '')).join('\n');
        }
        if (data.pode_reverter) {
          txt += `\n\n**Deseja reverter este protocolo?** Digite **sim** para restaurar os valores anteriores ou **não** para cancelar.`;
          setPendingRevert(pid);
        } else {
          txt += `\n\n_Não há alterações reversíveis neste protocolo._`;
        }
        addMsg('assistant', txt);
      } catch (e) {
        addMsg('error', 'Não encontrei esse protocolo: ' + (e?.response?.data?.error || e.message));
      }
      return;
    }

    // 1b) E-mail de SR (sem retorno) / cobrança de retorno — ex.: "veja o que está atrasado
    //     da CELESC nos Prazos e o que está sem resposta, escreva o e-mail de SR". Busca os
    //     vencidos sem retorno da distribuidora e abre a janela com os rascunhos prontos
    //     (nada é enviado sem a pessoa revisar e clicar em Enviar).
    if (!/^[#@]sistema\b/i.test(question) && reEmailSR.test(question) && reEmailVerbo.test(question)) {
      addMsg('user', question);
      setInput('');
      setLoading(true);
      const t0SR = Date.now();
      setProgresso({ inicio: t0SR, media: tempoMedio('sr'), etapas: ['Lendo os processos com prazo vencido…', 'Conferindo os e-mails de cada processo…', 'Identificando quem está sem retorno…', 'Montando os e-mails de SR…'] });
      try {
        const { data } = await api.post('/processos/cobranca-lote', { mensagem: question }, { timeout: 300000 });
        registrarTempo('sr', Date.now() - t0SR);
        const n = data?.itens?.length || 0;
        const quem = data?.concessionaria ? ` da **${data.concessionaria}**` : '';
        let txt = `📬 Verifiquei os prazos vencidos${quem} e a caixa de e-mails dos processos.\n\n`;
        txt += `• **${data?.total_atrasados ?? 0}** processo(s) com prazo vencido em "Aguardando retorno"\n`;
        txt += `• **${n}** sem retorno da distribuidora → e-mail de SR pronto\n`;
        if (data?.respondidos) txt += `• ${data.respondidos} já tiveram resposta depois do último envio (não precisam de SR)\n`;
        if (!data?.concessionaria) txt += `\n_Não identifiquei a distribuidora na mensagem — listei todas. Diga, por ex., "SR da CELESC" para filtrar._\n`;
        txt += n ? `\nAbri a janela com os rascunhos: revise e envie cada um.` : `\nNada a cobrar agora. 🎉`;
        addMsg('assistant', txt);
        if (n) setCobrancaLote(data);
      } catch (e) {
        addMsg('error', 'Não consegui montar os e-mails de SR: ' + (e?.response?.data?.error || e.message));
      } finally {
        setLoading(false);
        setProgresso(null);
      }
      return;
    }

    // 2) Comando de sistema — SEM precisar de tag. Auto-detecta: se for um comando
    //    (alterar/relatório/histórico/mover), vira pedido (prévia + aprovação); se for
    //    pergunta, segue para o chat de Q&A abaixo. "#sistema" ainda força comando.
    const forcadoSistema = /^[#@]sistema\b/i.test(question);
    const pedido = question.replace(/^[#@]sistema[\s,:]*/i, '').trim(); // "#sistema" ou "@sistema"
    if (forcadoSistema && !pedido) {
      addMsg('user', question);
      setInput('');
      addMsg('assistant', 'Escreva o que você quer. Ex.: `atualizar o crédito dobro do processo 18789 para 40000`.');
      return;
    }
    if (pedido) {
      let data = null;
      try {
        ({ data } = await api.post('/solicitacoes/interpretar', { mensagem: pedido }));
      } catch { data = null; }
      if (data && (data.comando || forcadoSistema)) {
        addMsg('user', question);
        setInput('');
        const consulta = !!data.leitura; // consulta/relatório = sem aprovação
        let cab = consulta
          ? `🔎 **Consulta ao sistema** (não precisa de aprovação):\n\n"${pedido}"\n`
          : `📋 **Pedido ao sistema** (vai para aprovação):\n\n"${pedido}"\n`;
        if (data.pode_executar) {
          cab += consulta
            ? `\n🤖 **O que vou levantar:**\n${data.preview}\n`
            : `\n🤖 **Prévia da execução:**\n${data.preview}\n\n_Após a aprovação, o sistema executa (com backup e protocolo)._\n`;
        } else if (!consulta) {
          cab += `\n✍️ Não é execução automática${data.motivo ? ` (${data.motivo})` : ''} — vai para **execução manual** após aprovação.\n`;
        } else {
          cab += `\n_Se a consulta for muito pesada, ela vai para a aprovação do Alisson Stark._\n`;
        }
        cab += consulta ? `\n` : `\n⚠️ Nada é alterado sem aprovação.\n\n`;
        cab += convModeRef.current
          ? `**Posso enviar?** Diga **"sim"** para confirmar ou **"não"** para cancelar.`
          : `**Deseja enviar?** Digite **sim** para confirmar ou **não** para cancelar.`;
        addMsg('assistant', cab);
        setPendingSolic(pedido);
        return;
      }
    }

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
    const t0QA = Date.now();
    setProgresso({ inicio: t0QA, media: tempoMedio('qa'), etapas: etapasDaPergunta(question) });

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const resp = await api.post(
        '/chat/processos',
        { question, history: historyForAPI },
        { signal: ctrl.signal, timeout: 60000 },
      );
      registrarTempo('qa', Date.now() - t0QA);
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
      setProgresso(null);
    }
  }, [input, messages, loading, pendingSolic, pendingRevert, anexoPendente, carregarMinhas]);

  // Mantém o ref do sendMessage atualizado (usado pelo reconhecimento de voz).
  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

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
    trocarSessao(); // "limpar" = começa uma conversa nova (a anterior fica nas recentes por 3 dias)
    setMessages([]);
    setLoading(false);
    try { localStorage.removeItem(CHAT_HIST_KEY); } catch { /* ignore */ }
    clearTimeout(chatSaveTimer.current);
    api.delete('/chat/historico').catch(() => { /* ignore */ });
  };

  // ── Meus pedidos (abas estilo Chrome) ─────────────────────────────────────
  const abertos = minhas.filter((s) => !s.feedback_solicitante).sort((a, b) => b.id - a.id);

  const statusInfo = (st) => ({
    pendente: { c: '#f59e0b', t: 'Pendente de aprovação do gestor' },
    aprovado: { c: '#3b82f6', t: 'Aprovado — na fila de execução' },
    executado: { c: '#22c55e', t: 'Pronto' },
    preciso_confirmar: { c: '#a855f7', t: 'Precisa da sua confirmação' },
    revisao: { c: '#f59e0b', t: 'Em análise manual' },
    revertido: { c: '#9ca3af', t: 'Revertido' },
    erro: { c: '#ef4444', t: 'Erro' },
  }[st] || { c: '#9ca3af', t: st });

  const baixar = async (id, formato, ext) => {
    try {
      const resp = await api.get(`/solicitacoes/${id}/export`, { params: { formato }, responseType: 'blob' });
      const url = URL.createObjectURL(resp.data);
      const a = document.createElement('a');
      a.href = url; a.download = `relatorio_sure_${id}.${ext}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      pushMsg('error', 'Não consegui gerar o arquivo: ' + (e?.response?.data?.error || e.message));
    }
  };

  const enviarCorrecao = async (id) => {
    const txt = txtCorrecao.trim();
    if (!txt) return;
    setTabBusy(id);
    try {
      await api.post(`/solicitacoes/${id}/corrigir`, { mensagem: txt });
      setCorrigindo(null); setTxtCorrecao('');
      await carregarMinhas();
    } catch (e) {
      pushMsg('error', 'Falha ao enviar correção: ' + (e?.response?.data?.error || e.message));
    } finally { setTabBusy(null); }
  };

  const responderConf = async (s) => {
    const perg = (s.perguntas && Array.isArray(s.perguntas.perguntas)) ? s.perguntas.perguntas : [];
    const respostas = perg.map((_, i) => (respConf[`${s.id}:${i}`] || '').trim());
    if (!respostas.some((r) => r)) { pushMsg('error', 'Escolha ou escreva ao menos uma resposta.'); return; }
    setTabBusy(s.id);
    try {
      await api.post(`/solicitacoes/${s.id}/responder-confirmacao`, { respostas });
      // limpa as respostas desse pedido
      setRespConf((m) => { const n = { ...m }; perg.forEach((_, i) => delete n[`${s.id}:${i}`]); return n; });
      await carregarMinhas();
      setActiveTab('conversa');
      pushMsg('assistant', `✅ Obrigado! Já estou terminando o pedido #${s.id} com a sua resposta. O resultado aparece na aba **#${s.id}** acima.`);
    } catch (e) {
      pushMsg('error', 'Não consegui registrar sua resposta: ' + (e?.response?.data?.error || e.message));
    } finally { setTabBusy(null); }
  };

  const baixarAnexo = async (sid, aid, nome) => {
    try {
      const resp = await api.get(`/solicitacoes/${sid}/anexo/${aid}`, { responseType: 'blob' });
      const url = URL.createObjectURL(resp.data);
      const a = document.createElement('a');
      a.href = url; a.download = nome || `anexo_${aid}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      pushMsg('error', 'Não consegui baixar o anexo: ' + (e?.response?.data?.error || e.message));
    }
  };

  const darFeedback = async (id, verdict) => {
    setTabBusy(id);
    try {
      await api.put(`/solicitacoes/${id}/feedback`, { verdict });
      await carregarMinhas();
      setActiveTab('conversa');
      pushMsg('assistant', verdict === 'aprovado' ? `👍 Você aprovou o resultado do pedido #${id}.` : `👎 Você rejeitou o pedido #${id}. Pode refazê-lo com mais detalhes.`);
    } catch (e) {
      pushMsg('error', 'Falha ao registrar: ' + (e?.response?.data?.error || e.message));
    } finally { setTabBusy(null); }
  };

  const parseTabela = (txt) => {
    let titulo = '', header = null; const rows = [];
    const sep = /^:?-{2,}:?$/;
    for (const ln of String(txt || '').split('\n')) {
      const t = ln.trim();
      if (!t) continue;
      if (t.startsWith('### ')) { if (header) break; continue; } // várias abas: a prévia mostra a 1ª; o Excel traz todas
      if (t.startsWith('|')) {
        const cells = t.replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
        if (cells.every((c) => sep.test(c))) continue;
        if (!header) header = cells; else rows.push(cells);
      } else if (!titulo && !header) { titulo = t; }
    }
    return { titulo, header, rows };
  };

  function renderAbas() {
    if (!abertos.length) return null;
    const aba = (key, label, dotC, title) => (
      <button key={key} type="button" title={title} onClick={() => setActiveTab(key)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
          padding: '5px 10px', borderRadius: '8px 8px 0 0', border: 'none', cursor: 'pointer',
          fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
          background: activeTab === key ? 'rgba(255,255,255,0.1)' : 'transparent',
          color: activeTab === key ? '#fff' : 'rgba(255,255,255,0.65)',
          borderBottom: activeTab === key ? '2px solid var(--accent)' : '2px solid transparent',
        }}>
        {dotC && <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotC, flexShrink: 0 }} />}
        {label}
      </button>
    );
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 8px 0', background: 'rgba(0,0,0,0.18)', borderBottom: '1px solid rgba(255,255,255,0.08)', overflowX: 'auto', flexShrink: 0 }}>
        {aba('conversa', '💬 Conversa', null, 'Conversa com a IA')}
        {abertos.map((s) => aba(s.id, `#${s.id}`, statusInfo(s.status).c, s.mensagem))}
      </div>
    );
  }

  function renderHistorico() {
    const todos = [...minhas].sort((a, b) => b.id - a.id);
    const back = () => setActiveTab('conversa');
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', color: '#e6edf3', display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <History size={15} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 13, fontWeight: 700 }}>Histórico de pedidos</span>
          <button type="button" onClick={back}
            style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid rgba(255,255,255,0.18)', color: 'rgba(255,255,255,0.8)', borderRadius: 7, padding: '3px 9px', fontSize: 11.5, cursor: 'pointer' }}>
            ← Conversa
          </button>
        </div>
        {todos.length === 0 && (
          <div style={{ fontSize: 12.5, opacity: 0.6, padding: '24px 0', textAlign: 'center' }}>
            Você ainda não fez pedidos ao sistema.
          </div>
        )}
        {todos.map((s) => {
          const si = statusInfo(s.status);
          const fb = s.feedback_solicitante;
          return (
            <button key={s.id} type="button" onClick={() => setActiveTab(s.id)}
              style={{
                display: 'grid', gridTemplateColumns: 'auto auto 1fr auto', alignItems: 'center', gap: 8,
                textAlign: 'left', width: '100%', background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)', borderRadius: 9, padding: '8px 10px',
                color: '#e6edf3', cursor: 'pointer',
              }}>
              <span title={si.t} style={{ width: 8, height: 8, borderRadius: '50%', background: si.c, flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 700, opacity: 0.85 }}>#{s.id}</span>
              <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.9 }}>
                {s.mensagem}
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                {fb && <span style={{ fontSize: 12 }}>{fb === 'aprovado' ? '👍' : '👎'}</span>}
                <span style={{ fontSize: 10.5, opacity: 0.5 }}>{(s.criado_em || '').slice(0, 10)}</span>
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  function renderDetalhePedido() {
    const s = minhas.find((x) => x.id === activeTab);
    if (!s) return null;
    const si = statusInfo(s.status);
    const pronto = ['executado', 'erro', 'revisao', 'revertido'].includes(s.status) && s.resultado;
    const tab = pronto ? parseTabela(s.resultado) : null;
    const temTabela = tab && tab.header && tab.rows.length > 0;
    const btn = (bg, fg) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, padding: '7px 12px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${fg}`, background: bg, color: fg });
    const btnFmt = (fg) => ({ fontSize: 11.5, fontWeight: 700, padding: '4px 11px', borderRadius: 7, cursor: 'pointer', border: `1px solid ${fg}`, background: 'transparent', color: fg });
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', color: '#e6edf3', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setActiveTab('historico')}
            title="Voltar ao histórico"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: '1px solid rgba(255,255,255,0.18)', color: 'rgba(255,255,255,0.8)', borderRadius: 7, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>
            <History size={12} /> Histórico
          </button>
          <span style={{ fontSize: 10.5, padding: '2px 9px', borderRadius: 99, background: `${si.c}22`, color: si.c, fontWeight: 700 }}>● {si.t}</span>
          <span style={{ fontSize: 10.5, opacity: 0.5, marginLeft: 'auto' }}>{(s.criado_em || '').slice(0, 16).replace('T', ' ')}</span>
        </div>
        <div style={{ fontSize: 13 }}><b style={{ opacity: 0.6 }}>Seu pedido:</b> {s.mensagem}</div>

        {Array.isArray(s.anexos) && s.anexos.length > 0 && (
          <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <b style={{ opacity: 0.6 }}>Anexos:</b>
            {s.anexos.map((a) => (
              <button key={a.id} type="button" onClick={() => baixarAnexo(s.id, a.id, a.nome)} title={`Baixar ${a.nome}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)', borderRadius: 7, padding: '3px 8px', cursor: 'pointer' }}>
                <Paperclip size={12} /> {a.nome}
              </button>
            ))}
            <div style={{ flexBasis: '100%', fontSize: 10.5, opacity: 0.6, lineHeight: 1.4 }}>{AVISO_ARQUIVO_20D}</div>
          </div>
        )}

        {s.status === 'preciso_confirmar' && s.perguntas && Array.isArray(s.perguntas.perguntas) && (
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#c084fc' }}>❓ Para eu terminar, me confirme:</div>
            {s.perguntas.perguntas.map((p, i) => {
              const key = `${s.id}:${i}`;
              const val = respConf[key] || '';
              const opcoes = Array.isArray(p.opcoes) ? p.opcoes : [];
              return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{p.texto}</div>
                  {opcoes.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {opcoes.map((op, oi) => {
                        const sel = val === op;
                        return (
                          <button key={oi} type="button" onClick={() => setRespConf((m) => ({ ...m, [key]: op }))}
                            style={{
                              fontSize: 12, fontWeight: 600, padding: '7px 12px', borderRadius: 999, cursor: 'pointer',
                              border: `1px solid ${sel ? '#a855f7' : 'rgba(255,255,255,0.18)'}`,
                              background: sel ? 'rgba(168,85,247,0.22)' : 'rgba(255,255,255,0.05)',
                              color: sel ? '#e9d5ff' : 'rgba(255,255,255,0.85)',
                            }}>
                            {sel ? '● ' : ''}{op}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {(p.permite_texto || opcoes.length === 0) && (
                    <input type="text" value={opcoes.includes(val) ? '' : val}
                      onChange={(e) => setRespConf((m) => ({ ...m, [key]: e.target.value }))}
                      placeholder={opcoes.length > 0 ? 'ou escreva outra resposta…' : 'escreva sua resposta…'}
                      style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '7px 10px', fontSize: 12.5, color: '#eaf2fb', outline: 'none' }} />
                  )}
                </div>
              );
            })}
            <div>
              <button type="button" disabled={tabBusy === s.id} onClick={() => responderConf(s)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, padding: '8px 14px', borderRadius: 8, cursor: 'pointer', border: '1px solid #a855f7', background: 'rgba(168,85,247,0.2)', color: '#e9d5ff' }}>
                Enviar resposta
              </button>
            </div>
          </div>
        )}

        {!pronto && s.status !== 'preciso_confirmar' && (
          <div style={{ fontSize: 12.5, opacity: 0.7, padding: '14px 0', textAlign: 'center' }}>
            ⏳ {s.status === 'pendente' ? 'Aguardando o gestor aprovar.' : s.status === 'aprovado' ? 'Aprovado — será executado em instantes.' : 'Em andamento…'}
          </div>
        )}

        {pronto && (
          <div style={{ fontSize: 12.5, borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 10 }}>
            {tab && tab.titulo && <div style={{ fontWeight: 700, marginBottom: 8 }}>{tab.titulo}</div>}
            {temTabela ? (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 11.5, width: '100%' }}>
                  <thead><tr>{tab.header.map((h, i) => <th key={i} style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid rgba(255,255,255,0.2)', color: 'var(--accent)', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
                  <tbody>{tab.rows.slice(0, 200).map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} style={{ padding: '3px 8px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{c}</td>)}</tr>)}</tbody>
                </table>
                {tab.rows.length > 200 && <div style={{ opacity: 0.5, marginTop: 6 }}>… e mais {tab.rows.length - 200} linhas (baixe o Excel para ver tudo)</div>}
              </div>
            ) : (
              <div style={{ whiteSpace: 'pre-wrap' }}>{s.resultado}</div>
            )}
          </div>
        )}

        {Array.isArray(s.conversa) && s.conversa.length > 0 && (
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.6 }}>Conversa / correções</div>
            {s.conversa.map((m, i) => (
              <div key={i} style={{ fontSize: 12, background: 'color-mix(in srgb, var(--accent) 10%, transparent)', borderRadius: 8, padding: '6px 9px' }}>
                <span style={{ opacity: 0.6, fontSize: 10.5 }}>{m.autor || 'você'} · {m.em}</span>
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.texto}</div>
              </div>
            ))}
          </div>
        )}

        {pronto && corrigindo !== s.id && (
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11.5, opacity: 0.6 }}>Baixar:</span>
            {temTabela && <button type="button" onClick={() => baixar(s.id, 'excel', 'xlsx')} style={btnFmt('#22c55e')}>Excel</button>}
            <button type="button" onClick={() => baixar(s.id, 'pdf', 'pdf')} style={btnFmt('#ef4444')}>PDF</button>
            <button type="button" onClick={() => baixar(s.id, 'word', 'doc')} style={btnFmt('#5b9cff')}>Word</button>
            <button type="button" onClick={() => baixar(s.id, 'txt', 'txt')} style={btnFmt('#cbd5e1')}>TXT</button>
            <div style={{ flexBasis: '100%', fontSize: 10.5, opacity: 0.6, lineHeight: 1.4, marginTop: 2 }}>{AVISO_ARQUIVO_20D}</div>
          </div>
        )}

        {pronto && corrigindo !== s.id && (
          <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            <button type="button" disabled={tabBusy === s.id} onClick={() => darFeedback(s.id, 'aprovado')} style={btn('rgba(34,197,94,0.14)', '#22c55e')}>👍 Aprovar</button>
            <button type="button" disabled={tabBusy === s.id} onClick={() => { setCorrigindo(s.id); setTxtCorrecao(''); }} style={btn('rgba(239,68,68,0.14)', '#ef4444')}>👎 Rejeitar e corrigir</button>
          </div>
        )}

        {corrigindo === s.id && (
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>O que está errado / o que devemos corrigir?</div>
            <textarea value={txtCorrecao} onChange={(e) => setTxtCorrecao(e.target.value)} rows={3}
              placeholder="Ex.: não era essa fatura — eu pedi a de abril/2026 do medidor X…"
              style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, color: '#eaf2fb', outline: 'none', resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" disabled={tabBusy === s.id || !txtCorrecao.trim()} onClick={() => enviarCorrecao(s.id)} style={btn('rgba(59,130,246,0.16)', '#5b9cff')}>Enviar correção</button>
              <button type="button" onClick={() => { setCorrigindo(null); setTxtCorrecao(''); }} style={btn('rgba(255,255,255,0.08)', 'rgba(255,255,255,0.7)')}>Cancelar</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Item de conversa (usado na barra lateral e no painel) ──────────────────
  function renderConvItem(cv) {
    const atual = cv.sessao === sessaoRef.current;
    const nome = cv.titulo || cv.primeira || '(sem pergunta)';
    if (renomeando === cv.sessao) {
      return (
        <div key={cv.sessao} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 6px' }}>
          <input autoFocus value={tituloEdit} onChange={(e) => setTituloEdit(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') salvarTitulo(cv.sessao); if (e.key === 'Escape') setRenomeando(null); }}
            style={{ flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.08)', border: '1px solid var(--accent)', borderRadius: 7, padding: '6px 8px', fontSize: 12.5, color: '#eaf2fb', outline: 'none' }} />
          <button type="button" onClick={() => salvarTitulo(cv.sessao)} title="Salvar" style={{ background: 'none', border: 'none', color: '#22c55e', cursor: 'pointer', fontSize: 15 }}>✓</button>
          <button type="button" onClick={() => setRenomeando(null)} title="Cancelar" style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 15 }}>×</button>
        </div>
      );
    }
    return (
      <div key={cv.sessao}
        style={{ display: 'flex', alignItems: 'stretch', gap: 2, border: '1px solid var(--panel-border, rgba(255,255,255,0.12))', background: atual ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent', borderRadius: 10, overflow: 'hidden' }}>
        <button type="button" onClick={() => retomarConversa(cv.sessao)} title={nome}
          style={{ flex: 1, minWidth: 0, textAlign: 'left', cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit', padding: '8px 10px' }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nome}</div>
          <div style={{ fontSize: 11, opacity: 0.55, marginTop: 2 }}>{cv.fim || cv.inicio} · {cv.qtd} msg{atual ? ' · atual' : ''}</div>
        </button>
        <button type="button" title="Renomear" onClick={(e) => { e.stopPropagation(); setRenomeando(cv.sessao); setTituloEdit(cv.titulo || cv.primeira || ''); }}
          style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 38, cursor: 'pointer', border: 'none', background: '#2563eb', color: '#ffffff' }}>
          <Pencil size={15} strokeWidth={2.5} />
        </button>
        <button type="button" title="Excluir" onClick={(e) => excluirConversa(cv.sessao, e)}
          style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 38, cursor: 'pointer', border: 'none', background: '#dc2626', color: '#ffffff' }}>
          <Trash2 size={15} strokeWidth={2.5} />
        </button>
      </div>
    );
  }

  // ── Barra lateral de conversas (janela ampliada, estilo Claude web) ────────
  function renderSidebar() {
    return (
      <div style={{ width: 256, flexShrink: 0, borderRight: '1px solid rgba(255,255,255,0.09)', background: 'rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 10 }}>
          <button type="button" onClick={novaConversa}
            style={{ width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer', border: '1px solid color-mix(in srgb, var(--accent) 45%, transparent)', background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)', borderRadius: 10, padding: '9px 12px', fontSize: 13, fontWeight: 700 }}>
            <Plus size={15} /> Nova conversa
          </button>
        </div>
        <div style={{ padding: '0 8px 4px', fontSize: 10.5, letterSpacing: '0.05em', textTransform: 'uppercase', opacity: 0.45 }}>Conversas</div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 10px', display: 'grid', gap: 6, alignContent: 'start' }}>
          {conversas === null && <div style={{ padding: 10, opacity: 0.6, fontSize: 12 }}>Carregando…</div>}
          {conversas?.length === 0 && <div style={{ padding: 10, opacity: 0.6, fontSize: 12 }}>Nenhuma conversa ainda.</div>}
          {(conversas || []).map((cv) => renderConvItem(cv))}
        </div>
      </div>
    );
  }

  const sidebarOn = expanded && !minimized && !showInfo;

  // ── FAB (botão flutuante) ─────────────────────────────────────────────────
  const hiddenRoutes = ['/caixa-de-email'];
  if (hiddenRoutes.some((r) => pathname.startsWith(r))) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="SURE — Assistente de processos"
        style={{
          position: 'fixed',
          bottom: '72px',
          right: '16px',
          zIndex: 200,
          width: 52,
          height: 52,
          borderRadius: '50%',
          border: '2px solid color-mix(in srgb, var(--accent) 50%, transparent)',
          background: 'linear-gradient(135deg, #1e3a8a 0%, #1e3a5f 50%, #0d1b2a 100%)',
          color: '#fff',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: pulse
            ? '0 0 0 6px color-mix(in srgb, var(--accent) 30%, transparent), 0 4px 20px color-mix(in srgb, var(--accent) 40%, transparent)'
            : '0 4px 20px rgba(0,0,0,0.5), 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent)',
          transition: 'box-shadow 0.3s ease, transform 0.2s ease',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.08)')}
        onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
      >
        {pulse ? (
          <Sparkles size={22} color="var(--accent)" strokeWidth={2} />
        ) : (
          <Bot size={22} color="#ffffff" strokeWidth={2} />
        )}
        {solicNotif > 0 ? (
          <span
            title={`${solicNotif} pedido(s) pronto(s)`}
            style={{
              position: 'absolute',
              top: -4,
              right: -4,
              minWidth: 20,
              height: 20,
              padding: '0 5px',
              borderRadius: 10,
              background: '#ef4444',
              color: '#fff',
              fontSize: 11,
              fontWeight: 800,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '2px solid #0d1b2a',
              boxShadow: '0 0 0 3px rgba(239,68,68,0.3)',
            }}
          >
            {solicNotif}
          </span>
        ) : messages.length > 0 ? (
          <span
            style={{
              position: 'absolute',
              top: 3,
              right: 3,
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: 'var(--accent)',
              border: '2px solid #0d1b2a',
            }}
          />
        ) : null}
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
        width: minimized ? 320 : expanded ? 'min(1180px, calc(100vw - 32px))' : 'min(820px, calc(100vw - 32px))',
        height: minimized ? 'auto' : expanded ? 'calc(100vh - 64px)' : 'min(820px, calc(100vh - 96px))',
        maxHeight: minimized ? 52 : expanded ? 'calc(100vh - 64px)' : 'calc(100vh - 96px)',
        background: '#0d1b2a', /* widget sempre escuro (texto é branco) — não seguir tema claro */
        color: '#e6edf3',
        border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)',
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
          borderBottom: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)',
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
            background: 'color-mix(in srgb, var(--accent) 25%, transparent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Bot size={16} style={{ color: 'var(--accent)' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', lineHeight: 1.2 }}>
            SURE
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
              title="O que a SURE pode fazer?"
              style={{
                background: showInfo ? 'color-mix(in srgb, var(--accent) 25%, transparent)' : 'transparent',
                border: 'none',
                color: showInfo ? 'var(--accent)' : 'rgba(255,255,255,0.85)',
                cursor: 'pointer',
                padding: 4,
                borderRadius: 6,
                display: 'flex',
              }}
            >
              <Info size={14} />
            </button>
          )}
          {!minimized && (
            <button
              type="button"
              onClick={() => setActiveTab((t) => (t === 'historico' ? 'conversa' : 'historico'))}
              title="Histórico de pedidos"
              style={{
                position: 'relative',
                background: activeTab === 'historico' ? 'color-mix(in srgb, var(--accent) 25%, transparent)' : 'transparent',
                border: 'none',
                color: activeTab === 'historico' ? 'var(--accent)' : 'rgba(255,255,255,0.85)',
                cursor: 'pointer', padding: 4, borderRadius: 6, display: 'flex',
              }}
            >
              <History size={14} />
              {/* contador = só pedidos que AINDA esperam o aceite (aceitos não contam) */}
              {abertos.length > 0 && (
                <span style={{ position: 'absolute', top: -2, right: -2, minWidth: 14, height: 14, padding: '0 3px', borderRadius: 7, background: 'var(--accent)', color: '#06212a', fontSize: 9, fontWeight: 800, lineHeight: '14px', textAlign: 'center' }}>
                  {abertos.length > 99 ? '99+' : abertos.length}
                </span>
              )}
            </button>
          )}
          {!minimized && (
            <button
              type="button"
              onClick={abrirConversas}
              title="Histórico de conversas — nova, retomar ou excluir"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', padding: '4px 7px', borderRadius: 6, fontSize: 11, letterSpacing: '0.03em' }}
            >
              <MessageSquare size={13} /> conversas
            </button>
          )}
          {messages.length > 0 && !minimized && activeTab === 'conversa' && (
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
                background: 'rgba(255,255,255,0.95)',
                border: '1px solid rgba(255,255,255,0.95)',
                color: '#1e293b',
                cursor: 'pointer',
                padding: 5,
                borderRadius: 7,
                display: 'flex',
                boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
              }}
            >
              {expanded ? <Minimize2 size={15} strokeWidth={2.75} /> : <Maximize2 size={15} strokeWidth={2.75} />}
            </button>
          )}
          <button
            type="button"
            onClick={() => setMinimized((v) => !v)}
            title={minimized ? 'Expandir' : 'Minimizar'}
            style={{
              background: 'rgba(255,255,255,0.95)',
              border: '1px solid rgba(255,255,255,0.95)',
              color: '#1e293b',
              cursor: 'pointer',
              padding: 5,
              borderRadius: 7,
              display: 'flex',
              boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
            }}
          >
            <ChevronDown
              size={16}
              strokeWidth={2.75}
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
              background: 'rgba(255,255,255,0.95)',
              border: '1px solid rgba(255,255,255,0.95)',
              color: '#1e293b',
              cursor: 'pointer',
              padding: 5,
              borderRadius: 7,
              display: 'flex',
              boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
            }}
          >
            <X size={16} strokeWidth={2.75} />
          </button>
        </div>
      </div>

      {/* ── Conteúdo: barra lateral de conversas (ampliado) + coluna principal ── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {sidebarOn && renderSidebar()}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' }}>

      {/* ── Painel de informações ──────────────────────────────────────────── */}
      {showInfo && !minimized && (
        <div style={{
          padding: '14px 16px',
          background: 'color-mix(in srgb, var(--accent) 7%, transparent)',
          borderBottom: '1px solid color-mix(in srgb, var(--accent) 18%, transparent)',
          overflowY: 'auto',
          maxHeight: 320,
        }}>
          <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 700, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Bot size={13} /> O que a SURE pode fazer?
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
              emoji: '🔁', titulo: 'Rotinas e lembretes',
              itens: ['#rotina — cria uma tarefa automática (ex.: vincular e-mails aos processos às 14h e 18h); começa após aprovação do administrador', '#rotinas — lista as suas; para excluir, abra Rotinas no menu e use o botão ⛔', '"lembrete para a Luana amanhã às 10h sobre o processo 18228" — vai para o calendário e por e-mail'],
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

          <div style={{ marginTop: 10, padding: '8px 10px', background: 'color-mix(in srgb, var(--accent) 12%, transparent)', borderRadius: 8, border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)' }}>
            <p style={{ margin: 0, fontSize: 10.5, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
              💡 <strong style={{ color: 'rgba(255,255,255,0.6)' }}>Dica:</strong> pergunte de forma natural.
              Ex: <em>"Qual cliente tem mais processos?"</em>, <em>"Mostre os alertas de hoje"</em> ou <em>"Como está a carteira?"</em>
            </p>
          </div>
        </div>
      )}

      {/* ── Barra de abas (Meus pedidos, estilo Chrome) ──────────────────── */}
      {!minimized && activeTab !== 'historico' && renderAbas()}

      {/* ── Histórico de pedidos (todos, inclusive concluídos) ───────────── */}
      {!minimized && activeTab === 'historico' && renderHistorico()}

      {/* ── Detalhe de um pedido (aba selecionada) ───────────────────────── */}
      {!minimized && typeof activeTab === 'number' && renderDetalhePedido()}

      {/* ── Corpo / Conversa (hidden when minimized) ───────────────────────── */}
      {!minimized && activeTab === 'conversa' && (
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
              scrollbarColor: 'color-mix(in srgb, var(--accent) 30%, transparent) transparent',
            }}
          >
            {/* Estado vazio */}
            {messages.length === 0 && !loading && (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <Zap size={28} style={{ color: 'color-mix(in srgb, var(--accent) 50%, transparent)', margin: '0 auto 8px' }} />
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
                        background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)',
                        borderRadius: 20,
                        padding: '4px 10px',
                        fontSize: 11,
                        color: 'var(--accent)',
                        cursor: 'pointer',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'color-mix(in srgb, var(--accent) 22%, transparent)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'color-mix(in srgb, var(--accent) 12%, transparent)')}
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
                        ? 'color-mix(in srgb, var(--danger) 20%, transparent)'
                        : 'color-mix(in srgb, var(--accent) 20%, transparent)',
                    border:
                      msg.role === 'user'
                        ? '1px solid rgba(30,58,95,0.8)'
                        : '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
                    marginTop: 2,
                  }}
                >
                  {msg.role === 'user' ? (
                    <MessageSquare size={12} style={{ color: 'var(--accent)' }} />
                  ) : msg.role === 'error' ? (
                    <X size={12} style={{ color: 'var(--danger)' }} />
                  ) : (
                    <Bot size={12} style={{ color: 'var(--accent)' }} />
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
                          ? 'color-mix(in srgb, var(--danger) 12%, transparent)'
                          : 'rgba(255,255,255,0.05)',
                      border:
                        msg.role === 'user'
                          ? '1px solid rgba(30,58,95,0.8)'
                          : msg.role === 'error'
                          ? '1px solid color-mix(in srgb, var(--danger) 30%, transparent)'
                          : '1px solid rgba(255,255,255,0.08)',
                      color:
                        msg.role === 'error' ? 'var(--danger)' : 'rgba(255,255,255,0.88)',
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
                    background: 'color-mix(in srgb, var(--accent) 20%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                >
                  <Bot size={12} style={{ color: 'var(--accent)' }} />
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
                  <Loader2 size={13} style={{ color: 'var(--accent)', animation: 'spin 1s linear infinite', alignSelf: progresso ? 'flex-start' : 'center', marginTop: progresso ? 2 : 0 }} />
                  {progresso ? <ProgressoPedido prog={progresso} /> : (
                    <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
                      Consultando dados...
                    </span>
                  )}
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
                    background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)',
                    borderRadius: 20,
                    padding: '3px 9px',
                    fontSize: 10.5,
                    color: 'var(--accent)',
                    cursor: 'pointer',
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {/* Chip do arquivo que será anexado ao próximo pedido #sistema */}
          {anexoPendente && (
            <div style={{ padding: '7px 12px 0', fontSize: 11.5 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: '90%', background: 'color-mix(in srgb, var(--accent) 14%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)', color: 'var(--accent)', borderRadius: 7, padding: '3px 8px' }}>
                {anexoPendente.type?.startsWith('image/')
                  ? <img src={URL.createObjectURL(anexoPendente)} alt="print" style={{ width: 22, height: 22, borderRadius: 4, objectFit: 'cover' }} />
                  : <Paperclip size={12} />}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{anexoPendente.name}</span>
                <button type="button" onClick={() => setAnexoPendente(null)} title="Remover anexo" style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, display: 'flex' }}><X size={12} /></button>
              </span>
            </div>
          )}
          <input ref={fileInputRef} type="file" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) setAnexoPendente(f); e.target.value = ''; }} />

          {/* ── Dica: rotinas (só equipe interna; fecha e não volta) ───────────── */}
          {!dicaRotinasOk && String(user?.tipo_conta || '').toLowerCase() !== 'solicitante' && (
            <div style={{
              margin: '6px 12px 0', padding: '8px 10px', borderRadius: 8, fontSize: 11, lineHeight: 1.5,
              background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)',
              color: 'rgba(255,255,255,0.75)', display: 'flex', gap: 8, alignItems: 'flex-start',
            }}>
              <span>🔁</span>
              <div style={{ flex: 1 }}>
                <strong style={{ color: 'var(--accent)' }}>Dica: crie rotinas automáticas.</strong>{' '}
                Digite <code>#rotina</code> e diga o que o sistema deve fazer e quando
                (ex.: <em>“vincular os e-mails do dia anterior aos processos às 14h e às 18h”</em> ou
                <em> “lembrete para a Luana toda segunda às 9h”</em>). A rotina começa depois da aprovação do administrador.
                Para ver ou excluir as suas, digite <code>#rotinas</code> ou abra <a href="/rotinas" style={{ color: 'var(--accent)' }}>Rotinas</a> no menu.
                <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => sendMessage('#rotina')}
                    style={{ background: 'color-mix(in srgb, var(--accent) 18%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', borderRadius: 14, padding: '2px 9px', fontSize: 10.5, color: 'var(--accent)', cursor: 'pointer' }}>
                    Criar uma rotina
                  </button>
                  <button type="button" onClick={() => sendMessage('#rotinas')}
                    style={{ background: 'transparent', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', borderRadius: 14, padding: '2px 9px', fontSize: 10.5, color: 'var(--accent)', cursor: 'pointer' }}>
                    Ver minhas rotinas
                  </button>
                </div>
              </div>
              <button type="button" onClick={fecharDicaRotinas} title="Entendi — não mostrar de novo"
                style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', padding: 0, display: 'flex' }}>
                <X size={13} />
              </button>
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
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Anexar arquivo ao pedido #sistema (ou cole um print com Ctrl+V)"
              style={{
                width: 34, height: 34, borderRadius: 10, flexShrink: 0, border: 'none',
                background: anexoPendente ? 'var(--gradient-primary)' : 'var(--accent)',
                color: '#fff',
                boxShadow: anexoPendente ? '0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent)' : 'none',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.15s',
              }}
            >
              <Paperclip size={15} />
            </button>
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
              onPaste={(e) => {
                const items = e.clipboardData?.items || [];
                for (const it of items) {
                  if (it.kind === 'file' && it.type.startsWith('image/')) {
                    const blob = it.getAsFile();
                    if (blob) {
                      e.preventDefault();
                      const ext = (it.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
                      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
                      const file = new File([blob], `print-${ts}.${ext}`, { type: it.type });
                      setAnexoPendente(file);
                    }
                    return;
                  }
                }
              }}
              placeholder={listening ? '🔴 Ouvindo… pode falar' : convMode ? (convOuvindo ? '🎙️ Modo conversa — pode falar…' : '🎙️ Modo conversa — a SURE está respondendo…') : 'Pergunte, ou cole um print (Ctrl+V)…'}
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
              onFocus={(e) => (e.target.style.borderColor = 'color-mix(in srgb, var(--accent) 50%, transparent)')}
              onBlur={(e) => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')}
            />
            <button
              type="button"
              onClick={() => (voiceSupported ? setConvMode((v) => !v) : pushMsg('error', '🎙️ Modo conversa precisa do Chrome ou Edge, em HTTPS, com microfone permitido.'))}
              title={convMode ? 'Modo conversa LIGADO — fale normalmente; ela responde e volta a ouvir. Diga "encerrar conversa" ou clique para desligar' : 'Modo conversa: fale sem clicar — ela responde em voz e volta a ouvir'}
              className={convMode ? 'sure-mic-live' : undefined}
              style={{
                width: 34, height: 34, borderRadius: 10, flexShrink: 0, border: 'none',
                background: convMode ? '#ef4444' : 'var(--accent)',
                color: '#fff',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: convMode ? '0 0 0 4px rgba(239,68,68,0.3)' : 'none',
                transition: 'all 0.15s',
              }}
            >
              <AudioLines size={15} />
            </button>
            <button
              type="button"
              onClick={() => setVoiceOn((v) => !v)}
              title={voiceOn ? 'SURE falando: ligado (clique p/ desligar)' : 'SURE responder por voz'}
              style={{
                width: 34, height: 34, borderRadius: 10, flexShrink: 0, border: 'none',
                background: voiceOn ? 'var(--gradient-primary)' : 'var(--accent)',
                color: '#fff',
                boxShadow: voiceOn ? '0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent)' : 'none',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.15s',
              }}
            >
              {voiceOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
            </button>
            {!convMode && (
              <button
                type="button"
                onClick={() => (listening ? stopListening() : startListening())}
                title={listening ? 'Ouvindo… (clique p/ parar)' : 'Falar (ditado por voz)'}
                className={listening ? 'sure-mic-live' : undefined}
                style={{
                  width: 34, height: 34, borderRadius: 10, flexShrink: 0, border: 'none',
                  background: listening ? '#ef4444' : 'var(--accent)',
                  color: '#fff',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: listening ? '0 0 0 4px rgba(239,68,68,0.3)' : 'none',
                  transition: 'all 0.15s',
                }}
              >
                <Mic size={15} />
              </button>
            )}
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
                    ? 'var(--gradient-primary)'
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
      {conversasAbertas && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setConversasAbertas(false); }}
          style={{ position: 'fixed', inset: 0, zIndex: 1250, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ width: 'min(560px, 100%)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', background: 'var(--card, #0f1722)', color: 'var(--fg, #e6edf3)', border: '1px solid var(--panel-border, rgba(255,255,255,0.14))', borderRadius: 16, boxShadow: 'var(--shadow-elevated)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--panel-border, rgba(255,255,255,0.1))' }}>
              <b style={{ flex: 1, fontSize: 15 }}>Histórico de conversas</b>
              <span style={{ fontSize: 11.5, opacity: 0.6 }}>guardadas por {convDias} dias</span>
              <button type="button" onClick={() => setConversasAbertas(false)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 18 }}>×</button>
            </div>
            <div style={{ padding: '10px 10px 0' }}>
              <button type="button" onClick={novaConversa}
                style={{ width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer', border: '1px solid color-mix(in srgb, var(--accent) 45%, transparent)', background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)', borderRadius: 10, padding: '10px 12px', fontSize: 13.5, fontWeight: 700 }}>
                <Plus size={16} /> Nova conversa
              </button>
            </div>
            <div style={{ overflowY: 'auto', padding: 10, display: 'grid', gap: 8 }}>
              {conversas === null && <div style={{ padding: 16, opacity: 0.7, fontSize: 13 }}>Carregando…</div>}
              {conversas?.length === 0 && <div style={{ padding: 16, opacity: 0.7, fontSize: 13 }}>Nenhuma conversa ainda. Comece uma nova acima.</div>}
              {(conversas || []).map((cv) => renderConvItem(cv))}
            </div>
          </div>
        </div>
      )}
      {cobrancaLote && <CobrancaLoteModal dados={cobrancaLote} onClose={() => setCobrancaLote(null)} />}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .sure-mic-live { animation: sureMicBlink 1.1s ease-in-out infinite; }
        @keyframes sureMicBlink {
          0%, 100% { box-shadow: 0 0 0 4px rgba(239,68,68,0.38); filter: brightness(1); }
          50%      { box-shadow: 0 0 0 9px rgba(239,68,68,0.10); filter: brightness(1.3); }
        }
      `}</style>
        </div>{/* fim coluna principal */}
      </div>{/* fim linha conteúdo (sidebar + principal) */}
    </div>
  );
}
