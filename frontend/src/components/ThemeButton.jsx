import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from '../context/ThemeContext.jsx';

export default function ThemeButton() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const timerRef = useRef(null);

  const Option = ({ name, value, sample }) => (
    <button
      onClick={() => { setTheme(value); setOpen(false); }}
      className={`flex items-center gap-2 px-3 py-2 rounded text-sm w-full justify-start hover:opacity-90 ${theme===value? 'bg-[var(--border)]/30':'bg-transparent'}`}
    >
      <span className="inline-flex w-4 h-4 rounded" style={{ background: sample }} />
      {name}
    </button>
  );

  useEffect(() => {
    function onDocClick(e) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    if (open) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setOpen(false), 12000);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [open]);

  return (
    <div className="fixed z-[10000] bottom-4 right-4" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-3 py-2 rounded-full shadow-lg bg-[var(--card)] text-[var(--fg)] border border-[var(--border)] hover:text-[var(--accent)]"
        title="Tema"
      >
        Tema
      </button>
      {open && (
        <div
          className="absolute bottom-12 right-0 w-44 bg-[var(--card)] text-[var(--fg)] border border-[var(--border)] rounded-lg p-2 space-y-2 shadow-xl z-[10001]"
          onMouseEnter={() => { if (timerRef.current) clearTimeout(timerRef.current); }}
          onMouseLeave={() => { if (open) timerRef.current = setTimeout(() => setOpen(false), 8000); }}
        >
          <Option name="Escuro" value="dark" sample="#111827" />
          <Option name="Claro (Padrão)" value="light" sample="#f3f4f6" />
          <Option name="Claro A" value="light-1" sample="linear-gradient(45deg,#eef2ff,#6366f1)" />
          <Option name="Claro B" value="light-2" sample="linear-gradient(45deg,#ecfdf5,#14b8a6)" />
          <Option name="Claro C" value="light-3" sample="linear-gradient(45deg,#f0f9ff,#0ea5e9)" />
          <Option name="Claro D" value="light-4" sample="linear-gradient(45deg,#f3f4f6,#9ca3af)" />
          <Option name="Rosa" value="pink" sample="linear-gradient(45deg,#fdf2f8,#ec4899)" />
          <Option name="Rosa (Claro)" value="pinklight" sample="linear-gradient(45deg,#fff7fb,#a855f7)" />
        </div>
      )}
    </div>
  );
}
