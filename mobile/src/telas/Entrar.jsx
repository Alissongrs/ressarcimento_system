// Entrar: o mesmo link mágico do site. O link chega por e-mail; ao abrir no celular,
// o site guarda a sessão e volta para o app (/m/).
import React, { useState } from 'react';
import { api } from '../api';

export default function Entrar({ aoEntrar }) {
  const [email, setEmail] = useState('');
  const [enviado, setEnviado] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState('');

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
      <button type="button" className="btn-link" onClick={aoEntrar}>Já entrei pelo site — continuar</button>
    </div>
  );
}
