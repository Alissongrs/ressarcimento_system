import React, { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import AlertsModal from './AlertsModal';
import api from '../services/api';

export default function NavBell() {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);

  const refresh = async () => {
    try {
      const { data } = await api.get('/alertas', { params: { overdue: 1, unread: 1 }});
      setCount(Array.isArray(data) ? data.length : 0);
    } catch (_) {}
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000); // atualiza a cada minuto
    const onChanged = () => refresh();
    try { window.addEventListener('alerts:changed', onChanged); } catch {}
    return () => { clearInterval(id); try { window.removeEventListener('alerts:changed', onChanged); } catch {} };
  }, []);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="relative p-2 rounded-xl hover:bg-neutral-800/40 transition"
        title="Alertas"
      >
        <Bell className="w-5 h-5" />
        {count > 0 && (
          <span className="absolute -top-1 -right-1 text-xs px-1.5 py-0.5 rounded-full bg-red-600 text-white">
            {count}
          </span>
        )}
      </button>
      {open && <AlertsModal onClose={() => { setOpen(false); refresh(); }} />}
    </>
  );
}
