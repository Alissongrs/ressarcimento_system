// Relatório de priorização dos deferidos (pedido da Luana, 26/11/2026) — modal de tela inteira.
// Todos os processos deferidos; estrela grande = prioridade 1, estrela pequena = prioridade 2, sem estrela = irrelevante.
// Comprovante de depósito com a fonte; data estimada pelo sistema (média desde 01/01/2026) e data digitada.
// "Gerar relatório" baixa do backend o Excel no formato do dashboard da Luana (Dashboard + DEFERIDOS + Demais deferidos).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Star, Download, RefreshCw, Plus, Trash2 } from 'lucide-react';
import {
  getRelatorioPriorizacao, salvarPriorizacao, registrarComprovante, apagarComprovante, baixarRelatorioPriorizacaoXlsx,
} from '../services/relatorioPriorizacaoService';

const brl = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (iso) => (iso && iso.length >= 10 ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const FONTE = {
  manual: 'Manual', email: 'E-mail', whatsapp: 'WhatsApp', historico: 'Histórico', faturamento: 'Envio ao financeiro',
};

function Estrelas({ valor, onChange, disabled }) {
  const cor = (ativo) => (ativo ? '#f5b301' : 'color-mix(in srgb, var(--fg) 30%, transparent)');
  const btn = { background: 'none', border: 'none', padding: 2, cursor: disabled ? 'default' : 'pointer', lineHeight: 0 };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <button type="button" style={btn} disabled={disabled} title="Prioridade 1"
        onClick={() => onChange(valor === 1 ? 0 : 1)}>
        <Star size={20} color={cor(valor === 1)} fill={valor === 1 ? '#f5b301' : 'none'} />
      </button>
      <button type="button" style={btn} disabled={disabled} title="Prioridade 2"
        onClick={() => onChange(valor === 2 ? 0 : 2)}>
        <Star size={13} color={cor(valor === 2)} fill={valor === 2 ? '#f5b301' : 'none'} />
      </button>
    </span>
  );
}

function ComprovanteCell({ p, onRegistrar, onApagar, podeEditar }) {
  const [aberto, setAberto] = useState(false);
  const [data, setData] = useState('');
  const [fonte, setFonte] = useState('email');
  const [ref, setRef] = useState('');
  const c = p.comprovante;
  if (c) {
    return (
      <div style={{ lineHeight: 1.3 }}>
        <div style={{ fontWeight: 600, color: 'var(--cpv2-success)' }}>{br(c.data)}</div>
        <div style={{ fontSize: 11, color: 'var(--cpv2-text-muted)' }} title={c.referencia || ''}>
          {FONTE[c.fonte] || c.fonte}{p.dias_ate_comprovante != null ? ` · ${p.dias_ate_comprovante} dias` : ''}
          {podeEditar && c.id ? (
            <button type="button" title="Apagar este registro" onClick={() => onApagar(c.id)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 0 4px', verticalAlign: 'middle' }}>
              <Trash2 size={11} />
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  if (!aberto) {
    return (
      <div style={{ lineHeight: 1.3 }}>
        <span style={{ color: 'var(--cpv2-text-soft)' }}>Não chegou</span>
        {podeEditar && (
          <button type="button" className="cpv2-btn" style={{ padding: '1px 6px', fontSize: 11, marginLeft: 6 }}
            onClick={() => setAberto(true)} title="Registrar comprovante">
            <Plus size={11} />
          </button>
        )}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 }}>
      <input type="date" value={data} onChange={(e) => setData(e.target.value)} />
      <select value={fonte} onChange={(e) => setFonte(e.target.value)}>
        <option value="email">E-mail</option>
        <option value="whatsapp">WhatsApp</option>
        <option value="manual">Manual</option>
      </select>
      <input placeholder="Referência (assunto, conversa…)" value={ref} onChange={(e) => setRef(e.target.value)} />
      <span style={{ display: 'flex', gap: 4 }}>
        <button type="button" className="cpv2-btn cpv2-btn--primary" disabled={!data}
          onClick={async () => { await onRegistrar(p.id_processo, { data, fonte, referencia: ref }); setAberto(false); }}>
          Salvar
        </button>
        <button type="button" className="cpv2-btn" onClick={() => setAberto(false)}>Cancelar</button>
      </span>
    </div>
  );
}

function Card({ titulo, valor, sub }) {
  return (
    <div style={{
      background: 'var(--cpv2-surface-2)', border: '1px solid var(--cpv2-border)', borderRadius: 10,
      padding: '10px 14px', minWidth: 170, flex: '1 1 170px',
    }}>
      <div style={{ fontSize: 11, color: 'var(--cpv2-text-muted)' }}>{titulo}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{valor}</div>
      {sub ? <div style={{ fontSize: 11, color: 'var(--cpv2-text-muted)' }}>{sub}</div> : null}
    </div>
  );
}

export default function RelatorioPriorizacaoModal({ isOpen, onClose, podeEditar }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [encerrados, setEncerrados] = useState(false);
  const [filtro, setFiltro] = useState('todos');
  const [busca, setBusca] = useState('');
  const [mesRel, setMesRel] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const [gerando, setGerando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true); setErro('');
    try {
      setDados(await getRelatorioPriorizacao({ encerrados }));
    } catch (e) {
      setErro(e?.response?.data?.error || 'Não foi possível carregar o relatório.');
    } finally {
      setCarregando(false);
    }
  }, [encerrados]);

  useEffect(() => { if (isOpen) carregar(); }, [isOpen, carregar]);

  const atualizarLocal = (id, patch) => setDados((d) => (d ? {
    ...d, processos: d.processos.map((p) => (p.id_processo === id ? { ...p, ...patch } : p)),
  } : d));

  const mudarEstrela = async (id, estrela) => {
    const antes = dados.processos.find((p) => p.id_processo === id)?.estrela;
    atualizarLocal(id, { estrela });
    try { await salvarPriorizacao(id, { estrela }); } catch { atualizarLocal(id, { estrela: antes }); setErro('Falha ao salvar a estrela.'); }
  };
  const mudarData = async (id, data_manual) => {
    atualizarLocal(id, { data_manual });
    try { await salvarPriorizacao(id, { data_manual }); } catch { setErro('Falha ao salvar a data.'); }
  };
  const salvarObs = async (id, observacao) => {
    try { await salvarPriorizacao(id, { observacao }); } catch { setErro('Falha ao salvar a observação.'); }
  };
  const onRegistrar = async (id, payload) => {
    try { await registrarComprovante(id, payload); await carregar(); } catch (e) { setErro(e?.response?.data?.error || 'Falha ao registrar.'); }
  };
  const onApagar = async (idc) => {
    try { await apagarComprovante(idc); await carregar(); } catch { setErro('Falha ao apagar.'); }
  };

  const procs = useMemo(() => dados?.processos || [], [dados]);
  const resumo = useMemo(() => {
    const g = (lst) => ({ n: lst.length, amee: lst.reduce((s, p) => s + (p.total_amee || 0), 0) });
    const mesAtual = new Date().toISOString().slice(0, 7);
    return {
      todos: g(procs.filter((p) => p.deferido)),
      p1: g(procs.filter((p) => p.estrela === 1)),
      p2: g(procs.filter((p) => p.estrela === 2)),
      demais: g(procs.filter((p) => !p.estrela)),
      comprovados: g(procs.filter((p) => p.comprovante)),
      compMes: g(procs.filter((p) => p.comprovante && p.comprovante.data.slice(0, 7) === mesAtual)),
      atrasados: procs.filter((p) => !p.comprovante && p.dias_para_estimada != null && p.dias_para_estimada < 0).length,
    };
  }, [procs]);

  const visiveis = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return procs.filter((p) => {
      if (filtro === 'p1' && p.estrela !== 1) return false;
      if (filtro === 'p2' && p.estrela !== 2) return false;
      if (filtro === 'marcados' && !p.estrela) return false;
      if (filtro === 'sem' && p.estrela) return false;
      if (filtro === 'semcomp' && p.comprovante) return false;
      if (!q) return true;
      return [p.id_processo, p.cliente, p.concessionaria, p.uc].some((v) => String(v || '').toLowerCase().includes(q));
    }).sort((a, b) => (a.estrela || 9) - (b.estrela || 9) || (b.total_amee || 0) - (a.total_amee || 0));
  }, [procs, filtro, busca]);

  const gerar = async () => {
    setGerando(true); setErro('');
    try {
      await baixarRelatorioPriorizacaoXlsx(mesRel);
    } catch {
      setErro('Não foi possível gerar o relatório.');
    } finally {
      setGerando(false);
    }
  };

  if (!isOpen) return null;
  const th = { textAlign: 'left', padding: '8px 10px', fontSize: 11.5, color: 'var(--cpv2-text-muted)', borderBottom: '1px solid var(--cpv2-border)', position: 'sticky', top: 0, background: 'var(--cpv2-surface)', zIndex: 1, whiteSpace: 'nowrap' };
  const td = { padding: '7px 10px', borderBottom: '1px solid var(--cpv2-border)', verticalAlign: 'top' };

  const modal = (
    <div className="cpv2-root" style={{ minHeight: 0 }}>
      <div className="cpv2-modal-backdrop cpv2-modal-backdrop--full" onClick={onClose}
        style={{ zIndex: 200, padding: 0, alignItems: 'stretch', justifyContent: 'stretch' }}>
        <div className="cpv2-modal cpv2-modal--full" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div className="cpv2-modal__head">
            <div>
              <h3>Priorização de casos deferidos</h3>
              <p>
                Estrela grande = prioridade 1 · estrela pequena = prioridade 2 · sem estrela = fora da lista (entra no resumo).
                {dados?.media_geral_dias != null ? ` Tempo médio até o comprovante: ${dados.media_geral_dias} dias (procedências desde ${br(dados.inicio_media)}).` : ''}
              </p>
            </div>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" className="cpv2-btn" onClick={carregar} disabled={carregando}><RefreshCw size={14} /> Atualizar</button>
              <input type="month" value={mesRel} onChange={(e) => setMesRel(e.target.value)} title="Mês de referência do relatório" />
              <button type="button" className="cpv2-btn cpv2-btn--primary" onClick={gerar} disabled={gerando || !mesRel}>
                <Download size={14} /> {gerando ? 'Gerando…' : 'Gerar relatório'}
              </button>
              <button type="button" className="cpv2-modal__close" onClick={onClose} aria-label="Fechar"><X size={18} /></button>
            </span>
          </div>

          <div style={{ padding: '12px 18px', display: 'flex', gap: 10, flexWrap: 'wrap', borderBottom: '1px solid var(--cpv2-border)' }}>
            <Card titulo="Prioridade 1" valor={resumo.p1.n} sub={brl(resumo.p1.amee)} />
            <Card titulo="Prioridade 2" valor={resumo.p2.n} sub={brl(resumo.p2.amee)} />
            <Card titulo="Demais deferidos" valor={resumo.demais.n} sub={brl(resumo.demais.amee)} />
            <Card titulo="Total deferidos" valor={resumo.todos.n} sub={brl(resumo.todos.amee)} />
            <Card titulo="Comprovantes no mês" valor={resumo.compMes.n} sub={brl(resumo.compMes.amee)} />
            <Card titulo="Passaram da data estimada" valor={resumo.atrasados} sub="sem comprovante" />
          </div>

          <div style={{ padding: '10px 18px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={filtro} onChange={(e) => setFiltro(e.target.value)}>
              <option value="todos">Todos os deferidos</option>
              <option value="marcados">Só marcados (P1 + P2)</option>
              <option value="p1">Prioridade 1</option>
              <option value="p2">Prioridade 2</option>
              <option value="sem">Sem estrela</option>
              <option value="semcomp">Sem comprovante</option>
            </select>
            <input placeholder="Buscar processo, cliente, distribuidora, UC" value={busca}
              onChange={(e) => setBusca(e.target.value)} style={{ minWidth: 280 }} />
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={encerrados} onChange={(e) => setEncerrados(e.target.checked)} /> Incluir encerrados
            </label>
            <span style={{ color: 'var(--cpv2-text-muted)' }}>{visiveis.length} de {procs.length} processos</span>
            {erro ? <span style={{ color: 'var(--cpv2-danger)' }}>{erro}</span> : null}
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: '0 18px 18px' }}>
            {carregando && !dados ? <p>Carregando…</p> : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr>
                    <th style={th}>Prioridade</th>
                    <th style={th}>Processo</th>
                    <th style={th}>Cliente</th>
                    <th style={th}>Distribuidora</th>
                    <th style={th}>Instância / etapa</th>
                    <th style={th}>Procedência</th>
                    <th style={{ ...th, textAlign: 'right' }}>Repasse AMEE</th>
                    <th style={th}>Comprovante</th>
                    <th style={th}>Data estimada (sistema)</th>
                    <th style={th}>Data prevista (manual)</th>
                    <th style={th}>Observação</th>
                    <th style={th}>Última mov.</th>
                  </tr>
                </thead>
                <tbody>
                  {visiveis.map((p) => (
                    <tr key={p.id_processo}>
                      <td style={td}><Estrelas valor={p.estrela} disabled={!podeEditar} onChange={(v) => mudarEstrela(p.id_processo, v)} /></td>
                      <td style={td}><a href={`/processos/${p.id_processo}`} target="_blank" rel="noreferrer">{p.id_processo}</a><div style={{ fontSize: 11, color: 'var(--cpv2-text-muted)' }}>UC {p.uc}</div>
                        {!p.deferido ? <div style={{ fontSize: 10.5, color: 'var(--cpv2-warning, #b45309)' }} title="Marcado na lista, mas ainda não está deferido no sistema">não deferido</div> : null}</td>
                      <td style={td}>{p.cliente}</td>
                      <td style={td}>{p.concessionaria}</td>
                      <td style={td}>{p.instancia}<div style={{ fontSize: 11, color: 'var(--cpv2-text-muted)' }}>{p.etapa}{p.status ? ` · ${p.status}` : ''}</div></td>
                      <td style={td}>{br(p.data_procedencia)}</td>
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>{brl(p.total_amee)}</td>
                      <td style={td}><ComprovanteCell p={p} podeEditar={podeEditar} onRegistrar={onRegistrar} onApagar={onApagar} /></td>
                      <td style={td}>
                        {p.comprovante ? <span style={{ color: 'var(--cpv2-text-soft)' }}>—</span> : p.data_estimada ? (
                          <div style={{ lineHeight: 1.3 }}>
                            <div style={{ fontWeight: 600, color: p.dias_para_estimada < 0 ? 'var(--cpv2-danger)' : undefined }}>{br(p.data_estimada)}</div>
                            <div style={{ fontSize: 11, color: 'var(--cpv2-text-muted)' }}>
                              {p.dias_para_estimada < 0 ? `${-p.dias_para_estimada} dias de atraso` : `em ${p.dias_para_estimada} dias`} · {p.base_estimativa}
                            </div>
                          </div>
                        ) : <span style={{ color: 'var(--cpv2-text-soft)' }}>sem procedência</span>}
                      </td>
                      <td style={td}>
                        <input type="date" value={p.data_manual || ''} disabled={!podeEditar}
                          onChange={(e) => mudarData(p.id_processo, e.target.value)} />
                      </td>
                      <td style={td}>
                        <textarea rows={2} style={{ minWidth: 200, width: '100%', resize: 'vertical', font: 'inherit' }}
                          disabled={!podeEditar} value={p.observacao || ''} placeholder="Motivo, combinado com a distribuidora…"
                          onChange={(e) => atualizarLocal(p.id_processo, { observacao: e.target.value })}
                          onBlur={(e) => salvarObs(p.id_processo, e.target.value)} />
                      </td>
                      <td style={td}>{br(p.ultima_movimentacao)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
  return createPortal(modal, document.body);
}
