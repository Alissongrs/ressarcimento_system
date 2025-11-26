import React from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { SkeletonLine } from '../components/Skeleton.jsx';
import api from '../services/api';
import Toast from '../components/Toast.jsx';
import { Clock, User, Layers, GitCompare } from 'lucide-react';
import { brDateTime } from '../utils/datetime';

export default function HomeGestorAdmin() {
  const { user } = useAuth();
  const isAdmin = String(user?.tipo_conta || '').toLowerCase() === 'admin';
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState('');
  const [toast, setToast] = React.useState({ open: false, type: 'info', text: '' });

  React.useEffect(() => {
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const { data } = await api.get('/dashboard/changes-24h');
        const rows = Array.isArray(data) ? data : [];
        rows.sort((a, b) => {
          const da = new Date(a?.data_movimentacao || a?.data || a?.created_at || 0).getTime();
          const db = new Date(b?.data_movimentacao || b?.data || b?.created_at || 0).getTime();
          return db - da; // mais recente primeiro
        });
        setItems(rows);
      } catch (e) {
        setErr('Falha ao carregar movimentações.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="p-4 md:p-6 bg-background text-foreground min-h-screen">
      {/* Avisos de manutenção/atualização (hoje) */}
      <div className="mb-4 rounded-xl border-2 shadow-elevated" style={{ background:'var(--panel)', borderColor:'var(--warning)' }}>
        <div className="px-4 py-3">
          <div className="text-lg font-extrabold" style={{ color:'var(--warning)' }}>Avisos de Hoje (Horário de Brasília)</div>
          <ul className="mt-2 space-y-1 text-sm">
            <li>
              <strong style={{ color:'var(--accent)' }}>10:20</strong> — Todos os dias teremos manutenção da base de consulta. Serviços de consulta podem oscilar neste horário.
            </li>
            <li>
              <strong style={{ color:'var(--accent)' }}>15:00</strong> — Atualização de funcionalidades de processos. Novas melhorias serão aplicadas.
            </li>
          </ul>
        </div>
      </div>
      <div className="rounded-xl shadow-elevated p-4 mb-6 border-2" style={{ background:'var(--header-bg)', borderColor:'var(--header-border)', color:'var(--header-fg)' }}>
        <h1 className="text-xl font-extrabold tracking-tight">Movimentações (últimas 24h)</h1>
        <p className="opacity-90 text-sm">Quem fez, em qual processo e o que mudou.</p>
      </div>

      {loading && (
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-md border border-[var(--border)] bg-[var(--panel)] gradient-card shadow-medium p-3">
              <div className="flex gap-3 mb-2">
                <SkeletonLine width="20%" />
                <SkeletonLine width="15%" />
                <SkeletonLine width="25%" />
              </div>
              <SkeletonLine width="60%" />
            </div>
          ))}
        </div>
      )}
      {err && <div className="text-red-600 mb-3">{err}</div>}

      <div className="space-y-3">
        {!loading && items.map((it) => (
          <div key={it.id_historico} className="rounded-md border border-[var(--border)] bg-[var(--panel)] text-[var(--fg)] gradient-card shadow-medium p-3">
            <div className="flex flex-wrap items-center gap-3 text-sm opacity-80 mb-2">
              <span className="inline-flex items-center gap-1"><User size={14} /> {it.usuario_nome || '—'}</span>
              <span className="inline-flex items-center gap-1"><Layers size={14} /> Proc #{it.id_processo}</span>
              <span className="inline-flex items-center gap-1"><Clock size={14} /> {brDateTime(it.data_movimentacao || it.data || it.created_at)}</span>
              {isAdmin && (
                <button
                  onClick={async () => {
                    if (!confirm(`Excluir histórico #${it.id_historico}? Esta ação é irreversível.`)) return;
                    try {
                      // Use caminho absoluto (ignora baseURL do axios) para evitar duplicação de prefixo
                      await api.delete(`/api/v1/admin/historico/${it.id_historico}`, { baseURL: '' });
                      setItems((prev) => prev.filter((x) => x.id_historico !== it.id_historico));
                      setToast({ open: true, type: 'success', text: `Histórico #${it.id_historico} excluído.` });
                    } catch (e) {
                      setToast({ open: true, type: 'error', text: 'Falha ao excluir histórico.' });
                    }
                  }}
                  className="ml-auto px-2 py-1 text-xs border rounded hover:bg-[var(--border)]/20"
                  title="Excluir histórico (Admin)"
                >Excluir</button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1"><GitCompare size={14} />
                {it.status_anterior || '—'} → {it.status_novo || '—'} | {it.etapa_anterior || '—'} → {it.etapa_nova || '—'}
                {it.sub_etapa ? ` (${it.sub_etapa})` : ''}
              </span>
            </div>
            {it.comentario && (
              <div className="mt-2 text-sm opacity-90">
                <span className="opacity-70">Comentário:</span> {it.comentario}
              </div>
            )}
          </div>
        ))}
        {!loading && !err && items.length === 0 && (
          <div className="opacity-70">Nenhuma movimentação registrada nas últimas 24 horas.</div>
        )}
      </div>
      <Toast open={toast.open} type={toast.type} message={toast.text} onClose={() => setToast((t) => ({ ...t, open: false }))} />
    </div>
  );
}
