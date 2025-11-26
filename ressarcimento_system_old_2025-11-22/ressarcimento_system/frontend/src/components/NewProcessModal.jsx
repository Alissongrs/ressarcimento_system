import React from 'react';

export default function NewProcessModal({ open, processo, onClose, onView }) {
  if (!open) return null;
  const { id, uc, cliente, concessionaria } = processo || {};
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl shadow-2xl overflow-hidden" style={{ background: 'var(--panel)', color: 'var(--fg)', border: '1px solid var(--panel-border)' }}>
        <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--panel-border)' }}>
          <h2 className="text-xl font-extrabold">Nova Requisição Criada</h2>
          <p className="text-sm opacity-80">Um novo processo foi registrado e aguarda triagem.</p>
        </div>
        <div className="px-6 py-5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm opacity-70">ID</span>
            <span className="font-semibold">{id ?? '-'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm opacity-70">UC</span>
            <span className="font-semibold">{uc || '-'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm opacity-70">Cliente</span>
            <span className="font-semibold">{cliente || '-'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm opacity-70">Concessionária</span>
            <span className="text-[11px] px-2 py-0.5 rounded border" style={{ borderColor: 'var(--panel-border)' }}>{concessionaria || '-'}</span>
          </div>
        </div>
        <div className="px-6 py-4 flex justify-end gap-2 border-t" style={{ borderColor: 'var(--panel-border)' }}>
          <button onClick={onClose} className="px-4 py-2 rounded-md hover:opacity-90" style={{ background: 'var(--panel-bg-60)' }}>Fechar</button>
          <button onClick={onView} className="px-4 py-2 rounded-md text-white hover:opacity-90" style={{ background: '#2563EB' }}>Ver processo</button>
        </div>
      </div>
    </div>
  );
}

