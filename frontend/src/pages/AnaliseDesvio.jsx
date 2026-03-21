import React, { useEffect, useMemo, useState } from 'react';
import Toast from '../components/Toast.jsx';
import {
  listDesvioKwhFponta,
  listDesvioKwhOptions,
  updateDesvioKwhFlags,
  createProcessoFromDesvioKwh,
} from '../services/desvioKwhFpontaService.js';

export default function AnaliseDesvio() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState({ open: false, type: 'info', text: '' });
  const [totalCount, setTotalCount] = useState(0);
  const [filteredCount, setFilteredCount] = useState(0);
  const [options, setOptions] = useState({
    status_desvio: [],
    status_extra: [],
    mes_ref: [],
    tp_tensao: [],
    concessionaria: [],
    cliente: [],
  });
  const [statusDesvioFilter, setStatusDesvioFilter] = useState([]);
  const [statusExtraFilter, setStatusExtraFilter] = useState([]);
  const [mesRefFilter, setMesRefFilter] = useState([]);
  const [tpTensaoFilter, setTpTensaoFilter] = useState([]);
  const [concessionariaFilter, setConcessionariaFilter] = useState([]);
  const [clienteFilter, setClienteFilter] = useState([]);
  const [search, setSearch] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  const load = async (payload = {}) => {
    setLoading(true);
    try {
      const data = await listDesvioKwhFponta({
        limit: 500,
        offset: 0,
        status_desvio: payload.status_desvio ?? statusDesvioFilter,
        status_extra: payload.status_extra ?? statusExtraFilter,
        mes_ref: payload.mes_ref ?? mesRefFilter,
        tp_tensao: payload.tp_tensao ?? tpTensaoFilter,
        concessionaria: payload.concessionaria ?? concessionariaFilter,
        cliente: payload.cliente ?? clienteFilter,
        q: payload.q ?? search,
      });
      setRows(Array.isArray(data?.rows) ? data.rows : []);
      setTotalCount(Number(data?.total || 0));
      setFilteredCount(Number(data?.filtered || 0));
    } catch (err) {
      setToast({ open: true, type: 'error', text: 'Falha ao carregar dados.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const fetchOptions = async () => {
      try {
        const data = await listDesvioKwhOptions();
        setOptions({
          status_desvio: Array.isArray(data?.status_desvio) ? data.status_desvio : [],
          status_extra: Array.isArray(data?.status_extra) ? data.status_extra : [],
          mes_ref: Array.isArray(data?.mes_ref) ? data.mes_ref : [],
          tp_tensao: Array.isArray(data?.tp_tensao) ? data.tp_tensao : [],
          concessionaria: Array.isArray(data?.concessionaria) ? data.concessionaria : [],
          cliente: Array.isArray(data?.cliente) ? data.cliente : [],
        });
      } catch {
        setOptions({
          status_desvio: [],
          status_extra: [],
          mes_ref: [],
          tp_tensao: [],
          concessionaria: [],
          cliente: [],
        });
      }
    };
    fetchOptions();
  }, []);

  const onFlag = async (row, payload) => {
    try {
      await updateDesvioKwhFlags(row.id, payload);
      setRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, ...payload } : r)),
      );
    } catch {
      setToast({ open: true, type: 'error', text: 'Falha ao salvar flag.' });
    }
  };

  const onCreateProcesso = async (row) => {
    try {
      const { data } = await createProcessoFromDesvioKwh(row.id);
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id ? { ...r, criar_processo: 1, processo_id: data?.id } : r,
        ),
      );
      setToast({
        open: true,
        type: 'success',
        text: `Processo criado${data?.id ? ' - #' + data.id : ''}.`,
      });
    } catch {
      setToast({ open: true, type: 'error', text: 'Falha ao criar processo.' });
    }
  };

  const tableRows = useMemo(() => rows || [], [rows]);

  const flagClass = (active) =>
    active
      ? 'btn-themed text-[11px] px-2 py-1'
      : 'btn-outline text-[11px] px-2 py-1';

  const toggleListItem = (list, value) => {
    if (list.includes(value)) {
      return list.filter((v) => v !== value);
    }
    return [...list, value];
  };

  return (
    <div className="p-4 border rounded panel-bg-60 panel-border space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Análise de Desvio (KWH FPonta)</h1>
          <div className="text-xs opacity-70">Tabela de análise com ações por linha.</div>
          <div className="text-[11px] opacity-70 mt-1">
            Mostrando {filteredCount} de {totalCount} registros.
          </div>
        </div>
        <button className="btn-outline" onClick={() => load()} disabled={loading}>
          {loading ? 'Carregando...' : 'Atualizar'}
        </button>
      </div>

      <div className="border panel-border rounded-lg p-3 space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="flex-1">
            <label className="text-[11px] uppercase tracking-wide">Busca</label>
            <input
              className="input-themed w-full mt-1"
              placeholder="Buscar por UC, Cliente ou Concessionária"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn-themed"
              onClick={() => load()}
              disabled={loading}
            >
              Aplicar filtros
            </button>
            <button
              className="btn-outline"
              onClick={() => {
                setStatusDesvioFilter([]);
                setStatusExtraFilter([]);
                setMesRefFilter([]);
                setTpTensaoFilter([]);
                setConcessionariaFilter([]);
                setClienteFilter([]);
                setSearch('');
                load({
                  status_desvio: [],
                  status_extra: [],
                  mes_ref: [],
                  tp_tensao: [],
                  concessionaria: [],
                  cliente: [],
                  q: '',
                });
              }}
              disabled={loading}
            >
              Limpar
            </button>
            <button
              className="btn-outline"
              type="button"
              onClick={() => setFiltersOpen((v) => !v)}
            >
              {filtersOpen ? 'Ocultar filtros' : 'Mostrar filtros'}
            </button>
          </div>
        </div>

        {filtersOpen && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-wide">Status desvio</div>
              <div className="mt-2 max-h-40 overflow-auto space-y-1">
                {options.status_desvio.map((opt) => (
                  <label key={`sd-${opt}`} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={statusDesvioFilter.includes(opt)}
                      onChange={() => setStatusDesvioFilter((prev) => toggleListItem(prev, opt))}
                    />
                    <span>{opt}</span>
                  </label>
                ))}
                {options.status_desvio.length === 0 && (
                  <div className="text-xs opacity-60">Sem opções</div>
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide">Status extra</div>
              <div className="mt-2 max-h-40 overflow-auto space-y-1">
                {options.status_extra.map((opt) => (
                  <label key={`se-${opt}`} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={statusExtraFilter.includes(opt)}
                      onChange={() => setStatusExtraFilter((prev) => toggleListItem(prev, opt))}
                    />
                    <span>{opt}</span>
                  </label>
                ))}
                {options.status_extra.length === 0 && (
                  <div className="text-xs opacity-60">Sem opções</div>
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide">Mês Ref</div>
              <div className="mt-2 max-h-40 overflow-auto space-y-1">
                {options.mes_ref.map((opt) => (
                  <label key={`mr-${opt}`} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={mesRefFilter.includes(opt)}
                      onChange={() => setMesRefFilter((prev) => toggleListItem(prev, opt))}
                    />
                    <span>{opt}</span>
                  </label>
                ))}
                {options.mes_ref.length === 0 && (
                  <div className="text-xs opacity-60">Sem opções</div>
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide">Tp. Tensão</div>
              <div className="mt-2 max-h-40 overflow-auto space-y-1">
                {options.tp_tensao.map((opt) => (
                  <label key={`tp-${opt}`} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={tpTensaoFilter.includes(opt)}
                      onChange={() => setTpTensaoFilter((prev) => toggleListItem(prev, opt))}
                    />
                    <span>{opt}</span>
                  </label>
                ))}
                {options.tp_tensao.length === 0 && (
                  <div className="text-xs opacity-60">Sem opções</div>
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide">Concessionária</div>
              <div className="mt-2 max-h-40 overflow-auto space-y-1">
                {options.concessionaria.map((opt) => (
                  <label key={`conc-${opt}`} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={concessionariaFilter.includes(opt)}
                      onChange={() =>
                        setConcessionariaFilter((prev) => toggleListItem(prev, opt))
                      }
                    />
                    <span>{opt}</span>
                  </label>
                ))}
                {options.concessionaria.length === 0 && (
                  <div className="text-xs opacity-60">Sem opções</div>
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide">Clientes</div>
              <div className="mt-2 max-h-40 overflow-auto space-y-1">
                {options.cliente.map((opt) => (
                  <label key={`cli-${opt}`} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={clienteFilter.includes(opt)}
                      onChange={() =>
                        setClienteFilter((prev) => toggleListItem(prev, opt))
                      }
                    />
                    <span>{opt}</span>
                  </label>
                ))}
                {options.cliente.length === 0 && (
                  <div className="text-xs opacity-60">Sem opções</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="overflow-auto border panel-border rounded-lg">
        <table className="w-full text-xs">
          <thead className="bg-[var(--card)]">
            <tr className="text-left">
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">UC</th>
              <th className="px-3 py-2">Concessionaria</th>
              <th className="px-3 py-2">Mes_Ref</th>
              <th className="px-3 py-2">Tp_Tensao</th>
              <th className="px-3 py-2">Link</th>
              <th className="px-3 py-2">RAZAO_SOCIAL</th>
              <th className="px-3 py-2">KWH_FPonta</th>
              <th className="px-3 py-2">media_base</th>
              <th className="px-3 py-2">score</th>
              <th className="px-3 py-2">status_desvio</th>
              <th className="px-3 py-2">status_extra</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={12} className="px-3 py-6 text-center text-sm opacity-70">
                  Carregando...
                </td>
              </tr>
            )}
            {!loading && tableRows.length === 0 && (
              <tr>
                <td colSpan={12} className="px-3 py-6 text-center text-sm opacity-70">
                  Nenhum registro encontrado.
                </td>
              </tr>
            )}
            {tableRows.map((row, idx) => (
              <tr
                key={row.id}
                className={`border-t panel-border ${
                  row.uc_match === 1
                    ? 'bg-blue-500/15'
                    : idx % 2 === 0
                    ? 'bg-white/5'
                    : 'bg-transparent'
                }`}
              >
                <td className="px-3 py-2">{row.id ?? '-'}</td>
                <td className="px-3 py-2">{row.uc || '-'}</td>
                <td className="px-3 py-2">{row.concessionaria || '-'}</td>
                <td className="px-3 py-2">{row.mes_ref || '-'}</td>
                <td className="px-3 py-2">{row.tp_tensao || '-'}</td>
                <td className="px-3 py-2">
                  {row.link ? (
                    <a href={row.link} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                      Abrir
                    </a>
                  ) : (
                    '-'
                  )}
                </td>
                <td className="px-3 py-2">{row.razao_social || row.razao_social_fatura || '-'}</td>
                <td className="px-3 py-2">{row.kwh_fponta || '-'}</td>
                <td className="px-3 py-2">{row.media_base || '-'}</td>
                <td className="px-3 py-2">{row.score || '-'}</td>
                <td className="px-3 py-2">{row.status_desvio || '-'}</td>
                <td className="px-3 py-2">{row.status_extra || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Toast
        open={toast.open}
        type={toast.type}
        message={toast.text}
        onClose={() => setToast((t) => ({ ...t, open: false }))}
      />
    </div>
  );
}
