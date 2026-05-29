// src/pages/Home.jsx
//
// Tela inicial informativa do SURE. Usada quando o usuário acessa "/" e
// quando é redirecionado de páginas que não tem acesso.
//
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import {
  CalendarClock, Inbox, LayoutDashboard, Archive, ShieldCheck, TrendingUp,
  FilePlus, Mail, Sparkles, Workflow, Bot, BarChart3, History,
  ArrowRight, Zap, Target, Activity,
} from 'lucide-react';

function FeatureCard({ icon: Icon, title, text, accent = 'var(--accent)' }) {
  return (
    <div
      className="rounded-xl border-2 panel-border p-5 transition-all hover:shadow-lg hover:scale-[1.01]"
      style={{ background: 'var(--card)' }}
    >
      <div
        className="w-11 h-11 rounded-xl flex items-center justify-center mb-3"
        style={{ background: `color-mix(in srgb, ${accent} 16%, transparent)` }}
      >
        <Icon size={20} style={{ color: accent }} />
      </div>
      <div className="font-bold text-base mb-1">{title}</div>
      <div className="text-sm opacity-75 leading-relaxed">{text}</div>
    </div>
  );
}

function QuickLink({ to, icon: Icon, label, hint, accent = 'var(--accent)', onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-3 px-4 py-3 rounded-lg border panel-border bg-[var(--panel)] hover:bg-[var(--hover)] transition-all text-left"
    >
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: `color-mix(in srgb, ${accent} 16%, transparent)` }}
      >
        <Icon size={16} style={{ color: accent }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">{label}</div>
        {hint && <div className="text-[11px] opacity-60 truncate">{hint}</div>}
      </div>
      <ArrowRight size={14} className="opacity-30 group-hover:opacity-100 transition-opacity flex-shrink-0" />
    </button>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const role = String(user?.tipo_conta || '').toLowerCase();
  const isAdmin = role === 'admin';
  const userName = user?.nome_usuario || user?.nome || '';

  const horaSaudacao = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Bom dia';
    if (h < 18) return 'Boa tarde';
    return 'Boa noite';
  })();

  // Atalhos baseados em permissão (gestor não tem Histórico/Métricas/Editor)
  const quickLinks = [
    { to: '/prazos', icon: CalendarClock, label: 'Prazos', hint: 'Cobranças e vencimentos', accent: '#f59e0b' },
    { to: '/processos', icon: LayoutDashboard, label: 'Controle de Processos', hint: 'Kanban e fluxo', accent: '#3b82f6' },
    { to: '/Requisicoes', icon: Inbox, label: 'Requisições', hint: 'Triagem e novas', accent: '#10b981' },
    { to: '/novo', icon: FilePlus, label: 'Nova Requisição', hint: 'Criar pedido', accent: '#8b5cf6' },
    { to: '/backlog', icon: Archive, label: 'Backlog', hint: 'Processos parados', accent: '#06b6d4' },
    { to: '/auditoria', icon: ShieldCheck, label: 'Auditoria', hint: 'Logs e validações', accent: '#ef4444' },
    { to: '/analise-desvio', icon: TrendingUp, label: 'Análise de Desvio', hint: 'KWh e ponta', accent: '#f97316' },
    { to: '/caixa-de-email', icon: Mail, label: 'Caixa de Email', hint: 'Mensagens recebidas', accent: '#0891b2' },
    isAdmin && { to: '/dashboard', icon: BarChart3, label: 'Métricas', hint: 'Relatórios completos', accent: '#a855f7' },
    isAdmin && { to: '/historico', icon: History, label: 'Histórico', hint: 'Movimentações globais', accent: '#64748b' },
  ].filter(Boolean);

  const features = [
    {
      icon: Bot,
      title: 'Análise inteligente',
      text: 'IA própria analisa faturas, identifica irregularidades F01-F05 com motor SQL determinístico e GPT-5.4 para decisão final.',
      accent: '#3b82f6',
    },
    {
      icon: Workflow,
      title: 'Fluxo end-to-end',
      text: 'Da requisição inicial até o caixa: Ativos → Deferidos → Fluxo → Faturamento → Concluídos. Tudo rastreável.',
      accent: '#10b981',
    },
    {
      icon: Activity,
      title: 'Visão operacional',
      text: 'Kanban com SLA, alertas de vencimento, painel de saúde com travados +30 dias e backlog em tempo real.',
      accent: '#f59e0b',
    },
    {
      icon: Target,
      title: 'Padronização e segurança',
      text: 'Permissões por perfil, auditoria de movimentações, snapshots imutáveis e histórico granular.',
      accent: '#8b5cf6',
    },
  ];

  return (
    <div className="relative min-h-[calc(100vh-80px)]">
      {/* Background gradient */}
      <div
        className="absolute inset-0 -z-10 opacity-50 pointer-events-none"
        style={{
          background:
            'radial-gradient(900px 360px at top left, var(--accent) 0%, transparent 60%), radial-gradient(700px 280px at bottom right, #4f46e5 0%, transparent 60%)',
        }}
      />

      <div className="mx-auto max-w-6xl px-4 py-8 space-y-8">
        {/* Hero */}
        <section className="text-center space-y-4 pt-4">
          <div className="flex justify-center">
            <img
              src="/logo_sure.png"
              alt="SURE — Sistema Unificado de Ressarcimento"
              style={{ width: 200, height: 'auto', display: 'block' }}
            />
          </div>

          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border panel-border bg-[var(--panel)]/60 text-xs">
            <Zap size={13} className="text-[var(--accent)]" />
            <span>SURE · Sistema Unificado de Ressarcimento</span>
          </div>

          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">
            {horaSaudacao}{userName ? `, ${userName}` : ''}
          </h1>

          <p className="text-sm md:text-base opacity-75 max-w-2xl mx-auto leading-relaxed">
            Plataforma para detectar, gerenciar e ressarcir irregularidades em faturas de energia elétrica.
            Da análise automatizada de irregularidades até o crédito em caixa, tudo em um lugar só.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
            <button
              type="button"
              onClick={() => navigate('/processos')}
              className="px-5 py-2.5 rounded-lg bg-[var(--accent)] text-white font-semibold text-sm hover:opacity-90 transition-opacity inline-flex items-center gap-2"
            >
              <LayoutDashboard size={16} />
              Ir para Processos
            </button>
            <button
              type="button"
              onClick={() => navigate('/novo')}
              className="px-5 py-2.5 rounded-lg border-2 panel-border bg-[var(--panel)] hover:bg-[var(--hover)] transition-colors text-sm font-semibold inline-flex items-center gap-2"
            >
              <FilePlus size={16} />
              Nova Requisição
            </button>
          </div>
        </section>

        {/* Features */}
        <section>
          <div className="text-[11px] uppercase tracking-wide opacity-60 font-semibold mb-3 px-1">
            Como o sistema funciona
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {features.map((f, i) => (
              <FeatureCard key={i} {...f} />
            ))}
          </div>
        </section>

        {/* Quick Links */}
        <section>
          <div className="text-[11px] uppercase tracking-wide opacity-60 font-semibold mb-3 px-1">
            Atalhos rápidos
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {quickLinks.map((q) => (
              <QuickLink
                key={q.to}
                {...q}
                onClick={() => navigate(q.to)}
              />
            ))}
          </div>
        </section>

        {/* Footer info */}
        <section className="rounded-xl border panel-border bg-[var(--panel)]/40 p-5">
          <div className="flex items-start gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: 'color-mix(in srgb, var(--accent) 16%, transparent)' }}
            >
              <Sparkles size={18} style={{ color: 'var(--accent)' }} />
            </div>
            <div className="flex-1 text-sm">
              <div className="font-bold mb-1">Precisa de ajuda?</div>
              <div className="opacity-75 leading-relaxed">
                Use o chat do canto inferior direito para tirar dúvidas com a IA do sistema, ou
                envie feedback diretamente pelo botão flutuante. Para problemas técnicos, contate
                o suporte interno.
              </div>
            </div>
          </div>
        </section>

        <div className="text-center text-[11px] opacity-40 pt-2">
          SURE © {new Date().getFullYear()} · AMEnergia · {isAdmin ? 'Acesso Administrador' : role === 'gestor' ? 'Acesso Gestor' : 'Acesso Solicitante'}
        </div>
      </div>
    </div>
  );
}
