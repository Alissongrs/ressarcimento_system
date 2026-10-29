import React, { useMemo, useState, useEffect } from 'react';
import { FICHAS_LISTA } from '../data/fichasCatalogo';

/**
 * CatalogoFichasModal — painel de consulta das 61 fichas de erro de faturamento.
 * O analista abre quando tem dúvida sobre o que uma ficha significa e como confirmar
 * se é um caso real. Busca por código/nome/texto e filtro por grupo.
 *
 * Props:
 *   open      (bool)      — controla a visibilidade
 *   onClose   (fn)        — fecha o modal
 *   destacar  (string?)   — código de ficha a destacar/rolar ao abrir (ex.: 'F39')
 */
export default function CatalogoFichasModal({ open, onClose, destacar }) {
  const [q, setQ] = useState('');
  const [grupo, setGrupo] = useState('Todos');

  useEffect(() => {
    if (!open) return;
    const onEsc = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [open, onClose]);

  useEffect(() => { if (open && destacar) setQ(String(destacar)); }, [open, destacar]);

  const grupos = useMemo(
    () => ['Todos', ...Array.from(new Set(FICHAS_LISTA.map(f => f.grupo)))],
    []
  );

  const filtradas = useMemo(() => {
    const t = q.trim().toLowerCase();
    return FICHAS_LISTA.filter(f => {
      if (grupo !== 'Todos' && f.grupo !== grupo) return false;
      if (!t) return true;
      return (
        f.codigo.toLowerCase().includes(t) ||
        f.nome.toLowerCase().includes(t) ||
        f.oque.toLowerCase().includes(t) ||
        f.conferir.toLowerCase().includes(t)
      );
    });
  }, [q, grupo]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.5)',
               display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--bg, #fff)', color: 'var(--fg, #111)', width: 'min(900px, 96vw)',
                 maxHeight: '90vh', borderRadius: 12, display: 'flex', flexDirection: 'column',
                 border: '1px solid color-mix(in srgb, var(--fg) 15%, transparent)', overflow: 'hidden' }}
      >
        {/* Cabeçalho */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid color-mix(in srgb, var(--fg) 12%, transparent)',
                      display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Catálogo de Fichas de Erro</div>
          <div style={{ fontSize: 12, opacity: .6 }}>{FICHAS_LISTA.length} fichas · F01–F61</div>
          <button onClick={onClose}
            style={{ marginLeft: 'auto', border: 'none', background: 'transparent', cursor: 'pointer',
                     fontSize: 22, lineHeight: 1, color: 'var(--fg)' }} aria-label="Fechar">×</button>
        </div>

        {/* Busca + filtro */}
        <div style={{ padding: '10px 18px', display: 'flex', gap: 10, flexWrap: 'wrap',
                      borderBottom: '1px solid color-mix(in srgb, var(--fg) 8%, transparent)' }}>
          <input
            autoFocus value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por código, nome ou palavra (ex.: F52, duplicada, reativo, bandeira)…"
            style={{ flex: '1 1 320px', padding: '8px 10px', borderRadius: 8, fontSize: 13,
                     border: '1px solid color-mix(in srgb, var(--fg) 20%, transparent)',
                     background: 'color-mix(in srgb, var(--fg) 4%, transparent)', color: 'var(--fg)' }}
          />
          <select value={grupo} onChange={(e) => setGrupo(e.target.value)}
            style={{ padding: '8px 10px', borderRadius: 8, fontSize: 13, color: 'var(--fg)',
                     border: '1px solid color-mix(in srgb, var(--fg) 20%, transparent)',
                     background: 'color-mix(in srgb, var(--fg) 4%, transparent)' }}>
            {grupos.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>

        {/* Lista */}
        <div style={{ overflowY: 'auto', padding: '12px 18px', display: 'grid', gap: 10 }}>
          {filtradas.length === 0 && (
            <div style={{ opacity: .6, padding: 20, textAlign: 'center' }}>Nenhuma ficha encontrada.</div>
          )}
          {filtradas.map(f => {
            const hl = destacar && f.codigo === String(destacar).toUpperCase();
            return (
              <div key={f.codigo}
                style={{ border: `1px solid ${hl ? 'var(--accent)' : 'color-mix(in srgb, var(--fg) 12%, transparent)'}`,
                         borderRadius: 10, padding: '10px 12px',
                         background: hl ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--accent)' }}>{f.codigo}</span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{f.nome}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 8px', borderRadius: 99,
                                 background: 'color-mix(in srgb, var(--fg) 8%, transparent)', opacity: .8 }}>{f.grupo}</span>
                </div>
                <div style={{ fontSize: 12.5, marginTop: 6 }}>
                  <span style={{ fontWeight: 700, opacity: .7 }}>O que é: </span>{f.oque}
                </div>
                <div style={{ fontSize: 12.5, marginTop: 4 }}>
                  <span style={{ fontWeight: 700, opacity: .7 }}>Como conferir: </span>{f.conferir}
                </div>
                <div style={{ fontSize: 11, marginTop: 5, opacity: .55 }}>{f.base}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
