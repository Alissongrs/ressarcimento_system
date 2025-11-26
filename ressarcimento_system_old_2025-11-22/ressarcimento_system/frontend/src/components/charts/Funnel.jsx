import React, { useMemo } from 'react';

// Simple funnel: bars decreasing top -> bottom with labels and values.
export default function Funnel({ data = [], title }) {
  const rows = Array.isArray(data) ? data : [];
  const max = useMemo(() => Math.max(0, ...rows.map(r => Number(r.total)||0)), [rows]);
  if (rows.length === 0) return null;
  return (
    <div className="glass-card p-6 rounded-lg border">
      {title && <h3 className="text-xl font-semibold mb-4">{title}</h3>}
      <div className="space-y-2">
        {rows.map((r, i) => {
          const val = Number(r.total)||0;
          const w = max>0 ? (val/max)*100 : 0;
          return (
            <div key={i} className="flex items-center">
              <div className="w-32 text-sm opacity-80">{r.label}</div>
              <div className="flex-1">
                <div className="h-6 bg-[var(--border)]/30 rounded-r-full overflow-hidden">
                  <div className="h-6 bg-[var(--accent)] rounded-r-full" style={{width: `${w}%`}} />
                </div>
              </div>
              <div className="w-16 text-right text-sm font-semibold ml-3">{val}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

