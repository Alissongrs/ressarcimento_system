// src/App.jsx — clean, UTF-8, routes and menus fixed
import React, { useEffect, useState, useRef } from 'react';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  NavLink,
  Navigate,
  useNavigate,
  useLocation,
} from 'react-router-dom';

import { useAuth } from './context/AuthContext.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';
import ThemeSwitcher from './components/ThemeSwitcher.jsx';
import './theme.css';

import {
  LogOut,
  FilePlus,
  BarChart3,
  Archive,
  FileText,
  Workflow,
  ShieldCheck,
  Inbox,
  Mail as MailIcon,
  AlarmClock,
  FilePenLine,
  PlusCircle,
  History,
  Home,
  Receipt,
  ChevronRight,
  LayoutDashboard,
  TrendingUp,
  Settings2,
  CalendarDays,
} from 'lucide-react';

import FeedbackModal from './components/FeedbackModal.jsx';
import Toast from './components/Toast.jsx';
import CommandPaletteHost from './components/CommandPaletteHost.jsx';
import PageContainer from './components/PageContainer.jsx';

// Components
import AlertasVencimentoModal from './components/AlertasVencimentoModal.jsx';
import AlertCalendarModal from './components/AlertCalendarModal.jsx';
import AlertTicker from './components/AlertTicker.jsx';
import GlobalNewProcessNotifier from './components/GlobalNewProcessNotifier.jsx';
import FloatingEmailComposer from './components/FloatingEmailComposer.jsx';
import GlobalChatWidget from './components/GlobalChatWidget.jsx';
import { EmailComposeProvider } from './context/EmailComposeContext.jsx';

// Pages
import Login from './pages/LoginPage.jsx';
import Register from './pages/Register.jsx';
import GestaoRequisicoes from './pages/GestaoRequisicoes.jsx';
import ControleProcessos from './pages/ControleProcessos.jsx';
import Relatorios from './pages/Relatorios.jsx';
import CaixaDeEmail from './pages/CaixaDeEmail.jsx';
import AnaliseDesvio from './pages/AnaliseDesvio.jsx';
import Auditoria from './pages/Auditoria.jsx';
import HomeGestorAdmin from './pages/HomeGestorAdmin.jsx';
import Requisicoes from './pages/Requisicoes.jsx';
import Historico from './pages/HistoricoFixed.jsx';
import AdminFeedbacks from './pages/AdminFeedbacks.jsx';
import AdminPrazos from './pages/AdminPrazos.jsx';
import AdminEditor from './pages/AdminEditor.jsx';
import AdminPlanilha from './pages/AdminPlanilha.jsx';
import Backlog from './pages/Backlog.jsx';
import RequisicaoForm from './pages/RequisicaoForm.jsx';

// Alerts SSE
import { getUnreadCount, connectAlertasSSE } from './services/alertaService.js';
import { sendFeedback } from './services/feedbackService.js';
import { getMailMessages } from './services/mailService';

// Corrige strings que chegaram como UTF-8 lido como latin1 (ex.: "RequisiÃ§ão" -> "Requisição")
const fixMojibake = (v) => {
  if (v == null) return '';
  const s = String(v);
  // Heurística simples: se não tem sinais típicos, não mexe
  if (!/[ÃÂ]/.test(s)) return s;

  try {
    // Converte "caracteres latin1" em bytes e decodifica como utf-8
    const bytes = Uint8Array.from([...s].map((ch) => ch.charCodeAt(0) & 0xff));
    // TextDecoder existe na maioria dos browsers modernos
    // eslint-disable-next-line no-undef
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    // Fallback (legado)
    try {
      // eslint-disable-next-line no-undef
      return decodeURIComponent(escape(s));
    } catch {
      return s;
    }
  }
};

function MailLinkMinimizedBar({ visible, onRestore }) {
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={onRestore}
      className="fixed left-4 bottom-4 z-50 bg-[var(--panel)]/90 border border-amber-400/70 shadow-lg rounded-xl px-4 py-3 flex items-center gap-3"
      title="Continuar anexar ao processo"
    >
      <div className="h-9 w-9 rounded-lg bg-[var(--muted)]/30 flex items-center justify-center border panel-border">
        <Inbox className="w-4 h-4" />
      </div>
      <div className="text-left">
        <div className="text-sm font-semibold">Anexar ao processo</div>
        <div className="text-[11px] opacity-70">Clique para continuar</div>
      </div>
    </button>
  );
}

function TopNav({ role, unread, mailUnread, onOpenAlertCalendar, onLogout }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const navigate = useNavigate();
  const baseItems = [
    { to: '/', label: 'Início', Icon: Home },
    { to: '/novo', label: 'Nova Requisição', Icon: FilePlus },
    { to: '/admin/planilha', label: 'Gerenciar Processos', Icon: LayoutDashboard },
    { to: '/backlog', label: 'Backlog', Icon: Archive },
    { to: '/auditoria', label: 'Auditoria', Icon: ShieldCheck },
    { to: '/analise-desvio', label: 'Análise de Desvio', Icon: TrendingUp },
    { to: '/historico', label: 'Histórico', Icon: History },
    { to: '/dashboard', label: 'Métricas', Icon: BarChart3 },
  ];
  const adminItems = [{ to: '/admin/editor', label: 'Editor', Icon: FilePenLine }];
  const items = role === 'admin' ? baseItems.concat(adminItems) : baseItems.filter((i) => !i.adminOnly);
  const visibleItems = items.slice(0, 8);
  const moreItems = items.slice(8);

  return (
    <header className="top-nav">
      <div className="top-nav-inner">
        <div className="top-nav-brand">SURE</div>
        <nav className="top-nav-links">
          <div className="top-nav-links-scroll">
            {visibleItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `top-nav-link ${isActive ? 'is-active' : ''}`}
                title={item.label}
              >
                <item.Icon className="top-nav-icon" />
                <span className="top-nav-text">{item.label}</span>
                {Number(item.badge) > 0 && <span className="top-nav-badge">{item.badge}</span>}
              </NavLink>
            ))}
            {null}
          </div>
          {moreItems.length > 0 && (
            <div className="top-nav-more">
              <button
                type="button"
                className="top-nav-link"
                onClick={(e) => {
                  e.preventDefault();
                  setMoreOpen((v) => !v);
                }}
                title="Mais"
              >
                <span className="top-nav-text">Mais</span>
                <ChevronRight className={`top-nav-icon transition ${moreOpen ? 'rotate-90' : ''}`} />
              </button>
              {moreOpen && (
                <div className="top-nav-more-menu">
                  {moreItems.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-[var(--hover)] text-sm"
                      onClick={() => setMoreOpen(false)}
                    >
                      <item.Icon className="h-4 w-4" />
                      <span>{item.label}</span>
                      {Number(item.badge) > 0 && <span className="top-nav-badge ml-auto">{item.badge}</span>}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          )}
        </nav>
        <div className="top-nav-actions">
          {(role === 'admin' || role === 'gestor') && (
            <>
              <button
                type="button"
                onClick={onOpenAlertCalendar}
                className="top-nav-link top-nav-alert relative"
                title="Calendário de alertas"
                aria-label="Calendário de alertas"
              >
                <CalendarDays className="top-nav-icon" />
                {Number(unread) > 0 && <span className="top-nav-badge">{unread > 99 ? '99+' : unread}</span>}
              </button>
              <button
                type="button"
                onClick={() => navigate('/caixa-de-email')}
                className="top-nav-link top-nav-alert relative"
                title="Caixa de Email"
                aria-label="Caixa de Email"
              >
                <MailIcon className="top-nav-icon" />
                {Number(mailUnread) > 0 && <span className="top-nav-badge">{mailUnread}</span>}
              </button>
            </>
          )}
          <button type="button" onClick={onLogout} className="top-nav-link top-nav-logout">
            <LogOut className="top-nav-icon" />
            <span className="top-nav-text">Sair</span>
          </button>
        </div>
      </div>
    </header>
  );
}

function App() {
  const { user, logout, sessionExpired, clearSessionExpired, remainingSeconds } = useAuth();
  const role = String(user?.tipo_conta || '').trim().toLowerCase();
  const isSolicitante = role === 'solicitante';
  const solicitanteAllowed = (key) => {
    const allowed = new Set(['inicio', 'novo', 'backlog', 'auditoria']);
    return allowed.has(key);
  };
  const solicitanteClass = (key) =>
    isSolicitante && solicitanteAllowed(key) ? 'text-orange-400' : '';

  const formatRemaining = (sec) => {
    if (sec == null) return '';
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    return `${m}:${String(r).padStart(2, '0')}`;
  };

  // Alerts state
  const [unread, setUnread] = useState(0);
  const [openGestorVenc, setOpenGestorVenc] = useState(false);
  const [openAlertCalendar, setOpenAlertCalendar] = useState(false);
  const [openFeedback, setOpenFeedback] = useState(false);
  const [toast, setToast] = useState({ open: false, type: 'info', text: '', position: 'bottom-right' });

  // Mail polling
  const [mailUnread, setMailUnread] = useState(0);
  const lastMailUnreadRef = useRef(0);
  const mailTimerRef = useRef(null);
  const mailPollRef = useRef(null);

  useEffect(() => {
    if (!toast.open) return;
    const id = setTimeout(() => {
      setToast((t) => ({ ...t, open: false }));
    }, 500);
    return () => clearTimeout(id);
  }, [toast.open]);

  const gestorVencShownRef = useRef(false);
  const esRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    // cleanup on logout
    if (!user) {
      setUnread(0);
      setMailUnread(0);
      lastMailUnreadRef.current = 0;
      if (mailTimerRef.current) clearInterval(mailTimerRef.current);
      try {
        esRef.current?.close();
      } catch {}
      if (timerRef.current) clearInterval(timerRef.current);
      setOpenGestorVenc(false);
      return;
    }

    (async () => setUnread(await getUnreadCount()))();

    const es = connectAlertasSSE();
    esRef.current = es;

    es.addEventListener('alerta_boot', async (ev) => {
      try {
        const data = JSON.parse(ev.data || '{}');
        if (typeof data.unread === 'number') setUnread(data.unread);
      } catch {}
    });

    es.addEventListener('alerta_novo', (ev) => {
      setUnread((u) => (Number.isFinite(u) ? u + 1 : 1));
      try {
        const data = JSON.parse(ev.data || '{}');
        const uc = data?.payload?.uc || data?.uc;
        const cliente = fixMojibake(data?.payload?.cliente || data?.cliente);
        const msg =
          uc || cliente
            ? `Nova requisição pendente${uc ? ' — UC ' + uc : ''}${cliente ? ' — ' + cliente : ''}`
            : 'Nova requisição pendente';
        setToast({ open: true, type: 'info', text: msg });
      } catch {
        setToast({ open: true, type: 'info', text: 'Nova requisição pendente' });
      }
    });

    es.addEventListener('requisicao_nova', (ev) => {
      // evento destinado ao criador; aviso amigável
      try {
        const data = JSON.parse(ev.data || '{}');
        const id = data?.processo_id || data?.id;
        setToast({
          open: true,
          type: 'success',
          text: `Requisição criada${id ? ' — #' + id : ''}`,
        });
      } catch {
        setToast({ open: true, type: 'success', text: 'Requisição criada' });
      }
    });

    es.addEventListener('alerta_unread', async (ev) => {
      try {
        const data = JSON.parse(ev.data || '{}');
        if (typeof data.unread === 'number') setUnread(data.unread);
      } catch {}
    });

    es.addEventListener('alerta_lido', async () => setUnread(await getUnreadCount()));

    // Canal unificado do backend para eventos de alerta (payload JSON possui {type, payload})
    es.addEventListener('alerta', (ev) => {
      try {
        const data = JSON.parse(ev.data || '{}');
        switch (data.type) {
          case 'alerta_unread': {
            const n = Number(data?.payload?.unread || 0);
            if (Number.isFinite(n)) setUnread(n);
            break;
          }
          case 'alerta_novo': {
            setUnread((u) => (Number.isFinite(u) ? u + 1 : 1));
            const uc = data?.payload?.uc;
            const cliente = fixMojibake(data?.payload?.cliente);
            const msg =
              uc || cliente
                ? `Nova requisição pendente${uc ? ' — UC ' + uc : ''}${cliente ? ' — ' + cliente : ''}`
                : 'Nova requisição pendente';
            setToast({ open: true, type: 'info', text: msg });
            break;
          }
          case 'alerta_lido': {
            (async () => setUnread(await getUnreadCount()))();
            break;
          }
          default:
            break;
        }
      } catch {}
    });

    // fallback polling se o SSE fechar
    timerRef.current = setInterval(async () => {
      if (es.readyState === EventSource.CLOSED) setUnread(await getUnreadCount());
    }, 30000);

    return () => {
      try {
        es.close();
      } catch {}
      esRef.current = null;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    if (role !== 'admin' && role !== 'gestor') return;
    let stopped = false;

    const poll = async () => {
      try {
        const inboxId = localStorage.getItem('mail_inbox_folder_id');
        if (!inboxId) return;

        const list = await getMailMessages({ folderId: inboxId, limit: 50 });
        if (stopped) return;

        let groupByThread = false;
        try {
          const raw = localStorage.getItem('mail_layout_v1');
          if (raw) {
            const parsed = JSON.parse(raw);
            if (typeof parsed?.groupByThread === 'boolean') groupByThread = parsed.groupByThread;
          }
        } catch {}

        const unreadCount = (() => {
          if (!Array.isArray(list)) return 0;
          const unread = list.filter((m) => !m.is_read_local);
          if (!groupByThread) return unread.length;

          const seen = new Set();
          const normalizeSubject = (s) =>
            String(s || '')
              .replace(/^\s*(re|fw|fwd)\s*:\s*/gi, '')
              .trim()
              .toLowerCase();

          for (const m of unread) {
            const key = m.thread_id || normalizeSubject(m.subject) || m.id;
            if (key) seen.add(key);
          }
          return seen.size;
        })();
        setMailUnread(unreadCount);

        if (unreadCount > lastMailUnreadRef.current) {
          const newest = Array.isArray(list)
            ? list.find((m) => !m.is_read_local) || list[0]
            : null;

          const from = fixMojibake(newest?.from_name || newest?.from_email || 'remetente');
          const subject = fixMojibake(newest?.subject || 'Sem assunto');

          setToast({
            open: true,
            type: 'info',
            text: `Novo e-mail de ${from}: ${subject}`,
            position: 'center',
          });
        }

        lastMailUnreadRef.current = unreadCount;
      } catch {
        // ignore polling errors
      }
    };

    mailPollRef.current = poll;
    poll();
    mailTimerRef.current = setInterval(poll, 60000);

    const onUnreadRefresh = () => {
      if (mailPollRef.current) mailPollRef.current();
    };
    const onUnreadSet = (ev) => {
      const count = Number(ev?.detail?.count ?? 0);
      if (Number.isNaN(count)) return;
      setMailUnread(count);
      lastMailUnreadRef.current = count;
    };
    window.addEventListener('mail-unread-refresh', onUnreadRefresh);
    window.addEventListener('mail-unread-set', onUnreadSet);

    return () => {
      stopped = true;
      if (mailTimerRef.current) clearInterval(mailTimerRef.current);
      window.removeEventListener('mail-unread-refresh', onUnreadRefresh);
      window.removeEventListener('mail-unread-set', onUnreadSet);
    };
  }, [user, role]);

  // Abre alertas de vencimento para gestor uma vez por sessão
  useEffect(() => {
    if (!user) return;
    if (String(user.tipo_conta).toLowerCase() === 'gestor' && !gestorVencShownRef.current) {
      gestorVencShownRef.current = true;
      setOpenGestorVenc(true);
    }
  }, [user]);

  // Sidebars
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const AdminSidebar = () => (
    <div className="sidebar-hoverzone sticky top-0 shrink-0">
      <aside
        className={`sidebar-collapsible p-4 border-r h-auto min-h-[125vh] flex flex-col ${
          sidebarOpen ? 'is-open' : ''
        }`}
        style={{
          background: 'var(--menu-bg)',
          borderColor: 'var(--menu-border)',
          color: 'var(--menu-fg)',
        }}
      >
      <div className="relative flex flex-col h-full">
        <button
          type="button"
          className="sidebar-handle"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label={sidebarOpen ? 'Recolher menu' : 'Expandir menu'}
          title={sidebarOpen ? 'Recolher menu' : 'Expandir menu'}
        >
          <ChevronRight className="sidebar-handle-icon" size={16} />
        </button>
        <div className="mb-6 px-2 flex flex-col items-center">
          <div className="text-lg font-extrabold sidebar-brand">SURE</div>
        </div>

        {/* ORDEM: Início, Nova Requisição, Requisições, Processos, Backlog, resto */}
        <nav className="space-y-1 flex-1 overflow-auto">
          {/* 0) Início */}
          <NavLink
            to="/"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Início"
          >
            <Home className="sidebar-icon" strokeWidth={1.8} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('inicio')}`}>Início</span>
          </NavLink>

          {/* 1) Nova Requisição */}
          <NavLink
            to="/novo"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Nova Requisição"
          >
            <FilePlus className="sidebar-icon" strokeWidth={1.6} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('novo')}`}>Nova Requisição</span>
          </NavLink>

          {/* 2) Requisições */}
          <NavLink
            to="/Requisicoes"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Requisições"
          >
            <FileText className="w-5 h-5" strokeWidth={1.25} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('requisicoes')}`}>Requisições</span>
          </NavLink>

          {/* 3) Gerenciar Processos */}
          <NavLink
            to="/admin/planilha"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Gerenciar Processos"
          >
            <LayoutDashboard className="w-5 h-5" strokeWidth={1.25} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('processos')}`}>Gerenciar Processos</span>
          </NavLink>

          {/* 4) Backlog */}
          <NavLink
            to="/backlog"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Backlog"
          >
            <Archive className="w-5 h-5" strokeWidth={1.25} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('backlog')}`}>Backlog</span>
          </NavLink>

          {null}

          <NavLink
            to="/auditoria"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Auditoria"
          >
            <ShieldCheck className="w-5 h-5" strokeWidth={1.25} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('auditoria')}`}>Auditoria</span>
          </NavLink>

          <NavLink
            to="/analise-desvio"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Análise de Desvio"
          >
            <TrendingUp className="w-5 h-5" strokeWidth={1.25} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('analise')}`}>Análise de Desvio</span>
          </NavLink>

          <NavLink
            to="/historico"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Histórico"
          >
            <History className="sidebar-icon" strokeWidth={1.25} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('historico')}`}>Histórico</span>
          </NavLink>

          <NavLink
            to="/dashboard"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Métricas"
          >
            <BarChart3 className="sidebar-icon" strokeWidth={1.25} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('metricas')}`}>Métricas</span>
          </NavLink>

          {role === 'admin' && (
            <NavLink
              to="/admin/editor"
              className={({ isActive }) =>
                `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                  isActive
                    ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                    : 'hover:bg-[var(--menu-hover)]'
                }`
              }
              title="Editor (Admin)"
            >
              <Settings2 className="sidebar-icon" strokeWidth={1.6} />
              <span className="text-sm font-medium sidebar-label">Editor</span>
            </NavLink>
          )}
        </nav>

        <div className="mt-auto space-y-2">
          {remainingSeconds != null && (
            <div className="text-[11px] opacity-70 text-center mb-1">
              Tempo restante: {formatRemaining(remainingSeconds)}
            </div>
          )}
          <button
            onClick={logout}
            className="w-full px-4 py-3 rounded-md hover:bg-[var(--menu-hover)] flex items-center justify-center gap-2"
          >
            <LogOut className="sidebar-icon sidebar-icon-logout" />
            <span className="text-xs sidebar-label">Sair</span>
          </button>
          <div className="text-[10px] opacity-60 text-center">v1.0.0</div>
        </div>
      </div>
      </aside>
    </div>
  );

  const CompactSidebar = () => (
    <div className="sidebar-hoverzone sticky top-0 shrink-0">
      <aside
        className={`sidebar-collapsible p-3 border-r h-auto min-h-[125vh] flex flex-col ${
          sidebarOpen ? 'is-open' : ''
        }`}
        style={{
          background: 'var(--menu-bg)',
          borderColor: 'var(--menu-border)',
          color: 'var(--menu-fg)',
        }}
      >
      <div className="relative flex flex-col h-full">
        <button
          type="button"
          className="sidebar-handle"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label={sidebarOpen ? 'Recolher menu' : 'Expandir menu'}
          title={sidebarOpen ? 'Recolher menu' : 'Expandir menu'}
        >
          <ChevronRight className="sidebar-handle-icon" size={16} />
        </button>
        <div className="mb-6 px-2 flex flex-col items-center">
          <h1 className="text-base font-semibold sidebar-brand">SURE</h1>
        </div>

        {/* ORDEM: Início, Nova Requisição, Requisições, Processos, Backlog, resto */}
        <nav className="space-y-1 flex-1 overflow-auto">
          <NavLink
            to="/"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Início"
          >
            <Home className="sidebar-icon shrink-0" strokeWidth={1.8} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('inicio')}`}>Início</span>
          </NavLink>

          <NavLink
            to="/novo"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Nova Requisição"
          >
            <FilePlus className="sidebar-icon shrink-0" strokeWidth={1.25} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('novo')}`}>Nova Requisição</span>
          </NavLink>

          <NavLink
            to="/Requisicoes"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Requisições"
          >
            <FileText className="sidebar-icon shrink-0" strokeWidth={1.25} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('requisicoes')}`}>Requisições</span>
          </NavLink>

          <NavLink
            to="/admin/planilha"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Gerenciar Processos"
          >
            <LayoutDashboard className="sidebar-icon shrink-0" strokeWidth={1.25} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('processos')}`}>Gerenciar Processos</span>
          </NavLink>

          <NavLink
            to="/backlog"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Backlog"
          >
            <Archive className="sidebar-icon shrink-0" strokeWidth={1.25} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('backlog')}`}>Backlog</span>
          </NavLink>

          {null}

          <NavLink
            to="/historico"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Histórico"
          >
            <History className="sidebar-icon shrink-0" strokeWidth={1.25} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('historico')}`}>Histórico</span>
          </NavLink>

          <NavLink
            to="/dashboard"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Métricas"
          >
            <BarChart3 className="sidebar-icon shrink-0" strokeWidth={1.25} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('metricas')}`}>Métricas</span>
          </NavLink>

          <NavLink
            to="/auditoria"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Auditoria"
          >
            <ShieldCheck className="sidebar-icon shrink-0" strokeWidth={1.25} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('auditoria')}`}>Auditoria</span>
          </NavLink>

          <NavLink
            to="/analise-desvio"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Análise de Desvio"
          >
            <TrendingUp className="sidebar-icon shrink-0" strokeWidth={1.25} />
            <span className={`text-sm font-medium sidebar-label ${solicitanteClass('analise')}`}>Análise de Desvio</span>
          </NavLink>
        </nav>

        <div className="mt-auto space-y-2">
          {remainingSeconds != null && (
            <div className="text-[11px] opacity-70 text-center mb-1">
              Tempo restante: {formatRemaining(remainingSeconds)}
            </div>
          )}
          <button
            onClick={logout}
            className="w-full px-4 py-3 rounded-md hover:bg-[var(--menu-hover)] flex items-center justify-center gap-2"
          >
            <LogOut className="sidebar-icon sidebar-icon-logout" />
            <span className="text-xs sidebar-label">Sair</span>
          </button>
          <div className="text-[10px] opacity-60 text-center">v1.0.0</div>
        </div>
      </div>
      </aside>
    </div>
  );

  // TopNav is a separate component (defined above) to keep its state stable.

  return (
    <ThemeProvider>
      <EmailComposeProvider>
      <Router>
        <RouteKeeper user={user} />
        <div className="flex min-h-screen themed-surface flex-col">
          {user && (
            <TopNav
              role={role}
              unread={unread}
              mailUnread={mailUnread}
              onOpenAlertCalendar={() => setOpenAlertCalendar(true)}
              onLogout={logout}
            />
          )}

          {user && (role === 'gestor' || role === 'admin') && <AlertTicker />}

          <main className="flex-1 min-w-0 pt-16">
            <PageContainer>
              <MailLinkMinimizedBarHost />
              <Routes>
                {!user && (
                  <>
                    <Route path="/login" element={<Login />} />
                    <Route path="/register" element={<Register />} />
                    <Route path="*" element={<Navigate to="/login" replace />} />
                  </>
                )}

                {user && (
                  <>
                    <Route
                      path="/"
                      element={
                        role === 'gestor' || role === 'admin' ? (
                          <HomeGestorAdmin />
                        ) : (
                          <ChatRequisicao />
                        )
                      }
                    />
                    <Route path="/backlog" element={<Backlog />} />
                    <Route path="/novo" element={<RequisicaoForm />} />

                    {role === 'gestor' || role === 'admin' ? (
                      <>
                        <Route path="/Requisicoes" element={<Requisicoes />} />
                        <Route path="/historico" element={<Historico />} />
                        <Route path="/gestao" element={<GestaoRequisicoes />} />
                        <Route path="/dashboard" element={<Relatorios />} />
                        <Route path="/processos" element={<ControleProcessos />} />
                        <Route path="/analise-desvio" element={<AnaliseDesvio />} />
                        <Route path="/caixa-de-email" element={<CaixaDeEmail />} />

                        {role === 'admin' && (
                          <>
                            {/* Preferred admin feedbacks route */}
                            <Route path="/adminfeedbacks" element={<AdminFeedbacks />} />
                            {/* Alias to maintain compatibility */}
                            <Route path="/admin/feedbacks" element={<AdminFeedbacks />} />
                            <Route path="/admin/prazos" element={<AdminPrazos />} />
                            <Route path="/admin/editor" element={<AdminEditor />} />
                            <Route path="/admin/planilha" element={<AdminPlanilha />} />
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <Route path="/gestao" element={<Navigate to="/" replace />} />
                        <Route path="/processos" element={<Navigate to="/" replace />} />
                        <Route path="/processos/:id" element={<Navigate to="/" replace />} />
                        <Route path="/analise-desvio" element={<Navigate to="/" replace />} />
                        <Route path="/caixa-de-email" element={<Navigate to="/" replace />} />
                      </>
                    )}

                    <Route path="/auditoria" element={<Auditoria />} />
                    <Route path="/login" element={<Navigate to="/" replace />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </>
                )}
              </Routes>
            </PageContainer>

            {/* Modal de feedback */}
            <FeedbackModal
              open={openFeedback}
              onClose={() => setOpenFeedback(false)}
              onSubmit={async (msg) => {
                try {
                  await sendFeedback(msg);
                  setOpenFeedback(false);
                  setToast({
                    open: true,
                    type: 'success',
                    text: 'Feedback enviado com sucesso!',
                  });
                } catch (e) {
                  setToast({
                    open: true,
                    type: 'error',
                    text: 'Falha ao enviar feedback.',
                  });
                }
              }}
            />
          </main>
        </div>

        {/* Global Modals */}
        <ThemeSwitcher />
        <GlobalNewProcessNotifier />
        <AlertasVencimentoModal
          open={openGestorVenc}
          onClose={() => setOpenGestorVenc(false)}
        />
        <AlertCalendarModal
          open={openAlertCalendar}
          onClose={() => setOpenAlertCalendar(false)}
        />
        <CommandPaletteHost />
        <FloatingEmailComposer />
        {user && <GlobalChatWidget />}

        {sessionExpired && (
          <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div
              className="w-full max-w-md border"
              style={{
                background: '#f6f6f6',
                color: '#111',
                borderColor: '#9a9a9a',
                borderRadius: 6,
                boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
                fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
              }}
            >
              <div
                style={{
                  padding: '10px 12px',
                  borderBottom: '1px solid #c9c9c9',
                  fontWeight: 600,
                  background: 'linear-gradient(#ffffff, #eaeaea)',
                }}
              >
                Sessão expirada
              </div>
              <div style={{ padding: '16px 12px', fontSize: 14, lineHeight: 1.4 }}>
                Seu tempo de login expirou. Faça login novamente para continuar.
              </div>
              <div
                style={{
                  padding: '12px',
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 8,
                  borderTop: '1px solid #c9c9c9',
                  background: '#ededed',
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    clearSessionExpired();
                    window.location.href = '/login';
                  }}
                  style={{
                    minWidth: 88,
                    padding: '6px 14px',
                    border: '1px solid #0a5bd7',
                    borderRadius: 4,
                    background: 'linear-gradient(#5aa0ff, #2f6edc)',
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: 13,
                  }}
                >
                  Ok
                </button>
              </div>
            </div>
          </div>
        )}

        <Toast
          open={toast.open}
          type={toast.type}
          message={toast.text}
          position={toast.position || 'bottom-right'}
          onClose={() =>
            setToast((t) => ({
              ...t,
              open: false,
            }))
          }
        />
      </Router>
      </EmailComposeProvider>
    </ThemeProvider>
  );
}

function MailLinkMinimizedBarHost() {
  const [visible, setVisible] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    try {
      setVisible(localStorage.getItem('mail_link_minimized') === '1');
    } catch {
      setVisible(false);
    }

    const handler = (e) => {
      const minimized = e?.detail?.minimized;
      if (typeof minimized === 'boolean') setVisible(minimized);
      else {
        try {
          setVisible(localStorage.getItem('mail_link_minimized') === '1');
        } catch {
          setVisible(false);
        }
      }
    };

    window.addEventListener('mail-link-minimized', handler);
    window.addEventListener('storage', handler);

    return () => {
      window.removeEventListener('mail-link-minimized', handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  if (!visible) return null;

  return (
    <MailLinkMinimizedBar
      visible={visible}
      onRestore={() => {
        try {
          localStorage.setItem('mail_link_restore', '1');
          localStorage.removeItem('mail_link_minimized');
          window.dispatchEvent(
            new CustomEvent('mail-link-minimized', { detail: { minimized: false } })
          );
        } catch {
          // ignore
        }
        navigate('/caixa-de-email');
      }}
    />
  );
}

export default App;

// Persist last route while logged + restore once per session after login/reload
function RouteKeeper({ user }) {
  const location = useLocation();
  const navigate = useNavigate();

  // Persist last non-root route
  useEffect(() => {
    if (!user) return;

    const path = location.pathname + (location.search || '');
    const isAuth = path === '/login' || path === '/register';
    const isRoot = path === '/';

    if (!isRoot && !isAuth) {
      try {
        localStorage.setItem('lastRoute', path);
      } catch {}
    }
  }, [user, location.pathname, location.search]);

  // Restore last route ONLY ONCE per session (prevents loop when clicking "Início")
  useEffect(() => {
    if (!user) {
      try {
        sessionStorage.removeItem('restoredLastRoute');
      } catch {}
      return;
    }

    const isRoot = location.pathname === '/';
    if (!isRoot) return;

    let already = false;
    try {
      already = sessionStorage.getItem('restoredLastRoute') === '1';
    } catch {}

    if (already) return;

    let last = null;
    try {
      last = localStorage.getItem('lastRoute');
    } catch {}

    try {
      sessionStorage.setItem('restoredLastRoute', '1');
    } catch {}

    if (last && last !== '/' && last !== '/login' && last !== '/register') {
      navigate(last, { replace: true });
    }
  }, [user, location.pathname, navigate]);

  return null;
}
