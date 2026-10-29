// AuditoriaRankings — painel de pódio (escondido, abre no botão 🏆).
// Top 5 clientes por ressarcimento estimado e por nº de processos.
import React, { useEffect, useState } from 'react';
import apiClient from '../services/apiClient';

const fmtBRL = (v) =>
  (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const MEDALHA = ['🥇', '🥈', '🥉', '4º', '5º'];

function ListaRanking({ titulo, cor, itens, render }) {
  return (
    <div style={{ flex: 1, minWidth: 260 }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: cor }}>{titulo}</div>
      {(!itens || itens.length === 0) ? (
        <div className="text-xs opacity-50">Sem dados.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {itens.map((it, i) => (
            <div
              key={it.cod_empresa ?? i}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px', borderRadius: 8,
                background: 'var(--cpv2-surface, var(--card))',
                border: '1px solid var(--cpv2-border, var(--panel-border))',
              }}
            >
              <span style={{ width: 22, textAlign: 'center', fontWeight: 700 }}>{MEDALHA[i] || `${i + 1}º`}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>
                <span className="opacity-50 font-mono text-xs">{it.cod_empresa}</span> — {it.nome || '—'}
              </span>
              <span style={{ fontWeight: 700, fontSize: 12.5, color: cor, whiteSpace: 'nowrap' }}>
                {render(it)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AuditoriaRankings() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancel = false;
    apiClient
      .get('/api/v1/faturas/fde-analise/rankings', { params: { motor: 1 } })
      .then((r) => { if (!cancel) setData(r.data || null); })
      .catch((e) => { if (!cancel) setError(e?.response?.data?.error || 'Falha ao carregar rankings.'); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, []);

  return (
    <div
      style={{
        border: '1px solid var(--cpv2-border, var(--panel-border))',
        borderRadius: 12,
        padding: '14px 16px',
        background: 'var(--panel)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        🏆 Rankings — Top 5 clientes
      </div>
      {loading ? (
        <div className="text-xs opacity-60">Carregando rankings…</div>
      ) : error ? (
        <div className="text-xs" style={{ color: 'var(--danger)' }}>{error}</div>
      ) : (
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <ListaRanking
            titulo="Maior ressarcimento estimado"
            cor="var(--success)"
            itens={data?.top_ressarcimento}
            render={(it) => fmtBRL(it.valor)}
          />
          <ListaRanking
            titulo="Mais apontamentos (FDE)"
            cor="var(--accent)"
            itens={data?.top_processos}
            render={(it) => `${it.qtd} apont.`}
          />
        </div>
      )}
    </div>
  );
}
