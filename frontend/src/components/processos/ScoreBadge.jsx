// src/components/processos/ScoreBadge.jsx
//
// Score de Progressão Badge — círculo colorido com percentual.
// Extraído de AdminPlanilha.jsx (linha 1054) na Etapa 2b do desacoplamento.
//
import React, { memo } from 'react';

const ScoreBadge = memo(function ScoreBadge({ score }) {
  if (score === undefined || score === null) return <span className="text-xs opacity-40">-</span>;

  if (score?.erro) {
    return <span className="text-[9px] text-red-500 opacity-40">erro</span>;
  }

  const percentage = typeof score === 'number' ? score : score?.percentual || score?.percentage || 0;
  const displayPercent = Math.round(percentage);

  let bgColor = 'bg-gray-300 text-gray-600'; // default/low
  if (displayPercent >= 70) bgColor = 'bg-green-500 text-white'; // high
  else if (displayPercent >= 40) bgColor = 'bg-yellow-500 text-white'; // medium

  return (
    <div
      className={`w-9 h-9 rounded-full flex items-center justify-center text-[10px] font-semibold ${bgColor} opacity-70`}
      title={`Score de Progressão: ${displayPercent}%`}
    >
      {displayPercent}%
    </div>
  );
});

export default ScoreBadge;
