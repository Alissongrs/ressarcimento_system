// src/components/charts/HeatmapWeek.jsx
import React, { useMemo } from "react";

/**
 * Heatmap Semana × Hora.
 * Espera data no formato flexível (qualquer um destes campos):
 *   [{ day|dia: 0..6 (0=Dom), hour|hora: 0..23, count|total|qtd: number }, ...]
 */
export default function HeatmapWeek({ data = [] }) {
  const norm = (v) => (v ?? 0);
  const normRows = Array.isArray(data) ? data.map((r) => ({
    day:  toDayIndex(r.day ?? r.dia),
    hour: clamp(0, 23, Number(r.hour ?? r.hora ?? 0)),
    val:  Number(r.count ?? r.total ?? r.qtd ?? 0),
  })) : [];

  const matrix = useMemo(() => {
    // ordem: Seg(1)..Dom(0) para UX pt-BR
    const order = [1,2,3,4,5,6,0];
    const m = order.map((d) => Array(24).fill(0));
    for (const r of normRows) {
      const row = order.indexOf(clamp(0,6,r.day));
      if (row >= 0) m[row][r.hour] += r.val;
    }
    return m;
  }, [normRows]);

  const max = useMemo(() => {
    let m = 0;
    matrix.forEach((row) => row.forEach((v) => { if (v > m) m = v; }));
    return m || 1;
  }, [matrix]);

  const dayLabels = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
  const hourLabels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}h`);

  return (
    <div className="w-full">
      {/* Cabeçalho de horas */}
      <div className="grid" style={{ gridTemplateColumns: `64px repeat(24, minmax(0, 1fr))`}}>
        <div />
        {hourLabels.map((h, i) => (
          <div key={i} className="text-[10px] text-center opacity-60">{(i % 2 === 0) ? h : ""}</div>
        ))}
      </div>

      {/* Grade */}
      <div className="grid gap-[2px] mt-1" style={{ gridTemplateColumns: `64px repeat(24, minmax(0, 1fr))`}}>
        {matrix.map((row, r) => (
          <React.Fragment key={r}>
            <div className="text-xs pr-2 text-right opacity-70 leading-6">{dayLabels[r]}</div>
            {row.map((v, c) => (
              <div
                key={c}
                className="h-6 rounded-sm"
                title={`${dayLabels[r]} ${hourLabels[c]} • ${v}`}
                style={{
                  background:
                    v === 0
                      ? "rgba(148,163,184,0.15)" // slate-400/15
                      : `rgba(59,130,246,${0.15 + 0.85 * (v / max)})`, // azul com intensidade
                  border: "1px solid rgba(148,163,184,0.15)",
                }}
              />
            ))}
          </React.Fragment>
        ))}
      </div>

      {/* Legenda */}
      <div className="flex items-center gap-2 mt-3 text-xs opacity-70">
        <span>Baixo</span>
        <div className="flex-1 h-2 bg-gradient-to-r from-[rgba(148,163,184,0.15)] to-[rgba(59,130,246,1)] rounded" />
        <span>Alto</span>
      </div>
    </div>
  );
}

function toDayIndex(d) {
  const n = Number(d);
  if (Number.isFinite(n)) return clamp(0, 6, n);
  const map = { dom:0, seg:1, ter:2, qua:3, qui:4, sex:5, sab:6, sáb:6 };
  return map[String(d).toLowerCase().slice(0,3)] ?? 0;
}
function clamp(a,b,x){ return Math.max(a, Math.min(b, x)); }
