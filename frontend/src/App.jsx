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
  ListChecks,
  ScanText,
  Inbox,
  Receipt,
  Mail as MailIcon,
  Bot,
  Megaphone,
  AlarmClock,
  FilePenLine,
  History,
  Home, // ícone Início
} from 'lucide-react';

import FeedbackModal from './components/FeedbackModal.jsx';
import Toast from './components/Toast.jsx';
import CommandPaletteHost from './components/CommandPaletteHost.jsx';
import PageContainer from './components/PageContainer.jsx';

// Components
import AlertsModal from './components/AlertsModal.jsx';
import AlertasVencimentoModal from './components/AlertasVencimentoModal.jsx';
import GlobalNewProcessNotifier from './components/GlobalNewProcessNotifier.jsx';

// Pages
import Login from './pages/LoginPage.jsx';
import Register from './pages/Register.jsx';
import RequisicaoForm from './pages/RequisicaoForm.jsx';
import GestaoRequisicoes from './pages/GestaoRequisicoes.jsx';
import ControleProcessos from './pages/ControleProcessos.jsx';
import DetalhesRequisicao from './pages/DetalhesRequisicao.jsx';
import ProcessoDetalhes from './pages/ProcessoDetalhes.jsx';
import Dashboard from './pages/Dashboard.jsx';
import CaixaDeEmail from './pages/CaixaDeEmail.jsx';
import ChatIA from './pages/ChatIA.jsx';
import Ocr from './pages/Ocr.jsx';
import Regras from './pages/Regras.jsx';
import Auditoria from './pages/Auditoria.jsx';
import ChatRequisicao from './pages/ChatRequisicaoNew.jsx';
import HomeGestorAdmin from './pages/HomeGestorAdmin.jsx';
import Requisicoes from './pages/Requisicoes.jsx';
import Historico from './pages/HistoricoFixed.jsx';
import AdminFeedbacks from './pages/AdminFeedbacks.jsx';
import AdminPrazos from './pages/AdminPrazos.jsx';
import AdminEditor from './pages/AdminEditor.jsx';
import Backlog from './pages/Backlog.jsx';

// Alerts SSE
import { getUnreadCount, connectAlertasSSE } from './services/alertaService.js';
import { sendFeedback } from './services/feedbackService.js';

function App() {
  const { user, logout } = useAuth();
  const role = String(user?.tipo_conta || '').trim().toLowerCase();

  // Alerts state
  const [unread, setUnread] = useState(0);
  const [openAlerts, setOpenAlerts] = useState(false);
  const [openGestorVenc, setOpenGestorVenc] = useState(false);
  const [openFeedback, setOpenFeedback] = useState(false);
  const [toast, setToast] = useState({ open: false, type: 'info', text: '' });
  const gestorVencShownRef = useRef(false);
  const esRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    // cleanup on logout
    if (!user) {
      setUnread(0);
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
        const cliente = data?.payload?.cliente || data?.cliente;
        const msg =
          uc || cliente
            ? `Nova requisição pendente${uc ? ' — UC ' + uc : ''}${
                cliente ? ' — ' + cliente : ''
              }`
            : 'Nova requisição pendente';
        setToast({ open: true, type: 'info', text: msg });
      } catch {
        setToast({
          open: true,
          type: 'info',
          text: 'Nova requisição pendente',
        });
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

    es.addEventListener('alerta_lido', async () =>
      setUnread(await getUnreadCount()),
    );

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
            const cliente = data?.payload?.cliente;
            const msg =
              uc || cliente
                ? `Nova requisição pendente${uc ? ' — UC ' + uc : ''}${
                    cliente ? ' — ' + cliente : ''
                  }`
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
      if (es.readyState === EventSource.CLOSED)
        setUnread(await getUnreadCount());
    }, 30000);

    return () => {
      try {
        es.close();
      } catch {}
      esRef.current = null;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [user]);

  // Abre alertas de vencimento para gestor uma vez por sessão
  useEffect(() => {
    if (!user) return;
    if (String(user.tipo_conta).toLowerCase() === 'gestor' && !gestorVencShownRef.current) {
      gestorVencShownRef.current = true;
      setOpenGestorVenc(true);
    }
  }, [user]);

  // Sidebars
  const AdminSidebar = () => (
    <aside
      className="sticky top-0 sidebar-collapsible p-4 border-r h-auto min-h-screen shrink-0 flex flex-col"
      style={{
        background: 'var(--menu-bg)',
        borderColor: 'var(--menu-border)',
        color: 'var(--menu-fg)',
      }}
    >
      <div className="relative flex flex-col h-full">
        <div className="mb-6 px-2 flex flex-col items-center">
          <div className="text-lg font-extrabold sidebar-brand">SURE</div>
          <NavLink
            to="/"
            className={({ isActive }) =>
              'sidebar-item transition-colors w-full flex items-center gap-2 px-3 py-2 rounded-md justify-center ' +
              (isActive
                ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                : 'hover:bg-[var(--menu-hover)]')
            }
            title="Início"
          >
<<<<<<< HEAD
            <Home className="sidebar-icon" strokeWidth={1.8} />
=======
            <Home className="w-8 h-8 shrink-0" strokeWidth={1.8} />
>>>>>>> 07e4f02 (Fix: alterações de segurança)
            <span className="text-sm font-medium sidebar-label">Início</span>
          </NavLink>
        </div>

        {/* ORDEM: Nova Requisição, Requisições, Processos, Backlog, resto */}
        <nav className="space-y-1 flex-1 overflow-auto">
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
            <span className="text-sm font-medium sidebar-label">
              Nova Requisição
            </span>
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
            <span className="text-sm font-medium sidebar-label">
              Requisições
            </span>
          </NavLink>

          {/* 3) Processos */}
          <NavLink
            to="/processos"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Processos"
          >
            <Workflow className="w-5 h-5" strokeWidth={1.25} />
            <span className="text-sm font-medium sidebar-label">Processos</span>
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
            <span className="text-sm font-medium sidebar-label">Backlog</span>
          </NavLink>

          {/* RESTANTE MANTIDO NA MESMA ORDEM DE ANTES */}

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
            <span className="text-sm font-medium sidebar-label">Auditoria</span>
          </NavLink>

          <NavLink
            to="/ocr"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="OCR"
          >
            <ScanText className="sidebar-icon" strokeWidth={1.25} />
            <span className="text-sm font-medium sidebar-label">OCR</span>
          </NavLink>

          <NavLink
            to="/regras"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Regras"
          >
            <ListChecks className="w-5 h-5" strokeWidth={1.25} />
            <span className="text-sm font-medium sidebar-label">Regras</span>
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
            <span className="text-sm font-medium sidebar-label">Histórico</span>
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
            title="Relatórios"
          >
            <BarChart3 className="sidebar-icon" strokeWidth={1.25} />
            <span className="text-sm font-medium sidebar-label">
              Relatórios
            </span>
          </NavLink>

          <NavLink
            to="/caixa-de-email"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Caixa de Email"
          >
            <MailIcon className="sidebar-icon" strokeWidth={1.25} />
            <span className="text-sm font-medium sidebar-label">
              Caixa de Email
            </span>
          </NavLink>

          <NavLink
            to="/chat-ia"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Chat IA"
          >
            <Bot className="sidebar-icon" strokeWidth={1.25} />
            <span className="text-sm font-medium sidebar-label">Chat IA</span>
          </NavLink>

          {role === 'admin' && (
            <>
              <NavLink
                to="/adminfeedbacks"
                className={({ isActive }) =>
                  `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                    isActive
                      ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                      : 'hover:bg-[var(--menu-hover)]'
                  }`
                }
                title="Feedbacks (Admin)"
              >
                <Megaphone className="sidebar-icon" strokeWidth={1.6} />
                <span className="text-sm font-medium sidebar-label">
                  Feedbacks
                </span>
              </NavLink>

              <NavLink
                to="/admin/prazos"
                className={({ isActive }) =>
                  `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                    isActive
                      ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                      : 'hover:bg-[var(--menu-hover)]'
                  }`
                }
                title="Prazos & Alarmes (Admin)"
              >
                <AlarmClock className="sidebar-icon" strokeWidth={1.6} />
                <span className="text-sm font-medium sidebar-label">
                  Prazos & Alarmes
                </span>
              </NavLink>

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
                <FilePenLine className="sidebar-icon" strokeWidth={1.6} />
                <span className="text-sm font-medium sidebar-label">
                  Editor
                </span>
              </NavLink>
            </>
          )}
        </nav>

        <div className="mt-auto space-y-2">
          <button
            onClick={logout}
            className="w-full px-4 py-3 rounded-md hover:bg-[var(--menu-hover)] flex items-center justify-center gap-2"
          >
            <LogOut className="sidebar-icon sidebar-icon-logout w-5 h-5" />
            <span className="text-xs sidebar-label">Sair</span>
          </button>
          <div className="text-[10px] opacity-60 text-center">v1.0.0</div>
        </div>
      </div>
    </aside>
  );

  const CompactSidebar = () => (
    <aside
      className="sticky top-0 sidebar-collapsible p-3 border-r h-auto min-h-screen shrink-0 flex flex-col"
      style={{
        background: 'var(--menu-bg)',
        borderColor: 'var(--menu-border)',
        color: 'var(--menu-fg)',
      }}
    >
      <div className="relative flex flex-col h-full">
        <div className="mb-6 px-2 flex flex-col items-center">
          <h1 className="text-base font-semibold sidebar-brand">SURE</h1>
          <NavLink
            to="/"
            className="w-full flex items-center justify-center px-3 py-2 rounded-md transition-colors hover:bg-[var(--menu-hover)]"
            title="Início"
          >
<<<<<<< HEAD
            <Home className="w-5 h-5" />
=======
            <Home className="w-8 h-8 shrink-0" strokeWidth={1.8} />
>>>>>>> 07e4f02 (Fix: alterações de segurança)
          </NavLink>
        </div>

        {/* ORDEM: Nova Requisição, Requisições, Processos, Backlog, resto */}
        <nav className="space-y-1 flex-1 overflow-auto">
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
            <FilePlus className="w-8 h-8 shrink-0" strokeWidth={1.25} />
            <span className="text-sm font-medium sidebar-label">
              Nova Requisição
            </span>
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
            <FileText className="w-8 h-8 shrink-0" strokeWidth={1.25} />
            <span className="text-sm font-medium sidebar-label">
              Requisições
            </span>
          </NavLink>

          {/* 3) Processos */}
          <NavLink
            to="/processos"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Processos"
          >
            <Workflow className="w-8 h-8 shrink-0" strokeWidth={1.25} />
            <span className="text-sm font-medium sidebar-label">Processos</span>
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
            <Archive className="w-8 h-8 shrink-0" strokeWidth={1.25} />
            <span className="text-sm font-medium sidebar-label">Backlog</span>
          </NavLink>

          {/* RESTANTE MANTIDO NA MESMA ORDEM DE ANTES */}

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
            <History className="w-8 h-8 shrink-0" strokeWidth={1.25} />
            <span className="text-sm font-medium sidebar-label">Histórico</span>
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
            title="Relatórios"
          >
            <BarChart3 className="w-8 h-8 shrink-0" strokeWidth={1.25} />
            <span className="text-sm font-medium sidebar-label">
              Relatórios
            </span>
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
            <Receipt className="w-8 h-8 shrink-0" strokeWidth={1.25} />
            <span className="text-sm font-medium sidebar-label">Auditoria</span>
          </NavLink>

          <NavLink
            to="/caixa-de-email"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Caixa de Email"
          >
            <MailIcon className="w-8 h-8 shrink-0" strokeWidth={1.25} />
            <span className="text-sm font-medium sidebar-label">
              Caixa de Email
            </span>
          </NavLink>

          <NavLink
            to="/chat-ia"
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-3 py-2 rounded-md ${
                isActive
                  ? 'bg-[var(--menu-hover)] text-[var(--menu-fg)]'
                  : 'hover:bg-[var(--menu-hover)]'
              }`
            }
            title="Chat IA"
          >
            <Bot className="w-8 h-8 shrink-0" strokeWidth={1.25} />
            <span className="text-sm font-medium sidebar-label">Chat IA</span>
          </NavLink>
        </nav>

        <div className="mt-auto space-y-2">
          <button
            onClick={logout}
            className="w-full px-4 py-3 rounded-md hover:bg-[var(--menu-hover)] flex items-center justify-center gap-2"
          >
            <LogOut className="w-5 h-5" />
            <span className="text-xs sidebar-label">Sair</span>
          </button>
          <div className="text-[10px] opacity-60 text-center">v1.0.0</div>
        </div>
      </div>
    </aside>
  );

  return (
    <ThemeProvider>
      <Router>
        <RouteKeeper user={user} />
        <div className="flex min-h-screen themed-surface">
          {user && (role === 'admin' ? <AdminSidebar /> : <CompactSidebar />)}

          <main className="flex-1 min-w-0">
            <PageContainer>
              <Routes>
                {!user && (
                  <>
                    <Route path="/login" element={<Login />} />
                    <Route path="/register" element={<Register />} />
                    <Route
                      path="*"
                      element={<Navigate to="/login" replace />}
                    />
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
                    <Route path="/novo" element={<ChatRequisicao />} />
                    <Route
                      path="/requisicao-chat"
                      element={<ChatRequisicao />}
                    />
                    <Route
                      path="/requisicao/:id"
                      element={<DetalhesRequisicao />}
                    />
                    <Route path="/backlog" element={<Backlog />} />

                    {role === 'gestor' || role === 'admin' ? (
                      <>
                        <Route
                          path="/Requisicoes"
                          element={<Requisicoes />}
                        />
                        <Route path="/historico" element={<Historico />} />
                        <Route
                          path="/gestao"
                          element={<GestaoRequisicoes />}
                        />
                        <Route path="/dashboard" element={<Dashboard />} />
                        <Route
                          path="/processos"
                          element={<ControleProcessos />}
                        />
                        <Route
                          path="/processos/:id"
                          element={<ProcessoDetalhes />}
                        />
                        <Route path="/auditoria" element={<Auditoria />} />
                        <Route path="/ocr" element={<Ocr />} />
                        <Route path="/regras" element={<Regras />} />
                        <Route
                          path="/caixa-de-email"
                          element={<CaixaDeEmail />}
                        />
                        <Route path="/chat-ia" element={<ChatIA />} />
                        {role === 'admin' && (
                          <>
                            {/* Preferred admin feedbacks route */}
                            <Route
                              path="/adminfeedbacks"
                              element={<AdminFeedbacks />}
                            />
                            {/* Alias to maintain compatibility */}
                            <Route
                              path="/admin/feedbacks"
                              element={<AdminFeedbacks />}
                            />
                            <Route
                              path="/admin/prazos"
                              element={<AdminPrazos />}
                            />
                            <Route
                              path="/admin/editor"
                              element={<AdminEditor />}
                            />
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <Route
                          path="/gestao"
                          element={<Navigate to="/" replace />}
                        />
                        <Route
                          path="/processos"
                          element={<Navigate to="/" replace />}
                        />
                        <Route
                          path="/processos/:id"
                          element={<Navigate to="/" replace />}
                        />
                        <Route
                          path="/auditoria"
                          element={<Navigate to="/" replace />}
                        />
                        <Route
                          path="/ocr"
                          element={<Navigate to="/" replace />}
                        />
                        <Route
                          path="/regras"
                          element={<Navigate to="/" replace />}
                        />
                        <Route
                          path="/caixa-de-email"
                          element={<Navigate to="/" replace />}
                        />
                        <Route
                          path="/chat-ia"
                          element={<Navigate to="/" replace />}
                        />
                      </>
                    )}

                    <Route
                      path="/login"
                      element={<Navigate to="/" replace />}
                    />
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
        <AlertsModal open={openAlerts} onClose={() => setOpenAlerts(false)} />
        <ThemeSwitcher />
        <GlobalNewProcessNotifier />
        <AlertasVencimentoModal
          open={openGestorVenc}
          onClose={() => setOpenGestorVenc(false)}
        />
        <CommandPaletteHost onOpenAlerts={() => setOpenAlerts(true)} />
        <Toast
          open={toast.open}
          type={toast.type}
          message={toast.text}
          onClose={() =>
            setToast((t) => ({
              ...t,
              open: false,
            }))
          }
        />
      </Router>
    </ThemeProvider>
  );
}

export default App;

// Persist last route while logged
function RouteKeeper({ user }) {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!user) return;
    const path = location.pathname + (location.search || '');
    if (path !== '/' && path !== '/login') {
      try {
        localStorage.setItem('lastRoute', path);
      } catch {}
    }
  }, [user, location.pathname, location.search]);

  useEffect(() => {
    if (!user) return;
    const isRoot = location.pathname === '/';
    // Se o usuário está na raiz (Home), não faça redirect automático;
    // também limpa o lastRoute para evitar loop ao clicar em "Início".
    if (isRoot) {
      try { localStorage.removeItem('lastRoute'); } catch {}
      return;
    }
    try {
      const last = localStorage.getItem('lastRoute');
      if (last && isRoot && last !== '/' && last !== '/login')
        navigate(last, { replace: true });
    } catch {}
  }, [user, location.pathname, navigate]);

  return null;
}
