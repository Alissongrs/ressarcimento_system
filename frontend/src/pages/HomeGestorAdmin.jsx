// src/pages/HomeGestorAdmin.jsx

import React, { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Clock, Mail, Loader2, X, Send, Sparkles, Check, AlertTriangle, Zap, CalendarClock, ChevronDown } from 'lucide-react';
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

// Assinatura padrão (frontend/public/assinatura_complaint.png) — mesma imagem que o
// backend fixa por padrão quando envia (appendEmailProcessSignature/appendMailSignature),
// só que aqui fica visível no editor ANTES de enviar, não só depois. O backend detecta
// que a assinatura já está no corpo (procura "assinatura_complaint.png") e não duplica.
const SIGNATURE_HTML = '<br/><br/><img src="/assinatura_complaint.png" alt="assinatura" style="max-width:260px;height:auto;" />';
const withSignature = (html) => {
  const clean = String(html || '').trim();
  if (clean.includes('assinatura_complaint.png')) return html || '';
  return clean + SIGNATURE_HTML;
};

// Os 4 tons disponíveis — a chave bate com o campo devolvido pela API
// (gerar-cobranca/cobranca-cache) e com o prompt em backend/data/prompt_cobranca.txt.
const TONS = [
  { key: 'formal', label: 'Formal', hint: 'Técnico e institucional, cita a REN ANEEL' },
  { key: 'direto', label: 'Direto', hint: 'Objetivo, foco na urgência prática' },
  { key: 'amigavel', label: 'Amigável', hint: 'Cordial, preserva o relacionamento' },
  { key: 'firme', label: 'Firme', hint: 'Enfático quanto ao prazo vencido' },
];

/* ─── Modal de cobrança de retorno ─── (exportado: também usado por Prazos.jsx) */
export function CobrancaEmailModal({ processo, onClose, onSent }) {
  const [para, setPara] = React.useState('');
  const [cc, setCc] = React.useState('');
  const [assunto, setAssunto] = React.useState('');
  const [body, setBody] = React.useState(SIGNATURE_HTML);
  const [loading, setLoading] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [opcoes, setOpcoes] = React.useState(null); // { formal, direto, amigavel, firme, subject, sem_retorno, dias_sem_retorno }
  const [tom, setTom] = React.useState('formal');
  const [tomMenuOpen, setTomMenuOpen] = React.useState(false);
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

  // Escolhe o primeiro tom que veio com texto (a API sempre tenta devolver os 4, mas o
  // fallback de erro de parse da IA só preenche "formal" — ver GerarCobrancaParaProcesso).
  const primeiroTomDisponivel = (data) => TONS.find((t) => (data?.[t.key] || '').trim())?.key || 'formal';

  const aplicarOpcoes = (data, tomEscolhido) => {
    setOpcoes(data);
    if (data.subject) setAssunto(data.subject);
    // Para/Cc vêm do último e-mail ENVIADO ao processo (mesmo destinatário, mesma cópia).
    // Fica vazio se nunca houve e-mail enviado — usuário preenche manualmente.
    if (data.para) setPara(data.para);
    if (data.cc) setCc(data.cc);
    const alvo = tomEscolhido || primeiroTomDisponivel(data);
    setTom(alvo);
    setBody(withSignature(data[alvo] || ''));
  };

  const handleAnalisarIA = async () => {
    setLoading(true);
    setOpcoes(null);
    setError('');
    try {
      const { data } = await apiClient.post(`/processos/${pid}/gerar-cobranca`);
      aplicarOpcoes(data);
    } catch (e) {
      setError('Falha ao analisar histórico com IA. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  // Ao abrir: tenta o cache primeiro (atualizado de hora em hora pelo cron
  // ProcessarCobrancasCache — instantâneo, sem chamar IA). Só gera na hora (mais lento)
  // se ainda não houver cache pra esse processo.
  useEffect(() => {
    if (!pid) return;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const { data } = await apiClient.get(`/processos/${pid}/cobranca-cache`);
        aplicarOpcoes(data);
        setLoading(false);
      } catch (e) {
        handleAnalisarIA();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  // Troca de tom é instantânea — os 4 textos já vieram juntos na mesma resposta da IA,
  // não é preciso chamar a API de novo (diferente de "Gerar novamente", que sim refaz a análise).
  const handleTrocarTom = (novoTom) => {
    setTom(novoTom);
    setTomMenuOpen(false);
    if (opcoes?.[novoTom]) {
      setBody(withSignature(opcoes[novoTom]));
    }
  };

  const handleGerarNovamente = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await apiClient.post(`/processos/${pid}/gerar-cobranca`);
      aplicarOpcoes(data, tom);
    } catch (e) {
      setError('Falha ao gerar nova sugestão. Tente novamente.');
    } finally {
      setLoading(false);
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
        cc: cc.trim(),
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
          width: '100%', maxWidth: 1180, height: '92vh', maxHeight: '92vh',
          borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column',
          background: 'var(--card)', border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-elevated)',
        }}
      >
        {/* Header */}
        <div style={{
          background: 'var(--gradient-primary)',
          padding: '14px 18px', display: 'flex', alignItems: 'flex-start', gap: 12,
          borderBottom: '1px solid rgba(255,255,255,0.14)',
        }}>
          <Mail size={18} style={{ color: 'rgba(255,255,255,0.9)', marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>
              Cobrança de Retorno — Proc #{pid}
            </div>
            <div style={{ color: 'rgba(255,255,255,0.82)', fontSize: 12, marginTop: 2 }}>
              UC {uc} · {cliente} · {concessionaria}
            </div>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4,
              background: 'rgba(255,255,255,0.16)', border: '1px solid rgba(255,255,255,0.3)',
              borderRadius: 6, padding: '1px 7px', fontSize: 11, color: '#fff',
            }}>
              <Clock size={10} /> {subEtapa}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ color: 'rgba(255,255,255,0.85)', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}
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
              multiple
              placeholder="email@concessionaria.com.br"
              value={para}
              onChange={(e) => setPara(e.target.value)}
              title="Pré-preenchido com o mesmo destinatário do último e-mail enviado, se houver"
              style={{
                flex: 1, background: 'color-mix(in srgb, var(--panel) 90%, transparent)',
                border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px',
                color: 'var(--fg)', fontSize: 13,
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--fg)', opacity: 0.6, width: 60, flexShrink: 0 }}>Cc</span>
            <input
              type="email"
              multiple
              placeholder="(opcional) cc@concessionaria.com.br"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              title="Pré-preenchido com os demais destinatários do último e-mail enviado, se houver"
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
              background: loading ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'var(--gradient-primary)',
              color: loading ? 'var(--accent)' : '#fff',
              border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)',
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'all 150ms',
            }}
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {loading ? 'Analisando histórico...' : 'Analisar histórico com IA'}
          </button>

          {opcoes && (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Check size={12} /> Sugestão aplicada ao corpo do e-mail
              </span>

              {/* Caixinha de tom — clica, abre as 4 opções, seleciona, aplica na hora */}
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setTomMenuOpen((v) => !v)}
                  disabled={loading}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                    background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)',
                    color: 'var(--accent)', cursor: loading ? 'not-allowed' : 'pointer',
                    opacity: loading ? 0.5 : 1,
                  }}
                >
                  Tom: {TONS.find((t) => t.key === tom)?.label || 'Formal'}
                  <ChevronDown size={12} style={{ transform: tomMenuOpen ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
                </button>
                {tomMenuOpen && (
                  <div
                    style={{
                      position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 20,
                      width: 220, borderRadius: 8, overflow: 'hidden',
                      background: 'var(--card)', border: '1px solid var(--border)',
                      boxShadow: 'var(--shadow-medium)',
                    }}
                  >
                    {TONS.map((t) => {
                      const disponivel = !!(opcoes?.[t.key] || '').trim();
                      const ativo = t.key === tom;
                      return (
                        <button
                          key={t.key}
                          type="button"
                          disabled={!disponivel}
                          onClick={() => handleTrocarTom(t.key)}
                          style={{
                            display: 'block', width: '100%', textAlign: 'left',
                            padding: '8px 12px', border: 'none', cursor: disponivel ? 'pointer' : 'not-allowed',
                            background: ativo ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                            opacity: disponivel ? 1 : 0.4,
                          }}
                          onMouseEnter={(e) => { if (disponivel && !ativo) e.currentTarget.style.background = 'var(--panel)'; }}
                          onMouseLeave={(e) => { if (!ativo) e.currentTarget.style.background = 'transparent'; }}
                        >
                          <div style={{ fontSize: 12.5, fontWeight: 600, color: ativo ? 'var(--accent)' : 'var(--fg)' }}>
                            {t.label}{!disponivel && ' (indisponível)'}
                          </div>
                          <div style={{ fontSize: 10.5, color: 'var(--fg)', opacity: 0.6 }}>{t.hint}</div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <button
                onClick={handleGerarNovamente}
                disabled={loading}
                title="Refazer a análise da IA para os 4 tons"
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
          {opcoes && opcoes.sem_retorno === false && (
            <div style={{
              marginTop: 8, display: 'flex', alignItems: 'flex-start', gap: 6,
              padding: '6px 10px', borderRadius: 6, fontSize: 11.5,
              background: 'color-mix(in srgb, var(--warning) 14%, transparent)',
              border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)', color: 'var(--warning)',
            }}>
              <AlertTriangle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
              <span>
                Já existe uma resposta da distribuidora não tratada — isso é uma pendência, não falta
                de retorno. Confira o histórico antes de enviar cobrança.
              </span>
            </div>
          )}
        </div>

        {/* Editor */}
        <div style={{ flex: 1, minHeight: 0, padding: '10px 16px 0', display: 'flex', flexDirection: 'column' }}>
          <div style={{
            flex: 1, minHeight: 420, display: 'flex', flexDirection: 'column',
            border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden',
            background: 'color-mix(in srgb, var(--panel) 80%, transparent)',
          }}>
            <ReactQuill
              ref={quillRef}
              theme="snow"
              value={body}
              onChange={setBody}
              modules={COBRANCA_QUILL_MODULES}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
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
                background: sending ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'var(--gradient-primary)',
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

  const [acoes, setAcoes] = React.useState(null);
  const [loadingAcoes, setLoadingAcoes] = React.useState(true);
  const [acoesExpanded, setAcoesExpanded] = React.useState({
    urgente: true, sem_movimentacao: false, aguardando_resposta: false, emails_nao_lidos: false,
  });
  const [avisosOpen, setAvisosOpen] = React.useState(false);

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

  return (
    <div className="p-4 md:p-6 bg-background text-foreground min-h-screen">
      {/* Avisos compactos (collapsable) */}
      <div className="mb-3 rounded-lg border" style={{ borderColor: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 6%, transparent)' }}>
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

      {/* Solicitações ao sistema (chat #sistema) — gestor aprova/deleta */}
      <div className="mb-6">
        <SolicitacoesPanel />
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
          // Cores literais (não var(--x)) porque o render abaixo monta variações de opacidade
          // via sufixo hex (${cat.color}10/20/30/50) — CSS custom properties não suportam isso.
          // Valores batem com a paleta SAP (danger/warning/accent do theme.css).
          const cats = [
            { key: 'urgente', label: 'Urgente', color: '#c0392b', icon: <AlertTriangle size={13} />, items: acoes.urgente, count: acoes.totais.urgente, getDesc: r => r.atrasado ? `Atrasado ${Math.abs(r.dias_restantes).toFixed(1)}d` : `${r.horas_restantes.toFixed(0)}h restantes` },
            { key: 'sem_movimentacao', label: 'Sem movimentação', color: '#d4a017', icon: <Clock size={13} />, items: acoes.sem_movimentacao, count: acoes.totais.sem_movimentacao, getDesc: r => `${r.dias_sem_mov}d sem mov.` },
            { key: 'aguardando_resposta', label: 'Aguardando resposta', color: '#2c6ea3', icon: <CalendarClock size={13} />, items: acoes.aguardando_resposta, count: acoes.totais.aguardando_resposta, getDesc: r => `Aguardando ${r.dias_aguardando}d` },
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
                              onClick={() => navigate(`/processos/${r.id_processo}`)}
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
    </div>
  );
}
