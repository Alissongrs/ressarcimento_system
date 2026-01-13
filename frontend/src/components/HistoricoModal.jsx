import React, { useEffect, useState } from 'react';
import { X, Clock, User, MessageSquare } from 'lucide-react';
import { getHistoricoById } from '../services/requisicaoService';

export default function HistoricoModal({ isOpen, onClose, processoId, anchorTop }) {
  const [itens, setItens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen || !processoId) return;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const rows = await getHistoricoById(processoId);
        setItens(Array.isArray(rows) ? rows : []);
      } catch (e) {
        setError('Falha ao carregar histórico.');
      } finally {
        setLoading(false);
      }
    })();
  }, [isOpen, processoId]);

  if (!isOpen) return null;

  const topPx = Math.max(16, Math.min(typeof window !== 'undefined' ? (anchorTop ?? 80) : 80, (typeof window !== 'undefined' ? window.innerHeight - 100 : 700)));

  return (
    <div className="fixed inset-0 z-50 bg-black/60" role="dialog" aria-modal="true">
      <div
        className="fixed w-[calc(100%-3rem)] max-w-3xl rounded-xl border border-[var(--border)] bg-[var(--panel)] text-[var(--fg)] shadow-elevated flex flex-col"
        style={{ top: topPx, left: '50%', transform: 'translateX(-50%)', maxHeight: '80vh' }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <h2 className="text-lg font-bold">Histórico do processo REQ-{String(processoId).padStart(3,'0')}</h2>
          <button onClick={onClose} className="p-2 rounded hover:bg-[var(--border)]/20" aria-label="Fechar">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="py-10 text-center opacity-80 sap-loading">Carregando…</div>
          ) : error ? (
            <div className="py-10 text-center text-red-400">{error}</div>
          ) : itens.length === 0 ? (
            <div className="py-10 text-center opacity-80">Nenhuma movimentação encontrada.</div>
          ) : (
            <div className="space-y-4">
              {itens.map((h, idx) => {
                const quando = h?.data_movimentacao || h?.quando || '';
                const usuario = h?.nome_usuario || h?.usuario_nome || '';
                const status = h?.status_composto || h?.status_novo || '';
                const tipo = h?.tipo_movimentacao || '';
                const comentario = h?.comentario || '';
                return (
                  <div key={idx} className="rounded-lg border border-[var(--border)] p-3 bg-[var(--card)]/40">
                    <div className="flex items-center justify-between text-xs opacity-80">
                      <div className="inline-flex items-center gap-1"><Clock size={12} /> {quando || '-'}</div>
                      <div className="inline-flex items-center gap-1"><User size={12} /> {usuario || 'Sistema'}</div>
                    </div>
                    <div className="mt-2 text-sm font-semibold">{status || '—'}</div>
                    {tipo && (
                      <div className="mt-1 text-[11px] opacity-70">Tipo: {tipo}</div>
                    )}
                    {comentario && (
                      <div className="mt-2 text-sm flex items-start gap-2">
                        <MessageSquare size={14} className="opacity-70 mt-0.5" />
                        <div>{comentario}</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-[var(--border)] text-right">
          <button onClick={onClose} className="px-3 py-2 rounded border border-[var(--border)] hover:bg-[var(--border)]/20">Fechar</button>
        </div>
      </div>
    </div>
  );
}

