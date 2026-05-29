import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { FilePlus, FileText, Clock, CheckCircle2, AlertCircle, ArrowRight, ListChecks, Search } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { getMinhasRequisicoes } from '../services/requisicaoService';

const normStatus = (s) => String(s || '').trim().toLowerCase();

const STATUS_STYLE = {
  'nova requisição':         { Icon: Clock,         color: 'text-amber-400',  bg: 'bg-amber-500/10',   border: 'border-amber-500/30' },
  'pendente':                { Icon: Clock,         color: 'text-amber-400',  bg: 'bg-amber-500/10',   border: 'border-amber-500/30' },
  'em análise':              { Icon: Clock,         color: 'text-blue-400',   bg: 'bg-blue-500/10',    border: 'border-blue-500/30' },
  'em andamento':            { Icon: Clock,         color: 'text-blue-400',   bg: 'bg-blue-500/10',    border: 'border-blue-500/30' },
  'aprovado':                { Icon: CheckCircle2,  color: 'text-green-400',  bg: 'bg-green-500/10',   border: 'border-green-500/30' },
  'aprovada':                { Icon: CheckCircle2,  color: 'text-green-400',  bg: 'bg-green-500/10',   border: 'border-green-500/30' },
  'concluído':               { Icon: CheckCircle2,  color: 'text-green-400',  bg: 'bg-green-500/10',   border: 'border-green-500/30' },
  'rejeitado':               { Icon: AlertCircle,   color: 'text-red-400',    bg: 'bg-red-500/10',     border: 'border-red-500/30' },
  'rejeitada':               { Icon: AlertCircle,   color: 'text-red-400',    bg: 'bg-red-500/10',     border: 'border-red-500/30' },
};

const getStatusStyle = (status) => STATUS_STYLE[normStatus(status)] || {
  Icon: FileText, color: 'text-[var(--fg)]', bg: 'bg-[var(--panel)]', border: 'border-[var(--border)]'
};

const fmtData = (d) => {
  if (!d) return '—';
  try {
    const dt = typeof d === 'string' ? new Date(d) : d;
    if (isNaN(dt.getTime())) return String(d).slice(0, 10);
    return dt.toLocaleDateString('pt-BR');
  } catch { return String(d).slice(0, 10); }
};

const fmtValor = (v) => {
  if (v == null || v === '') return '—';
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d,.-]/g, '').replace(',', '.'));
  if (!isFinite(n)) return String(v);
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

const ChatRequisicao = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [requisicoes, setRequisicoes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filtroStatus, setFiltroStatus] = useState('todos');
  const [busca, setBusca] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getMinhasRequisicoes(true)
      .then((rows) => { if (alive) setRequisicoes(rows || []); })
      .catch(() => { if (alive) setRequisicoes([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const stats = useMemo(() => {
    const total = requisicoes.length;
    const counts = { pendente: 0, andamento: 0, aprovado: 0, rejeitado: 0 };
    for (const r of requisicoes) {
      const s = normStatus(r?.status);
      if (s.includes('nova') || s === 'pendente') counts.pendente++;
      else if (s.includes('andamento') || s.includes('análise') || s.includes('analise')) counts.andamento++;
      else if (s.includes('aprov') || s.includes('conclu')) counts.aprovado++;
      else if (s.includes('rejeit')) counts.rejeitado++;
    }
    return { total, ...counts };
  }, [requisicoes]);

  const requisicoesFiltradas = useMemo(() => {
    let rows = requisicoes;
    if (filtroStatus !== 'todos') {
      rows = rows.filter((r) => {
        const s = normStatus(r?.status);
        if (filtroStatus === 'pendente') return s.includes('nova') || s === 'pendente';
        if (filtroStatus === 'andamento') return s.includes('andamento') || s.includes('análise') || s.includes('analise');
        if (filtroStatus === 'aprovado') return s.includes('aprov') || s.includes('conclu');
        if (filtroStatus === 'rejeitado') return s.includes('rejeit');
        return true;
      });
    }
    const q = busca.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) => {
        const uc = String(r?.uc || '').toLowerCase();
        const cliente = String(r?.cliente || '').toLowerCase();
        const id = String(r?.id || r?.id_requisicao || '').toLowerCase();
        return uc.includes(q) || cliente.includes(q) || id.includes(q);
      });
    }
    return rows;
  }, [requisicoes, filtroStatus, busca]);

  const firstName = String(user?.nome || '').split(' ')[0] || 'Solicitante';

  return (
    <div className="max-w-6xl mx-auto p-6 text-[var(--fg)] space-y-6">
      {/* Hero — boas-vindas + CTA */}
      <div className="glass-card border border-[var(--border)] rounded-xl p-6 bg-gradient-to-br from-[var(--panel)] to-[var(--bg)]">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold mb-1">Olá, {firstName}! 👋</h1>
            <p className="text-sm opacity-70">Acompanhe suas requisições ou abra uma nova abaixo.</p>
          </div>
          <button
            onClick={() => navigate('/novo')}
            className="inline-flex items-center gap-2 px-6 py-3 bg-[var(--accent)] text-white rounded-lg font-semibold hover:opacity-90 transition shadow-lg shadow-[var(--accent)]/20"
          >
            <FilePlus size={20} />
            Nova Requisição
          </button>
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Total"
          value={stats.total}
          Icon={ListChecks}
          color="text-[var(--fg)]"
          onClick={() => setFiltroStatus('todos')}
          active={filtroStatus === 'todos'}
        />
        <StatCard
          label="Em aberto"
          value={stats.pendente}
          Icon={Clock}
          color="text-amber-400"
          onClick={() => setFiltroStatus('pendente')}
          active={filtroStatus === 'pendente'}
        />
        <StatCard
          label="Em andamento"
          value={stats.andamento}
          Icon={Clock}
          color="text-blue-400"
          onClick={() => setFiltroStatus('andamento')}
          active={filtroStatus === 'andamento'}
        />
        <StatCard
          label="Aprovadas"
          value={stats.aprovado}
          Icon={CheckCircle2}
          color="text-green-400"
          onClick={() => setFiltroStatus('aprovado')}
          active={filtroStatus === 'aprovado'}
        />
      </div>

      {/* Lista de requisições do usuário */}
      <div className="glass-card border border-[var(--border)] rounded-xl overflow-hidden">
        <div className="p-4 border-b border-[var(--border)] flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-lg font-semibold">
            {filtroStatus === 'todos' ? 'Minhas requisições' : `Requisições — ${filtroStatus}`}
          </h2>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-60" />
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar por UC, cliente ou ID..."
              className="pl-9 pr-3 py-2 text-sm bg-[var(--panel)] border border-[var(--border)] rounded-lg text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] min-w-[280px]"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-10 text-center opacity-60">
            <Clock className="inline-block animate-spin mr-2" size={16} />
            Carregando suas requisições...
          </div>
        ) : requisicoesFiltradas.length === 0 ? (
          <EmptyState filtroStatus={filtroStatus} busca={busca} onCriar={() => navigate('/novo')} />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {requisicoesFiltradas.map((r) => (
              <RequisicaoRow key={r.id || r.id_requisicao || Math.random()} requisicao={r} onClick={() => navigate('/novo')} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

const StatCard = ({ label, value, Icon, color, onClick, active }) => (
  <button
    onClick={onClick}
    className={`glass-card border rounded-xl p-4 text-left transition hover:scale-[1.02] ${
      active ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/30' : 'border-[var(--border)]'
    }`}
  >
    <div className="flex items-center justify-between mb-2">
      <Icon size={20} className={color} />
      <span className={`text-2xl font-bold ${color}`}>{value}</span>
    </div>
    <div className="text-xs opacity-70">{label}</div>
  </button>
);

const RequisicaoRow = ({ requisicao, onClick }) => {
  const id = requisicao?.id || requisicao?.id_requisicao || '—';
  const uc = requisicao?.uc || requisicao?.UC || '—';
  const cliente = requisicao?.cliente || requisicao?.razao_social || '—';
  const valor = requisicao?.valor_estimado || requisicao?.ressarcimento_estimado || requisicao?.valor;
  const data = requisicao?.criado_em || requisicao?.created_at || requisicao?.data_criacao;
  const status = requisicao?.status || 'Nova Requisição';
  const { Icon, color, bg, border } = getStatusStyle(status);

  return (
    <li
      className="px-4 py-3 hover:bg-[var(--panel)] cursor-pointer transition flex items-center gap-4"
      onClick={onClick}
    >
      <div className={`shrink-0 w-10 h-10 rounded-lg ${bg} ${border} border flex items-center justify-center`}>
        <Icon size={18} className={color} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="font-semibold">#{id}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full ${bg} ${color} ${border} border`}>
            {status}
          </span>
        </div>
        <div className="text-sm opacity-80 truncate mt-0.5">
          UC <span className="font-mono">{uc}</span> — {cliente}
        </div>
      </div>
      <div className="hidden md:flex flex-col items-end gap-1 shrink-0">
        <div className="text-sm font-semibold">{fmtValor(valor)}</div>
        <div className="text-xs opacity-60">{fmtData(data)}</div>
      </div>
      <ArrowRight size={16} className="opacity-40 shrink-0" />
    </li>
  );
};

const EmptyState = ({ filtroStatus, busca, onCriar }) => {
  const isBusca = !!busca;
  const isFiltro = filtroStatus !== 'todos';
  return (
    <div className="p-10 text-center">
      <FileText size={48} className="mx-auto opacity-30 mb-4" />
      {isBusca ? (
        <>
          <h3 className="text-lg font-semibold mb-2">Nenhum resultado</h3>
          <p className="text-sm opacity-70">Nenhuma requisição encontrada para "{busca}".</p>
        </>
      ) : isFiltro ? (
        <>
          <h3 className="text-lg font-semibold mb-2">Sem requisições neste status</h3>
          <p className="text-sm opacity-70 mb-4">Você não tem requisições com este status.</p>
        </>
      ) : (
        <>
          <h3 className="text-lg font-semibold mb-2">Você ainda não tem requisições</h3>
          <p className="text-sm opacity-70 mb-4">Clique abaixo pra criar a sua primeira requisição de ressarcimento.</p>
          <button
            onClick={onCriar}
            className="inline-flex items-center gap-2 px-6 py-3 bg-[var(--accent)] text-white rounded-lg font-semibold hover:opacity-90"
          >
            <FilePlus size={18} />
            Criar primeira requisição
          </button>
        </>
      )}
    </div>
  );
};

export default ChatRequisicao;
