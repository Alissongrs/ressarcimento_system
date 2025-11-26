// src/components/charts/Donut.jsx
import React, { useMemo } from "react";

/**
 * Aceita:
 *  - data: [{ label, value, color? }, ...]  // seu Dashboard já usa "data"
 *  - rows: idem (alias)
 *  - size?: px
 *  - hole?: 0..1 (fração do raio vazada, default 0.6)
 *  - centerLabel?: string
 */
export default function Donut({ data, rows, size = 180, hole = 0.6, centerLabel }) {
  const items = useMemo(() => {
    const arr = Array.isArray(data) ? data : (Array.isArray(rows) ? rows : []);
    return arr.map((r, idx) => ({ ...r, color: r.color || pickColor(idx) }));
  }, [data, rows]);

  const total = useMemo(() => items.reduce((acc, r) => acc + (Number(r.value) || 0), 0), [items]);

  const bg = useMemo(() => {
    if (!total || items.length === 0) return "conic-gradient(#4b5563 0 100%)";
    let acc = 0;
    const stops = items.map((r) => {
      const pctFrom = (acc / total) * 100;
      acc += Number(r.value) || 0;
      const pctTo = (acc / total) * 100;
      return `${r.color} ${pctFrom}% ${pctTo}%`;
    }).join(", ");
    return `conic-gradient(${stops})`;
  }, [items, total]);

  const inner = Math.max(0, Math.min(0.9, hole));
  const innerInset = `${(1 - inner) * 50}%`;
  const innerSize = `${inner * 100}%`;

  return (
    <div className="relative glass-card gradient-card shadow-medium rounded-lg p-4" style={{ minWidth: size }}>
      <div
        className="relative rounded-full"
        style={{
          width: size,
          height: size,
          background: bg,
          boxShadow: "inset 0 0 0 6px rgba(255,255,255,0.05)",
        }}
      >
        <div
          className="absolute rounded-full bg-[var(--panel,rgba(0,0,0,0.35))]"
          style={{
            inset: innerInset,
            width: innerSize,
            height: innerSize,
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center text-center">
          <div>
            <div className="text-lg font-bold leading-tight">
              {centerLabel ?? total}
            </div>
            {centerLabel && <div className="text-[10px] opacity-70">Total</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function pickColor(i) {
  const palette = [
    "hsl(var(--accent))",
    "hsl(var(--success))",
    "hsl(var(--warning))",
    "hsl(var(--destructive))",
    "hsl(var(--primary))",
    "hsl(var(--secondary))",
    "#8b5cf6", // fallback violet
    "#14b8a6", // fallback teal
  ];
  return palette[i % palette.length];
}
