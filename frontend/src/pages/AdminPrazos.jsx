import React, { useEffect, useMemo, useState } from 'react';
import { getPrazos, savePrazos } from '../services/prazosService';
import { getAlarmes, saveAlarme, deleteAlarme } from '../services/alarmesService';
import { useAuth } from '../context/AuthContext.jsx';

export default function AdminPrazos() {
  const { user } = useAuth();
  const isAdmin = String(user?.tipo_conta || '').toLowerCase() === 'admin';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [kanbanRows, setKanbanRows] = useState([]);
  const [etapasRows, setEtapasRows] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [toast, setToast] = useState('');
  const [alarmes, setAlarmes] = useState([]);
  const [novoAlarme, setNovoAlarme] = useState({ nome: '', tipo: 'coluna', id_coluna_kanban: null, id_etapa_processo: null, sub_etapa: '', prazo_dias: 5, severity: 'warn', ativo: true });

  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      try {
        setLoading(true);
        const data = await getPrazos();
        setKanbanRows(data.kanban || []);
        setEtapasRows(data.etapas || []);
        const alm = await getAlarmes();
        setAlarmes(alm);
        // Pre-carrega overrides existentes a partir de etapasRows com prazo/sub_etapa
        const ov = (data.etapas || [])
          .filter(r => r.prazo_dias && (r.sub_etapa?.String || r.sub_etapa?.String === null))
          .map(r => ({ id_etapa_processo: r.id_etapa_processo, sub_etapa: r.sub_etapa?.String || '', prazo_dias: r.prazo_dias.Int64 || r.prazo_dias }))
        setOverrides(ov);
      } catch (e) {
        setError('Falha ao carregar');
      } finally { setLoading(false); }
    })();
  }, [isAdmin]);

  const etapasDistinct = useMemo(() => {
    const map = new Map();
    etapasRows.forEach(r => { if (!map.has(r.id_etapa_processo)) map.set(r.id_etapa_processo, { id: r.id_etapa_processo, nome: r.etapa, coluna: r.id_coluna_kanban }); });
    return Array.from(map.values());
  }, [etapasRows]);

  const setKanbanPrazo = (idColuna, val) => {
    setKanbanRows(prev => prev.map(r => r.id_coluna_kanban === idColuna ? { ...r, prazo_dias: val } : r));
  };

  const addOverride = () => setOverrides(prev => [...prev, { id_etapa_processo: etapasDistinct[0]?.id || 0, sub_etapa: '', prazo_dias: 5 }]);
  const setOverride = (idx, patch) => setOverrides(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r));
  const removeOverride = (idx) => setOverrides(prev => prev.filter((_, i) => i !== idx));

  const handleSave = async () => {
    try {
      const kanbanPayload = (kanbanRows || []).map(r => ({ id_coluna_kanban: r.id_coluna_kanban || r.IDColuna || r.id_coluna, prazo_dias: normIntOrNull(r.prazo_dias) }));
      const overridesPayload = (overrides || [])
        .filter(o => (o.id_etapa_processo && Number(o.prazo_dias) > 0))
        .map(o => ({ id_etapa_processo: Number(o.id_etapa_processo), sub_etapa: (o.sub_etapa || '').trim() || null, prazo_dias: Number(o.prazo_dias) }));
      await savePrazos({ kanban: kanbanPayload, overrides: overridesPayload });
      setToast('Configurações salvas');
      setTimeout(() => setToast(''), 2500);
    } catch (e) {
      alert('Falha ao salvar');
    }
  };

  const handleCreateAlarme = async () => {
    try {
      const payload = { ...novoAlarme };
      // normalizar campos por tipo
      if (payload.tipo === 'coluna') { payload.id_etapa_processo = null; payload.sub_etapa = null; }
      if (payload.tipo === 'etapa') { payload.sub_etapa = null; }
      if (payload.sub_etapa === '') payload.sub_etapa = null;
      await saveAlarme(payload);
      const alm = await getAlarmes(); setAlarmes(alm);
      setNovoAlarme({ nome: '', tipo: 'coluna', id_coluna_kanban: null, id_etapa_processo: null, sub_etapa: '', prazo_dias: 5, severity: 'warn', ativo: true });
      setToast('Alarme salvo'); setTimeout(() => setToast(''), 2000);
    } catch { alert('Falha ao salvar alarme'); }
  };

  const handleDeleteAlarme = async (id) => {
    if (!confirm('Remover este alarme?')) return;
    try { await deleteAlarme(id); const alm = await getAlarmes(); setAlarmes(alm); } catch { alert('Falha ao remover'); }
  };

  if (!isAdmin) return <div className="p-8 text-center">Acesso restrito ao administrador.</div>;
  if (loading) return <div className="p-8 text-center">Carregando...</div>;

  return (
    <div className="max-w-5xl mx-auto p-6 bg-background text-foreground min-h-screen">
      <div className="rounded-xl shadow-elevated p-4 mb-6 border-2" style={{ background:'var(--header-bg)', borderColor:'var(--header-border)', color:'var(--header-fg)' }}>
        <h1 className="text-xl font-extrabold tracking-tight">Configurações de Prazos (Alertas)</h1>
        <p className="opacity-90 text-sm">Defina prazos por coluna, etapa e alarmes personalizados.</p>
      </div>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">Prazos por Coluna do Kanban</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {kanbanRows.map(r => {
            const id = r.id_coluna_kanban || r.IDColuna || r.id_coluna;
            const nome = r.nome_coluna || r.Nome || r.nome;
            const prazo = toInt(r.prazo_dias);
            return (
              <div key={id} className="flex items-center gap-3 bg-[var(--panel)] gradient-card shadow-medium border border-[var(--panel-border)] rounded p-3">
                <div className="flex-1 font-medium">{nome}</div>
                <input
                  type="number"
                  min={0}
                  value={prazo ?? ''}
                  onChange={e => setKanbanPrazo(id, e.target.value === '' ? null : Number(e.target.value))}
                  className="w-28 px-2 py-1 rounded border border-[var(--border)] bg-transparent"
                  placeholder="dias"
                />
                <span className="opacity-70 text-sm">dias</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Overrides por Etapa/Sub-etapa</h2>
          <button onClick={addOverride} className="px-3 py-1.5 rounded bg-[var(--accent)] text-[var(--fg)]">Adicionar</button>
        </div>
        <div className="space-y-2">
          {overrides.map((ov, idx) => (
            <div key={idx} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center bg-[var(--panel)] gradient-card shadow-medium border border-[var(--panel-border)] rounded p-3">
              <div className="md:col-span-5">
                <label className="block text-xs opacity-70 mb-1">Etapa</label>
                <select
                  value={ov.id_etapa_processo}
                  onChange={e => setOverride(idx, { id_etapa_processo: Number(e.target.value) })}
                  className="w-full px-2 py-1 rounded border border-[var(--border)] bg-transparent"
                >
                  {etapasDistinct.map(opt => (
                    <option key={opt.id} value={opt.id}>{opt.nome}</option>
                  ))}
                </select>
              </div>
              <div className="md:col-span-5">
                <label className="block text-xs opacity-70 mb-1">Sub-etapa (opcional)</label>
                <input
                  type="text"
                  value={ov.sub_etapa || ''}
                  onChange={e => setOverride(idx, { sub_etapa: e.target.value })}
                  className="w-full px-2 py-1 rounded border border-[var(--border)] bg-transparent"
                  placeholder="ex.: Suspenso, Em Contestação"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs opacity-70 mb-1">Prazo (dias)</label>
                <input
                  type="number"
                  min={1}
                  value={ov.prazo_dias || ''}
                  onChange={e => setOverride(idx, { prazo_dias: Number(e.target.value) })}
                  className="w-full px-2 py-1 rounded border border-[var(--border)] bg-transparent"
                />
              </div>
              <div className="md:col-span-12 flex justify-end">
                <button onClick={() => removeOverride(idx)} className="px-3 py-1.5 rounded border border-[var(--border)]">Remover</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="flex gap-2 justify-end">
        <button onClick={handleSave} className="px-4 py-2 rounded bg-[var(--accent)] text-[var(--fg)]">Salvar configurações</button>
      </div>

      <section className="mt-10">
        <h2 className="text-lg font-semibold mb-3">Alarmes Personalizados</h2>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end bg-[var(--panel)] border border-[var(--panel-border)] rounded p-3 mb-3">
          <div className="md:col-span-3">
            <label className="block text-xs opacity-70 mb-1">Nome</label>
            <input className="w-full px-2 py-1 rounded border border-[var(--border)] bg-transparent" value={novoAlarme.nome} onChange={e=>setNovoAlarme(v=>({...v, nome:e.target.value}))} />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs opacity-70 mb-1">Tipo</label>
            <select className="w-full px-2 py-1 rounded border border-[var(--border)] bg-transparent" value={novoAlarme.tipo} onChange={e=>setNovoAlarme(v=>({...v, tipo:e.target.value}))}>
              <option value="coluna">Coluna</option>
              <option value="etapa">Etapa</option>
              <option value="etapa_sub">Etapa + Sub</option>
            </select>
          </div>
          {novoAlarme.tipo === 'coluna' && (
            <div className="md:col-span-3">
              <label className="block text-xs opacity-70 mb-1">Coluna</label>
              <select className="w-full px-2 py-1 rounded border border-[var(--border)] bg-transparent" value={novoAlarme.id_coluna_kanban ?? ''} onChange={e=>setNovoAlarme(v=>({...v, id_coluna_kanban: e.target.value ? Number(e.target.value) : null}))}>
                <option value="">Selecione...</option>
                {kanbanRows.map(r => (
                  <option key={r.id_coluna_kanban || r.IDColuna || r.id_coluna} value={r.id_coluna_kanban || r.IDColuna || r.id_coluna}>{r.nome_coluna || r.Nome || r.nome}</option>
                ))}
              </select>
            </div>
          )}
          {novoAlarme.tipo !== 'coluna' && (
            <>
              <div className="md:col-span-3">
                <label className="block text-xs opacity-70 mb-1">Etapa</label>
                <select className="w-full px-2 py-1 rounded border border-[var(--border)] bg-transparent" value={novoAlarme.id_etapa_processo ?? ''} onChange={e=>setNovoAlarme(v=>({...v, id_etapa_processo: e.target.value ? Number(e.target.value) : null}))}>
                  <option value="">Selecione...</option>
                  {etapasDistinct.map(opt => (<option key={opt.id} value={opt.id}>{opt.nome}</option>))}
                </select>
              </div>
              <div className="md:col-span-3">
                <label className="block text-xs opacity-70 mb-1">Sub-etapa (opcional)</label>
                <input className="w-full px-2 py-1 rounded border border-[var(--border)] bg-transparent" value={novoAlarme.sub_etapa || ''} onChange={e=>setNovoAlarme(v=>({...v, sub_etapa: e.target.value}))} />
              </div>
            </>
          )}
          <div className="md:col-span-2">
            <label className="block text-xs opacity-70 mb-1">Prazo (dias)</label>
            <input type="number" min={1} className="w-full px-2 py-1 rounded border border-[var(--border)] bg-transparent" value={novoAlarme.prazo_dias} onChange={e=>setNovoAlarme(v=>({...v, prazo_dias: Number(e.target.value)}))} />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs opacity-70 mb-1">Severidade</label>
            <select className="w-full px-2 py-1 rounded border border-[var(--border)] bg-transparent" value={novoAlarme.severity} onChange={e=>setNovoAlarme(v=>({...v, severity: e.target.value}))}>
              <option value="info">Info</option>
              <option value="warn">Aviso</option>
              <option value="crit">Crítico</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs opacity-70 mb-1">Ativo</label>
            <input type="checkbox" checked={!!novoAlarme.ativo} onChange={e=>setNovoAlarme(v=>({...v, ativo: e.target.checked}))} />
          </div>
          <div className="md:col-span-12 flex justify-end">
            <button onClick={handleCreateAlarme} className="px-3 py-1.5 rounded bg-[var(--accent)] text-[var(--fg)]">Salvar alarme</button>
          </div>
        </div>
        <div className="space-y-2">
          {alarmes.map(a => (
            <div key={a.id} className="flex items-center justify-between bg-[var(--panel)] border border-[var(--panel-border)] rounded p-3">
              <div className="flex items-center gap-3">
                <span className="text-sm px-2 py-0.5 rounded bg-[var(--border)]/30">{a.severity}</span>
                <strong>{a.nome}</strong>
                <span className="opacity-70 text-sm">tipo: {a.tipo}</span>
                <span className="opacity-70 text-sm">prazo: {a.prazo_dias}d</span>
                {!a.ativo && <span className="opacity-70 text-sm">(inativo)</span>}
              </div>
              <button onClick={() => handleDeleteAlarme(a.id)} className="px-3 py-1.5 rounded border border-[var(--border)]">Excluir</button>
            </div>
          ))}
          {alarmes.length === 0 && <div className="opacity-70 text-sm">Nenhum alarme criado.</div>}
        </div>
      </section>

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 px-4 py-2 rounded-md bg-[var(--accent)] text-[var(--fg)] shadow-lg">{toast}</div>
      )}
    </div>
  );
}

function toInt(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') {
    if ('Int64' in v) return Number(v.Int64);
    if ('Value' in v) return Number(v.Value);
  }
  const n = Number(v); return Number.isFinite(n) ? n : null;
}
function normIntOrNull(v) { const n = toInt(v); return Number.isFinite(n) ? n : null; }

