import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Trash2, RefreshCw, Inbox, Undo2 } from 'lucide-react';
import { listarSolicitacoes, aprovarSolicitacao, deletarSolicitacao, reverterSolicitacao } from '../services/solicitacoesService';

/**
 * SolicitacoesPanel — fila de pedidos ao sistema (chat #sistema).
 * O gestor vê as pendentes, Aprova (entra na fila de execução do Claude),
 * Copia o texto, ou Deleta. Mostra também as já aprovadas/executadas com resultado.
 * Auto-atualiza a cada 15s.
 */
const STATUS_COR = {
  pendente:  { bg: 'color-mix(in srgb, var(--warning) 18%, transparent)', fg: 'var(--warning)', label: 'Pendente' },
  aprovado:  { bg: 'color-mix(in srgb, var(--accent) 18%, transparent)',  fg: 'var(--accent)',  label: 'Aprovado — aguardando execução' },
  executado: { bg: 'color-mix(in srgb, var(--success) 18%, transparent)', fg: 'var(--success)', label: 'Executado' },
  revisao:   { bg: 'color-mix(in srgb, var(--warning) 18%, transparent)', fg: 'var(--warning)', label: 'Requer revisão manual' },
  revertido: { bg: 'color-mix(in srgb, var(--fg) 12%, transparent)',      fg: 'var(--fg)',      label: 'Revertido' },
  erro:      { bg: 'color-mix(in srgb, var(--danger) 18%, transparent)',  fg: 'var(--danger)',  label: 'Erro' },
};

export default function SolicitacoesPanel() {
  const [itens, setItens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    setLoading(true); setErro('');
    try {
      // traz tudo (pendentes no topo pela ordem de criação desc do backend)
      const todas = await listarSolicitacoes();
      // pendentes primeiro, depois o resto
      todas.sort((a, b) => (a.status === 'pendente' ? -1 : 0) - (b.status === 'pendente' ? -1 : 0));
      setItens(todas);
    } catch (e) {
      setErro(e?.response?.data?.error || 'Falha ao carregar solicitações.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    carregar();
    const t = setInterval(carregar, 15000);
    return () => clearInterval(t);
  }, [carregar]);

  const aprovar = async (id) => {
    setBusyId(id);
    try { await aprovarSolicitacao(id); await carregar(); }
    catch (e) { setErro(e?.response?.data?.error || 'Falha ao aprovar.'); }
    finally { setBusyId(null); }
  };
  const deletar = async (id) => {
    setBusyId(id);
    try { await deletarSolicitacao(id); await carregar(); }
    catch (e) { setErro(e?.response?.data?.error || 'Falha ao deletar.'); }
    finally { setBusyId(null); }
  };
  const reverter = async (id) => {
    if (!window.confirm(`Reverter o protocolo #${id}? Os valores anteriores serão restaurados.`)) return;
    setBusyId(id);
    try { await reverterSolicitacao(id); await carregar(); }
    catch (e) { setErro(e?.response?.data?.error || 'Falha ao reverter.'); }
    finally { setBusyId(null); }
  };
  const copiar = (txt) => { try { navigator.clipboard?.writeText(txt || ''); } catch { /* ignore */ } };

  const pendentes = itens.filter((i) => i.status === 'pendente');

  return (
    <div style={{ background: 'var(--card, #10233a)', border: '1px solid color-mix(in srgb, var(--accent) 22%, transparent)',
                  borderRadius: 12, padding: 14, color: 'var(--fg, #e6edf3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Inbox size={16} style={{ color: 'var(--accent)' }} />
        <span style={{ fontWeight: 700, fontSize: 14 }}>Solicitações ao sistema</span>
        <span style={{ fontSize: 11, opacity: 0.7 }}>
          {pendentes.length} pendente{pendentes.length === 1 ? '' : 's'}
        </span>
        <button onClick={carregar} title="Atualizar" disabled={loading}
          style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg)', opacity: loading ? 0.4 : 0.8 }}>
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
        </button>
      </div>

      {erro && <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 8 }}>{erro}</div>}

      {itens.length === 0 && !loading && (
        <div style={{ opacity: 0.6, fontSize: 12.5, padding: '14px 4px', textAlign: 'center' }}>
          Nenhuma solicitação. Os pedidos feitos no chat com <code>#sistema</code> aparecem aqui.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflowY: 'auto' }}>
        {itens.map((it) => {
          const c = STATUS_COR[it.status] || STATUS_COR.pendente;
          return (
            <div key={it.id}
              style={{ border: `1px solid ${it.status === 'pendente' ? 'color-mix(in srgb, var(--warning) 35%, transparent)' : 'color-mix(in srgb, var(--fg) 12%, transparent)'}`,
                       borderRadius: 9, padding: '9px 11px', background: 'color-mix(in srgb, var(--fg) 3%, transparent)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' }}>
                <span title="Protocolo" style={{ fontSize: 10.5, fontWeight: 700, opacity: 0.8, fontFamily: 'monospace' }}>#{it.id}</span>
                <span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 99, background: c.bg, color: c.fg, fontWeight: 600 }}>{c.label}</span>
                <span style={{ fontSize: 11, opacity: 0.7 }}>{it.usuario_nome || 'usuário'}</span>
                <span style={{ fontSize: 10.5, opacity: 0.5, marginLeft: 'auto' }}>{(it.criado_em || '').slice(0, 16).replace('T', ' ')}</span>
              </div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{it.mensagem}</div>

              {it.resultado && (
                <div style={{ marginTop: 6, fontSize: 11.5, opacity: 0.85, borderTop: '1px solid color-mix(in srgb, var(--fg) 10%, transparent)', paddingTop: 5 }}>
                  <b style={{ opacity: 0.7 }}>Resultado:</b> <span style={{ whiteSpace: 'pre-wrap' }}>{it.resultado}</span>
                </div>
              )}

              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                {it.status === 'pendente' && (
                  <button onClick={() => aprovar(it.id)} disabled={busyId === it.id}
                    style={btn('var(--success)')}>
                    <Check size={13} /> Aprovar
                  </button>
                )}
                {it.status === 'executado' && (
                  <button onClick={() => reverter(it.id)} disabled={busyId === it.id}
                    style={btn('var(--warning)')}>
                    <Undo2 size={13} /> Reverter
                  </button>
                )}
                <button onClick={() => copiar(it.mensagem)} style={btn('var(--accent)')}>
                  <Copy size={13} /> Copiar
                </button>
                <button onClick={() => deletar(it.id)} disabled={busyId === it.id}
                  style={btn('var(--danger)')}>
                  <Trash2 size={13} /> Deletar
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function btn(cor) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    padding: '5px 10px', borderRadius: 7, color: cor,
    border: `1px solid color-mix(in srgb, ${cor} 40%, transparent)`,
    background: `color-mix(in srgb, ${cor} 10%, transparent)`,
  };
}
