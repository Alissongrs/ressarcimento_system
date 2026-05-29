// src/components/processos/Field.jsx
//
// Campo do drawer com label + hint opcional. Extraído de AdminPlanilha.jsx (linha 1206).
//
import React, { memo } from 'react';

const Field = memo(function Field({ label, hint, children }) {
  return (
    <div className="sap-field">
      <label className="sap-label">{label}</label>
      {children}
      {hint ? <div className="sap-hint">{hint}</div> : null}
    </div>
  );
});

export default Field;
