// SURE no celular: Chat, Processos, Pedidos e Tarefas, com a barra de abas embaixo.
// A aba aberta fica no endereço (#chat, #processos…) — os atalhos do ícone usam isso.
import React, { useEffect, useState } from 'react';
import { usuarioDoToken, sessaoDoServidor, sair } from './api';
import Entrar from './telas/Entrar';
import Chat from './telas/Chat';
import Processos from './telas/Processos';
import Pedidos from './telas/Pedidos';
import Tarefas from './telas/Tarefas';

const ABAS = [
  { id: 'chat', nome: 'Chat', ic: <path d="M4 5h16v11H8l-4 4z" /> },
  { id: 'processos', nome: 'Processos', ic: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></> },
  { id: 'pedidos', nome: 'Pedidos', ic: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></> },
  { id: 'tarefas', nome: 'Tarefas', ic: <><path d="M4 12l4 4 8-9" /><path d="M14 17h6" /></> },
];
// token guardado no celular OU a sessão (cookie) do site
const descobrir = async () => usuarioDoToken() || sessaoDoServidor();
const abaDoHash = () => { const h = window.location.hash.replace('#', ''); return ABAS.some((a) => a.id === h) ? h : 'chat'; };

export default function App() {
  const [usuario, setUsuario] = useState(() => usuarioDoToken() || undefined); // undefined = conferindo
  const [aba, setAba] = useState(abaDoHash);

  useEffect(() => {
    const fora = () => setUsuario(null);
    const hash = () => setAba(abaDoHash());
    window.addEventListener('sure-sair', fora);
    window.addEventListener('hashchange', hash);
    // a sessão pode ter sido aberta/fechada pelo site em outra aba
    if (!usuarioDoToken()) descobrir().then((u) => setUsuario(u || null));
    const vis = () => { if (document.visibilityState === 'visible') descobrir().then((u) => setUsuario(u || null)); };
    document.addEventListener('visibilitychange', vis);
    return () => { window.removeEventListener('sure-sair', fora); window.removeEventListener('hashchange', hash); document.removeEventListener('visibilitychange', vis); };
  }, []);

  const irPara = (id) => { window.location.hash = id; setAba(id); };

  if (usuario === undefined) return <div className="entrar"><img src="/m/icons/sure-192.png" alt="" className="entrar-logo" /></div>;
  if (!usuario) return <Entrar aoEntrar={descobrir} entrou={setUsuario} />;

  return (
    <div className="app">
      <header className="topo">
        <img src="/m/icons/sure-192.png" alt="" />
        <span className="topo-nome">{ABAS.find((a) => a.id === aba)?.nome}</span>
        <details className="menu">
          <summary aria-label="Menu">{String(usuario.nome || '?').trim().charAt(0).toUpperCase()}</summary>
          <div className="menu-cx">
            <div className="menu-u"><b>{usuario.nome}</b><small>{usuario.email}</small></div>
            <a href="/">Abrir o site completo</a>
            <button type="button" onClick={sair}>Sair deste celular</button>
          </div>
        </details>
      </header>
      <main className="conteudo">
        {aba === 'chat' && <Chat usuario={usuario} irPara={irPara} />}
        {aba === 'processos' && <Processos />}
        {aba === 'pedidos' && <Pedidos />}
        {aba === 'tarefas' && <Tarefas usuario={usuario} />}
      </main>
      <nav className="abas-baixo">
        {ABAS.map((a) => (
          <button key={a.id} type="button" className={aba === a.id ? 'on' : ''} onClick={() => irPara(a.id)}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{a.ic}</svg>
            <span>{a.nome}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
