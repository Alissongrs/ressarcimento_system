import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Save, Trash2, Wand2 } from 'lucide-react';
import { getRules, createRule, updateRule, deleteRule, interpretRule } from '@services/rulesService.js';

export default function Regras() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const [editing, setEditing] = useState(null);
  const [natText, setNatText] = useState('');
  const [interpreting, setInterpreting] = useState(false);

  const emptyRule = useMemo(() => ({
    id: 0,
    name: '',
    distribuidoras: ['ENEL SP'],
    grupo: 'Grupo B',
    periodo: '',
    tipo: '',
    active: true,
    natural_text: '',
  }), []);

  const load = async () => {
    try { setLoading(true); setErr(''); const data = await getRules(); setItems(data); }
    catch (e) { setErr('Falha ao carregar regras.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const startNew = () => { setEditing({ ...emptyRule }); setNatText(''); };
  const startEdit = (r) => { setEditing({ ...r }); setNatText(r.natural_text || ''); };
  const remove = async (r) => { if (!window.confirm('Excluir esta regra?')) return; await deleteRule(r.id); await load(); setEditing(null); };
  const save = async () => {
    const payload = { ...editing, natural_text: natText };
    if (!payload.name.trim()) { alert('Informe o nome da regra.'); return; }
    if (payload.id && payload.id > 0) await updateRule(payload.id, payload); else await createRule(payload);
    await load(); setEditing(null); setNatText('');
  };

  const runInterpret = async () => {
    if (!natText.trim()) { alert('Escreva a regra em linguagem natural.'); return; }
    setInterpreting(true);
    try {
      const msg = await interpretRule(natText);
      // Tenta extrair JSON
      const m = String(msg || '').trim();
      const start = m.search(/[\[{]/);
      if (start >= 0) {
        const jsonStr = m.slice(start);
        const obj = JSON.parse(jsonStr);
        setEditing((prev) => ({
          ...(prev || emptyRule),
          name: obj?.name ?? prev?.name ?? '',
          distribuidoras: obj?.distribuidoras ?? prev?.distribuidoras ?? [],
          grupo: obj?.grupo ?? prev?.grupo ?? '',
          periodo: obj?.periodo ?? prev?.periodo ?? '',
          tipo: obj?.tipo ?? prev?.tipo ?? '',
          active: (typeof obj?.active === 'boolean') ? obj.active : (prev?.active ?? true),
          natural_text: natText,
        }));
      }
    } catch (e) {
      // ignore
    } finally { setInterpreting(false); }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Lista de regras */}
      <div className="glass-card border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Regras de Auditoria</h2>
          <button className="px-3 py-2 rounded bg-[var(--accent)] text-[var(--fg)]" onClick={startNew}><Plus size={16} /> Nova</button>
        </div>
        {loading ? (<div><span className="sap-loading">Carregando…</span></div>) : err ? (<div className="text-danger">{err}</div>) : (
          <table className="w-full text-sm">
            <thead className="text-left opacity-70">
              <tr>
                <th className="py-2">Nome</th>
                <th>Distribuidora</th>
                <th>Grupo</th>
                <th>Tipo</th>
                <th>Ativa</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-t border-[var(--border)]/50">
                  <td className="py-2">{r.name}</td>
                  <td>{(r.distribuidoras || []).join(', ')}</td>
                  <td>{r.grupo}</td>
                  <td>{r.tipo}</td>
                  <td>{r.active ? 'Sim' : 'Não'}</td>
                  <td className="text-right">
                    <button className="text-xs px-2 py-1 rounded bg-[var(--accent)] text-[var(--fg)] mr-2" onClick={() => startEdit(r)}>Editar</button>
                    <button className="text-xs px-2 py-1 rounded bg-danger text-[var(--fg)]" onClick={() => remove(r)}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Editor */}
      <div className="glass-card border rounded-xl p-4">
        <h2 className="font-semibold mb-3">Editor de Regra</h2>
        {!editing ? (
          <div className="opacity-70 text-sm">Selecione uma regra ou clique em Nova.</div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="text-xs opacity-70">Nome</label>
              <input className="w-full p-2 border panel-border rounded-md panel-bg-60" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div>
              <label className="text-xs opacity-70">Distribuidoras (separe por vírgula)</label>
              <input className="w-full p-2 border panel-border rounded-md panel-bg-60" value={(editing.distribuidoras || []).join(', ')} onChange={(e) => setEditing({ ...editing, distribuidoras: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs opacity-70">Grupo</label>
                <input className="w-full p-2 border panel-border rounded-md panel-bg-60" value={editing.grupo} onChange={(e) => setEditing({ ...editing, grupo: e.target.value })} />
              </div>
              <div>
                <label className="text-xs opacity-70">Período</label>
                <input className="w-full p-2 border panel-border rounded-md panel-bg-60" value={editing.periodo} onChange={(e) => setEditing({ ...editing, periodo: e.target.value })} placeholder="ex.: 092024 ou 202401-202412" />
              </div>
            </div>
            <div>
              <label className="text-xs opacity-70">Tipo de Regra</label>
              <input className="w-full p-2 border panel-border rounded-md panel-bg-60" value={editing.tipo} onChange={(e) => setEditing({ ...editing, tipo: e.target.value })} placeholder="ex.: Bandeira Tarifária" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
              Ativa
            </label>

            <div>
              <label className="text-xs opacity-70">Regra em linguagem natural</label>
              <textarea className="w-full p-2 border panel-border rounded-md panel-bg-60 h-32" value={natText} onChange={(e) => setNatText(e.target.value)} placeholder="Descreva a regra…" />
              <div className="mt-2 flex gap-2">
                <button className="px-3 py-2 rounded bg-[var(--accent)] text-[var(--fg)] flex items-center gap-2" onClick={runInterpret} disabled={interpreting}><Wand2 size={16} /> {interpreting ? 'Interpretando…' : 'Interpretar com IA'}</button>
                <button className="px-3 py-2 rounded bg-success text-[var(--fg)] flex items-center gap-2" onClick={save}><Save size={16} /> Salvar</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


