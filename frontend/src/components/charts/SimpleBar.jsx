// src/components/charts/SimpleBar.jsx
import React, { useMemo } from "react";

/**
 * data: [{ label: 'Ago/2025', total: 12 }, ...]
 * title: string
 * valueFmt: (n) => string (opcional)
 */
export default function SimpleBar({ data = [], title, valueFmt }) {
  const maxValue = useMemo(
    () => Math.max(0, ...(Array.isArray(data) ? data.map(d => Number(d.total) || 0) : [0])),
    [data]
  );

  if (!Array.isArray(data) || data.length === 0) return null;

  return (
    <div className="glass-card gradient-card shadow-medium p-6 rounded-lg border">
      {title && <h3 className="text-xl font-semibold mb-4">{title}</h3>}
      <div className="space-y-3">
        {data.map((item, idx) => {
          const v = Number(item.total) || 0;
          const w = maxValue > 0 ? (v / maxValue) * 100 : 0;
          return (
            <div key={idx} className="flex items-center">
              <div className="w-28 text-sm font-medium opacity-70 truncate">
                {item.label || item.mes || item.cliente}
              </div>
              <div className="flex-1 mx-3">
                <div className="rounded-full h-4 bg-[var(--border)]/40 overflow-hidden">
                  <div
                    className="h-4 rounded-full transition-all duration-500 bg-[var(--accent)]"
                    style={{ width: `${w}%` }}
                  />
                </div>
              </div>
              <div className="w-20 text-sm font-bold text-right">
                {valueFmt ? valueFmt(v) : v}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
