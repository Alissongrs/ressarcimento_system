// src/pages/Historico.jsx
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCcw, GitCompare, User, Clock } from 'lucide-react';
// Ajuste o nome da função abaixo conforme seu service (ex.: getMovimentacoesPeriodo)
import { getMovimentacoesPeriodo } from '../services/requisicaoService';

function fmtBR(dt) {
  try {
    return new Date(dt).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(dt || '');
  }
}

export default function Historico() {
  // Datas: carrega últimos 30 dias por padrão
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const toYmd = (d) => [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join('-');
  const defaultFim = toYmd(today);
  const dIni = new Date(today);
  dIni.setDate(dIni.getDate() - 30);
  const defaultIni = toYmd(dIni);

  const [ini, setIni] = useState(defaultIni);
  const [fim, setFim] = useState(defaultFim);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 15;
  const navigate = useNavigate();

  // Filtros
  const [fEtapa, setFEtapa] = useState('');
  const [fSub, setFSub] = useState('');
  const [fMes, setFMes] = useState('');
  const [fAno, setFAno] = useState('');

  // Helpers período
  const setPeriodo = (dStart, dEnd) => {
    try {
      setIni(toYmd(dStart));
      setFim(toYmd(dEnd));
      setPage(1);
    } catch {}
  };
  const aplicarHoje = () => {
    const d = new Date();
    setPeriodo(d, d);
  };
  const aplicarUltimosNDias = (n) => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - (n - 1));
    setPeriodo(start, end);
  };

  useEffect(() => {
    if (fMes && fAno) {
      const m = parseInt(fMes, 10) - 1;
      const y = parseInt(fAno, 10);
      const start = new Date(y, m, 1);
      const end = new Date(y, m + 1, 0);
      setPeriodo(start, end);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fMes, fAno]);

  const load = async () => {
    try {
      setLoading(true);
      setErr('');
      const data = await getMovimentacoesPeriodo(ini, fim);
      const rows = Array.isArray(data) ? data : [];
      rows.sort(
        (a, b) =>
          new Date(b?.data_movimentacao || b?.data || 0) -
          new Date(a?.data_movimentacao || a?.data || 0)
      );
      setItems(rows);
      setPage(1);
    } catch (e) {
      const msg =
        e?.response?.data?.detail ||
        e?.response?.data?.error ||
        e?.message ||
        'Falha ao carregar movimentações.';
      setErr(String(msg));
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (ini && fim) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ini, fim]);

  // Opções dinâmicas
  const etapasOptions = useMemo(() => {
    const s = new Set();
    (items || []).forEach((it) => {
      const e = String(it.etapa_nova || it.etapa_anterior || '').trim();
      if (e) s.add(e);
    });
    return Array.from(s).sort();
  }, [items]);

  const subOptions = useMemo(() => {
    const s = new Set();
    (items || []).forEach((it) => {
      const sub = String(it.sub_etapa || '').trim();
      if (sub) s.add(sub);
    });
    return Array.from(s).sort();
  }, [items]);

  const filtered = useMemo(
    () =>
      (items || []).filter((it) => {
        const etapa = String(it.etapa_nova || it.etapa_anterior || '').toLowerCase();
        const sub = String(it.sub_etapa || '').toLowerCase();
        const okEtapa = !fEtapa || etapa.includes(String(fEtapa).toLowerCase());
        const okSub = !fSub || sub.includes(String(fSub).toLowerCase());
        return okEtapa && okSub;
      }),
    [items, fEtapa, fSub]
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageItems = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page]
  );

  // Export CSV dos itens filtrados
  const handleExportCsv = () => {
    try {
      const rows = Array.isArray(filtered) ? filtered : [];
      const esc = (v) => {
        const s = v == null ? '' : String(v);
        const t = s.replace(/"/g, '""');
        return '"' + t + '"';
      };
      const header = [
        'data_movimentacao',
        'usuario_nome',
        'status_anterior',
        'status_novo',
        'etapa_anterior',
        'etapa_nova',
        'sub_etapa',
        'comentario',
        'id_processo',
      ];
      let csv = '\ufeff' + header.join(';') + '\n';
      rows.forEach((it) => {
        const line = [
          it?.data_movimentacao || it?.data || it?.created_at || '',
          it?.usuario_nome || '',
          it?.status_anterior || '',
          it?.status_novo || '',
          it?.etapa_anterior || '',
          it?.etapa_nova || '',
          it?.sub_etapa || '',
          it?.comentario || '',
          it?.id_processo || '',
        ]
          .map(esc)
          .join(';');
        csv += line + '\n';
      });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Historico_${ini}_${fim}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {}
  };

  // Helpers de texto (trata objetos do backend com {String, Valid, etc.})
  const str = (v) => {
    if (v == null) return '';
    if (typeof v === 'object') {
      if ('String' in v) return v.String ?? '';
      if ('Value' in v) return v.Value ?? '';
      if ('Time' in v) return v.Time ?? '';
    }
    return String(v ?? '');
  };

  return (
    <div className="p-4 md:p-8 bg-background text-foreground min-h-screen">
      {/* Header */}
      <div
        className="rounded-xl shadow-elevated p-4 mb-6 flex items-center justify-between border-2"
        style={{ background: 'var(--header-bg)', borderColor: 'var(--header-border)', color: 'var(--header-fg)' }}
      >
        <div>
          <h1 className="text-xl font-extrabold tracking-tight">Histórico</h1>
          <p className="opacity-90 text-sm">Movimentações com filtros de período</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            disabled={!ini || !fim}
            onClick={load}
            className="px-3 py-2 rounded border panel-border panel-bg-60 hover:opacity-90 disabled:opacity-50 text-[var(--header-fg)] transition-smooth flex items-center gap-2"
          >
            <RefreshCcw size={16} /> Atualizar
          </button>
          <button
            onClick={handleExportCsv}
            className="px-3 py-2 rounded border panel-border panel-bg-60 hover:opacity-90 text-[var(--header-fg)] transition-smooth"
          >
            Exportar CSV
          </button>
        </div>
      </div>

      {/* Filtros principais */}
      <div className="glass-card gradient-card shadow-medium p-4 rounded-lg border mb-6 grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
        <div>
          <label className="block text-xs opacity-70">Data inicial</label>
          <input
            type="date"
            value={ini}
            onChange={(e) => setIni(e.target.value)}
            className="w-full p-2 rounded border border-[var(--border)] bg-transparent"
          />
        </div>
        <div>
          <label className="block text-xs opacity-70">Data final</label>
          <input
            type="date"
            value={fim}
            onChange={(e) => setFim(e.target.value)}
            className="w-full p-2 rounded border border-[var(--border)] bg-transparent"
          />
        </div>
        <div>
          <label className="block text-xs opacity-70">Etapa</label>
          <select
            value={fEtapa}
            onChange={(e) => {
              setFEtapa(e.target.value);
              setPage(1);
            }}
            className="w-full p-2 rounded border border-[var(--border)] bg-transparent"
          >
            <option value="">Todas</option>
            {etapasOptions.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs opacity-70">Sub-etapa</label>
          <select
            value={fSub}
            onChange={(e) => {
              setFSub(e.target.value);
              setPage(1);
            }}
            className="w-full p-2 rounded border border-[var(--border)] bg-transparent"
          >
            <option value="">Todas</option>
            {subOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <button
            disabled={!ini || !fim}
            onClick={load}
            className="px-3 py-2 rounded bg-[var(--accent)] text-[var(--fg)] disabled:opacity-50 w-full"
          >
            Aplicar
          </button>
        </div>
      </div>

      {/* Atalhos e mês/ano */}
      <div className="flex flex-wrap gap-2 items-center mb-4">
        <span className="text-xs opacity-70">Atalhos:</span>
        <button onClick={aplicarHoje} className="px-2 py-1 rounded border panel-border panel-bg-60 hover:opacity-90 text-xs">
          Hoje
        </button>
        <button
          onClick={() => aplicarUltimosNDias(7)}
          className="px-2 py-1 rounded border panel-border panel-bg-60 hover:opacity-90 text-xs"
        >
          Últimos 7 dias
        </button>
        <button
          onClick={() => aplicarUltimosNDias(30)}
          className="px-2 py-1 rounded border panel-border panel-bg-60 hover:opacity-90 text-xs"
        >
          Últimos 30 dias
        </button>
        <div className="ml-auto flex gap-2 items-end">
          <div>
            <label className="block text-xs opacity-70">Mês</label>
            <select
              value={fMes}
              onChange={(e) => {
                setFMes(e.target.value);
              }}
              className="p-2 rounded border panel-border panel-bg-60"
            >
              <option value="">Selecione</option>
              <option value="01">Janeiro</option>
              <option value="02">Fevereiro</option>
              <option value="03">Março</option>
              <option value="04">Abril</option>
              <option value="05">Maio</option>
              <option value="06">Junho</option>
              <option value="07">Julho</option>
              <option value="08">Agosto</option>
              <option value="09">Setembro</option>
              <option value="10">Outubro</option>
              <option value="11">Novembro</option>
              <option value="12">Dezembro</option>
            </select>
          </div>
          <div>
            <label className="block text-xs opacity-70">Ano</label>
            <select
              value={fAno}
              onChange={(e) => {
                setFAno(e.target.value);
              }}
              className="p-2 rounded border panel-border panel-bg-60"
            >
              <option value="">Selecione</option>
              {(() => {
                const y = today.getFullYear();
                const ys = [];
                for (let i = 0; i < 7; i++) {
                  ys.push(y - i);
                }
                return ys;
              })().map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Estado */}
      {loading && <div className="opacity-70">Carregando...</div>}
      {err && <div className="text-red-500 mb-3 break-words">{err}</div>}

      {/* Lista */}
      {!loading && !err && (
        <div className="space-y-3">
          {pageItems.length === 0 ? (
            <div className="opacity-70">Nenhuma movimentação no período.</div>
          ) : (
            pageItems.map((it, idx) => {
              const dataMov = it?.data_movimentacao || it?.data || it?.created_at || '';
              const usuario = it?.usuario_nome || '';
              const idProc = it?.id_processo || it?.processo_id || null;

              const statusAnt = str(it.status_anterior);
              const statusNov = str(it.status_novo);
              const etapaAnt = str(it.etapa_anterior);
              const etapaNov = str(it.etapa_nova);
              const sub = str(it.sub_etapa);

              const dash = '--';
              const statusTxt =
                !statusAnt && !statusNov
                  ? ''
                  : statusAnt === statusNov
                  ? statusNov
                  : `${statusAnt || dash} => ${statusNov || dash}`;
              const etapaBase =
                !etapaAnt && !etapaNov
                  ? ''
                  : etapaAnt === etapaNov
                  ? etapaNov
                  : `${etapaAnt || dash} => ${etapaNov || dash}`;
              const etapaTxt = etapaBase + (sub ? ` (${sub})` : '');

              return (
                <div
                  key={`${dataMov}-${idx}`}
                  className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel)] text-[var(--fg)] p-3 shadow-soft"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm">
                      <Clock size={16} className="opacity-70" />
                      <span className="font-medium">{fmtBR(dataMov)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <User size={16} className="opacity-70" />
                      <span className="opacity-90">{usuario || '—'}</span>
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                    <span className="inline-flex items-center gap-1">
                      <GitCompare size={14} />
                      {statusTxt && <>{statusTxt} | </>}
                      {etapaTxt || dash}
                    </span>
                  </div>

                  {it.comentario && (
                    <div className="mt-2 text-sm opacity-90">
                      <span className="opacity-70">Comentário:</span> {it.comentario}
                    </div>
                  )}

                  {idProc ? (
                    <div className="mt-3">
                      <button
                        onClick={() => navigate(`/processos/${idProc}`)}
                        className="px-3 py-1.5 rounded border border-[var(--border)] text-sm hover:bg-[var(--border)]/20"
                      >
                        Ver processo #{idProc}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Paginação */}
      {!loading && !err && totalPages > 1 && (
        <div className="mt-4 flex items-center gap-2 justify-center text-sm">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="px-2 py-1 rounded border border-[var(--border)] disabled:opacity-50"
          >
            Anterior
          </button>
          <span className="opacity-70">
            Página {page} de {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="px-2 py-1 rounded border border-[var(--border)] disabled:opacity-50"
          >
            Próxima
          </button>
        </div>
      )}
    </div>
  );
}
