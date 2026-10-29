// src/pages/Prazos.jsx
// Página dedicada de Prazos — processos "Aguardando retorno" com prazo vencido/crítico,
// por instância (Distribuidora/Ouvidoria: dias úteis; ANEEL/SMA: dias corridos).
// Extraída do bloco "Tabela de prazos" que vivia embutido em HomeGestorAdmin.jsx.

import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Clock, Mail, Loader2, AlertTriangle, Building2, Zap, CalendarClock, ChevronRight, ChevronDown,
} from 'lucide-react';
import { getProcessosComPrazo, getHistoricoById } from '../services/requisicaoService';
import Toast from '../components/Toast.jsx';
import { CobrancaEmailModal } from './HomeGestorAdmin.jsx';

const thStyle = {
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 700,
  padding: '8px 10px',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  opacity: 0.7,
  color: 'var(--fg)',
  whiteSpace: 'nowrap',
};

const tdStyle = {
  padding: '10px',
  fontSize: 12.5,
  color: 'var(--fg)',
  verticalAlign: 'top',
};

export default function Prazos() {
  const navigate = useNavigate();

  const [prazos, setPrazos] = React.useState({ grupos: {}, rows: [], count: 0 });
  const [errPrazos, setErrPrazos] = React.useState('');

  const [expandedIds, setExpandedIds] = React.useState(() => new Set());
  const [historicos, setHistoricos] = React.useState({});

  const toggleExpand = React.useCallback((idProcesso) => {
    if (!idProcesso) return;
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(idProcesso)) {
        next.delete(idProcesso);
        return next;
      }
      next.add(idProcesso);
      return next;
    });
    setHistoricos((prev) => {
      if (prev[idProcesso]?.data || prev[idProcesso]?.loading) return prev;
      const ret = { ...prev, [idProcesso]: { loading: true, data: null, error: '' } };
      getHistoricoById(idProcesso)
        .then((rows) => {
          setHistoricos((cur) => ({
            ...cur,
            [idProcesso]: { loading: false, data: Array.isArray(rows) ? rows : [], error: '' },
          }));
        })
        .catch(() => {
          setHistoricos((cur) => ({
            ...cur,
            [idProcesso]: { loading: false, data: [], error: 'Falha ao carregar histórico.' },
          }));
        });
      return ret;
    });
  }, []);

  const [toast, setToast] = React.useState({ open: false, type: 'info', text: '' });
  const [cobrancaModal, setCobrancaModal] = React.useState(null);

  const [filtroEtapa, setFiltroEtapa] = React.useState('todas');
  const [filtroStatus, setFiltroStatus] = React.useState('todos'); // todos | vencidos | urgentes | no_prazo
  const [busca, setBusca] = React.useState('');

  const carregarPrazos = React.useCallback(async () => {
    try {
      const resp = await getProcessosComPrazo();
      setPrazos(resp || { grupos: {}, rows: [], count: 0 });
      setErrPrazos('');
    } catch (e) {
      setErrPrazos('Falha ao carregar prazos críticos.');
    }
  }, []);

  React.useEffect(() => {
    carregarPrazos();
    // ⭐ Refaz o fetch quando um processo muda de instância/etapa/status (evento disparado
    // pelos serviços de movimentar/suspender/retomar/descartar) e ao voltar o foco/aba —
    // senão a lista de Prazos ficava com o processo que já saiu do status "Aguardando retorno".
    const onAtualizado = () => carregarPrazos();
    const onFocus = () => carregarPrazos();
    const onVisibility = () => { if (document.visibilityState === 'visible') carregarPrazos(); };
    window.addEventListener('processo:atualizado', onAtualizado);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('processo:atualizado', onAtualizado);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [carregarPrazos]);

  const todosPrazos = React.useMemo(() => {
    const flat = [];
    Object.entries(prazos.grupos || {}).forEach(([etapa, arr]) => {
      (arr || []).forEach((r) => flat.push({ ...r, _etapa: etapa }));
    });
    return flat;
  }, [prazos]);

  const classifica = (r) => {
    const dias = Number(r?.dias_restantes ?? 0);
    if (r?.atrasado) return 'vencido';
    if (dias < 2) return 'urgente';
    return 'no_prazo';
  };

  const kpis = React.useMemo(() => {
    const out = { total: todosPrazos.length, vencidos: 0, urgentes: 0, no_prazo: 0 };
    todosPrazos.forEach((r) => {
      const c = classifica(r);
      out[c === 'vencido' ? 'vencidos' : c === 'urgente' ? 'urgentes' : 'no_prazo']++;
    });
    return out;
  }, [todosPrazos]);

  const etapasFiltro = React.useMemo(() => {
    const map = new Map();
    todosPrazos.forEach((r) => {
      const k = r._etapa || 'Outros';
      map.set(k, (map.get(k) || 0) + 1);
    });
    return Array.from(map.entries()).map(([etapa, count]) => ({ etapa, count }));
  }, [todosPrazos]);

  const linhasFiltradas = React.useMemo(() => {
    const term = busca.trim().toLowerCase();
    return todosPrazos
      .filter((r) => {
        if (filtroEtapa !== 'todas' && r._etapa !== filtroEtapa) return false;
        if (filtroStatus !== 'todos') {
          const c = classifica(r);
          if (filtroStatus === 'vencidos' && c !== 'vencido') return false;
          if (filtroStatus === 'urgentes' && c !== 'urgente') return false;
          if (filtroStatus === 'no_prazo' && c !== 'no_prazo') return false;
        }
        if (term) {
          const blob = `${r.id_processo || ''} ${r.uc || ''} ${r.cliente || ''} ${r.concessionaria || ''} ${r.sub_etapa || ''}`.toLowerCase();
          if (!blob.includes(term)) return false;
        }
        return true;
      })
      .sort((a, b) => (a.deadline_unix || 0) - (b.deadline_unix || 0));
  }, [todosPrazos, filtroEtapa, filtroStatus, busca]);

  return (
    <div className="p-4 md:p-6 bg-background text-foreground min-h-screen">
      <div className="mb-4">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Clock size={20} style={{ color: 'var(--accent)' }} />
          Prazos
        </h1>
        <p className="opacity-80 text-sm">
          Processos em "Aguardando retorno" — prazo por instância (Distribuidora 5 dias úteis,
          Ouvidoria 10 dias úteis, ANEEL 30 dias corridos, SMA 30 dias corridos).
        </p>
      </div>

      {/* KPI Hero — 4 indicadores principais */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {[
          { label: 'Total ativos', value: kpis.total, color: 'var(--accent)', filter: 'todos' },
          { label: 'Vencidos', value: kpis.vencidos, color: 'var(--danger)', filter: 'vencidos' },
          { label: 'Urgentes (<2d)', value: kpis.urgentes, color: 'var(--warning)', filter: 'urgentes' },
          { label: 'No prazo', value: kpis.no_prazo, color: 'var(--success)', filter: 'no_prazo' },
        ].map((k) => (
          <button
            key={k.label}
            type="button"
            onClick={() => setFiltroStatus(k.filter)}
            className="text-left rounded-xl border-2 px-4 py-3 transition-all hover:scale-[1.01]"
            style={{
              background: filtroStatus === k.filter
                ? `color-mix(in srgb, ${k.color} 14%, var(--card))`
                : 'var(--card)',
              borderColor: filtroStatus === k.filter ? k.color : 'var(--border)',
              cursor: 'pointer',
            }}
          >
            <div className="text-[10px] uppercase tracking-wide opacity-60 mb-1">{k.label}</div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-extrabold tabular-nums" style={{ color: k.color }}>{k.value}</span>
              <span className="text-xs opacity-50">{k.value === 1 ? 'processo' : 'processos'}</span>
            </div>
          </button>
        ))}
      </div>

      {/* Tabela de prazos com filtros */}
      <div className="rounded-xl border-2 panel-border bg-[var(--panel)] mb-4 overflow-hidden">
        <div className="px-3 py-2.5 border-b panel-border flex flex-wrap items-center gap-2">
          <Clock size={15} style={{ color: 'var(--accent)' }} />
          <span className="text-sm font-bold mr-2">Prazos por etapa</span>

          <button
            type="button"
            onClick={() => setFiltroEtapa('todas')}
            className="text-xs font-semibold px-2.5 py-1 rounded border transition-colors"
            style={{
              borderColor: filtroEtapa === 'todas' ? 'var(--accent)' : 'var(--border)',
              background: filtroEtapa === 'todas' ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
              color: filtroEtapa === 'todas' ? 'var(--accent)' : 'var(--fg)',
            }}
          >
            Todas ({todosPrazos.length})
          </button>
          {etapasFiltro.map(({ etapa, count }) => (
            <button
              key={etapa}
              type="button"
              onClick={() => setFiltroEtapa(etapa)}
              className="text-xs font-semibold px-2.5 py-1 rounded border transition-colors"
              style={{
                borderColor: filtroEtapa === etapa ? 'var(--accent)' : 'var(--border)',
                background: filtroEtapa === etapa ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                color: filtroEtapa === etapa ? 'var(--accent)' : 'var(--fg)',
              }}
            >
              {etapa} ({count})
            </button>
          ))}

          <input
            type="text"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por ID, UC, cliente..."
            className="ml-auto text-xs px-3 py-1.5 rounded border panel-border bg-[var(--panel)] focus:outline-none focus:border-[var(--accent)]"
            style={{ minWidth: 220, color: 'var(--fg)' }}
          />
        </div>

        {errPrazos ? (
          <div className="text-red-500 text-sm p-4 text-center">{errPrazos}</div>
        ) : linhasFiltradas.length === 0 ? (
          <div className="opacity-60 text-sm p-8 text-center">
            {todosPrazos.length === 0
              ? 'Nenhum processo em prazo crítico no momento.'
              : 'Nenhum processo encontrado com os filtros atuais.'}
          </div>
        ) : (
          <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{
                position: 'sticky', top: 0, zIndex: 1,
                background: 'var(--panel)', borderBottom: '1px solid var(--border)',
              }}>
                <tr>
                  <th style={{ ...thStyle, width: 32, padding: '8px 4px' }} aria-label="Expandir histórico"></th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Processo</th>
                  <th style={thStyle}>Cliente / UC</th>
                  <th style={thStyle}>Concessionária</th>
                  <th style={thStyle}>Etapa / Sub</th>
                  <th style={{ ...thStyle, textAlign: 'center' }}>Sem mov.</th>
                  <th style={thStyle}>Prazo</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Ação</th>
                </tr>
              </thead>
              <tbody>
                {linhasFiltradas.map((r, idx) => {
                  const dias = Number(r?.dias_restantes ?? 0);
                  const hrs = Number(r?.horas_restantes ?? 0);
                  const c = classifica(r);
                  const cor = c === 'vencido' ? 'var(--danger)' : c === 'urgente' ? 'var(--warning)' : 'var(--accent)';
                  const diasMov = r?.data_base_unix
                    ? Math.max(0, Math.floor((Date.now() - Number(r.data_base_unix) * 1000) / 86400000))
                    : null;
                  const diasAtraso = c === 'vencido' ? Math.abs(Math.round(dias)) : 0;
                  const isExpanded = expandedIds.has(r.id_processo);
                  const histState = historicos[r.id_processo];
                  return (
                    <React.Fragment key={`${r._etapa}-${r.id_processo ?? 'pid'}-${idx}`}>
                    <tr
                      style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                      onClick={() => navigate(`/processos/${r.id_processo}`)}
                    >
                      <td
                        style={{ ...tdStyle, padding: '8px 4px', textAlign: 'center', width: 32 }}
                        onClick={(e) => { e.stopPropagation(); toggleExpand(r.id_processo); }}
                        title={isExpanded ? 'Esconder histórico' : 'Mostrar histórico'}
                      >
                        <button
                          type="button"
                          aria-label={isExpanded ? 'Esconder histórico' : 'Mostrar histórico'}
                          style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            padding: 4, borderRadius: 4, background: 'transparent', border: 'none',
                            cursor: 'pointer', color: 'var(--fg)', opacity: 0.7,
                          }}
                        >
                          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td style={tdStyle}>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          fontSize: 11, fontWeight: 700, padding: '3px 8px',
                          borderRadius: 6, whiteSpace: 'nowrap',
                          background: cor, color: '#fff',
                        }}>
                          {c === 'vencido' && <AlertTriangle size={10} />}
                          {c === 'urgente' && <Zap size={10} />}
                          {c === 'no_prazo' && <CalendarClock size={10} />}
                          {c === 'vencido' ? `Vencido ${diasAtraso}d` : c === 'urgente' ? 'Urgente' : `${Math.floor(dias)}d ${Math.floor(hrs % 24)}h`}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, fontWeight: 700, color: cor, fontFamily: 'monospace' }}>
                        #{r.id_processo}
                      </td>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 600, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.cliente || '—'}
                        </div>
                        <div style={{ fontSize: 11, opacity: 0.6 }}>UC {r.uc || '—'}</div>
                      </td>
                      <td style={tdStyle}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Building2 size={11} style={{ opacity: 0.6 }} />
                          {r.concessionaria || '—'}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--accent)' }}>{r._etapa}</div>
                        <div style={{ fontSize: 11, opacity: 0.65, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.sub_etapa || 'Aguardando retorno'}
                        </div>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                        <span style={{ color: diasMov && diasMov > 14 ? 'var(--warning)' : 'var(--fg)', opacity: diasMov && diasMov > 14 ? 1 : 0.7 }}>
                          {diasMov != null ? `${diasMov}d` : '—'}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span style={{
                          color: c === 'vencido' ? 'var(--danger)' : 'var(--fg)',
                          fontVariantNumeric: 'tabular-nums',
                          opacity: c === 'vencido' ? 1 : 0.75,
                        }}>
                          {r.deadline ? new Date(r.deadline).toLocaleDateString('pt-BR') : '—'}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setCobrancaModal(r); }}
                          title="Enviar e-mail de cobrança"
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 5,
                            padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                            background: c === 'vencido' ? 'color-mix(in srgb, var(--danger) 15%, transparent)' : 'color-mix(in srgb, var(--accent) 12%, transparent)',
                            border: c === 'vencido' ? '1px solid color-mix(in srgb, var(--danger) 45%, transparent)' : '1px solid color-mix(in srgb, var(--accent) 35%, transparent)',
                            color: c === 'vencido' ? 'var(--danger)' : 'var(--accent)',
                            cursor: 'pointer', whiteSpace: 'nowrap',
                          }}
                        >
                          <Mail size={11} /> Cobrar
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr style={{ background: 'rgba(0,0,0,0.18)', borderBottom: '1px solid var(--border)' }}>
                        <td></td>
                        <td colSpan={8} style={{ padding: '12px 14px' }}>
                          <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.75, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                            Histórico do processo #{r.id_processo}
                          </div>
                          {histState?.loading ? (
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.7 }}>
                              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                              Carregando histórico…
                            </div>
                          ) : histState?.error ? (
                            <div style={{ fontSize: 12, color: 'var(--danger)' }}>{histState.error}</div>
                          ) : !histState?.data || histState.data.length === 0 ? (
                            <div style={{ fontSize: 12, opacity: 0.6 }}>Nenhum registro no histórico.</div>
                          ) : (
                            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {histState.data.map((h, i) => {
                                const dataMov = h?.data_movimentacao || h?.data || h?.created_at || h?.dt_movimentacao;
                                const quem = h?.usuario_nome || h?.usuario || h?.nome_usuario || h?.created_by || '—';
                                const acao = h?.acao || h?.descricao || h?.evento || h?.tipo || '—';
                                const detalhe = h?.detalhe || h?.observacao || h?.comentario || '';
                                return (
                                  <li key={h?.id_historico ?? h?.id ?? i}
                                      style={{ borderLeft: '2px solid var(--accent)', paddingLeft: 10, fontSize: 12 }}>
                                    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                                      <span style={{ fontFamily: 'monospace', opacity: 0.7 }}>
                                        {dataMov ? new Date(dataMov).toLocaleString('pt-BR') : '—'}
                                      </span>
                                      <span style={{ fontWeight: 600 }}>{acao}</span>
                                      <span style={{ opacity: 0.6 }}>· {quem}</span>
                                    </div>
                                    {detalhe && (
                                      <div style={{ marginTop: 2, opacity: 0.75, fontSize: 11.5 }}>{detalhe}</div>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {cobrancaModal && (
        <CobrancaEmailModal
          processo={cobrancaModal}
          onClose={() => setCobrancaModal(null)}
          onSent={() => setToast({ open: true, type: 'success', text: 'E-mail de cobrança enviado com sucesso!' })}
        />
      )}

      <Toast
        open={toast.open}
        type={toast.type}
        message={toast.text}
        onClose={() => setToast((t) => ({ ...t, open: false }))}
      />
    </div>
  );
}
