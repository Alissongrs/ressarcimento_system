import React, { useMemo } from 'react';

// BubbleChart expects rows like: [{ label, simples_total, dobro_total, total, qtd, media }]
// x = simples_total, y = dobro_total, size = total (area), color = qtd
export default function BubbleChart({ data = [], title, height = 320 }) {
  const rows = Array.isArray(data) ? data : [];
  const w = 640;
  const h = height;
  const pad = 40;
  const maxX = useMemo(() => Math.max(1, ...rows.map(r => Number(r.simples_total)||0)), [rows]);
  const maxY = useMemo(() => Math.max(1, ...rows.map(r => Number(r.dobro_total)||0)), [rows]);
  const maxS = useMemo(() => Math.max(1, ...rows.map(r => Number(r.total)||0)), [rows]);
  const maxQ = useMemo(() => Math.max(1, ...rows.map(r => Number(r.qtd)||0)), [rows]);
  const toX = (v) => pad + ((Number(v)||0) / maxX) * (w - pad*2);
  const toY = (v) => h - pad - ((Number(v)||0) / maxY) * (h - pad*2);
  const toR = (v) => 6 + 24 * Math.sqrt((Number(v)||0) / maxS);
  const toC = (v) => `hsl(${220 - 180*(Number(v)||0)/maxQ}, 70%, 55%)`;

  if (rows.length === 0) return null;

  return (
    <div className="glass-card p-6 rounded-lg border">
      {title && <h3 className="text-xl font-semibold mb-4">{title}</h3>}
      <div className="overflow-x-auto">
        <svg width={w} height={h}>
          <rect x="0" y="0" width={w} height={h} fill="transparent" />
          {/* axes */}
          <line x1={pad} y1={h-pad} x2={w-pad} y2={h-pad} stroke="var(--border)" />
          <line x1={pad} y1={pad} x2={pad} y2={h-pad} stroke="var(--border)" />
          {/* ticks */}
          {Array.from({length:5}, (_,i)=>i).map(i=>{
            const tx = pad + i*(w - pad*2)/4;
            const val = Math.round((i/4)*maxX);
            return <text key={`xt${i}`} x={tx} y={h-10} fontSize="10" textAnchor="middle" fill="currentColor">{val}</text>
          })}
          {Array.from({length:5}, (_,i)=>i).map(i=>{
            const ty = h - pad - i*(h - pad*2)/4;
            const val = Math.round((i/4)*maxY);
            return <text key={`yt${i}`} x={10} y={ty} fontSize="10" fill="currentColor">{val}</text>
          })}
          {/* bubbles */}
          {rows.map((r, idx) => (
            <g key={idx}>
              <circle cx={toX(r.simples_total)} cy={toY(r.dobro_total)} r={toR(r.total)} fill={toC(r.qtd)} fillOpacity="0.7" />
              <title>{`${r.label}\nS: ${fmt(r.simples_total)}  D: ${fmt(r.dobro_total)}\nTotal: ${fmt(r.total)}  Qtd: ${r.qtd}`}</title>
            </g>
          ))}
        </svg>
      </div>
      <div className="text-xs opacity-70 mt-2">Eixos: x=Crédito Simples, y=Crédito Dobro; Tamanho=Total; Cor=Quantidade</div>
    </div>
  );
}

function fmt(n){ return (Number(n)||0).toLocaleString('pt-BR'); }

