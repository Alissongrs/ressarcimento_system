// src/pages/tarefas/CartaoDivergencias.jsx
// Cartão "Status × histórico" da tela Tarefas do sistema (só admin): lista os processos cujo
// status/etapa em FT_PROCESSOS não bate com a última movimentação do histórico e corrige um a
// um, na direção sugerida (ou na outra), sempre com backup no servidor (FT_STATUS_RECONCILIACAO).
import React, { useCallback, useEffect, useState } from 'react';
import { GitCompareArrows, Loader2, RefreshCw } from 'lucide-react';
import { listarDivergencias, corrigirDivergencia } from '../../services/divergenciasService.js';

const card = { borderColor: 'var(--border)', background: 'var(--card)' };
const fmt = (d) => (d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

export default function CartaoDivergencias() {
  const [dados, setDados] = useState(null); // { total, itens }
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [ocupado, setOcupado] = useState(null); // id_processo em correção
  const [aberto, setAberto] = useState(false);
  const [log, setLog] = useState([]);

  const carregar = useCallback(async () => {
    setCarregando(true); setErro('');
    try { setDados(await listarDivergencias()); } catch (e) {
      setErro(e?.response?.data?.error?.message || 'Não foi possível listar as divergências.');
    } finally { setCarregando(false); }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  const corrigir = async (item, direcao) => {
    setOcupado(item.id_processo);
    try {
      await corrigirDivergencia(item.id_processo, direcao);
      setLog((l) => [`#${item.id_processo}: ${direcao === 'historico' ? 'registrado no histórico' : 'processo atualizado pelo histórico'}`, ...l].slice(0, 20));
      setDados((d) => d ? { total: d.total - 1, itens: d.itens.filter((x) => x.id_processo !== item.id_processo) } : d);
    } catch (e) {
      setErro(`#${item.id_processo}: ${e?.response?.data?.error?.message || 'não foi possível corrigir'}`);
    } finally { setOcupado(null); }
  };

  const corrigirTodosSugeridos = async () => {
    if (!dados?.itens?.length) return;
    for (const item of [...dados.itens]) {
      // sequencial de propósito: cada correção grava histórico + backup
      await corrigir(item, item.sugestao);
    }
  };

  const total = dados?.total ?? 0;
  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3" style={card}>
      <div className="flex items-start gap-3">
        <GitCompareArrows className="w-5 h-5 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Status × histórico</div>
          <div className="text-sm opacity-70">
            Processos cujo status/etapa na lista não bate com a última movimentação do histórico. O histórico é a fonte da verdade;
            desde 12/11 toda mudança de status passa por um caminho só, e esta lista é o estoque antigo. Uma rotina confere todo dia às 06:30.
          </div>
        </div>
        <button type="button" onClick={carregar} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-sm" style={{ borderColor: 'var(--border)' }} disabled={carregando}>
          {carregando ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
      </div>

      {erro && <div className="rounded border px-3 py-2 text-sm" style={{ borderColor: '#dc2626', color: '#dc2626' }}>{erro}</div>}

      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-2xl font-semibold" style={{ fontVariantNumeric: 'tabular-nums', color: total ? '#b45309' : '#059669' }}>{dados ? total : '…'}</span>
        <span className="text-sm opacity-70">{total === 1 ? 'processo divergente' : 'processos divergentes'}</span>
        {total > 0 && (
          <>
            <button type="button" onClick={() => setAberto((v) => !v)} className="px-3 py-1.5 rounded border text-sm" style={{ borderColor: 'var(--border)' }}>
              {aberto ? 'Esconder lista' : 'Ver lista'}
            </button>
            <button type="button" onClick={corrigirTodosSugeridos} disabled={!!ocupado} className="px-3 py-1.5 rounded text-sm text-white" style={{ background: '#0c6f7a' }}
              title="Aplica em cada processo a direção sugerida pelas datas; cada correção fica com backup no servidor">
              {ocupado ? `Corrigindo #${ocupado}…` : 'Corrigir todos na direção sugerida'}
            </button>
          </>
        )}
      </div>

      {aberto && total > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left opacity-70">
              <th className="px-2 py-1">Processo</th><th className="px-2 py-1">Cliente</th>
              <th className="px-2 py-1">Na lista (FT_PROCESSOS)</th><th className="px-2 py-1">Última movimentação</th>
              <th className="px-2 py-1">Sugestão</th><th className="px-2 py-1"></th>
            </tr></thead>
            <tbody>
              {dados.itens.map((it) => (
                <tr key={it.id_processo} className="border-t align-top" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-2 py-1.5 whitespace-nowrap">#{it.id_processo}{it.codigo ? <div className="text-xs opacity-60">{it.codigo}</div> : null}{it.suspenso && <div className="text-xs" style={{ color: '#b45309' }}>suspenso</div>}</td>
                  <td className="px-2 py-1.5">{it.cliente || '—'}</td>
                  <td className="px-2 py-1.5"><b>{it.ft_status_nome || '—'}</b> / {it.ft_etapa_nome || '—'}<div className="text-xs opacity-60">{fmt(it.ft_data)}</div></td>
                  <td className="px-2 py-1.5"><b>{it.hist_status_nome || '—'}</b> / {it.hist_etapa_nome || '—'}<div className="text-xs opacity-60">{fmt(it.hist_data)} · {it.hist_tipo || 'sem tipo'}</div>{it.hist_comentario && <div className="text-xs opacity-70 max-w-[320px] truncate" title={it.hist_comentario}>{it.hist_comentario}</div>}</td>
                  <td className="px-2 py-1.5 text-xs max-w-[260px]">{it.sugestao === 'historico' ? 'Registrar no histórico o estado da lista' : 'Atualizar a lista pelo histórico'}<div className="opacity-60">{it.motivo}</div></td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <div className="flex flex-col gap-1">
                      <button type="button" disabled={!!ocupado} onClick={() => corrigir(it, it.sugestao)} className="px-2 py-1 rounded text-xs text-white" style={{ background: '#0c6f7a' }}>
                        {ocupado === it.id_processo ? '…' : 'Aplicar sugestão'}
                      </button>
                      <button type="button" disabled={!!ocupado} onClick={() => corrigir(it, it.sugestao === 'historico' ? 'processo' : 'historico')} className="px-2 py-1 rounded border text-xs" style={{ borderColor: 'var(--border)' }}>
                        {it.sugestao === 'historico' ? 'Atualizar a lista' : 'Registrar no histórico'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {log.length > 0 && (
        <div className="text-xs opacity-70">{log.map((l, i) => <div key={i}>{l}</div>)}</div>
      )}
    </div>
  );
}
