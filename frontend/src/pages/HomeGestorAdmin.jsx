// src/pages/HomeGestorAdmin.jsx

import React, { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import Toast from '../components/Toast.jsx';
import { Clock, Mail, Loader2, X, Send, Sparkles, Check, AlertTriangle, User, Building2, Zap, CalendarClock } from 'lucide-react';
import { getProcessosComPrazo } from '../services/requisicaoService';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import apiClient from '../services/apiClient';

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
  const isAdmin = String(user?.tipo_conta || '').toLowerCase() === 'admin';
  const navigate = useNavigate();

  const [prazos, setPrazos] = React.useState({ grupos: {}, rows: [], count: 0 });
  const [errPrazos, setErrPrazos] = React.useState('');
  const [toast, setToast] = React.useState({ open: false, type: 'info', text: '' });
  const [cobrancaModal, setCobrancaModal] = React.useState(null); // { id_processo, uc, cliente, ... }

  const [acoes, setAcoes] = React.useState(null);
  const [loadingAcoes, setLoadingAcoes] = React.useState(true);
  const [acoesExpanded, setAcoesExpanded] = React.useState({ urgente: true, sem_movimentacao: false, aguardando_resposta: false, emails_nao_lidos: false });

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

  if (!isAdmin) {
    return (
      <div className="p-4 md:p-6 bg-background text-foreground min-h-screen flex items-center justify-center">
        <div className="rounded-xl border px-4 py-3">
          Acesso restrito ao administrador.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 bg-background text-foreground min-h-screen">
      {/* Avisos de manutenção/atualização (hoje) */}
      <div
        className="mb-4 rounded-xl border-2 shadow-elevated"
        style={{ background: 'var(--panel)', borderColor: 'var(--warning)' }}
      >
        <div className="px-4 py-3">
          <div
            className="text-lg font-extrabold"
            style={{ color: 'var(--warning)' }}
          >
            Avisos de Hoje (Horário de Brasília)
          </div>
          <ul className="mt-2 space-y-1 text-sm">
            <li>
              <strong style={{ color: 'var(--accent)' }}>10:20</strong> — Todos
              os dias teremos manutenção da base de consulta. Serviços de
              consulta podem oscilar neste horário.
            </li>
            <li>
              <strong style={{ color: 'var(--accent)' }}>15:00</strong> —
              Atualização de funcionalidades de processos. Novas melhorias serão
              aplicadas.
            </li>
          </ul>
        </div>
      </div>

      {/* Prazos críticos */}
      <div
        className="rounded-xl shadow-elevated p-4 mb-6 border-2"
        style={{
          background: 'var(--panel)',
          borderColor: 'var(--accent)',
          color: 'var(--fg)',
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-extrabold tracking-tight flex items-center gap-2">
            <Clock size={16} /> Prazos críticos (Distribuidora/Ouvidoria/ANEEL)
          </h2>
          <span className="text-sm opacity-80">Total: {prazos.count}</span>
        </div>

        {errPrazos && (
          <div className="text-red-500 text-sm mb-2">{errPrazos}</div>
        )}

        {prazos.count === 0 ? (
          <div className="opacity-70 text-sm py-4 text-center">
            Nenhum processo em prazo crítico no momento.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {Object.entries(prazos.grupos || {}).map(([etapa, arr]) => (
              <div key={etapa}>
                {/* Cabeçalho da etapa */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
                }}>
                  <div style={{
                    width: 3, height: 18, borderRadius: 2,
                    background: 'var(--accent)', flexShrink: 0,
                  }} />
                  <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--accent)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                    {etapa}
                  </span>
                  <span style={{
                    fontSize: 11, fontWeight: 600,
                    background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)',
                    borderRadius: 10, padding: '1px 8px', color: 'var(--accent-2)',
                  }}>
                    {arr.length} processo{arr.length !== 1 ? 's' : ''}
                  </span>
                </div>

                {/* Grid de cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
                  {arr
                    .slice()
                    .sort((a, b) => (a.deadline_unix || 0) - (b.deadline_unix || 0))
                    .map((r, idx) => {
                      const hrs = Number(r?.horas_restantes ?? 0);
                      const dias = Number(r?.dias_restantes ?? 0);
                      const diasMov = r?.data_base_unix
                        ? Math.max(0, Math.floor((Date.now() - Number(r.data_base_unix) * 1000) / 86400000))
                        : null;
                      const atrasado = !!r?.atrasado;
                      const diasAtraso = atrasado ? Math.abs(Math.round(dias)) : 0;
                      const urgente = !atrasado && dias < 2;

                      const accentColor = atrasado ? '#ef4444' : urgente ? '#f59e0b' : '#3b82f6';
                      const bgColor = atrasado
                        ? 'rgba(239,68,68,0.06)'
                        : urgente
                        ? 'rgba(245,158,11,0.06)'
                        : 'rgba(255,255,255,0.02)';

                      return (
                        <div
                          key={`${etapa}-${r.id_processo ?? 'pid'}-${idx}`}
                          style={{
                            borderRadius: 12,
                            border: `1px solid ${atrasado ? 'rgba(239,68,68,0.35)' : urgente ? 'rgba(245,158,11,0.35)' : 'var(--border)'}`,
                            background: `var(--card)`,
                            boxShadow: atrasado ? '0 0 0 1px rgba(239,68,68,0.1)' : 'none',
                            overflow: 'hidden',
                            display: 'flex', flexDirection: 'column',
                            position: 'relative',
                          }}
                        >
                          {/* Barra colorida no topo */}
                          <div style={{
                            height: 3,
                            background: atrasado
                              ? 'linear-gradient(90deg, #dc2626, #ef4444)'
                              : urgente
                              ? 'linear-gradient(90deg, #d97706, #f59e0b)'
                              : 'linear-gradient(90deg, #1d4ed8, #3b82f6)',
                          }} />

                          <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {/* Linha 1: ID + badge status + botão cobrar */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <button
                                type="button"
                                onClick={() => navigate(`/admin/planilha?pid=${r.id_processo}`)}
                                style={{
                                  fontWeight: 800, fontSize: 14, color: accentColor,
                                  background: 'none', border: 'none', cursor: 'pointer',
                                  padding: 0, lineHeight: 1, textDecoration: 'none',
                                }}
                              >
                                Proc #{r.id_processo}
                              </button>

                              {atrasado ? (
                                <span style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  fontSize: 11, fontWeight: 700,
                                  background: 'rgba(239,68,68,0.18)', border: '1px solid rgba(239,68,68,0.45)',
                                  borderRadius: 6, padding: '2px 7px', color: '#fca5a5',
                                }}>
                                  <AlertTriangle size={10} /> Vencido há {diasAtraso}d
                                </span>
                              ) : urgente ? (
                                <span style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  fontSize: 11, fontWeight: 700,
                                  background: 'rgba(245,158,11,0.18)', border: '1px solid rgba(245,158,11,0.45)',
                                  borderRadius: 6, padding: '2px 7px', color: '#fcd34d',
                                }}>
                                  <Zap size={10} /> Urgente
                                </span>
                              ) : (
                                <span style={{
                                  fontSize: 11, fontWeight: 600,
                                  background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)',
                                  borderRadius: 6, padding: '2px 7px', color: '#93c5fd',
                                }}>
                                  {Math.floor(dias)}d {Math.max(0, Math.floor(hrs % 24))}h restantes
                                </span>
                              )}

                              <button
                                type="button"
                                onClick={() => setCobrancaModal(r)}
                                title="Enviar e-mail de cobrança de resposta"
                                style={{
                                  marginLeft: 'auto',
                                  display: 'inline-flex', alignItems: 'center', gap: 5,
                                  padding: '5px 11px', borderRadius: 7, fontSize: 11, fontWeight: 700,
                                  background: atrasado ? 'rgba(239,68,68,0.15)' : 'rgba(37,99,235,0.12)',
                                  border: atrasado ? '1px solid rgba(239,68,68,0.5)' : '1px solid rgba(59,130,246,0.4)',
                                  color: atrasado ? '#fca5a5' : '#93c5fd',
                                  cursor: 'pointer', whiteSpace: 'nowrap',
                                  transition: 'all 120ms',
                                }}
                              >
                                <Mail size={11} /> Cobrar Retorno
                              </button>
                            </div>

                            {/* Linha 2: UC / Cliente / Concessionária */}
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {r.uc && (
                                <span style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  fontSize: 12, color: 'var(--fg)', opacity: 0.9,
                                  background: bgColor,
                                  border: '1px solid var(--border)',
                                  borderRadius: 6, padding: '2px 8px',
                                }}>
                                  <Zap size={10} style={{ color: accentColor }} /> UC {r.uc}
                                </span>
                              )}
                              {r.cliente && (
                                <span style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  fontSize: 12, color: 'var(--fg)', opacity: 0.85,
                                  background: bgColor,
                                  border: '1px solid var(--border)',
                                  borderRadius: 6, padding: '2px 8px',
                                  maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                }}>
                                  <User size={10} style={{ color: 'var(--fg)', flexShrink: 0 }} /> {r.cliente}
                                </span>
                              )}
                              {r.concessionaria && (
                                <span style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  fontSize: 12, color: 'var(--fg)', opacity: 0.85,
                                  background: bgColor,
                                  border: '1px solid var(--border)',
                                  borderRadius: 6, padding: '2px 8px',
                                }}>
                                  <Building2 size={10} style={{ color: 'var(--fg)', flexShrink: 0 }} /> {r.concessionaria}
                                </span>
                              )}
                            </div>

                            {/* Linha 3: Sub-etapa + datas */}
                            <div style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              flexWrap: 'wrap', gap: 6,
                              paddingTop: 8, borderTop: '1px solid var(--border)',
                            }}>
                              <span style={{
                                fontSize: 11, color: 'var(--fg)', opacity: 0.7,
                                maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}>
                                {r.sub_etapa || 'Aguardando retorno'}
                              </span>
                              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <span style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  fontSize: 11, color: 'var(--fg)', opacity: 0.55,
                                }}>
                                  <Clock size={10} /> {diasMov ?? '-'}d sem mov.
                                </span>
                                <span style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  fontSize: 11, color: atrasado ? '#fca5a5' : 'var(--fg)', opacity: atrasado ? 0.85 : 0.55,
                                }}>
                                  <CalendarClock size={10} />
                                  {r.deadline ? new Date(r.deadline).toLocaleDateString('pt-BR') : '-'}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
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
                              onClick={() => navigate(`/admin/planilha?pid=${r.id_processo}`)}
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
