// src/pages/AdminPlanilha.jsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  listPlanilha,
  bulkMover,
  bulkComentarioReplace,
  deleteHistorico,
} from '../services/adminPlanilhaService';
import { Download, RefreshCcw, Filter } from 'lucide-react';
import { saveProcessoFull } from '../services/adminEditorService';
import Toast from '../components/Toast.jsx';

export default function AdminPlanilha() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [kanbanFilter, setKanbanFilter] = useState('');
  const [applyEtapa, setApplyEtapa] = useState('');
  const [applySub, setApplySub] = useState('');
  const [applyComentario, setApplyComentario] = useState('');
  const [applyingAll, setApplyingAll] = useState(false);
  const [etapa, setEtapa] = useState('');
  const [sub, setSub] = useState('');
  const [limit] = useState(100);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingAll, setLoadingAll] = useState(false);
  const [sel, setSel] = useState({});
  const [moving, setMoving] = useState(false);
  const [toast, setToast] = useState({ open: false, type: 'info', text: '' });

  // Replace comentário
  const [repFrom, setRepFrom] = useState('');
  const [repTo, setRepTo] = useState('');

  // Filtro por período
  const [ini, setIni] = useState('');
  const [fim, setFim] = useState('');

  // Edição por processo: deferimento (crédito simples/dobro e datas)
  const [deferByPid, setDeferByPid] = useState({}); // { [pid]: { cs, ds, cd, dd } }

  // Draft “adicionar histórico”
  const [draftByPid, setDraftByPid] = useState({}); // { [pid]: { etapa:'', sub:'', comentario:'' } }
  // Mover por processo (draft)
  const [mvByPid, setMvByPid] = useState({}); // { [pid]: { etapa:'', sub:'', comentario:'' } }

  const keyOf = (r) =>
    `${r.processo_id || r.ProcessoID || r.processoId || r.id}-${
      r.id_historico || r.IDHistorico || r.historico_id || ''
    }`;
  const pidOf = (r) =>
    Number(r.processo_id ?? r.ProcessoID ?? r.processoId ?? r.id ?? 0) || 0;
  const hidOf = (r) =>
    Number(r.id_historico ?? r.IDHistorico ?? r.historico_id ?? 0) || 0;

  async function load(reset = false) {
    setLoading(true);
    try {
      const p = {
        q: q || undefined,
        etapa: etapa || undefined,
        sub: sub || undefined,
        ini: ini || undefined,
        fim: fim || undefined,
        limit,
        offset: reset ? 0 : offset,
      };
      const data = await listPlanilha(p);
      setRows((prev) => (reset ? data : [...prev, ...(data || [])]));
      setHasMore((data || []).length === limit);
      if (reset) setOffset(limit);
      else setOffset((v) => v + limit);
    } finally {
      setLoading(false);
    }
  }

  async function loadAll() {
    if (loadingAll) return;
    setLoadingAll(true);
    setLoading(true);
    try {
      const chunk = 1000;
      let off = 0;
      let all = [];
      const base = {
        q: q || undefined,
        etapa: etapa || undefined,
        sub: sub || undefined,
        ini: ini || undefined,
        fim: fim || undefined,
      };
      for (;;) {
        const part = await listPlanilha({ ...base, limit: chunk, offset: off });
        const arr = Array.isArray(part) ? part : [];
        all = all.concat(arr);
        if (arr.length < chunk) break;
        off += chunk;
      }
      setRows(all);
      setOffset(all.length);
      setHasMore(false);
    } finally {
      setLoading(false);
      setLoadingAll(false);
    }
  }

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedPIDs = useMemo(() => {
    const ids = new Set();
    rows.forEach((r) => {
      const k = keyOf(r);
      if (sel[k]) ids.add(pidOf(r));
    });
    return Array.from(ids);
  }, [sel, rows]);

  const selectedHIDs = useMemo(() => {
    const ids = new Set();
    rows.forEach((r) => {
      const k = keyOf(r);
      if (sel[k]) {
        const h = hidOf(r);
        if (h) ids.add(h);
      }
    });
    return Array.from(ids);
  }, [sel, rows]);

  // Agrupar por processo para exibir cabeçalho + histórico
  const groups = useMemo(() => {
    const map = new Map();
    (rows || []).forEach((r) => {
      const pid = pidOf(r);
      if (!map.has(pid)) map.set(pid, { header: r, hist: [] });
      map.get(pid).hist.push(r);
    });
    return Array.from(map.entries());
  }, [rows]);

  // Mapeia etapa para coluna do Kanban (rótulos principais)
  const etapaToColuna = (etapaNome) => {
    const e = String(etapaNome || '').trim().toLowerCase();
    if (!e) return 'Ativos';
    if (/(deferid|pendente|concil|contest)/.test(e)) return 'Deferidos';
    if (/(fluxo.*ressarc|validacao|valida|enviado ao financeiro|envio ao financeiro)/.test(e)) return 'Fluxo de Ressarcimento';
    if (/fatur/.test(e)) return 'Faturamento';
    if (/(conclu)/.test(e)) return 'Concluídos';
    if (/(indefer)/.test(e)) return 'Indeferidos';
    return 'Ativos';
  };

  // PIDs que estão na visão atual (após busca/filtros) e batem o filtro de Kanban
  const candidatePIDs = useMemo(() => {
    try {
      const ids = [];
      for (const [pid, g] of groups) {
        const col = etapaToColuna(g?.header?.etapa || g?.header?.Etapa || '');
        if (kanbanFilter && col !== kanbanFilter) continue;
        ids.push(pid);
      }
      return ids;
    } catch {
      return [];
    }
  }, [groups, kanbanFilter]);

  const doExport = () => {
    const headers = [
      'Sel',
      'Processo',
      'UC',
      'CNPJ',
      'Concessionaria',
      'Cliente',
      'Credito Simples',
      'Data Simples',
      'Credito Dobro',
      'Data Dobro',
      'Forma Devolucao',
      'Valor Fluxo',
      'Data Fluxo',
      'NF',
      'Emissao',
      'Vencimento',
      'Pagamento',
      'Valor NF',
      'HistID',
      'Hist Data',
      'Comentario',
      'Etapa',
      'Sub-Etapa',
      'Tipo',
    ];
    const sep = ';';
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(sep)];
    rows.forEach((r) => {
      const k = keyOf(r);
      lines.push(
        [
          sel[k] ? 'x' : '',
          pidOf(r),
          r.uc || '',
          r.cnpj || '',
          r.concessionaria || '',
          r.cliente || '',
          r.credito_simples ?? '',
          r.data_simples || '',
          r.credito_dobro ?? '',
          r.data_dobro || '',
          r.forma_devolucao || '',
          r.valor_fluxo ?? '',
          r.data_fluxo || '',
          r.numero_nf || '',
          r.data_emissao || '',
          r.data_vencimento || '',
          r.data_pagamento || '',
          r.valor_nf ?? '',
          hidOf(r),
          r.hist_data || '',
          r.hist_comentario || '',
          r.etapa || '',
          r.sub_etapa || '',
          r.tipo_movimentacao || '',
        ]
          .map(esc)
          .join(sep),
      );
    });
    const blob = new Blob([lines.join('\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'planilha_processos.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="p-4 border rounded panel-bg-60 panel-border">
      {/* Filtros */}
      <div className="mb-3 flex flex-wrap gap-2 items-center">
        <div className="flex items-center gap-1">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Busca (cliente, UC, comentário)"
            className="input-themed"
          />
          <input
            value={etapa}
            onChange={(e) => setEtapa(e.target.value)}
            placeholder="Etapa"
            className="input-themed"
          />
          <input
            value={sub}
            onChange={(e) => setSub(e.target.value)}
            placeholder="Sub-etapa"
            className="input-themed"
          />
          <input
            type="date"
            value={ini}
            onChange={(e) => setIni(e.target.value)}
            className="input-themed"
          />
          <input
            type="date"
            value={fim}
            onChange={(e) => setFim(e.target.value)}
            className="input-themed"
          />
          <button
            className="btn-themed inline-flex items-center gap-1"
            onClick={() => load(true)}
            title="Filtrar"
          >
            <Filter size={16} />
            Filtrar
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            className="btn-outline"
            onClick={() => {
              const next = {};
              rows.forEach((r) => {
                next[keyOf(r)] = true;
              });
              setSel(next);
            }}
          >
            Selecionar todos filtrados
          </button>
          <button className="btn-outline" onClick={() => setSel({})}>
            Limpar seleção
          </button>
          <button
            className="btn-outline inline-flex items-center gap-1"
            onClick={doExport}
          >
            <Download size={16} />
            Exportar
          </button>
          <button
            className="btn-themed inline-flex items-center gap-1"
            onClick={() => {
              setSel({});
              setOffset(0);
              load(true);
            }}
            title="Recarregar"
          >
            <RefreshCcw size={16} />
            Recarregar
          </button>
        </div>
      </div>

      {/* Aplicar etapa/subetapa em massa nos resultados */}
      <div className="mt-3 p-3 border rounded panel-bg-60 panel-border">
        <div className="font-semibold mb-2">Aplicar em massa (resultados atuais)</div>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2 items-end">
          <div className="md:col-span-2">
            <label className="block text-xs mb-1">Etapa destino</label>
            <input
              className="input-themed w-full"
              value={applyEtapa}
              onChange={(e) => setApplyEtapa(e.target.value)}
              placeholder="Ex.: Ativos / Deferidos / Faturamento"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs mb-1">Sub-etapa destino</label>
            <input
              className="input-themed w-full"
              value={applySub}
              onChange={(e) => setApplySub(e.target.value)}
              placeholder="Sub-etapa (opcional)"
            />
          </div>
          <div>
            <label className="block text-xs mb-1">Filtrar por Kanban</label>
            <select
              className="input-themed w-full"
              value={kanbanFilter}
              onChange={(e) => setKanbanFilter(e.target.value)}
            >
              <option value="">Todos</option>
              <option>Ativos</option>
              <option>Deferidos</option>
              <option>Fluxo de Ressarcimento</option>
              <option>Faturamento</option>
              <option>Concluídos</option>
              <option>Indeferidos</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-2 items-end mt-2">
          <div className="md:col-span-4">
            <label className="block text-xs mb-1">Comentário (opcional)</label>
            <input
              className="input-themed w-full"
              value={applyComentario}
              onChange={(e) => setApplyComentario(e.target.value)}
              placeholder="Comentário a registrar no histórico (opcional)"
            />
          </div>
          <div className="text-right md:text-left">
            <button
              className="btn-themed"
              disabled={applyingAll || !applyEtapa.trim() || candidatePIDs.length === 0}
              onClick={async () => {
                if (!applyEtapa.trim()) return;
                setApplyingAll(true);
                try {
                  await bulkMover({
                    processo_ids: candidatePIDs,
                    etapa: applyEtapa.trim(),
                    sub_etapa: applySub.trim() || '',
                    comentario: applyComentario.trim() || '',
                  });
                  setToast({ open: true, type: 'success', text: `Aplicado em ${candidatePIDs.length} processo(s).` });
                  await load(true);
                } catch (e) {
                  setToast({ open: true, type: 'error', text: e?.message || 'Falha ao aplicar em massa' });
                } finally {
                  setApplyingAll(false);
                }
              }}
            >
              {applyingAll ? 'Aplicando...' : `Aplicar nos resultados (${candidatePIDs.length})`}
            </button>
          </div>
        </div>
        <div className="mt-1 text-xs opacity-70">
          Observação: aplica nos processos carregados (use "Carregar todos" para incluir mais) e, se definido, somente nos da coluna Kanban selecionada.
        </div>
      </div>

      {/* Replace comentário (bulk) */}
      {(repFrom || repTo) && (
        <div className="mb-3 p-3 border rounded panel-bg-60 panel-border">
          <div className="font-semibold mb-2">Substituir comentário (bulk)</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 items-center">
            <input
              value={repFrom}
              onChange={(e) => setRepFrom(e.target.value)}
              className="input-themed"
              placeholder="Procurar"
            />
            <input
              value={repTo}
              onChange={(e) => setRepTo(e.target.value)}
              className="input-themed"
              placeholder="Substituir por"
            />
            <button
              disabled={!selectedHIDs.length}
              className="btn-themed"
              onClick={async () => {
                await bulkComentarioReplace({
                  historico_ids: selectedHIDs,
                  from: repFrom || '',
                  to: repTo || '',
                });
                setRepFrom('');
                setRepTo('');
                await load(true);
              }}
            >
              Aplicar em selecionados ({selectedHIDs.length})
            </button>
          </div>
        </div>
      )}

      {/* REMOVIDO: seção de Movimentar (Kanban) em massa */}

      {/* Tabela */}
      <div className="space-y-3 max-w-full mt-3">
        {groups.map(([pid, g]) => {
          const header = g.header;
          const rowKeys = g.hist.map((r) => keyOf(r));
          const groupChecked =
            rowKeys.length > 0 && rowKeys.every((k) => !!sel[k]);

          return (
            <div key={pid} className="border rounded">
              <div className="px-3 py-2 border-b panel-border bg-[var(--panel)] sticky top-0 z-10">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={groupChecked}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setSel((s) => {
                        const next = { ...s };
                        rowKeys.forEach((k) => (next[k] = checked));
                        return next;
                      });
                    }}
                  />
                  <div className="font-semibold">Processo {pid}</div>
                  <div className="text-xs opacity-70">
                    UC {header.uc} | {header.cliente} |{' '}
                    {header.concessionaria}
                  </div>
                </div>

                {/* Barra de ações por processo */}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs opacity-70">Mover para:</span>

                  <input
                    value={mvByPid[pid]?.etapa || ''}
                    onChange={(e) =>
                      setMvByPid((s) => ({
                        ...s,
                        [pid]: { ...(s[pid] || {}), etapa: e.target.value },
                      }))
                    }
                    placeholder="Etapa"
                    className="input-themed"
                  />
                  <input
                    value={mvByPid[pid]?.sub || ''}
                    onChange={(e) =>
                      setMvByPid((s) => ({
                        ...s,
                        [pid]: { ...(s[pid] || {}), sub: e.target.value },
                      }))
                    }
                    placeholder="Sub-etapa"
                    className="input-themed"
                  />
                  <input
                    value={mvByPid[pid]?.comentario || ''}
                    onChange={(e) =>
                      setMvByPid((s) => ({
                        ...s,
                        [pid]: {
                          ...(s[pid] || {}),
                          comentario: e.target.value,
                        },
                      }))
                    }
                    placeholder="Comentário (opcional)"
                    className="input-themed flex-1"
                  />

                  <button
                    className="btn-blue"
                    style={{
                      background: '#2563eb',
                      color: '#fff',
                      borderColor: '#2563eb',
                    }}
                    onClick={async () => {
                      const d = mvByPid[pid] || {};
                      const etap = (d.etapa || '').trim();
                      if (!etap) return;

                      setMoving(true);
                      try {
                        await bulkMover({
                          processo_ids: [pid],
                          etapa: etap,
                          sub_etapa: (d.sub || '').trim(),
                          comentario: (d.comentario || '').trim(),
                        });
                        setMvByPid((s) => ({
                          ...s,
                          [pid]: { etapa: '', sub: '', comentario: '' },
                        }));
                        await load(true);
                      } finally {
                        setMoving(false);
                      }
                    }}
                  >
                    Mover
                  </button>

                  <button
                    className="btn-green"
                    style={{
                      background: 'var(--success)',
                      color: '#fff',
                      borderColor: 'var(--success)',
                    }}
                    title="Salvar alterações deste processo (histórico ou movimento)"
                    onClick={async () => {
                      // Salva histórico redigido
                      const dHist = draftByPid[pid] || {};
                      const etapH = (dHist.etapa || '').trim();
                      const comH = (dHist.comentario || '').trim();

                      if (etapH || comH) {
                        await saveProcessoFull({
                          processo_id: pid,
                          historico: [
                            {
                              data: new Date()
                                .toISOString()
                                .slice(0, 19)
                                .replace('T', ' '),
                              comentario: comH,
                              etapa_nova: etapH || undefined,
                              sub_etapa: (dHist.sub || '') || undefined,
                            },
                          ],
                        });
                        setDraftByPid((s) => ({
                          ...s,
                          [pid]: { etapa: '', sub: '', comentario: '' },
                        }));
                      }

                      // Se houver draft de mover, aplica
                      const dMove = mvByPid[pid] || {};
                      const etapM = (dMove.etapa || '').trim();
                      if (etapM) {
                        await bulkMover({
                          processo_ids: [pid],
                          etapa: etapM,
                          sub_etapa: (dMove.sub || '').trim(),
                          comentario: (dMove.comentario || '').trim(),
                        });
                        setMvByPid((s) => ({
                          ...s,
                          [pid]: { etapa: '', sub: '', comentario: '' },
                        }));
                      }

                      await load(true);
                    }}
                  >
                    Salvar processo
                  </button>
                </div>
              </div>

              <div className="overflow-auto">
                <table className="min-w-[900px] md:min-w-[1000px] w-full text-sm">
                  <thead>
                    <tr>
                      {[
                        'Sel',
                        'HistID',
                        'Data',
                        'Comentário',
                        'Etapa',
                        'Sub-Etapa',
                        'Tipo',
                        'Ações',
                      ].map((h) => (
                        <th
                          key={h}
                          className="px-2 py-2 border-b text-left"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>

                  <tbody>
                    {g.hist.map((r) => {
                      const k = keyOf(r);
                      return (
                        <tr key={k} className="hover:bg-[var(--border)]/20">
                          <td className="px-2 py-1 border-b">
                            <input
                              type="checkbox"
                              checked={!!sel[k]}
                              onChange={(e) =>
                                setSel((s) => ({
                                  ...s,
                                  [k]: e.target.checked,
                                }))
                              }
                            />
                          </td>

                          <td className="px-2 py-1 border-b">{hidOf(r)}</td>
                          <td className="px-2 py-1 border-b">
                            {r.hist_data}
                          </td>

                          <td className="px-2 py-1 border-b">
                            <input
                              defaultValue={r.hist_comentario || ''}
                              className="input-themed w-full"
                              onBlur={async (e) => {
                                const txt = e.target.value;
                                if (txt !== r.hist_comentario) {
                                  await bulkComentarioReplace({
                                    historico_ids: [hidOf(r)],
                                    from: r.hist_comentario || '',
                                    to: txt,
                                  });
                                  await load(true);
                                }
                              }}
                            />
                          </td>

                          <td className="px-2 py-1 border-b">
                            <input
                              defaultValue={r.etapa || ''}
                              className="input-themed w-full"
                              onBlur={async (e) => {
                                const val = e.target.value;
                                if (val !== r.etapa) {
                                  await saveProcessoFull({
                                    processo_id: pid,
                                    historico: [
                                      {
                                        id_historico: hidOf(r),
                                        data:
                                          r.hist_data ||
                                          new Date()
                                            .toISOString()
                                            .slice(0, 19)
                                            .replace('T', ' '),
                                        comentario: r.hist_comentario || '',
                                        etapa_nova: val,
                                        sub_etapa:
                                          r.sub_etapa || undefined,
                                      },
                                    ],
                                  });
                                  await load(true);
                                }
                              }}
                            />
                          </td>

                          <td className="px-2 py-1 border-b">
                            <input
                              defaultValue={r.sub_etapa || ''}
                              className="input-themed w-full"
                              onBlur={async (e) => {
                                const val = e.target.value;
                                if (val !== r.sub_etapa) {
                                  await saveProcessoFull({
                                    processo_id: pid,
                                    historico: [
                                      {
                                        id_historico: hidOf(r),
                                        data:
                                          r.hist_data ||
                                          new Date()
                                            .toISOString()
                                            .slice(0, 19)
                                            .replace('T', ' '),
                                        comentario: r.hist_comentario || '',
                                        etapa_nova:
                                          r.etapa || undefined,
                                        sub_etapa: val,
                                      },
                                    ],
                                  });
                                  await load(true);
                                }
                              }}
                            />
                          </td>

                          <td className="px-2 py-1 border-b">
                            {r.tipo_movimentacao}
                          </td>

                          <td className="px-2 py-1 border-b">
                            {hidOf(r) ? (
                              <button
                                className="px-2 py-1 border rounded"
                                onClick={async () => {
                                  await deleteHistorico(hidOf(r));
                                  await load(true);
                                }}
                              >
                                Excluir
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="px-3 py-2 text-xs border-t space-y-2">
                <div className="opacity-70">
                  Forma: {header.forma_devolucao || '-'} | Valor: {header.valor_fluxo ?? ''} | Data Fluxo: {header.data_fluxo || '-'}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-start">
                  <div>
                    <div className="text-xs opacity-70 mb-1">Crédito Simples</div>
                    <input
                      aria-label="Crédito Simples"
                      type="number"
                      step="0.01"
                      className="input-themed w-full"
                      placeholder="Crédito Simples"
                      value={
                        (deferByPid[pid]?.cs ?? (header.credito_simples ?? ''))
                      }
                      onChange={(e) =>
                        setDeferByPid((s) => ({
                          ...s,
                          [pid]: {
                            ...(s[pid] || {}),
                            cs: e.target.value,
                          },
                        }))
                      }
                    />
                  </div>
                  <div>
                    <div className="text-xs opacity-70 mb-1">Data Simples</div>
                    <input
                      aria-label="Data Simples"
                      type="date"
                      className="input-themed w-full"
                      placeholder="Data Simples"
                      value={
                        (deferByPid[pid]?.ds ?? (header.data_simples || ''))
                      }
                      onChange={(e) =>
                        setDeferByPid((s) => ({
                          ...s,
                          [pid]: {
                            ...(s[pid] || {}),
                            ds: e.target.value,
                          },
                        }))
                      }
                    />
                  </div>
                  <div>
                    <div className="text-xs opacity-70 mb-1">Crédito Dobro</div>
                    <input
                      aria-label="Crédito Dobro"
                      type="number"
                      step="0.01"
                      className="input-themed w-full"
                      placeholder="Crédito Dobro"
                      value={
                        (deferByPid[pid]?.cd ?? (header.credito_dobro ?? ''))
                      }
                      onChange={(e) =>
                        setDeferByPid((s) => ({
                          ...s,
                          [pid]: {
                            ...(s[pid] || {}),
                            cd: e.target.value,
                          },
                        }))
                      }
                    />
                  </div>
                  <div>
                    <div className="text-xs opacity-70 mb-1">Data Dobro</div>
                    <input
                      aria-label="Data Dobro"
                      type="date"
                      className="input-themed w-full"
                      placeholder="Data Dobro"
                      value={
                        (deferByPid[pid]?.dd ?? (header.data_dobro || ''))
                      }
                      onChange={(e) =>
                        setDeferByPid((s) => ({
                          ...s,
                          [pid]: {
                            ...(s[pid] || {}),
                            dd: e.target.value,
                          },
                        }))
                      }
                    />
                  </div>
                </div>
                <div className="text-right">
                  <button
                    className="btn-themed"
                    onClick={async () => {
                      const cur = deferByPid[pid] || {};
                      const cs = cur.cs ?? header.credito_simples ?? '';
                      const ds = cur.ds ?? header.data_simples ?? '';
                      const cd = cur.cd ?? header.credito_dobro ?? '';
                      const dd = cur.dd ?? header.data_dobro ?? '';

                      const payload = {
                        processo_id: pid,
                        deferimento: JSON.stringify({
                          data_procedencia: (ds || '').trim() || undefined,
                          credito_simples: cs !== '' && !isNaN(Number(cs)) ? Number(cs) : undefined,
                          credito_dobro: cd !== '' && !isNaN(Number(cd)) ? Number(cd) : undefined,
                          data_credito_dobro: (dd || '').trim() || undefined,
                        }),
                      };
                      await saveProcessoFull(payload);
                      await load(true);
                    }}
                  >
                    Salvar deferimento
                  </button>
                </div>
              </div>

              <div className="px-3 py-3 border-t flex items-center gap-2">
                <span className="text-sm">Adicionar histórico:</span>

                <input
                  value={draftByPid[pid]?.etapa || ''}
                  onChange={(e) =>
                    setDraftByPid((s) => ({
                      ...s,
                      [pid]: {
                        ...(s[pid] || {}),
                        etapa: e.target.value,
                      },
                    }))
                  }
                  placeholder="Etapa"
                  className="input-themed"
                />
                <input
                  value={draftByPid[pid]?.sub || ''}
                  onChange={(e) =>
                    setDraftByPid((s) => ({
                      ...s,
                      [pid]: { ...(s[pid] || {}), sub: e.target.value },
                    }))
                  }
                  placeholder="Sub-etapa"
                  className="input-themed"
                />
                <input
                  value={draftByPid[pid]?.comentario || ''}
                  onChange={(e) =>
                    setDraftByPid((s) => ({
                      ...s,
                      [pid]: {
                        ...(s[pid] || {}),
                        comentario: e.target.value,
                      },
                    }))
                  }
                  placeholder="Comentário"
                  className="input-themed flex-1"
                />

                <button
                  className="btn-themed"
                  onClick={async () => {
                    const d = draftByPid[pid] || {};
                    const etap = (d.etapa || '').trim();
                    const comentario = (d.comentario || '').trim();
                    if (!etap && !comentario) return;

                    await saveProcessoFull({
                      processo_id: pid,
                      historico: [
                        {
                          data: new Date()
                            .toISOString()
                            .slice(0, 19)
                            .replace('T', ' '),
                          comentario,
                          etapa_nova: etap || undefined,
                          sub_etapa: (d.sub || '') || undefined,
                        },
                      ],
                    });

                    setDraftByPid((s) => ({
                      ...s,
                      [pid]: { etapa: '', sub: '', comentario: '' },
                    }));
                    await load(true);
                  }}
                >
                  Adicionar
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {/* Toast feedback */}
      <Toast
        open={toast.open}
        type={toast.type}
        message={toast.text}
        onClose={() => setToast((t) => ({ ...t, open: false }))}
      />

      {/* Pager */}
      <div className="py-3 text-center">
        <div className="flex items-center justify-center gap-2">
          {hasMore && (
            <button
              disabled={loading || loadingAll}
              className="btn-outline"
              onClick={() => load(false)}
            >
              {loading ? 'Carregando...' : 'Carregar mais'}
            </button>
          )}

          <button
            disabled={loading || loadingAll}
            className="btn-outline"
            onClick={loadAll}
          >
            {loadingAll ? 'Carregando todos...' : 'Carregar todos'}
          </button>

          {!hasMore && !loadingAll && (
            <div className="text-xs opacity-70">
              Todos os itens carregados.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
