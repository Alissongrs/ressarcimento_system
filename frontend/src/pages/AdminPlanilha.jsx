import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Filter, Search, RefreshCcw } from 'lucide-react';
import { listPlanilha, bulkMover } from '../services/adminPlanilhaService';
import { saveProcessoFull } from '../services/adminEditorService';
import Toast from '../components/Toast.jsx';

const kanbanColumns = [
  'Ativos',
  'Deferidos',
  'Fluxo de Ressarcimento',
  'Faturamento',
  'Concluídos',
  'Indeferidos',
  'Suspensos',
];

const etapaToColuna = (etapaNome) => {
  const e = String(etapaNome || '').trim().toLowerCase();
  if (!e) return 'Ativos';
  if (/(deferid|pendente|concil|contest)/.test(e)) return 'Deferidos';
  if (/(fluxo.*ressarc|validacao|valida|financeiro)/.test(e)) return 'Fluxo de Ressarcimento';
  if (/fatur/.test(e)) return 'Faturamento';
  if (/(conclu)/.test(e)) return 'Concluídos';
  if (/(indefer)/.test(e)) return 'Indeferidos';
  if (/(suspenso)/.test(e)) return 'Suspensos';
  return 'Ativos';
};

const toNumberValue = (value) => {
  if (value === '' || value == null) return '';
  const normalized = String(value).trim().replace(/\./g, '').replace(',', '.');
  const num = Number(normalized);
  return Number.isNaN(num) ? '' : num;
};

const detailValue = (details, pid, field, fallback) =>
  details[pid]?.[field] ?? fallback ?? '';

export default function AdminPlanilha() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadingAll, setLoadingAll] = useState(false);
  const offsetRef = useRef(0);
  const [q, setQ] = useState('');
  const [etapa, setEtapa] = useState('');
  const [sub, setSub] = useState('');
  const [ini, setIni] = useState('');
  const [fim, setFim] = useState('');
  const [kanbanFilter, setKanbanFilter] = useState('');
  const [showHistoryAll, setShowHistoryAll] = useState(false);
  const [toast, setToast] = useState({ open: false, type: 'info', text: '' });
  const [mvByPid, setMvByPid] = useState({});
  const [detailsByPid, setDetailsByPid] = useState({});
  const [bulkEtapa, setBulkEtapa] = useState('');
  const [bulkSub, setBulkSub] = useState('');
  const [bulkComentario, setBulkComentario] = useState('');
  const limit = 100;

  const load = useCallback(
    async (reset = false) => {
      setLoading(true);
      try {
        const payload = {
          q: q || undefined,
          etapa: etapa || undefined,
          sub: sub || undefined,
          ini: ini || undefined,
          fim: fim || undefined,
          coluna: kanbanFilter || undefined,
          limit,
          offset: reset ? 0 : offsetRef.current,
        };
        const data = await listPlanilha(payload);
        if (reset) {
          setRows(data);
          offsetRef.current = data.length;
        } else {
          setRows((prev) => [...prev, ...data]);
          offsetRef.current += data.length;
        }
        setHasMore(data.length === limit);
      } finally {
        setLoading(false);
      }
    },
    [q, etapa, sub, ini, fim, kanbanFilter],
  );

  const loadAll = useCallback(async () => {
    if (loadingAll) return;
    setLoadingAll(true);
    setLoading(true);
    try {
      const chunk = 1000;
      let off = 0;
      let acc = [];
      const base = {
        q: q || undefined,
        etapa: etapa || undefined,
        sub: sub || undefined,
        ini: ini || undefined,
        fim: fim || undefined,
        coluna: kanbanFilter || undefined,
      };
      while (true) {
        const part = await listPlanilha({ ...base, limit: chunk, offset: off });
        if (!Array.isArray(part)) break;
        acc = [...acc, ...part];
        if (part.length < chunk) break;
        off += chunk;
      }
      setRows(acc);
      offsetRef.current = acc.length;
      setHasMore(false);
    } finally {
      setLoading(false);
      setLoadingAll(false);
    }
  }, [q, etapa, sub, ini, fim, kanbanFilter, loadingAll]);

  useEffect(() => {
    load(true);
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map();
    (rows || []).forEach((r) => {
      const pid = Number(r.processo_id ?? r.ProcessoID ?? r.processoId ?? r.id ?? 0) || 0;
      if (!map.has(pid)) map.set(pid, { header: r, hist: [] });
      map.get(pid).hist.push(r);
    });
    return Array.from(map.entries());
  }, [rows]);

  const tableRows = useMemo(() => {
    return groups.map(([pid, g]) => ({
      pid,
      header: g.header,
      history: g.hist,
      kanban: etapaToColuna(g.header.etapa || g.header.Etapa),
    }));
  }, [groups]);

  const filteredRows = useMemo(() => {
    if (!kanbanFilter) return tableRows;
    return tableRows.filter((row) => row.kanban === kanbanFilter);
  }, [tableRows, kanbanFilter]);

  const candidatePIDs = useMemo(() => filteredRows.map((row) => row.pid), [filteredRows]);

  const handleSaveProcesso = async (pid, header) => {
    const detail = detailsByPid[pid] || {};
    const cs = detail.cs ?? header.credito_simples ?? '';
    const ds = detail.ds ?? header.data_simples ?? '';
    const cd = detail.cd ?? header.credito_dobro ?? '';
    const dd = detail.dd ?? header.data_dobro ?? '';
    const fluxo = {
      forma_devolucao: detail.forma || header.forma_devolucao || '',
      valor: toNumberValue(detail.valor_fluxo ?? header.valor_fluxo ?? ''),
      data_devolucao: detail.data_fluxo || header.data_fluxo || '',
    };
    const faturamento = {
      numero_nf: detail.numero_nf || header.numero_nf || '',
      data_emissao: detail.data_emissao || header.data_emissao || '',
      data_vencimento: detail.data_vencimento || header.data_vencimento || '',
      data_pagamento: detail.data_pagamento || header.data_pagamento || '',
      valor: toNumberValue(detail.valor_nf ?? header.valor_nf ?? ''),
    };
    const payload = { processo_id: pid };
    const deferimentoHas =
      (ds && ds !== '') ||
      (dd && dd !== '') ||
      (cs !== '' && Number(cs) !== 0) ||
      (cd !== '' && Number(cd) !== 0);
    if (deferimentoHas) {
      payload.deferimento = JSON.stringify({
        data_procedencia: ds || '',
        credito_simples: cs === '' ? undefined : Number(cs),
        credito_dobro: cd === '' ? undefined : Number(cd),
        data_credito_dobro: dd || '',
      });
    }
    payload.fluxo_ressarcimento = JSON.stringify({
      itens: [
        {
          forma_devolucao: fluxo.forma_devolucao,
          valor: fluxo.valor,
          data_devolucao: fluxo.data_devolucao,
        },
      ],
    });
    payload.faturamento = JSON.stringify({
      itens: [
        {
          numero_nf: faturamento.numero_nf,
          data_emissao: faturamento.data_emissao,
          data_vencimento: faturamento.data_vencimento,
          data_pagamento: faturamento.data_pagamento,
          valor: faturamento.valor,
        },
      ],
    });
    try {
      await saveProcessoFull(payload);
      setToast({ open: true, type: 'success', text: `Dados salvos para ${pid}.` });
      await load(true);
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Falha ao salvar processo.' });
    }
  };

  const handleMoveProcesso = async (pid) => {
    const dados = mvByPid[pid] || {};
    const etapaDestino = (dados.etapa || '').trim();
    if (!etapaDestino) return;
    setLoading(true);
    try {
      await bulkMover({
        processo_ids: [pid],
        etapa: etapaDestino,
        sub_etapa: (dados.sub || '').trim(),
        comentario: (dados.comentario || '').trim(),
      });
      setToast({ open: true, type: 'success', text: `Processo ${pid} movido.` });
      setMvByPid((prev) => ({ ...prev, [pid]: { etapa: '', sub: '', comentario: '' } }));
      await load(true);
    } catch (err) {
      setToast({ open: true, type: 'error', text: err?.message || 'Erro ao mover processo.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 border rounded panel-bg-60 panel-border space-y-4">
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <div className="flex items-center gap-2">
          <Search size={16} />
          <input
            placeholder="Busca (cliente, UC, comentário)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="input-themed w-full"
          />
        </div>
        <input
          placeholder="Etapa"
          value={etapa}
          onChange={(e) => setEtapa(e.target.value)}
          className="input-themed"
        />
        <input
          placeholder="Sub-etapa"
          value={sub}
          onChange={(e) => setSub(e.target.value)}
          className="input-themed"
        />
        <select
          value={kanbanFilter}
          onChange={(e) => setKanbanFilter(e.target.value)}
          className="input-themed"
        >
          <option value="">Coluna (todas)</option>
          {kanbanColumns.map((col) => (
            <option key={col}>{col}</option>
          ))}
        </select>
        <div className="flex items-center gap-2">
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
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn-themed inline-flex items-center gap-1"
            onClick={() => load(true)}
            disabled={loading}
          >
            <Filter size={16} />
            Filtrar
          </button>
          <button
            className="btn-outline inline-flex items-center gap-1"
            onClick={loadAll}
            disabled={loadingAll}
          >
            <RefreshCcw size={16} />
            Carregar todos
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4 items-end">
        <div>
          <label className="text-xs uppercase tracking-wide">Etapa destino</label>
          <input
            className="input-themed w-full"
            value={bulkEtapa}
            onChange={(e) => setBulkEtapa(e.target.value)}
            placeholder="Ex.: Concluídos"
          />
        </div>
        <div>
          <label className="text-xs uppercase tracking-wide">Sub-etapa</label>
          <input
            className="input-themed w-full"
            value={bulkSub}
            onChange={(e) => setBulkSub(e.target.value)}
            placeholder="Ex.: Arquivado"
          />
        </div>
        <div className="md:col-span-2 lg:col-span-2">
          <label className="text-xs uppercase tracking-wide">Comentário (opcional)</label>
          <input
            className="input-themed w-full"
            value={bulkComentario}
            onChange={(e) => setBulkComentario(e.target.value)}
            placeholder="Comentário padrão para o novo histórico"
          />
        </div>
        <div className="md:col-span-3 flex justify-end">
          <button
            className="btn-themed"
            disabled={!bulkEtapa.trim() || !candidatePIDs.length}
            onClick={async () => {
              setLoading(true);
              try {
                await bulkMover({
                  processo_ids: candidatePIDs,
                  etapa: bulkEtapa.trim(),
                  sub_etapa: bulkSub.trim(),
                  comentario: bulkComentario.trim(),
                });
                setToast({
                  open: true,
                  type: 'success',
                  text: `Aplicado em ${candidatePIDs.length} processo(s)`,
                });
                await load(true);
              } catch (err) {
                setToast({
                  open: true,
                  type: 'error',
                  text: err?.message || 'Erro ao aplicar em massa',
                });
              } finally {
                setLoading(false);
              }
            }}
          >
            Aplicar etapa/subetapa aos resultados ({candidatePIDs.length})
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <button
          className="btn-outline text-sm"
          onClick={() => setShowHistoryAll((prev) => !prev)}
        >
          {showHistoryAll ? 'Ocultar históricos' : 'Mostrar históricos'}
        </button>
        <span className="text-xs opacity-60">
          Quando ativo, cada processo mostra seu histórico completo abaixo da linha.
        </span>
      </div>

      <div className="text-xs opacity-70">
        Os filtros acima consultam diretamente o servidor (etapa, subetapa, palavra-chave, período e coluna). Os campos exibidos à direita são carregados via `/admin/planilha` e podem ser alterados in-line.
      </div>

      <div className="overflow-auto">
        <table className="min-w-[1200px] w-full text-sm border border-slate-200">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide">
            <tr>
              {[
                'Processo',
                'UC',
                'Cliente',
                'Etapa',
                'Sub-etapa',
                'Crédito Simples',
                'Data Simples',
                'Crédito Dobro',
                'Data Dobro',
                'Fluxo (Forma)',
                'Fluxo (Valor)',
                'Fluxo (Data)',
                'NF',
                'NF Emissão',
                'NF Venc.',
                'NF Pag.',
                'Valor NF',
                'Mover Etapa',
                'Mover Sub',
                'Coment.',
                'Ações',
              ].map((col) => (
                <th key={col} className="px-2 py-2 border-b">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map(({ pid, header, history }) => (
              <React.Fragment key={`row-${pid}`}>
                <tr className="odd:bg-white even:bg-slate-50">
                  <td className="px-2 py-2 border-b">{pid}</td>
                  <td className="px-2 py-2 border-b">{header.uc || header.Uc || '-'}</td>
                  <td className="px-2 py-2 border-b">{header.cliente || '-'}</td>
                  <td className="px-2 py-2 border-b">{header.etapa || header.Etapa || '-'}</td>
                  <td className="px-2 py-2 border-b">{header.sub_etapa || header.SubEtapa || '-'}</td>
                  <td className="px-2 py-2 border-b">
                    <input
                      className="input-themed text-xs"
                      value={detailValue(detailsByPid, pid, 'cs', header.credito_simples)}
                      onChange={(e) =>
                        setDetailsByPid((prev) => ({
                          ...prev,
                          [pid]: { ...(prev[pid] || {}), cs: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-2 border-b">
                    <input
                      type="date"
                      className="input-themed text-xs"
                      value={detailValue(detailsByPid, pid, 'ds', header.data_simples)}
                      onChange={(e) =>
                        setDetailsByPid((prev) => ({
                          ...prev,
                          [pid]: { ...(prev[pid] || {}), ds: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-2 border-b">
                    <input
                      className="input-themed text-xs"
                      value={detailValue(detailsByPid, pid, 'cd', header.credito_dobro)}
                      onChange={(e) =>
                        setDetailsByPid((prev) => ({
                          ...prev,
                          [pid]: { ...(prev[pid] || {}), cd: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-2 border-b">
                    <input
                      type="date"
                      className="input-themed text-xs"
                      value={detailValue(detailsByPid, pid, 'dd', header.data_dobro)}
                      onChange={(e) =>
                        setDetailsByPid((prev) => ({
                          ...prev,
                          [pid]: { ...(prev[pid] || {}), dd: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-2 border-b">
                    <input
                      className="input-themed text-xs"
                      value={detailValue(detailsByPid, pid, 'forma', header.forma_devolucao)}
                      onChange={(e) =>
                        setDetailsByPid((prev) => ({
                          ...prev,
                          [pid]: { ...(prev[pid] || {}), forma: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-2 border-b">
                    <input
                      type="number"
                      step="0.01"
                      className="input-themed text-xs"
                      value={detailValue(detailsByPid, pid, 'valor_fluxo', header.valor_fluxo)}
                      onChange={(e) =>
                        setDetailsByPid((prev) => ({
                          ...prev,
                          [pid]: { ...(prev[pid] || {}), valor_fluxo: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-2 border-b">
                    <input
                      type="date"
                      className="input-themed text-xs"
                      value={detailValue(detailsByPid, pid, 'data_fluxo', header.data_fluxo)}
                      onChange={(e) =>
                        setDetailsByPid((prev) => ({
                          ...prev,
                          [pid]: { ...(prev[pid] || {}), data_fluxo: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-2 border-b">
                    <input
                      className="input-themed text-xs"
                      value={detailValue(detailsByPid, pid, 'numero_nf', header.numero_nf)}
                      onChange={(e) =>
                        setDetailsByPid((prev) => ({
                          ...prev,
                          [pid]: { ...(prev[pid] || {}), numero_nf: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-2 border-b">
                    <input
                      type="date"
                      className="input-themed text-xs"
                      value={detailValue(detailsByPid, pid, 'data_emissao', header.data_emissao)}
                      onChange={(e) =>
                        setDetailsByPid((prev) => ({
                          ...prev,
                          [pid]: { ...(prev[pid] || {}), data_emissao: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-2 border-b">
                    <input
                      type="date"
                      className="input-themed text-xs"
                      value={detailValue(detailsByPid, pid, 'data_vencimento', header.data_vencimento)}
                      onChange={(e) =>
                        setDetailsByPid((prev) => ({
                          ...prev,
                          [pid]: { ...(prev[pid] || {}), data_vencimento: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-2 border-b">
                    <input
                      type="date"
                      className="input-themed text-xs"
                      value={detailValue(detailsByPid, pid, 'data_pagamento', header.data_pagamento)}
                      onChange={(e) =>
                        setDetailsByPid((prev) => ({
                          ...prev,
                          [pid]: { ...(prev[pid] || {}), data_pagamento: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-2 border-b">
                    <input
                      type="number"
                      step="0.01"
                      className="input-themed text-xs"
                      value={detailValue(detailsByPid, pid, 'valor_nf', header.valor_nf)}
                      onChange={(e) =>
                        setDetailsByPid((prev) => ({
                          ...prev,
                          [pid]: { ...(prev[pid] || {}), valor_nf: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-2 border-b">
                    <input
                      className="input-themed text-xs"
                      placeholder="Etapa"
                      value={mvByPid[pid]?.etapa || ''}
                      onChange={(e) =>
                        setMvByPid((prev) => ({
                          ...prev,
                          [pid]: { ...(prev[pid] || {}), etapa: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-2 border-b">
                    <input
                      className="input-themed text-xs"
                      placeholder="Sub"
                      value={mvByPid[pid]?.sub || ''}
                      onChange={(e) =>
                        setMvByPid((prev) => ({
                          ...prev,
                          [pid]: { ...(prev[pid] || {}), sub: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-2 border-b">
                    <input
                      className="input-themed text-xs"
                      placeholder="Comentário"
                      value={mvByPid[pid]?.comentario || ''}
                      onChange={(e) =>
                        setMvByPid((prev) => ({
                          ...prev,
                          [pid]: { ...(prev[pid] || {}), comentario: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-2 border-b">
                    <div className="flex flex-col gap-1">
                      <button className="btn-themed text-xs" onClick={() => handleSaveProcesso(pid, header)}>
                        Salvar
                      </button>
                      <button className="btn-outline text-xs" onClick={() => handleMoveProcesso(pid)}>
                        Mover
                      </button>
                    </div>
                  </td>
                  <td className="px-2 py-2 border-b text-center">{etapaToColuna(header.etapa)}</td>
                </tr>
                {showHistoryAll && history.length > 0 && (
                  <tr className="bg-slate-100">
                    <td colSpan={21} className="px-3 py-2 border-b text-xs space-y-2">
                      {history.map((item, idx) => (
                        <div key={`${pid}-${idx}`} className="flex flex-wrap gap-3">
                          <span className="font-semibold">{item.hist_data}</span>
                          <span className="opacity-70">Etapa: {item.etapa || item.Etapa}</span>
                          <span className="opacity-70">Sub: {item.sub_etapa || item.SubEtapa}</span>
                          <span className="flex-1">{item.hist_comentario || '-'}</span>
                        </div>
                      ))}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <Toast open={toast.open} type={toast.type} message={toast.text} onClose={() => setToast((t) => ({ ...t, open: false }))} />

      <div className="py-4 text-center">
        {loading && <div className="text-sm opacity-70">Carregando...</div>}
        {hasMore && !loading && (
          <button className="btn-outline" onClick={() => load(false)}>
            Carregar mais ({rows.length} carregados)
          </button>
        )}
      </div>
    </div>
  );
}
