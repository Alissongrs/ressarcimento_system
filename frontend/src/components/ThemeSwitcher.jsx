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
      <Option name="Escuro A" value="flowtory-dark" sample="linear-gradient(45deg,#0f1624,#6ea8ff)" />
      <Option name="Escuro B" value="dark" sample="#111827" />
      <Option name="Claro (Padrão)" value="light" sample="#f3f4f6" />
      <Option name="Claro A" value="light-1" sample="linear-gradient(45deg,#eef2ff,#6366f1)" />
      <Option name="Claro B" value="light-2" sample="linear-gradient(45deg,#ecfdf5,#14b8a6)" />
      <Option name="Claro C" value="light-3" sample="linear-gradient(45deg,#f0f9ff,#0ea5e9)" />
      <Option name="Claro D" value="light-4" sample="linear-gradient(45deg,#f3f4f6,#9ca3af)" />
      <Option name="Rosa (Claro)" value="pink" sample="#ec4899" />
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
