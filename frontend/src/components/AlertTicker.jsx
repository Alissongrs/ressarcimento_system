import React from 'react';
import { AlertTriangle, CalendarClock } from 'lucide-react';
import { listAlertas } from '../services/alertaService.js';

function uniqueById(rows = []) {
  const seen = new Set();
  return rows.filter((row) => {
    const id = String(row?.id_alerta ?? row?.id ?? '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export default function AlertTicker() {
  const [items, setItems] = React.useState([]);

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      const [overdue, today] = await Promise.all([
        listAlertas({ overdue: 1, unread: 1 }),
        listAlertas({ due: 'today', unread: 1 }),
      ]);
      if (!alive) return;
      setItems(uniqueById([...(overdue || []), ...(today || [])]).slice(0, 12));
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!items.length) return null;

  const marqueeItems = [...items, ...items];

  return (
    <div
      className="border-b px-4 py-2 overflow-hidden"
      style={{ background: 'linear-gradient(90deg, rgba(220,38,38,0.08), rgba(245,158,11,0.08))', borderColor: 'var(--border)' }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="inline-flex items-center gap-2 text-xs font-semibold text-red-500 shrink-0">
          <AlertTriangle size={14} />
          Prazos e alertas
        </div>
        <div className="overflow-hidden min-w-0 flex-1">
          <div
            className="flex gap-8 whitespace-nowrap"
            style={{ width: 'max-content', animation: 'alertTickerScroll 32s linear infinite' }}
          >
            {marqueeItems.map((item, index) => (
              <div key={`${item.id_alerta ?? item.id}-${index}`} className="inline-flex items-center gap-2 text-xs opacity-80">
                <CalendarClock size={13} className="text-amber-500" />
                <span>
                  {item.id_processo ? `PROC-${String(item.id_processo).padStart(3, '0')} · ` : ''}
                  {item.mensagem}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <style>{`
        @keyframes alertTickerScroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  );
}
