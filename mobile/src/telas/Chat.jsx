// Chat do SURE no celular — o mesmo caminho do chat do site:
//  1) a frase é um COMANDO (alterar, relatório, mover…)? → prévia + "Enviar?" → vira pedido
//     (FT_SOLICITACOES). Consulta não precisa de aprovação; alteração vai para aprovação.
//  2) senão é PERGUNTA → /chat/processos (IA com os dados do banco, só leitura).
// Microfone: ditado do próprio celular (Web Speech API, pt-BR) — o texto cai na caixa.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import Md from '../Md';

const KEY = 'sure_m_chat';
const carregar = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
let SEQ = 0;
const mid = () => `${Date.now().toString(36)}-${++SEQ}`;

const Reconhecimento = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

export default function Chat({ usuario, irPara }) {
  const [msgs, setMsgs] = useState(carregar);
  const [texto, setTexto] = useState('');
  const [busy, setBusy] = useState(false);
  const [ouvindo, setOuvindo] = useState(false);
  const [pendente, setPendente] = useState(null); // { pedido, consulta }
  const fimRef = useRef(null);
  const recRef = useRef(null);
  const taRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(msgs.slice(-60))); } catch { /* ignore */ }
    fimRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs, busy]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [texto]);

  const add = (role, content, extra) => setMsgs((p) => [...p, { id: mid(), role, content, ...extra }]);

  const enviarPedido = async (pedido) => {
    setPendente(null);
    setBusy(true);
    try {
      const d = await api('/solicitacoes', { method: 'POST', body: { mensagem: pedido } });
      add('assistant', d?.precisa_aprovacao === false
        ? `🔎 Pedido **#${d?.id || ''}** é uma consulta — já estou levantando. O resultado aparece em **Pedidos**.`
        : `✅ Pedido **#${d?.id || ''}** registrado e enviado para aprovação. Acompanhe em **Pedidos**.`, { pedido: d?.id });
    } catch (e) {
      add('erro', 'Não consegui enviar o pedido: ' + e.message);
    } finally { setBusy(false); }
  };

  const enviar = async (bruto) => {
    const q = String(bruto ?? texto).trim();
    if (!q || busy) return;
    setTexto('');
    if (pendente) {
      if (/^\s*sim\b/i.test(q)) { add('user', q); await enviarPedido(pendente.pedido); return; }
      if (/^\s*n[ãa]o\b/i.test(q)) { add('user', q); setPendente(null); add('assistant', 'Pedido cancelado — nada foi enviado.'); return; }
      setPendente(null); // escreveu outra coisa: deixa o pedido anterior de lado
    }
    const historico = msgs.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-10).map((m) => ({ role: m.role, content: m.content }));
    add('user', q);
    setBusy(true);
    try {
      const forcado = /^[#@]sistema\b/i.test(q);
      const pedido = q.replace(/^[#@]sistema[\s,:]*/i, '').trim();
      let it = null;
      try { it = await api('/solicitacoes/interpretar', { method: 'POST', body: { mensagem: pedido } }); } catch { it = null; }
      if (it && (it.comando || forcado)) {
        const consulta = !!it.leitura;
        let cab = consulta ? `🔎 **Consulta ao sistema** (sem aprovação):\n\n"${pedido}"\n` : `📋 **Pedido ao sistema** (vai para aprovação):\n\n"${pedido}"\n`;
        if (it.pode_executar && it.preview) cab += consulta ? `\n**O que vou levantar:**\n${it.preview}\n` : `\n**Prévia:**\n${it.preview}\n\n_Depois da aprovação o sistema executa, com backup._\n`;
        else if (!consulta) cab += `\nVai para **execução manual** depois da aprovação${it.motivo ? ` (${it.motivo})` : ''}.\n`;
        if (!consulta) cab += `\n⚠️ Nada é alterado sem aprovação.`;
        add('assistant', cab, { confirmar: true });
        setPendente({ pedido, consulta });
        return;
      }
      const d = await api('/chat/processos', { method: 'POST', body: { question: q, history: historico } });
      add('assistant', d?.answer || 'Sem resposta.');
    } catch (e) {
      add('erro', e.message || 'Não consegui responder agora.');
    } finally { setBusy(false); }
  };

  const microfone = () => {
    if (!Reconhecimento) { add('erro', 'Este navegador não tem ditado por voz. Use o Chrome do celular.'); return; }
    if (ouvindo) { recRef.current?.stop(); return; }
    const r = new Reconhecimento();
    r.lang = 'pt-BR';
    r.interimResults = true;
    r.continuous = false;
    const base = texto ? texto.trim() + ' ' : '';
    r.onresult = (ev) => {
      let t = '';
      for (let i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript;
      setTexto(base + t);
    };
    r.onerror = (ev) => { if (ev.error === 'not-allowed') add('erro', 'Libere o microfone para o SURE nas permissões do navegador.'); };
    r.onend = () => setOuvindo(false);
    recRef.current = r;
    setOuvindo(true);
    try { r.start(); } catch { setOuvindo(false); }
  };

  const nova = () => { setMsgs([]); setPendente(null); try { localStorage.removeItem(KEY); } catch { /* ignore */ } };
  const nome = String(usuario?.nome || '').split(' ')[0];
  const ultimaConfirmar = [...msgs].reverse().find((m) => m.role !== 'user');

  return (
    <div className="chat">
      <div className="chat-topo">
        <span>Assistente SURE</span>
        {msgs.length > 0 && <button type="button" className="btn-mini" onClick={nova}>Nova conversa</button>}
      </div>
      <div className="chat-msgs">
        {msgs.length === 0 && (
          <div className="chat-vazio">
            <p>Olá{nome ? `, ${nome}` : ''}! Pergunte sobre processos, faturas, prazos — ou peça uma tarefa ao sistema.</p>
            {['Quais processos da CLARO foram deferidos este mês?', 'Faturas da UC 62053589 de agosto e setembro', 'Rodar o pdf_pipeline'].map((s) => (
              <button key={s} type="button" className="sug" onClick={() => enviar(s)}>{s}</button>
            ))}
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={`bolha ${m.role}`}>
            {m.role === 'user' ? m.content : <Md text={m.content} />}
            {m.pedido && <button type="button" className="btn-mini" onClick={() => irPara('pedidos')}>Ver pedido #{m.pedido}</button>}
            {m.confirmar && pendente && m === ultimaConfirmar && (
              <div className="confirmar">
                <button type="button" className="btn-pri" onClick={() => { add('user', 'sim'); enviarPedido(pendente.pedido); }}>Enviar</button>
                <button type="button" className="btn-sec" onClick={() => { add('user', 'não'); setPendente(null); add('assistant', 'Pedido cancelado — nada foi enviado.'); }}>Cancelar</button>
              </div>
            )}
          </div>
        ))}
        {busy && <div className="bolha assistant pensando"><span /><span /><span /></div>}
        <div ref={fimRef} />
      </div>
      <form className="chat-barra" onSubmit={(e) => { e.preventDefault(); enviar(); }}>
        <button type="button" className={`btn-mic${ouvindo ? ' on' : ''}`} onClick={microfone} aria-label={ouvindo ? 'Parar de ouvir' : 'Falar'}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
        </button>
        <textarea ref={taRef} rows={1} value={texto} onChange={(e) => setTexto(e.target.value)}
          placeholder={ouvindo ? 'Ouvindo…' : 'Mensagem'}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); enviar(); } }} />
        <button type="submit" className="btn-env" disabled={busy || !texto.trim()} aria-label="Enviar">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 20l18-8L3 4v6l12 2-12 2z" /></svg>
        </button>
      </form>
    </div>
  );
}
