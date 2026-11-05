// Consulta rápida de processo (número do processo, da requisição ou protocolo).
// Usa a mesma consulta do Assistente: valor e data só aparecem quando há deferimento.
import React, { useEffect, useState } from 'react';
import { api } from '../api';

const brl = (v) => (v == null || v === '' || !isFinite(Number(v)) ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const data = (s) => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || '—'); };
const KEY = 'sure_m_proc_recentes';

export default function Processos() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState('');
  const [recentes, setRecentes] = useState(() => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } });

  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(recentes.slice(0, 8))); } catch { /* ignore */ } }, [recentes]);

  const buscar = async (valor) => {
    const v = String(valor ?? q).trim();
    if (!v) return;
    setQ(v);
    setBusy(true);
    setErro('');
    setRes(null);
    try {
      const d = await api('/api/v2/assistente/processo', { params: { q: v } });
      setRes(d);
      if (d?.encontrado) setRecentes((r) => [v, ...r.filter((x) => x !== v)]);
    } catch (e) { setErro(e.message); } finally { setBusy(false); }
  };

  const deferido = !!res?.valor_liberado;
  const dev = res?.devolucao || {};

  return (
    <div className="tela">
      <form className="busca" onSubmit={(e) => { e.preventDefault(); buscar(); }}>
        <input inputMode="numeric" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nº do processo, requisição ou protocolo" />
        <button type="submit" className="btn-pri" disabled={busy}>{busy ? '…' : 'Buscar'}</button>
      </form>
      {!res && !busy && !erro && recentes.length > 0 && (
        <div className="recentes">
          <div className="rot">Consultados recentemente</div>
          {recentes.map((r) => <button key={r} type="button" className="sug" onClick={() => buscar(r)}>{r}</button>)}
        </div>
      )}
      {erro && <div className="erro">{erro}</div>}
      {res && !res.encontrado && <div className="cartao">Não encontrei o processo <b>{res.consulta || q}</b>. Confira o número.</div>}
      {res?.encontrado && (
        <div className="cartao">
          <div className="cartao-cab">
            <b>Processo #{res.codigo_publico || res.id_processo}</b>
            <span className={`selo ${deferido ? 'ok' : res.indeferido ? 'ruim' : 'and'}`}>{deferido ? 'DEFERIDO' : res.indeferido ? 'INDEFERIDO' : (res.etapa_atual || 'EM ANÁLISE')}</span>
          </div>
          {res.cliente && <div className="kv"><span>Cliente</span><b>{res.cliente}</b></div>}
          {res.concessionaria && <div className="kv"><span>Concessionária</span><b>{res.concessionaria}</b></div>}
          {deferido ? (
            <div className="valor ok"><span>Valor deferido</span><b>{brl(res.valor)}</b><small>em {data(res.data_deferimento)}</small></div>
          ) : (
            <div className="valor"><span>Valor ainda não disponível</span><small>Sem deferimento confirmado — não informe valor nem prazo ao cliente.</small></div>
          )}
          {dev.realizada && (
            <>
              <div className="kv"><span>Devolução</span><b>{dev.forma || '—'}</b></div>
              {dev.data_devolucao && <div className="kv"><span>Devolvido em</span><b>{data(dev.data_devolucao)}</b></div>}
            </>
          )}
          {Array.isArray(res.movimentacoes) && res.movimentacoes.length > 0 && (
            <>
              <div className="rot">Andamento</div>
              <ul className="linha-tempo">
                {res.movimentacoes.map((mv, i) => (
                  <li key={i}><b>{mv.etapa || 'Movimentação'}</b>{mv.comentario ? ` — ${mv.comentario}` : ''}<small>{data(mv.data)}</small></li>
                ))}
              </ul>
            </>
          )}
          {res.id_processo && <a className="btn-sec bloco" href={`/processos/${res.id_processo}`}>Abrir no site completo</a>}
        </div>
      )}
    </div>
  );
}
