import React from 'react';
import { CalendarDays, Clock3, Plus, Trash2, X } from 'lucide-react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import {
  atualizarAlerta,
  criarAlerta,
  excluirAlerta,
  listAlertas,
} from '../services/alertaService.js';
import { criarAlertaProcesso, salvarDataAlerta } from '../services/requisicaoService.js';

function toKey(dateLike) {
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateLabel(key) {
  const d = new Date(`${key}T00:00:00`);
  if (Number.isNaN(d.getTime())) return key;
  return d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}

function toInputDate(dateLike) {
  const key = toKey(dateLike);
  return key || '';
}

export default function AlertCalendarModal({ open, onClose }) {
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState(new Date());
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const [form, setForm] = React.useState({
    mensagem: '',
    data_alerta: toInputDate(new Date()),
    id_processo: '',
    para_todos: false,
  });

  const loadRows = React.useCallback(async () => {
    setLoading(true);
    const data = await listAlertas({});
    setRows(Array.isArray(data) ? data.filter((item) => item?.data_alerta) : []);
    setLoading(false);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      setError('');
      setForm((prev) => ({ ...prev, data_alerta: toInputDate(selected || new Date()) }));
      const data = await listAlertas({});
      if (!alive) return;
      setRows(Array.isArray(data) ? data.filter((item) => item?.data_alerta) : []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [open, selected]);

  React.useEffect(() => {
    setForm((prev) => ({ ...prev, data_alerta: toInputDate(selected || new Date()) }));
  }, [selected]);

  const grouped = rows.reduce((acc, row) => {
    const key = toKey(row.data_alerta);
    if (!key) return acc;
    acc[key] ||= [];
    acc[key].push(row);
    return acc;
  }, {});

  const markerDays = Object.keys(grouped).map((key) => new Date(`${key}T00:00:00`));
  const selectedKey = toKey(selected);
  const selectedItems = grouped[selectedKey] || [];

  const resetForm = React.useCallback(() => {
    setForm({
      mensagem: '',
      data_alerta: selectedKey || toInputDate(new Date()),
      id_processo: '',
      para_todos: false,
    });
    setError('');
  }, [selectedKey]);

  if (!open) return null;

  const handleCreate = async () => {
    const mensagem = String(form.mensagem || '').trim();
    const dataAlerta = String(form.data_alerta || '').trim();
    const processoID = String(form.id_processo || '').trim();

    if (!mensagem) {
      setError('Informe a mensagem do lembrete.');
      return;
    }
    if (!dataAlerta) {
      setError('Informe a data do alerta.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      if (processoID) {
        await criarAlertaProcesso(processoID, {
          mensagem,
          data_alerta: dataAlerta,
          para_todos: form.para_todos,
        });
        await salvarDataAlerta(processoID, { data_alerta: dataAlerta });
      } else {
        await criarAlerta({
          mensagem,
          data_alerta: dataAlerta,
          para_todos: form.para_todos,
        });
      }
      await loadRows();
      setSelected(new Date(`${dataAlerta}T00:00:00`));
      resetForm();
    } catch (err) {
      setError(err?.response?.data?.error || 'Não foi possível salvar o lembrete.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleRead = async (item) => {
    try {
      await atualizarAlerta(item.id_alerta ?? item.id, {
        lido: !(item.lido === true),
      });
      await loadRows();
    } catch {}
  };

  const handleDelete = async (item) => {
    try {
      await excluirAlerta(item.id_alerta ?? item.id);
      await loadRows();
    } catch {}
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-5xl rounded-2xl border bg-[var(--bg)] shadow-2xl" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="inline-flex items-center gap-2 text-sm font-semibold">
            <CalendarDays size={18} />
            Calendário de alertas
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-[var(--panel)]">
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[360px,1fr] gap-0">
          <div className="p-5 border-r" style={{ borderColor: 'var(--border)' }}>
            <DayPicker
              mode="single"
              selected={selected}
              onSelect={(d) => d && setSelected(d)}
              modifiers={{ highlighted: markerDays }}
              modifiersClassNames={{ highlighted: 'rdp-day_highlighted' }}
              styles={{
                day: { fontSize: '13px' },
                month_caption: { fontWeight: 700 },
              }}
            />
            <style>{`
              .rdp-day_highlighted {
                background: rgba(30, 58, 95, 0.16);
                color: #1e3a5f;
                font-weight: 700;
                border-radius: 9999px;
              }
            `}</style>

            <div className="mt-5 rounded-2xl border bg-[var(--panel)] p-4 space-y-3" style={{ borderColor: 'var(--border)' }}>
              <div className="inline-flex items-center gap-2 text-sm font-semibold">
                <Plus size={16} />
                Novo lembrete
              </div>

              <div>
                <label className="block text-xs opacity-70 mb-1">Mensagem</label>
                <textarea
                  rows={3}
                  value={form.mensagem}
                  onChange={(e) => setForm((prev) => ({ ...prev, mensagem: e.target.value }))}
                  className="w-full rounded-lg border px-3 py-2 text-sm bg-[var(--bg)] border-[var(--border)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  placeholder="Ex.: cobrar retorno da distribuidora"
                />
              </div>

              <div>
                <label className="block text-xs opacity-70 mb-1">Data</label>
                <input
                  type="date"
                  value={form.data_alerta}
                  onChange={(e) => setForm((prev) => ({ ...prev, data_alerta: e.target.value }))}
                  className="w-full rounded-lg border px-3 py-2 text-sm bg-[var(--bg)] border-[var(--border)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                />
              </div>

              <div>
                <label className="block text-xs opacity-70 mb-1">Processo vinculado</label>
                <input
                  type="number"
                  min="1"
                  value={form.id_processo}
                  onChange={(e) => setForm((prev) => ({ ...prev, id_processo: e.target.value }))}
                  className="w-full rounded-lg border px-3 py-2 text-sm bg-[var(--bg)] border-[var(--border)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  placeholder="Opcional. Ex.: 123"
                />
                <div className="mt-1 text-[11px] opacity-60">
                  Se informar um processo, o card também recebe a data de alerta.
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={form.para_todos}
                  onChange={(e) => setForm((prev) => ({ ...prev, para_todos: e.target.checked }))}
                  className="w-4 h-4 rounded"
                />
                <span className="text-xs">Todos <span className="opacity-50">(visível para a equipe + envia e-mail no prazo)</span></span>
              </label>

              {error && <div className="text-xs text-red-500">{error}</div>}

              <div className="flex items-center justify-between gap-2">
                <button type="button" onClick={resetForm} className="btn-outline text-sm">
                  Limpar
                </button>
                <button type="button" onClick={handleCreate} disabled={saving} className="btn-themed text-sm disabled:opacity-50">
                  {saving ? 'Salvando...' : 'Salvar lembrete'}
                </button>
              </div>
            </div>
          </div>

          <div className="p-5 min-h-[420px]">
            <div className="text-sm font-semibold mb-3">{formatDateLabel(selectedKey)}</div>
            {loading ? (
              <div className="text-sm opacity-60">Carregando alertas...</div>
            ) : selectedItems.length === 0 ? (
              <div className="text-sm opacity-50">Nenhum evento para esta data.</div>
            ) : (
              <div className="space-y-3">
                {selectedItems.map((item) => (
                  <div key={item.id_alerta ?? item.id} className="rounded-xl border px-4 py-3 bg-[var(--panel)]" style={{ borderColor: 'var(--border)' }}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium flex items-center gap-2">
                          {item.id_processo ? `PROC-${String(item.id_processo).padStart(3, '0')}` : 'Alerta'}
                          {item.para_todos && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                              style={{ background: 'rgba(99,102,241,0.15)', color: '#6366f1' }}>
                              Todos
                            </span>
                          )}
                        </div>
                        <div className="text-xs opacity-70 mt-1">{item.mensagem}</div>
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleToggleRead(item)}
                            className={`rounded-lg px-2 py-1 text-[11px] border ${item.lido ? 'opacity-60' : ''}`}
                            style={{ borderColor: 'var(--border)' }}
                          >
                            {item.lido ? 'Marcar como não lido' : 'Marcar como lido'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(item)}
                            className="rounded-lg px-2 py-1 text-[11px] border text-red-500 inline-flex items-center gap-1"
                            style={{ borderColor: 'var(--border)' }}
                          >
                            <Trash2 size={12} />
                            Excluir
                          </button>
                        </div>
                      </div>
                      <div className="inline-flex items-center gap-1 text-[11px] opacity-60">
                        <Clock3 size={12} />
                        {item.data_alerta ? new Date(item.data_alerta).toLocaleDateString('pt-BR') : '-'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
