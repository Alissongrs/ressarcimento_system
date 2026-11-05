// Modo conversa por voz (tela cheia), no estilo do ChatGPT:
// escuta → percebe quando você parou de falar → transcreve (OpenAI) → responde (mesmo cérebro
// do chat) → fala a resposta (voz da OpenAI) → volta a escutar sozinho.
// Falar por cima interrompe a resposta. Tudo entra também no histórico do chat escrito.
import React, { useEffect, useRef, useState } from 'react';
import { transcrever, falar } from '../api';
import { responder, mid } from '../conversa';

const TIPOS = [['audio/webm;codecs=opus', 'webm'], ['audio/webm', 'webm'], ['audio/mp4', 'mp4'], ['audio/ogg;codecs=opus', 'ogg']];
const SILENCIO_MS = 1200; // pausa que encerra a sua fala
const MAX_FALA_MS = 45000;

const ROTULO = {
  iniciando: 'Preparando o microfone…',
  ouvindo: 'Pode falar',
  falou: 'Ouvindo…',
  transcrevendo: 'Entendendo…',
  pensando: 'Pensando…',
  falando: 'Falando — fale por cima para interromper',
  pausado: 'Pausado — toque para continuar',
  erro: 'Algo deu errado',
};

export default function Voz({ msgs, setMsgs, pendente, setPendente, fechar }) {
  const [estado, setEstado] = useState('iniciando');
  const [eu, setEu] = useState('');
  const [sure, setSure] = useState('');
  const [erro, setErro] = useState('');
  const [nivel, setNivel] = useState(0);

  const r = useRef({}).current; // motor (não re-renderiza)
  const estadoRef = useRef('iniciando');
  const msgsRef = useRef(msgs);
  const pendRef = useRef(pendente);
  useEffect(() => { msgsRef.current = msgs; }, [msgs]);
  useEffect(() => { pendRef.current = pendente; }, [pendente]);

  const mudar = (e) => { estadoRef.current = e; setEstado(e); };

  // ── gravação de uma fala ──
  const comecarGravacao = () => {
    const [tipo, ext] = TIPOS.find(([t]) => window.MediaRecorder?.isTypeSupported?.(t)) || ['', 'webm'];
    r.ext = ext;
    r.pedacos = [];
    r.rec = new MediaRecorder(r.stream, tipo ? { mimeType: tipo } : undefined);
    r.rec.ondataavailable = (ev) => { if (ev.data?.size) r.pedacos.push(ev.data); };
    r.rec.onstop = () => { if (r.aoParar) r.aoParar(); };
    r.rec.start(250);
    r.inicioGrav = Date.now();
    r.falaIni = 0;
    r.ultimaVoz = 0;
  };
  const pararGravacao = (usar) => new Promise((res) => {
    if (!r.rec || r.rec.state === 'inactive') { res(null); return; }
    r.aoParar = () => { r.aoParar = null; res(usar ? new Blob(r.pedacos, { type: r.rec.mimeType || 'audio/webm' }) : null); };
    try { r.rec.stop(); } catch { res(null); }
  });

  const escutar = () => {
    if (r.fechado) return;
    mudar('ouvindo');
    comecarGravacao();
  };

  // ── uma volta completa: fala gravada → texto → resposta → voz ──
  const processarFala = async () => {
    mudar('transcrevendo');
    const blob = await pararGravacao(true);
    if (r.fechado) return;
    let texto = '';
    try { texto = blob && blob.size > 2000 ? await transcrever(blob, r.ext) : ''; } catch (e) { setErro(e.message); }
    if (r.fechado) return;
    if (!texto || texto.replace(/[^\p{L}\p{N}]/gu, '').length < 2) { escutar(); return; }
    setEu(texto);
    setSure('');
    setErro('');
    const historico = msgsRef.current.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-10).map((m) => ({ role: m.role, content: m.content }));
    setMsgs((p) => [...p, { id: mid(), role: 'user', content: texto, voz: true }]);
    mudar('pensando');
    let out;
    try {
      out = await responder(texto, { historico, pendente: pendRef.current, voz: true });
    } catch (e) {
      out = { msgs: [{ role: 'erro', content: e.message }], pendente: null, fala: 'Não consegui responder agora. ' + e.message };
    }
    if (r.fechado) return;
    setPendente(out.pendente);
    setMsgs((p) => [...p, ...out.msgs.map((m) => ({ id: mid(), ...m }))]);
    setSure(out.fala);
    await dizer(out.fala);
    if (!r.fechado && estadoRef.current !== 'pausado' && estadoRef.current !== 'ouvindo' && estadoRef.current !== 'falou') escutar();
  };

  // ── fala a resposta; se você falar por cima, para e volta a escutar ──
  const dizer = async (texto) => {
    mudar('falando');
    try {
      const mp3 = await falar(texto);
      if (r.fechado || estadoRef.current !== 'falando') return;
      const buf = await r.ctx.decodeAudioData(mp3);
      if (r.fechado || estadoRef.current !== 'falando') return;
      await new Promise((res) => {
        const src = r.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(r.ctx.destination);
        src.onended = res;
        r.tocando = { src, res };
        src.start();
      });
    } catch {
      // sem a voz da OpenAI: usa a voz do próprio celular
      await new Promise((res) => {
        if (!window.speechSynthesis) { res(); return; }
        const u = new SpeechSynthesisUtterance(texto);
        u.lang = 'pt-BR';
        u.onend = res;
        u.onerror = res;
        r.tocando = { sintese: true, res };
        window.speechSynthesis.speak(u);
      });
    } finally {
      r.tocando = null;
    }
  };
  const calar = () => {
    const t = r.tocando;
    if (!t) return;
    try { if (t.sintese) window.speechSynthesis.cancel(); else t.src.stop(); } catch { /* ignore */ }
    t.res();
    r.tocando = null;
  };

  // ── laço do microfone: mede o volume e decide quando você começou/parou de falar ──
  const laco = () => {
    if (r.fechado) return;
    r.analisador.getFloatTimeDomainData(r.amostra);
    let s = 0;
    for (let i = 0; i < r.amostra.length; i++) s += r.amostra[i] * r.amostra[i];
    const rms = Math.sqrt(s / r.amostra.length);
    const agora = Date.now();
    if (agora - r.calibIni < 600) { r.ruido = Math.max(r.ruido, rms); }
    const limiar = Math.max(0.012, r.ruido * 2.5);
    setNivel(Math.min(1, rms / (limiar * 4)));
    const e = estadoRef.current;
    if (e === 'ouvindo' || e === 'falou') {
      if (rms > limiar) {
        if (!r.falaIni) r.falaIni = agora;
        r.ultimaVoz = agora;
        if (e === 'ouvindo' && agora - r.falaIni > 180) mudar('falou');
      } else if (e === 'ouvindo' && r.falaIni && agora - r.ultimaVoz > 400) {
        r.falaIni = 0; // ruído curto, não era fala
      }
      if (e === 'falou' && (agora - r.ultimaVoz > SILENCIO_MS || agora - r.falaIni > MAX_FALA_MS)) processarFala();
      // muito tempo em silêncio: recomeça a gravação para não acumular áudio vazio
      if (e === 'ouvindo' && !r.falaIni && agora - r.inicioGrav > 20000) { pararGravacao(false).then(() => { if (estadoRef.current === 'ouvindo') comecarGravacao(); }); r.inicioGrav = agora; }
    } else if (e === 'falando') {
      // interrupção: voz forte e contínua por cima da resposta
      if (rms > limiar * 2.2) { r.bargeIni = r.bargeIni || agora; if (agora - r.bargeIni > 350) { r.bargeIni = 0; calar(); mudar('falou'); comecarGravacao(); r.falaIni = agora; r.ultimaVoz = agora; } } else r.bargeIni = 0;
    }
    r.raf = requestAnimationFrame(laco);
  };

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        r.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (!vivo) { r.stream.getTracks().forEach((t) => t.stop()); return; }
        r.ctx = new (window.AudioContext || window.webkitAudioContext)();
        await r.ctx.resume();
        const fonte = r.ctx.createMediaStreamSource(r.stream);
        r.analisador = r.ctx.createAnalyser();
        r.analisador.fftSize = 1024;
        fonte.connect(r.analisador);
        r.amostra = new Float32Array(r.analisador.fftSize);
        r.ruido = 0;
        r.calibIni = Date.now();
        try { r.trava = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ }
        escutar();
        laco();
      } catch (e) {
        setErro(e?.name === 'NotAllowedError' ? 'Libere o microfone para o SURE (cadeado ao lado do endereço → Microfone → Permitir).' : 'Não consegui abrir o microfone.');
        mudar('erro');
      }
    })();
    return () => {
      vivo = false;
      r.fechado = true;
      cancelAnimationFrame(r.raf);
      calar();
      try { if (r.rec && r.rec.state !== 'inactive') r.rec.stop(); } catch { /* ignore */ }
      r.stream?.getTracks().forEach((t) => t.stop());
      try { r.ctx?.close(); } catch { /* ignore */ }
      try { r.trava?.release(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tocarOrbe = () => {
    const e = estadoRef.current;
    if (e === 'falando') { calar(); escutar(); return; }
    if (e === 'pausado') { escutar(); return; }
    if (e === 'falou') { processarFala(); return; } // terminou de falar: envia já
    if (e === 'ouvindo') { pararGravacao(false); mudar('pausado'); }
  };

  const escala = estado === 'falando' ? 1.08 : 1 + nivel * 0.35;
  return (
    <div className="voz" role="dialog" aria-label="Conversa por voz">
      <button type="button" className="voz-x" onClick={fechar} aria-label="Fechar">✕</button>
      <div className="voz-textos">
        {eu && <p className="voz-eu">{eu}</p>}
        {sure && <p className="voz-sure">{sure}</p>}
        {pendente && <p className="voz-dica">Diga <b>sim</b> para enviar ou <b>não</b> para cancelar.</p>}
      </div>
      <button type="button" className={`voz-orbe ${estado}`} style={{ transform: `scale(${escala})` }} onClick={tocarOrbe} aria-label={ROTULO[estado]}>
        <span />
      </button>
      <div className="voz-estado">{ROTULO[estado]}</div>
      {erro && <div className="erro voz-erro">{erro}</div>}
      <div className="voz-baixo">
        <button type="button" className="btn-sec" onClick={tocarOrbe}>{estado === 'pausado' ? 'Continuar' : estado === 'falando' ? 'Interromper' : estado === 'falou' ? 'Enviar agora' : 'Pausar'}</button>
        <button type="button" className="btn-sec" onClick={fechar}>Voltar ao chat</button>
      </div>
    </div>
  );
}
