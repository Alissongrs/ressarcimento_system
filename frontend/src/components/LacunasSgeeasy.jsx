// LacunasSgeeasy — aba de divergência sgeeasy ↔ FATURA_DADOS_EXTRAIDOS.
//   • modo "lacunas":  apontado no sgeeasy (desvio>80%/outlier>150%) e NÃO na FDE.
//   • modo "reverso":  apontado pela FDE e NÃO no sgeeasy.
// Casamento por uid. Enriquecido com motivo + consumo sgeeasy/FDE/SEFAZ (o SEFAZ arbitra).
import React, { useEffect, useState } from 'react';
import apiClient from '../services/apiClient';

function parseValor(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  const br = /,\d{1,2}$/.test(s);
  const limpo = br ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = Number(limpo);
  return Number.isFinite(n) ? n : 0;
}
const fmtBRL = (v) =>
  parseValor(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtKwh = (v) =>
  v == null ? '—' : `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kWh`;
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

// "Não extraída" não tem equivalente semântico (não é danger/warning/success/accent) —
// mantém tom violeta acinzentado (mesmo usado como extra categórico no Donut.jsx) por sobriedade com a paleta SAP.
const MOTIVOS = {
  nao_extraida:       { label: 'Não extraída',        cor: '#7c6f9c' },
  consumo_divergente: { label: 'Consumo divergente',  cor: 'var(--warning)' },
  fde_sem_consumo:    { label: 'FDE sem consumo',      cor: 'var(--danger)' },
  so_algoritmo:       { label: 'Só algoritmo',         cor: 'var(--accent)' },
  so_fde:             { label: 'Só FDE',               cor: 'var(--accent)' },
};
function Badge({ children, cor }) {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999, fontSize: 10.5, fontWeight: 700,
      background: `color-mix(in srgb, ${cor} 13%, transparent)`, color: cor,
      border: `1px solid color-mix(in srgb, ${cor} 33%, transparent)`, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}
function MotivoBadge({ m }) {
  const cfg = MOTIVOS[m];
  if (!cfg) return <span className="opacity-30">—</span>;
  return <Badge cor={cfg.cor}>{cfg.label}</Badge>;
}
function CatBadge({ cat }) {
  if (!cat) return <span className="opacity-30">—</span>;
  const outlier = cat === 'OUTLIER';
  return <Badge cor={outlier ? 'var(--danger)' : 'var(--warning)'}>{outlier ? 'Outlier' : 'Desvio alto'}</Badge>;
}

export default function LacunasSgeeasy() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [modo, setModo] = useState('lacunas'); // 'lacunas' | 'reverso'

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError('');
    apiClient
      .get('/api/v1/faturas/fde-analise/sgeeasy-gap')
      .then((r) => { if (!cancel) setData(r.data || null); })
      .catch((e) => { if (!cancel) setError(e?.response?.data?.error || e?.message || 'Falha ao carregar.'); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [tick]);

  const lacunas = data?.lacunas?.items || [];
  const reverso = data?.reverso?.items || [];
  const itens = modo === 'lacunas' ? lacunas : reverso;

  const TabBtn = ({ id, label, total, cor }) => {
    const ativo = modo === id;
    return (
      <button
        onClick={() => setModo(id)}
        style={{
          padding: '6px 14px', borderRadius: 8, fontWeight: 700, fontSize: 12.5,
          border: `1px solid ${ativo ? cor : 'var(--cpv2-border)'}`,
          background: ativo ? cor + '22' : 'transparent',
          color: ativo ? cor : 'var(--cpv2-text-muted)',
        }}
      >
        {label} {total != null ? `(${total})` : ''}
      </button>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Resumo */}
      <div className="cpv2-kpis">
        <div className="cpv2-kpi">
          <div className="cpv2-kpi__label">Lacunas (sgeeasy sem FDE)</div>
          <div className="cpv2-kpi__value" style={{ color: '#7c6f9c' }}>
            {loading ? '…' : (data?.lacunas?.total ?? 0)}
          </div>
        </div>
        <div className="cpv2-kpi">
          <div className="cpv2-kpi__label">Reverso (FDE sem sgeeasy)</div>
          <div className="cpv2-kpi__value" style={{ color: 'var(--accent)' }}>
            {loading ? '…' : (data?.reverso?.total ?? 0)}
          </div>
        </div>
        <div className="cpv2-kpi">
          <div className="cpv2-kpi__label">Apontados sgeeasy (desvio&gt;80%)</div>
          <div className="cpv2-kpi__value">{loading ? '…' : (data?.total_sgeeasy ?? 0)}</div>
        </div>
        <div className="cpv2-kpi">
          <div className="cpv2-kpi__label">Apontados FDE (motor)</div>
          <div className="cpv2-kpi__value">{loading ? '…' : (data?.total_fde_apontados ?? 0)}</div>
        </div>
      </div>

      {/* Toggle direção + recarregar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <TabBtn id="lacunas" label="sgeeasy → falta na FDE" total={data?.lacunas?.total} cor="#7c6f9c" />
          <TabBtn id="reverso" label="FDE → falta no sgeeasy" total={data?.reverso?.total} cor="var(--accent)" />
        </div>
        <button className="cpv2-btn cpv2-btn--sm" onClick={() => setTick((x) => x + 1)} disabled={loading}>
          {loading ? 'Carregando…' : 'Recarregar'}
        </button>
      </div>

      <div className="text-xs opacity-60">
        {modo === 'lacunas'
          ? 'Apontado no sgeeasy (desvio>80% / outlier>150%) e não apontado pela FDE. O SEFAZ arbitra qual consumo é o correto.'
          : 'Apontado pela FDE (motor F01–F05) e não apontado pelo sgeeasy.'}
      </div>

      {/* Tabela */}
      <div className="cpv2-tablewrap">
        {loading ? (
          <div className="p-8 text-center text-sm opacity-60">Carregando…</div>
        ) : error ? (
          <div className="p-8 text-center text-sm" style={{ color: 'var(--danger)' }}>{error}</div>
        ) : itens.length === 0 ? (
          <div className="p-8 text-center text-sm opacity-60">Nenhum caso nesta direção.</div>
        ) : modo === 'lacunas' ? (
          <div className="overflow-x-auto">
            <table className="cpv2-table">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left">UC</th>
                  <th className="px-3 py-2 text-left">Empresa</th>
                  <th className="px-3 py-2 text-left">Concessionária</th>
                  <th className="px-3 py-2 text-left">Mês</th>
                  <th className="px-3 py-2 text-center">Motivo</th>
                  <th className="px-3 py-2 text-right">Desvio %</th>
                  <th className="px-3 py-2 text-center">Categoria</th>
                  <th className="px-3 py-2 text-right">Cons. sgeeasy</th>
                  <th className="px-3 py-2 text-right">Cons. FDE</th>
                  <th className="px-3 py-2 text-right">Cons. SEFAZ</th>
                  <th className="px-3 py-2 text-center">Fatura</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 font-mono text-xs">{r.UC || '—'}</td>
                    <td className="px-3 py-2">{r.cod_empresa ?? '—'}</td>
                    <td className="px-3 py-2">{r.concessionaria || '—'}</td>
                    <td className="px-3 py-2">{fmtMes(r.mes_ref)}</td>
                    <td className="px-3 py-2 text-center"><MotivoBadge m={r.motivo} /></td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.desvio_pct_max != null ? `${Number(r.desvio_pct_max).toFixed(1)}%` : '—'}
                    </td>
                    <td className="px-3 py-2 text-center"><CatBadge cat={r.categoria_desvio} /></td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtKwh(r.consumo_sgeeasy)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtKwh(r.consumo_fde)}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: r.consumo_sefaz ? 'var(--success)' : undefined }}>
                      {fmtKwh(r.consumo_sefaz)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {r.link ? (
                        <a href={r.link} target="_blank" rel="noreferrer"
                           className="text-[var(--accent)] hover:text-[color-mix(in_srgb,var(--accent)_70%,white)] underline text-xs"
                           onClick={(e) => e.stopPropagation()}>abrir</a>
                      ) : <span className="opacity-30">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="cpv2-table">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left">UC (codigo_uc)</th>
                  <th className="px-3 py-2 text-left">Empresa</th>
                  <th className="px-3 py-2 text-left">Mês</th>
                  <th className="px-3 py-2 text-left">Fichas (FDE)</th>
                  <th className="px-3 py-2 text-right">Desvio % (FDE)</th>
                  <th className="px-3 py-2 text-right">Cons. FDE</th>
                  <th className="px-3 py-2 text-right">Cons. SEFAZ</th>
                  <th className="px-3 py-2 text-center">Motivo</th>
                  <th className="px-3 py-2 text-center">Fatura</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 font-mono text-xs">{r.UC || '—'}</td>
                    <td className="px-3 py-2">{r.cod_empresa ?? '—'}</td>
                    <td className="px-3 py-2">{fmtMes(r.mes_ref)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.fichas_aplicadas || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.desvio_pct_max != null ? `${Number(r.desvio_pct_max).toFixed(1)}%` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtKwh(r.consumo_fde)}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: r.consumo_sefaz ? 'var(--success)' : undefined }}>
                      {fmtKwh(r.consumo_sefaz)}
                    </td>
                    <td className="px-3 py-2 text-center"><MotivoBadge m={r.motivo} /></td>
                    <td className="px-3 py-2 text-center">
                      {r.link ? (
                        <a href={r.link} target="_blank" rel="noreferrer"
                           className="text-[var(--accent)] hover:text-[color-mix(in_srgb,var(--accent)_70%,white)] underline text-xs"
                           onClick={(e) => e.stopPropagation()}>abrir</a>
                      ) : <span className="opacity-30">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
