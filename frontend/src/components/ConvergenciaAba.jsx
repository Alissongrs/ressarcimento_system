// ConvergenciaAba — união de TODOS os apontamentos (FDE ∪ sgeeasy) numa lista só.
// Cada linha abre o ModalFaturaMontada (gráfico + opções), com dados da fonte:
//   fonte 'fde'/'ambos' → FATURA_DADOS_EXTRAIDOS · fonte 'sgeeasy' → Faturas_Registradas_Cache.
import React, { useEffect, useMemo, useState } from 'react';
import apiClient from '../services/apiClient';
import ModalFaturaMontada from './ModalFaturaMontada';

const fmtBRL = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtKwh = (v) => (v == null ? '—' : `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kWh`);
// mês com ano SEMPRE 4 dígitos (trata "2021-12-01" e o bug "12/20210")
const fmtMes = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return '—';
  let m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) return `${m[2].padStart(2, '0')}/${m[1]}`;
  m = s.match(/^(\d{1,2})\/(\d{4})/);
  if (m) return `${m[1].padStart(2, '0')}/${m[2]}`;
  return s;
};

const FONTES = {
  fde:     { label: 'FDE',      cor: 'var(--accent)' },
  // sgeeasy-only (lacuna: apontado no sgeeasy e não na FDE) → marcado como Outlier (vermelho)
  sgeeasy: { label: 'Outlier',  cor: 'var(--danger)' },
  ambos:   { label: 'Ambos',    cor: 'var(--success)' },
};
function FonteBadge({ f }) {
  const cfg = FONTES[f] || { label: f || '—', cor: 'color-mix(in srgb, var(--fg) 55%, transparent)' };
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999, fontSize: 10.5, fontWeight: 700,
      background: `color-mix(in srgb, ${cfg.cor} 13%, transparent)`, color: cfg.cor,
      border: `1px solid color-mix(in srgb, ${cfg.cor} 33%, transparent)`, whiteSpace: 'nowrap',
    }}>{cfg.label}</span>
  );
}

export default function ConvergenciaAba() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [modalRow, setModalRow] = useState(null);
  const [filtroFonte, setFiltroFonte] = useState('todos'); // todos|fde|sgeeasy|ambos
  const [sortCol, setSortCol] = useState('ressarcimento');

  useEffect(() => {
    let cancel = false;
    setLoading(true); setError('');
    apiClient.get('/api/v1/faturas/fde-analise/convergencia')
      .then((r) => { if (!cancel) setData(r.data || null); })
      .catch((e) => { if (!cancel) setError(e?.response?.data?.error || e?.message || 'Falha ao carregar.'); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [tick]);

  const itens = useMemo(() => {
    let arr = data?.items || [];
    if (filtroFonte !== 'todos') arr = arr.filter((r) => r.fonte === filtroFonte);
    return [...arr].sort((a, b) => (Number(b[sortCol]) || 0) - (Number(a[sortCol]) || 0));
  }, [data, filtroFonte, sortCol]);

  const totalRess = useMemo(() => itens.reduce((s, r) => s + (Number(r.ressarcimento) || 0), 0), [itens]);
  const cont = useMemo(() => {
    const c = { fde: 0, sgeeasy: 0, ambos: 0 };
    (data?.items || []).forEach((r) => { c[r.fonte] = (c[r.fonte] || 0) + 1; });
    return c;
  }, [data]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* KPIs */}
      <div className="cpv2-kpis">
        <div className="cpv2-kpi">
          <div className="cpv2-kpi__label">Apontamentos (união)</div>
          <div className="cpv2-kpi__value">{loading ? '…' : (data?.total ?? 0)}</div>
        </div>
        <div className="cpv2-kpi">
          <div className="cpv2-kpi__label">Ressarcimento estimado (filtro)</div>
          <div className="cpv2-kpi__value" style={{ color: 'var(--success)' }}>{loading ? '…' : fmtBRL(totalRess)}</div>
        </div>
        <div className="cpv2-kpi">
          <div className="cpv2-kpi__label">FDE / sgeeasy / ambos</div>
          <div className="cpv2-kpi__value" style={{ fontSize: 15 }}>
            {loading ? '…' : `${cont.fde} / ${cont.sgeeasy} / ${cont.ambos}`}
          </div>
        </div>
      </div>

      {/* Filtros */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }} className="text-xs">
          <span className="opacity-70">Fonte:</span>
          {['todos', 'fde', 'sgeeasy', 'ambos'].map((f) => (
            <button key={f} onClick={() => setFiltroFonte(f)}
              style={{
                padding: '3px 10px', borderRadius: 999, fontWeight: 600, fontSize: 11.5,
                border: `1px solid ${filtroFonte === f ? 'var(--accent)' : 'var(--cpv2-border)'}`,
                background: filtroFonte === f ? 'color-mix(in srgb, var(--accent) 13%, transparent)' : 'transparent',
                color: filtroFonte === f ? 'var(--accent)' : 'var(--cpv2-text-muted)',
              }}>{f === 'todos' ? 'Todas' : (FONTES[f]?.label || f)}</button>
          ))}
          <span className="opacity-70" style={{ marginLeft: 10 }}>Ordenar:</span>
          <select className="cpv2-select" value={sortCol} onChange={(e) => setSortCol(e.target.value)}>
            <option value="ressarcimento">Maior ressarcimento</option>
            <option value="desvio_pct_max">Maior desvio %</option>
            <option value="consumo">Maior consumo</option>
          </select>
        </div>
        <button className="cpv2-btn cpv2-btn--sm" onClick={() => setTick((x) => x + 1)} disabled={loading}>
          {loading ? 'Carregando…' : 'Recarregar'}
        </button>
      </div>

      <div className="cpv2-tablewrap">
        {loading ? (
          <div className="p-8 text-center text-sm opacity-60">Carregando apontamentos…</div>
        ) : error ? (
          <div className="p-8 text-center text-sm" style={{ color: 'var(--danger)' }}>{error}</div>
        ) : itens.length === 0 ? (
          <div className="p-8 text-center text-sm opacity-60">Nenhum apontamento.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="cpv2-table">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left">UC</th>
                  <th className="px-3 py-2 text-left">Empresa</th>
                  <th className="px-3 py-2 text-left">Distribuidora</th>
                  <th className="px-3 py-2 text-left">Mês</th>
                  <th className="px-3 py-2 text-center">Fonte</th>
                  <th className="px-3 py-2 text-right">Desvio %</th>
                  <th className="px-3 py-2 text-right">Consumo</th>
                  <th className="px-3 py-2 text-left">Fichas</th>
                  <th className="px-3 py-2 text-right">Ressarcimento</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((r) => (
                  <tr key={`${r.fonte}-${r.id}`} onClick={() => setModalRow(r)}
                      style={{ cursor: 'pointer' }} className="hover:bg-[var(--cpv2-surface-2)]">
                    <td className="px-3 py-2 font-mono text-xs">{r.UC || '—'}</td>
                    <td className="px-3 py-2">{r.cod_empresa ?? '—'}</td>
                    <td className="px-3 py-2">{r.distribuidora || '—'}</td>
                    <td className="px-3 py-2">{fmtMes(r.mes_ref)}</td>
                    <td className="px-3 py-2 text-center"><FonteBadge f={r.fonte} /></td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.desvio_pct_max != null ? `${Number(r.desvio_pct_max).toFixed(1)}%` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtKwh(r.consumo)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.fichas_aplicadas || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: r.ressarcimento > 0 ? 'var(--success)' : 'var(--cpv2-text-muted)' }}>
                      {r.ressarcimento > 0 ? fmtBRL(r.ressarcimento) : 'não estimável'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalRow && (
        <ModalFaturaMontada
          row={modalRow}
          onClose={() => setModalRow(null)}
          onRejeitado={() => { setModalRow(null); setTick((x) => x + 1); }}
        />
      )}
    </div>
  );
}
