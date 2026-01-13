import React, { useState } from 'react';
import { useTheme } from '../context/ThemeContext.jsx';

export default function ThemeSwitcher({ inline = false }) {
  const { setTheme } = useTheme();
  const [open, setOpen] = useState(false);

  const Option = ({ name, value, sample }) => (
    <button
      onClick={() => { setTheme(value); setOpen(false); }}
      className={`flex items-center gap-2 px-3 py-2 rounded text-sm w-full justify-start hover:opacity-90`}
    >
      <span className="inline-flex w-4 h-4 rounded" style={{ background: sample }} />
      {name}
    </button>
  );

  const Menu = () => (
    <div className="space-y-2">
      <Option name="Padrão (Claro D)" value="light-4" sample="linear-gradient(45deg,#ffffff,#e5e7eb)" />
      <Option name="Rosa" value="pink" sample="linear-gradient(45deg,#ffffff,#fbcfe8)" />
      <Option name="Azul" value="azul" sample="linear-gradient(45deg,#ffffff,#bfdbfe)" />
    </div>
  );

  if (inline) {
    return (
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--card)] text-[var(--fg)] hover:text-[var(--accent)]"
          title="Tema"
        >
          Tema
        </button>
        {open && (
          <div className="theme-menu absolute right-0 mt-2 w-40 bg-[var(--card)] text-[var(--fg)] border border-[var(--border)] rounded-lg p-2 shadow-xl z-50">
            <Menu />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="fixed z-50 bottom-4 right-4">
      <div
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="relative"
      >
        <button
          className="px-3 py-2 rounded-full shadow-lg bg-[var(--card)] text-[var(--fg)] border border-[var(--border)] hover:text-[var(--accent)]"
          title="Tema"
        >
          Tema
        </button>
        {open && (
          <div className="theme-menu absolute bottom-12 right-0 w-40 bg-[var(--card)] text-[var(--fg)] border border-[var(--border)] rounded-lg p-2 shadow-xl">
            <Menu />
          </div>
        )}
      </div>
    </div>
  );
}
