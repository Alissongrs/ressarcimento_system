// src/pages/Backlog.jsx
import React from 'react';
import { Link } from 'react-router-dom';
import { getBacklog, toggleBacklogCheck } from '../services/requisicaoService';

const fmtDateTime = (v) => {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('pt-BR');
  } catch {
    return '—';
  }
};

const fmtCurrency = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

const sortRows = (list = []) =>
  list
    .slice()
    .sort((a, b) => {
      const aChecked = !!a.checked;
      const bChecked = !!b.checked;
      if (aChecked !== bChecked) return aChecked ? 1 : -1;
      const da = a.data_ultima_movimentacao ? new Date(a.data_ultima_movimentacao) : new Date(0);
      const db = b.data_ultima_movimentacao ? new Date(b.data_ultima_movimentacao) : new Date(0);
      return da - db;
    });

const formatMes = (isoMonth) => {
  if (!isoMonth || isoMonth === 'sem-data') return 'Sem data';
  try {
    return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(
      new Date(`${isoMonth}-01`),
    );
  } catch {
    return 'Sem data';
  }
};

const groupByMes = (list) => {
  const acc = {};
  for (const r of list) {
    const dt = r.data_ultima_movimentacao ? new Date(r.data_ultima_movimentacao) : null;
    const key = dt ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}` : 'sem-data';
    if (!acc[key]) acc[key] = [];
    acc[key].push(r);
  }
  return Object.keys(acc)
    .sort((a, b) => {
      if (a === 'sem-data') return 1;
      if (b === 'sem-data') return -1;
      return new Date(`${a}-01`) - new Date(`${b}-01`);
    })
    .map((k) => ({ key: k, label: formatMes(k), items: acc[k] }));
};

export default function Backlog() {
  const [rows, setRows] = React.useState([]);
  const [err, setErr] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [updating, setUpdating] = React.useState(false);
  const [buscaCliente, setBuscaCliente] = React.useState('');
  const [buscaConcess, setBuscaConcess] = React.useState('');
  const pendentesRef = React.useRef(null);
  const aguardandoRef = React.useRef(null);

  React.useEffect(() => {
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const data = await getBacklog();
        const rowsNorm = Array.isArray(data?.rows)
          ? data.rows
          : Array.isArray(data)
          ? data
          : [];
        setRows(sortRows(rowsNorm));
      } catch {
        setErr('Falha ao carregar backlog.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtrar = React.useCallback(
    (list) => {
      const cli = buscaCliente.trim().toLowerCase();
      const conc = buscaConcess.trim().toLowerCase();
      return list.filter((r) => {
        const okCli = cli
          ? (r.cliente || '').toLowerCase().includes(cli) || (r.uc || '').toLowerCase().includes(cli)
          : true;
        const okConc = conc ? (r.concessionaria || '').toLowerCase().includes(conc) : true;
        return okCli && okConc;
      });
    },
    [buscaCliente, buscaConcess],
  );

  const pendentes = filtrar(rows.filter((r) => !r.checked));
  const aguardando = filtrar(rows.filter((r) => !!r.checked));

  const gruposPendentes = groupByMes(pendentes);
  const gruposAguardando = groupByMes(aguardando);

  const renderGrupo = (title, grupos) => (
    <div className="flex flex-col gap-4" ref={title === 'Pendentes' ? pendentesRef : aguardandoRef}>
      <h2 className="text-lg font-semibold">{title}</h2>
      {grupos.length === 0 ? (
        <div className="opacity-70 text-sm">Nenhum processo nesta lista.</div>
      ) : (
        grupos.map((g) => (
          <div key={g.key} className="flex gap-2 items-stretch">
            <div className="w-12 flex items-center justify-center bg-[var(--panel)] border border-[var(--border)] rounded-lg">
              <span
                className="text-xs font-semibold px-1"
                style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
              >
                {g.label}
              </span>
            </div>
            <div className="flex-1 overflow-x-auto border border-[var(--border)] rounded-lg">
              <table className="min-w-full text-sm table-fixed">
                <thead className="bg-[var(--panel)] text-[var(--fg)] border-b border-[var(--border)]">
                  <tr>
                    <th className="text-left px-3 py-2 w-16 whitespace-nowrap">ID</th>
                    <th className="text-left px-3 py-2 w-56 whitespace-nowrap">Cliente / UC</th>
                    <th className="text-left px-3 py-2 w-44 whitespace-nowrap">Concessionária</th>
                    <th className="text-left px-3 py-2 w-32 whitespace-nowrap">Valor estimado</th>
                    <th className="text-left px-3 py-2 w-40 whitespace-nowrap">Última movimentação</th>
                    <th className="text-left px-3 py-2 w-28 whitespace-nowrap">Dias sem mov.</th>
                    <th className="text-left px-3 py-2 w-44 whitespace-nowrap">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map((r) => (
                    <tr key={r.id} className="border-b border-[var(--border)] hover:bg-[var(--panel)]/60">
                      <td className="px-3 py-2 w-16">
                        <Link to={`/admin/planilha?pid=${r.id}`} className="text-[var(--accent)] underline">
                          #{r.id}
                        </Link>
                      </td>
                      <td className="px-3 py-2 w-56">
                        <div className="font-semibold">{r.cliente || '—'}</div>
                        <div className="text-xs opacity-70">UC: {r.uc || '—'}</div>
                      </td>
                      <td className="px-3 py-2 w-44 whitespace-nowrap">{r.concessionaria || '—'}</td>
                      <td className="px-3 py-2 w-32 whitespace-nowrap">{fmtCurrency(r.valor_estimado)}</td>
                      <td className="px-3 py-2 w-40 whitespace-nowrap">{fmtDateTime(r.data_ultima_movimentacao)}</td>
                      <td className="px-3 py-2 w-28 whitespace-nowrap">{r.dias_sem_movimentacao ?? '—'}</td>
                      <td className="px-3 py-2 w-44 whitespace-nowrap">
                        {!r.checked ? (
                          <button
                            className="px-3 py-1 rounded-full text-xs font-semibold border transition bg-amber-500 text-white border-amber-500 hover:bg-amber-600 disabled:opacity-60"
                            disabled={updating}
                            onClick={async () => {
                              setUpdating(true);
                              try {
                                await toggleBacklogCheck(r.id, true);
                                setRows((prev) =>
                                  sortRows(prev.map((x) => (x.id === r.id ? { ...x, checked: true } : x))),
                                );
                              } catch {
                                setErr('Falha ao marcar como Aguardando definição.');
                              } finally {
                                setUpdating(false);
                              }
                            }}
                          >
                            Aguardando definicao
                          </button>
                        ) : (
  <button
    className="px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-500 border border-amber-400 hover:bg-amber-500/30 disabled:opacity-60"
    disabled={updating}
    onClick={async () => {
      setUpdating(true);
      try {
        await toggleBacklogCheck(r.id, false);
        setRows((prev) =>
          sortRows(prev.map((x) => (x.id === r.id ? { ...x, checked: false } : x))),
        );
      } catch {
        setErr('Falha ao remover de Aguardando definicao.');
      } finally {
        setUpdating(false);
      }
    }}
  >
    Aguardando definicao
  </button>
)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );

  return (
    <div className="max-w-6xl mx-auto p-6 text-[var(--fg)]">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Backlog</h1>
        <p className="opacity-80">
          Processos com última movimentação mais antiga (aparecem a partir de 60 dias sem movimentação).
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <label className="flex flex-col text-sm gap-1">
          <span className="opacity-70">Filtrar por cliente / UC</span>
          <input
            value={buscaCliente}
            onChange={(e) => setBuscaCliente(e.target.value)}
            placeholder="Digite parte do cliente ou UC"
            className="px-3 py-2 rounded border border-[var(--border)] bg-[var(--panel)]"
          />
        </label>
        <label className="flex flex-col text-sm gap-1">
          <span className="opacity-70">Filtrar por concessionaria</span>
          <input
            value={buscaConcess}
            onChange={(e) => setBuscaConcess(e.target.value)}
            placeholder="Digite parte da concessionaria"
            className="px-3 py-2 rounded border border-[var(--border)] bg-[var(--panel)]"
          />
        </label>
      </div>

      {loading && <div className="opacity-70 sap-loading">Carregando...</div>}
      {err && <div className="text-red-500 text-sm mb-3">{err}</div>}

      {!loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
          <button
            type="button"
            onClick={() => aguardandoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className="text-left p-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] transition hover:border-amber-400"
          >
            <div className="text-xs opacity-70">Aguardando definição</div>
            <div className="text-2xl font-bold text-amber-400">{aguardando.length}</div>
          </button>
          <button
            type="button"
            onClick={() => pendentesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className="text-left p-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] transition hover:border-[var(--accent)]/60"
          >
            <div className="text-xs opacity-70">Pendentes</div>
            <div className="text-2xl font-bold text-[var(--accent)]">{pendentes.length}</div>
          </button>
        </div>
      )}

      {!loading && pendentes.length === 0 && aguardando.length === 0 && !err && (
        <div className="opacity-70">Nenhum processo encontrado.</div>
      )}

      {!loading && pendentes.length > 0 && renderGrupo('Pendentes', gruposPendentes)}

      {!loading && aguardando.length > 0 && renderGrupo('Aguardando definição', gruposAguardando)}

      {updating && <div className="text-xs opacity-70 mt-2">Salvando...</div>}
    </div>
  );
}

