// Pedidos ao sistema (FT_SOLICITACOES): os meus e — para o aprovador — os que esperam aprovação.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import Md from '../Md';

const ST = {
  pendente: ['Aguardando aprovação', 'and'],
  aprovado: ['Aprovado — na fila', 'info'],
  executado: ['Pronto', 'ok'],
  preciso_confirmar: ['Precisa da sua confirmação', 'roxo'],
  revisao: ['Em análise manual', 'and'],
  revertido: ['Revertido', 'cinza'],
  erro: ['Erro', 'ruim'],
  rejeitado: ['Rejeitado', 'cinza'],
};

export default function Pedidos() {
  const [aba, setAba] = useState('meus');
  const [aprovador, setAprovador] = useState(false);
  const [lista, setLista] = useState(null);
  const [aberto, setAberto] = useState(null);
  const [confirmando, setConfirmando] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => { api('/solicitacoes/sou-aprovador').then((d) => setAprovador(!!d?.aprovador)).catch(() => {}); }, []);

  const carregar = useCallback(async () => {
    try {
      const d = await api('/solicitacoes', { params: aba === 'meus' ? { mine: 1 } : { status: 'pendente' } });
      setLista((d?.data || []).slice().sort((a, b) => b.id - a.id).slice(0, 80));
      setErro('');
    } catch (e) { setErro(e.message); }
  }, [aba]);

  useEffect(() => {
    setLista(null);
    carregar();
    const t = setInterval(() => { if (document.visibilityState === 'visible') carregar(); }, 15000);
    return () => clearInterval(t);
  }, [carregar]);

  const aprovar = async (id) => {
    setConfirmando(null);
    try { await api(`/solicitacoes/${id}/aprovar`, { method: 'PUT' }); carregar(); } catch (e) { setErro('Não aprovei: ' + e.message); }
  };

  return (
    <div className="tela">
      {aprovador && (
        <div className="abas">
          <button type="button" className={aba === 'meus' ? 'on' : ''} onClick={() => setAba('meus')}>Meus pedidos</button>
          <button type="button" className={aba === 'aprovar' ? 'on' : ''} onClick={() => setAba('aprovar')}>Para aprovar</button>
        </div>
      )}
      {erro && <div className="erro">{erro}</div>}
      {lista === null && !erro && <div className="fraco centro">Carregando…</div>}
      {lista && lista.length === 0 && <div className="fraco centro">{aba === 'meus' ? 'Nenhum pedido ainda. Peça pelo chat.' : 'Nada esperando aprovação. 🎉'}</div>}
      {(lista || []).map((s) => {
        const [rot, cor] = ST[s.status] || [s.status, 'cinza'];
        const ab = aberto === s.id;
        return (
          <div key={s.id} className="cartao">
            <button type="button" className="cartao-cab toque" onClick={() => setAberto(ab ? null : s.id)}>
              <b>#{s.id}</b>
              <span className={`selo ${cor}`}>{rot}</span>
            </button>
            <div className="pedido-msg">{s.mensagem}</div>
            <div className="fraco pequeno">{aba === 'aprovar' && s.usuario_nome ? `${s.usuario_nome} · ` : ''}{s.criado_em}</div>
            {ab && s.preview && aba === 'aprovar' && <div className="bloco-res"><Md text={s.preview} /></div>}
            {ab && s.resultado && <div className="bloco-res"><Md text={s.resultado} /></div>}
            {ab && !s.resultado && aba === 'meus' && <div className="fraco pequeno">Ainda sem resultado.</div>}
            {aba === 'aprovar' && s.status === 'pendente' && (
              confirmando === s.id ? (
                <div className="confirmar">
                  <button type="button" className="btn-pri" onClick={() => aprovar(s.id)}>Confirmar aprovação</button>
                  <button type="button" className="btn-sec" onClick={() => setConfirmando(null)}>Voltar</button>
                </div>
              ) : (
                <div className="confirmar">
                  <button type="button" className="btn-sec" onClick={() => setAberto(s.id)}>Ver prévia</button>
                  <button type="button" className="btn-pri" onClick={() => setConfirmando(s.id)}>Aprovar</button>
                </div>
              )
            )}
            {s.status === 'preciso_confirmar' && <div className="fraco pequeno">Responda a confirmação pelo site completo (Assistente).</div>}
          </div>
        );
      })}
    </div>
  );
}
