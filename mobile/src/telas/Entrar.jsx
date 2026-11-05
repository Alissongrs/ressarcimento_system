// Entrar: o mesmo link mágico do site. O link chega por e-mail; ao abrir no celular,
// o site guarda a sessão e volta para o app (/m/).
import React, { useState } from 'react';
import { api } from '../api';

export default function Entrar({ aoEntrar, entrou, erroQR }) {
  const [email, setEmail] = useState('');
  const [enviado, setEnviado] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState('');
  const [conferindo, setConferindo] = useState(false);

  const continuar = async () => {
    setConferindo(true);
    setErro('');
    const u = await aoEntrar();
    setConferindo(false);
    if (u) entrou(u);
    else setErro('Neste celular você ainda não está conectado ao SURE. Digite seu e-mail acima e abra o link que chegar — no próprio celular.');
  };

  const pedir = async (e) => {
    e.preventDefault();
    const em = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(em)) { setErro('Digite seu e-mail corporativo.'); return; }
    setErro('');
    setBusy(true);
    try { localStorage.setItem('sure_depois_login', JSON.stringify({ para: '/m/', em: Date.now() })); } catch { /* ignore */ }
    try { await api('/api/v2/auth/magic', { method: 'POST', body: { email: em } }); } catch { /* resposta genérica */ }
    setBusy(false);
    setEnviado(true);
  };

  return (
    <div className="entrar">
      <img src="/m/icons/sure-192.png" alt="" className="entrar-logo" />
      <h1>SURE</h1>
      {erroQR && <div className="erro entrar-form">{erroQR}</div>}
      <div className="entrar-qr">
        <b>Mais fácil: pelo QR code</b>
        <span>No computador, já logado no SURE, clique no seu nome (canto de cima) → <b>Conectar celular</b> e aponte a câmera deste celular para o QR.</span>
      </div>
      <div className="fraco pequeno">ou receba um link no e-mail:</div>
      {!enviado ? (
        <form onSubmit={pedir} className="entrar-form">
          <label htmlFor="em">E-mail corporativo</label>
          <input id="em" type="email" inputMode="email" autoComplete="email" value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="nome@amee.com.br" />
          {erro && <div className="erro">{erro}</div>}
          <button type="submit" className="btn-pri" disabled={busy}>{busy ? 'Enviando…' : 'Receber link de acesso'}</button>
        </form>
      ) : (
        <div className="entrar-ok">
          <p><b>Link enviado.</b> Abra o e-mail <b>neste celular</b> e toque no link — o SURE abre já conectado.</p>
          <p className="fraco">Não chegou em alguns minutos? Confira o lixo eletrônico ou peça de novo.</p>
          <button type="button" className="btn-sec" onClick={() => setEnviado(false)}>Pedir de novo</button>
        </div>
      )}
      <button type="button" className="btn-link" onClick={continuar} disabled={conferindo}>{conferindo ? 'Conferindo…' : 'Já entrei pelo site neste celular — continuar'}</button>
      {erro && enviado && <div className="erro entrar-form">{erro}</div>}
    </div>
  );
}
