// Chat do SURE no celular — mesmo caminho do chat do site (ver conversa.js).
// Microfone pequeno = ditado (o texto cai na caixa). Botão de onda = MODO CONVERSA por voz
// (tela cheia, voz da OpenAI), que grava no mesmo histórico.
import React, { useEffect, useRef, useState } from 'react';
import Md from '../Md';
import Voz from './Voz';
import { carregarChat, salvarChat, responder, enviarPedido, mid } from '../conversa';

const Reconhecimento = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

export default function Chat({ usuario, irPara }) {
  const [msgs, setMsgs] = useState(carregarChat);
  const [texto, setTexto] = useState('');
  const [busy, setBusy] = useState(false);
  const [ouvindo, setOuvindo] = useState(false);
  const [pendente, setPendente] = useState(null); // { pedido, consulta }
  const [voz, setVoz] = useState(false);
  const fimRef = useRef(null);
  const recRef = useRef(null);
  const taRef = useRef(null);

  useEffect(() => {
    salvarChat(msgs);
    fimRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs, busy, voz]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [texto]);

  const add = (novas) => setMsgs((p) => [...p, ...novas.map((m) => ({ id: mid(), ...m }))]);

  const confirmar = async (sim) => {
    const p = pendente;
    setPendente(null);
    add([{ role: 'user', content: sim ? 'sim' : 'não' }]);
    if (!sim) { add([{ role: 'assistant', content: 'Pedido cancelado — nada foi enviado.' }]); return; }
    setBusy(true);
    try { add((await enviarPedido(p.pedido)).msgs); } catch (e) { add([{ role: 'erro', content: 'Não consegui enviar o pedido: ' + e.message }]); } finally { setBusy(false); }
  };

  const enviar = async (bruto) => {
    const q = String(bruto ?? texto).trim();
    if (!q || busy) return;
    setTexto('');
    const historico = msgs.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-10).map((m) => ({ role: m.role, content: m.content }));
    add([{ role: 'user', content: q }]);
    setBusy(true);
    try {
      const out = await responder(q, { historico, pendente });
      setPendente(out.pendente);
      add(out.msgs);
    } catch (e) {
      add([{ role: 'erro', content: e.message || 'Não consegui responder agora.' }]);
    } finally { setBusy(false); }
  };

  const microfone = () => {
    if (!Reconhecimento) { add([{ role: 'erro', content: 'Este navegador não tem ditado por voz. Use o Chrome do celular.' }]); return; }
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
    r.onerror = (ev) => { if (ev.error === 'not-allowed') add([{ role: 'erro', content: 'Libere o microfone para o SURE nas permissões do navegador.' }]); };
    r.onend = () => setOuvindo(false);
    recRef.current = r;
    setOuvindo(true);
    try { r.start(); } catch { setOuvindo(false); }
  };

  const nova = () => { setMsgs([]); setPendente(null); };
  const nome = String(usuario?.nome || '').split(' ')[0];
  const ultimaBot = [...msgs].reverse().find((m) => m.role !== 'user');

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
            <button type="button" className="btn-pri" onClick={() => setVoz(true)}>🎙️ Conversar por voz</button>
            {['Quais processos da CLARO foram deferidos este mês?', 'Faturas da UC 62053589 de agosto e setembro', 'Rodar o pdf_pipeline'].map((s) => (
              <button key={s} type="button" className="sug" onClick={() => enviar(s)}>{s}</button>
            ))}
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={`bolha ${m.role}`}>
            {m.role === 'user' ? <>{m.voz && <span className="voz-marca">🎙️ </span>}{m.content}</> : <Md text={m.content} />}
            {m.pedido && <button type="button" className="btn-mini" onClick={() => irPara('pedidos')}>Ver pedido #{m.pedido}</button>}
            {m.confirmar && pendente && m === ultimaBot && (
              <div className="confirmar">
                <button type="button" className="btn-pri" onClick={() => confirmar(true)}>Enviar</button>
                <button type="button" className="btn-sec" onClick={() => confirmar(false)}>Cancelar</button>
              </div>
            )}
          </div>
        ))}
        {busy && <div className="bolha assistant pensando"><span /><span /><span /></div>}
        <div ref={fimRef} />
      </div>
      <form className="chat-barra" onSubmit={(e) => { e.preventDefault(); enviar(); }}>
        <button type="button" className={`btn-mic${ouvindo ? ' on' : ''}`} onClick={microfone} aria-label={ouvindo ? 'Parar o ditado' : 'Ditar'}>
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
        </button>
        <textarea ref={taRef} rows={1} value={texto} onChange={(e) => setTexto(e.target.value)}
          placeholder={ouvindo ? 'Ouvindo…' : 'Mensagem'}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); enviar(); } }} />
        {texto.trim() ? (
          <button type="submit" className="btn-env" disabled={busy} aria-label="Enviar">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M3 20l18-8L3 4v6l12 2-12 2z" /></svg>
          </button>
        ) : (
          <button type="button" className="btn-env" onClick={() => setVoz(true)} aria-label="Conversar por voz">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" /></svg>
          </button>
        )}
      </form>
      {voz && <Voz msgs={msgs} setMsgs={setMsgs} pendente={pendente} setPendente={setPendente} fechar={() => setVoz(false)} />}
    </div>
  );
}
