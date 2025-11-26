import React, { useEffect } from 'react';

export default function NewProcessToast({ open, processo, onClose, onView, timeout = 6000 }) {
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => onClose?.(), timeout);
    return () => clearTimeout(id);
  }, [open, timeout, onClose]);

  if (!open) return null;
  const { uc, cliente, concessionaria } = processo || {};

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <div className="rounded-xl shadow-2xl border p-4 w-80 panel-bg-80" style={{ background: 'var(--panel)', color: 'var(--fg)', borderColor: 'var(--panel-border)' }}>
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-2 h-2 mt-1 rounded-full bg-[var(--accent)]"></div>
          <div className="flex-1">
            <p className="text-sm font-semibold">Nova Requisição Criada</p>
            <div className="mt-1 text-xs opacity-80 space-y-0.5">
              <div className="flex justify-between"><span>UC</span><span className="font-medium">{uc || '-'}</span></div>
              <div className="flex justify-between"><span>Cliente</span><span className="font-medium">{cliente || '-'}</span></div>
              <div className="flex justify-between"><span>Concessionária</span><span className="font-medium">{concessionaria || '-'}</span></div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-1 rounded-md text-xs hover:opacity-90" style={{ background: 'var(--panel-bg-60)' }}>Fechar</button>
              <button onClick={onView} className="px-3 py-1 rounded-md text-xs text-white hover:opacity-90" style={{ background: '#2563EB' }}>Ver</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

