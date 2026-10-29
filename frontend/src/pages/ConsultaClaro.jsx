// ConsultaClaro — página SOMENTE LEITURA das faturas Claro (FATURA_CLARO_DADOS_EXTRAIDOS).
// Cards agregados + filtros + tabela paginada (server-side, ~695k linhas) + link do PDF no Drive.
//   GET /api/v1/claro/resumo   -> cards
//   GET /api/v1/claro/faturas  -> lista paginada (uc, cliente, cnpj, distribuidora, mes, valor, q, com_link)
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, RotateCcw, ExternalLink, ChevronLeft, ChevronRight, Loader2, CalendarCheck } from 'lucide-react';
import api from '../services/apiClient';

const LIMIT = 50;

const brl = (v) =>
  v == null || v === '' ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num0 = (v) =>
  v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const kwh = (v) =>
  v == null || Number(v) === 0 ? '—' : `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kWh`;

const FILTROS_VAZIOS = {
  q: '', uc: '', cliente: '', cnpj: '', distribuidora: '', mes: '', valor_min: '', valor_max: '', com_link: false,
};

function Card({ label, value, sub, accent }) {
  return (
    <div className="rounded-xl border-2 panel-border p-4 flex flex-col gap-1" style={{ background: 'var(--panel, var(--bg))' }}>
      <div className="text-[11px] uppercase tracking-wide" style={{ color: 'color-mix(in srgb, var(--fg) 55%, transparent)' }}>{label}</div>
      <div className="text-2xl font-bold tabular-nums" style={{ color: accent || 'var(--fg)' }}>{value}</div>
      {sub && <div className="text-xs" style={{ color: 'color-mix(in srgb, var(--fg) 50%, transparent)' }}>{sub}</div>}
    </div>
  );
}

function Campo({ label, value, onChange, placeholder, onEnter, style }) {
  return (
    <div className="flex flex-col gap-1" style={style}>
      <label className="text-[11px] uppercase tracking-wide" style={{ color: 'color-mix(in srgb, var(--fg) 55%, transparent)' }}>{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) onEnter(); }}
        placeholder={placeholder}
        className="px-2.5 py-1.5 rounded-lg border-2 panel-border text-sm outline-none"
        style={{ background: 'var(--bg)', color: 'var(--fg)' }}
      />
    </div>
  );
}

export default function ConsultaClaro() {
  const [resumo, setResumo] = useState(null);
  const [filtros, setFiltros] = useState(FILTROS_VAZIOS);
  const [aplicados, setAplicados] = useState(FILTROS_VAZIOS); // filtros efetivamente enviados
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');
  const [buscou, setBuscou] = useState(false); // nada é exibido até a 1ª busca
  const [cobertura, setCobertura] = useState(null); // meses que a UC tem + faltantes
  const [covLoading, setCovLoading] = useState(false);

  const setF = (k) => (v) => setFiltros((p) => ({ ...p, [k]: v }));

  // resumo (uma vez)
  useEffect(() => {
    api.get('/api/v1/claro/resumo')
      .then(({ data }) => setResumo(data))
      .catch(() => setResumo(null));
  }, []);

  const params = useMemo(() => {
    const p = { limit: LIMIT, offset };
    Object.entries(aplicados).forEach(([k, v]) => {
      if (k === 'com_link') { if (v) p.com_link = 1; }
      else if (String(v).trim() !== '') p[k] = String(v).trim();
    });
    return p;
  }, [aplicados, offset]);

  const carregar = useCallback(() => {
    setLoading(true); setErro('');
    api.get('/api/v1/claro/faturas', { params })
      .then(({ data }) => { setRows(data.faturas || []); setTotal(data.total || 0); })
      .catch((e) => { setErro(e?.response?.data?.error || e?.message || 'Erro ao consultar'); setRows([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [params]);

  // só busca no banco depois que o usuário aciona a 1ª busca (página começa vazia)
  useEffect(() => { if (buscou) carregar(); }, [carregar, buscou]);

  const buscar = () => { setOffset(0); setAplicados(filtros); setBuscou(true); };
  const limpar = () => { setFiltros(FILTROS_VAZIOS); setAplicados(FILTROS_VAZIOS); setOffset(0); setBuscou(false); setRows([]); setTotal(0); setCobertura(null); };

  // Cobertura da UC: meses que tem (com link) + meses que faltam (buracos na série).
  const verCobertura = () => {
    const uc = (filtros.uc || '').trim();
    if (!uc) { setCobertura({ erro: 'Digite a UC / instalação no campo acima primeiro.' }); return; }
    setCovLoading(true); setCobertura({});
    api.get('/api/v1/claro/uc-cobertura', { params: { uc } })
      .then(({ data }) => setCobertura(data))
      .catch((e) => setCobertura({ erro: e?.response?.data?.error || e?.message || 'Erro ao consultar cobertura' }))
      .finally(() => setCovLoading(false));
  };

  const pagAtual = Math.floor(offset / LIMIT) + 1;
  const totalPags = Math.max(1, Math.ceil(total / LIMIT));
  const de = total === 0 ? 0 : offset + 1;
  const ate = Math.min(offset + LIMIT, total);

  return (
    <div className="p-4 md:p-6 w-full flex flex-col gap-5" style={{ color: 'var(--fg)' }}>
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <span style={{ color: '#e11d48' }}>●</span> Faturas Claro — Consulta
        </h1>
        <p className="text-sm" style={{ color: 'color-mix(in srgb, var(--fg) 55%, transparent)' }}>
          Faturas de energia do cliente Claro extraídas. Consulta somente leitura — abra o PDF pelo link do Drive.
        </p>
      </div>

      {/* Cards */}
      {resumo && (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          <Card label="Faturas" value={num0(resumo.total_faturas)} />
          <Card label="Com link (PDF)" value={num0(resumo.com_link)} sub={`${num0(resumo.sem_link)} sem link`} accent="#1f9d6b" />
          <Card label="UCs (instalações)" value={num0(resumo.ucs)} />
          <Card label="Valor total" value={brl(resumo.soma_valor)} />
          <Card label="Período" value={`${resumo.mes_min || '—'} → ${resumo.mes_max || '—'}`} />
        </div>
      )}

      {/* Filtros */}
      <div className="rounded-xl border-2 panel-border p-4 flex flex-col gap-3" style={{ background: 'var(--panel, var(--bg))' }}>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <Campo label="Busca (arquivo/UC/cliente)" value={filtros.q} onChange={setF('q')} onEnter={buscar} placeholder="texto livre…" />
          <Campo label="UC / instalação (começa com)" value={filtros.uc} onChange={setF('uc')} onEnter={buscar} placeholder="nº" />
          <Campo label="Cliente (contém)" value={filtros.cliente} onChange={setF('cliente')} onEnter={buscar} placeholder="nome" />
          <Campo label="CNPJ (começa com)" value={filtros.cnpj} onChange={setF('cnpj')} onEnter={buscar} />
          <Campo label="Distribuidora (começa com)" value={filtros.distribuidora} onChange={setF('distribuidora')} onEnter={buscar} />
          <Campo label="Mês (AAAA-MM)" value={filtros.mes} onChange={setF('mes')} onEnter={buscar} placeholder="2025-01" />
          <Campo label="Valor mín." value={filtros.valor_min} onChange={setF('valor_min')} onEnter={buscar} placeholder="0" />
          <Campo label="Valor máx." value={filtros.valor_max} onChange={setF('valor_max')} onEnter={buscar} />
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={filtros.com_link} onChange={(e) => setF('com_link')(e.target.checked)} />
            Só com PDF no Drive
          </label>
          <div className="flex-1" />
          <button onClick={buscar} className="px-3.5 py-1.5 rounded-lg text-sm font-semibold flex items-center gap-1.5"
            style={{ background: 'var(--accent)', color: '#fff' }}>
            <Search size={14} /> Buscar
          </button>
          <button onClick={verCobertura} className="px-3 py-1.5 rounded-lg text-sm border-2 panel-border flex items-center gap-1.5"
            title="Meses que a UC tem (com PDF) e os que faltam">
            <CalendarCheck size={13} /> Cobertura da UC
          </button>
          <button onClick={limpar} className="px-3 py-1.5 rounded-lg text-sm border-2 panel-border flex items-center gap-1.5">
            <RotateCcw size={13} /> Limpar
          </button>
        </div>
      </div>

      {/* Cobertura por UC — meses presentes (com link) + faltantes */}
      {cobertura && (
        <div className="rounded-xl border-2 panel-border p-4 flex flex-col gap-3" style={{ background: 'var(--panel, var(--bg))' }}>
          <div className="flex items-center justify-between">
            <div className="font-semibold text-sm flex items-center gap-2">
              <CalendarCheck size={15} style={{ color: 'var(--accent)' }} />
              Cobertura da UC {cobertura.numero_real || cobertura.uc || ''}
              {cobertura.distribuidora ? <span className="opacity-60 font-normal">· {cobertura.distribuidora}</span> : null}
            </div>
            <button onClick={() => setCobertura(null)} className="text-xs opacity-60 hover:opacity-100">fechar ✕</button>
          </div>

          {covLoading ? (
            <Loader2 className="animate-spin" size={18} />
          ) : cobertura.erro ? (
            <div className="text-sm" style={{ color: 'var(--danger)' }}>{cobertura.erro}</div>
          ) : (
            <>
              <div className="text-xs" style={{ color: 'color-mix(in srgb, var(--fg) 60%, transparent)' }}>
                {num0(cobertura.total_faturas)} faturas · período {cobertura.periodo?.primeiro || '—'} → {cobertura.periodo?.ultimo || '—'}
                {cobertura.cliente ? ` · ${cobertura.cliente}` : ''}
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wide mb-1.5" style={{ color: '#1f9d6b' }}>
                  Tem ({(cobertura.presentes || []).length}) — clique para abrir o PDF
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(cobertura.presentes || []).map((p) => (p.link ? (
                    <a key={p.mes} href={p.link} target="_blank" rel="noreferrer"
                      className="px-2 py-0.5 rounded text-xs font-semibold inline-flex items-center gap-1"
                      style={{ background: 'color-mix(in srgb, #1f9d6b 15%, transparent)', color: '#1f9d6b' }}>
                      {p.label} <ExternalLink size={11} />
                    </a>
                  ) : (
                    <span key={p.mes} className="px-2 py-0.5 rounded text-xs" title="sem PDF no Drive"
                      style={{ background: 'color-mix(in srgb, var(--fg) 8%, transparent)', color: 'color-mix(in srgb, var(--fg) 60%, transparent)' }}>
                      {p.label}
                    </span>
                  )))}
                </div>
              </div>

              {(cobertura.faltantes || []).length > 0 ? (
                <div>
                  <div className="text-[11px] uppercase tracking-wide mb-1.5" style={{ color: '#e11d48' }}>
                    Faltam ({cobertura.faltantes.length})
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {cobertura.faltantes.map((m) => (
                      <span key={m} className="px-2 py-0.5 rounded text-xs font-semibold"
                        style={{ background: 'color-mix(in srgb, #e11d48 14%, transparent)', color: '#e11d48' }}>{m}</span>
                    ))}
                  </div>
                </div>
              ) : (cobertura.presentes || []).length > 0 ? (
                <div className="text-xs font-semibold" style={{ color: '#1f9d6b' }}>
                  ✓ Série completa — sem buracos entre {cobertura.periodo?.primeiro} e {cobertura.periodo?.ultimo}.
                </div>
              ) : (
                <div className="text-xs opacity-60">Nenhuma fatura encontrada para essa UC.</div>
              )}
            </>
          )}
        </div>
      )}

      {/* Resultado */}
      <div className="rounded-xl border-2 panel-border overflow-hidden" style={{ background: 'var(--panel, var(--bg))' }}>
        <div className="flex items-center justify-between px-4 py-2 text-sm border-b-2 panel-border">
          <div style={{ color: 'color-mix(in srgb, var(--fg) 65%, transparent)' }}>
            {loading ? 'Carregando…' : buscou ? `${num0(de)}–${num0(ate)} de ${num0(total)}` : 'Aguardando busca'}
          </div>
          <div className="flex items-center gap-2">
            <button disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - LIMIT))}
              className="p-1 rounded border panel-border disabled:opacity-40"><ChevronLeft size={16} /></button>
            <span className="tabular-nums text-xs">pág {num0(pagAtual)}/{num0(totalPags)}</span>
            <button disabled={ate >= total || loading} onClick={() => setOffset(offset + LIMIT)}
              className="p-1 rounded border panel-border disabled:opacity-40"><ChevronRight size={16} /></button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'color-mix(in srgb, var(--fg) 6%, transparent)' }}>
                {['UC / Instalação', 'Nº relacionado (de/para)', 'Distribuidora', 'Mês', 'Cliente', 'CNPJ', 'Consumo', 'Valor', 'Fichas', 'PDF'].map((h) => (
                  <th key={h} className="text-left px-3 py-2 font-semibold whitespace-nowrap text-[12px] uppercase tracking-wide"
                    style={{ color: 'color-mix(in srgb, var(--fg) 55%, transparent)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={10} className="px-3 py-10 text-center"><Loader2 className="inline animate-spin" size={20} /></td></tr>
              )}
              {!loading && erro && (
                <tr><td colSpan={10} className="px-3 py-8 text-center" style={{ color: 'var(--danger)' }}>{erro}</td></tr>
              )}
              {!loading && !erro && !buscou && (
                <tr><td colSpan={10} className="px-3 py-10 text-center opacity-60">Use os filtros acima e clique <b>Buscar</b> para consultar as faturas.</td></tr>
              )}
              {!loading && !erro && buscou && rows.length === 0 && (
                <tr><td colSpan={10} className="px-3 py-8 text-center opacity-60">Nenhuma fatura com esses filtros.</td></tr>
              )}
              {!loading && rows.map((r) => (
                <tr key={r.id} className="border-t panel-border hover:bg-[color-mix(in_srgb,var(--fg)_4%,transparent)]">
                  <td className="px-3 py-2 font-mono whitespace-nowrap">{r.numero_instalacao || r.codigo_uc || '—'}</td>
                  <td className="px-3 py-2 font-mono whitespace-nowrap text-xs" title="Número relacionado — renumeração 2026 (novo↔antigo)">
                    {r.numero_instalacao_relacionado
                      ? <span style={{ color: 'var(--accent)' }}>{r.numero_instalacao_relacionado}</span>
                      : <span className="opacity-40">—</span>}
                  </td>
                  <td className="px-3 py-2">{r.distribuidora || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.mes_referencia || '—'}</td>
                  <td className="px-3 py-2 max-w-[220px] truncate" title={r.nome_cliente}>{r.nome_cliente || '—'}</td>
                  <td className="px-3 py-2 font-mono whitespace-nowrap">{r.cnpj_cliente || '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{kwh(r.consumo_kwh)}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{brl(r.valor_total)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.fichas ? <span className="text-xs font-semibold" style={{ color: 'var(--warning)' }}>{r.fichas}</span> : '—'}
                    {r.gd ? <span className="ml-1" title="Geração distribuída">🟢</span> : null}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.link
                      ? <a href={r.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold"
                          style={{ color: 'var(--accent)' }}><ExternalLink size={13} /> abrir</a>
                      : <span className="opacity-40 text-xs">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
