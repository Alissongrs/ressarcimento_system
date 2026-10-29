// src/pages/ProtocolosAneel.jsx
// Protocolos da Ouvidoria ANEEL: consultar um protocolo (e vincular a um processo), lista de todos e os
// protocolos que aparecem em mais de um processo (admin confirma qual vale) e as tarefas que as mudanças geram
// (vão para quem fez a última alteração no processo). Botão para consultar o site da ANEEL pela extensão.
// As mudanças chegam pelos e-mails da ANEEL (conferidos a cada 15 min) — ver backend/protocolos.
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Landmark, RefreshCw, Search, Lock } from 'lucide-react';
import api from '../services/apiClient.js';
import { useAuth } from '../context/AuthContext.jsx';
import { formatarProtocolo, protocoloValido, SITUACOES_ANEEL } from '../utils/protocolosAneel.js';
import './protocolosAneel.css';

function fmt(d) {
  if (!d) return '—';
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '—' : t.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

const COR_SIT = {
  'Registrado na ANEEL': 'var(--accent)',
  'Resposta da ANEEL': 'var(--warning)',
  'Prazo da distribuidora encerrado': 'var(--danger)',
  'Em análise na concessionária': 'var(--accent)',
  'Em análise na ANEEL': 'var(--accent)',
  'Concluída na ANEEL': 'var(--success)',
};

// Texto longo (resposta da ANEEL) começa recolhido; clica para ler inteiro.
function TextoRecolhido({ texto, rotulo = 'Ver texto' }) {
  const [aberto, setAberto] = useState(false);
  return (
    <div className="text-xs mt-1">
      <button type="button" className="underline opacity-80" onClick={() => setAberto((v) => !v)}>
        {aberto ? '▾ Recolher' : `▸ ${rotulo}`}
      </button>
      {aberto && <div className="mt-1 whitespace-pre-wrap text-sm">{texto}</div>}
    </div>
  );
}

function Pill({ texto, cor = 'var(--fg)' }) {
  return (
    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `color-mix(in srgb, ${cor} 16%, transparent)`, color: cor }}>
      {texto}
    </span>
  );
}

function Situacao({ s }) {
  return s ? <Pill texto={s} cor={COR_SIT[s]} /> : <span className="text-xs opacity-60">nenhum e-mail da ANEEL ainda</span>;
}

const card = { borderColor: 'var(--border)', background: 'var(--card)' };

// ── Consultar ────────────────────────────────────────────────────────────────
function Consultar({ inicial, onErro }) {
  const [q, setQ] = useState(inicial || '');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [outro, setOutro] = useState('');
  const [msg, setMsg] = useState('');

  const consultar = useCallback(async (valor) => {
    const v = valor ?? q;
    if (!protocoloValido(v)) { onErro('Protocolo ANEEL tem 13 números começando com 010 (ex.: 010.665.84026-55).'); return; }
    setBusy(true); setMsg('');
    try {
      const { data } = await api.get('/protocolos-aneel/consulta', { params: { protocolo: v } });
      setRes(data);
    } catch (e) { onErro(e?.response?.data?.error || 'Falha na consulta.'); }
    finally { setBusy(false); }
  }, [q, onErro]);

  useEffect(() => { if (inicial && protocoloValido(inicial)) consultar(inicial); }, [inicial]); // eslint-disable-line react-hooks/exhaustive-deps

  const vincular = async (idProcesso) => {
    setBusy(true);
    try {
      await api.post('/protocolos-aneel/vincular', { protocolo: res.protocolo, id_processo: Number(idProcesso) || 0 });
      setMsg(Number(idProcesso) ? `Vinculado ao processo #${idProcesso}.` : 'Protocolo em acompanhamento (sem processo).');
      setOutro('');
      await consultar(res.protocolo);
    } catch (e) { onErro(e?.response?.data?.error || 'Falha ao vincular.'); }
    finally { setBusy(false); }
  };

  const itens = res?.itens || [];
  const comProcesso = itens.filter((i) => i.id_processo);
  const sit = itens.find((i) => i.situacao);

  return (
    <div className="rounded-xl border p-4" style={card}>
      <div className="flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && consultar()}
          placeholder="010.000.00000-00" className="flex-1 min-w-[220px] rounded border px-3 py-2 font-mono text-base"
          style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--fg)' }} />
        <button disabled={busy} onClick={() => consultar()} className="pa-btn pa-btn--pri flex items-center gap-1">
          <Search size={15} /> Consultar
        </button>
      </div>

      {res && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <b className="font-mono text-lg">{res.protocolo}</b>
            <Situacao s={sit?.situacao} />
            {sit?.ultima_mudanca_em && <span className="text-xs opacity-60">desde {fmt(sit.ultima_mudanca_em)}</span>}
          </div>
          {!res.site_disponivel && (
            <div className="mt-2 text-xs rounded px-3 py-2" style={{ background: 'color-mix(in srgb, var(--warning) 12%, transparent)' }}>
              {res.aviso_site}
            </div>
          )}
          {sit?.ultimo_andamento && <div className="mt-3"><TextoRecolhido texto={sit.ultimo_andamento} rotulo="Ver o texto da ANEEL" /></div>}

          <h3 className="mt-4 mb-2 font-semibold text-sm">Processo</h3>
          {comProcesso.length > 0 ? comProcesso.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center gap-2 py-1 text-sm">
              <Link to={`/processos/${i.id_processo}`} className="font-semibold underline">#{i.id_processo}</Link>
              <span>{i.cliente} · {i.concessionaria}{i.uc ? ` · UC ${i.uc}` : ''}</span>
              {i.status_vinculo === 'confirmar' && <Pill texto="a confirmar (está em mais de um processo)" cor="var(--danger)" />}
            </div>
          )) : (
            <>
              <div className="text-sm mb-2" style={{ color: 'var(--warning)' }}>⚠️ Este protocolo não está em nenhum processo.</div>
              {(res.sugestoes || []).map((s) => (
                <div key={s.id_processo} className="flex flex-wrap items-center gap-2 rounded border p-2 mb-2 text-sm" style={{ borderColor: 'var(--border)' }}>
                  <span>Sugestão: <b>#{s.id_processo}</b> — {s.cliente} · {s.concessionaria}</span>
                  <span className="text-xs opacity-60">({s.motivo})</span>
                  <button disabled={busy} onClick={() => vincular(s.id_processo)} className="pa-btn ml-auto">Vincular</button>
                </div>
              ))}
            </>
          )}
          <div className="flex flex-wrap items-center gap-2 rounded border p-2 text-sm" style={{ borderColor: 'var(--border)' }}>
            <span>{comProcesso.length ? 'Vincular também a outro processo:' : 'Outro processo:'}</span>
            <input value={outro} onChange={(e) => setOutro(e.target.value.replace(/\D/g, ''))} placeholder="nº do processo"
              className="w-36 rounded border px-2 py-1" style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--fg)' }} />
            <button disabled={busy || !outro} onClick={() => vincular(outro)} className="pa-btn">Vincular</button>
            {!itens.length && (<>
              <span className="opacity-60">ou</span>
              <button disabled={busy} onClick={() => vincular(0)} className="pa-btn">Só acompanhar (sem processo)</button>
            </>)}
          </div>

          {msg && <div className="mt-3 text-sm" style={{ color: 'var(--success)' }}>{msg}</div>}

          <h3 className="mt-5 mb-2 font-semibold text-sm">Linha do tempo</h3>
          {!(res.eventos || []).length ? <div className="text-xs opacity-60">Nenhuma mudança registrada ainda.</div> : (
            <div className="border-l-2 pl-4 ml-1" style={{ borderColor: 'var(--border)' }}>
              {res.eventos.map((e) => (
                <div key={e.id} className="mb-3 text-sm">
                  <div><b>{fmt(e.ocorrido_em)} — {e.situacao_nova || 'novidade'}</b></div>
                  {e.assunto && <div className="text-xs opacity-60">e-mail: {e.assunto}</div>}
                  {e.andamento && <TextoRecolhido texto={e.andamento} />}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Lista / A confirmar ──────────────────────────────────────────────────────
function Lista({ vinculo, isAdmin, onConsultar, onErro, onMudou }) {
  const [q, setQ] = useState('');
  const [situacao, setSituacao] = useState('');
  const [lista, setLista] = useState([]);
  const [busy, setBusy] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const { data } = await api.get('/protocolos-aneel', { params: { q: q || undefined, situacao: situacao || undefined, vinculo: vinculo || undefined } });
      setLista(data?.itens || []);
    } catch (e) { onErro(e?.response?.data?.error || 'Falha ao carregar.'); }
  }, [q, situacao, vinculo, onErro]);
  useEffect(() => { const t = setTimeout(carregar, 300); return () => clearTimeout(t); }, [carregar]);

  const confirmar = async (p, manter) => {
    setBusy(true);
    try { await api.post(`/protocolos-aneel/${p.id}/confirmar`, { manter }); await carregar(); onMudou(); }
    catch (e) { onErro(e?.response?.data?.error || 'Falha ao confirmar.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border" style={card}>
      <div className="flex flex-wrap items-center gap-2 p-3 border-b" style={{ borderColor: 'var(--border)' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar protocolo, processo, cliente ou UC"
          className="flex-1 min-w-[220px] rounded border px-2 py-1 text-sm" style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--fg)' }} />
        {vinculo !== 'confirmar' && (
          <select value={situacao} onChange={(e) => setSituacao(e.target.value)} className="text-sm rounded border px-2 py-1" style={card}>
            <option value="">Situação: todas</option>
            {SITUACOES_ANEEL.map((s) => <option key={s} value={s}>{s}</option>)}
            <option value="sem">Nenhum e-mail da ANEEL ainda</option>
          </select>
        )}
        <span className="text-xs opacity-60">{lista.length} linha(s)</span>
      </div>
      {vinculo === 'confirmar' && (
        <div className="px-3 pt-3 text-xs opacity-70">
          Estes protocolos foram escritos no histórico de mais de um processo. Diga em qual processo cada um vale — o vínculo tirado fica guardado (não é apagado).
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs opacity-70">
            <th className="px-3 py-2">Protocolo</th><th className="px-3 py-2">Processo / cliente</th><th className="px-3 py-2">Situação na ANEEL</th>
            <th className="px-3 py-2">Última mudança</th><th className="px-3 py-2">Origem</th>
            {vinculo === 'confirmar' && isAdmin && <th className="px-3 py-2" />}
          </tr></thead>
          <tbody>
            {lista.map((p) => (
              <tr key={p.id} className="border-t align-top" style={{ borderColor: 'var(--border)' }}>
                <td className="px-3 py-2 font-mono"><button className="underline" onClick={() => onConsultar(p.protocolo)}>{p.protocolo}</button></td>
                <td className="px-3 py-2">
                  {p.id_processo ? <Link to={`/processos/${p.id_processo}`} className="underline">#{p.id_processo}</Link> : <Pill texto="sem processo" cor="var(--warning)" />}
                  <div className="text-xs opacity-60">{[p.cliente, p.concessionaria].filter(Boolean).join(' · ')}</div>
                </td>
                <td className="px-3 py-2"><Situacao s={p.situacao} /></td>
                <td className="px-3 py-2 text-xs whitespace-nowrap">{fmt(p.ultima_mudanca_em)}</td>
                <td className="px-3 py-2 text-xs">{{ historico: 'histórico', manual: 'cadastro', email: 'e-mail da ANEEL' }[p.origem] || p.origem}</td>
                {vinculo === 'confirmar' && isAdmin && (
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    <button disabled={busy} onClick={() => confirmar(p, true)} className="pa-btn">Vale neste</button>{' '}
                    <button disabled={busy} onClick={() => confirmar(p, false)} className="pa-btn">Tirar deste</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// "Consultar no site da ANEEL": a extensão SURE — Consulta ANEEL abre a janela da Ouvidoria, o usuário
// entra (login e verificação são dele), a extensão lê os protocolos abertos e devolve para esta página,
// que grava com o login do SURE. Sem a extensão, mostra como instalar.
function ConsultaSite({ isAdmin, onFim, onErro }) {
  const [temExt, setTemExt] = useState(() => document.documentElement.dataset.sureAneelExt === '1');
  const [estado, setEstado] = useState('');
  const [ajuda, setAjuda] = useState(false);
  const [rodando, setRodando] = useState(false);

  useEffect(() => {
    const ouvir = async (ev) => {
      if (ev.source !== window || ev.origin !== window.location.origin) return;
      const d = ev.data || {};
      if (d.origem !== 'sure-aneel-ext') return;
      if (d.tipo === 'pronta') setTemExt(true);
      else if (d.tipo === 'aguardando_login') setEstado(`Janela da ANEEL aberta: entre com o login (${d.total} protocolos a consultar).`);
      else if (d.tipo === 'lendo') setEstado(`Lendo ${d.total} protocolos no site…`);
      else if (d.tipo === 'progresso') setEstado(`Lendo no site… ${d.feito} de ${d.total}`);
      else if (d.tipo === 'erro') { setRodando(false); setEstado(''); onErro(d.erro); }
      else if (d.tipo === 'resultado') {
        if (d.itens?.length) {
          setEstado(`Gravando ${d.itens.length} protocolos…`);
          try {
            const { data } = await api.post('/protocolos-aneel/site/importar', { itens: d.itens });
            const r = data?.resultado || {};
            onFim(`Site da ANEEL: ${d.itens.length} de ${d.total} lidos, ${r.mudaram || 0} mudaram, ${r.concluidos || 0} concluídos agora.` +
              (d.erro ? ` Parou antes do fim: ${d.erro}` : ''));
          } catch (e) { onErro(e?.response?.data?.error || 'Falha ao gravar o resultado do site.'); }
        } else if (d.erro) onErro(d.erro);
        setRodando(false); setEstado('');
      }
    };
    window.addEventListener('message', ouvir);
    window.postMessage({ origem: 'sure-pagina', tipo: 'ping' }, window.location.origin);
    return () => window.removeEventListener('message', ouvir);
  }, [onFim, onErro]);

  const consultar = async (todos = false) => {
    if (!temExt) { setAjuda(true); return; }
    setRodando(true); setEstado(todos ? 'Buscando todos os protocolos…' : 'Buscando os protocolos abertos…');
    try {
      const { data } = await api.get('/protocolos-aneel/site/abertos', { params: todos ? { todos: 1 } : {} });
      window.postMessage({ origem: 'sure-pagina', tipo: 'consultar', lista: data?.protocolos || [] }, window.location.origin);
    } catch (e) { setRodando(false); setEstado(''); onErro(e?.response?.data?.error || 'Falha ao buscar os protocolos.'); }
  };

  return (
    <>
      <button disabled={rodando} onClick={() => consultar(false)} className="pa-btn flex items-center gap-1"
        title="Abre o site da ANEEL; você entra e a extensão atualiza os protocolos abertos">
        <Landmark size={13} className={rodando ? 'animate-pulse' : ''} /> Consultar no site da ANEEL
      </button>
      {isAdmin && (
        <button disabled={rodando} onClick={() => consultar(true)} className="pa-btn"
          title="Relê TODOS os protocolos (inclusive concluídos) para trazer o texto completo das respostas — demora mais">
          Reler todos
        </button>
      )}
      {estado && <span className="text-xs opacity-80">{estado}</span>}
      {ajuda && (
        <div className="w-full text-sm rounded-xl border px-3 py-2" style={card}>
          <b>Falta instalar a extensão "SURE — Consulta ANEEL" neste Chrome</b> (uma vez só):
          <ol className="list-decimal ml-5 mt-1 space-y-0.5">
            <li>Peça a pasta <code>extensao_aneel</code> ao administrador e salve no computador.</li>
            <li>Abra <code>chrome://extensions</code> e ligue o <b>Modo do desenvolvedor</b> (canto superior direito).</li>
            <li>Clique em <b>Carregar sem compactação</b> e escolha a pasta <code>extensao_aneel</code>.</li>
            <li>Recarregue esta página e clique de novo em <b>Consultar no site da ANEEL</b>.</li>
          </ol>
          <button className="pa-btn mt-2" onClick={() => setAjuda(false)}>Fechar</button>
        </div>
      )}
    </>
  );
}

// ── Tarefas: cada mudança do protocolo vira uma tarefa para quem fez a última alteração no processo
// (histórico ou edição); sem processo ou sem ninguém, fica sem responsável e o admin direciona.
function Tarefas({ isAdmin, onErro }) {
  const [status, setStatus] = useState('abertas');
  const [minhas, setMinhas] = useState(!isAdmin);
  const [lista, setLista] = useState(null);
  const [equipe, setEquipe] = useState([]);
  const carregar = useCallback(async () => {
    try {
      const { data } = await api.get('/tarefas', { params: { status, minhas: minhas ? 1 : 0 } });
      setLista(data || []);
    } catch (e) { onErro(e?.response?.data?.error || 'Falha ao carregar as tarefas.'); setLista([]); }
  }, [status, minhas, onErro]);
  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => {
    if (isAdmin) api.get('/protocolos-aneel/analistas').then(({ data }) => setEquipe(data || [])).catch(() => {});
  }, [isAdmin]);

  const direcionar = async (t, id) => {
    try { await api.post(`/tarefas/${t.id_tarefa}/direcionar`, { id_usuario: Number(id) }); carregar(); }
    catch (e) { onErro(e?.response?.data?.error || 'Falha ao direcionar.'); }
  };
  const concluir = async (t) => {
    const comentario = window.prompt('O que foi feito? (opcional)', '');
    if (comentario === null) return;
    try { await api.post(`/tarefas/${t.id_tarefa}/concluir`, { comentario }); carregar(); }
    catch (e) { onErro(e?.response?.data?.error || 'Falha ao concluir.'); }
  };

  return (
    <div className="rounded-xl border" style={card}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm border-b" style={{ borderColor: 'var(--border)' }}>
        {[['abertas', 'Abertas'], ['concluidas', 'Concluídas (30 dias)']].map(([k, l]) => (
          <button key={k} onClick={() => setStatus(k)} className="px-2 py-1 rounded"
            style={status === k ? { background: 'var(--accent)', color: '#fff' } : { border: '1px solid var(--border)' }}>{l}</button>
        ))}
        {isAdmin && (
          <label className="ml-2 flex items-center gap-1 text-xs">
            <input type="checkbox" checked={minhas} onChange={(e) => setMinhas(e.target.checked)} /> só as minhas
          </label>
        )}
        <span className="ml-auto text-xs opacity-60">Vai para quem fez a última alteração no processo.</span>
      </div>
      {lista === null ? <div className="p-4 text-sm opacity-60">Carregando…</div> : lista.length === 0 ? (
        <div className="p-4 text-sm opacity-60">Nenhuma tarefa {status === 'abertas' ? 'aberta' : 'concluída nos últimos 30 dias'}.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs opacity-70">
              <th className="px-3 py-2">Tarefa</th><th className="px-3 py-2">Processo</th><th className="px-3 py-2">Responsável</th>
              <th className="px-3 py-2">Criada</th><th className="px-3 py-2" />
            </tr></thead>
            <tbody>
              {lista.map((t) => (
                <tr key={t.id_tarefa} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{t.titulo}</div>
                    {(t.cliente || t.concessionaria) && <div className="text-xs opacity-60">{[t.cliente, t.concessionaria].filter(Boolean).join(' · ')}</div>}
                    {t.comentario_conclusao && <div className="text-xs opacity-70 mt-1">Feito: {t.comentario_conclusao}</div>}
                  </td>
                  <td className="px-3 py-2">{t.id_processo ? <Link to={`/processos/${t.id_processo}`} className="underline">#{t.id_processo}</Link> : <span className="opacity-50">sem processo</span>}</td>
                  <td className="px-3 py-2">
                    {isAdmin && t.status !== 'concluida' ? (
                      <select className={`pa-input text-xs ${t.id_responsavel ? 'font-bold' : ''}`} value={t.id_responsavel || ''} onChange={(e) => e.target.value && direcionar(t, e.target.value)}
                        style={t.id_responsavel ? { color: 'var(--accent)' } : undefined}>
                        <option value="">— direcionar —</option>
                        {equipe.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
                      </select>
                    ) : (t.responsavel ? <span className="font-bold" style={{ color: 'var(--accent)' }}>{t.responsavel}</span> : <span className="opacity-50">sem responsável</span>)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs">{fmt(t.criado_em)}</td>
                  <td className="px-3 py-2 text-right">
                    {t.status !== 'concluida' && (isAdmin || t.id_responsavel) && (
                      <button className="pa-btn text-xs" onClick={() => concluir(t)}>Concluir</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function ProtocolosAneel() {
  const { user } = useAuth();
  const role = String(user?.tipo_conta || user?.role || user?.perfil || '').trim().toLowerCase();
  const isAdmin = role === 'admin';
  const [params, setParams] = useSearchParams();
  const protocoloUrl = params.get('protocolo') || '';
  const abaUrl = params.get('aba');
  const [aba, setAba] = useState(protocoloUrl ? 'consultar' : (['confirmar', 'tarefas'].includes(abaUrl) ? abaUrl : 'lista'));
  const [resumo, setResumo] = useState(null);
  const [erro, setErro] = useState('');
  const [busy, setBusy] = useState(false);
  const [aviso, setAviso] = useState('');

  const carregarResumo = useCallback(async () => {
    try {
      const r = await api.get('/protocolos-aneel', { params: { mudou_dias: 1 } });
      setResumo(r.data?.resumo || null);
    } catch { /* aviso aparece nas abas */ }
  }, []);

  useEffect(() => {
    carregarResumo();
  }, [carregarResumo]);

  const onErro = useCallback((m) => { setErro(m); setTimeout(() => setErro(''), 8000); }, []);
  const fimSite = useCallback((m) => { setAviso(m); carregarResumo(); }, [carregarResumo]);

  const atualizarAgora = async () => {
    setBusy(true); setAviso('');
    try {
      const { data } = await api.post('/protocolos-aneel/sincronizar');
      if (data?.ok) {
        const r = data.resultado || {};
        setAviso(`Atualizado: ${r.eventos || 0} mudança(s), ${r.novos_do_historico || 0} protocolo(s) novo(s) do histórico.`);
        carregarResumo();
      } else onErro(data?.erro || 'Falha ao atualizar.');
    } catch (e) { onErro(e?.response?.data?.error || 'Falha ao atualizar.'); }
    finally { setBusy(false); }
  };

  const irConsultar = (p) => { setParams({ protocolo: p }); setAba('consultar'); };

  if (!role || role === 'solicitante') {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <Lock size={28} style={{ color: 'var(--warning)', margin: '0 auto 12px' }} />
        <h1 className="text-lg font-bold mb-2">Acesso restrito</h1>
      </div>
    );
  }

  const ABAS = [
    ['consultar', 'Consultar protocolo'],
    ['lista', 'Todos os protocolos'],
    ['confirmar', `A confirmar${resumo?.confirmar ? ` (${resumo.confirmar})` : ''}`],
    ['tarefas', 'Tarefas'],
  ];

  return (
    <div className="w-full px-4 md:px-6 py-6">
      <div className="flex flex-wrap items-center gap-3 mb-1">
        <Landmark size={22} style={{ color: 'var(--accent)' }} />
        <h1 className="text-xl font-bold">Protocolos ANEEL</h1>
        <div className="ml-auto" />
        <ConsultaSite isAdmin={isAdmin} onFim={fimSite} onErro={onErro} />
        {isAdmin && (
          <button disabled={busy} onClick={atualizarAgora} className="pa-btn flex items-center gap-1">
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> Atualizar agora
          </button>
        )}
      </div>
      <p className="text-sm opacity-70 mb-4">
        O sistema confere a cada 15 minutos os e-mails da ANEEL e o histórico dos processos. Mudou → aparece aqui e no histórico do processo e vira uma tarefa para quem cuida do protocolo (sem ninguém, o admin direciona).
        Para conferir direto no site da ANEEL, use <b>Consultar no site da ANEEL</b>: você entra e o resto é automático.
      </p>
      {resumo && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          {[
            ['Protocolos acompanhados', resumo.total],
            ['Processos', resumo.processos],
            ['Mudaram em 24h', resumo.mudou_24h],
            ['Sem processo', resumo.sem_processo],
            ['Última conferência', fmt(resumo.ultima_verificacao_em)],
          ].map(([l, v]) => (
            <div key={l} className="rounded-xl border px-3 py-2" style={card}>
              <div className="text-xs opacity-70">{l}</div>
              <div className="text-lg font-bold">{v ?? '—'}</div>
            </div>
          ))}
        </div>
      )}
      {erro && <div className="mb-3 text-sm rounded px-3 py-2" style={{ background: 'color-mix(in srgb, var(--danger) 14%, transparent)' }}>{erro}</div>}
      {aviso && <div className="mb-3 text-sm rounded px-3 py-2" style={{ background: 'color-mix(in srgb, var(--success) 14%, transparent)' }}>{aviso}</div>}

      <div className="flex flex-wrap gap-1 mb-3">
        {ABAS.map(([k, l]) => (
          <button key={k} onClick={() => setAba(k)}
            className="px-3 py-1.5 rounded-lg text-sm"
            style={aba === k ? { background: 'var(--accent)', color: '#fff' } : { background: 'var(--card)', border: '1px solid var(--border)' }}>
            {l}
          </button>
        ))}
      </div>

      {aba === 'consultar' && <Consultar key={protocoloUrl} inicial={protocoloUrl} onErro={onErro} />}
      {aba === 'lista' && <Lista isAdmin={isAdmin} onConsultar={irConsultar} onErro={onErro} onMudou={carregarResumo} />}
      {aba === 'confirmar' && <Lista vinculo="confirmar" isAdmin={isAdmin} onConsultar={irConsultar} onErro={onErro} onMudou={carregarResumo} />}
      {aba === 'tarefas' && <Tarefas isAdmin={isAdmin} onErro={onErro} />}
    </div>
  );
}
