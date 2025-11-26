import React, { useMemo } from 'react';

// Expects rows: [{ label, total, share_pct, cumulative_pct }]
export default function ParetoChart({ data = [], title, height = 220 }) {
  const rows = Array.isArray(data) ? data : [];
  const maxVal = useMemo(() => Math.max(0, ...rows.map(r => Number(r.total)||0)), [rows]);
  const w = Math.max(360, rows.length * 50);
  const h = height;
  const pad = 30;
  const xStep = rows.length > 0 ? (w - pad*2) / rows.length : 0;
  const barH = (v) => (maxVal>0 ? ((Number(v)||0)/maxVal) * (h - pad*2) : 0);
  const lineY = (pct) => pad + (1 - (Number(pct)||0)/100) * (h - pad*2);
  const path = useMemo(() => {
    if (rows.length === 0) return '';
    return rows.map((r, i) => {
      const x = pad + i * xStep + xStep/2;
      const y = lineY(r.cumulative_pct);
      return `${i===0?'M':'L'} ${x} ${y}`;
    }).join(' ');
  }, [rows, xStep]);

  if (rows.length === 0) return null;

  return (
    <div className="glass-card p-6 rounded-lg border">
      {title && <h3 className="text-xl font-semibold mb-4">{title}</h3>}
      <div className="overflow-x-auto">
        <svg width={w} height={h}>
          <rect x="0" y="0" width={w} height={h} fill="transparent" />
          {/* Bars */}
          {rows.map((r, i) => {
            const x = pad + i * xStep + 6;
            const y = h - pad - barH(r.total);
            return (
              <g key={i}>
                <rect x={x} y={y} width={Math.max(10, xStep-12)} height={barH(r.total)} fill="var(--accent)" opacity="0.8" />
                <title>{`${r.label}: ${fmt(r.total)} (${Number(r.share_pct||0).toFixed(1)}%), cum ${Number(r.cumulative_pct||0).toFixed(1)}%`}</title>
              </g>
            );
          })}
          {/* Pareto line */}
          <path d={path} stroke="#ef4444" strokeWidth="2" fill="none" />
          {/* Right axis (percentage) */}
          {Array.from({ length:5 }, (_,i)=>i*25).map((p,i)=>{
            const y = lineY(p);
            return <text key={i} x={w-24} y={y} fontSize="10" fill="currentColor">{p}%</text>
          })}
        </svg>
      </div>
      <div className="text-xs opacity-70 mt-2">Barras = valor total; Linha vermelha = acumulado (%)</div>
    </div>
  );
}

function fmt(n){ return (Number(n)||0).toLocaleString('pt-BR'); }

