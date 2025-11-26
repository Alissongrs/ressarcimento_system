import React from 'react';
import { listFeedbacks } from '../services/feedbackService';
import { User, Clock } from 'lucide-react';

export default function AdminFeedbacks() {
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const rows = await listFeedbacks();
        setItems(rows);
      } catch (e) { setErr('Falha ao carregar feedbacks.'); }
      finally { setLoading(false); }
    })();
  }, []);

  return (
    <div className="p-4 md:p-6">
      <h1 className="text-2xl font-semibold mb-1">Feedbacks dos usuários</h1>
      <p className="opacity-70 mb-4">Somente administradores.</p>
      {loading && <div className="opacity-70">Carregando...</div>}
      {err && <div className="text-red-600 mb-3">{err}</div>}
      <div className="space-y-3">
        {items.map((it) => (
          <div key={it.id_feedback} className="rounded-md border border-[var(--border)] bg-[var(--panel)] text-[var(--fg)] p-3">
            <div className="flex flex-wrap items-center gap-3 text-sm opacity-80 mb-2">
              <span className="inline-flex items-center gap-1"><User size={14} /> {it.usuario_nome || `#${it.id_usuario}`}</span>
              <span className="inline-flex items-center gap-1"><Clock size={14} /> {it.created_at}</span>
            </div>
            <div className="text-sm whitespace-pre-wrap">{it.mensagem}</div>
          </div>
        ))}
        {!loading && items.length === 0 && (
          <div className="opacity-70">Nenhum feedback enviado ainda.</div>
        )}
      </div>
    </div>
  );
}

