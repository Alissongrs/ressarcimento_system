import React from 'react';

export default function FeedbackModal({ open, onClose, onSubmit }) {
  const [msg, setMsg] = React.useState('');
  React.useEffect(() => { if (!open) setMsg(''); }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md sap-card text-[var(--fg)] p-5">
        <h2 className="text-lg font-semibold mb-2">Enviar feedback</h2>
        <p className="text-sm opacity-70 mb-4">Compartilhe sua sugestão ou relato para melhorar o sistema.</p>
        <label className="sap-label mb-2">Mensagem</label>
        <textarea
          value={msg}
          onChange={e => setMsg(e.target.value)}
          rows={5}
          className="w-full input-themed"
          placeholder="Escreva aqui..."
        />
        <div className="mt-4 flex gap-2 justify-end">
          <button onClick={onClose} className="btn-outline">Cancelar</button>
          <button
            onClick={() => onSubmit?.(msg)}
            disabled={!msg.trim()}
            className="btn-themed disabled:opacity-50"
          >Enviar</button>
        </div>
      </div>
    </div>
  );
}
