import React, { useState } from 'react';
import { Palette, Check } from 'lucide-react';
import { useTheme } from '../context/ThemeContext.jsx';

const THEME_OPTIONS = [
  { name: 'Navy Escuro', value: 'dark-navy', swatch: 'linear-gradient(135deg,#0c1b2e,#3b82f6)' },
  { name: 'Padrão Claro', value: 'light-4', swatch: 'linear-gradient(135deg,#f5f8ff,#1d4ed8)' },
  { name: 'Azul', value: 'azul', swatch: 'linear-gradient(135deg,#ffffff,#2563eb)' },
  { name: 'SAP', value: 'sap', swatch: 'linear-gradient(135deg,#f2f3f5,#2c6ea3)' },
  { name: 'Marinho', value: 'navy', swatch: 'linear-gradient(135deg,#eef2f6,#3b82f6)' },
  { name: 'Rosa', value: 'pink', swatch: 'linear-gradient(135deg,#ffffff,#ec4899)' },
  { name: 'Laranja + Cinza', value: 'orange-gray', swatch: 'linear-gradient(135deg,#f5f3ef,#d97706)' },
  { name: 'Verde + Laranja', value: 'green-orange', swatch: 'linear-gradient(135deg,#ffffff,#2f7d32)' },
  { name: 'Laranja + Roxo', value: 'orange-purple-green', swatch: 'linear-gradient(135deg,#f6f4f2,#8b5cf6)' },
];

export default function ThemeSwitcher({ inline = false }) {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);

  const Menu = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {THEME_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => { setTheme(opt.value); setOpen(false); }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 10px',
            borderRadius: 6,
            background: theme === opt.value ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'transparent',
            color: 'var(--fg)',
            border: 'none',
            cursor: 'pointer',
            width: '100%',
            textAlign: 'left',
            fontSize: 13,
            fontWeight: theme === opt.value ? 600 : 400,
            transition: 'background 120ms',
          }}
          onMouseEnter={(e) => { if (theme !== opt.value) e.currentTarget.style.background = 'color-mix(in srgb, var(--border) 40%, transparent)'; }}
          onMouseLeave={(e) => { if (theme !== opt.value) e.currentTarget.style.background = 'transparent'; }}
        >
          <span style={{ width: 16, height: 16, borderRadius: 4, background: opt.swatch, flexShrink: 0, border: '1px solid rgba(0,0,0,0.1)' }} />
          <span style={{ flex: 1 }}>{opt.name}</span>
          {theme === opt.value && <Check size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
        </button>
      ))}
    </div>
  );

  if (inline) {
    return (
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 10px', borderRadius: 8,
            border: '1px solid var(--border)',
            background: open ? 'color-mix(in srgb, var(--accent) 12%, var(--card))' : 'var(--card)',
            color: 'var(--fg)',
            cursor: 'pointer',
            fontSize: 13,
          }}
          title="Tema"
        >
          <Palette size={14} />
          <span>Tema</span>
        </button>
        {open && (
          <div style={{
            position: 'absolute', right: 0, marginTop: 6, width: 180,
            background: 'var(--card)', color: 'var(--fg)',
            border: '1px solid var(--border)', borderRadius: 10,
            padding: 6, boxShadow: 'var(--shadow-elevated)', zIndex: 50,
          }}>
            <Menu />
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', zIndex: 50, bottom: 16, right: 16 }}>
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 40, height: 40, borderRadius: '50%',
            boxShadow: 'var(--shadow-elevated)',
            background: 'var(--card)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            cursor: 'pointer',
            transition: 'filter 150ms, transform 150ms',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(1.1)'; e.currentTarget.style.transform = 'scale(1.08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.filter = ''; e.currentTarget.style.transform = ''; }}
          title="Mudar tema"
        >
          <Palette size={16} />
        </button>
        {open && (
          <div style={{
            position: 'absolute', bottom: 48, right: 0, width: 180,
            background: 'var(--card)', color: 'var(--fg)',
            border: '1px solid var(--border)', borderRadius: 10,
            padding: 6, boxShadow: 'var(--shadow-elevated)',
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', opacity: 0.5, padding: '4px 10px 6px', textTransform: 'uppercase' }}>
              Tema
            </div>
            <Menu />
          </div>
        )}
      </div>
    </div>
  );
}
