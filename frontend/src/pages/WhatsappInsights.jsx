// src/pages/WhatsappInsights.jsx
// Aba "Insights" da tela WhatsApp: números do período, conversas aguardando resposta, tempo de resposta,
// volume por dia e por hora, assuntos (por palavras-chave), contatos mais ativos e mensagens com palavras
// de alerta. Só conversas diretas; nada é ligado a processo. Dados: GET /whatsapp/insights.
import React, { useCallback, useEffect, useState } from 'react';
import api from '../services/apiClient.js';
import './whatsappInsights.css';

const card = { borderColor: 'var(--border)', background: 'var(--card)' };

function telefone(chat) {
  const [n] = String(chat || '').split('@');
  const m = n.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${n}`;
}
function duracao(min) {
  if (min == null) return '—';
  if (min < 60) return `${min} min`;
  if (min < 60 * 24) return `${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ''}`.trim();
  return `${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`;
}
function dataCurta(iso) {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}
const fmtN = (n) => (n || 0).toLocaleString('pt-BR');

function Tile({ rotulo, valor, sub }) {
  return (
    <div className="rounded-xl border p-3" style={card}>
      <div className="text-xs wa-ins-muted">{rotulo}</div>
      <div className="text-2xl font-semibold mt-1">{valor}</div>
      {sub && <div className="text-xs wa-ins-muted mt-1">{sub}</div>}
    </div>
  );
}

function Painel({ titulo, nota, children }) {
  return (
    <div className="rounded-xl border p-4" style={card}>
      <div className="text-sm font-semibold">{titulo}</div>
      {nota && <div className="text-xs wa-ins-muted mb-2">{nota}</div>}
      {children}
    </div>
  );
}

// Colunas por dia: recebidas (série 1) empilhadas com enviadas (série 2), gap de 2px entre segmentos.
function VolumePorDia({ dias }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...dias.map((d) => d.recebidas + d.enviadas));
  const passo = Math.ceil(dias.length / 8); // rótulos espaçados no eixo
  return (
    <div>
      <div className="flex items-center gap-4 text-xs mb-2">
        <span className="flex items-center gap-1"><i className="wa-ins-sw wa-ins-rec" /> Recebidas</span>
        <span className="flex items-center gap-1"><i className="wa-ins-sw wa-ins-env" /> Enviadas</span>
      </div>
      <div className="wa-ins-plot" onMouseLeave={() => setHover(null)}>
        <div className="wa-ins-grid"><span>{fmtN(max)}</span><span>{fmtN(Math.round(max / 2))}</span><span>0</span></div>
        <div className="wa-ins-cols">
          {dias.map((d, i) => (
            <div key={d.dia} className="wa-ins-col" onMouseEnter={() => setHover(i)}>
              <div className="wa-ins-stack">
                {d.enviadas > 0 && <div className="wa-ins-bar wa-ins-env" style={{ height: `${(d.enviadas / max) * 100}%` }} />}
                {d.recebidas > 0 && <div className="wa-ins-bar wa-ins-rec" style={{ height: `${(d.recebidas / max) * 100}%` }} />}
              </div>
              <div className="wa-ins-x">{i % passo === 0 ? dataCurta(d.dia) : ''}</div>
              {hover === i && (
                <div className="wa-ins-tip" style={i > dias.length / 2 ? { right: 0 } : { left: 0 }}>
                  <b>{dataCurta(d.dia)}</b><br />
                  <i className="wa-ins-sw wa-ins-rec" /> {fmtN(d.recebidas)} recebidas<br />
                  <i className="wa-ins-sw wa-ins-env" /> {fmtN(d.enviadas)} enviadas
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Mensagens recebidas por hora do dia (uma série).
function PorHora({ horas }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...horas);
  return (
    <div className="wa-ins-plot" onMouseLeave={() => setHover(null)}>
      <div className="wa-ins-grid"><span>{fmtN(max)}</span><span>{fmtN(Math.round(max / 2))}</span><span>0</span></div>
      <div className="wa-ins-cols">
        {horas.map((n, h) => (
          <div key={h} className="wa-ins-col" onMouseEnter={() => setHover(h)}>
            <div className="wa-ins-stack">
              {n > 0 && <div className="wa-ins-bar wa-ins-rec" style={{ height: `${(n / max) * 100}%` }} />}
            </div>
            <div className="wa-ins-x">{h % 3 === 0 ? `${h}h` : ''}</div>
            {hover === h && (
              <div className="wa-ins-tip" style={h > 12 ? { right: 0 } : { left: 0 }}>
                <b>{h}h–{h + 1}h</b><br />{fmtN(n)} recebidas
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Assuntos: barras horizontais (uma série), rótulo e valor ao lado.
function Assuntos({ itens }) {
  const max = Math.max(1, ...itens.map((a) => a.conversas));
  return (
    <div className="space-y-2">
      {itens.map((a) => (
        <div key={a.assunto} title={a.exemplo ? `Exemplo: "${a.exemplo}"` : ''}>
          <div className="flex text-xs mb-0.5">
            <span>{a.assunto}</span>
            <span className="ml-auto wa-ins-muted">{fmtN(a.conversas)} conversas · {fmtN(a.mensagens)} msgs</span>
          </div>
          <div className="wa-ins-hbar-track">
            {a.conversas > 0 && <div className="wa-ins-hbar wa-ins-rec" style={{ width: `${(a.conversas / max) * 100}%` }} />}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function WhatsappInsights({ onAbrirConversa, onErro }) {
  const [dias, setDias] = useState(30);
  const [d, setD] = useState(null);

  const carregar = useCallback(async () => {
    try { const { data } = await api.get('/whatsapp/insights', { params: { dias } }); setD(data); }
    catch (e) { onErro(e?.response?.data?.error || 'Falha ao carregar os insights.'); }
  }, [dias, onErro]);
  useEffect(() => { carregar(); const t = setInterval(carregar, 60000); return () => clearInterval(t); }, [carregar]);

  if (!d) return <div className="text-sm wa-ins-muted p-4">Carregando…</div>;
  const r = d.resposta || {};
  const vazio = d.recebidas + d.enviadas === 0;

  return (
    <div className="wa-ins space-y-4">
      <div className="flex items-center gap-2">
        <select value={dias} onChange={(e) => setDias(Number(e.target.value))} className="text-sm rounded border px-2 py-1" style={card}>
          <option value={7}>Últimos 7 dias</option><option value={30}>Últimos 30 dias</option>
          <option value={90}>Últimos 90 dias</option><option value={365}>Último ano</option>
        </select>
        <span className="text-xs wa-ins-muted">Só conversas diretas (grupos ficam de fora). Atualiza a cada minuto.</span>
      </div>

      {vazio && (
        <div className="rounded-xl border p-4 text-sm" style={card}>
          Ainda não há mensagens no período. Os insights aparecem conforme as conversas chegam pelo número do departamento.
        </div>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <Tile rotulo="Conversas" valor={fmtN(d.conversas)} />
        <Tile rotulo="Mensagens recebidas" valor={fmtN(d.recebidas)} />
        <Tile rotulo="Mensagens enviadas" valor={fmtN(d.enviadas)} />
        <Tile rotulo="Aguardando resposta" valor={fmtN(d.aguardando?.length)}
          sub={d.aguardando?.length ? `mais antiga há ${duracao(d.aguardando[0].espera_min)}` : 'nenhuma'} />
        <Tile rotulo="Tempo de resposta (mediana)" valor={duracao(r.mediana_min)}
          sub={r.amostras ? `90% em até ${duracao(r.p90_min)}` : 'sem respostas no período'} />
        <Tile rotulo="Respondidas em até 1 h" valor={r.amostras ? `${r.pct_1h}%` : '—'}
          sub={r.amostras ? `${fmtN(r.amostras)} respostas medidas` : ''} />
      </div>

      <Painel titulo="Aguardando resposta" nota="O contato escreveu e o departamento ainda não respondeu. Mais antigas primeiro.">
        {!d.aguardando?.length ? <div className="text-sm wa-ins-muted">Nenhuma conversa esperando.</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs wa-ins-muted">
                <th className="py-1 pr-3">Contato</th><th className="py-1 pr-3">Esperando há</th><th className="py-1 pr-3">Msgs sem resposta</th><th className="py-1">Última mensagem</th>
              </tr></thead>
              <tbody>
                {d.aguardando.map((a) => (
                  <tr key={a.chat} className="border-t cursor-pointer wa-ins-row" style={{ borderColor: 'var(--border)' }} onClick={() => onAbrirConversa(a)}>
                    <td className="py-1.5 pr-3 whitespace-nowrap"><b>{a.nome || telefone(a.chat)}</b>{a.nome && <div className="text-[11px] wa-ins-muted">{telefone(a.chat)}</div>}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{duracao(a.espera_min)}</td>
                    <td className="py-1.5 pr-3">{a.sem_resposta}</td>
                    <td className="py-1.5 max-w-[520px] truncate">{a.ultimo_tipo === 'texto' ? a.ultimo_texto : `${a.ultimo_tipo}${a.ultimo_texto ? `: ${a.ultimo_texto}` : ''}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Painel>

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))' }}>
        <Painel titulo="Mensagens por dia">
          <VolumePorDia dias={d.por_dia || []} />
        </Painel>
        <Painel titulo="Horário em que os contatos escrevem" nota="Mensagens recebidas por hora do dia.">
          <PorHora horas={d.por_hora || []} />
        </Painel>
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))' }}>
        <Painel titulo="Assuntos mais frequentes" nota="Estimativa por palavras-chave nas mensagens recebidas; uma mensagem pode cair em mais de um assunto. Passe o mouse para ver um exemplo.">
          <Assuntos itens={d.assuntos || []} />
        </Painel>
        <Painel titulo="Contatos mais ativos">
          {!d.top_contatos?.length ? <div className="text-sm wa-ins-muted">Sem conversas no período.</div> : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs wa-ins-muted"><th className="py-1">Contato</th><th className="py-1 text-right">Recebidas</th><th className="py-1 text-right">Enviadas</th></tr></thead>
              <tbody>
                {d.top_contatos.map((c) => (
                  <tr key={c.chat} className="border-t cursor-pointer wa-ins-row" style={{ borderColor: 'var(--border)' }} onClick={() => onAbrirConversa(c)}>
                    <td className="py-1.5">{c.nome || telefone(c.chat)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtN(c.recebidas)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtN(c.enviadas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Painel>
      </div>

      <Painel titulo="Mensagens com palavras de alerta" nota="Procon, advogado, judicial, cancelar, urgente, absurdo, descaso… (as 30 mais recentes).">
        {!d.alertas?.length ? <div className="text-sm wa-ins-muted">Nenhuma no período.</div> : (
          <div className="space-y-1">
            {d.alertas.map((a, i) => (
              <button key={`${a.chat}-${i}`} type="button" onClick={() => onAbrirConversa(a)}
                className="w-full text-left text-sm border-t pt-1 wa-ins-row" style={{ borderColor: 'var(--border)' }}>
                <span className="wa-ins-tag">⚠ {a.palavra}</span>{' '}
                <b>{a.nome || telefone(a.chat)}</b>{' '}
                <span className="text-xs wa-ins-muted">{new Date(a.quando).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span>
                <div className="text-xs truncate">{a.texto}</div>
              </button>
            ))}
          </div>
        )}
      </Painel>
    </div>
  );
}
