// Tempo de resposta aos protocolos ANEEL (página Métricas, fim da página).
// Do e-mail da ANEEL até: alguém atualizar o processo / dar "Ciente" no sininho / concluir a tarefa.
// Antes × depois da tela de protocolos (marco vem do backend). Dados: GET /relatorios/tempo-resposta-protocolos.
import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Landmark } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from 'recharts';
import { fmtDuracao } from '../utils/duracao.js';

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const rotMes = (ym) => { const [a, m] = String(ym).split('-'); return `${MESES[Number(m) - 1]}/${String(a).slice(2)}`; };

const fmtPct = (p) => `${Math.round(Number(p || 0))}%`;
const fmtData = (s) => (s ? new Date(s * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

const TIPOS = [
  ['resposta', 'Resposta da ANEEL'],
  ['prazo', 'Prazo da distribuidora encerrado'],
];

function Destaque({ titulo, antes, depois, dica }) {
  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.65, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{titulo}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, color: 'var(--fg)' }}>{depois}</span>
        <span style={{ fontSize: 12, opacity: 0.6 }}>depois da tela</span>
      </div>
      <div style={{ fontSize: 12, opacity: 0.75 }}>Antes: <b>{antes}</b></div>
      {dica && <div style={{ fontSize: 11, opacity: 0.55 }}>{dica}</div>}
    </div>
  );
}

const th = { textAlign: 'left', padding: '6px 8px', fontSize: 11, fontWeight: 600, opacity: 0.65, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const td = { padding: '6px 8px', fontSize: 12, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };

export default function TempoRespostaProtocolos({ dados, carregando, erro }) {
  const navigate = useNavigate();
  const [tipo, setTipo] = useState('resposta');

  const marco = dados?.marco ? new Date(`${dados.marco}T00:00:00-03:00`) : null;
  const mesMarco = dados?.marco ? dados.marco.slice(0, 7) : '';
  const r = dados?.resumo?.[tipo] || {};
  const antes = r.antes || {};
  const depois = r.depois || {};

  const serie = useMemo(() => (dados?.por_mes || [])
    .map((m) => ({ mes: m.mes, rotulo: rotMes(m.mes), ...(m[tipo] || {}) }))
    .filter((m) => m.n > 0)
    .map((m) => ({ ...m, dias: m.mediana_h != null ? Math.round((m.mediana_h / 24) * 10) / 10 : 0 })), [dados, tipo]);

  const itens = (dados?.itens || []).filter((it) => it.tipo === tipo);
  const agora = Date.now() / 1000;

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px 0', display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, background: 'color-mix(in srgb, var(--accent) 14%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Landmark size={15} style={{ color: 'var(--accent)' }} />
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Tempo de resposta aos protocolos ANEEL</div>
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
            Do e-mail da ANEEL até alguém atualizar o processo (não contam o usuário sistema nem e-mails anexados automaticamente).
            {marco && <> Comparação antes × depois da tela de protocolos, no ar desde <b>{marco.toLocaleDateString('pt-BR')}</b>. Base desde nov/2025.</>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 9, background: 'var(--panel)', border: '1px solid var(--border)' }}>
          {TIPOS.map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTipo(k)} style={{
              padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: tipo === k ? 'var(--accent)' : 'transparent', color: tipo === k ? '#fff' : 'var(--fg)', opacity: tipo === k ? 1 : 0.7,
            }}>{l}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: '12px 16px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {erro && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{erro}</div>}
        {carregando && !dados && <div style={{ fontSize: 12, opacity: 0.6 }}>Calculando…</div>}

        {dados && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
              <Destaque titulo="Tempo típico até atualizar" antes={fmtDuracao(antes.mediana_h)} depois={fmtDuracao(depois.mediana_h)}
                dica="Mediana: metade dos casos foi atualizada em até esse tempo" />
              <Destaque titulo="Atualizados em até 24 h" antes={`${fmtPct(antes.ate_24h_pct)} de ${antes.n || 0}`} depois={depois.n ? fmtPct(depois.ate_24h_pct) : '—'}
                dica={depois.n ? `de ${depois.n} e-mail(s) desde a tela` : 'Nenhum e-mail desde a tela'} />
              <Destaque titulo="Atualizados em até 3 dias" antes={fmtPct(antes.ate_72h_pct)} depois={depois.n ? fmtPct(depois.ate_72h_pct) : '—'} />
              <Destaque titulo="Aguardando atualização" antes={`${antes.pendentes || 0} de ${antes.n || 0}`} depois={`${depois.pendentes || 0} de ${depois.n || 0}`}
                dica="E-mails da ANEEL que ainda não tiveram nenhuma movimentação depois" />
              <Destaque titulo="Até dar Ciente no sininho" antes="não existia" depois={fmtDuracao(depois.mediana_ciente_h)}
                dica="Mediana, entre os avisos já confirmados" />
              <Destaque titulo="Até concluir a tarefa" antes="não existia" depois={fmtDuracao(depois.mediana_tarefa_h)}
                dica="Mediana, entre as tarefas já concluídas" />
            </div>
            {depois.n > 0 && depois.n < 30 && (
              <div style={{ fontSize: 11, opacity: 0.65 }}>
                Ainda são poucos casos depois da tela ({depois.n}). A comparação fica firme com umas 4 semanas de dados; os que estão aguardando atualização puxam o tempo para cima quando forem atualizados.
              </div>
            )}

            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Tempo típico até atualizar, por mês de chegada do e-mail (dias)</div>
              <div style={{ height: 220 }}>
                {serie.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={serie} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="rotulo" tick={{ fill: 'var(--fg)', opacity: 0.6, fontSize: 11 }} />
                      <YAxis tick={{ fill: 'var(--fg)', opacity: 0.6, fontSize: 11 }} />
                      <Tooltip
                        cursor={{ fill: 'color-mix(in srgb, var(--fg) 6%, transparent)' }}
                        contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--fg)' }}
                        formatter={(_v, _n, p) => [`${fmtDuracao(p?.payload?.mediana_h)} · ${fmtPct(p?.payload?.ate_24h_pct)} em até 24 h · ${p?.payload?.n} e-mail(s) · ${p?.payload?.pendentes} aguardando`, 'Tempo típico']}
                      />
                      <Bar dataKey="dias" radius={[4, 4, 0, 0]} maxBarSize={36}>
                        {serie.map((m) => (
                          <Cell key={m.mes} fill={m.mes >= mesMarco ? 'var(--accent)' : 'color-mix(in srgb, var(--fg) 30%, transparent)'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : <div style={{ fontSize: 12, opacity: 0.6 }}>Sem e-mails desse tipo na base.</div>}
              </div>
              <div style={{ display: 'flex', gap: 14, fontSize: 11, opacity: 0.7, marginTop: 4 }}>
                <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: 'color-mix(in srgb, var(--fg) 30%, transparent)', marginRight: 5 }} />Antes da tela</span>
                <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: 'var(--accent)', marginRight: 5 }} />Mês em que a tela entrou no ar e depois</span>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
              <div style={{ overflowX: 'auto' }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Por analista, desde a tela</div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={th}>Analista</th><th style={th}>E-mails</th><th style={th}>Tempo típico</th>
                    <th style={th}>Até 24 h</th><th style={th}>Aguardando</th><th style={th}>Até Ciente</th>
                  </tr></thead>
                  <tbody>
                    {(dados.por_analista?.[tipo] || []).map((a) => {
                      const rs = a.resumo || {};
                      return (
                        <tr key={a.analista}>
                          <td style={td}>{a.analista}</td><td style={td}>{rs.n}</td><td style={td}>{fmtDuracao(rs.mediana_h)}</td>
                          <td style={td}>{fmtPct(rs.ate_24h_pct)}</td><td style={td}>{rs.pendentes}</td><td style={td}>{fmtDuracao(rs.mediana_ciente_h)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {(dados.por_analista?.[tipo] || []).length === 0 && <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>Nenhum e-mail desse tipo desde a tela.</div>}
              </div>

              <div style={{ overflowX: 'auto' }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Protocolos desde a tela ({itens.length})</div>
                {itens.length === 0 ? <div style={{ fontSize: 12, opacity: 0.6 }}>Nenhum e-mail desse tipo desde a tela.</div> : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={th}>Protocolo</th><th style={th}>Processo</th><th style={th}>Chegou</th>
                      <th style={th}>Atualizado em</th><th style={th}>Ciente em</th><th style={th}>Tarefa concluída em</th><th style={th}>Responsável</th>
                    </tr></thead>
                    <tbody>
                      {itens.map((it) => (
                        <tr key={`${it.id_evento}-${it.id_processo}`}
                          style={it.h_atualizacao == null ? { background: 'color-mix(in srgb, var(--warning) 10%, transparent)' } : undefined}>
                          <td style={td}>
                            <button type="button" onClick={() => navigate(`/protocolos-aneel?protocolo=${encodeURIComponent(it.protocolo)}`)}
                              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 12 }}>
                              {it.protocolo}
                            </button>
                          </td>
                          <td style={td}>#{it.id_processo}</td>
                          <td style={td}>{fmtData(it.chegou)}</td>
                          <td style={td}>
                            {it.h_atualizacao != null
                              ? <><b>{fmtDuracao(it.h_atualizacao)}</b> <span style={{ opacity: 0.6 }}>({fmtData(it.atualizou)})</span></>
                              : <span>aguardando há {fmtDuracao((agora - it.chegou) / 3600)}</span>}
                          </td>
                          <td style={td}>{it.h_ciente != null ? fmtDuracao(it.h_ciente) : '—'}</td>
                          <td style={td}>{it.h_tarefa != null ? fmtDuracao(it.h_tarefa) : (it.id_tarefa ? 'aberta' : '—')}</td>
                          <td style={td}>{it.responsavel || 'Sem responsável'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
