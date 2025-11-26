// src/components/charts/TinySparkline.jsx
import React from 'react';

export default function TinySparkline({ points = [], className='' }) {
  if (!points || points.length === 0) return null;
  const w = 160, h = 48, pad = 4;
  const xs = points.map((_, i) => i);
  const ys = points.map(v => v || 0);
  const min = Math.min(...ys), max = Math.max(...ys);
  const scaleX = i => pad + (i * (w - 2*pad)) / (xs.length - 1 || 1);
  const scaleY = v => h - pad - ((v - min) * (h - 2*pad)) / (max - min || 1);

  const d = xs.map((i, idx) => `${idx===0?'M':'L'} ${scaleX(i)} ${scaleY(ys[idx])}`).join(' ');
  return (
    <svg width={w} height={h} className={className}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
