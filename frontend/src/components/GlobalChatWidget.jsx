/**
 * GlobalChatWidget — Chat flutuante global com acesso ao banco de dados
 * Responde perguntas sobre processos de ressarcimento em tempo real.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  ChevronDown,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  Send,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import api from '../services/apiClient.js';

// ─── Markdown simples (sem dependência extra) ──────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';
  return text
    // Negrito
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Itálico
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Código inline
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 5px;border-radius:3px;font-family:monospace;font-size:0.9em;">$1</code>')
    // Headers ## e ###
    .replace(/^### (.+)$/gm, '<div style="font-weight:700;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.08em;opacity:0.7;margin:10px 0 4px;">$1</div>')
    .replace(/^## (.+)$/gm, '<div style="font-weight:700;font-size:0.9rem;margin:10px 0 4px;color:var(--accent);">$1</div>')
    // Itens de lista
    .replace(/^- (.+)$/gm, '<div style="padding-left:14px;position:relative;"><span style="position:absolute;left:4px;opacity:0.5">›</span>$1</div>')
    // Quebras de linha
    .replace(/\n/g, '<br/>');
}

// ─── Sugestões rápidas ─────────────────────────────────────────────────────
const SUGESTOES = [
  { label: 'Parados há 30+ dias', q: 'Quais processos estão parados há mais de 30 dias?' },
  { label: 'Alertas vencidos', q: 'Quais alertas estão vencidos ou vencem hoje?' },
  { label: 'Processos recentes', q: 'Quais processos foram criados nos últimos 7 dias?' },
  { label: 'Resumo geral', q: 'Me dê um resumo geral dos processos ativos.' },
  { label: 'Totais financeiros', q: 'Qual é o valor total deferido em ressarcimentos?' },
  { label: 'Por etapa', q: 'Como estão distribuídos os processos por etapa?' },
];

// ─── Componente principal ──────────────────────────────────────────────────
export default function GlobalChatWidget() {
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [pulse, setPulse] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);

  // Scroll automático para o fim
  useEffect(() => {
    if (open && !minimized) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, open, minimized]);

  // Foco no input ao abrir
  useEffect(() => {
    if (open && !minimized) {
      setTimeout(() => inputRef.current?.focus(), 120);
    }
  }, [open, minimized]);

  // Pulsa o botão quando chega resposta enquanto minimizado
  useEffect(() => {
    if (!open || minimized) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'assistant') {
        setPulse(true);
        const t = setTimeout(() => setPulse(false), 3000);
        return () => clearTimeout(t);
      }
    }
  }, [messages, open, minimized]);

  const sendMessage = useCallback(async (text) => {
    const question = (text || input).trim();
    if (!question || loading) return;

    // Monta histórico para a API
    const historyForAPI = messages
      .filter((m) => m.role !== 'system')
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [
      ...prev,
      { id: Date.now(), role: 'user', content: question },
    ]);
    setInput('');
    setLoading(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const resp = await api.post(
        '/chat/processos',
        { question, history: historyForAPI },
        { signal: ctrl.signal, timeout: 60000 },
      );
      const answer = resp.data?.answer || 'Sem resposta.';
      setMessages((prev) => [
        ...prev,
        { id: Date.now() + 1, role: 'assistant', content: answer },
      ]);
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'CanceledError') return;
      const msg =
        err?.response?.data?.error ||
        'Não foi possível obter resposta. Tente novamente.';
      setMessages((prev) => [
        ...prev,
        { id: Date.now() + 1, role: 'error', content: msg },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, messages, loading]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
    if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const handleClose = () => {
    abortRef.current?.abort();
    setOpen(false);
    setMinimized(false);
  };

  const clearHistory = () => {
    abortRef.current?.abort();
    setMessages([]);
    setLoading(false);
  };

  // ── FAB (botão flutuante) ─────────────────────────────────────────────────
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="AISURE — Assistente de processos"
        style={{
          position: 'fixed',
          bottom: '72px',
          right: '16px',
          zIndex: 200,
          width: 52,
          height: 52,
          borderRadius: '50%',
          border: 'none',
          background: 'linear-gradient(135deg, #1e3a5f 0%, #0d1b2a 100%)',
          color: '#fff',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: pulse
            ? '0 0 0 6px rgba(99,102,241,0.25), 0 4px 20px rgba(0,0,0,0.4)'
            : '0 4px 20px rgba(0,0,0,0.35)',
          transition: 'box-shadow 0.3s ease, transform 0.2s ease',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.08)')}
        onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
      >
        {pulse ? (
          <Sparkles size={22} style={{ color: '#818cf8' }} />
        ) : (
          <Bot size={22} />
        )}
        {messages.length > 0 && (
          <span
            style={{
              position: 'absolute',
              top: 3,
              right: 3,
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: '#6366f1',
              border: '2px solid #0d1b2a',
            }}
          />
        )}
      </button>
    );
  }

  // ── Painel do chat ─────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 72,
        right: 16,
        zIndex: 200,
        width: minimized ? 280 : expanded ? 680 : 420,
        maxHeight: minimized ? 52 : expanded ? 'calc(100vh - 100px)' : 580,
        background: 'var(--bg, #0d1b2a)',
        border: '1px solid rgba(99,102,241,0.25)',
        borderRadius: 16,
        boxShadow: '0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'all 0.25s cubic-bezier(0.4,0,0.2,1)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div
        style={{
          background: 'linear-gradient(135deg, #1e3a5f 0%, #0d1b2a 100%)',
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderBottom: '1px solid rgba(99,102,241,0.2)',
          cursor: minimized ? 'pointer' : 'default',
          flexShrink: 0,
        }}
        onClick={() => minimized && setMinimized(false)}
        title={minimized ? 'Expandir chat' : undefined}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: 'rgba(99,102,241,0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Bot size={16} style={{ color: '#818cf8' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', lineHeight: 1.2 }}>
            AISURE
          </div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', letterSpacing: '0.06em' }}>
            {loading ? 'Consultando banco...' : 'Assistente de processos'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {messages.length > 0 && !minimized && (
            <button
              type="button"
              onClick={clearHistory}
              title="Limpar conversa"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'rgba(255,255,255,0.4)',
                cursor: 'pointer',
                padding: '4px 6px',
                borderRadius: 6,
                fontSize: 11,
                letterSpacing: '0.04em',
              }}
            >
              limpar
            </button>
          )}
          {!minimized && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? 'Tamanho normal' : 'Ampliar janela'}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'rgba(255,255,255,0.5)',
                cursor: 'pointer',
                padding: 4,
                borderRadius: 6,
                display: 'flex',
              }}
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          )}
          <button
            type="button"
            onClick={() => setMinimized((v) => !v)}
            title={minimized ? 'Expandir' : 'Minimizar'}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'rgba(255,255,255,0.5)',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 6,
              display: 'flex',
            }}
          >
            <ChevronDown
              size={15}
              style={{
                transform: minimized ? 'rotate(180deg)' : 'none',
                transition: 'transform 0.2s',
              }}
            />
          </button>
          <button
            type="button"
            onClick={handleClose}
            title="Fechar"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'rgba(255,255,255,0.5)',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 6,
              display: 'flex',
            }}
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* ── Corpo (hidden when minimized) ──────────────────────────────────── */}
      {!minimized && (
        <>
          {/* ── Área de mensagens ─────────────────────────────────────────── */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              minHeight: 200,
              scrollbarWidth: 'thin',
              scrollbarColor: 'rgba(99,102,241,0.3) transparent',
            }}
          >
            {/* Estado vazio */}
            {messages.length === 0 && !loading && (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <Zap size={28} style={{ color: 'rgba(99,102,241,0.5)', margin: '0 auto 8px' }} />
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 16 }}>
                  Pergunte sobre processos, alertas, valores ou clientes.
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    justifyContent: 'center',
                  }}
                >
                  {SUGESTOES.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      onClick={() => sendMessage(s.q)}
                      style={{
                        background: 'rgba(99,102,241,0.12)',
                        border: '1px solid rgba(99,102,241,0.25)',
                        borderRadius: 20,
                        padding: '4px 10px',
                        fontSize: 11,
                        color: '#818cf8',
                        cursor: 'pointer',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(99,102,241,0.22)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(99,102,241,0.12)')}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Mensagens */}
            {messages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  display: 'flex',
                  flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
                  gap: 8,
                  alignItems: 'flex-start',
                }}
              >
                {/* Avatar */}
                <div
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background:
                      msg.role === 'user'
                        ? 'rgba(30,58,95,0.8)'
                        : msg.role === 'error'
                        ? 'rgba(239,68,68,0.2)'
                        : 'rgba(99,102,241,0.2)',
                    border:
                      msg.role === 'user'
                        ? '1px solid rgba(30,58,95,0.8)'
                        : '1px solid rgba(99,102,241,0.3)',
                    marginTop: 2,
                  }}
                >
                  {msg.role === 'user' ? (
                    <MessageSquare size={12} style={{ color: '#93c5fd' }} />
                  ) : msg.role === 'error' ? (
                    <X size={12} style={{ color: '#f87171' }} />
                  ) : (
                    <Bot size={12} style={{ color: '#818cf8' }} />
                  )}
                </div>

                {/* Balão */}
                <div
                  style={{
                    maxWidth: '80%',
                    padding: '8px 11px',
                    borderRadius:
                      msg.role === 'user' ? '12px 4px 12px 12px' : '4px 12px 12px 12px',
                    fontSize: 12.5,
                    lineHeight: 1.55,
                    background:
                      msg.role === 'user'
                        ? 'rgba(30,58,95,0.6)'
                        : msg.role === 'error'
                        ? 'rgba(239,68,68,0.12)'
                        : 'rgba(255,255,255,0.05)',
                    border:
                      msg.role === 'user'
                        ? '1px solid rgba(30,58,95,0.8)'
                        : msg.role === 'error'
                        ? '1px solid rgba(239,68,68,0.3)'
                        : '1px solid rgba(255,255,255,0.08)',
                    color:
                      msg.role === 'error' ? '#fca5a5' : 'rgba(255,255,255,0.88)',
                    wordBreak: 'break-word',
                  }}
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                />
              </div>
            ))}

            {/* Indicador de digitação */}
            {loading && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <div
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    background: 'rgba(99,102,241,0.2)',
                    border: '1px solid rgba(99,102,241,0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                >
                  <Bot size={12} style={{ color: '#818cf8' }} />
                </div>
                <div
                  style={{
                    padding: '8px 14px',
                    borderRadius: '4px 12px 12px 12px',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Loader2 size={13} style={{ color: '#818cf8', animation: 'spin 1s linear infinite' }} />
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
                    Consultando dados...
                  </span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* ── Sugestões rápidas (após 1ª mensagem) ─────────────────────── */}
          {messages.length > 0 && messages.length < 4 && !loading && (
            <div
              style={{
                padding: '4px 14px 8px',
                display: 'flex',
                gap: 5,
                flexWrap: 'wrap',
                borderTop: '1px solid rgba(255,255,255,0.05)',
              }}
            >
              {SUGESTOES.slice(0, 3).map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => sendMessage(s.q)}
                  style={{
                    background: 'rgba(99,102,241,0.1)',
                    border: '1px solid rgba(99,102,241,0.2)',
                    borderRadius: 20,
                    padding: '3px 9px',
                    fontSize: 10.5,
                    color: '#818cf8',
                    cursor: 'pointer',
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {/* ── Input ────────────────────────────────────────────────────── */}
          <div
            style={{
              padding: '10px 12px',
              borderTop: '1px solid rgba(255,255,255,0.07)',
              display: 'flex',
              gap: 8,
              alignItems: 'flex-end',
              background: 'rgba(0,0,0,0.15)',
              flexShrink: 0,
            }}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // Auto-resize
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
              }}
              onKeyDown={handleKeyDown}
              placeholder="Pergunte sobre processos, clientes, alertas..."
              disabled={loading}
              style={{
                flex: 1,
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 10,
                padding: '7px 11px',
                fontSize: 12.5,
                color: 'rgba(255,255,255,0.9)',
                outline: 'none',
                resize: 'none',
                lineHeight: 1.5,
                minHeight: 34,
                maxHeight: 100,
                overflow: 'hidden',
                fontFamily: 'inherit',
                transition: 'border-color 0.15s',
              }}
              onFocus={(e) => (e.target.style.borderColor = 'rgba(99,102,241,0.5)')}
              onBlur={(e) => (e.target.style.borderColor = 'rgba(255,255,255,0.1)')}
            />
            <button
              type="button"
              onClick={() => sendMessage()}
              disabled={!input.trim() || loading}
              title="Enviar (Enter)"
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                border: 'none',
                background:
                  input.trim() && !loading
                    ? 'linear-gradient(135deg, #6366f1, #4f46e5)'
                    : 'rgba(255,255,255,0.08)',
                color: input.trim() && !loading ? '#fff' : 'rgba(255,255,255,0.25)',
                cursor: input.trim() && !loading ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                transition: 'all 0.15s',
              }}
            >
              <Send size={14} />
            </button>
          </div>
        </>
      )}

      {/* CSS global para animação do Loader2 */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
