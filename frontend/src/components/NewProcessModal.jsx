import React from 'react';

export default function NewProcessModal({ open, processo, onClose, onView }) {
  if (!open) return null;
  const { id, uc, cliente, concessionaria } = processo || {};
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md sap-card overflow-hidden">
        <div className="sap-section-header">
          <h2 className="text-xl font-extrabold">Nova Requisição Criada</h2>
          <p className="text-sm opacity-80">Um novo processo foi registrado e aguarda triagem.</p>
        </div>
        <div className="px-6 py-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="sap-label">ID</span>
            <span className="font-semibold">{id ?? '-'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="sap-label">UC</span>
            <span className="font-semibold">{uc || '-'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="sap-label">Cliente</span>
            <span className="font-semibold">{cliente || '-'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="sap-label">Concessionária</span>
            <span className="sap-chip">{concessionaria || '-'}</span>
          </div>
        </div>
        <div className="px-6 py-4 flex justify-end gap-2 border-t panel-border">
          <button onClick={onClose} className="btn-outline">Fechar</button>
          <button onClick={onView} className="btn-themed">Ver processo</button>
        </div>
      </div>
    </div>
  );
}
