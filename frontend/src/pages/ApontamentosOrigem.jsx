import React, { useEffect, useState } from 'react';
import apiClient from '../services/apiClient';
import CatalogoFichasModal from '../components/CatalogoFichasModal';
import { fichaTooltip } from '../data/fichasCatalogo';

// Renderiza "F01,F04" como badges com tooltip explicativo (o que é + como conferir).
const fichaBadgeStyle = {
  display: 'inline-block', margin: '0 3px 3px 0', padding: '1px 6px', borderRadius: 6,
  fontWeight: 700, fontSize: 11, cursor: 'help',
  background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)',
  border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)',
};
function renderFichas(raw) {
  const fichas = String(raw || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!fichas.length) return '—';
  return fichas.map((f) => (
    <span key={f} title={fichaTooltip(f)} style={fichaBadgeStyle}>{f}</span>
  ));
}

// Apontamentos do motor VERIFICADO sobre a Faturas_Registradas_Cache (sgeeasy),
// materializados em db_ressarcimento.apontamentos_desvio_origem.
// Mesmo conjunto do dossiê .html (F02 ANOMALIA/ATIVACAO/INFORMAR + F01/F04/F05).

const VEREDITO_COR = {
  ANOMALIA: { bg: 'color-mix(in srgb, var(--danger) 15%, var(--card))', fg: 'var(--danger)', label: '🔴 Anomalia' },
  INFORMAR: { bg: 'color-mix(in srgb, var(--warning) 22%, var(--card))', fg: 'var(--warning)', label: '🟡 Informar' },
  ATIVACAO: { bg: 'color-mix(in srgb, var(--fg) 10%, var(--card))', fg: 'var(--fg)', label: '⚪ Ativação' },
};

export default function ApontamentosOrigem() {
  const [resumo, setResumo] = useState(null);
  const [empresas, setEmpresas] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [empresa, setEmpresa] = useState('');
  const [ficha, setFicha] = useState('');
  const [catalogoFichas, setCatalogoFichas] = useState(false);
  const [veredito, setVeredito] = useState('');

  useEffect(() => {
    apiClient.get('/api/v1/desvio/origem/resumo').then((r) => setResumo(r.data)).catch(() => {});
    apiClient.get('/api/v1/desvio/origem/empresas').then((r) => setEmpresas(r.data || [])).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const p = new URLSearchParams();
    if (empresa) p.set('empresa', empresa);
    if (ficha) p.set('ficha', ficha);
    if (veredito) p.set('veredito', veredito);
    apiClient.get('/api/v1/desvio/origem?' + p.toString())
      .then((r) => setRows(r.data || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [empresa, ficha, veredito]);

  const card = (titulo, valor, cor) => (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 16px', minWidth: 120 }}>
      <div style={{ fontSize: 12, color: 'color-mix(in srgb, var(--fg) 55%, transparent)' }}>{titulo}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: cor || 'var(--fg)' }}>{valor ?? '—'}</div>
    </div>
  );

  const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 }));

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, Arial' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700 }}>Apontamentos — Origem (sgeeasy)</h1>
      <p style={{ color: 'color-mix(in srgb, var(--fg) 55%, transparent)', fontSize: 13 }}>
        Motor F01–F05 verificado sobre a <code>Faturas_Registradas_Cache</code> (validação forward + teto de sanidade + leitura confiável).
        Série: <code>lag3 lag2 lag1 [mês] lead1 lead2 lead3</code>.
      </p>

      {resumo && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '14px 0' }}>
          {card('Total apontado', resumo.total)}
          {card('F02 🔴 Anomalia', resumo.anomalia, 'var(--danger)')}
          {card('F02 ⚪ Ativação', resumo.ativacao, 'var(--fg)')}
          {card('F02 🟡 Informar', resumo.informar, 'var(--warning)')}
          {card('F01', resumo.f01)}
          {card('F05', resumo.f05)}
          {card('F04', resumo.f04)}
        </div>
      )}

      {/* filtros */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
        <select value={empresa} onChange={(e) => setEmpresa(e.target.value)} style={selStyle}>
          <option value="">Todas as empresas</option>
          {empresas.map((e) => (
            <option key={e.cod_empresa} value={e.cod_empresa}>
              {e.concessionaria || ('Empresa ' + e.cod_empresa)} ({e.qtd})
            </option>
          ))}
        </select>
        {['', 'F01', 'F02', 'F04', 'F05'].map((f) => (
          <button key={f || 'all'} onClick={() => setFicha(f)} style={btn(ficha === f)}>{f || 'Todas fichas'}</button>
        ))}
        {['', 'ANOMALIA', 'ATIVACAO', 'INFORMAR'].map((v) => (
          <button key={v || 'allv'} onClick={() => setVeredito(v)} style={btn(veredito === v)}>{v || 'Todos vereditos'}</button>
        ))}
        <button onClick={() => setCatalogoFichas(true)}
          title="Abrir o catálogo com a explicação das 61 fichas (o que é + como conferir)"
          style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
                   color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)',
                   background: 'color-mix(in srgb, var(--accent) 10%, transparent)' }}>
          📖 Catálogo de fichas
        </button>
      </div>

      <CatalogoFichasModal open={catalogoFichas} onClose={() => setCatalogoFichas(false)} />

      <div style={{ fontSize: 13, color: 'color-mix(in srgb, var(--fg) 55%, transparent)', marginBottom: 6 }}>
        {loading ? 'carregando…' : `${rows.length} apontamento(s)`}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: 'var(--panel)' }}>
              {['id', 'Empresa', 'Concessionária', 'Mês', 'Fichas', 'Veredito F02', 'Série (lag3..[mês]..lead3)', 'Desvio', 'Fatura']
                .map((h) => <th key={h} style={th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const vc = VEREDITO_COR[r.veredito_f02] || {};
              return (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={td}>{r.id}</td>
                  <td style={td}>{r.cod_empresa}</td>
                  <td style={td}>{r.concessionaria}</td>
                  <td style={td}>{(r.mes_ref || '').slice(0, 7)}</td>
                  <td style={td}>{renderFichas(r.fichas_aplicadas)}</td>
                  <td style={td}>
                    {r.veredito_f02
                      ? <span style={{ background: vc.bg, color: vc.fg, padding: '2px 8px', borderRadius: 10, fontWeight: 600 }}>{vc.label || r.veredito_f02}</span>
                      : '—'}
                  </td>
                  <td style={{ ...td, fontFamily: 'ui-monospace, Consolas, monospace' }}>{r.serie_f02 || '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{r.desvio_pct_max_f02 != null ? `${fmt(r.desvio_pct_max_f02)}%` : '—'}</td>
                  <td style={td}>{r.link ? <a href={r.link} target="_blank" rel="noreferrer">ver PDF</a> : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th = { border: '1px solid var(--border)', padding: '6px 8px', textAlign: 'left' };
const td = { border: '1px solid var(--border)', padding: '4px 8px', verticalAlign: 'top' };
const selStyle = { padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8 };
const btn = (active) => ({
  padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)',
  background: active ? 'var(--accent)' : 'var(--card)', color: active ? '#fff' : 'var(--fg)', cursor: 'pointer', fontSize: 12.5,
});
