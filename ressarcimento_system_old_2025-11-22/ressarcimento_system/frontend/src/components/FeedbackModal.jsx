import React from 'react';

export default function FeedbackModal({ open, onClose, onSubmit }) {
  const [msg, setMsg] = React.useState('');
  React.useEffect(() => { if (!open) setMsg(''); }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md bg-[var(--panel)] text-[var(--fg)] border border-[var(--panel-border)] rounded-lg shadow-lg p-4">
        <h2 className="text-lg font-semibold mb-2">Enviar feedback</h2>
        <p className="text-sm opacity-70 mb-4">Compartilhe sua sugestão ou relato para melhorar o sistema.</p>
        <textarea
          value={msg}
          onChange={e => setMsg(e.target.value)}
          rows={5}
          className="w-full p-2 rounded-md border border-[var(--border)] bg-transparent focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          placeholder="Escreva aqui..."
        />
        <div className="mt-4 flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-2 rounded-md border border-[var(--border)] hover:bg-[var(--border)]/20">Cancelar</button>
          <button
            onClick={() => onSubmit?.(msg)}
            disabled={!msg.trim()}
            className="px-3 py-2 rounded-md bg-[var(--accent)] text-[var(--fg)] disabled:opacity-50"
          >Enviar</button>
        </div>
      </div>
    </div>
  );
}

