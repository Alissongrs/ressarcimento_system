import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import CommandPalette from './CommandPalette.jsx';

export default function CommandPaletteHost({ onOpenAlerts }) {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      const isK = e.key?.toLowerCase() === 'k';
      if ((e.ctrlKey || e.metaKey) && isK) {
        e.preventDefault(); setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const role = String(user?.tipo_conta || '').trim().toLowerCase();
  const actions = useMemo(() => {
    if (!user) return [];
    const common = [
      { id: 'goto-new', title: 'Nova Requisição', subtitle: 'Abrir formulário de requisição', run: () => navigate('/novo') },
      { id: 'goto-chat', title: 'Assistente de Requisição (Chat)', subtitle: 'Abrir fluxo guiado por chat', run: () => navigate('/requisicao-chat') },
      { id: 'open-alertas', title: 'Abrir Alertas', subtitle: 'Ver seus alertas', run: () => onOpenAlerts?.() },
      { id: 'theme-cycle', title: 'Trocar Tema', subtitle: `Atual: ${theme}`, run: () => {
          const order = ['dark','light','light-1','light-2','light-3','light-4','pink','pinklight'];
          const i = order.indexOf(theme); setTheme(order[(i+1+order.length)%order.length]);
        } },
      { id: 'logout', title: 'Sair', subtitle: 'Encerrar sessão atual', run: () => logout() },
    ];
    const gestor = [
      { id: 'goto-dashboard', title: 'Dashboard', subtitle: 'Visão geral e métricas', run: () => navigate('/dashboard') },
      { id: 'goto-processos', title: 'Controle de Processos', subtitle: 'Kanban e movimentações', run: () => navigate('/processos') },
      { id: 'goto-auditoria', title: 'Auditoria', subtitle: 'Upload de PDFs, links e regras (IA)', run: () => navigate('/auditoria') },
      { id: 'goto-email', title: 'Caixa de E-mail', subtitle: 'Envio e histórico por processo', run: () => navigate('/caixa-de-email') },
      { id: 'goto-ia', title: 'Chat IA', subtitle: 'Assistente para consultas e apoio', run: () => navigate('/chat-ia') },
    ];
    const admin = [
      { id: 'goto-feedbacks', title: 'Admin: Feedbacks', subtitle: 'Ver feedbacks dos usuários', run: () => navigate('/adminfeedbacks') },
      { id: 'goto-prazos', title: 'Admin: Prazos', subtitle: 'Configurar prazos por coluna/etapa', run: () => navigate('/admin/prazos') },
      { id: 'goto-editor', title: 'Admin: Editor de Processos', subtitle: 'Editor completo de processos', run: () => navigate('/admin/editor') },
    ];
    let list = [...common];
    if (role === 'gestor' || role === 'admin') list = [...list, ...gestor];
    if (role === 'admin') list = [...list, ...admin];
    return list;
  }, [user, role, theme, onOpenAlerts, navigate, logout, setTheme]);

  return <CommandPalette open={open} onClose={() => setOpen(false)} actions={actions} />;
}
