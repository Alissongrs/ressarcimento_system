import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import CommandPalette from './CommandPalette.jsx';
import { searchGlobal } from '../services/searchService.js';

export default function CommandPaletteHost({ onOpenAlerts }) {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [dbResults, setDbResults] = useState([]);
  const [dbLoading, setDbLoading] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      const isK = e.key?.toLowerCase() === 'k';
      if ((e.ctrlKey || e.metaKey) && isK) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
    setQuery('');
    setDbResults([]);
    setDbLoading(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  // Debounced DB search
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = (query || '').trim();
    if (q.length < 3) {
      setDbResults([]);
      setDbLoading(false);
      return;
    }
    setDbLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const hits = await searchGlobal(q);
        const seen = new Set();
        const unique = (hits || []).filter((r) => {
          if (seen.has(r.processo_id)) return false;
          seen.add(r.processo_id);
          return true;
        }).slice(0, 8);
        setDbResults(unique);
      } catch {
        setDbResults([]);
      } finally {
        setDbLoading(false);
      }
    }, 350);
  }, [query, open]);

  const role = String(user?.tipo_conta || '').trim().toLowerCase();

  const dbActions = useMemo(() =>
    dbResults.map((r) => {
      const label = r.nome_cliente || r.uc || `Processo #${r.processo_id}`;
      const parts = [
        r.uc && r.nome_cliente ? `UC: ${r.uc}` : null,
        r.status_composto && r.status_composto !== ' - ' ? r.status_composto : null,
      ].filter(Boolean);
      const dest = (role === 'admin') ? `/admin/planilha?q=${r.processo_id}` : `/historico`;
      return {
        id: `db-proc-${r.processo_id}`,
        title: `#${r.processo_id} — ${label}`,
        subtitle: parts.join(' · ') || undefined,
        run: () => navigate(dest),
      };
    }),
  [dbResults, role, navigate]);

  const actions = useMemo(() => {
    if (!user) return [];
    const common = [
      { id: 'goto-new', title: 'Nova Requisição', subtitle: 'Abrir formulário de requisição', run: () => navigate('/novo') },
      { id: 'goto-chat', title: 'Assistente de Requisição (Chat)', subtitle: 'Abrir fluxo guiado por chat', run: () => navigate('/requisicao-chat') },
      { id: 'theme-cycle', title: 'Trocar Tema', subtitle: `Atual: ${theme}`, run: () => {
          const order = ['dark','light','light-1','light-2','light-3','light-4','sap','navy','orange-gray','green-orange','orange-purple-green','pink','pinklight'];
          const i = order.indexOf(theme); setTheme(order[(i + 1 + order.length) % order.length]);
        } },
      { id: 'logout', title: 'Sair', subtitle: 'Encerrar sessão atual', run: () => logout() },
    ];
    const gestor = [
      { id: 'goto-metricas', title: 'Métricas', subtitle: 'Visão geral e indicadores', run: () => navigate('/dashboard') },
      { id: 'goto-processos', title: 'Controle de Processos', subtitle: 'Kanban e movimentações', run: () => navigate('/processos') },
      { id: 'goto-auditoria', title: 'Auditoria', subtitle: 'Upload de PDFs, links e regras (IA)', run: () => navigate('/auditoria') },
      { id: 'goto-email', title: 'Caixa de E-mail', subtitle: 'Envio e histórico por processo', run: () => navigate('/caixa-de-email') },
    ];
    const admin = [
      { id: 'goto-feedbacks', title: 'Admin: Feedbacks', subtitle: 'Ver feedbacks dos usuários', run: () => navigate('/adminfeedbacks') },
      { id: 'goto-prazos', title: 'Admin: Prazos', subtitle: 'Configurar prazos por coluna/etapa', run: () => navigate('/admin/prazos') },
      { id: 'goto-editor', title: 'Admin: Editor de Processos', subtitle: 'Editor completo de processos', run: () => navigate('/admin/editor') },
      { id: 'goto-planilha', title: 'Gerenciar Processos', subtitle: 'Planilha completa de processos', run: () => navigate('/admin/planilha') },
    ];
    let list = [...common];
    if (role === 'gestor' || role === 'admin') list = [...list, ...gestor];
    if (role === 'admin') list = [...list, ...admin];
    return list;
  }, [user, role, theme, navigate, logout, setTheme]);

  return (
    <CommandPalette
      open={open}
      onClose={handleClose}
      actions={actions}
      query={query}
      onQueryChange={setQuery}
      dbActions={dbActions}
      dbLoading={dbLoading}
    />
  );
}
