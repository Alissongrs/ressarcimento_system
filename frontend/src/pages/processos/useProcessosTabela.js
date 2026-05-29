// src/pages/processos/useProcessosTabela.js
//
// Hook que gerencia o state da tabela de processos:
// - processColWidths (com persistência em localStorage)
// - processResizeRef (resize por arraste)
// - processSort (ordenação por coluna)
// - effects: mousemove/mouseup para resize + persist no localStorage
//
// Extraído de AdminPlanilha.jsx — Etapa 2d.2c.
//
import { useEffect, useRef, useState } from 'react';
import { PROCESS_LIST_COLUMNS } from '../utils/processosHelpers.js';

const STORAGE_KEY = 'controleprocessos_colwidths_v2';
const DEFAULT_WIDTHS = [90, 280, 180, 220, 240, 200, 170, 120, 50];

export default function useProcessosTabela() {
  const [processColWidths, setProcessColWidths] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed) && parsed.length === PROCESS_LIST_COLUMNS.length) return parsed;
    } catch {}
    return DEFAULT_WIDTHS;
  });
  const processResizeRef = useRef({ idx: -1, startX: 0, startW: 0 });
  const [processSort, setProcessSort] = useState({ key: 'ultima', dir: 'desc' });

  useEffect(() => {
    const handleMove = (e) => {
      const ref = processResizeRef.current;
      if (ref.idx < 0) return;
      const dx = e.clientX - ref.startX;
      setProcessColWidths((prev) => {
        const next = [...prev];
        next[ref.idx] = Math.max(80, ref.startW + dx);
        return next;
      });
    };
    const handleUp = () => {
      processResizeRef.current.idx = -1;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(processColWidths));
    } catch {}
  }, [processColWidths]);

  return {
    processColWidths,
    setProcessColWidths,
    processResizeRef,
    processSort,
    setProcessSort,
  };
}
