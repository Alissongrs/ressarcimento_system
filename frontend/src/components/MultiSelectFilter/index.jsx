// MultiSelectFilter — dropdown leve com checkboxes pra filtros multi-seleção.
// Uso:
//   <MultiSelectFilter
//     label="Status"
//     options={[{value: 1, label: 'Em análise'}, ...]}
//     selected={[1, 3]}
//     onChange={(arr) => setFiltroStatus(arr)}
//   />
//
// Botão mostra "Status (Todos)" ou "Status: X selecionado(s)". Ao clicar abre
// painel absoluto com lista de checkboxes; ESC ou clique fora fecha.

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';

export default function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  title,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    // 'click' (não 'mousedown') pra evitar fechar antes do onChange do checkbox processar
    const handler = (e) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target)) setOpen(false);
    };
    const esc = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', handler);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('click', handler);
      document.removeEventListener('keydown', esc);
    };
  }, []);

  const sel = Array.isArray(selected) ? selected : [];
  const total = sel.length;
  const isAll = total === 0;

  const toggle = (val) => {
    if (sel.includes(val)) {
      onChange(sel.filter((x) => x !== val));
    } else {
      onChange([...sel, val]);
    }
  };
  const clear = (e) => {
    e.stopPropagation();
    onChange([]);
  };

  // Label do botão: "Status (Todos)" ou "Status (3)" ou "Status: Em análise"
  const labelTexto = isAll
    ? `${label} (Todos)`
    : total === 1
      ? `${label}: ${options.find((o) => String(o.value) === String(sel[0]))?.label || ''}`
      : `${label} (${total})`;

  return (
    <div className="cpv2-msf" ref={ref} title={title}>
      <button
        type="button"
        className={`cpv2-msf__btn ${!isAll ? 'is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cpv2-msf__lbl">{labelTexto}</span>
        {!isAll && (
          <span
            className="cpv2-msf__clear"
            onClick={clear}
            title="Limpar seleção"
            role="button"
            tabIndex={-1}
          >
            <X size={11} />
          </span>
        )}
        <ChevronDown size={12} className="cpv2-msf__chev" />
      </button>
      {open && (
        <div
          className="cpv2-msf__pop"
          onClick={(e) => e.stopPropagation()}
        >
          {options.length === 0 ? (
            <div className="cpv2-msf__empty">Sem opções</div>
          ) : (
            options.map((o) => {
              const checked = sel.map(String).includes(String(o.value));
              return (
                <label
                  key={String(o.value)}
                  className="cpv2-msf__opt"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(o.value)}
                  />
                  <span>{o.label}</span>
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
