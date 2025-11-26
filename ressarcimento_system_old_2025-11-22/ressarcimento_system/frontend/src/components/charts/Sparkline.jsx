// src/components/charts/Sparkline.jsx
import React, { useMemo } from "react";

/**
 * Pequeno gráfico de linha em SVG.
 * Props:
 *  - points: number[]
 *  - width?: number (default 140)
 *  - height?: number (default 30)
 *  - className?: string
 */
export default function Sparkline({ points = [], width = 140, height = 30, className = "" }) {
  const { pathD, min, max } = useMemo(() => {
    if (!points || points.length === 0) {
      return { pathD: "", min: 0, max: 0 };
    }
    const minVal = Math.min(...points);
    const maxVal = Math.max(...points);
    const span = maxVal - minVal || 1;
    const stepX = width / Math.max(1, points.length - 1);

    const toY = (v) => height - ((v - minVal) / span) * height;
    let d = "";
    points.forEach((v, i) => {
      const x = i * stepX;
      const y = toY(v);
      d += i === 0 ? `M ${x},${y}` : ` L ${x},${y}`;
    });
    return { pathD: d, min: minVal, max: maxVal };
  }, [points, width, height]);

  if (!pathD) return null;

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} className={className}>
      <path d={pathD} fill="none" stroke="currentColor" strokeWidth="2" />
      {/* preenchimento sutil abaixo da linha */}
      <path
        d={`${pathD} L ${width},${height} L 0,${height} Z`}
        fill="currentColor"
        opacity="0.12"
      />
      <title>{`min: ${min} | max: ${max}`}</title>
    </svg>
  );
}
