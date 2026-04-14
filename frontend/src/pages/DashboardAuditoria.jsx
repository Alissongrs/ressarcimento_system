import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  DollarSign,
  Search,
} from 'lucide-react';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';

const fmt = (n) =>
  new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n ?? 0);

const fmtPct = (n) => `${(n ?? 0).toFixed(1)}%`;

const fmtBRL = (n) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n ?? 0);

// ── Barra de progresso inline ──────────────────────────────────────────────────
function ProgressBar({ value, color = '#6d28d9' }) {
  const pct = Math.min(100, Math.max(0, value ?? 0));
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-xs tabular-nums w-10 text-right text-gray-500 dark:text-gray-400">
        {fmtPct(pct)}
      </span>
    </div>
  );
}

// ── Cabeçalho de coluna ordenável ──────────────────────────────────────────────
function SortHeader({ label, field, sortState, onSort, className = '' }) {
  const active = sortState.field === field;
  return (
    <th
      className={`px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide cursor-pointer select-none whitespace-nowrap ${className}`}
      onClick={() => onSort(field)}
    >
      <span className="flex items-center gap-1">
        {label}
        {active ? (
          sortState.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
        ) : (
          <ChevronsUpDown size={12} className="opacity-30" />
        )}
      </span>
    </th>
  );
}

// ── Totalizador ────────────────────────────────────────────────────────────────
function TotaisBar({ clientes }) {
  const t = useMemo(() => {
    return clientes.reduce(
      (acc, c) => ({
        total:        acc.total        + (c.total_faturas       ?? 0),
        analisadas:   acc.analisadas   + (c.faturas_analisadas  ?? 0),
        nao:          acc.nao          + (c.nao_analisadas      ?? 0),
        anomalias:    acc.anomalias    + (c.anomalias_encontradas ?? 0),
        confirmados:  acc.confirmados  + (c.casos_confirmados   ?? 0),
        descartados:  acc.descartados  + (c.casos_descartados   ?? 0),
        ressarcimento: acc.ressarcimento + (c.ressarcimento_estimado ?? 0),
      }),
      { total: 0, analisadas: 0, nao: 0, anomalias: 0, confirmados: 0, descartados: 0, ressarcimento: 0 },
    );
  }, [clientes]);

  const cards = [
    { label: 'Faturas',        value: fmt(t.total),        icon: <Clock size={16} />,         color: 'text-gray-500' },
    { label: 'Analisadas',     value: fmt(t.analisadas),   icon: <CheckCircle2 size={16} />,  color: 'text-blue-500' },
    { label: 'Não analisadas', value: fmt(t.nao),          icon: <Clock size={16} />,         color: 'text-yellow-500' },
    { label: 'Anomalias',      value: fmt(t.anomalias),    icon: <AlertTriangle size={16} />, color: 'text-orange-500' },
    { label: 'Confirmados',    value: fmt(t.confirmados),  icon: <CheckCircle2 size={16} />,  color: 'text-red-500' },
    { label: 'Descartados',    value: fmt(t.descartados),  icon: <XCircle size={16} />,       color: 'text-gray-400' },
    {
      label: 'Ressarcimento',
      value: fmtBRL(t.ressarcimento),
      icon: <DollarSign size={16} />,
      color: 'text-green-600',
      wide: true,
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
      {cards.map((c) => (
        <div
          key={c.label}
          className={`bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 p-3 flex flex-col gap-1 ${c.wide ? 'lg:col-span-1' : ''}`}
        >
          <span className={`flex items-center gap-1 text-xs font-medium ${c.color}`}>
            {c.icon} {c.label}
          </span>
          <span className="text-lg font-bold text-gray-800 dark:text-gray-100 tabular-nums leading-tight">
            {c.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Página principal ───────────────────────────────────────────────────────────
export default function DashboardAuditoria() {
  const navigate = useNavigate();
  const [clientes, setClientes]   = useState([]);
  const [loading,  setLoading]    = useState(true);
  const [erro,     setErro]       = useState(null);
  const [busca,    setBusca]      = useState('');
  const [sort,     setSort]       = useState({ field: 'casos_confirmados', dir: 'desc' });

  const token = localStorage.getItem('token');

  const carregar = async () => {
    setLoading(true);
    setErro(null);
    try {
      const r = await axios.get(`${API}/api/v1/faturas/clientes-ia`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setClientes(r.data?.clientes ?? []);
    } catch (e) {
      setErro(e.response?.data?.error ?? e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { carregar(); }, []);

  const handleSort = (field) => {
    setSort((prev) =>
      prev.field === field
        ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { field, dir: 'desc' },
    );
  };

  const dados = useMemo(() => {
    let lista = clientes.filter((c) =>
      !busca || (c.razao_social ?? '').toLowerCase().includes(busca.toLowerCase()),
    );
    lista = [...lista].sort((a, b) => {
      const va = a[sort.field] ?? 0;
      const vb = b[sort.field] ?? 0;
      if (typeof va === 'string') return sort.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return sort.dir === 'asc' ? va - vb : vb - va;
    });
    return lista;
  }, [clientes, busca, sort]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        <RefreshCw size={20} className="animate-spin mr-2" /> Carregando...
      </div>
    );
  }

  if (erro) {
    return (
      <div className="p-8 text-red-500 flex items-center gap-2">
        <AlertTriangle size={18} /> {erro}
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">
            Auditoria IA — Visão Geral
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {clientes.length} cliente{clientes.length !== 1 ? 's' : ''} · clique na linha para abrir a análise
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar cliente..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-400 w-52"
            />
          </div>
          <button
            onClick={carregar}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition"
          >
            <RefreshCw size={13} /> Atualizar
          </button>
        </div>
      </div>

      {/* Cards totalizadores */}
      <TotaisBar clientes={dados} />

      {/* Tabela */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-750 border-b border-gray-100 dark:border-gray-700 text-gray-500 dark:text-gray-400">
              <tr>
                <SortHeader label="Cliente"            field="razao_social"           sortState={sort} onSort={handleSort} className="min-w-[200px]" />
                <SortHeader label="Faturas"             field="total_faturas"          sortState={sort} onSort={handleSort} />
                <SortHeader label="Analisadas"          field="faturas_analisadas"     sortState={sort} onSort={handleSort} className="min-w-[160px]" />
                <SortHeader label="Não analisadas"      field="nao_analisadas"         sortState={sort} onSort={handleSort} className="min-w-[160px]" />
                <SortHeader label="Anomalias"           field="anomalias_encontradas"  sortState={sort} onSort={handleSort} />
                <SortHeader label="Confirmados"         field="casos_confirmados"      sortState={sort} onSort={handleSort} />
                <SortHeader label="Descartados"         field="casos_descartados"      sortState={sort} onSort={handleSort} />
                <SortHeader label="Ressarcimento est."  field="ressarcimento_estimado" sortState={sort} onSort={handleSort} className="min-w-[160px]" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
              {dados.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-gray-400 text-sm">
                    Nenhum cliente encontrado.
                  </td>
                </tr>
              )}
              {dados.map((cl) => (
                <tr
                  key={`${cl.cod_empresa}-${cl.razao_social}`}
                  onClick={() =>
                    navigate(`/analise-desvio?empresa=${cl.cod_empresa ?? ''}`)
                  }
                  className="cursor-pointer hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors group"
                >
                  {/* Cliente */}
                  <td className="px-3 py-2.5">
                    <span className="font-medium text-gray-800 dark:text-gray-100 group-hover:text-violet-700 dark:group-hover:text-violet-300 transition-colors">
                      {cl.razao_social}
                    </span>
                    {cl.cod_empresa != null && (
                      <span className="ml-2 text-[10px] text-gray-400">#{cl.cod_empresa}</span>
                    )}
                  </td>

                  {/* Total faturas */}
                  <td className="px-3 py-2.5 tabular-nums text-gray-600 dark:text-gray-300 text-right">
                    {fmt(cl.total_faturas)}
                  </td>

                  {/* Analisadas com barra */}
                  <td className="px-3 py-2.5 min-w-[160px]">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs tabular-nums text-blue-600 dark:text-blue-400 font-medium">
                        {fmt(cl.faturas_analisadas)}
                      </span>
                      <ProgressBar value={cl.pct_analisadas} color="#3b82f6" />
                    </div>
                  </td>

                  {/* Não analisadas com barra */}
                  <td className="px-3 py-2.5 min-w-[160px]">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs tabular-nums text-yellow-600 dark:text-yellow-400 font-medium">
                        {fmt(cl.nao_analisadas)}
                      </span>
                      <ProgressBar value={cl.pct_nao_analisadas} color="#f59e0b" />
                    </div>
                  </td>

                  {/* Anomalias */}
                  <td className="px-3 py-2.5 tabular-nums text-right">
                    {cl.anomalias_encontradas > 0 ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400">
                        <AlertTriangle size={10} /> {fmt(cl.anomalias_encontradas)}
                      </span>
                    ) : (
                      <span className="text-gray-300 dark:text-gray-600">—</span>
                    )}
                  </td>

                  {/* Confirmados */}
                  <td className="px-3 py-2.5 tabular-nums text-right">
                    {cl.casos_confirmados > 0 ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400">
                        <CheckCircle2 size={10} /> {fmt(cl.casos_confirmados)}
                      </span>
                    ) : (
                      <span className="text-gray-300 dark:text-gray-600">—</span>
                    )}
                  </td>

                  {/* Descartados */}
                  <td className="px-3 py-2.5 tabular-nums text-right">
                    {cl.casos_descartados > 0 ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                        <XCircle size={10} /> {fmt(cl.casos_descartados)}
                      </span>
                    ) : (
                      <span className="text-gray-300 dark:text-gray-600">—</span>
                    )}
                  </td>

                  {/* Ressarcimento */}
                  <td className="px-3 py-2.5 tabular-nums text-right">
                    {(cl.ressarcimento_estimado ?? 0) > 0 ? (
                      <span className="font-semibold text-green-600 dark:text-green-400">
                        {fmtBRL(cl.ressarcimento_estimado)}
                      </span>
                    ) : (
                      <span className="text-gray-300 dark:text-gray-600">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>

            {/* Rodapé totalizador */}
            {dados.length > 0 && (
              <tfoot className="border-t-2 border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-750 text-xs font-semibold text-gray-600 dark:text-gray-300">
                <tr>
                  <td className="px-3 py-2">
                    Total ({dados.length} clientes)
                  </td>
                  <td className="px-3 py-2 tabular-nums text-right">
                    {fmt(dados.reduce((s, c) => s + (c.total_faturas ?? 0), 0))}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {fmt(dados.reduce((s, c) => s + (c.faturas_analisadas ?? 0), 0))}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {fmt(dados.reduce((s, c) => s + (c.nao_analisadas ?? 0), 0))}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-right">
                    {fmt(dados.reduce((s, c) => s + (c.anomalias_encontradas ?? 0), 0))}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-right">
                    {fmt(dados.reduce((s, c) => s + (c.casos_confirmados ?? 0), 0))}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-right">
                    {fmt(dados.reduce((s, c) => s + (c.casos_descartados ?? 0), 0))}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-right text-green-600 dark:text-green-400">
                    {fmtBRL(dados.reduce((s, c) => s + (c.ressarcimento_estimado ?? 0), 0))}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
