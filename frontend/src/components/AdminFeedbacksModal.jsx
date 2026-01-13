import React from 'react';
import { X, User, Clock } from 'lucide-react';
import { listFeedbacks } from '../services/feedbackService';

export default function AdminFeedbacksModal({ open, onClose }) {
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const rows = await listFeedbacks();
        setItems(rows);
      } catch (e) {
        setErr('Falha ao carregar feedbacks.');
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-2xl sap-card text-[var(--fg)] p-5 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-3 pb-3 border-b panel-border">
          <h2 className="text-lg font-semibold">Feedbacks dos usuários</h2>
          <button onClick={onClose} className="btn-outline p-2" aria-label="Fechar">
            <X size={18} />
          </button>
        </div>
        {loading && <div className="opacity-70 sap-loading">Carregando...</div>}
        {err && <div className="text-red-600 mb-3">{err}</div>}
        <div className="flex-1 overflow-auto space-y-3">
          {items.map((it) => (
            <div key={it.id_feedback} className="sap-card p-3">
              <div className="flex flex-wrap items-center gap-3 text-sm opacity-80 mb-2">
                <span className="inline-flex items-center gap-1"><User size={14} /> {it.usuario_nome || `#${it.id_usuario}`}</span>
                <span className="inline-flex items-center gap-1"><Clock size={14} /> {it.created_at}</span>
              </div>
              <div className="text-sm whitespace-pre-wrap">{it.mensagem}</div>
            </div>
          ))}
          {!loading && !err && items.length === 0 && (
            <div className="opacity-70">Nenhum feedback enviado ainda.</div>
          )}
        </div>
      </div>
    </div>
  );
}
