// src/pages/HomeGestorAdmin.jsx

import React, { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import Toast from '../components/Toast.jsx';
import { Clock, Mail, Loader2, X, Send, Sparkles, Check, AlertTriangle, User, Building2, Zap, CalendarClock, ChevronRight, ChevronDown } from 'lucide-react';
import { getProcessosComPrazo, getHistoricoById } from '../services/requisicaoService';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import apiClient from '../services/apiClient';

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

const formatDateTimeBR = (value) => {
  if (!value) return '-';
  const raw = String(value).trim();
  if (!raw) return '-';
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return raw;
  return dt.toLocaleString('pt-BR');
};

/* ─── QUILL MODULES (toolbar mínima para email) ─── */
const COBRANCA_QUILL_MODULES = {
  toolbar: [
    ['bold', 'italic', 'underline'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    ['clean'],
  ],
};

/* ─── Modal de cobrança de retorno ─── */
function CobrancaEmailModal({ processo, onClose, onSent }) {
  const [para, setPara] = React.useState('');
  const [assunto, setAssunto] = React.useState('');
  const [body, setBody] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [opcoes, setOpcoes] = React.useState(null); // { opcao1, opcao2, subject }
  const [opcaoIdx, setOpcaoIdx] = React.useState(0); // 0 = opcao1, 1 = opcao2
  const [error, setError] = React.useState('');
  const quillRef = useRef(null);

  const pid = processo?.id_processo;
  const uc = processo?.uc || '';
  const cliente = processo?.cliente || '';
  const concessionaria = processo?.concessionaria || '';
  const subEtapa = processo?.sub_etapa || 'Aguardando retorno';

  // Paste-image inline
  useEffect(() => {
    const editor = quillRef.current?.getEditor();
    if (!editor) return;
    const handler = (e) => {
      const items = e.clipboardData?.items || [];
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          const reader = new FileReader();
          reader.onload = (ev) => {
            const range = editor.getSelection(true);
            editor.insertEmbed(range.index, 'image', ev.target.result);
          };
          reader.readAsDataURL(file);
        }
      }
    };
    editor.root.addEventListener('paste', handler);
    return () => editor.root.removeEventListener('paste', handler);
  }, []);

  const handleAnalisarIA = async () => {
    setLoading(true);
    setOpcoes(null);
    setOpcaoIdx(0);
    setError('');
    try {
      const { data } = await apiClient.post(`/processos/${pid}/gerar-cobranca`);
      setOpcoes(data);
      if (data.subject) setAssunto(data.subject);
      const html = data.opcao1 || data.opcao2 || '';
      setBody(html);
    } catch (e) {
      setError('Falha ao analisar histórico com IA. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  const handleGerarNovamente = async () => {
    if (!opcoes) { handleAnalisarIA(); return; }
    // Cycle to the other option first; if both exhausted, call API again
    const nextIdx = opcaoIdx === 0 ? 1 : 0;
    const nextHtml = nextIdx === 0 ? opcoes.opcao1 : opcoes.opcao2;
    if (nextHtml && nextIdx !== opcaoIdx) {
      setOpcaoIdx(nextIdx);
      setBody(nextHtml);
    } else {
      // Fetch fresh from API
      setLoading(true);
      setError('');
      try {
        const { data } = await apiClient.post(`/processos/${pid}/gerar-cobranca`);
        setOpcoes(data);
        setOpcaoIdx(0);
        if (data.subject) setAssunto(data.subject);
        setBody(data.opcao1 || data.opcao2 || '');
      } catch (e) {
        setError('Falha ao gerar nova sugestão. Tente novamente.');
      } finally {
        setLoading(false);
      }
    }
  };

  const handleEnviar = async () => {
    if (!para.trim()) { setError('Informe o e-mail destinatário.'); return; }
    if (!assunto.trim()) { setError('Informe o assunto.'); return; }
    if (!body.trim() || body === '<p><br></p>') { setError('O corpo do e-mail está vazio.'); return; }
    setSending(true);
    setError('');
    try {
      await apiClient.post(`/processos/${pid}/emails`, {
        para: para.trim(),
        assunto: assunto.trim(),
        corpo: body,
      });
      onSent?.();
      onClose();
    } catch (e) {
      setError('Falha ao enviar e-mail. Verifique sua permissão de envio.');
    } finally {
      setSending(false);
    }
  };

  const modal = (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: '100%', maxWidth: 860, maxHeight: '96vh',
          borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column',
          background: 'var(--card)', border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-elevated)',
        }}
      >
        {/* Header */}
        <div style={{
          background: 'linear-gradient(135deg, #1e3a5f, #0f2340)',
          padding: '14px 18px', display: 'flex', alignItems: 'flex-start', gap: 12,
          borderBottom: '1px solid #1e3050',
        }}>
          <Mail size={18} style={{ color: '#60a5fa', marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 14 }}>
              Cobrança de Retorno — Proc #{pid}
            </div>
            <div style={{ color: '#93c5fd', fontSize: 12, marginTop: 2, opacity: 0.85 }}>
              UC {uc} · {cliente} · {concessionaria}
            </div>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4,
              background: 'rgba(239,68,68,0.2)', border: '1px solid rgba(239,68,68,0.4)',
              borderRadius: 6, padding: '1px 7px', fontSize: 11, color: '#fca5a5',
            }}>
              <Clock size={10} /> {subEtapa}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ color: '#93c5fd', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Fields */}
        <div style={{ padding: '12px 16px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--fg)', opacity: 0.6, width: 60, flexShrink: 0 }}>Para</span>
            <input
              type="email"
              placeholder="email@concessionaria.com.br"
              value={para}
              onChange={(e) => setPara(e.target.value)}
              style={{
                flex: 1, background: 'color-mix(in srgb, var(--panel) 90%, transparent)',
                border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px',
                color: 'var(--fg)', fontSize: 13,
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--fg)', opacity: 0.6, width: 60, flexShrink: 0 }}>Assunto</span>
            <input
              type="text"
              placeholder="Assunto do e-mail"
              value={assunto}
              onChange={(e) => setAssunto(e.target.value)}
              style={{
                flex: 1, background: 'color-mix(in srgb, var(--panel) 90%, transparent)',
                border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px',
                color: 'var(--fg)', fontSize: 13,
              }}
            />
          </div>
        </div>

        {/* AI Button + Opcoes */}
        <div style={{ padding: '10px 16px 0' }}>
          <button
            onClick={handleAnalisarIA}
            disabled={loading}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: loading ? 'rgba(37,99,235,0.15)' : 'linear-gradient(135deg, #1d4ed8, #3b82f6)',
              color: loading ? '#93c5fd' : '#fff',
              border: '1px solid rgba(59,130,246,0.4)',
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'all 150ms',
            }}
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {loading ? 'Analisando histórico...' : 'Analisar histórico com IA'}
          </button>

          {opcoes && (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Check size={12} /> Sugestão aplicada ao corpo do e-mail
              </span>
              <button
                onClick={handleGerarNovamente}
                disabled={loading}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  color: 'var(--fg)', cursor: loading ? 'not-allowed' : 'pointer',
                  opacity: loading ? 0.5 : 1,
                }}
              >
                {loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                Gerar novamente
              </button>
            </div>
          )}
        </div>

        {/* Editor */}
        <div style={{ flex: 1, minHeight: 0, padding: '10px 16px 0', display: 'flex', flexDirection: 'column' }}>
          <div style={{
            flex: 1, minHeight: 320,
            border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden',
            background: 'color-mix(in srgb, var(--panel) 80%, transparent)',
          }}>
            <ReactQuill
              ref={quillRef}
              theme="snow"
              value={body}
              onChange={setBody}
              modules={COBRANCA_QUILL_MODULES}
              style={{ height: 320 }}
              placeholder="Escreva o corpo do e-mail aqui, ou use a análise de IA acima..."
            />
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--border)' }}>
          {error ? (
            <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>
          ) : (
            <span style={{ fontSize: 11, color: 'var(--fg)', opacity: 0.5 }}>
              Enviará via caixa de e-mail configurada
            </span>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={onClose}
              style={{
                padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                background: 'transparent', border: '1px solid var(--border)',
                color: 'var(--fg)', cursor: 'pointer',
              }}
            >
              Cancelar
            </button>
            <button
              onClick={handleEnviar}
              disabled={sending}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '7px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                background: sending ? 'rgba(37,99,235,0.4)' : 'linear-gradient(135deg, #1d4ed8, #3b82f6)',
                color: '#fff', border: 'none', cursor: sending ? 'not-allowed' : 'pointer',
              }}
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {sending ? 'Enviando...' : 'Enviar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

/* ─── Página principal ─── */
export default function HomeGestorAdmin() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [prazos, setPrazos] = React.useState({ grupos: {}, rows: [], count: 0 });
  const [errPrazos, setErrPrazos] = React.useState('');

  // Linhas expandidas: histórico do processo aparece embaixo da linha selecionada.
  // expandedIds: ids cuja seta está apontando pra baixo (mostrando histórico).
  // historicos: cache por id { loading, data: [], error }.
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
    // Só dispara fetch se ainda não tiver dado em cache
    setHistoricos((prev) => {
      if (prev[idProcesso]?.data || prev[idProcesso]?.loading) return prev;
      const ret = { ...prev, [idProcesso]: { loading: true, data: null, error: '' } };
      // Fire and forget — atualiza o estado quando voltar
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

  const [acoes, setAcoes] = React.useState(null);
  const [loadingAcoes, setLoadingAcoes] = React.useState(true);
  const [acoesExpanded, setAcoesExpanded] = React.useState({
    urgente: true, sem_movimentacao: false, aguardando_resposta: false, emails_nao_lidos: false,
  });

  // Filtros da tabela
  const [filtroEtapa, setFiltroEtapa] = React.useState('todas');
  const [filtroStatus, setFiltroStatus] = React.useState('todos'); // todos | vencidos | urgentes | no_prazo
  const [busca, setBusca] = React.useState('');
  const [avisosOpen, setAvisosOpen] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      try {
        const resp = await getProcessosComPrazo();
        setPrazos(resp || { grupos: {}, rows: [], count: 0 });
        setErrPrazos('');
      } catch (e) {
        setErrPrazos('Falha ao carregar prazos críticos.');
      }
    })();
  }, []);

  React.useEffect(() => {
    (async () => {
      setLoadingAcoes(true);
      try {
        const { data } = await apiClient.get('/acoes-do-dia');
        setAcoes(data);
      } catch { /* silencioso */ }
      finally { setLoadingAcoes(false); }
    })();
  }, []);

  // Aplaina todos os processos em uma única lista (com etapa)
  const todosPrazos = React.useMemo(() => {
    const flat = [];
    Object.entries(prazos.grupos || {}).forEach(([etapa, arr]) => {
      (arr || []).forEach((r) => flat.push({ ...r, _etapa: etapa }));
    });
    return flat;
  }, [prazos]);

  // Classifica cada item
  const classifica = (r) => {
    const dias = Number(r?.dias_restantes ?? 0);
    if (r?.atrasado) return 'vencido';
    if (dias < 2) return 'urgente';
    return 'no_prazo';
  };

  // KPIs
  const kpis = React.useMemo(() => {
    const out = { total: todosPrazos.length, vencidos: 0, urgentes: 0, no_prazo: 0 };
    todosPrazos.forEach((r) => {
      const c = classifica(r);
      out[c === 'vencido' ? 'vencidos' : c === 'urgente' ? 'urgentes' : 'no_prazo']++;
    });
    return out;
  }, [todosPrazos]);

  // Lista de etapas com count (para os filtros)
  const etapasFiltro = React.useMemo(() => {
    const map = new Map();
    todosPrazos.forEach((r) => {
      const k = r._etapa || 'Outros';
      map.set(k, (map.get(k) || 0) + 1);
    });
    return Array.from(map.entries()).map(([etapa, count]) => ({ etapa, count }));
  }, [todosPrazos]);

  // Filtragem da lista pra tabela
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
      {/* Avisos compactos (collapsable) */}
      <div className="mb-3 rounded-lg border" style={{ borderColor: 'var(--warning)', background: 'rgba(245,158,11,0.06)' }}>
        <button
          type="button"
          onClick={() => setAvisosOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm"
          style={{ background: 'transparent', border: 'none', color: 'var(--fg)', cursor: 'pointer' }}
        >
          <AlertTriangle size={14} style={{ color: 'var(--warning)' }} />
          <span style={{ fontWeight: 700, color: 'var(--warning)' }}>Avisos de hoje</span>
          <span className="text-xs opacity-60">· 10:20 manutenção · 15:00 atualização</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.6 }}>{avisosOpen ? '▲' : '▼'}</span>
        </button>
        {avisosOpen && (
          <ul className="px-4 pb-3 space-y-1 text-sm">
            <li>
              <strong style={{ color: 'var(--accent)' }}>10:20</strong> — Todos os dias teremos manutenção da base de consulta. Serviços de consulta podem oscilar neste horário.
            </li>
            <li>
              <strong style={{ color: 'var(--accent)' }}>15:00</strong> — Atualização de funcionalidades de processos. Novas melhorias serão aplicadas.
            </li>
          </ul>
        )}
      </div>

      {/* KPI Hero — 4 indicadores principais */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {[
          { label: 'Total ativos', value: kpis.total, color: '#3b82f6', filter: 'todos' },
          { label: 'Vencidos', value: kpis.vencidos, color: '#ef4444', filter: 'vencidos' },
          { label: 'Urgentes (<2d)', value: kpis.urgentes, color: '#f59e0b', filter: 'urgentes' },
          { label: 'No prazo', value: kpis.no_prazo, color: '#10b981', filter: 'no_prazo' },
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
        {/* Toolbar: filtros + busca */}
        <div className="px-3 py-2.5 border-b panel-border flex flex-wrap items-center gap-2">
          <Clock size={15} style={{ color: 'var(--accent)' }} />
          <span className="text-sm font-bold mr-2">Prazos por etapa</span>

          {/* Tabs de etapa */}
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

        {/* Tabela */}
        {errPrazos ? (
          <div className="text-red-500 text-sm p-4 text-center">{errPrazos}</div>
        ) : linhasFiltradas.length === 0 ? (
          <div className="opacity-60 text-sm p-8 text-center">
            {todosPrazos.length === 0
              ? 'Nenhum processo em prazo crítico no momento.'
              : 'Nenhum processo encontrado com os filtros atuais.'}
          </div>
        ) : (
          <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
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
                  const cor = c === 'vencido' ? '#ef4444' : c === 'urgente' ? '#f59e0b' : '#3b82f6';
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
                      onClick={() => navigate(`/processos?pid=${r.id_processo}`)}
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
                        <span style={{ color: diasMov && diasMov > 14 ? '#f59e0b' : 'var(--fg)', opacity: diasMov && diasMov > 14 ? 1 : 0.7 }}>
                          {diasMov != null ? `${diasMov}d` : '—'}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span style={{
                          color: c === 'vencido' ? '#fca5a5' : 'var(--fg)',
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
                            background: c === 'vencido' ? 'rgba(239,68,68,0.15)' : 'rgba(37,99,235,0.12)',
                            border: c === 'vencido' ? '1px solid rgba(239,68,68,0.45)' : '1px solid rgba(59,130,246,0.35)',
                            color: c === 'vencido' ? '#fca5a5' : '#93c5fd',
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
                            <div style={{ fontSize: 12, color: '#fca5a5' }}>{histState.error}</div>
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

      {/* Fila do Dia */}
      <div
        className="rounded-xl shadow-elevated p-4 mb-6 border-2"
        style={{ background: 'var(--panel)', borderColor: 'var(--border)', color: 'var(--fg)' }}
      >
        <h2 className="text-lg font-extrabold tracking-tight flex items-center gap-2 mb-4">
          <Zap size={16} style={{ color: 'var(--warning)' }} />
          Fila do Dia
          {acoes && (
            <span style={{ fontSize: 12, fontWeight: 500, marginLeft: 6, opacity: 0.65 }}>
              {acoes.totais.urgente + acoes.totais.sem_movimentacao + acoes.totais.aguardando_resposta + acoes.totais.emails_nao_lidos} itens
            </span>
          )}
        </h2>

        {loadingAcoes && <div className="text-sm opacity-50 py-4 text-center">Carregando...</div>}

        {acoes && (() => {
          const cats = [
            { key: 'urgente', label: 'Urgente', color: '#ef4444', icon: <AlertTriangle size={13} />, items: acoes.urgente, count: acoes.totais.urgente, getDesc: r => r.atrasado ? `Atrasado ${Math.abs(r.dias_restantes).toFixed(1)}d` : `${r.horas_restantes.toFixed(0)}h restantes` },
            { key: 'sem_movimentacao', label: 'Sem movimentação', color: '#f59e0b', icon: <Clock size={13} />, items: acoes.sem_movimentacao, count: acoes.totais.sem_movimentacao, getDesc: r => `${r.dias_sem_mov}d sem mov.` },
            { key: 'aguardando_resposta', label: 'Aguardando resposta', color: '#3b82f6', icon: <CalendarClock size={13} />, items: acoes.aguardando_resposta, count: acoes.totais.aguardando_resposta, getDesc: r => `Aguardando ${r.dias_aguardando}d` },
            { key: 'emails_nao_lidos', label: 'Emails não lidos', color: '#8b5cf6', icon: <Mail size={13} />, items: acoes.emails_nao_lidos.processos, count: acoes.totais.emails_nao_lidos, getDesc: r => `${r.count_emails} email${r.count_emails > 1 ? 's' : ''}` },
          ];
          return (
            <div className="space-y-3">
              {cats.map(cat => (
                <div key={cat.key} style={{ border: `1px solid ${cat.color}30`, borderRadius: 10, overflow: 'hidden' }}>
                  <button
                    type="button"
                    onClick={() => setAcoesExpanded(p => ({ ...p, [cat.key]: !p[cat.key] }))}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: `${cat.color}10`, border: 'none', cursor: 'pointer', color: 'var(--fg)' }}
                  >
                    <span style={{ color: cat.color }}>{cat.icon}</span>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{cat.label}</span>
                    <span style={{ marginLeft: 4, fontSize: 11, fontWeight: 600, background: `${cat.color}25`, border: `1px solid ${cat.color}50`, borderRadius: 10, padding: '1px 8px', color: cat.color }}>{cat.count}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.5 }}>{acoesExpanded[cat.key] ? '▲' : '▼'}</span>
                  </button>
                  {acoesExpanded[cat.key] && (
                    cat.count === 0
                      ? <div style={{ padding: '10px 14px', fontSize: 13, opacity: 0.55 }}>Nenhum item.</div>
                      : <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                          {cat.items.map(r => (
                            <button
                              key={r.id_processo}
                              type="button"
                              onClick={() => navigate(`/processos?pid=${r.id_processo}`)}
                              style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 8, background: 'var(--card)', border: '1px solid var(--border)', cursor: 'pointer', color: 'var(--fg)' }}
                              onMouseEnter={e => { e.currentTarget.style.background = `${cat.color}12`; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'var(--card)'; }}
                            >
                              <span style={{ fontSize: 11, fontWeight: 700, color: cat.color, background: `${cat.color}20`, borderRadius: 6, padding: '1px 6px', flexShrink: 0 }}>#{r.id_processo}</span>
                              <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {r.cliente || r.uc || '-'}{r.etapa ? ` · ${r.etapa}` : ''}{r.sub_etapa ? ` / ${r.sub_etapa}` : ''}
                              </span>
                              <span style={{ fontSize: 11, opacity: 0.7, flexShrink: 0, color: cat.color }}>{cat.getDesc(r)}</span>
                            </button>
                          ))}
                        </div>
                  )}
                </div>
              ))}
            </div>
          );
        })()}
      </div>

      {/* Modal de cobrança */}
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
