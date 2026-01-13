import React from 'react';
import { X, AlertTriangle, CalendarDays } from 'lucide-react';
import { getUnreadAlertas } from '../services/alertaService';

function sameYMD(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

export default function AlertasVencimentoModal({ open, onClose }) {
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [dueToday, setDueToday] = React.useState([]);
  const [dueTomorrow, setDueTomorrow] = React.useState([]);
  const [overdueYesterday, setOverdueYesterday] = React.useState([]);

  React.useEffect(() => {
    if (!open) return;
    (async () => {
      setLoading(true); setErr('');
      try {
        const rows = await getUnreadAlertas();
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const tPlus1 = addDays(today, 1);
        const tMinus1 = addDays(today, -1);
        const ds = (s) => s ? new Date(s) : null;

        const withDate = rows.filter(r => r.data_alerta);
        setDueToday(withDate.filter(r => sameYMD(ds(r.data_alerta), today)));
        setDueTomorrow(withDate.filter(r => sameYMD(ds(r.data_alerta), tPlus1)));
        setOverdueYesterday(withDate.filter(r => sameYMD(ds(r.data_alerta), tMinus1)));
      } catch (e) {
        setErr('Falha ao obter alertas de vencimento.');
      } finally { setLoading(false); }
    })();
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-3xl sap-card text-[var(--fg)] p-5 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-3 pb-3 border-b panel-border">
          <h2 className="text-lg font-semibold inline-flex items-center gap-2"><AlertTriangle size={18} /> Alertas de vencimento</h2>
          <button onClick={onClose} className="btn-outline p-2" aria-label="Fechar">
            <X size={18} />
          </button>
        </div>
        {loading && <div className="opacity-70 sap-loading">Carregando...</div>}
        {err && <div className="text-red-600 mb-3">{err}</div>}
        <div className="flex-1 overflow-auto space-y-4">
          <Section title="Vencem hoje" items={dueToday} emptyMsg="Nenhum alerta para hoje." />
          <Section title="Faltam 1 dia" items={dueTomorrow} emptyMsg="Nenhum alerta para amanhã." />
          <Section title="Atrasados (1 dia)" items={overdueYesterday} emptyMsg="Nenhum alerta atrasado de ontem." />
        </div>
        <div className="mt-3 flex justify-end">
          <button onClick={onClose} className="btn-themed">OK</button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, items, emptyMsg }) {
  return (
    <div className="sap-section">
      <div className="sap-section-header text-sm font-semibold inline-flex items-center gap-2">
        <CalendarDays size={14} /> {title}
      </div>
      <div className="p-3 space-y-2">
        {items.map(it => (
          <div key={it.id_alerta} className="sap-card p-3 text-sm">
            <div className="opacity-80 mb-1">{it.mensagem}</div>
            {it.id_processo && (
              <div className="opacity-60">Processo #{it.id_processo}</div>
            )}
          </div>
        ))}
        {items.length === 0 && (
          <div className="opacity-60 text-sm">{emptyMsg}</div>
        )}
      </div>
    </div>
  );
}
