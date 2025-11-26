import React, { useMemo } from 'react';

export default function LineChart({ data = [], title, height = 160 }) {
  const points = Array.isArray(data) ? data.map((d, i) => ({ x: i, y: Number(d.total) || 0, label: d.label })) : [];
  const max = useMemo(() => Math.max(0, ...points.map(p => p.y)), [points]);
  const min = 0;
  const w = Math.max(300, points.length * 40);
  const h = height;
  const path = useMemo(() => {
    if (points.length === 0) return '';
    const step = points.length > 1 ? (w - 20) / (points.length - 1) : 0;
    const toY = (y) => h - 20 - (max > min ? ((y - min) / (max - min)) * (h - 40) : 0);
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${10 + i*step} ${toY(p.y)}`).join(' ');
  }, [points, w, h, max, min]);

  return (
    <div className="glass-card gradient-card shadow-medium p-6 rounded-lg border">
      {title && <h3 className="text-xl font-semibold mb-4">{title}</h3>}
      <div className="overflow-x-auto">
        <svg width={w} height={h}>
          <rect x="0" y="0" width={w} height={h} fill="transparent" />
          <path d={path} fill="none" stroke="hsl(var(--accent))" strokeWidth="2" />
        </svg>
      </div>
    </div>
  );
}
