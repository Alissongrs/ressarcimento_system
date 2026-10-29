// Logo oficial do SURE (vetorial). Marca = raio de energia apontando p/ cima
// (energia que volta = ressarcimento), dentro de um "chip"/medidor, em gradiente
// ciano→teal. Use <SureLogo/> (marca + wordmark) ou <SureMark/> (só a marca).
import React, { useId } from 'react';

export function SureMark({ size = 48, glow = true }) {
  const gid = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true"
      style={glow ? { filter: 'drop-shadow(0 0 12px rgba(93,200,255,0.35))' } : undefined}>
      <defs>
        <linearGradient id={gid} x1="12" y1="8" x2="52" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5CC8FF" />
          <stop offset="1" stopColor="#2DD4BF" />
        </linearGradient>
      </defs>
      <rect x="7" y="7" width="50" height="50" rx="15" stroke={`url(#${gid})`} strokeWidth="3.5" />
      <path d="M34 11 L20 34 L28 34 L25 53 L44 28 L35 28 Z" fill={`url(#${gid})`} />
    </svg>
  );
}

export default function SureLogo({ size = 48, wordmark = true, wordSize = 30, color = 'var(--fg, #fff)', gap = 12, glow = true }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap }}>
      <SureMark size={size} glow={glow} />
      {wordmark && (
        <span style={{
          fontFamily: "'Space Grotesk', 'Inter', sans-serif",
          fontWeight: 700, fontSize: wordSize, letterSpacing: '0.16em', color, lineHeight: 1,
        }}>
          SURE
        </span>
      )}
    </span>
  );
}
