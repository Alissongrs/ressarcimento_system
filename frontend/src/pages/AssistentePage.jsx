// src/pages/AssistentePage.jsx
// Chat em tela cheia do perfil SOLICITANTE. Consulta processos/requisições,
// relatório de cliente e tempo médio — com a regra de cautela do valor embutida
// no backend (valor/data só quando o deferimento está preenchido). Visual do
// piloto aprovado. Entendimento: chips + número/nome digitados (determinístico);
// frases livres serão roteadas ao worker (claude -p) numa etapa seguinte.
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Send, Loader2, CheckCircle2, Lock, Clock, FileText, Undo2, Download, History, Plus, Trash2, X } from 'lucide-react';
import * as XLSX from 'xlsx';
import { useAuth } from '../context/AuthContext.jsx';
import { consultarProcesso, relatorioCliente, tempoMedioConcessionaria, listaProcessos } from '../services/assistenteService';
import api from '../services/apiClient';

const DISPLAY = "'Space Grotesk', 'Inter', sans-serif";

const fmtBRL = (v) => {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};
const fmtDate = (s) => {
  if (!s) return '—';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s);
};
const formaEmoji = (f) => {
  const k = String(f || '').toLowerCase();
  if (k.startsWith('fat')) return '📄';
  if (k.startsWith('dep')) return '🏦';
  if (k === 'gd') return '⚡';
  return '•';
};

let MID = 0;
const mkId = () => `m${++MID}`;

const SESS_KEY = 'sure_asst_sessao';
const CARD = '§card§';
// mensagem da tela → linha do histórico de conversas
function serializarMsg(m) {
  if (m.role === 'me') return { role: 'user', conteudo: String(m.text || '') };
  if (m.type === 'text') return { role: 'assistant', conteudo: String(m.text || '') };
  if (m.type === 'chips' || !m.type) return null;
  let data = m.data || {};
  if (m.type === 'pedido') data = { id: data.id };                          // recarrega do pedido ao abrir
  if (m.type === 'lista') data = { ...data, linhas: (data.linhas || []).slice(0, 300) };
  return { role: 'assistant', conteudo: CARD + JSON.stringify({ type: m.type, data }) };
}
function desserializarMsg(x) {
  const id = `h${x.id}`;
  const c = String(x.content || '');
  if (x.role === 'user') return { id, role: 'me', type: 'text', text: c };
  if (c.startsWith(CARD)) {
    try { const o = JSON.parse(c.slice(CARD.length)); return { id, role: 'bot', type: o.type, data: o.data }; } catch { return null; }
  }
  return { id, role: 'bot', type: 'text', text: c };
}

const AssistentePage = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const firstName = String(user?.nome || '').trim().split(' ')[0] || 'por aqui';

  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // 'processo' | 'cliente' | 'tempo' | 'lista' | null
  const scrollRef = useRef(null);
  const taRef = useRef(null);

  // auto-grow do textarea (cresce com o conteúdo, até um teto; depois rola)
  const autoGrow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };
  useEffect(() => { autoGrow(); }, [input]);

  const push = (m) => setMsgs((prev) => [...prev, { id: mkId(), ...m }]);

  // ── Histórico de conversas (o MESMO do chat do admin/analista: /chat/conversas, 90 dias) ──
  // Texto vai como texto; cartões (processo, resumo, relatório) vão como "§card§{json}" e voltam
  // iguais ao retomar — o cartão de relatório guarda só o nº do pedido e recarrega o resultado.
  const sessaoRef = useRef(null);
  const logadosRef = useRef(new Set());
  const [convOpen, setConvOpen] = useState(false);
  const [conversas, setConversas] = useState(null);
  const garantirSessao = () => {
    if (!sessaoRef.current) {
      sessaoRef.current = `asst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      try { sessionStorage.setItem(SESS_KEY, sessaoRef.current); } catch { /* ignore */ }
    }
    return sessaoRef.current;
  };
  const saudacao = () => [
    { id: mkId(), noLog: true, role: 'bot', type: 'text', text: `Olá, ${firstName}! 👋 Posso te ajudar a consultar **processos** e **requisições** para você repassar ao cliente.` },
    { id: mkId(), noLog: true, role: 'bot', type: 'chips' },
  ];
  useEffect(() => {
    msgs.forEach((m) => {
      if (m.noLog || logadosRef.current.has(m.id)) return;
      const sr = serializarMsg(m);
      if (!sr || !sr.conteudo.trim()) return;
      logadosRef.current.add(m.id);
      api.post('/chat/conversas/msg', { sessao: garantirSessao(), role: sr.role, conteudo: sr.conteudo, modo: 'assistente' })
        .catch(() => { /* offline: segue */ });
    });
  }, [msgs]);
  const carregarConversas = async () => {
    setConversas(null);
    try {
      const { data } = await api.get('/chat/conversas');
      setConversas(data?.conversas || []);
    } catch { setConversas([]); }
  };
  const abrirConversa = async (sessao) => {
    try {
      const { data } = await api.get(`/chat/conversas/${encodeURIComponent(sessao)}`);
      const lista = (data?.mensagens || []).map(desserializarMsg).filter(Boolean);
      lista.forEach((m) => logadosRef.current.add(m.id));
      sessaoRef.current = sessao;
      try { sessionStorage.setItem(SESS_KEY, sessao); } catch { /* ignore */ }
      setMsgs(lista.length ? lista : saudacao());
      setConvOpen(false);
      lista.filter((m) => m.type === 'pedido' && m.data?.id).forEach((m) => acompanharPedido(m.id, m.data.id, true));
    } catch { push({ role: 'bot', type: 'text', text: 'Não consegui abrir essa conversa.' }); }
  };
  const novaConversa = () => {
    sessaoRef.current = null;
    try { sessionStorage.removeItem(SESS_KEY); } catch { /* ignore */ }
    logadosRef.current = new Set();
    setMsgs(saudacao());
    setConvOpen(false);
  };
  const excluirConversa = async (sessao, e) => {
    if (e) e.stopPropagation();
    try {
      await api.delete(`/chat/conversas/${encodeURIComponent(sessao)}`);
      setConversas((cv) => (cv || []).filter((x) => x.sessao !== sessao));
      if (sessao === sessaoRef.current) novaConversa();
    } catch { /* ignore */ }
  };

  useEffect(() => {
    // volta na conversa aberta desta aba (F5 não perde nada); senão começa uma nova
    let s = null;
    try { s = sessionStorage.getItem(SESS_KEY); } catch { /* ignore */ }
    if (s) abrirConversa(s); else setMsgs(saudacao());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, busy]);

  const askFor = (intent) => {
    setPending(intent);
    const prompt = intent === 'processo'
      ? 'Qual o **número do processo** ou da requisição?'
      : intent === 'cliente'
        ? 'Qual **cliente**? (pode ser parte do nome)'
        : intent === 'lista'
          ? 'Qual lista você quer? Ex.: **processos da CLARO com deferimento em 2026**'
          : 'De qual **concessionária**?';
    push({ role: 'bot', type: 'text', text: prompt });
  };

  const run = async (intent, arg) => {
    setBusy(true);
    try {
      if (intent === 'processo') {
        const data = await consultarProcesso(arg);
        push({ role: 'bot', type: 'processo', data });
      } else if (intent === 'cliente') {
        const data = await relatorioCliente(arg);
        if (!data?.encontrado) { await enviarPedido(arg); return; } // não achou cliente → vira pedido de relatório
        push({ role: 'bot', type: 'cliente', data });
      } else if (intent === 'tempo') {
        const data = await tempoMedioConcessionaria(arg);
        push({ role: 'bot', type: 'tempo', data });
      } else if (intent === 'lista') {
        const data = await listaProcessos(arg);
        if (!data?.encontrado) { await enviarPedido(arg); return; }
        push({ role: 'bot', type: 'lista', data });
      } else if (intent === 'pedido') {
        await enviarPedido(arg);
      }
    } catch {
      push({ role: 'bot', type: 'text', text: 'Não consegui consultar agora. Tente novamente em instantes.' });
    } finally {
      setBusy(false);
    }
  };

  // Pedido de RELATÓRIO livre (mesmo caminho do chat do admin): vira FT_SOLICITACOES —
  // relatório da lista pronta roda na hora, o resto vai p/ o worker; consulta não passa por
  // aprovação e o perfil solicitante só pode ler (o servidor barra alteração). O card
  // acompanha o pedido até ficar pronto e oferece Excel/Word/PDF.
  const atualizar = (mid, patch) => setMsgs((prev) => prev.map((m) => (m.id === mid ? { ...m, data: { ...m.data, ...patch } } : m)));
  const enviarPedido = async (text) => {
    let resp;
    try {
      ({ data: resp } = await api.post('/solicitacoes', { mensagem: text }));
    } catch (e) {
      const msg = e?.response?.data?.error || 'Não consegui registrar o pedido agora. Tente novamente em instantes.';
      push({ role: 'bot', type: 'text', text: msg });
      return;
    }
    const mid = mkId();
    setMsgs((prev) => [...prev, { id: mid, role: 'bot', type: 'pedido', data: { id: resp?.id, status: resp?.status || 'pendente' } }]);
    acompanharPedido(mid, resp?.id, false);
  };

  // acompanha um pedido até ficar pronto (também ao retomar uma conversa antiga: 1ª leitura já)
  const acompanharPedido = (mid, pid, jaAgora) => {
    const inicio = Date.now();
    const tick = async () => {
      try {
        const { data } = await api.get('/solicitacoes', { params: { mine: 1 } });
        const s = (data?.data || []).find((x) => String(x.id) === String(pid));
        if (s) {
          const res = String(s.resultado || '');
          const fim = ['executado', 'erro', 'preciso_confirmar', 'rejeitado'].includes(s.status) || /^requer /i.test(res);
          atualizar(mid, { status: s.status, resultado: res, perguntas: s.perguntas_json });
          if (fim) return;
        }
      } catch { /* tenta de novo */ }
      if (Date.now() - inicio < 15 * 60 * 1000) setTimeout(tick, 6000);
      else atualizar(mid, { demorou: true });
    };
    setTimeout(tick, jaAgora ? 0 : 3000);
  };

  const detect = (text) => {
    const t = text.toLowerCase();
    // 2+ números de processo → relatório desses processos (pedido)
    const nums = text.match(/\b\d{4,7}\b/g) || [];
    if (nums.length >= 2) return { intent: 'pedido', arg: text.trim() };
    // pedido elaborado (histórico, abas, por mês, protocolos, várias condições) → relatório
    // completo pelo sistema; as consultas rápidas abaixo só cobrem perguntas curtas.
    if (t.split(/\s+/).length > 14 || /hist[óo]ric|\babas?\b|por m[eê]s|por empresa|protocolo|movimenta|etapa|status|instân|instan/.test(t)) {
      return { intent: 'pedido', arg: text.trim() };
    }
    // Lista / Excel: a frase inteira vai pro servidor, que acha cliente, ano e se é só deferidos.
    // Relatório / planilha / Excel / lista → relatório COMPLETO do sistema (mesma visão do
    // controle de processos, com a regra de valor do solicitante aplicada no servidor). Só filtra
    // o que a pessoa pedir. O card de resumo rápido fica para quem pede "resumo".
    if (/excel|planilha|lista|listar|relat[óo]rio|todos\s+(os\s+)?processos|\.xlsx/.test(t) && !/\bresumo\b/.test(t)) {
      return { intent: 'pedido', arg: text.trim() };
    }
    if (/resumo|cliente/.test(t)) {
      // a frase inteira também: o servidor reconhece o nome cadastrado dentro dela
      const nome = text.replace(/.*?(relat[óo]rio|cliente)\s*(d[eoa]s?\s+)?/i, '').trim();
      return { intent: 'cliente', arg: nome ? text.trim() : null };
    }
    if (/tempo|m[ée]dia|m[ée]dio|concession|distribuidora/.test(t)) {
      const conc = text.replace(/.*?(concession\w*|distribuidora)\s*/i, '').replace(/tempo m[ée]dio|m[ée]dia|de defer\w*/gi, '').trim();
      return { intent: 'tempo', arg: conc || null };
    }
    const num = text.match(/#?\s*(\d{3,})/);
    if (num && t.split(/\s+/).length <= 6) {
      return { intent: 'processo', arg: num[1] };
    }
    if (/^\s*(o\s+)?(processo|requisi\w*)\s*$/.test(t)) return { intent: 'processo', arg: null };
    // qualquer outra pergunta/pedido → relatório pelo sistema (como no chat do admin)
    return { intent: 'pedido', arg: text.trim() };
  };

  const submit = (raw) => {
    const text = String(raw ?? input).trim();
    if (!text || busy) return;
    push({ role: 'me', type: 'text', text });
    setInput('');

    if (pending) {
      const intent = pending;
      setPending(null);
      run(intent, text);
      return;
    }
    const { intent, arg } = detect(text);
    if (!intent) {
      push({ role: 'bot', type: 'text', text: 'Não entendi 🤔. Escolha uma opção:' });
      push({ role: 'bot', type: 'chips' });
      return;
    }
    if (intent === 'pedido') { run('pedido', arg); return; }
    if (!arg) { askFor(intent); return; }
    run(intent, arg);
  };

  const onChip = (intent) => { if (!busy) askFor(intent); };

  return (
    <div className="asst">
      <div className="asst-head">
        <div className="asst-av">✦</div>
        <div>
          <div className="asst-nm">Assistente SURE</div>
          <div className="asst-st"><span className="asst-pulse" /> online</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" className="asst-chip" onClick={novaConversa} title="Começar uma conversa nova (a atual fica no histórico)"><Plus size={14} /> Nova conversa</button>
          <button type="button" className="asst-chip" onClick={() => { setConvOpen(true); carregarConversas(); }} title="Conversas anteriores"><History size={14} /> Conversas</button>
        </div>
      </div>

      {convOpen && (
        <div className="asst-conv" role="dialog" aria-label="Conversas anteriores">
          <div className="asst-conv-h">
            <b>Conversas anteriores</b>
            <button type="button" className="asst-conv-x" onClick={() => setConvOpen(false)} aria-label="Fechar"><X size={16} /></button>
          </div>
          {conversas === null && <div className="asst-conv-v"><Loader2 size={14} className="asst-spin" /> carregando…</div>}
          {conversas && conversas.length === 0 && <div className="asst-conv-v">Nenhuma conversa ainda.</div>}
          {(conversas || []).map((cv) => (
            <div key={cv.sessao} className={`asst-conv-i${cv.sessao === sessaoRef.current ? ' on' : ''}`} onClick={() => abrirConversa(cv.sessao)} role="button" tabIndex={0}>
              <div className="t">{cv.titulo || cv.primeira || 'Conversa'}</div>
              <div className="d">{cv.fim}{cv.qtd ? ` · ${cv.qtd} mensagens` : ''}</div>
              <button type="button" className="asst-conv-del" title="Excluir" onClick={(e) => excluirConversa(cv.sessao, e)}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}

      <div className="asst-msgs" ref={scrollRef}>
        {msgs.map((m) => (
          <Bubble key={m.id} m={m} onChip={onChip} navigate={navigate} />
        ))}
        {busy && (
          <div className="asst-row">
            <div className="asst-bav">✦</div>
            <div className="asst-bub asst-bot asst-typing"><Loader2 size={15} className="asst-spin" /> consultando…</div>
          </div>
        )}
      </div>

      <form className="asst-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="asst-inbar">
          <textarea
            ref={taRef}
            className="asst-inp"
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
            placeholder="Pergunte sobre um processo, requisição ou cliente…"
            autoFocus
          />
          <button type="submit" className="asst-snd" disabled={busy || !input.trim()} aria-label="Enviar">
            <Send size={18} />
          </button>
        </div>
      </form>

      <style>{STYLE}</style>
    </div>
  );
};

function Bubble({ m, onChip, navigate }) {
  if (m.role === 'me') {
    return (
      <div className="asst-row me">
        <div className="asst-bub asst-me">{m.text}</div>
      </div>
    );
  }
  return (
    <div className="asst-row">
      <div className="asst-bav">✦</div>
      <div className="asst-bub asst-bot">
        {m.type === 'text' && <MD text={m.text} />}
        {m.type === 'chips' && (
          <div className="asst-chips">
            <button type="button" className="asst-chip" onClick={() => onChip('processo')}><FileText size={14} /> Movimentações de um processo</button>
            <button type="button" className="asst-chip" onClick={() => onChip('tempo')}><Clock size={14} /> Tempo médio de deferimento</button>
            <button type="button" className="asst-chip" onClick={() => onChip('cliente')}><Mail size={14} /> Relatório de um cliente</button>
            <button type="button" className="asst-chip" onClick={() => onChip('lista')}><Download size={14} /> Lista de processos em Excel</button>
          </div>
        )}
        {m.type === 'processo' && <ProcessoCard d={m.data} navigate={navigate} />}
        {m.type === 'cliente' && <ClienteCard d={m.data} />}
        {m.type === 'tempo' && <TempoCard d={m.data} />}
        {m.type === 'lista' && <ListaCard d={m.data} />}
        {m.type === 'pedido' && <PedidoCard d={m.data} />}
      </div>
    </div>
  );
}

// Markdown minimalista (apenas **negrito**).
function MD({ text }) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return <>{parts.map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : <span key={i}>{p}</span>))}</>;
}

function ProcessoCard({ d, navigate }) {
  if (!d?.encontrado) {
    return <MD text={`Não encontrei o processo **${d?.consulta || ''}**. Confira o número ou o protocolo.`} />;
  }
  const deferido = !!d.valor_liberado;
  const dev = d.devolucao || {};
  return (
    <>
      <MD text={deferido ? 'Encontrei o processo abaixo. ✅ **Deferido** — pode informar o valor e a forma ao cliente.' : 'Encontrei o processo. Mostro o andamento, mas **ainda não há valor/data para informar ao cliente**.'} />
      <div className="asst-card">
        <div className="asst-ch">
          <span className="asst-pn">Processo #{d.codigo_publico || d.id_processo}</span>
          <span className={`asst-badge ${deferido ? 'def' : d.indeferido ? 'ind' : 'and'}`}>
            {deferido ? 'DEFERIDO' : d.indeferido ? 'INDEFERIDO' : (d.etapa_atual || 'EM ANÁLISE')}
          </span>
        </div>
        <div className="asst-cb">
          {d.cliente && <div className="asst-kv"><span className="k">Cliente</span><span className="v">{d.cliente}</span></div>}
          {d.concessionaria && <div className="asst-kv"><span className="k">Concessionária</span><span className="v">{d.concessionaria}</span></div>}

          {Array.isArray(d.movimentacoes) && d.movimentacoes.length > 0 && (
            <ul className="asst-tl">
              {d.movimentacoes.map((mv, i) => (
                <li key={i}><b>{mv.etapa || 'Movimentação'}</b>{mv.comentario ? ` — ${mv.comentario}` : ''}<div className="dt">{fmtDate(mv.data)}</div></li>
              ))}
            </ul>
          )}

          {deferido ? (
            <div className="asst-vbox ok">
              <CheckCircle2 size={18} />
              <div>
                <div className="t ok">Valor deferido — liberado</div>
                <div className="big">{fmtBRL(d.valor)}</div>
                <div className="sub">Data do deferimento: <b>{fmtDate(d.data_deferimento)}</b></div>
              </div>
            </div>
          ) : (
            <div className="asst-vbox lock">
              <Lock size={18} />
              <div>
                <div className="t lock">Valor ainda não disponível</div>
                <div className="sub">O processo não tem deferimento confirmado. Não informe valor nem prazo ao cliente até o deferimento sair.</div>
              </div>
            </div>
          )}

          {dev.realizada && (
            <>
              <div className="asst-kv" style={{ marginTop: 10 }}><span className="k">Forma de devolução</span><span className="v">{formaEmoji(dev.forma)} {dev.forma}</span></div>
              {dev.data_devolucao && <div className="asst-kv"><span className="k">Devolvido em</span><span className="v">{fmtDate(dev.data_devolucao)}</span></div>}
              {dev.tempo_comprovante_dias != null && (
                <div className="asst-kv"><span className="k">Tempo de envio do comprovante</span><span className="v" style={{ color: '#2DD4BF' }}>{dev.tempo_comprovante_dias} dias</span></div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function ClienteCard({ d }) {
  if (!d?.encontrado) return <MD text={`Não encontrei processos do cliente **${d?.cliente || ''}**.`} />;
  return (
    <>
      <MD text={`Resumo de **${d.cliente}** (valores só de processos deferidos):`} />
      <div className="asst-card">
        <div className="asst-ch">
          <span className="asst-pn">Cliente — {d.cliente}</span>
          {d.tempo_medio_deferimento_dias != null && <span className="asst-badge def">⏱️ média {d.tempo_medio_deferimento_dias} dias</span>}
        </div>
        <div className="asst-cb">
          <table className="asst-tbl">
            <tbody>
              <tr><th>Situação</th><th className="num">Qtd.</th></tr>
              <tr><td>Deferidos</td><td className="num">{d.deferidos}</td></tr>
              <tr><td>Em análise</td><td className="num">{d.em_analise}</td></tr>
              <tr><td>Indeferidos</td><td className="num">{d.indeferidos}</td></tr>
              <tr className="sum"><td>Total</td><td className="num">{d.total_processos}</td></tr>
            </tbody>
          </table>
          <div className="asst-vbox ok" style={{ marginTop: 12 }}>
            <CheckCircle2 size={18} />
            <div>
              <div className="t ok">Valor total deferido</div>
              <div className="big">{fmtBRL(d.valor_total_deferido)}</div>
            </div>
          </div>
          {(d.tempo_medio_deferimento_dias != null || d.tempo_medio_comprovante_dias != null) && (
            <div className="asst-vbox ok" style={{ marginTop: 10 }}>
              <Clock size={18} />
              <div>
                {d.tempo_medio_deferimento_dias != null && <div className="sub">Tempo médio até o deferimento: <b style={{ color: '#eafff9' }}>{d.tempo_medio_deferimento_dias} dias</b></div>}
                {d.tempo_medio_comprovante_dias != null && <div className="sub"><Undo2 size={12} style={{ display: 'inline', verticalAlign: '-1px' }} /> Tempo médio de envio do comprovante: <b style={{ color: '#eafff9' }}>{d.tempo_medio_comprovante_dias} dias</b></div>}
              </div>
            </div>
          )}
          {Array.isArray(d.formas) && d.formas.length > 0 && (
            <div className="asst-kv" style={{ marginTop: 10 }}>
              <span className="k">Formas de devolução</span>
              <span className="v">{d.formas.map((f) => `${formaEmoji(f.forma)} ${f.forma} (${f.qtd})`).join(' · ')}</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function baixarExcel(d) {
  const linhas = (d.linhas || []).map((l) => ({
    'Nº do Processo': l.processo,
    UC: l.uc,
    Cliente: l.cliente,
    Concessionária: l.concessionaria,
    Irregularidade: l.irregularidade,
    'Etapa atual': l.etapa,
    'Instância do deferimento': l.instancia,
    'Data do deferimento': fmtDate(l.data_deferimento),
    'Valor deferido (R$)': l.valor != null ? Number(l.valor) : null,
  }));
  const ws = XLSX.utils.json_to_sheet(linhas);
  ws['!cols'] = [16, 14, 22, 22, 22, 16, 18, 16, 18].map((w) => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Processos');
  const nome = `processos_${String(d.cliente || 'cliente').replace(/\W+/g, '_').toLowerCase()}${d.so_deferidos ? '_deferidos' : ''}${d.ano ? `_${d.ano}` : ''}.xlsx`;
  XLSX.writeFile(wb, nome);
}

// 1ª tabela markdown do resultado (a prévia; o Excel traz todas as abas).
function tabelaMD(txt) {
  let titulo = '', header = null; const rows = [];
  for (const ln of String(txt || '').split('\n')) {
    const t = ln.trim();
    if (!t) continue;
    if (t.startsWith('### ')) { if (header) break; continue; }
    if (t.startsWith('|')) {
      const cells = t.replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (!header) header = cells; else rows.push(cells);
    } else if (!titulo && !header) titulo = t;
  }
  return { titulo, header, rows };
}

async function baixarPedido(id, formato, ext) {
  try {
    const resp = await api.get(`/solicitacoes/${id}/export`, { params: { formato }, responseType: 'blob' });
    const url = URL.createObjectURL(resp.data);
    const a = document.createElement('a');
    a.href = url; a.download = `relatorio_sure_${id}.${ext}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch { /* sem tabela p/ este formato */ }
}

function PedidoCard({ d }) {
  const pronto = d.status === 'executado';
  const res = String(d.resultado || '');
  if (!pronto) {
    if (d.status === 'erro' || /^requer /i.test(res)) {
      return <MD text={`Não consegui montar esse relatório sozinho (pedido **#${d.id}**). A equipe foi avisada e vai te responder por aqui.`} />;
    }
    if (d.status === 'preciso_confirmar') {
      let pergs = [];
      try { pergs = JSON.parse(d.perguntas || '[]'); } catch { /* */ }
      const lista = pergs.map((p) => (typeof p === 'string' ? p : p?.pergunta || '')).filter(Boolean);
      return <MD text={`Para montar o pedido **#${d.id}** preciso saber: ${lista.join(' · ') || 'um detalhe — escreva de novo com mais informações'}.`} />;
    }
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Loader2 size={15} className="asst-spin" />
        <MD text={d.demorou ? `Seu pedido **#${d.id}** está demorando mais que o normal — ele continua na fila.` : `Preparando seu relatório (pedido **#${d.id}**)…`} />
      </div>
    );
  }
  const tab = tabelaMD(res);
  const temTabela = tab.header && tab.rows.length > 0;
  const prev = tab.rows.slice(0, 8);
  const resumo = (tab.titulo || '').replace(/^📊\s*/, '') || (res.split('\n')[0] || '').slice(0, 300);
  return (
    <>
      <MD text={resumo} />
      {temTabela && (
        <div className="asst-card">
          <div className="asst-cb" style={{ overflowX: 'auto' }}>
            <table className="asst-tbl">
              <tbody>
                <tr>{tab.header.slice(0, 6).map((h, i) => <th key={i}>{h}</th>)}</tr>
                {prev.map((r, i) => <tr key={i}>{r.slice(0, 6).map((c, j) => <td key={j}>{c}</td>)}</tr>)}
                {tab.rows.length > prev.length && <tr><td colSpan={6} style={{ opacity: 0.7 }}>… e mais {tab.rows.length - prev.length} no Excel</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="asst-chips" style={{ marginTop: 10 }}>
        {temTabela && <button type="button" className="asst-chip" onClick={() => baixarPedido(d.id, 'excel', 'xlsx')}><Download size={14} /> Excel</button>}
        <button type="button" className="asst-chip" onClick={() => baixarPedido(d.id, 'word', 'doc')}><FileText size={14} /> Word</button>
        <button type="button" className="asst-chip" onClick={() => baixarPedido(d.id, 'pdf', 'pdf')}><FileText size={14} /> PDF</button>
      </div>
    </>
  );
}

function ListaCard({ d }) {
  if (!d?.encontrado) {
    return <MD text="Não identifiquei o **cliente** na sua frase. Escreva o nome como está no sistema (ex.: processos da CLARO com deferimento em 2026 em Excel)." />;
  }
  const filtro = `${d.so_deferidos ? 'com deferimento' : 'todos os processos'}${d.ano ? (d.so_deferidos ? ` em ${d.ano}` : ` criados em ${d.ano}`) : ''}`;
  if (!d.total) return <MD text={`**${d.cliente}** — nenhum processo ${filtro}.`} />;
  const prev = (d.linhas || []).slice(0, 8);
  return (
    <>
      <MD text={`**${d.cliente}** — ${filtro}: **${d.total}** processo(s).`} />
      <div className="asst-card">
        <div className="asst-cb">
          <table className="asst-tbl">
            <tbody>
              <tr><th>Processo</th><th>Concessionária</th><th>Deferimento</th><th className="num">Valor</th></tr>
              {prev.map((l, i) => (
                <tr key={i}><td>{l.processo}</td><td>{l.concessionaria}</td><td>{fmtDate(l.data_deferimento)}</td><td className="num">{fmtBRL(l.valor)}</td></tr>
              ))}
              {d.total > prev.length && <tr><td colSpan={4} style={{ opacity: 0.7 }}>… e mais {d.total - prev.length} no Excel</td></tr>}
              {d.so_deferidos && <tr className="sum"><td colSpan={3}>Valor total deferido</td><td className="num">{fmtBRL(d.valor_total)}</td></tr>}
            </tbody>
          </table>
          <button type="button" className="asst-chip" style={{ marginTop: 12 }} onClick={() => baixarExcel(d)}>
            <Download size={14} /> Baixar Excel ({d.total} linhas)
          </button>
        </div>
      </div>
    </>
  );
}

function TempoCard({ d }) {
  return (
    <>
      <MD text={`Tempo médio de deferimento — **${d.concessionaria}**:`} />
      <div className="asst-card">
        <div className="asst-cb">
          <div className="asst-vbox ok">
            <Clock size={18} />
            <div>
              <div className="t ok">Tempo médio de deferimento</div>
              <div className="big">{d.tempo_medio_deferimento_dias != null ? `${d.tempo_medio_deferimento_dias} dias` : 'sem dados'}</div>
              {d.amostra != null && <div className="sub">base: {d.amostra} processo(s) deferido(s)</div>}
            </div>
          </div>
          {(d.min_dias != null || d.max_dias != null) && (
            <>
              <div className="asst-kv" style={{ marginTop: 10 }}><span className="k">Mais rápido</span><span className="v">{d.min_dias} dias</span></div>
              <div className="asst-kv"><span className="k">Mais lento</span><span className="v">{d.max_dias} dias</span></div>
            </>
          )}
          {d.tempo_medio_comprovante_dias != null && (
            <div className="asst-kv"><span className="k">Envio do comprovante</span><span className="v" style={{ color: '#2DD4BF' }}>{d.tempo_medio_comprovante_dias} dias</span></div>
          )}
        </div>
      </div>
    </>
  );
}

const STYLE = `
.asst{height:calc(100vh - 70px);display:flex;flex-direction:column;max-width:none;margin:0;
  background:#0c1a28;border:none;border-radius:0;overflow:hidden;color:#e6edf3}
/* coluna de conteúdo centralizada, estilo Claude web (larga, mas sem grudar nas bordas) */
.asst-wrap{--col:960px}
.asst{position:relative}
.asst-conv{position:absolute;top:62px;right:max(20px,calc((100% - 960px)/2));width:min(360px,calc(100% - 32px));max-height:70%;overflow:auto;z-index:20;
  background:#0f2236;border:1px solid rgba(255,255,255,.12);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.45);padding:10px}
.asst-conv-h{display:flex;align-items:center;justify-content:space-between;padding:4px 6px 10px;color:#e6edf3;font-size:14px}
.asst-conv-x,.asst-conv-del{background:none;border:none;color:rgba(230,237,243,.6);cursor:pointer;padding:4px;border-radius:6px}
.asst-conv-x:hover,.asst-conv-del:hover{color:#fff;background:rgba(255,255,255,.08)}
.asst-conv-v{padding:10px;color:rgba(230,237,243,.7);font-size:13px;display:flex;gap:8px;align-items:center}
.asst-conv-i{position:relative;padding:9px 34px 9px 10px;border-radius:8px;cursor:pointer;color:#e6edf3}
.asst-conv-i:hover,.asst-conv-i.on{background:rgba(92,200,255,.10)}
.asst-conv-i .t{font-size:13px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.asst-conv-i .d{font-size:11px;color:rgba(230,237,243,.55);margin-top:2px}
.asst-conv-del{position:absolute;top:8px;right:6px}
.asst-head{display:flex;align-items:center;gap:12px;padding:14px max(20px,calc((100% - 960px)/2));border-bottom:1px solid rgba(255,255,255,.08);
  background:linear-gradient(158deg,#103049,#0a1b2e)}
.asst-av{width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,#5CC8FF,#2DD4BF);color:#06212a;
  display:flex;align-items:center;justify-content:center;font-size:15px;flex:0 0 32px}
.asst-nm{font-family:${DISPLAY};font-weight:600;font-size:15px;color:#fff}
.asst-st{font-size:12px;color:#2DD4BF;display:flex;align-items:center;gap:6px}
.asst-pulse{width:8px;height:8px;border-radius:50%;background:#2DD4BF;animation:asstp 2s infinite}
@keyframes asstp{0%{box-shadow:0 0 0 0 rgba(45,212,191,.5)}70%{box-shadow:0 0 0 7px rgba(45,212,191,0)}100%{box-shadow:0 0 0 0 rgba(45,212,191,0)}}
.asst-msgs{flex:1;overflow-y:auto;padding:24px max(20px,calc((100% - 960px)/2));display:flex;flex-direction:column;gap:14px}
.asst-row{display:flex;gap:10px;max-width:80%;align-self:flex-start}
.asst-row.me{align-self:flex-end;flex-direction:row-reverse}
.asst-bav{width:30px;height:30px;border-radius:9px;flex:0 0 30px;background:linear-gradient(135deg,#5CC8FF,#2DD4BF);
  color:#06212a;display:flex;align-items:center;justify-content:center;font-size:14px}
.asst-bub{padding:11px 14px;border-radius:14px;font-size:13.5px;line-height:1.5}
.asst-bub.asst-bot{background:#0f2436;border:1px solid rgba(255,255,255,.08);border-top-left-radius:4px}
.asst-bub.asst-me{background:linear-gradient(135deg,#5CC8FF,#2DD4BF);color:#06212a;border-top-right-radius:4px;font-weight:500}
.asst-bub b{color:#fff}
.asst-typing{display:flex;align-items:center;gap:8px;color:rgba(255,255,255,.7)}
.asst-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.asst-chip{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;color:#5CC8FF;
  border:1px solid rgba(93,200,255,.4);background:rgba(93,200,255,.08);padding:8px 12px;border-radius:999px;cursor:pointer}
.asst-chip:hover{background:rgba(93,200,255,.16)}
.asst-card{margin-top:10px;background:#0b1a2a;border:1px solid rgba(255,255,255,.08);border-radius:12px;overflow:hidden}
.asst-ch{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid rgba(255,255,255,.08);background:#0e2234;flex-wrap:wrap}
.asst-pn{font-family:${DISPLAY};font-weight:600;font-size:13.5px}
.asst-badge{font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;margin-left:auto}
.asst-badge.def{color:#2DD4BF;background:rgba(45,212,191,.12);border:1px solid rgba(45,212,191,.32)}
.asst-badge.and{color:#93c5fd;background:rgba(147,197,253,.1);border:1px solid rgba(147,197,253,.3)}
.asst-badge.ind{color:#fca5a5;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3)}
.asst-cb{padding:12px 14px}
.asst-kv{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;padding:4px 0}
.asst-kv .k{color:rgba(255,255,255,.62)}.asst-kv .v{font-weight:600;text-align:right}
.asst-tl{margin:8px 0 2px;padding-left:6px}
.asst-tl li{list-style:none;position:relative;padding:0 0 12px 20px;font-size:12.5px;color:rgba(255,255,255,.62)}
.asst-tl li:before{content:'';position:absolute;left:3px;top:4px;width:9px;height:9px;border-radius:50%;background:#2DD4BF}
.asst-tl li:after{content:'';position:absolute;left:7px;top:13px;bottom:-2px;width:1.5px;background:rgba(255,255,255,.08)}
.asst-tl li:last-child{padding-bottom:0}.asst-tl li:last-child:after{display:none}
.asst-tl .dt{color:rgba(255,255,255,.42);font-size:11.5px}.asst-tl b{color:#e6edf3}
.asst-vbox{margin-top:10px;border-radius:11px;padding:11px 13px;font-size:12.5px;display:flex;gap:10px;align-items:flex-start}
.asst-vbox.ok{background:rgba(45,212,191,.12);border:1px solid rgba(45,212,191,.32);color:#2DD4BF}
.asst-vbox.lock{background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);color:#fbbf24}
.asst-vbox .t{font-weight:600}.asst-vbox .t.ok{color:#2DD4BF}.asst-vbox .t.lock{color:#fbbf24}
.asst-vbox .big{font-family:${DISPLAY};font-weight:700;font-size:18px;color:#eafff9;margin-top:2px}
.asst-vbox .sub{color:rgba(255,255,255,.62);margin-top:3px}.asst-vbox .sub b{color:#fff}
.asst-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.asst-tbl th,.asst-tbl td{text-align:left;padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.08)}
.asst-tbl th{color:rgba(255,255,255,.42);font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em}
.asst-tbl td.num,.asst-tbl th.num{text-align:right}
.asst-tbl tr.sum td{font-weight:700;border-bottom:none;border-top:1px solid rgba(255,255,255,.18)}
.asst-composer{display:block;padding:10px max(20px,calc((100% - 960px)/2)) 20px;background:#0c1a28}
/* caixa de digitar estilo Claude: pílula com borda, sombra e botão embutido */
.asst-inbar{display:flex;align-items:flex-start;gap:8px;background:#0f2436;border:1px solid rgba(255,255,255,.14);
  border-radius:22px;padding:12px 10px 10px 18px;min-height:76px;box-shadow:0 10px 34px rgba(0,0,0,.4);transition:border-color .15s,box-shadow .15s}
.asst-inbar:focus-within{border-color:rgba(45,212,191,.6);box-shadow:0 10px 34px rgba(0,0,0,.4),0 0 0 3px rgba(45,212,191,.14)}
.asst-inp{flex:1;background:transparent;border:none;padding:4px 2px;color:#eaf2fb;font-size:14px;line-height:1.5;outline:none;
  font-family:inherit;resize:none;overflow-y:auto;max-height:200px;display:block}
.asst-inp::placeholder{color:rgba(230,237,243,.42)}
.asst-snd{width:40px;height:40px;flex:0 0 40px;align-self:flex-end;border-radius:50%;border:none;background:linear-gradient(135deg,#5CC8FF,#2DD4BF);color:#06212a;
  display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 14px rgba(45,212,191,.3)}
.asst-snd:disabled{opacity:.45;cursor:default;box-shadow:none}
.asst-spin{animation:asstspin .9s linear infinite}@keyframes asstspin{to{transform:rotate(360deg)}}
@media(max-width:640px){.asst{height:calc(100vh - 60px);border-radius:0;border-left:none;border-right:none}.asst-row{max-width:95%}}
`;

export default AssistentePage;
