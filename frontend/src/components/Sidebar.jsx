// src/components/Sidebar.jsx
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Bell } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getUnreadCount, connectAlertasSSE } from '../services/alertaService';

export default function Sidebar() {
  const [unread, setUnread] = useState(0);
  const navigate = useNavigate();
  const esRef = useRef(null);
  const pollRef = useRef(null);

  const safeSetUnread = useCallback((valOrFn) => {
    setUnread((prev) => {
      const next = typeof valOrFn === 'function' ? valOrFn(prev) : valOrFn;
      // evita negativos e limita a 999 para badge
      const clamped = Math.max(0, Math.min(999, Number(next) || 0));
      return clamped;
    });
  }, []);

  const loadUnread = useCallback(async () => {
    try {
      const n = await getUnreadCount();
      if (typeof n === 'number') safeSetUnread(n);
    } catch {
      // silencioso: polling falhou (ex.: offline)
    }
  }, [safeSetUnread]);

  // Polling de segurança (fallback)
  useEffect(() => {
    loadUnread(); // carga inicial
    pollRef.current = setInterval(loadUnread, 30_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadUnread]);

  // Util: tenta extrair "unread" de diferentes formatos de payload
  const parseUnread = (raw) => {
    try {
      const obj = JSON.parse(raw);
      if (typeof obj?.unread === 'number') return obj.unread;
      if (typeof obj?.payload?.unread === 'number') return obj.payload.unread;
      if (typeof obj?.data?.unread === 'number') return obj.data.unread;
    } catch {
      /* ignore */
    }
    return null;
  };

  // SSE em tempo real (user-level)
  useEffect(() => {
    // se já existir, fecha
    if (esRef.current) {
      try { esRef.current.close(); } catch {}
      esRef.current = null;
    }

    // Conecta usando a URL oficial (/api/v1/alertas/stream?token=...)
    let es;

    try {
      es = connectAlertasSSE();
      esRef.current = es;
    } catch {
      // Se o navegador não suportar ou falhar na criação, seguimos com polling apenas
      return;
    }

    const onOpen = () => {
      // opcional: console.debug('[SSE] conectado');
    };
    const onError = () => {
      // navegador normalmente tenta reconectar sozinho
      // opcional: console.debug('[SSE] erro; aguardando reconexão automática');
    };

    // Evento: contagem direta
    const onUnread = (e) => {
      const n = parseUnread(e.data);
      if (n != null) safeSetUnread(n);
      else loadUnread(); // fallback
    };

    // Evento: novo alerta → incrementa otimista (ou recarrega)
    const onNovo = () => {
      safeSetUnread((prev) => (Number.isFinite(prev) ? prev + 1 : prev));
    };

    // Evento: leitura no servidor → recarrega para garantir consistência
    const onLido = () => {
      loadUnread();
    };

    es.addEventListener('open', onOpen);
    es.addEventListener('error', onError);
    es.addEventListener('alerta_unread', onUnread);
    es.addEventListener('alerta_novo', onNovo);
    es.addEventListener('alerta_lido', onLido);

    return () => {
      if (!es) return;
      es.removeEventListener('open', onOpen);
      es.removeEventListener('error', onError);
      es.removeEventListener('alerta_unread', onUnread);
      es.removeEventListener('alerta_novo', onNovo);
      es.removeEventListener('alerta_lido', onLido);
      try { es.close(); } catch {}
      esRef.current = null;
    };
  }, [loadUnread, safeSetUnread]);

  const handleClickAlertas = useCallback(() => {
    navigate('/alertas'); // ajuste se sua rota for diferente
  }, [navigate]);

  const badgeText = unread > 99 ? '99+' : String(unread);

  return (
    <nav
      className="w-64 sidebar-collapsible h-full flex flex-col shadow-soft border-r rounded-tr-3xl rounded-br-3xl overflow-hidden"
      style={{
        background: 'var(--sidebar-background, var(--menu-bg))',
        color: 'var(--menu-fg, var(--fg))',
        borderColor: 'var(--sidebar-border, var(--border))',
      }}
    >
      {/* ...outros itens de navegação */}

      <button
        type="button"
        onClick={handleClickAlertas}
        className="relative mt-2 mx-2 flex items-center gap-2 px-3 py-2 rounded-lg transition-smooth"
        style={{
          background: 'transparent',
          color: 'var(--menu-fg)',
        }}
        aria-label={`Alertas${unread > 0 ? `, ${unread} não lido${unread > 1 ? 's' : ''}` : ''}`}
        title={unread > 0 ? `${unread} alerta(s) não lido(s)` : 'Alertas'}
      >
        <Bell className="w-5 h-5" />
        <span className="text-sm font-medium">Alertas</span>

        {unread > 0 && (
          <span
            className="absolute right-2 top-1 text-[10px] leading-none px-1.5 py-1 rounded-full bg-red-600 text-white font-semibold"
            aria-hidden="true"
          >
            {badgeText}
          </span>
        )}
      </button>
    </nav>
  );
}
