import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import apiClient from '../services/apiClient';

/* ─── Chat AISURE ─────────────────────────────────────────────── */
function AisurePanel() {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: 'Olá! Sou o **AISURE**, assistente de análise de anomalias em faturas de energia.\n\nPosso responder perguntas como:\n- "Qual UC tem mais ocorrências na F02?"\n- "Analise a UC 48341497 nas fichas de irregularidade"\n- "Explique o que é desvio de média"\n\nVocê também pode **anexar um documento de regras** (PDF, TXT, CSV) usando o botão 📎 abaixo.\n\nComo posso ajudar?',
    },
  ]);
  const [input, setInput]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [attachments, setAttachments] = useState([]);   // [{ name, text }]
  const [uploading, setUploading]   = useState(false);
  const fileInputRef = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* Upload de arquivo */
  const handleFileChange = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setUploading(true);
    setMessages(prev => [...prev, {
      role: 'system',
      content: `Carregando arquivo: **${file.name}**...`,
    }]);

    try {
      const form = new FormData();
      form.append('files', file);
      const res = await apiClient.post('/api/v1/chat/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const uploaded = res.data?.files ?? [];
      const newAtts = uploaded
        .filter(f => f.text)
        .map(f => ({ name: f.name, text: f.text }));

      if (newAtts.length === 0) {
        setMessages(prev => [...prev, {
          role: 'error',
          content: `Não foi possível extrair texto de **${file.name}**. Tente um arquivo .txt, .csv ou .pdf.`,
        }]);
        return;
      }

      setAttachments(prev => {
        const names = new Set(prev.map(a => a.name));
        return [...prev, ...newAtts.filter(a => !names.has(a.name))];
      });
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Arquivo **${newAtts[0].name}** carregado com sucesso! O conteúdo será usado como contexto em todas as respostas desta sessão.\n\nPode perguntar sobre as regras ou pedir que eu as aplique aos dados das fichas.`,
      }]);
    } catch {
      setMessages(prev => [...prev, {
        role: 'error',
        content: `Erro ao fazer upload de **${file.name}**.`,
      }]);
    } finally {
      setUploading(false);
    }
  }, []);

  const removeAttachment = useCallback((name) => {
    setAttachments(prev => prev.filter(a => a.name !== name));
  }, []);

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || loading) return;

    const history = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    setMessages(prev => [...prev, { role: 'user', content: q }]);
    setInput('');
    setLoading(true);

    try {
      const res = await apiClient.post('/api/v1/faturas/aisure/chat', {
        question: q,
        history,
        attachments,
      });
      setMessages(prev => [...prev, { role: 'assistant', content: res.data.answer }]);
    } catch (e) {
      const msg = e?.response?.data?.error ?? 'Erro ao conectar com o AISURE.';
      setMessages(prev => [...prev, { role: 'error', content: msg }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, attachments]);

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  /* Renderiza markdown simples: **negrito**, listas, quebras de linha */
  const renderText = (text) => {
    const lines = text.split('\n');
    return lines.map((line, i) => {
      // Negrito
      const parts = line.split(/\*\*(.*?)\*\*/g);
      const rendered = parts.map((p, j) =>
        j % 2 === 1 ? <strong key={j}>{p}</strong> : <span key={j}>{p}</span>
      );
      // Lista
      if (line.startsWith('- ') || line.startsWith('• ')) {
        return <li key={i} className="ml-4 list-disc">{rendered.slice(1)}</li>;
      }
      return <p key={i} className={line === '' ? 'my-1' : ''}>{rendered}</p>;
    });
  };

  const SUGGESTIONS = [
    'Quais UCs aparecem em mais de uma ficha?',
    'Explique o que é Divergência de Fórmula (F01)',
    'Quantos registros tem cada ficha?',
    'Como identificar acúmulo de consumo?',
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-5 py-3 border-b border-[var(--border)]"
        style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #0f2340 100%)' }}
      >
        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-white/10">
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
          </svg>
        </div>
        <div>
          <div className="text-white font-bold text-sm tracking-wide">AISURE</div>
          <div className="text-white/50 text-xs">Análise inteligente de anomalias em faturas</div>
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-xs text-white/60">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"/>
          GPT-4o-mini · contexto ao vivo das fichas
        </div>
      </div>

      {/* Mensagens */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((m, i) => (
          m.role === 'system' ? (
            <div key={i} className="flex justify-center">
              <span className="text-xs opacity-40 italic px-3 py-1 bg-[var(--panel)] rounded-full">
                {renderText(m.content)}
              </span>
            </div>
          ) : (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role !== 'user' && (
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold mr-2 flex-shrink-0 mt-0.5"
                style={{ background: m.role === 'error' ? '#dc2626' : '#1e3a5f' }}
              >
                {m.role === 'error' ? '!' : 'AI'}
              </div>
            )}
            <div
              className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'text-white rounded-tr-sm'
                  : m.role === 'error'
                  ? 'bg-red-50 border border-red-200 text-red-700 rounded-tl-sm'
                  : 'bg-[var(--panel)] border border-[var(--border)] text-[var(--fg)] rounded-tl-sm'
              }`}
              style={m.role === 'user' ? { backgroundColor: '#1e3a5f' } : {}}
            >
              {m.role === 'user' ? (
                <span>{m.content}</span>
              ) : (
                <div className="prose prose-sm max-w-none">{renderText(m.content)}</div>
              )}
            </div>
          </div>
          )
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold mr-2 flex-shrink-0 mt-0.5" style={{ backgroundColor: '#1e3a5f' }}>AI</div>
            <div className="bg-[var(--panel)] border border-[var(--border)] rounded-2xl rounded-tl-sm px-4 py-3">
              <div className="flex gap-1 items-center">
                <span className="w-2 h-2 rounded-full bg-[#1e3a5f] animate-bounce" style={{ animationDelay: '0ms' }}/>
                <span className="w-2 h-2 rounded-full bg-[#1e3a5f] animate-bounce" style={{ animationDelay: '150ms' }}/>
                <span className="w-2 h-2 rounded-full bg-[#1e3a5f] animate-bounce" style={{ animationDelay: '300ms' }}/>
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Sugestões (só quando há apenas 1 mensagem) */}
      {messages.length === 1 && !loading && (
        <div className="px-4 pb-2 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s, i) => (
            <button
              key={i}
              onClick={() => { setInput(s); }}
              className="text-xs px-3 py-1.5 rounded-full border border-[var(--border)] hover:bg-[var(--panel)] transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Arquivos anexados */}
      {attachments.length > 0 && (
        <div className="px-4 pt-2 flex flex-wrap gap-2 border-t border-[var(--border)]">
          {attachments.map(a => (
            <div
              key={a.name}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border"
              style={{ borderColor: '#1e3a5f', color: '#1e3a5f', backgroundColor: '#e8f0fe' }}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
              <span className="max-w-[160px] truncate font-medium">{a.name}</span>
              <button
                onClick={() => removeAttachment(a.name)}
                className="ml-0.5 opacity-60 hover:opacity-100 rounded-full"
              >
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/>
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="px-4 pb-4 pt-2 border-t border-[var(--border)]">
        {/* Input oculto de arquivo */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.csv,.pdf,.md,.json"
          className="hidden"
          onChange={handleFileChange}
        />

        <div className="flex gap-2 items-end">
          {/* Botão de anexar */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || loading}
            title="Anexar documento de regras (PDF, TXT, CSV)"
            className="flex-shrink-0 w-10 h-10 rounded-xl border border-[var(--border)] flex items-center justify-center hover:bg-[var(--panel)] disabled:opacity-40 transition-all"
          >
            {uploading ? (
              <svg className="w-4 h-4 animate-spin opacity-60" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
              </svg>
            )}
          </button>

          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            placeholder="Pergunte sobre as fichas, UCs ou anomalias... (Enter para enviar)"
            className="flex-1 resize-none rounded-xl border border-[var(--border)] bg-[var(--bg)] px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1e3a5f] leading-relaxed"
            style={{ maxHeight: 120 }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || loading}
            className="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-white disabled:opacity-40 transition-all"
            style={{ backgroundColor: '#1e3a5f' }}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
            </svg>
          </button>
        </div>
        <p className="text-xs opacity-30 mt-1.5 text-center">
          📎 Anexe regras · Enter para enviar · Shift+Enter nova linha · Contexto ao vivo F01–F05
        </p>
      </div>
    </div>
  );
}

/* ─── Fichas cadastradas ──────────────────────────────────────── */
const FICHAS = [
  { id: 'f01',       label: 'F01',       nome: 'Divergência de Fórmula', endpoint: '/api/v1/faturas/ficha/01',        cor: '#1a56db' },
  { id: 'f02',       label: 'F02',       nome: 'Desvio de Média',        endpoint: '/api/v1/faturas/ficha/02',        cor: '#0e9f6e' },
  { id: 'f03',       label: 'F03',       nome: 'Acúmulo de Consumo',     endpoint: '/api/v1/faturas/ficha/03',        cor: '#c27803' },
  { id: 'f04',       label: 'F04',       nome: 'Troca de Medidor',       endpoint: '/api/v1/faturas/ficha/04',        cor: '#9061f9' },
  { id: 'f05',       label: 'F05',       nome: 'Quebra de Leitura',      endpoint: '/api/v1/faturas/ficha/05',        cor: '#e02424' },
  { id: 'combinados',label: 'Combinados',nome: '2+ Fichas',              endpoint: '/api/v1/faturas/ficha/combinados',cor: '#7c3aed' },
];

/* ─── Helpers ────────────────────────────────────────────────── */
const fmt = (v) => (v == null || v === '' ? '-' : String(v));

function cellVal(v) {
  if (v == null || v === '') return '-';
  const s = String(v);
  // Tenta formatar como BRL se parecer valor monetário
  if (/^rs_|^vl_|^valor|^total|^preco/i.test('')) return s;
  return s;
}

/* ─── Resumo ─────────────────────────────────────────────────── */
function ResumoPanel({ onSelectTab }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [totalDetectadas, setTotalDetectadas] = useState(0);

  useEffect(() => {
    setLoading(true);
    apiClient.get('/api/v1/faturas/ficha/resumo')
      .then(r => {
        setData(r.data?.fichas ?? []);
        setTotalDetectadas(r.data?.total_detectadas ?? 0);
      })
      .catch(() => setError('Erro ao carregar resumo.'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 text-sm opacity-60">Carregando resumo...</div>;
  if (error)   return <div className="p-8 text-sm text-red-500">{error}</div>;

  return (
    <div className="p-6">
      {/* Banner total detectadas */}
      <div
        className="flex items-center gap-4 rounded-lg px-5 py-4 mb-6"
        style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #0f2340 100%)' }}
      >
        <div>
          <div className="text-white/60 text-xs uppercase tracking-widest mb-0.5">Total de unidades detectadas</div>
          <div className="text-white text-3xl font-bold font-mono">
            {Number(totalDetectadas).toLocaleString('pt-BR')}
          </div>
        </div>
        <div className="ml-auto text-white/30 text-xs text-right leading-relaxed">
          Faturas com pelo menos<br/>uma anomalia identificada
        </div>
      </div>
      <p className="text-sm opacity-60 mb-6">
        Visão consolidada das anomalias detectadas por tipo de irregularidade.
        Clique em uma ficha para ver os registros detalhados.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        {(data ?? []).map((f, idx) => {
          const ficha = FICHAS[idx];
          return (
            <button
              key={f.key}
              onClick={() => onSelectTab(f.key)}
              className="text-left rounded-lg border p-4 hover:shadow-md transition-all"
              style={{ borderColor: ficha?.cor ?? '#6b7280', borderWidth: 2 }}
            >
              <div
                className="text-xs font-bold px-2 py-0.5 rounded inline-block mb-2"
                style={{ backgroundColor: ficha?.cor ?? '#6b7280', color: '#fff' }}
              >
                {ficha?.label ?? f.key.toUpperCase()}
              </div>
              <div className="text-xs text-[var(--fg)] opacity-70 mb-3 leading-tight">{f.nome}</div>
              <div className="text-3xl font-bold" style={{ color: ficha?.cor ?? '#6b7280' }}>
                {Number(f.total).toLocaleString('pt-BR')}
              </div>
              <div className="text-xs opacity-50 mt-1">registros</div>
            </button>
          );
        })}
      </div>

      <div className="mt-8 rounded-lg border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#1e3a5f] text-white">
              <th className="px-4 py-2 text-left font-semibold">Ficha</th>
              <th className="px-4 py-2 text-left font-semibold">Tipo de Anomalia</th>
              <th className="px-4 py-2 text-right font-semibold">Registros</th>
              <th className="px-4 py-2 text-center font-semibold">Ação</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((f, idx) => {
              const ficha = FICHAS[idx];
              return (
                <tr key={f.key} className="border-t border-[var(--border)] hover:bg-[var(--panel)]">
                  <td className="px-4 py-2">
                    <span
                      className="text-xs font-bold px-2 py-0.5 rounded text-white"
                      style={{ backgroundColor: ficha?.cor ?? '#6b7280' }}
                    >
                      {ficha?.label ?? f.key.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-sm">{f.nome}</td>
                  <td className="px-4 py-2 text-right font-mono font-semibold">
                    {Number(f.total).toLocaleString('pt-BR')}
                  </td>
                  <td className="px-4 py-2 text-center">
                    <button
                      onClick={() => onSelectTab(f.key)}
                      className="text-xs px-3 py-1 rounded border border-[var(--border)] hover:bg-[var(--panel)]"
                    >
                      Ver detalhes →
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Renderiza resultado da análise AISURE ──────────────────── */
function AnaliseResultado({ analise, confirmado }) {
  if (!analise) return null;

  // Colorize cada linha do resultado estruturado
  const lines = analise.split('\n');
  const prioColor = { CRÍTICO: '#ef4444', ALTO: '#f97316', MÉDIO: '#eab308', BAIXO: '#22c55e' };

  return (
    <div className="rounded-lg border border-[var(--border)] overflow-hidden text-xs font-mono">
      {/* Banner confirmado/não confirmado */}
      <div
        className="flex items-center gap-2 px-3 py-2 text-white text-xs font-semibold"
        style={{ backgroundColor: confirmado ? '#16a34a' : '#dc2626' }}
      >
        {confirmado ? '✓ Anomalia Confirmada' : '✗ Anomalia Não Confirmada'}
      </div>
      {/* Texto estruturado */}
      <div className="px-3 py-2 space-y-0.5 overflow-auto max-h-64 bg-[var(--panel)]">
        {lines.map((line, i) => {
          const upper = line.toUpperCase();
          let color = 'inherit';
          let weight = 'normal';
          if (/^F0[1-5]\s*—/.test(line)) {
            if (line.includes('Confirmado') && !line.includes('Não confirmado')) color = '#4ade80';
            else if (line.includes('Não confirmado')) color = '#f87171';
            weight = '600';
          } else if (upper.startsWith('PRIORIDADE:')) {
            const prio = Object.keys(prioColor).find(p => upper.includes(p));
            color = prio ? prioColor[prio] : '#facc15';
            weight = '700';
          } else if (upper.startsWith('TOTAL DE FICHAS')) {
            color = '#93c5fd';
            weight = '600';
          } else if (upper.startsWith('UC:') || upper.startsWith('MÊS') || upper.startsWith('CONCESS')) {
            color = '#e2e8f0';
          } else if (upper.startsWith('FICHAS DETECTADAS')) {
            color = '#facc15';
            weight = '700';
          }
          return (
            <div key={i} style={{ color, fontWeight: weight, lineHeight: '1.5' }}>
              {line || '\u00a0'}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Modal de análise IA por linha ─────────────────────────── */
function ConfirmIAModal({ modal, onClose, onResult, onCriar }) {
  const [faturaText, setFaturaText] = useState('');
  const [uploading, setUploading]   = useState(false);
  const [fileName, setFileName]     = useState('');
  const [analyzing, setAnalyzing]   = useState(false);
  const [result, setResult]         = useState(modal.initialResult ?? null);
  const fileRef = useRef(null);

  const handleFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploading(true);
    try {
      const form = new FormData();
      form.append('files', file);
      const res = await apiClient.post('/api/v1/chat/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const text = res.data?.files?.[0]?.text ?? '';
      setFaturaText(text);
      setFileName(text ? file.name : file.name + ' (sem OCR — IA usará dados do banco)');
    } catch {
      setFileName('Erro ao carregar arquivo');
    } finally {
      setUploading(false);
    }
  }, []);

  const handleAnalyze = useCallback(async () => {
    setAnalyzing(true);
    setResult(null);
    try {
      const res = await apiClient.post('/api/v1/faturas/aisure/confirmar', {
        uc: modal.uc,
        fichas: modal.fichas,
        detalhamento: modal.detalhe,
        fatura_text: faturaText,
        row_data: Object.fromEntries(Object.entries(modal.row).map(([k, v]) => [k, String(v ?? '')])),
      });
      const r = { confirmado: res.data.confirmado, analise: res.data.analise };
      setResult(r);
      onResult?.(modal.rowIdx, r);
    } catch {
      setResult({ erro: true, analise: 'Erro ao conectar com o AISURE.' });
    } finally {
      setAnalyzing(false);
    }
  }, [modal, faturaText, onResult]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-xl bg-[var(--bg)] rounded-xl shadow-2xl flex flex-col border border-[var(--border)]"
        style={{ maxHeight: '90vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 rounded-t-xl flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, #1e3a5f, #0f2340)' }}
        >
          <div>
            <div className="text-white font-bold text-sm flex items-center gap-2">
              <svg className="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd"/>
              </svg>
              Análise de Anomalia — AISURE
            </div>
            <div className="text-white/50 text-xs font-mono mt-0.5">UC {modal.uc}</div>
          </div>
          <button onClick={onClose} className="text-white/50 hover:text-white">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Corpo */}
        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
          {/* Info da linha */}
          <div className="rounded-lg bg-[var(--panel)] border border-[var(--border)] px-4 py-3 text-xs space-y-1">
            <div><span className="opacity-50">Fichas:</span> <span className="font-semibold">{modal.fichas || '—'}</span></div>
            <div><span className="opacity-50">Detalhe:</span> <span>{modal.detalhe || '—'}</span></div>
          </div>

          {/* Resultado (se já houver) */}
          {analyzing && (
            <div className="flex items-center gap-2 text-xs opacity-60 py-2">
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              Auditando com IA... isso pode levar alguns segundos.
            </div>
          )}

          {result && !analyzing && (
            <AnaliseResultado analise={result.analise} confirmado={result.confirmado} />
          )}

          {/* Upload da fatura — oculto se já há resultado */}
          {!result && !analyzing && (
            <div>
              <p className="text-xs opacity-60 mb-2">
                Anexe a fatura (PDF, imagem) para análise completa. Sem anexo a IA usa os dados do banco.
              </p>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-[var(--border)] text-xs hover:bg-[var(--panel)] transition-colors w-full justify-center"
              >
                {uploading ? (
                  <><svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg> Carregando...</>
                ) : fileName ? (
                  <><span className="text-green-400">✓</span> {fileName} <span className="opacity-40">(trocar)</span></>
                ) : (
                  <><svg className="w-3.5 h-3.5 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/></svg> Anexar fatura (opcional)</>
                )}
              </button>
              <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" className="hidden" onChange={handleFile}/>
            </div>
          )}
        </div>

        {/* Rodapé */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--border)] flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--panel)]">
            {result ? 'Fechar' : 'Cancelar'}
          </button>
          {result ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setResult(null); }}
                className="px-3 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--panel)] flex items-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                </svg>
                Reanalisar
              </button>
              <button
                onClick={() => { onCriar?.(modal, result); onClose(); }}
                className="px-4 py-2 text-sm rounded-lg text-white font-semibold flex items-center gap-2"
                style={{ backgroundColor: '#16a34a' }}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
                </svg>
                Criar Requisição
              </button>
            </div>
          ) : (
            <button
              onClick={handleAnalyze}
              disabled={uploading || analyzing}
              className="px-4 py-2 text-sm rounded-lg text-white font-semibold flex items-center gap-2 disabled:opacity-50"
              style={{ backgroundColor: '#1e3a5f' }}
            >
              <svg className="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd"/>
              </svg>
              Analisar com IA
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Modal de criação de requisição a partir da análise IA ──── */
const MESES_ABREV = ['','Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const MESES_FULL  = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function parseMesRef(mesRef) {
  const parts = String(mesRef || '').split('-');
  return { ano: parts[0] || '', mes: parts[1] ? String(parseInt(parts[1], 10)) : '' };
}

function extractPriority(analise) {
  const m = String(analise || '').match(/PRIORIDADE\s*:\s*(CRÍTICO|CRITICO|ALTO|MÉDIO|MEDIO|BAIXO)/i);
  return m ? m[1].toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') : null;
}

function CriarRequisicaoModal({ modal, result, onClose, onSuccess }) {
  const row = modal.row ?? {};

  const initPeriodo = parseMesRef(row.Mes_Ref);

  const [fields, setFields] = useState({
    uc:                      modal.uc || '',
    cliente:                 row.RAZAO_SOCIAL || '',
    razaoSocialFatura:       row.RAZAO_SOCIAL || '',
    concessionaria:          row.Concessionaria || '',
    cnpj:                    '',
    linkFatura:              row.Link || '',
    ressarcimentoEstimado:   String(row.RS_Total_Fatura || '').replace(/[^\d,\.]/g, '') || '',
    descricaoIrregularidade: result?.analise || modal.detalhe || '',
    problemaIdentificado:    modal.fichas || '',
  });
  const [mes, setMes]       = useState(initPeriodo.mes);
  const [ano, setAno]       = useState(initPeriodo.ano);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]   = useState('');
  const [createdId, setCreatedId] = useState(null);

  const set = (k) => (e) => setFields(prev => ({ ...prev, [k]: e.target.value }));

  const priority = extractPriority(result?.analise);
  const prioColor = { CRITICO: '#ef4444', ALTO: '#f97316', MEDIO: '#eab308', BAIXO: '#22c55e' };

  const handleSubmit = useCallback(async () => {
    setError('');
    const missing = [];
    if (!fields.uc)                      missing.push('UC');
    if (!fields.cliente)                 missing.push('Cliente');
    if (!fields.concessionaria)          missing.push('Concessionária');
    if (!fields.descricaoIrregularidade) missing.push('Descrição');
    if (!mes || !ano)                    missing.push('Período');
    if (!fields.ressarcimentoEstimado)   missing.push('Valor estimado');
    if (missing.length) { setError('Preencha: ' + missing.join(', ')); return; }

    setSubmitting(true);
    try {
      const form = new FormData();
      form.append('uc',                      fields.uc);
      form.append('cliente',                 fields.cliente);
      form.append('razaoSocialFatura',       fields.razaoSocialFatura);
      form.append('concessionaria',          fields.concessionaria);
      form.append('cnpj',                    fields.cnpj);
      form.append('linkFatura',              fields.linkFatura);
      form.append('problemaIdentificado',    fields.problemaIdentificado);
      form.append('descricaoIrregularidade', fields.descricaoIrregularidade);
      form.append('ressarcimentoEstimado',
        fields.ressarcimentoEstimado.replace(/\./g, '').replace(',', '.'));
      form.append('periodosIrregularidade',
        JSON.stringify([{ mes: String(mes), ano: String(ano) }]));

      const res = await apiClient.post('/api/v1/requisicoes', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const id = res.data?.id ?? res.data?.requisicao_id ?? null;
      setCreatedId(id ?? true);
      onSuccess?.(res.data);
    } catch (e) {
      const msg = e?.response?.data?.error || e?.response?.data?.missing_fields?.join(', ') || 'Erro ao criar requisição.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }, [fields, mes, ano, onSuccess]);

  const inputCls = 'w-full px-3 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)] focus:outline-none focus:ring-1 focus:ring-blue-500';
  const labelCls = 'block text-xs opacity-60 mb-0.5';

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="w-full max-w-2xl bg-[var(--bg)] rounded-xl shadow-2xl flex flex-col border border-[var(--border)]"
        style={{ maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 rounded-t-xl flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, #166534, #14532d)' }}
        >
          <div>
            <div className="text-white font-bold text-sm flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
              Nova Requisição de Ressarcimento
            </div>
            <div className="text-white/50 text-xs font-mono mt-0.5">UC {modal.uc}</div>
          </div>
          <button onClick={onClose} className="text-white/50 hover:text-white">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Sucesso */}
        {createdId ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
            <div className="w-14 h-14 rounded-full bg-green-500/20 flex items-center justify-center">
              <svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
              </svg>
            </div>
            <div>
              <div className="text-lg font-bold">Requisição criada!</div>
              {createdId !== true && (
                <div className="text-sm opacity-60 mt-1">Req #{createdId}</div>
              )}
              <div className="text-xs opacity-50 mt-2">Acesse a planilha para acompanhar o processo.</div>
            </div>
            <button onClick={onClose} className="px-5 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--panel)]">
              Fechar
            </button>
          </div>
        ) : (
          <>
            {/* Sumário */}
            <div className="px-5 pt-4 flex-shrink-0">
              <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-xs space-y-1">
                <div className="font-semibold text-blue-300 mb-1">O que será criado</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 opacity-80">
                  <span><span className="opacity-60">UC:</span> <strong>{modal.uc}</strong></span>
                  <span><span className="opacity-60">Fichas:</span> <strong>{modal.fichas || '—'}</strong></span>
                  {priority && (
                    <span className="font-bold" style={{ color: prioColor[priority] || '#facc15' }}>
                      {priority}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Formulário */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {/* Linha 1: UC + Concessionária */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>UC *</label>
                  <input className={inputCls} value={fields.uc} readOnly style={{ opacity: 0.6 }}/>
                </div>
                <div>
                  <label className={labelCls}>Concessionária *</label>
                  <input className={inputCls} value={fields.concessionaria} onChange={set('concessionaria')} placeholder="Ex: CEMIG"/>
                </div>
              </div>

              {/* Linha 2: Cliente + Razão Social */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Cliente *</label>
                  <input className={inputCls} value={fields.cliente} onChange={set('cliente')} placeholder="Nome do cliente"/>
                </div>
                <div>
                  <label className={labelCls}>Razão Social (Fatura)</label>
                  <input className={inputCls} value={fields.razaoSocialFatura} onChange={set('razaoSocialFatura')} placeholder="Razão social conforme fatura"/>
                </div>
              </div>

              {/* Linha 3: CNPJ + Período */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={labelCls}>CNPJ</label>
                  <input className={inputCls} value={fields.cnpj} onChange={set('cnpj')} placeholder="00.000.000/0000-00"/>
                </div>
                <div>
                  <label className={labelCls}>Mês da irregularidade *</label>
                  <select className={inputCls} value={mes} onChange={e => setMes(e.target.value)}>
                    <option value="">Mês</option>
                    {MESES_FULL.slice(1).map((m, i) => (
                      <option key={i+1} value={i+1}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Ano *</label>
                  <input className={inputCls} value={ano} onChange={e => setAno(e.target.value)} placeholder="2025" maxLength={4}/>
                </div>
              </div>

              {/* Linha 4: Link + Valor */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Link da Fatura</label>
                  <input className={inputCls} value={fields.linkFatura} onChange={set('linkFatura')} placeholder="https://..."/>
                </div>
                <div>
                  <label className={labelCls}>Ressarcimento Estimado (R$) *</label>
                  <input className={inputCls} value={fields.ressarcimentoEstimado} onChange={set('ressarcimentoEstimado')} placeholder="0,00"/>
                </div>
              </div>

              {/* Problema identificado */}
              <div>
                <label className={labelCls}>Problema identificado</label>
                <input className={inputCls} value={fields.problemaIdentificado} onChange={set('problemaIdentificado')} placeholder="Ex: F01, F02"/>
              </div>

              {/* Descrição */}
              <div>
                <label className={labelCls}>Descrição da irregularidade * <span className="opacity-40">(pré-preenchida com análise da IA — edite se necessário)</span></label>
                <textarea
                  className={inputCls + ' resize-y'}
                  rows={6}
                  value={fields.descricaoIrregularidade}
                  onChange={set('descricaoIrregularidade')}
                  placeholder="Descreva a irregularidade detectada..."
                />
              </div>

              {error && (
                <div className="text-xs text-red-400 bg-red-400/10 border border-red-400/30 rounded px-3 py-2">
                  {error}
                </div>
              )}
            </div>

            {/* Rodapé */}
            <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--border)] flex-shrink-0">
              <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--panel)]">
                Cancelar
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="px-5 py-2 text-sm rounded-lg text-white font-semibold flex items-center gap-2 disabled:opacity-50"
                style={{ backgroundColor: '#166534' }}
              >
                {submitting ? (
                  <><svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg> Criando...</>
                ) : (
                  <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg> Criar Requisição</>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Drawer histórico de faturas da UC ──────────────────────── */
function UCHistoricoDrawer({ uc, onClose }) {
  const [rows, setRows]     = useState([]);
  const [cols, setCols]     = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uc) return;
    setLoading(true);
    apiClient.get('/api/v1/faturas/uc-historico', { params: { uc } })
      .then(r => { setCols(r.data?.columns ?? []); setRows(r.data?.rows ?? []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [uc]);

  if (!uc) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl h-full bg-[var(--bg)] shadow-2xl flex flex-col border-l border-[var(--border)]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, #1e3a5f, #0f2340)' }}
        >
          <div>
            <div className="text-white font-bold text-sm">Histórico de Faturas</div>
            <div className="text-white/60 text-xs font-mono">UC {uc}</div>
          </div>
          <button onClick={onClose} className="text-white/60 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Conteúdo */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-sm opacity-50">Carregando faturas...</div>
          ) : rows.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-sm opacity-50">Nenhuma fatura encontrada para a UC {uc}.</div>
          ) : (
            <table className="min-w-full text-xs border-collapse" style={{ fontFamily: 'Consolas, "Courier New", monospace' }}>
              <thead className="sticky top-0">
                <tr style={{ backgroundColor: '#1e3a5f', color: '#fff' }}>
                  {cols.map(col => (
                    <th key={col} className="px-3 py-2 text-left font-semibold whitespace-nowrap border-r border-[#2d5080] last:border-r-0">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className={`border-b border-[var(--border)] ${i % 2 === 0 ? 'bg-[var(--bg)]' : 'bg-[var(--panel)]'}`}>
                    {cols.map(col => (
                      <td key={col} className="px-3 py-1 whitespace-nowrap border-r border-[var(--border)] last:border-r-0">
                        {row[col] == null ? '-' : String(row[col])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-2 text-xs opacity-40 border-t border-[var(--border)] flex-shrink-0">
          {rows.length} fatura{rows.length !== 1 ? 's' : ''} · últimas 60 referências
        </div>
      </div>
    </div>
  );
}

/* ─── Painel de Ficha ─────────────────────────────────────────── */
function FichaPanel({ ficha, ucsEmProcesso }) {
  const [cols, setCols]       = useState([]);
  const [rows, setRows]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded]   = useState(false);
  const [error, setError]     = useState('');
  const [search, setSearch]   = useState('');
  const [confirmMap, setConfirmMap] = useState({}); // rowIdx → { loading, confirmado, analise }
  const [ucDrawer, setUcDrawer]     = useState(null);
  const theadRef = useRef(null);

  const ucSet = useMemo(() => new Set((ucsEmProcesso ?? []).map(String)), [ucsEmProcesso]);

  const load = useCallback(async () => {
    if (loaded) return;
    setLoading(true);
    setError('');
    try {
      const res = await apiClient.get(ficha.endpoint, { params: { limit: 5000, offset: 0 } });
      setCols(res.data?.columns ?? []);
      setRows(res.data?.rows ?? []);
      setTotal(res.data?.total ?? 0);
      setLoaded(true);
    } catch {
      setError('Erro ao carregar dados da ficha.');
    } finally {
      setLoading(false);
    }
  }, [ficha.endpoint, loaded]);

  useEffect(() => { load(); }, [load]);

  /* Coluna que representa a UC nessa ficha */
  const ucCol = useMemo(() => {
    if (!cols.length) return null;
    return cols.find(c => /^uc$/i.test(c) || /^id_uc$/i.test(c) || /^num_uc$/i.test(c)) ?? null;
  }, [cols]);

  /* Filtro client-side */
  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter(row =>
      Object.values(row).some(v => v != null && String(v).toLowerCase().includes(q))
    );
  }, [rows, search]);

  /* Separa linhas: em processo primeiro */
  const { emProcesso, normais } = useMemo(() => {
    if (!ucCol || ucSet.size === 0) return { emProcesso: [], normais: filtered };
    const ep = [];
    const n  = [];
    for (const r of filtered) {
      const v = r[ucCol];
      if (v != null && ucSet.has(String(v))) ep.push(r);
      else n.push(r);
    }
    return { emProcesso: ep, normais: n };
  }, [filtered, ucCol, ucSet]);

  const allRows = [...emProcesso, ...normais];

  const [confirmModal, setConfirmModal] = useState(null); // { rowIdx, row, uc, fichas, detalhe }
  const [criarReqData, setCriarReqData] = useState(null); // { modal, result }

  const openConfirmModal = useCallback((rowIdx, row, initialResult = null) => {
    const uc      = ucCol ? String(row[ucCol] ?? '') : '';
    const fichas  = String(row['fichas_aplicadas'] ?? '');
    const detalhe = String(row['detalhamento'] ?? '');
    setConfirmModal({ rowIdx, row, uc, fichas, detalhe, initialResult });
  }, [ucCol]);

  const handleConfirmResult = useCallback((rowIdx, result) => {
    setConfirmMap(prev => ({ ...prev, [rowIdx]: result }));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="flex items-center gap-2 text-sm opacity-60">
          <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
          </svg>
          Carregando {ficha.nome}...
        </div>
      </div>
    );
  }

  if (error) return <div className="p-6 text-sm text-red-500">{error}</div>;

  return (
    <div className="flex flex-col h-full">
      {/* Barra de busca */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--panel)]">
        <div className="relative flex-1 max-w-sm">
          <svg className="absolute left-2.5 top-2 w-4 h-4 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/>
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar em qualquer coluna..."
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded border border-[var(--border)] bg-[var(--bg)] focus:outline-none focus:ring-1"
            style={{ '--tw-ring-color': ficha.cor }}
          />
        </div>

        {emProcesso.length > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-white px-2 py-1 rounded" style={{ backgroundColor: '#1e3a5f' }}>
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd"/>
            </svg>
            {emProcesso.length} UC{emProcesso.length > 1 ? 's' : ''} em processo
          </div>
        )}

        <span className="text-xs opacity-50 ml-auto">
          {filtered.length.toLocaleString('pt-BR')} / {total.toLocaleString('pt-BR')} registros
        </span>
      </div>

      {/* Tabela Excel */}
      <div className="flex-1 overflow-auto">
        {cols.length === 0 ? (
          <div className="p-8 text-sm opacity-50 text-center">Nenhum dado encontrado para esta ficha.</div>
        ) : (
          <table className="min-w-full text-xs border-collapse" style={{ fontFamily: 'Consolas, "Courier New", monospace' }}>
            <thead ref={theadRef} className="sticky top-0 z-10">
              <tr style={{ backgroundColor: '#1e3a5f', color: '#fff' }}>
                <th className="px-2 py-2 text-center font-semibold border-r border-[#2d5080] w-8 select-none">#</th>
                <th className="px-2 py-2 text-center font-semibold border-r border-[#2d5080] w-16 select-none">IA</th>
                {cols.map(col => (
                  <th
                    key={col}
                    className="px-3 py-2 text-left font-semibold whitespace-nowrap border-r border-[#2d5080] last:border-r-0"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={cols.length + 2}
                    className="px-4 py-8 text-center opacity-50"
                  >
                    Nenhum resultado para "{search}"
                  </td>
                </tr>
              ) : allRows.map((row, rowIdx) => {
                const ucVal = ucCol ? row[ucCol] : null;
                const isEmProcesso = ucVal != null && ucSet.has(String(ucVal));
                const isEven = rowIdx % 2 === 0;
                const cfm = confirmMap[rowIdx];

                let rowStyle = {};
                let rowClass = 'border-b transition-colors cursor-pointer ';

                if (isEmProcesso) {
                  rowStyle = { backgroundColor: '#1e3a5f', color: '#e2e8f0' };
                  rowClass += 'hover:opacity-90';
                } else if (isEven) {
                  rowClass += 'bg-[var(--bg)] hover:bg-[var(--panel)] border-[var(--border)]';
                } else {
                  rowClass += 'bg-[var(--panel)] hover:brightness-95 border-[var(--border)]';
                }

                return (
                  <tr
                    key={rowIdx}
                    className={rowClass}
                    style={rowStyle}
                    onClick={() => ucVal && setUcDrawer(String(ucVal))}
                  >
                    <td
                      className="px-2 py-1 text-center border-r select-none"
                      style={isEmProcesso
                        ? { color: '#94a3b8', borderColor: '#2d5080' }
                        : { color: '#9ca3af', borderColor: 'var(--border)' }
                      }
                    >
                      {rowIdx + 1}
                    </td>
                    {/* Célula IA */}
                    <td
                      className="px-1 py-1 text-center border-r"
                      style={isEmProcesso ? { borderColor: '#2d5080' } : { borderColor: 'var(--border)' }}
                      onClick={e => e.stopPropagation()}
                    >
                      {cfm?.loading ? (
                        <svg className="animate-spin w-3.5 h-3.5 mx-auto text-yellow-500" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                        </svg>
                      ) : cfm?.erro ? (
                        <span title="Erro ao consultar IA" className="text-red-400 cursor-pointer" onClick={() => openConfirmModal(rowIdx, row)}>✕</span>
                      ) : cfm?.confirmado === true ? (
                        <button
                          title="Ver análise"
                          onClick={() => openConfirmModal(rowIdx, row, cfm)}
                          className="text-green-500 font-bold hover:opacity-80 transition-opacity"
                        >✓</button>
                      ) : cfm?.confirmado === false ? (
                        <button
                          title="Ver análise"
                          onClick={() => openConfirmModal(rowIdx, row, cfm)}
                          className="text-red-400 hover:opacity-80 transition-opacity"
                        >✗</button>
                      ) : (
                        <button
                          title="Analisar com IA"
                          onClick={() => openConfirmModal(rowIdx, row)}
                          className="inline-flex items-center justify-center w-6 h-6 rounded text-yellow-400 hover:bg-yellow-400/20 transition-colors"
                        >
                          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd"/>
                          </svg>
                        </button>
                      )}
                    </td>
                    {cols.map(col => {
                      const v = row[col];
                      const isLink = /^https?:\/\//i.test(String(v ?? ''));
                      return (
                        <td
                          key={col}
                          className="px-3 py-1 whitespace-nowrap border-r last:border-r-0"
                          style={isEmProcesso ? { borderColor: '#2d5080' } : { borderColor: 'var(--border)' }}
                        >
                          {isLink ? (
                            <a
                              href={String(v)}
                              target="_blank"
                              rel="noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="text-blue-400 underline hover:text-blue-300"
                              title={String(v)}
                            >
                              Ver fatura ↗
                            </a>
                          ) : cellVal(v)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Rodapé */}
      <div
        className="flex items-center justify-between px-4 py-2 text-xs border-t border-[var(--border)]"
        style={{ backgroundColor: '#1e3a5f', color: '#94a3b8' }}
      >
        <span>
          {ficha.label} · {ficha.nome}
        </span>
        <span>
          {emProcesso.length > 0 && (
            <span className="mr-3">
              <span className="inline-block w-2.5 h-2.5 rounded-sm mr-1" style={{ backgroundColor: '#4a90d9' }}/>
              UC em processo
            </span>
          )}
          <span className="mr-3 text-yellow-400/70">⚡ clique em linha para ver faturas · ⚡ botão IA para confirmar</span>
          Total: <strong className="text-white">{filtered.length.toLocaleString('pt-BR')}</strong> linhas
        </span>
      </div>

      {/* Modal de análise IA */}
      {confirmModal && (
        <ConfirmIAModal
          modal={confirmModal}
          onClose={() => setConfirmModal(null)}
          onResult={handleConfirmResult}
          onCriar={(modal, result) => setCriarReqData({ modal, result })}
        />
      )}

      {criarReqData && (
        <CriarRequisicaoModal
          modal={criarReqData.modal}
          result={criarReqData.result}
          onClose={() => setCriarReqData(null)}
          onSuccess={() => setCriarReqData(null)}
        />
      )}

      {/* Drawer de histórico da UC */}
      {ucDrawer && (
        <UCHistoricoDrawer uc={ucDrawer} onClose={() => setUcDrawer(null)} />
      )}
    </div>
  );
}

/* ─── Componente principal ────────────────────────────────────── */
export default function AnaliseDesvio() {
  const [activeTab, setActiveTab] = useState('resumo');
  const [ucsEmProcesso, setUcsEmProcesso] = useState([]);

  /* Carrega UCs em processo uma vez */
  useEffect(() => {
    apiClient.get('/api/v1/faturas/ucs-em-processo')
      .then(r => setUcsEmProcesso(r.data?.ucs ?? []))
      .catch(() => {});
  }, []);

  const handleSelectTab = useCallback((tabId) => setActiveTab(tabId), []);

  const activeColor = useMemo(() => {
    if (activeTab === 'resumo') return '#1e3a5f';
    return FICHAS.find(f => f.id === activeTab)?.cor ?? '#1e3a5f';
  }, [activeTab]);

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* Header */}
      <div className="px-4 pt-4 pb-0 flex items-center gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Análise de Desvio</h1>
          <p className="text-xs opacity-50 mt-0.5">Fichas de anomalia detectadas · banco sgeeasy_clientes_novo</p>
        </div>
        {ucsEmProcesso.length > 0 && (
          <div
            className="ml-auto flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full text-white font-medium"
            style={{ backgroundColor: '#1e3a5f' }}
          >
            <span
              className="inline-block w-2 h-2 rounded-sm"
              style={{ backgroundColor: '#4a90d9' }}
            />
            {ucsEmProcesso.length} UCs monitoradas em processo
          </div>
        )}
      </div>

      {/* Barra de abas estilo Excel */}
      <div className="flex items-end gap-0 px-4 pt-3 overflow-x-auto border-b border-[var(--border)]">
        {/* Aba Resumo */}
        <button
          onClick={() => setActiveTab('resumo')}
          className="px-4 py-2 text-sm font-medium rounded-t border border-b-0 whitespace-nowrap transition-colors"
          style={activeTab === 'resumo'
            ? { backgroundColor: '#1e3a5f', color: '#fff', borderColor: '#1e3a5f', zIndex: 1, marginBottom: -1 }
            : { backgroundColor: 'var(--panel)', color: 'var(--fg)', borderColor: 'var(--border)', opacity: 0.7 }
          }
        >
          Resumo
        </button>

        <div className="w-2" />

        {FICHAS.map(f => (
          <button
            key={f.id}
            onClick={() => setActiveTab(f.id)}
            className="px-4 py-2 text-sm font-medium rounded-t border border-b-0 whitespace-nowrap transition-colors"
            style={activeTab === f.id
              ? { backgroundColor: f.cor, color: '#fff', borderColor: f.cor, zIndex: 1, marginBottom: -1 }
              : { backgroundColor: 'var(--panel)', color: 'var(--fg)', borderColor: 'var(--border)', opacity: 0.7 }
            }
          >
            {f.label}
            <span className="ml-1.5 text-xs opacity-75 hidden sm:inline">· {f.nome}</span>
          </button>
        ))}

        <div className="w-2" />

        {/* Aba AISURE */}
        <button
          onClick={() => setActiveTab('aisure')}
          className="px-4 py-2 text-sm font-medium rounded-t border border-b-0 whitespace-nowrap transition-all flex items-center gap-1.5"
          style={activeTab === 'aisure'
            ? { background: 'linear-gradient(135deg, #1e3a5f, #0f2340)', color: '#fff', borderColor: '#1e3a5f', zIndex: 1, marginBottom: -1 }
            : { backgroundColor: 'var(--panel)', color: 'var(--fg)', borderColor: 'var(--border)', opacity: 0.7 }
          }
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
          </svg>
          AISURE
        </button>
      </div>

      {/* Conteúdo das abas */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'resumo' ? (
          <div className="h-full overflow-auto">
            <ResumoPanel onSelectTab={handleSelectTab} />
          </div>
        ) : activeTab === 'aisure' ? (
          <div className="h-full">
            <AisurePanel />
          </div>
        ) : (
          FICHAS.map(f => (
            activeTab === f.id ? (
              <div key={f.id} className="h-full flex flex-col">
                <FichaPanel
                  ficha={f}
                  ucsEmProcesso={ucsEmProcesso}
                />
              </div>
            ) : null
          ))
        )}
      </div>
    </div>
  );
}
