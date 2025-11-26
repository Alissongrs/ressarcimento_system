// src/components/StatCard.jsx
import React from "react";
import Sparkline from "./charts/Sparkline";

const COLORS = {
  accent:  "border-[var(--accent)] text-[var(--accent)] bg-[color:var(--accent)]/15",
  success: "border-success text-success bg-success/15",
  warning: "border-warning text-warning bg-warning/15",
  danger:  "border-danger  text-danger  bg-danger/15",
  neutral: "border-[var(--border)] text-[var(--fg)] bg-[var(--border)]/10",
};

/**
 * Props:
 * - title, value, subtitle?
 * - color: accent|success|warning|danger|neutral
 * - defHint?: string  (mostra tooltip nativo no hover)
 * - trend?: number[]  (desenha sparkline abaixo do valor)
 */
export default function StatCard({ title, value, subtitle, color = "neutral", defHint, trend }) {
  const styles = COLORS[color] || COLORS.neutral;

  return (
    <div className={`p-4 sm:p-6 rounded-lg border glass-card gradient-card shadow-medium transition-smooth hover:-translate-y-[2px] ${styles}`} title={defHint || ""}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium opacity-75">{title}</h3>
        {defHint && (
          <span
            aria-label="Definição"
            className="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs opacity-75 border border-current"
            title={defHint}
          >
            i
          </span>
        )}
      </div>

      <p className="text-2xl sm:text-3xl font-bold mt-2">{value}</p>
      {trend && Array.isArray(trend) && trend.length > 0 && (
        <div className="mt-2">
          <Sparkline points={trend} height={28} className="opacity-90" />
        </div>
      )}
      {subtitle && <p className="text-sm mt-1 opacity-75">{subtitle}</p>}
    </div>
  );
}
