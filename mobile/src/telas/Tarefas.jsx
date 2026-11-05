// Tarefas da equipe (FT_TAREFAS): as abertas — de todos para o admin, as minhas para o analista.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

const dataHora = (s) => {
  const d = s ? new Date(s) : null;
  return d && !isNaN(d) ? d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
};

export default function Tarefas({ usuario }) {
  const admin = usuario?.perfil === 'admin';
  const [minhas, setMinhas] = useState(!admin);
  const [lista, setLista] = useState(null);
  const [concluindo, setConcluindo] = useState(null);
  const [coment, setComent] = useState('');
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    try {
      const d = await api('/tarefas', { params: minhas ? { minhas: 1 } : {} });
      setLista(Array.isArray(d) ? d : []);
      setErro('');
    } catch (e) { setErro(e.message); }
  }, [minhas]);

  useEffect(() => { setLista(null); carregar(); }, [carregar]);

  const concluir = async (id) => {
    try {
      const d = await api(`/tarefas/${id}/concluir`, { method: 'POST', body: { comentario: coment } });
      if (d?.ok === false) { setErro(d.erro || 'Não consegui concluir.'); return; }
      setConcluindo(null);
      setComent('');
      carregar();
    } catch (e) { setErro(e.message); }
  };

  return (
    <div className="tela">
      {admin && (
        <div className="abas">
          <button type="button" className={!minhas ? 'on' : ''} onClick={() => setMinhas(false)}>Todas abertas</button>
          <button type="button" className={minhas ? 'on' : ''} onClick={() => setMinhas(true)}>Minhas</button>
        </div>
      )}
      {erro && <div className="erro">{erro}</div>}
      {lista === null && !erro && <div className="fraco centro">Carregando…</div>}
      {lista && lista.length === 0 && <div className="fraco centro">Nenhuma tarefa aberta. 🎉</div>}
      {(lista || []).map((t) => (
        <div key={t.id_tarefa} className="cartao">
          <div className="cartao-cab">
            <b>{t.titulo}</b>
            <span className={`selo ${t.responsavel ? 'info' : 'and'}`}>{t.responsavel || 'sem responsável'}</span>
          </div>
          {(t.cliente || t.concessionaria) && <div className="fraco pequeno">{[t.cliente, t.concessionaria].filter(Boolean).join(' · ')}</div>}
          {t.descricao && <div className="pedido-msg">{t.descricao}</div>}
          {(t.situacao_anterior || t.situacao_nova) && <div className="pequeno">{t.situacao_anterior || '—'} → <b>{t.situacao_nova || '—'}</b></div>}
          <div className="fraco pequeno">{t.id_processo ? `Processo #${t.id_processo} · ` : ''}{dataHora(t.criado_em)}</div>
          {concluindo === t.id_tarefa ? (
            <div className="concluir">
              <textarea rows={2} value={coment} onChange={(e) => setComent(e.target.value)} placeholder="Comentário (opcional)" />
              <div className="confirmar">
                <button type="button" className="btn-pri" onClick={() => concluir(t.id_tarefa)}>Concluir</button>
                <button type="button" className="btn-sec" onClick={() => setConcluindo(null)}>Voltar</button>
              </div>
            </div>
          ) : (
            <div className="confirmar">
              {t.id_processo && <a className="btn-sec" href={`/processos/${t.id_processo}`}>Abrir processo</a>}
              <button type="button" className="btn-pri" onClick={() => { setConcluindo(t.id_tarefa); setComent(''); }}>Concluir</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
