import React, { useState } from 'react';
import { useTheme } from '../context/ThemeContext.jsx';

export default function ThemeButton() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);

  const Option = ({ name, value, sample }) => (
    <button
      onClick={() => { setTheme(value); }}
      className={`flex items-center gap-2 px-3 py-2 rounded text-sm w-full justify-start hover:opacity-90 ${theme===value? 'bg-[var(--border)]/30':'bg-transparent'}`}
    >
      <span className="inline-flex w-4 h-4 rounded" style={{ background: sample }} />
      {name}
    </button>
  );

  return (
    <div className="fixed z-[10000] bottom-4 right-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-3 py-2 rounded-full shadow-lg bg-[var(--card)] text-[var(--fg)] border border-[var(--border)] hover:text-[var(--accent)]"
        title="Tema"
      >
        Tema
      </button>
      {open && (
        <div className="absolute bottom-12 right-0 w-44 bg-[var(--card)] text-[var(--fg)] border border-[var(--border)] rounded-lg p-2 space-y-2 shadow-xl z-[10001]">
          <Option name="Escuro" value="dark" sample="#111827" />
          <Option name="Claro (PadrÆo)" value="light" sample="#f3f4f6" />
          <Option name="Claro A" value="light-1" sample="linear-gradient(45deg,#eef2ff,#6366f1)" />
          <Option name="Claro B" value="light-2" sample="linear-gradient(45deg,#ecfdf5,#14b8a6)" />
          <Option name="Claro C" value="light-3" sample="linear-gradient(45deg,#f0f9ff,#0ea5e9)" />
          <Option name="Claro D" value="light-4" sample="linear-gradient(45deg,#f3f4f6,#9ca3af)" />
          <Option name="Rosa" value="pink" sample="linear-gradient(45deg,#fdf2f8,#ec4899)" />
          <Option name="Rosa (Claro)" value="pinklight" sample="linear-gradient(45deg,#fff7fb,#a855f7)" />
          <Option name="SAP" value="sap" sample="linear-gradient(45deg,#f2f3f5,#c6cbd3)" />
          <Option name="Marinho" value="navy" sample="linear-gradient(45deg,#eef2f6,#3b82f6)" />
          <Option name="Laranja + Cinza" value="orange-gray" sample="linear-gradient(45deg,#f5f3ef,#d97706)" />
          <Option name="Verde + Laranja" value="green-orange" sample="linear-gradient(45deg,#ffffff,#2f7d32)" />
          <Option name="Laranja + Roxo + Verde" value="orange-purple-green" sample="linear-gradient(45deg,#f6f4f2,#8b5cf6)" />
        </div>
      )}
    </div>
  );
}
