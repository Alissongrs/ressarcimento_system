// src/components/processos/CanaisSelector.jsx
//
// Seletor de canais (WhatsApp, Ligação, E-mail, SMS, Site, Pessoal).
// Extraído de AdminPlanilha.jsx (linha 1182).
//
import React, { memo } from 'react';
import { CANAIS_UI } from '../../pages/utils/processosHelpers.js';

const CanaisSelector = memo(function CanaisSelector({ canais, onToggle }) {
  return (
    <div className="flex items-center gap-3">
      <img src="/Icones/contato.png" alt="" className="h-16 w-16 object-contain opacity-90" />
      <div className="grid grid-cols-3 gap-2">
        {CANAIS_UI.map(({ key, label }) => {
          const ativo = !!canais?.[key];
          return (
            <button
              key={key}
              type="button"
              className={`sap-chip transition ${ativo ? 'sap-chip--active' : ''}`}
              onClick={() => onToggle(key)}
              title={`Registrar no histórico como ${label}`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
});

export default CanaisSelector;
