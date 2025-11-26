// src/components/AlertsModal.jsx
import { useEffect, useState } from 'react';
import api from '../services/api';

export default function AlertsModal({ open, onClose }) {
  const [alertas, setAlertas] = useState([]);
  const [selecionados, setSelecionados] = useState(new Set());

  // Util: extrai ID do alerta em qualquer formato vindo do backend
  const getId = (a) => a?.id_alerta ?? a?.id;

  // Carrega alertas quando abrir
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const { data } = await api.get('/alertas'); // retorna lista
        setAlertas(Array.isArray(data) ? data : []);
        setSelecionados(new Set());
      } catch {
        setAlertas([]);
        setSelecionados(new Set());
      }
    })();
  }, [open]);

  if (!open) return null;

  // Classificação: sistema vs gestores (tenta ser tolerante a campos diversos)
  const isSistema = (a) => {
    const t = String(a?.tipo || a?.origem || a?.categoria || '').toLowerCase();
    if (t.includes('sistema')) return true;
    if (t.includes('gestor') || t.includes('usuario') || t.includes('usuário')) return false;
    if (a?.is_sistema === true) return true;
    if (a?.criado_por || a?.usuario || a?.usuario_id || a?.id_usuario_criador) return false;
    return true; // fallback: trata como sistema se não souber
  };

  const sistema = alertas.filter(isSistema);
  const gestores = alertas.filter((a) => !isSistema(a));

  const toggle = (id) => {
    setSelecionados((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const marcarLido = async () => {
    const ids = Array.from(selecionados).filter(Boolean);
    if (!ids.length) return;
    try {
      await api.post('/alertas/marcar-lido', { alerta_ids: ids });
      setAlertas((prev) =>
        prev.map((a) => (ids.includes(getId(a)) ? { ...a, lido: true } : a)),
      );
      setSelecionados(new Set());
      try { window.dispatchEvent(new CustomEvent('alerts:changed')); } catch {}
    } catch {
      // opcional: toast de erro
    }
  };

  const excluir = async () => {
    const ids = Array.from(selecionados).filter(Boolean);
    if (!ids.length) return;
    try {
      await Promise.all(ids.map((id) => api.delete(`/alertas/${id}`)));
      setAlertas((prev) => prev.filter((a) => !ids.includes(getId(a))));
      setSelecionados(new Set());
      try { window.dispatchEvent(new CustomEvent('alerts:changed')); } catch {}
    } catch {
      // opcional: toast de erro
    }
  };

  const renderItem = (a, prefix) => {
    const id = getId(a);
    const dtStr = a?.data_criacao || a?.data || a?.created_at || a?.createdAt;
    const dt = dtStr ? new Date(dtStr) : null;
    const labelData = dt && !isNaN(dt.getTime())
      ? dt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      : '—';
    const msg = a?.mensagem || a?.descricao || a?.titulo || '(sem mensagem)';

    return (
      <li key={`${prefix}-${id}`} style={{ marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
          <input
            type="checkbox"
            checked={selecionados.has(id)}
            onChange={() => toggle(id)}
          />
          <span style={{ opacity: a?.lido ? 0.8 : 1 }}>
            [{labelData}] {msg}
          </span>
        </label>
        <button
          onClick={async () => {
            try {
              await api.delete(`/alertas/${id}`);
              setAlertas((prev) => prev.filter((x) => getId(x) !== id));
              setSelecionados((prev) => { const n = new Set(prev); n.delete(id); return n; });
              try { window.dispatchEvent(new CustomEvent('alerts:changed')); } catch {}
            } catch {}
          }}
          style={{ fontSize: 12, opacity: 0.9, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--fg)' }}
          title="Excluir este alerta"
        >Excluir</button>
      </li>
    );
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: 'var(--card)',
          color: 'var(--fg)',
          padding: 16,
          borderRadius: 8,
          width: 720,
          maxHeight: '80vh',
          overflow: 'auto',
          border: '1px solid var(--border)',
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>Notificações</h3>

        <section style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '8px 0', color: 'var(--accent)' }}>Alertas do Sistema</h4>
          {sistema.length ? (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {sistema.map((a) => renderItem(a, 's'))}
            </ul>
          ) : (
            <div style={{ fontSize: 13, opacity: 0.8 }}>Nenhum alerta do sistema</div>
          )}
        </section>

        <section>
          <h4 style={{ margin: '8px 0', color: 'var(--accent)' }}>Alertas de Gestores</h4>
          {gestores.length ? (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {gestores.map((a) => renderItem(a, 'g'))}
            </ul>
          ) : (
            <div style={{ fontSize: 13, opacity: 0.8 }}>Nenhum alerta de gestores</div>
          )}
        </section>

        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            marginTop: 12,
          }}
        >
          <button
            onClick={marcarLido}
            style={{
              background: 'var(--card)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              padding: '6px 10px',
              borderRadius: 6,
            }}
          >
            Marcar como lido
          </button>
          <button
            onClick={excluir}
            style={{
              background: 'var(--card)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              padding: '6px 10px',
              borderRadius: 6,
            }}
          >
            Excluir
          </button>
          <button
            onClick={onClose}
            style={{
              background: 'var(--border)',
              color: 'var(--fg)',
              padding: '6px 10px',
              borderRadius: 6,
            }}
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
