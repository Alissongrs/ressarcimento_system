import React, { useState } from 'react';
import { useTheme } from '../context/ThemeContext.jsx';

export default function ThemeSwitcher({ inline = false }) {
  const { setTheme } = useTheme();
  const [open, setOpen] = useState(false);

  const Option = ({ name, value, sample }) => (
    <button
      onClick={() => { setTheme(value); }}
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
      <Option name="SAP" value="sap" sample="linear-gradient(45deg,#f2f3f5,#c6cbd3)" />
      <Option name="Marinho" value="navy" sample="linear-gradient(45deg,#eef2f6,#3b82f6)" />
      <Option name="Laranja + Cinza" value="orange-gray" sample="linear-gradient(45deg,#f5f3ef,#d97706)" />
      <Option name="Verde + Laranja" value="green-orange" sample="linear-gradient(45deg,#ffffff,#2f7d32)" />
      <Option name="Laranja + Roxo + Verde" value="orange-purple-green" sample="linear-gradient(45deg,#f6f4f2,#8b5cf6)" />
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
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
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
