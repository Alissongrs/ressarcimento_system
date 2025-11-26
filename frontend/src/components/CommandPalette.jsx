import React, { useEffect, useMemo, useRef, useState } from 'react';

// CommandPalette: Spotlight-style command launcher
// Props: open, onClose, actions [{ id, title, subtitle?, hotkey?, run: fn }]
export default function CommandPalette({ open, onClose, actions = [] }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    const onKey = (e) => {
      if (!open) return;
      if (e.key === 'Escape') { e.preventDefault(); onClose?.(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, filtered.length - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
      if (e.key === 'Enter') { e.preventDefault(); const a = filtered[index]; if (a) { try { a.run(); } finally { onClose?.(); } } }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, index]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => `${a.title} ${a.subtitle || ''}`.toLowerCase().includes(q));
  }, [actions, query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[1000]" aria-modal="true" role="dialog">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute left-1/2 top-24 -translate-x-1/2 w-[92vw] max-w-2xl">
        <div className="rounded-xl shadow-2xl glass-card border border-[var(--border)] overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--panel)]">
            <svg width="16" height="16" viewBox="0 0 24 24" className="opacity-70"><path fill="currentColor" d="M11 18q-2.9 0-4.95-2.05T4 11q0-2.9 2.05-4.95T11 4q2.9 0 4.95 2.05T18 11q0 2.9-2.05 4.95T11 18m7.65 2.75l-4.2-4.2q-.65.375-1.375.563T11 17.3q-3.275 0-5.562-2.288T3.15 9.45q0-3.275 2.288-5.563T11 1.6q3.275 0 5.562 2.288T18.85 9.45q0 1.025-.262 1.963T17.9 13.2l4.225 4.225z"/></svg>
            <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar ação... (↑↓ Enter, Esc)" className="flex-1 bg-transparent outline-none text-[var(--fg)] placeholder:opacity-60"/>
            <div className="text-[10px] opacity-60">Ctrl/Cmd + K</div>
          </div>
          <ul className="max-h-80 overflow-auto bg-[var(--panel)]">
            {filtered.length === 0 && (
              <li className="px-4 py-6 text-sm opacity-70">Nenhuma ação encontrada.</li>
            )}
            {filtered.map((a, i) => (
              <li key={a.id} onMouseEnter={() => setIndex(i)} onClick={() => { try { a.run(); } finally { onClose?.(); } }}
                  className={`px-4 py-3 cursor-pointer ${i === index ? 'bg-[var(--border)]/20' : ''}`}>
                <div className="text-sm">{a.title}</div>
                {a.subtitle && <div className="text-xs opacity-60">{a.subtitle}</div>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

