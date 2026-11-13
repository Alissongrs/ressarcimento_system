// src/pages/WhatsappEmpresa.jsx
// WhatsApp do departamento dentro do SURE: o admin conecta uma vez por QR code e toda a equipe vê as
// conversas (mensagens recebidas e enviadas pelo número do departamento) e responde. Conectar,
// desconectar e escolher o grupo dos avisos são só do admin. Backend: backend/whatsapp.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, Paperclip, RefreshCw, Search, Send, Smartphone } from 'lucide-react';
import api, { withAuthToken } from '../services/apiClient.js';
import { useAuth } from '../context/AuthContext.jsx';
import WhatsappInsights from './WhatsappInsights.jsx';
import './protocolosAneel.css';

const card = { borderColor: 'var(--border)', background: 'var(--card)' };

function fmt(d, soHora) {
  if (!d) return '—';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '—';
  return soHora && t.toDateString() === new Date().toDateString()
    ? t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : t.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function telefone(chat) {
  const [n, srv] = String(chat || '').split('@');
  if (srv !== 's.whatsapp.net') return n;
  const m = n.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${n}`;
}

const TIPO_ICONE = { imagem: '📷', 'vídeo': '🎬', 'áudio': '🎤', documento: '📄', figurinha: '🏷️', 'localização': '📍', contato: '👤', 'reação': '❤️', outro: '…' };
function resumo(tipo, texto) {
  if (tipo === 'texto') return texto;
  return `${TIPO_ICONE[tipo] || ''} ${tipo}${texto ? `: ${texto}` : ''}`;
}

function tamanho(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Anexo de uma mensagem: imagem/vídeo/áudio em linha, documento como link; estados de espera e erro.
function Anexo({ m }) {
  if (!m.anexo_status) return null;
  if (m.anexo_status !== 'ok') {
    const txt = m.anexo_status === 'pedido' ? 'anexo antigo: aguardando o celular do departamento mandar o arquivo (ninguém recebe mensagem)'
      : m.anexo_status === 'pendente' ? 'anexo: baixando…'
      : `anexo indisponível${m.anexo_erro ? `: ${m.anexo_erro}` : ''}`;
    return <div className="text-[11px] opacity-70 italic mt-1">{txt}</div>;
  }
  const url = withAuthToken(`/api/v1/whatsapp/anexo/${m.id}`);
  const mime = m.anexo_mime || '';
  if (mime.startsWith('image/')) {
    return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={m.anexo_nome || 'imagem'} loading="lazy" className="rounded mt-1" style={{ maxWidth: 280, maxHeight: 320 }} /></a>;
  }
  if (mime.startsWith('audio/')) return <audio controls src={url} className="mt-1" style={{ maxWidth: 280 }} />;
  if (mime.startsWith('video/')) return <video controls src={url} className="rounded mt-1" style={{ maxWidth: 280 }} />;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 mt-1 underline">
      📎 {m.anexo_nome || 'arquivo'} <span className="opacity-60 no-underline">{tamanho(m.anexo_tamanho)}</span>
    </a>
  );
}

// Busca das conversas inteiras no celular (admin) + progresso; aparece acima da lista de conversas.
function HistoricoCompleto({ isAdmin, conectado, chat, onErro }) {
  const [p, setP] = useState(null);
  const [busy, setBusy] = useState(false);
  const ler = useCallback(async () => {
    try { const { data } = await api.get('/whatsapp/historico'); setP(data); } catch { /* sem progresso */ }
  }, []);
  useEffect(() => { ler(); const t = setInterval(ler, 5000); return () => clearInterval(t); }, [ler]);
  const chamar = async (url, body) => {
    setBusy(true);
    try { const { data } = await api.post(url, body || {}); setP(data); }
    catch (e) { onErro(e?.response?.data?.error || 'Falha ao falar com o servidor.'); }
    finally { setBusy(false); }
  };
  const rodando = !!p?.rodando;
  return (
    <div className="px-3 py-2 border-b text-xs flex flex-wrap items-center gap-2" style={{ borderColor: 'var(--border)' }}>
      {rodando ? (
        <span>Buscando no celular: {p.feitas}/{p.total} conversas · {p.novas} mensagens novas{p.conversa_nome ? ` · ${p.conversa_nome}` : ''}</span>
      ) : p?.fim ? (
        <span className="opacity-70">Última busca: {p.novas} mensagens novas em {p.total} conversas{p.erro ? ` · ${p.erro}` : ''}</span>
      ) : <span className="opacity-70">O celular manda só parte do histórico ao parear; a busca pede o resto ao próprio celular do departamento, conversa por conversa, sem enviar nada a ninguém.</span>}
      {isAdmin && conectado && !rodando && (
        <button className="pa-btn ml-auto" disabled={busy} onClick={() => chamar('/whatsapp/historico/puxar', {})}>Buscar conversas inteiras</button>
      )}
      {isAdmin && conectado && !rodando && chat && !chat.novo && (
        <button className="pa-btn" disabled={busy} onClick={() => chamar('/whatsapp/historico/puxar', { chat: chat.chat })}>Mais antigas desta conversa</button>
      )}
      {isAdmin && rodando && <button className="pa-btn ml-auto" disabled={busy} onClick={() => chamar('/whatsapp/historico/parar')}>Parar</button>}
      {isAdmin && !rodando && <button className="pa-btn" disabled={busy} title="Tenta baixar de novo os anexos que ficaram pendentes ou com erro"
        onClick={() => chamar('/whatsapp/anexos/retentar')}>Retentar anexos</button>}
    </div>
  );
}

// ── Conexão ──────────────────────────────────────────────────────────────────
function Conexao({ estado, isAdmin, onAtualizar, onErro }) {
  const [busy, setBusy] = useState(false);
  const acao = async (url, confirmar) => {
    if (confirmar && !window.confirm(confirmar)) return;
    setBusy(true);
    try { const { data } = await api.post(url); onAtualizar(data); }
    catch (e) { onErro(e?.response?.data?.error || 'Falha ao falar com o servidor.'); }
    finally { setBusy(false); }
  };

  if (!estado) return <div className="rounded-xl border p-4 text-sm opacity-70" style={card}>Carregando…</div>;
  if (!estado.ligado) {
    return (
      <div className="rounded-xl border p-4 text-sm" style={card}>
        O WhatsApp está desligado neste servidor{estado.erro ? ` (${estado.erro})` : ''}.
      </div>
    );
  }
  return (
    <div className="rounded-xl border p-4" style={card}>
      <div className="flex flex-wrap items-center gap-3">
        <Smartphone size={20} />
        {estado.conectado ? (
          <div className="text-sm">
            <b style={{ color: 'var(--success)' }}>● Conectado</b> como <b>{telefone(`${estado.numero}@s.whatsapp.net`)}</b>
            {estado.nome ? ` (${estado.nome})` : ''} {estado.desde && <span className="opacity-60">· desde {fmt(estado.desde)}</span>}
          </div>
        ) : estado.vinculado ? (
          <div className="text-sm"><b style={{ color: 'var(--warning)' }}>● Vinculado, mas sem conexão agora</b> — o servidor tenta reconectar sozinho.</div>
        ) : (
          <div className="text-sm"><b style={{ color: 'var(--danger)' }}>● Desconectado</b> — nenhum celular vinculado.</div>
        )}
        {isAdmin && <div className="ml-auto flex gap-2">
          {!estado.conectado && (
            <button className="pa-btn" disabled={busy} onClick={() => acao('/whatsapp/conectar')}>
              {estado.vinculado ? 'Reconectar' : 'Conectar (gerar QR code)'}
            </button>
          )}
          {estado.vinculado && (
            <button className="pa-btn" disabled={busy}
              onClick={() => acao('/whatsapp/desconectar', 'Desvincular o WhatsApp do departamento do SURE? Os avisos por WhatsApp param até conectar de novo.')}>
              Desconectar
            </button>
          )}
        </div>}
        {!isAdmin && !estado.vinculado && <span className="text-sm opacity-70">Peça a um administrador para conectar o WhatsApp do departamento.</span>}
      </div>
      {estado.erro && <div className="text-xs mt-2" style={{ color: 'var(--danger)' }}>{estado.erro}</div>}
      {estado.qr && (
        <div className="mt-4 flex flex-wrap items-start gap-6">
          <img src={estado.qr} alt="QR code para conectar o WhatsApp" width={260} height={260}
            style={{ background: '#fff', padding: 8, borderRadius: 8 }} />
          <ol className="text-sm list-decimal pl-5 space-y-1 max-w-md">
            <li>Abra o WhatsApp no celular do departamento.</li>
            <li>Toque em <b>⋮ / Configurações › Aparelhos conectados › Conectar um aparelho</b>.</li>
            <li>Aponte a câmera para este QR code.</li>
            <li className="opacity-70">O código muda sozinho a cada poucos segundos; se expirar, clique em Conectar de novo.</li>
          </ol>
        </div>
      )}
    </div>
  );
}

// ── Conversas (monitor) ──────────────────────────────────────────────────────
function Conversas({ conectado, inicial, onErro, isAdmin }) {
  const [q, setQ] = useState('');
  const [dias, setDias] = useState(0); // 0 = tudo
  const [lista, setLista] = useState([]);
  const [chat, setChat] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [texto, setTexto] = useState('');
  const [novo, setNovo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const fimRef = useRef(null);
  const arquivoRef = useRef(null);
  // vindo dos Insights: abre a conversa clicada
  useEffect(() => { if (inicial?.chat) setChat({ chat: inicial.chat, nome: inicial.nome }); }, [inicial]);

  const carregarLista = useCallback(async () => {
    try {
      const { data } = await api.get('/whatsapp/conversas', { params: { q, dias } });
      setLista(Array.isArray(data) ? data : []);
    } catch (e) { onErro(e?.response?.data?.error || 'Falha ao carregar as conversas.'); }
  }, [q, dias, onErro]);
  const carregarMsgs = useCallback(async () => {
    if (!chat) return;
    try {
      const { data } = await api.get('/whatsapp/mensagens', { params: { chat: chat.chat } });
      setMsgs(Array.isArray(data) ? data : []);
    } catch (e) { onErro(e?.response?.data?.error || 'Falha ao carregar as mensagens.'); }
  }, [chat, onErro]);

  useEffect(() => { carregarLista(); const t = setInterval(carregarLista, 15000); return () => clearInterval(t); }, [carregarLista]);
  useEffect(() => { carregarMsgs(); const t = setInterval(carregarMsgs, 10000); return () => clearInterval(t); }, [carregarMsgs]);
  useEffect(() => { fimRef.current?.scrollIntoView({ block: 'end' }); }, [msgs.length]);

  const enviar = async (para, txt, limpar) => {
    if (!para || !txt.trim()) return;
    setEnviando(true);
    try {
      await api.post('/whatsapp/enviar', { para, texto: txt });
      limpar('');
      await carregarLista(); await carregarMsgs();
    } catch (e) { onErro(e?.response?.data?.error || 'Falha ao enviar.'); }
    finally { setEnviando(false); }
  };

  // arquivo escolhido no clipe: sobe pelo número do departamento; o texto digitado vira a legenda
  const enviarArquivo = async (para, file) => {
    if (!para || !file) return;
    if (file.size > 25 * 1024 * 1024) { onErro('Arquivo maior que 25 MB.'); return; }
    setEnviando(true);
    try {
      const fd = new FormData();
      fd.append('para', para); fd.append('legenda', texto); fd.append('arquivo', file, file.name);
      await api.post('/whatsapp/enviar-arquivo', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setTexto('');
      await carregarLista(); await carregarMsgs();
    } catch (e) { onErro(e?.response?.data?.error || 'Falha ao enviar o arquivo.'); }
    finally { setEnviando(false); if (arquivoRef.current) arquivoRef.current.value = ''; }
  };

  return (
    <div className="rounded-xl border" style={card}>
    <HistoricoCompleto isAdmin={isAdmin} conectado={conectado} chat={chat} onErro={onErro} />
    <div className="grid" style={{ gridTemplateColumns: 'minmax(260px, 340px) 1fr', minHeight: 520 }}>
      <div className="border-r flex flex-col" style={{ borderColor: 'var(--border)' }}>
        <div className="p-2 flex gap-2 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-1 flex-1 rounded border px-2" style={card}>
            <Search size={14} className="opacity-60" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome ou número"
              className="text-sm py-1 bg-transparent outline-none w-full" />
          </div>
          <select value={dias} onChange={(e) => setDias(Number(e.target.value))} className="text-sm rounded border px-1" style={card}>
            <option value={0}>tudo</option><option value={7}>7 dias</option><option value={30}>30 dias</option><option value={90}>90 dias</option><option value={365}>1 ano</option>
          </select>
        </div>
        {conectado && (
          <div className="p-2 flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
            <input value={novo} onChange={(e) => setNovo(e.target.value)} placeholder="Nova conversa: (15) 99999-0000"
              className="text-sm rounded border px-2 py-1 flex-1" style={card} />
            <button className="pa-btn" onClick={() => { const n = novo.replace(/\D/g, ''); if (n) setChat({ chat: n, nome: novo, novo: true }); }}>Abrir</button>
          </div>
        )}
        <div className="overflow-y-auto" style={{ maxHeight: 600 }}>
          {!lista.length && <div className="p-4 text-sm opacity-60">{dias ? 'Nenhuma conversa neste período. Escolha "tudo" para ver o histórico importado do celular.' : 'Nenhuma conversa gravada ainda. Ao parear pelo QR code, o celular manda o histórico e ele aparece aqui.'}</div>}
          {lista.map((c) => (
            <button key={c.chat} type="button" onClick={() => setChat(c)}
              className="w-full text-left px-3 py-2 border-b text-sm"
              style={{ borderColor: 'var(--border)', background: chat?.chat === c.chat ? 'var(--menu-hover)' : 'transparent' }}>
              <div className="flex items-center gap-2">
                <b className="truncate">{c.grupo ? '👥 ' : ''}{c.nome || telefone(c.chat)}</b>
                <span className="ml-auto text-[11px] opacity-60 whitespace-nowrap">{fmt(c.ultima_em, true)}</span>
              </div>
              {c.nome && !c.grupo && <div className="text-[11px] opacity-60">{telefone(c.chat)}</div>}
              <div className="text-xs opacity-70 truncate">{c.ultima_de_mim ? 'Você: ' : ''}{resumo(c.ultimo_tipo, c.ultimo_texto)}</div>
              {c.erros > 0 && <div className="text-[11px]" style={{ color: 'var(--danger)' }}>{c.erros} envio(s) com erro</div>}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col">
        {!chat ? (
          <div className="m-auto text-sm opacity-60 flex items-center gap-2"><MessageCircle size={18} /> Escolha uma conversa.</div>
        ) : (
          <>
            <div className="px-4 py-2 border-b text-sm" style={{ borderColor: 'var(--border)' }}>
              <b>{chat.nome || telefone(chat.chat)}</b> <span className="opacity-60">{chat.novo ? '' : telefone(chat.chat)}</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2" style={{ maxHeight: 520 }}>
              {!msgs.length && <div className="text-sm opacity-60">Sem mensagens gravadas.</div>}
              {msgs.map((m) => (
                <div key={m.id} className={`flex ${m.de_mim ? 'justify-end' : 'justify-start'}`}>
                  <div className="rounded-lg px-3 py-2 text-sm max-w-[75%]"
                    style={{ background: m.de_mim ? 'color-mix(in srgb, var(--success) 14%, var(--card))' : 'var(--menu-hover)' }}>
                    {!m.de_mim && chat.grupo && <div className="text-[11px] font-semibold opacity-70">{m.remetente_nome || m.remetente}</div>}
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{resumo(m.tipo, m.texto)}</div>
                    <Anexo m={m} />
                    <div className="text-[10px] opacity-60 mt-1 text-right">
                      {m.origem === 'sistema' ? (m.enviado_por ? `pelo SURE (${m.enviado_por}) · ` : 'aviso automático do SURE · ') : ''}
                      {fmt(m.enviada_em)}
                      {m.status_envio === 'erro' && <span style={{ color: 'var(--danger)' }}> · não enviada: {m.erro}</span>}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={fimRef} />
            </div>
            {conectado && !chat.grupo && (
              <div className="p-2 border-t flex gap-2" style={{ borderColor: 'var(--border)' }}>
                <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={2} placeholder="Responder pelo WhatsApp da empresa…"
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(chat.chat, texto, setTexto); } }}
                  className="flex-1 text-sm rounded border px-2 py-1" style={card} />
                <input ref={arquivoRef} type="file" className="hidden" onChange={(e) => enviarArquivo(chat.chat, e.target.files?.[0])}
                  accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip" />
                <button className="pa-btn" type="button" disabled={enviando} title="Enviar arquivo (o texto digitado vai como legenda)"
                  onClick={() => arquivoRef.current?.click()}>
                  <Paperclip size={14} />
                </button>
                <button className="pa-btn" disabled={enviando || !texto.trim()} onClick={() => enviar(chat.chat, texto, setTexto)}>
                  <Send size={14} /> Enviar
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
    </div>
  );
}

// ── Grupo dos avisos ─────────────────────────────────────────────────────────
// Os avisos das tarefas (protocolos ANEEL) saem pelo número do departamento neste grupo, onde está a equipe.
function GrupoAvisos({ conectado, onErro }) {
  const [dados, setDados] = useState({ grupos: [], grupo_avisos: '' });
  const [carregando, setCarregando] = useState(false);
  const [salvo, setSalvo] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try { const { data } = await api.get('/whatsapp/grupos'); setDados({ grupos: data?.grupos || [], grupo_avisos: data?.grupo_avisos || '', erro: data?.erro }); }
    catch (e) { onErro(e?.response?.data?.error || 'Falha ao carregar os grupos.'); }
    finally { setCarregando(false); }
  }, [onErro]);
  useEffect(() => { carregar(); }, [carregar, conectado]);

  const escolher = async (jid) => {
    try {
      await api.post('/whatsapp/grupo-avisos', { jid });
      setDados((d) => ({ ...d, grupo_avisos: jid })); setSalvo(true); setTimeout(() => setSalvo(false), 3000);
    } catch (e) { onErro(e?.response?.data?.error || 'Falha ao salvar.'); }
  };
  const testar = async () => {
    try { await api.post('/whatsapp/enviar', { para: dados.grupo_avisos, texto: '🔔 SURE — teste: os avisos das tarefas vão chegar neste grupo.' }); }
    catch (e) { onErro(e?.response?.data?.error || 'Falha ao enviar o teste.'); }
  };

  const escolhido = dados.grupos.find((g) => g.jid === dados.grupo_avisos);
  return (
    <div className="rounded-xl border p-4 space-y-3" style={card}>
      <p className="text-sm">
        Cada tarefa nova dos protocolos ANEEL (e cada tarefa direcionada) vira uma mensagem neste grupo, enviada pelo número do
        departamento — todos do grupo recebem a notificação. O aviso na tela do SURE continua igual.
      </p>
      {!conectado && <p className="text-sm" style={{ color: 'var(--warning)' }}>Conecte o WhatsApp para ver a lista de grupos.</p>}
      {dados.erro && conectado && <p className="text-xs" style={{ color: 'var(--danger)' }}>{dados.erro}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <select value={dados.grupo_avisos} onChange={(e) => escolher(e.target.value)} disabled={!conectado && !dados.grupo_avisos}
          className="text-sm rounded border px-2 py-1 min-w-[280px]" style={card}>
          <option value="">— nenhum (avisos só na tela) —</option>
          {dados.grupo_avisos && !escolhido && <option value={dados.grupo_avisos}>Grupo escolhido ({dados.grupo_avisos.split('@')[0]})</option>}
          {dados.grupos.map((g) => <option key={g.jid} value={g.jid}>{g.nome || g.jid} · {g.participantes} pessoas</option>)}
        </select>
        <button className="pa-btn" disabled={carregando} onClick={carregar}><RefreshCw size={14} /> Recarregar grupos</button>
        {dados.grupo_avisos && conectado && <button className="pa-btn" onClick={testar}>Mandar teste no grupo</button>}
        {salvo && <span className="text-xs" style={{ color: 'var(--success)' }}>salvo</span>}
      </div>
      <p className="text-xs opacity-60">O grupo precisa já existir no WhatsApp com o número do departamento dentro (crie pelo celular, se ainda não houver).</p>
    </div>
  );
}

export default function WhatsappEmpresa() {
  const { user } = useAuth();
  const isAdmin = String(user?.tipo_conta || user?.role || user?.perfil || '').trim().toLowerCase() === 'admin';
  const [estado, setEstado] = useState(null);
  const [aba, setAba] = useState('insights');
  const [chatInicial, setChatInicial] = useState(null);
  const abrirConversa = useCallback((c) => { setChatInicial({ chat: c.chat, nome: c.nome, t: Date.now() }); setAba('conversas'); }, []);
  const [erro, setErro] = useState('');
  const onErro = useCallback((m) => { setErro(m); setTimeout(() => setErro(''), 6000); }, []);

  const carregarEstado = useCallback(async () => {
    try { const { data } = await api.get('/whatsapp/estado'); setEstado(data); }
    catch (e) { onErro(e?.response?.data?.error || 'Falha ao ler o estado do WhatsApp.'); }
  }, [onErro]);
  // enquanto o QR está na tela, confere a cada 2s (para sumir assim que escanear)
  useEffect(() => {
    carregarEstado();
    const t = setInterval(carregarEstado, estado?.qr ? 2000 : 15000);
    return () => clearInterval(t);
  }, [carregarEstado, estado?.qr]);

  return (
    <div className="p-4 md:p-6 space-y-4 w-full">
      <div className="flex items-center gap-2">
        <MessageCircle size={22} />
        <h1 className="text-xl font-semibold">WhatsApp do departamento</h1>
        <button className="pa-btn ml-auto" onClick={carregarEstado}><RefreshCw size={14} /> Atualizar</button>
      </div>
      {erro && <div className="rounded border px-3 py-2 text-sm" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>{erro}</div>}

      <Conexao estado={estado} isAdmin={isAdmin} onAtualizar={setEstado} onErro={onErro} />

      <div className="flex gap-2">
        {[['insights', 'Insights'], ['conversas', 'Conversas'], ...(isAdmin ? [['avisos', 'Grupo dos avisos']] : [])].map(([k, l]) => (
          <button key={k} onClick={() => setAba(k)} className="text-sm px-3 py-1.5 rounded-lg"
            style={aba === k ? { background: 'var(--accent)', color: '#fff' } : { background: 'var(--card)', border: '1px solid var(--border)' }}>
            {l}
          </button>
        ))}
      </div>
      {aba === 'insights' && <WhatsappInsights onAbrirConversa={abrirConversa} onErro={onErro} />}
      {aba === 'conversas' && <Conversas conectado={!!estado?.conectado} inicial={chatInicial} onErro={onErro} isAdmin={isAdmin} />}
      {aba === 'avisos' && isAdmin && <GrupoAvisos conectado={!!estado?.conectado} onErro={onErro} />}
    </div>
  );
}
