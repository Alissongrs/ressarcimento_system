import React, { useEffect, useMemo, useRef, useState } from 'react';

// CommandPalette: Spotlight-style command launcher with live DB search support
// Props: open, onClose, actions [], query (controlled), onQueryChange, dbActions [], dbLoading
export default function CommandPalette({ open, onClose, actions = [], query: queryProp, onQueryChange, dbActions = [], dbLoading = false }) {
  const [queryInternal, setQueryInternal] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);
  const controlled = onQueryChange != null;
  const query = controlled ? (queryProp ?? '') : queryInternal;
  const setQuery = controlled ? onQueryChange : setQueryInternal;

  useEffect(() => {
    if (open) {
      if (!controlled) setQueryInternal('');
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open, controlled]);

  const filteredActions = useMemo(() => {
    const q = (query || '').trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => `${a.title} ${a.subtitle || ''}`.toLowerCase().includes(q));
  }, [actions, query]);

  const allItems = useMemo(() => [
    ...dbActions.map((a) => ({ ...a, _section: 'db' })),
    ...filteredActions.map((a) => ({ ...a, _section: 'cmd' })),
  ], [dbActions, filteredActions]);

  useEffect(() => { setIndex(0); }, [query]);

  useEffect(() => {
    const onKey = (e) => {
      if (!open) return;
      if (e.key === 'Escape') { e.preventDefault(); onClose?.(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, allItems.length - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
      if (e.key === 'Enter') {
        e.preventDefault();
        const a = allItems[index];
        if (a) { try { a.run(); } finally { onClose?.(); } }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, index, allItems, onClose]);

  if (!open) return null;

  const isSearching = dbLoading && (query || '').trim().length >= 3;
  const hasDb = dbActions.length > 0;
  const hasCmd = filteredActions.length > 0;
  const showDbSection = hasDb || isSearching;

  return (
    <div className="fixed inset-0 z-[1000]" aria-modal="true" role="dialog">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute left-1/2 top-24 -translate-x-1/2 w-[92vw] max-w-2xl">
        <div className="rounded-xl shadow-2xl glass-card border border-[var(--border)] overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--panel)]">
            {isSearching
              ? <div className="w-4 h-4 border-2 border-[var(--fg)] border-t-transparent rounded-full animate-spin opacity-60 shrink-0" />
              : <svg width="16" height="16" viewBox="0 0 24 24" className="opacity-60 shrink-0"><path fill="currentColor" d="M11 18q-2.9 0-4.95-2.05T4 11q0-2.9 2.05-4.95T11 4q2.9 0 4.95 2.05T18 11q0 2.9-2.05 4.95T11 18m7.65 2.75l-4.2-4.2q-.65.375-1.375.563T11 17.3q-3.275 0-5.562-2.288T3.15 9.45q0-3.275 2.288-5.563T11 1.6q3.275 0 5.562 2.288T18.85 9.45q0 1.025-.262 1.963T17.9 13.2l4.225 4.225z"/></svg>
            }
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar processo, ação... (↑↓ Enter, Esc)"
              className="flex-1 bg-transparent outline-none text-[var(--fg)] placeholder:opacity-60"
            />
            <div className="text-[10px] opacity-50">Ctrl/Cmd + K</div>
          </div>
          <ul className="max-h-96 overflow-auto bg-[var(--panel)]">
            {showDbSection && (
              <li className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider opacity-50 select-none sticky top-0 bg-[var(--panel)]">
                Processos
              </li>
            )}
            {isSearching && !hasDb && (
              <li className="px-4 py-3 text-sm opacity-50">Buscando...</li>
            )}
            {allItems.map((a, i) => {
              const prevSection = i > 0 ? allItems[i - 1]._section : null;
              const sectionChanged = a._section !== prevSection;
              return (
                <React.Fragment key={a.id}>
                  {sectionChanged && a._section === 'cmd' && showDbSection && (
                    <li className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider opacity-50 border-t border-[var(--border)] select-none sticky top-0 bg-[var(--panel)]">
                      Ações
                    </li>
                  )}
                  <li
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => { try { a.run(); } finally { onClose?.(); } }}
                    className={`px-4 py-3 cursor-pointer ${i === index ? 'bg-[var(--border)]/20' : ''}`}
                  >
                    <div className="text-sm">{a.title}</div>
                    {a.subtitle && <div className="text-xs opacity-60">{a.subtitle}</div>}
                  </li>
                </React.Fragment>
              );
            })}
            {allItems.length === 0 && !isSearching && (
              <li className="px-4 py-6 text-sm opacity-70">
                {(query || '').trim().length >= 3 ? 'Nenhum resultado encontrado.' : 'Nenhuma ação encontrada.'}
              </li>
            )}
            {!hasCmd && !showDbSection && (query || '').trim().length === 0 && actions.length === 0 && (
              <li className="px-4 py-6 text-sm opacity-70">Nenhuma ação disponível.</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
