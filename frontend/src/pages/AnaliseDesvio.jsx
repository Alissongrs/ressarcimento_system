import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import apiClient from '../services/apiClient';
import { addChatMessage, createChatSession, deleteChatSession, listChatMessages, listChatSessions } from '../services/chatService.js';
import * as pdfjsLib from 'pdfjs-dist';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).href;

const ANALISE_DESVIO_RESULTS_KEY = 'analise_desvio_confirm_results_v1';
const ANALISE_DESVIO_BATCH_HISTORY_KEY = 'analise_desvio_batch_history_v1';
const REMOTE_FATURA_CACHE = new Map();
const TRANSIENT_AI_ERROR_RE = /(upstream_unavailable|timeout|temporar|overloaded|rate limit|connection reset|bad gateway|service unavailable)/i;
const AISURE_SESSION_PREFIX = 'AISURE_DESVIO: ';

/* Converte todas as páginas de um PDF em imagens PNG (base64) via canvas */
async function pdfToImages(file, scale = 2.0) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdf.numPages;
  const pages = [];
  for (let i = 1; i <= totalPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const dataUrl = canvas.toDataURL('image/png');
    pages.push({ base64: dataUrl.split(',')[1], mime: 'image/png', previewUrl: dataUrl, pageNum: i });
  }
  return { pages, totalPages, name: file.name };
}

async function fileToImageData(file) {
  const dataUrl = await new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = (ev) => res(ev.target.result);
    reader.onerror = () => rej(new Error('Falha ao ler arquivo'));
    reader.readAsDataURL(file);
  });
  const base64 = String(dataUrl).split(',')[1];
  return {
    pages: [{ base64, mime: file.type || 'image/jpeg', previewUrl: dataUrl, pageNum: 1 }],
    totalPages: 1,
    name: file.name,
  };
}

async function detectRemoteFileKind(blob, filename = '', contentType = '') {
  const lowerName = String(filename || '').toLowerCase();
  const lowerType = String(contentType || blob?.type || '').toLowerCase();

  if (lowerType.includes('pdf') || lowerName.endsWith('.pdf')) return 'pdf';
  if (lowerType.startsWith('image/')) return 'image';
  if (/\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(lowerName)) return 'image';

  const head = await blob.slice(0, 16).arrayBuffer();
  const bytes = new Uint8Array(head);
  const ascii = Array.from(bytes).map(b => String.fromCharCode(b)).join('');

  if (ascii.startsWith('%PDF-')) return 'pdf';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image';
  if (ascii.startsWith('RIFF') && ascii.includes('WEBP')) return 'image';
  if ((bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)) return 'image';

  return '';
}

function getRowFaturaLink(row) {
  return String(row?.Link ?? row?.link ?? '').trim();
}

function isTransientAisureError(error) {
  const msg = String(error?.response?.data?.error || error?.message || error || '');
  return TRANSIENT_AI_ERROR_RE.test(msg);
}

function readStoredJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function appendBatchHistory(entry) {
  const current = readStoredJson(ANALISE_DESVIO_BATCH_HISTORY_KEY, []);
  const next = [entry, ...current].slice(0, 20);
  writeStoredJson(ANALISE_DESVIO_BATCH_HISTORY_KEY, next);
}

/* Extrai texto de um File (PDF ou imagem) usando o mesmo endpoint do chat */
async function extractFaturaText(file) {
  const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const isImg = file.type.startsWith('image/') || /\.(png|jpg|jpeg|webp)$/i.test(file.name);
  if (!isPDF && !isImg) throw new Error(`tipo de arquivo não suportado: ${file.type || file.name}`);
  const imgData = isPDF ? await pdfToImages(file) : await fileToImageData(file);
  const res = await apiClient.post('/api/v1/chat/extract-pdf', {
    name: file.name,
    images: imgData.pages.map(p => ({ base64: p.base64, mime: p.mime })),
  });
  return {
    name: res.data?.name ?? file.name,
    text: String(res.data?.text ?? '').trim(),
  };
}

async function loadFaturaDataFromLink(link) {
  const trimmed = String(link || '').trim();
  if (!trimmed) return null;
  if (REMOTE_FATURA_CACHE.has(trimmed)) return REMOTE_FATURA_CACHE.get(trimmed);

  const res = await apiClient.get('/api/v1/faturas/aisure/fetch', {
    params: { url: trimmed },
    responseType: 'blob',
  });
  const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
  const disposition = String(res.headers?.['content-disposition'] || '');
  const nameMatch = disposition.match(/filename="?([^"]+)"?/i);
  const guessedName = nameMatch?.[1] || (contentType.includes('pdf') ? 'fatura.pdf' : 'fatura.jpg');
  const blob = new Blob([res.data], { type: res.data?.type || contentType || 'application/octet-stream' });
  const file = new File([blob], guessedName, { type: blob.type || contentType || 'application/octet-stream' });

  const data = await extractFaturaText(file);
  REMOTE_FATURA_CACHE.set(trimmed, data);
  return data;
}

async function runAisureConfirm({ uc, fichas, detalhe, row, faturaData }) {
  const body = {
    uc,
    fichas,
    detalhamento: detalhe,
    row_data: Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [k, String(v ?? '')])),
    fatura_link: getRowFaturaLink(row),
  };
  if (faturaData?.text) {
    body.fatura_text = faturaData.text;
  }
  const res = await apiClient.post('/api/v1/faturas/aisure/confirmar', body);
  return {
    confirmado: res.data.confirmado,
    analise: res.data.analise,
    calcFinanceiro: res.data.calculo_financeiro || null,
  };
}

async function runAisureConfirmWithRetry(payload, maxAttempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runAisureConfirm(payload);
    } catch (error) {
      lastError = error;
      if (!isTransientAisureError(error) || attempt >= maxAttempts) break;
    }
  }
  throw lastError;
}

/* Chat AISURE */
function AisurePanel() {
  const initialAssistantMessage = useMemo(() => ({
    role: 'assistant',
    content: 'Olá! Sou o **AISURE**, assistente de análise de anomalias em faturas de energia.\n\nPosso responder perguntas como:\n- "Qual UC tem mais ocorrências na F02?"\n- "Analise a UC 48341497 nas fichas de irregularidade"\n- "Explique o que é desvio de média"\n\nVocê também pode **anexar um documento de regras** (PDF, TXT, CSV) usando o botão 📎 abaixo.\n\nComo posso ajudar?',
  }), []);
  const [messages, setMessages] = useState([
    initialAssistantMessage,
  ]);
  const [input, setInput]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [attachments, setAttachments] = useState([]);   // [{ name, text, previewUrl?, isImage? }]
  const [uploading, setUploading]   = useState(false);
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingSessionMessages, setLoadingSessionMessages] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const fileInputRef = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const reloadSessions = useCallback(async (preferredId = null) => {
    setLoadingSessions(true);
    try {
      const res = await listChatSessions();
      const nextSessions = (res?.sessions ?? []).filter((session) =>
        String(session?.title || '').startsWith(AISURE_SESSION_PREFIX),
      );
      setSessions(nextSessions);
      if (preferredId) {
        setActiveSessionId(preferredId);
      } else if (!activeSessionId && nextSessions.length > 0) {
        setActiveSessionId(nextSessions[0].id);
      }
    } catch {
      setSessions([]);
    } finally {
      setLoadingSessions(false);
    }
  }, [activeSessionId]);

  useEffect(() => {
    reloadSessions();
  }, [reloadSessions]);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([initialAssistantMessage]);
      return;
    }

    let cancelled = false;
    setLoadingSessionMessages(true);
    listChatMessages(activeSessionId)
      .then((res) => {
        if (cancelled) return;
        const loaded = (res?.messages ?? []).map((m) => ({ role: m.role, content: m.content }));
        setMessages(loaded.length > 0 ? loaded : [initialAssistantMessage]);
      })
      .catch(() => {
        if (!cancelled) setMessages([initialAssistantMessage]);
      })
      .finally(() => {
        if (!cancelled) setLoadingSessionMessages(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, initialAssistantMessage]);

  const handleNewChat = useCallback(() => {
    setActiveSessionId(null);
    setAttachments([]);
    setMessages([initialAssistantMessage]);
    setInput('');
  }, [initialAssistantMessage]);

  const handleDeleteSession = useCallback(async (sessionId) => {
    try {
      await deleteChatSession(sessionId);
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
        setAttachments([]);
        setMessages([initialAssistantMessage]);
      }
    } catch {}
  }, [activeSessionId, initialAssistantMessage]);

  const ingestAttachmentFile = useCallback(async (file, sourceLabel = 'arquivo') => {
    setUploading(true);
    setMessages(prev => [...prev, {
      role: 'system',
      content: `Carregando arquivo: **${file.name}**...`,
    }]);

    try {
      const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      const isImage = file.type.startsWith('image/') || /\.(png|jpg|jpeg|webp)$/i.test(file.name);

      let extractedText = '';
      let attachName = file.name;
      let previewUrl = '';

      if (isPDF || isImage) {
        // Converte PDF/imagem para base64 e extrai texto via OpenAI vision
        const data = isPDF ? await pdfToImages(file) : await fileToImageData(file);
        if (isImage) {
          previewUrl = data.pages?.[0]?.previewUrl || '';
        }
        const res = await apiClient.post('/api/v1/chat/extract-pdf', {
          name: file.name,
          images: data.pages.map(p => ({ base64: p.base64, mime: p.mime })),
        });
        extractedText = res.data?.text ?? '';
        attachName = res.data?.name ?? file.name;
      } else {
        // Arquivos texto: fluxo original via multipart
        const form = new FormData();
        form.append('files', file);
        const res = await apiClient.post('/api/v1/chat/upload', form, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        const uploaded = res.data?.files ?? [];
        extractedText = uploaded[0]?.text ?? '';
        attachName = uploaded[0]?.name ?? file.name;
      }

      if (!extractedText.trim()) {
        setMessages(prev => [...prev, {
          role: 'error',
          content: `Não foi possível extrair texto de **${file.name}**.`,
        }]);
        return;
      }

      setAttachments(prev => {
        const names = new Set(prev.map(a => a.name));
        if (names.has(attachName)) return prev;
        return [...prev, { name: attachName, text: extractedText, previewUrl, isImage }];
      });
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `${sourceLabel === 'print' ? 'Print' : 'Arquivo'} **${attachName}** carregado com sucesso! O conteúdo será usado como contexto em todas as respostas desta sessão.\n\nPode perguntar sobre os dados ou pedir análise.`,
      }]);
    } catch {
      setMessages(prev => [...prev, {
        role: 'error',
        content: `Erro ao processar **${file.name}**.`,
      }]);
    } finally {
      setUploading(false);
    }
  }, []);

  /* Upload de arquivo */
  const handleFileChange = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    await ingestAttachmentFile(file, 'arquivo');
  }, [ingestAttachmentFile]);

  const handlePaste = useCallback(async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (imageItems.length === 0) return;

    e.preventDefault();
    for (let i = 0; i < imageItems.length; i++) {
      const file = imageItems[i].getAsFile();
      if (!file) continue;
      const ext = file.type.split('/')[1] || 'png';
      const namedFile = new File([file], `print-${Date.now()}-${i + 1}.${ext}`, { type: file.type || 'image/png' });
      // eslint-disable-next-line no-await-in-loop
      await ingestAttachmentFile(namedFile, 'print');
    }
  }, [ingestAttachmentFile]);

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
      let sessionId = activeSessionId;
      if (!sessionId) {
        const created = await createChatSession({ title: `${AISURE_SESSION_PREFIX}${q.slice(0, 80)}` });
        sessionId = created?.id;
        if (sessionId) {
          setActiveSessionId(sessionId);
          await reloadSessions(sessionId);
        }
      }
      if (sessionId) {
        await addChatMessage({ id: sessionId, role: 'user', content: q });
      }
      const res = await apiClient.post('/api/v1/faturas/aisure/chat', {
        question: q,
        history,
        attachments,
      });
      setMessages(prev => [...prev, { role: 'assistant', content: res.data.answer }]);
      if (sessionId) {
        await addChatMessage({ id: sessionId, role: 'assistant', content: res.data.answer });
        await reloadSessions(sessionId);
      }
    } catch (e) {
      const msg = e?.response?.data?.error ?? 'Erro ao conectar com o AISURE.';
      setMessages(prev => [...prev, { role: 'error', content: msg }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, attachments, activeSessionId, reloadSessions]);

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  /* Renderiza markdown: **negrito**, `código`, #headers, listas, separadores, blocos de código */
  const renderText = (text) => {
    const lines = text.split('\n');
    const result = [];
    let codeBlock = [];
    let inCode = false;
    let listItems = [];

    const flushList = (key) => {
      if (listItems.length === 0) return;
      result.push(<ul key={`ul-${key}`} className="ml-4 my-1 space-y-0.5 list-disc">{listItems}</ul>);
      listItems = [];
    };

    const renderInline = (line, key) => {
      // bold + inline code
      const parts = line.split(/(\*\*.*?\*\*|`[^`]+`)/g);
      return parts.map((p, j) => {
        if (p.startsWith('**') && p.endsWith('**')) return <strong key={j}>{p.slice(2, -2)}</strong>;
        if (p.startsWith('`') && p.endsWith('`')) return <code key={j} className="px-1 py-0.5 rounded text-[0.75em] font-mono" style={{ background: 'rgba(30,58,95,0.12)', color: '#1e3a5f' }}>{p.slice(1, -1)}</code>;
        return <span key={j}>{p}</span>;
      });
    };

    lines.forEach((line, i) => {
      if (line.startsWith('```')) {
        if (inCode) {
          result.push(
            <pre key={`code-${i}`} className="my-2 rounded-lg text-xs font-mono overflow-x-auto p-3" style={{ background: '#0f2340', color: '#a5d6f7', lineHeight: 1.5 }}>
              {codeBlock.join('\n')}
            </pre>
          );
          codeBlock = [];
          inCode = false;
        } else {
          flushList(i);
          inCode = true;
        }
        return;
      }
      if (inCode) { codeBlock.push(line); return; }

      if (line.startsWith('### ')) {
        flushList(i);
        result.push(<h3 key={i} className="font-bold text-sm mt-3 mb-1" style={{ color: '#1e3a5f' }}>{renderInline(line.slice(4), i)}</h3>);
      } else if (line.startsWith('## ')) {
        flushList(i);
        result.push(<h2 key={i} className="font-bold text-base mt-3 mb-1 border-b pb-0.5" style={{ color: '#1e3a5f', borderColor: '#1e3a5f33' }}>{renderInline(line.slice(3), i)}</h2>);
      } else if (line.startsWith('# ')) {
        flushList(i);
        result.push(<h1 key={i} className="font-bold text-lg mt-3 mb-1" style={{ color: '#1e3a5f' }}>{renderInline(line.slice(2), i)}</h1>);
      } else if (/^\d+\.\s/.test(line)) {
        flushList(i);
        result.push(<ol key={`ol-${i}`} className="ml-4 list-decimal"><li className="text-sm leading-relaxed">{renderInline(line.replace(/^\d+\.\s/, ''), i)}</li></ol>);
      } else if (line.startsWith('- ') || line.startsWith('• ')) {
        listItems.push(<li key={i} className="text-sm leading-relaxed">{renderInline(line.slice(2), i)}</li>);
      } else if (line.match(/^---+$/)) {
        flushList(i);
        result.push(<hr key={i} className="my-2 border-[var(--border)]" />);
      } else if (line === '') {
        flushList(i);
        result.push(<div key={i} className="h-1.5" />);
      } else {
        flushList(i);
        result.push(<p key={i} className="text-sm leading-relaxed">{renderInline(line, i)}</p>);
      }
    });
    flushList('end');
    return result;
  };

  const SUGGESTIONS = [
    { icon: '🔍', text: 'Quais UCs aparecem em mais de uma ficha?' },
    { icon: '📋', text: 'Explique o que é Divergência de Fórmula (F01)' },
    { icon: '📊', text: 'Quantos registros tem cada ficha?' },
    { icon: '⚡', text: 'Como identificar acúmulo de consumo?' },
  ];

  return (
    <div className="flex h-full overflow-hidden">
      <aside
        className={`border-r border-[var(--border)] flex flex-col flex-shrink-0 transition-all duration-200 ${
          sidebarOpen ? 'w-64' : 'w-12'
        }`}
        style={{ background: 'linear-gradient(180deg, #0f1e33 0%, #0a1628 100%)' }}
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-2 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
          {sidebarOpen && (
            <div className="pl-1">
              <div className="text-xs font-semibold text-white/80 tracking-wide uppercase">Histórico</div>
            </div>
          )}
          <button
            onClick={() => setSidebarOpen(v => !v)}
            className={`rounded-lg flex items-center justify-center transition-colors hover:bg-white/10 text-white/50 hover:text-white/90 ${sidebarOpen ? 'w-7 h-7' : 'w-8 h-8 mx-auto'}`}
            title={sidebarOpen ? 'Recolher' : 'Expandir histórico'}
          >
            <svg className={`w-4 h-4 transition-transform ${sidebarOpen ? '' : 'rotate-180'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/>
            </svg>
          </button>
        </div>

        {/* Novo chat */}
        <div className="px-2 py-2 border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
          <button
            onClick={handleNewChat}
            className={`w-full rounded-lg flex items-center gap-2 transition-colors text-white/70 hover:text-white hover:bg-white/10 ${
              sidebarOpen ? 'px-3 py-2 text-xs' : 'justify-center py-2'
            }`}
            title="Novo chat"
          >
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            {sidebarOpen && <span className="font-medium">Novo chat</span>}
          </button>
        </div>

        {/* Sessions list */}
        <div className="flex-1 overflow-y-auto py-2 px-1.5 space-y-0.5">
          {loadingSessions ? (
            <div className="text-xs text-white/30 px-2 py-2">{sidebarOpen ? 'Carregando...' : '···'}</div>
          ) : sessions.length === 0 ? (
            sidebarOpen && <div className="text-xs text-white/30 px-2 py-4 text-center leading-relaxed">Nenhuma conversa<br/>salva ainda</div>
          ) : sessions.map((session) => {
            const title = String(session.title || '').replace(AISURE_SESSION_PREFIX, '').trim() || `Sessão ${session.id.slice(0, 6)}`;
            const isActive = activeSessionId === session.id;
            return (
              <div key={session.id} className={`group rounded-lg transition-colors ${isActive ? 'bg-white/15' : 'hover:bg-white/8'}`}>
                <button
                  onClick={() => { setAttachments([]); setActiveSessionId(session.id); }}
                  className={`w-full text-left transition-colors ${sidebarOpen ? 'px-2.5 py-2' : 'flex justify-center py-2'}`}
                  title={title}
                >
                  {sidebarOpen ? (
                    <span className={`block text-xs truncate font-medium ${isActive ? 'text-white' : 'text-white/60 group-hover:text-white/80'}`}>
                      {title}
                    </span>
                  ) : (
                    <span className={`w-2 h-2 rounded-full ${isActive ? 'bg-blue-400' : 'bg-white/20'}`} />
                  )}
                </button>
                {sidebarOpen && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteSession(session.id); }}
                    className="hidden group-hover:block text-[10px] text-white/30 hover:text-red-400 px-2.5 pb-1.5 transition-colors"
                    title="Excluir"
                  >
                    excluir
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-h-0">
        {/* Header */}
        <div
          className="flex items-center gap-3 px-5 py-3 flex-shrink-0"
          style={{
            background: 'linear-gradient(135deg, #1e3a5f 0%, #0f2340 100%)',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div className="flex items-center justify-center w-8 h-8 rounded-lg" style={{ background: 'rgba(255,255,255,0.12)' }}>
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
            </svg>
          </div>
          <div>
            <div className="text-white font-bold text-sm tracking-widest uppercase">AISURE</div>
            <div className="text-white/40 text-[11px]">Análise de anomalias em faturas · F01–F05</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.55)' }}>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0"/>
              GPT-4o
            </span>
          </div>
        </div>

        {/* Mensagens */}
        <div className="flex-1 overflow-y-auto min-h-0 px-4 py-5 space-y-5" style={{ background: 'var(--bg)' }}>
        {loadingSessionMessages && (
          <div className="text-xs text-center opacity-40 py-2">Carregando conversa...</div>
        )}
        {messages.map((m, i) => (
          m.role === 'system' ? (
            <div key={i} className="flex justify-center">
              <span className="text-[11px] opacity-40 italic px-3 py-1 rounded-full" style={{ background: 'rgba(30,58,95,0.08)' }}>
                {renderText(m.content)}
              </span>
            </div>
          ) : (
          <div key={i} className={`flex items-end gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role !== 'user' && (
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0 shadow-sm"
                style={{ background: m.role === 'error' ? '#dc2626' : 'linear-gradient(135deg,#1e3a5f,#0f2340)' }}
              >
                {m.role === 'error' ? '!' : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
                  </svg>
                )}
              </div>
            )}
            <div
              className={`max-w-[78%] rounded-2xl px-4 py-3 shadow-sm ${
                m.role === 'user'
                  ? 'rounded-br-sm text-white text-sm'
                  : m.role === 'error'
                  ? 'rounded-bl-sm border border-red-200 text-red-700 text-sm'
                  : 'rounded-bl-sm border text-[var(--fg)]'
              }`}
              style={
                m.role === 'user'
                  ? { background: 'linear-gradient(135deg,#1e3a5f,#0f2340)' }
                  : m.role === 'error'
                  ? { background: '#fff5f5' }
                  : { background: 'var(--panel)', borderColor: 'var(--border)' }
              }
            >
              {m.role === 'user' ? (
                <span className="text-sm leading-relaxed whitespace-pre-wrap">{m.content}</span>
              ) : (
                <div>{renderText(m.content)}</div>
              )}
            </div>
            {m.role === 'user' && (
              <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold text-white shadow-sm" style={{ background: '#374151' }}>
                U
              </div>
            )}
          </div>
          )
        ))}

        {loading && (
          <div className="flex items-end gap-2 justify-start">
            <div className="w-7 h-7 rounded-full flex items-center justify-center shadow-sm flex-shrink-0" style={{ background: 'linear-gradient(135deg,#1e3a5f,#0f2340)' }}>
              <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
              </svg>
            </div>
            <div className="rounded-2xl rounded-bl-sm border px-4 py-3 shadow-sm" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
              <div className="flex gap-1 items-center h-4">
                <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ backgroundColor: '#1e3a5f', animationDelay: '0ms' }}/>
                <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ backgroundColor: '#1e3a5f', animationDelay: '160ms' }}/>
                <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ backgroundColor: '#1e3a5f', animationDelay: '320ms' }}/>
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
        </div>

        {/* Sugestões (só quando há apenas 1 mensagem) */}
        {messages.length === 1 && !loading && (
          <div className="px-4 pb-3 pt-1 grid grid-cols-2 gap-2">
            {SUGGESTIONS.map((s, i) => (
              <button
                key={i}
                onClick={() => { setInput(s.text); }}
                className="flex items-start gap-2 text-left rounded-xl border px-3 py-2.5 hover:border-[#1e3a5f] hover:bg-[#1e3a5f]/5 transition-all group"
                style={{ borderColor: 'var(--border)' }}
              >
                <span className="text-base leading-none mt-0.5">{s.icon}</span>
                <span className="text-xs text-[var(--fg)] opacity-70 group-hover:opacity-100 leading-snug">{s.text}</span>
              </button>
            ))}
          </div>
        )}

        {/* Arquivos anexados */}
        {attachments.length > 0 && (
          <div className="px-4 py-2 flex flex-wrap gap-1.5 border-t" style={{ borderColor: 'var(--border)', background: 'rgba(30,58,95,0.04)' }}>
            {attachments.map(a => (
              <div
                key={a.name}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border font-medium"
                style={{ borderColor: 'rgba(30,58,95,0.3)', color: '#1e3a5f', backgroundColor: 'rgba(30,58,95,0.07)' }}
              >
                {a.previewUrl ? (
                  <img src={a.previewUrl} alt={a.name} className="w-5 h-5 rounded object-cover" style={{ border: '1px solid rgba(30,58,95,0.2)' }} />
                ) : (
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                  </svg>
                )}
                <span className="max-w-[150px] truncate">{a.name}</span>
                <button onClick={() => removeAttachment(a.name)} className="ml-0.5 opacity-50 hover:opacity-100 flex-shrink-0" title="Remover">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/>
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Input */}
        <div className="px-4 pb-4 pt-3 border-t flex-shrink-0" style={{ borderColor: 'var(--border)' }}>
          <input ref={fileInputRef} type="file" accept=".txt,.csv,.pdf,.md,.json" className="hidden" onChange={handleFileChange} />

          <div className="flex gap-2 items-end rounded-2xl border px-2 py-2 focus-within:ring-2 focus-within:ring-[#1e3a5f]/40 transition-all" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || loading}
              title="Anexar PDF, imagem ou texto"
              className="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-colors hover:bg-[#1e3a5f]/10 disabled:opacity-30"
              style={{ color: '#1e3a5f' }}
            >
              {uploading ? (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
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
              onPaste={handlePaste}
              rows={1}
              placeholder="Pergunte sobre fichas, UCs, anomalias... (Ctrl+V para colar print)"
              className="flex-1 resize-none bg-transparent text-sm focus:outline-none leading-relaxed py-1 text-[var(--fg)] placeholder:text-[var(--fg)]/30"
              style={{ maxHeight: 120 }}
            />

            <button
              onClick={send}
              disabled={!input.trim() || loading}
              className="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center text-white transition-all disabled:opacity-30"
              style={{ background: input.trim() && !loading ? 'linear-gradient(135deg,#1e3a5f,#0f2340)' : '#94a3b8' }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
              </svg>
            </button>
          </div>
          <p className="text-[10px] opacity-25 mt-1.5 text-center">
            Enter envia · Shift+Enter nova linha · Ctrl+V cola imagem · Contexto F01–F05 ao vivo
          </p>
        </div>
      </div>
    </div>
  );
}

/* Colunas visíveis na tabela principal — na ordem de exibição */
const TABLE_COLS = [
  'UC', 'cliente', 'Concessionaria', 'Mes_Ref', 'Tp_Tensao',
  'RS_Total_Fatura', 'valor_ressarcimento_estimado', 'fichas_aplicadas', 'qtd_regras', 'peso_alerta_max',
  'segmentos', 'desvio_pct_max', 'dif_pct_alerta_f02', 'status_alerta_f02', 'Link',
];

const COL_LABELS = {
  UC: 'UC', cliente: 'Cliente', Concessionaria: 'Distribuidora',
  Mes_Ref: 'Mês Ref', Tp_Tensao: 'Tensão', RS_Total_Fatura: 'Valor Fatura',
  valor_ressarcimento_estimado: 'Valor Ressarc.',
  fichas_aplicadas: 'Fichas', qtd_regras: 'Qtd', peso_alerta_max: 'Peso',
  segmentos: 'Seg.', desvio_pct_max: 'Desvio %', dif_pct_alerta_f02: 'Desvio Seg.',
  status_alerta_f02: 'Status F02', Link: 'Link',
};

function DesvioBar({ value }) {
  const pct = parseFloat(value);
  if (isNaN(pct) || pct === 0) return <span className="text-gray-400">-</span>;
  const abs = Math.min(Math.abs(pct), 500);
  const color = pct >= 200 ? '#ef4444' : pct >= 100 ? '#f97316' : pct >= 50 ? '#eab308' : '#22c55e';
  return (
    <div className="flex items-center gap-1.5 min-w-[90px]">
      <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div style={{ width: `${(abs / 500) * 100}%`, backgroundColor: color }} className="h-full rounded-full" />
      </div>
      <span style={{ color }} className="font-mono font-semibold text-xs whitespace-nowrap">
        {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
      </span>
    </div>
  );
}

function PesoBadge({ value }) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n === 0) return <span className="text-gray-400">-</span>;
  const colors = ['', '#22c55e', '#eab308', '#f97316', '#ef4444', '#dc2626'];
  const labels = ['', '1 Baixo', '2 Médio', '3 Alto', '4 Crítico', '5 Urgente'];
  const color = colors[n] ?? '#94a3b8';
  return (
    <span style={{ backgroundColor: color + '22', color, border: `1px solid ${color}55` }}
      className="px-1.5 py-0.5 rounded text-xs font-semibold whitespace-nowrap">
      {labels[n] ?? n}
    </span>
  );
}

function FichasBadge({ value }) {
  if (!value) return <span className="text-gray-400">-</span>;
  const fichas = String(value).split(/[\s|,]+/).filter(Boolean);
  const colors = { F01: '#1a56db', F02: '#0e9f6e', F03: '#c27803', F04: '#9061f9', F05: '#e02424' };
  return (
    <div className="flex flex-wrap gap-0.5">
      {fichas.map(f => (
        <span key={f}
          style={{ backgroundColor: (colors[f] ?? '#6b7280') + '33', color: colors[f] ?? '#94a3b8', border: `1px solid ${(colors[f] ?? '#6b7280')}55` }}
          className="px-1 py-0 rounded text-xs font-bold">
          {f}
        </span>
      ))}
    </div>
  );
}

/* Fichas cadastradas */
const FICHAS = [
  { id: 'f01',       label: 'F01',       nome: 'Divergência de Fórmula', endpoint: '/api/v1/faturas/ficha/01',        cor: '#1a56db' },
  { id: 'f02',       label: 'F02',       nome: 'Desvio de Média',        endpoint: '/api/v1/faturas/ficha/02',        cor: '#0e9f6e' },
  { id: 'f03',       label: 'F03',       nome: 'Acúmulo de Consumo',     endpoint: '/api/v1/faturas/ficha/03',        cor: '#c27803' },
  { id: 'f04',       label: 'F04',       nome: 'Troca de Medidor',       endpoint: '/api/v1/faturas/ficha/04',        cor: '#9061f9' },
  { id: 'f05',       label: 'F05',       nome: 'Quebra de Leitura',      endpoint: '/api/v1/faturas/ficha/05',        cor: '#e02424' },
];

/* Helpers */
const fmt = (v) => (v == null || v === '' ? '-' : String(v));

function formatCurrencyBRL(v) {
  const num = Number(v);
  if (v == null || v === '' || Number.isNaN(num)) return '-';
  return `R$ ${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function cellVal(v, col = '') {
  if (v == null || v === '') return '-';
  if (col === 'valor_ressarcimento_estimado') return formatCurrencyBRL(v);
  return String(v);
}

/* Resumo */
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

/* Renderiza resultado da análise AISURE */
function AnaliseResultado({ analise, confirmado, calcFinanceiro }) {
  const [showCalc, setShowCalc] = useState(false);
  if (!analise) return null;

  const lines = analise.split('\n');
  const prioColor = { CRITICO: '#ef4444', ALTO: '#f97316', MEDIO: '#eab308', BAIXO: '#22c55e' };
  const calcLines = calcFinanceiro ? calcFinanceiro.split('\n') : [];

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
          let color = '#1e293b';
          let weight = 'normal';
          let bg = 'transparent';
          const isBoldLine = line.startsWith('**') && line.endsWith('**');
          const displayLine = isBoldLine ? line.slice(2, -2) : line;

          if (/^F0[1-5]\s*[—:-]/.test(line)) {
            if (line.includes('Confirmado') && !line.includes('Não confirmado')) color = '#4ade80';
            else if (line.includes('Não confirmado')) color = '#f87171';
            weight = '600';
          } else if (upper.startsWith('PRIORIDADE:')) {
            const normalizedUpper = upper.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            const prio = Object.keys(prioColor).find(p => normalizedUpper.includes(p));
            color = prio ? prioColor[prio] : '#facc15';
            weight = '700';
          } else if (upper.startsWith('TOTAL DE FICHAS') || upper.startsWith('FICHAS CONFIRMADAS')) {
            color = '#1d4ed8';
            weight = '600';
          } else if (upper.startsWith('UC:') || upper.startsWith('MÊS') || upper.startsWith('CONCESS')) {
            color = '#0f172a';
            weight = '600';
          } else if (upper.startsWith('FICHAS DETECTADAS')) {
            color = '#92400e';
            weight = '700';
          } else if (isBoldLine && upper.includes('DOBRO')) {
            color = '#fbbf24';
            weight = '700';
            bg = 'rgba(251,191,36,0.08)';
          } else if (isBoldLine) {
            weight = '700';
          }
          return (
            <div key={i} style={{ color, fontWeight: weight, lineHeight: '1.5', background: bg, borderRadius: bg !== 'transparent' ? '3px' : undefined, padding: bg !== 'transparent' ? '1px 4px' : undefined }}>
              {displayLine || '\u00a0'}
            </div>
          );
        })}
      </div>

      {/* Seção de cálculo financeiro - colapsável */}
      {calcFinanceiro && (
        <div className="border-t border-[var(--border)]">
          <button
            onClick={() => setShowCalc(v => !v)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold hover:bg-[var(--panel)] transition-colors"
            style={{ color: '#60a5fa' }}
          >
            <span>Cálculo Financeiro Estimado</span>
            <span style={{ fontSize: '10px' }}>{showCalc ? '▲' : '▼'}</span>
          </button>
          {showCalc && (
            <div className="px-3 py-2 space-y-0.5 overflow-auto max-h-80 bg-[var(--panel)]">
              {calcLines.map((line, i) => {
                const lower = line.toLowerCase();
                let color = '#1e293b';
                let weight = 'normal';
                if (lower.includes('valor_total_estimado_recuperavel_max')) {
                  color = '#1d4ed8'; weight = '700';
                } else if (lower.includes('valor_total_estimado_recuperavel_min')) {
                  color = '#15803d'; weight = '700';
                } else if (lower.includes('valor_cobrado_a_maior') || lower.includes('valor_potencial_devolucao_em_dobro')) {
                  color = '#c2410c'; weight = '600';
                } else if (lower.includes('calculo_financeiro') || lower.includes('10.')) {
                  color = '#92400e'; weight = '700';
                } else if (lower.includes('nivel_de_confianca') || lower.includes('11.')) {
                  color = '#6d28d9'; weight = '600';
                } else if (lower.includes('classificacao_final') || lower.includes('conclusao_final') || lower.includes('proxima_acao') || lower.includes('12.') || lower.includes('13.') || lower.includes('14.')) {
                  color = '#1e293b'; weight = '600';
                }
                return (
                  <div key={i} style={{ color, fontWeight: weight, lineHeight: '1.5' }}>
                    {line || '\u00a0'}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* Modal de análise IA por linha */
function ConfirmIAModal({ modal, onClose, onResult, onCriar, onSavedResult }) {
  const [faturaData, setFaturaData] = useState(null); // { name, text }
  const [converting, setConverting] = useState(false);
  const [analyzing, setAnalyzing]   = useState(false);
  const [result, setResult]         = useState(modal.initialResult ?? null);
  const [autoLoadError, setAutoLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [estimatedValue, setEstimatedValue] = useState(() => {
    const raw = modal?.row?.valor_ressarcimento_estimado;
    return raw == null || raw === '' ? '' : String(raw).replace('.', ',');
  });
  const fileRef = useRef(null);
  const autoStartedRef = useRef(false);

  useEffect(() => {
    if (!result) return;
    if (estimatedValue) return;
    const extracted = extractValorEstimado(result.calcFinanceiro || result.analise || '');
    if (extracted) {
      setEstimatedValue(String(extracted).replace('.', ','));
    }
  }, [result, estimatedValue]);

  const handleFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setConverting(true);
    setAutoLoadError('');
    try {
      setFaturaData(await extractFaturaText(file));
    } catch {
      setFaturaData(null);
      alert('Não foi possível processar o arquivo. Tente outro formato.');
    } finally {
      setConverting(false);
    }
  }, []);

  const handleAnalyze = useCallback(async () => {
    setAnalyzing(true);
    setResult(null);
    try {
      const r = await runAisureConfirmWithRetry({
        uc: modal.uc,
        fichas: modal.fichas,
        detalhe: modal.detalhe,
        row: modal.row,
        faturaData,
      });
      setResult(r);
      onResult?.(modal.rowIdx, r);
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || 'Erro ao conectar com o AISURE.';
      setResult({ erro: true, analise: msg });
    } finally {
      setAnalyzing(false);
    }
  }, [modal, faturaData, onResult]);

  const loadFaturaFromLink = useCallback(async () => {
    const link = getRowFaturaLink(modal.row);
    if (!link) return false;

    setConverting(true);
    setAutoLoadError('');
    try {
      setFaturaData(await loadFaturaDataFromLink(link));
      return true;
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || 'Falha ao baixar a fatura pelo link.';
      setAutoLoadError(String(msg));
      setFaturaData(null);
      return false;
    } finally {
      setConverting(false);
    }
  }, [modal.row]);

  useEffect(() => {
    if (autoStartedRef.current) return;
    if (modal.initialResult) return;
    autoStartedRef.current = true;
    loadFaturaFromLink();
  }, [loadFaturaFromLink, modal.initialResult]);

  useEffect(() => {
    if (modal.initialResult) return;
    if (result || analyzing || converting) return;
    if (!faturaData?.text) return;
    handleAnalyze();
  }, [modal.initialResult, result, analyzing, converting, faturaData, handleAnalyze]);

  const handleSaveResult = useCallback(async () => {
    const rowId = Number(modal?.row?.id || 0);
    if (!rowId || !result?.analise) return;

    setSaving(true);
    setSaveError('');
    try {
      const normalizedValue = String(estimatedValue || '').trim();
      const parsedValue = normalizedValue === ''
        ? null
        : Number(normalizedValue.replace(/\./g, '').replace(',', '.'));

      const payload = {
        id: rowId,
        resultado_ia: result.analise,
      };
      if (parsedValue != null && !Number.isNaN(parsedValue)) {
        payload.valor_ressarcimento_estimado = parsedValue;
      }

      const res = await apiClient.post('/api/v1/faturas/analise-resultado/salvar', payload);
      const savedValue = res.data?.valor_ressarcimento_estimado;
      const savedAt = res.data?.resultado_salvo_em || new Date().toISOString();

      onSavedResult?.(modal.rowIdx, {
        resultado_ia: result.analise,
        valor_ressarcimento_estimado: savedValue ?? null,
        resultado_salvo_em: savedAt,
      });
      onClose();
    } catch (e) {
      setSaveError(e?.response?.data?.error || 'Erro ao guardar resultado.');
    } finally {
      setSaving(false);
    }
  }, [estimatedValue, modal?.row?.id, modal.rowIdx, onClose, onSavedResult, result]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-4xl bg-[var(--bg)] rounded-xl shadow-2xl flex flex-col border border-[var(--border)]"
        style={{ maxHeight: '92vh' }}
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
              Análise de Anomalia - AISURE
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
            <div className="space-y-3">
              <AnaliseResultado analise={result.analise} confirmado={result.confirmado} calcFinanceiro={result.calcFinanceiro} />
              <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-3">
                <label className="block text-xs opacity-60 mb-1">Valor de Ressarcimento Estimado (editável)</label>
                <input
                  value={estimatedValue}
                  onChange={(e) => setEstimatedValue(e.target.value)}
                  placeholder="0,00"
                  className="w-full px-3 py-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)] focus:outline-none focus:ring-1 focus:ring-[#1e3a5f]"
                />
                {saveError && (
                  <div className="text-xs text-red-400 mt-2">{saveError}</div>
                )}
              </div>
            </div>
          )}

          {/* Upload da fatura - oculto se já há resultado */}
          {!result && !analyzing && (
            <div>
              <p className="text-xs opacity-60 mb-2">
                Ao abrir, o sistema tenta baixar automaticamente a fatura e extrair o texto — o mesmo processo do anexo manual.
                Se falhar, você pode anexar a fatura manualmente abaixo.
              </p>

              {autoLoadError && (
                <div className="mb-2 text-xs text-red-400 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
                  {autoLoadError}
                </div>
              )}

              {converting ? (
                <div className="flex items-center gap-2 text-xs opacity-60 py-3 justify-center border border-dashed border-[var(--border)] rounded-lg">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                  Baixando fatura e extraindo texto...
                </div>
              ) : faturaData ? (
                <div className="rounded-lg border border-green-500/40 bg-[var(--panel)] flex items-center justify-between px-3 py-2.5 text-xs">
                  <span className="flex items-center gap-2 text-green-400 font-medium min-w-0">
                    <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                    </svg>
                    <span className="truncate">{faturaData.name}</span>
                    <svg className="w-3.5 h-3.5 flex-shrink-0 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
                    </svg>
                  </span>
                  <button onClick={() => setFaturaData(null)} className="ml-2 flex-shrink-0 opacity-50 hover:opacity-100 text-red-400">
                    remover
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-[var(--border)] text-xs hover:bg-[var(--panel)] transition-colors w-full justify-center"
                >
                  <svg className="w-3.5 h-3.5 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                  </svg>
                  Anexar fatura (PDF, PNG, JPG, WEBP)
                </button>
              )}
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
                onClick={onClose}
                className="px-3 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--panel)]"
              >
                Descartar resultado
              </button>
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
                onClick={handleSaveResult}
                disabled={saving}
                className="px-4 py-2 text-sm rounded-lg text-white font-semibold flex items-center gap-2 disabled:opacity-50"
                style={{ backgroundColor: '#1e3a5f' }}
              >
                {saving ? 'Guardando...' : 'Guardar resultado'}
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
              disabled={analyzing || converting}
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

function BulkConfirmModal({ jobs, onClose, onItemResult, onFinished }) {
  const [items, setItems] = useState(() => jobs.map(job => ({
    ...job,
    status: 'pending',
    message: 'Aguardando na fila',
    result: null,
  })));
  const [running, setRunning] = useState(true);
  const [cancelRequested, setCancelRequested] = useState(false);

  const buildSummary = useCallback((currentItems) => ({
    finishedAt: new Date().toISOString(),
    total: currentItems.length,
    processed: currentItems.filter(item => item.status === 'done' || item.status === 'error' || item.status === 'cancelled').length,
    confirmed: currentItems.filter(item => item.status === 'done' && item.result?.confirmado).length,
    notConfirmed: currentItems.filter(item => item.status === 'done' && item.result && !item.result?.confirmado).length,
    errors: currentItems.filter(item => item.status === 'error').length,
    cancelled: currentItems.filter(item => item.status === 'cancelled').length,
  }), []);

  const reprocessItem = useCallback(async (item) => {
    setItems(prev => prev.map(current => current.key === item.key ? {
      ...current,
      status: 'loading',
      message: 'Reprocessando...',
      result: null,
    } : current));
    onItemResult?.(item.rowIdx, { loading: true });

    try {
      const link = getRowFaturaLink(item.row);
      const faturaData = link ? await loadFaturaDataFromLink(link) : null;
      if (faturaData?.name) {
        setItems(prev => prev.map(current => current.key === item.key ? { ...current, message: 'Analisando...', fileName: faturaData.name } : current));
      }
      const result = await runAisureConfirmWithRetry({
        uc: item.uc,
        fichas: item.fichas,
        detalhe: item.detalhe,
        row: item.row,
        faturaData,
      });
      setItems(prev => prev.map(current => current.key === item.key ? {
        ...current,
        status: 'done',
        message: result.confirmado ? 'Anomalia confirmada' : 'Anomalia não confirmada',
        fileName: faturaData?.name || current.fileName,
        result,
      } : current));
      onItemResult?.(item.rowIdx, result);
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || 'Erro ao conectar com o AISURE.';
      const result = { erro: true, analise: msg };
      setItems(prev => prev.map(current => current.key === item.key ? {
        ...current,
        status: 'error',
        message: msg,
        result,
      } : current));
      onItemResult?.(item.rowIdx, result);
    }
  }, [onItemResult]);

  const reprocessFailed = useCallback(async () => {
    const failedItems = items.filter(item => item.status === 'error');
    for (const item of failedItems) {
      await reprocessItem(item);
    }
  }, [items, reprocessItem]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      let currentItems = jobs.map(job => ({
        ...job,
        status: 'pending',
        message: 'Aguardando',
        result: null,
      }));

      for (let idx = 0; idx < jobs.length; idx++) {
        const job = jobs[idx];
        if (cancelled) break;
        if (cancelRequested) {
          currentItems = currentItems.map((item, i) => (
            i >= idx && item.status === 'pending'
              ? { ...item, status: 'cancelled', message: 'Cancelado antes do processamento' }
              : item
          ));
          setItems(currentItems);
          break;
        }

        currentItems = currentItems.map((item, i) => i === idx ? { ...item, status: 'loading', message: `Baixando fatura... (${idx + 1}/${jobs.length})` } : item);
        setItems(currentItems);
        onItemResult?.(job.rowIdx, { loading: true });

        try {
          const link = getRowFaturaLink(job.row);
          const faturaData = link ? await loadFaturaDataFromLink(link) : null;
          if (faturaData?.name) {
            currentItems = currentItems.map((item, i) => i === idx ? { ...item, message: `Analisando... (${idx + 1}/${jobs.length})`, fileName: faturaData.name } : item);
            setItems(currentItems);
          }
          const result = await runAisureConfirmWithRetry({
            uc: job.uc,
            fichas: job.fichas,
            detalhe: job.detalhe,
            row: job.row,
            faturaData,
          });
          if (cancelled) break;
          currentItems = currentItems.map((item, i) => i === idx ? {
            ...item,
            status: 'done',
            message: result.confirmado ? 'Anomalia confirmada' : 'Anomalia não confirmada',
            fileName: faturaData?.name || item.fileName,
            result,
          } : item);
          setItems(currentItems);
          onItemResult?.(job.rowIdx, result);
        } catch (e) {
          const msg = e?.response?.data?.error || e?.message || 'Erro ao conectar com o AISURE.';
          if (cancelled) break;
          const result = { erro: true, analise: msg };
          currentItems = currentItems.map((item, i) => i === idx ? {
            ...item,
            status: 'error',
            message: msg,
            result,
          } : item);
          setItems(currentItems);
          onItemResult?.(job.rowIdx, result);
        }
      }

      if (!cancelled) {
        setRunning(false);
        onFinished?.(buildSummary(currentItems));
      }
    }

    run();
    return () => { cancelled = true; };
  }, [jobs, onItemResult, cancelRequested, onFinished, buildSummary]);

  const completed = items.filter(item => item.status === 'done' || item.status === 'error' || item.status === 'cancelled').length;
  const summary = buildSummary(items);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={!running ? onClose : undefined}>
      <div
        className="w-full max-w-3xl bg-[var(--bg)] rounded-xl shadow-2xl flex flex-col border border-[var(--border)]"
        style={{ maxHeight: '88vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-3 rounded-t-xl flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, #1e3a5f, #0f2340)' }}
        >
          <div>
            <div className="text-white font-bold text-sm">Análise em lote - AISURE</div>
            <div className="text-white/60 text-xs">{completed}/{items.length} processados</div>
          </div>
          <button onClick={onClose} disabled={running} className="text-white/50 hover:text-white disabled:opacity-30">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 border-b border-[var(--border)] text-xs opacity-70">
          O processamento ocorre em fila, uma linha por vez. Para ver o resultado completo da análise, clique no símbolo da própria linha na tabela depois que o processamento terminar.
        </div>

        <div className="px-5 py-3 border-b border-[var(--border)] text-xs flex gap-4 text-slate-300">
          <span>Confirmadas: {summary.confirmed}</span>
          <span>Não confirmadas: {summary.notConfirmed}</span>
          <span>Erros: {summary.errors}</span>
          <span>Canceladas: {summary.cancelled}</span>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-2">
          {items.map(item => (
            <div key={item.key} className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-xs">
              <div className="flex items-start gap-3">
                <div className="mt-0.5">
                  {item.status === 'loading' ? (
                    <svg className="animate-spin w-4 h-4 text-yellow-400" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                    </svg>
                  ) : item.status === 'done' ? (
                    <span className={item.result?.confirmado ? 'text-green-400' : 'text-yellow-400'}>{item.result?.confirmado ? '✓' : '•'}</span>
                  ) : item.status === 'cancelled' ? (
                    <span className="text-slate-400">∅</span>
                  ) : item.status === 'error' ? (
                    <span className="text-red-400">✕</span>
                  ) : (
                    <span className="text-slate-400">•</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-[var(--fg)]">
                    UC {item.uc || '-'} <span className="opacity-50 ml-2">{item.fichas || '-'}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="opacity-70">{item.message}</span>
                    {item.fileName && (
                      <span className="flex items-center gap-1 text-green-400/80">
                        <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                        </svg>
                        {item.fileName}
                      </span>
                    )}
                    {!running && item.status === 'error' && (
                      <button
                        onClick={() => reprocessItem(item)}
                        className="text-xs px-2 py-0.5 rounded border border-yellow-500/40 text-yellow-300 hover:bg-yellow-500/10"
                      >
                        Reprocessar
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--border)] flex-shrink-0">
          <span className="text-xs opacity-60">
            {running ? (cancelRequested ? 'Cancelando fila...' : 'Processando seleção...') : 'Processamento concluído.'}
          </span>
          <div className="flex items-center gap-2">
            {!running && summary.errors > 0 && (
              <button
                onClick={reprocessFailed}
                className="px-4 py-2 text-sm rounded-lg border border-yellow-500/40 text-yellow-300 hover:bg-yellow-500/10"
              >
                Reprocessar falhas
              </button>
            )}
            {running && (
              <button
                onClick={() => setCancelRequested(true)}
                disabled={cancelRequested}
                className="px-4 py-2 text-sm rounded-lg border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-40"
              >
                Cancelar fila
              </button>
            )}
            <button
              onClick={onClose}
              disabled={running}
              className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--panel)] disabled:opacity-40"
            >
              Fechar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Dados estáticos tipo/subtipo irregularidade */
const TIPOS_IRREG = [
  { id: 1, nome: 'CADASTRO' }, { id: 2, nome: 'COMPENSAÇÃO' }, { id: 3, nome: 'CONSUMO' },
  { id: 4, nome: 'DÚVIDA' }, { id: 5, nome: 'FATURAMENTO' }, { id: 6, nome: 'IMPOSTOENCARGO' },
  { id: 7, nome: 'LEITURA' }, { id: 8, nome: 'PID' }, { id: 9, nome: 'PLEITO GERAL' },
  { id: 10, nome: 'QUALIDADE' }, { id: 11, nome: 'SCEE' }, { id: 12, nome: 'SERVIÇO' }, { id: 13, nome: 'TOI' },
];
const SUBTIPOS_IRREG = [
  { id: 35, idTipo: 1, nome: 'Troca de titularidade' }, { id: 36, idTipo: 1, nome: 'Troca média mensal para média horária' },
  { id: 4,  idTipo: 2, nome: 'Compensação' },
  { id: 1,  idTipo: 3, nome: 'Alteração' }, { id: 5, idTipo: 3, nome: 'Elevado' }, { id: 6, idTipo: 3, nome: 'Reduzido' },
  { id: 10, idTipo: 4, nome: 'Dúvida' },
  { id: 13, idTipo: 5, nome: 'Acima da média' }, { id: 3, idTipo: 5, nome: 'Cobrança de 2,5%' },
  { id: 7,  idTipo: 5, nome: 'Custo mínimo' }, { id: 8, idTipo: 5, nome: 'Demanda' },
  { id: 9,  idTipo: 5, nome: 'DMCR' }, { id: 12, idTipo: 5, nome: 'Faturado por média' },
  { id: 22, idTipo: 5, nome: 'Multas e juros' }, { id: 14, idTipo: 5, nome: 'Tarifa indevida' },
  { id: 16, idTipo: 5, nome: 'Unidade fechada' },
  { id: 15, idTipo: 6, nome: 'CDE indevido' }, { id: 2, idTipo: 6, nome: 'CIP' },
  { id: 17, idTipo: 6, nome: 'ICMS' }, { id: 18, idTipo: 6, nome: 'Outros impostos' },
  { id: 11, idTipo: 7, nome: 'Erro de leitura' }, { id: 20, idTipo: 7, nome: 'Medidor queimado' },
  { id: 21, idTipo: 7, nome: 'Memória de massa' }, { id: 25, idTipo: 7, nome: 'Reativo' },
  { id: 26, idTipo: 7, nome: 'Regularização de acesso' }, { id: 29, idTipo: 7, nome: 'Sem leitura' },
  { id: 37, idTipo: 7, nome: 'Violação de lacre' },
  { id: 19, idTipo: 8, nome: 'Pedido de indenização' },
  { id: 23, idTipo: 9, nome: 'Pleito geral' },
  { id: 24, idTipo: 10, nome: 'Qualidade de fornecimento' }, { id: 33, idTipo: 10, nome: 'Reclamação de tensão' },
  { id: 27, idTipo: 11, nome: 'Saldo incorreto' },
  { id: 32, idTipo: 12, nome: 'Agrupamento' }, { id: 28, idTipo: 12, nome: 'Sem fornecimento' },
  { id: 30, idTipo: 12, nome: 'Serviços' }, { id: 31, idTipo: 12, nome: 'Solicitação de fatura' },
  { id: 34, idTipo: 13, nome: 'TOI' },
];

/* Modal de criação de requisição a partir da análise IA */
const MESES_ABREV = ['','Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const MESES_FULL  = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function parseMesRef(mesRef) {
  const parts = String(mesRef || '').split('-');
  return { ano: parts[0] || '', mes: parts[1] ? String(parseInt(parts[1], 10)) : '' };
}

const MESES_PT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

/* Formata "2025-05-01T00:00:00-03:00" → "Mai/2025" */
function formatMesRef(v) {
  const s = String(v || '').trim();
  if (!s) return '-';
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (!m) return s.slice(0, 7);
  const mes = parseInt(m[2], 10);
  return `${MESES_PT[mes - 1] ?? m[2]}/${m[1]}`;
}

function extractPriority(analise) {
  const m = String(analise || '').match(/PRIORIDADE\s*:\s*(CRÍTICO|CRITICO|ALTO|MÉDIO|MEDIO|BAIXO)/i);
  return m ? m[1].toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') : null;
}

/* Extrai seção numerada do calcFinanceiro (ex: campo 4, 5, 6...) */
function extractCalcSection(text, num) {
  if (!text) return '';
  const re = new RegExp(`^${num}\\.\\s*[^:]+:\\s*([\\s\\S]*?)(?=^\\d+\\.|$)`, 'im');
  const m = text.match(re);
  return m ? m[1].trim().substring(0, 800) : '';
}

/* Extrai tipo/subtipo do novo formato (Tipo de Irregularidade: id | nome) */
function extractTipoSubtipoSugerido(text) {
  const result = { tipo: '', subtipo: '' };
  if (!text) return result;
  // Novo formato: "Tipo de Irregularidade: 5 | FATURAMENTO"
  const mTipo = text.match(/Tipo de Irregularidade\s*:\s*(\d+)/i);
  const mSub  = text.match(/Subtipo de Irregularidade\s*:\s*(\d+)/i);
  // Fallback formato antigo
  const mTipoOld = text.match(/15\.\s*tipo_irregularidade_sugerido\s*:\s*(\d+)/i);
  const mSubOld  = text.match(/16\.\s*subtipo_irregularidade_sugerido\s*:\s*(\d+)/i);
  result.tipo    = (mTipo || mTipoOld)?.[1] || '';
  result.subtipo = (mSub  || mSubOld)?.[1]  || '';
  return result;
}

/* Auto-sugestão de tipo/subtipo baseada nas fichas detectadas */
function suggestTipoSubtipo(fichas) {
  const f = String(fichas || '').toUpperCase();
  if (f.includes('F02')) return { tipo: '5', subtipo: '13' }; // FATURAMENTO / Acima da média
  if (f.includes('F03')) return { tipo: '5', subtipo: '12' }; // FATURAMENTO / Faturado por média
  if (f.includes('F01') || f.includes('F04') || f.includes('F05')) return { tipo: '7', subtipo: '11' }; // LEITURA / Erro de leitura
  return { tipo: '', subtipo: '' };
}

function extractValorEstimado(text) {
  if (!text) return '';
  const patterns = [
    // Novo formato
    /Valor Estimado Simples\s*:\s*R?\$?\s*([\d.]+(?:,\d+)?)/i,
    // Formato antigo (fallback)
    /valor_total_estimado_recuperavel_min\s*:\s*R?\$?\s*([\d.]+(?:,\d+)?)/i,
    /valor_total_estimado_recuperavel_max\s*:\s*R?\$?\s*([\d.]+(?:,\d+)?)/i,
    /valor_cobrado_a_maior_estimado\s*:\s*R?\$?\s*([\d.]+(?:,\d+)?)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].replace(/\./g, '').replace(',', '.');
  }
  return '';
}

function buildSavedResultFromRow(row) {
  const analise = String(row?.resultado_ia || '').trim();
  if (!analise) return null;
  const confirmedCount = Number((analise.match(/Fichas Confirmadas\s*:\s*(\d+)/i) || [])[1] || 0);
  return {
    analise,
    confirmado: confirmedCount > 0,
    calcFinanceiro: null,
  };
}

/* Tela de sucesso */
function SuccessPane({ modal, periods, onClose }) {
  const periodoStr = periods
    .filter(p => p.mes && p.ano)
    .map(p => `${MESES_ABREV[Number(p.mes)] || p.mes}/${p.ano}`)
    .join(', ');

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Confirmação */}
      <div className="flex flex-col items-center gap-4 p-8 text-center">
        <div className="w-14 h-14 rounded-full bg-green-500/20 flex items-center justify-center">
          <svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
          </svg>
        </div>
        <div>
          <div className="text-lg font-bold">Requisição criada!</div>
          <div className="text-xs opacity-50 mt-1">UC {modal.uc}{periodoStr ? ' · ' + periodoStr : ''}</div>
          <div className="text-xs opacity-40 mt-2">Acesse a planilha para acompanhar o processo.</div>
        </div>
        <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--panel)] mt-2">
          Fechar
        </button>
      </div>
    </div>
  );
}

function CriarRequisicaoModal({ modal, result, onClose, onSuccess }) {
  const row = modal.row ?? {};
  // Fonte de texto: novo formato usa analise; fallback para calcFinanceiro (formato antigo)
  const analiseText = result?.analise || '';
  const cf          = result?.calcFinanceiro || '';
  const textSource  = analiseText || cf;

  // Determina tipo/subtipo inicial: IA (analise) > fichas > vazio
  const aiSuggestion     = extractTipoSubtipoSugerido(textSource);
  const fichasSuggestion = suggestTipoSubtipo(modal.fichas);
  const initTipo    = aiSuggestion.tipo    || fichasSuggestion.tipo    || '';
  const initSubtipo = aiSuggestion.subtipo || fichasSuggestion.subtipo || '';

  // Descrição pré-preenchida: novo formato usa a analise completa; formato antigo usa seções numeradas
  function buildDescricao() {
    // Formato antigo com seções numeradas
    const resumo    = extractCalcSection(cf, 4);
    const inconsist = extractCalcSection(cf, 5);
    const hipotese  = extractCalcSection(cf, 6);
    if (resumo || inconsist || hipotese) {
      const parts = [];
      if (resumo)    parts.push('RESUMO EXECUTIVO:\n' + resumo);
      if (inconsist) parts.push('INCONSISTÊNCIAS ENCONTRADAS:\n' + inconsist);
      if (hipotese)  parts.push('HIPÓTESE DE RESSARCIMENTO:\n' + hipotese);
      return parts.join('\n\n');
    }
    // Novo formato: usa a análise completa
    return analiseText || modal.detalhe || '';
  }

  const initPeriodo = parseMesRef(row.Mes_Ref);

  const [fields, setFields] = useState({
    uc:                      modal.uc || '',
    cliente:                 '',
    razaoSocialFatura:       row.cliente || row.RAZAO_SOCIAL || '',
    concessionaria:          row.Concessionaria || '',
    cnpj:                    '',
    linkFatura:              row.Link || '',
    ressarcimentoEstimado:   extractValorEstimado(textSource) || String(row.RS_Total_Fatura || '').replace(/[^\d,.]/g, '') || '',
    descricaoIrregularidade: buildDescricao(),
    problemaIdentificado:    modal.fichas || '',
  });
  const [idTipo,    setIdTipo]    = useState(initTipo);
  const [idSubtipo, setIdSubtipo] = useState(initSubtipo);
  const [periods,   setPeriods]   = useState([
    { mes: String(initPeriodo.mes || ''), ano: String(initPeriodo.ano || '') }
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]   = useState('');
  const [createdId, setCreatedId] = useState(null);

  // Busca nome da empresa pelo Cod_Empresa
  useEffect(() => {
    const cod = row.Cod_Empresa;
    if (!cod) return;
    apiClient.get('/api/v1/filtros/empresas')
      .then(res => {
        const lista = res.data ?? [];
        const found = lista.find(e => String(e.cod_empresa) === String(cod));
        if (found?.rz_social) {
          setFields(prev => ({ ...prev, cliente: found.rz_social }));
        }
      })
      .catch(() => {});
  }, [row.Cod_Empresa]);

  // Quando tipo muda, limpa subtipo se não pertencer ao tipo
  useEffect(() => {
    if (idSubtipo && idTipo) {
      const valid = SUBTIPOS_IRREG.find(s => String(s.id) === String(idSubtipo) && String(s.idTipo) === String(idTipo));
      if (!valid) setIdSubtipo('');
    }
  }, [idTipo]);

  const set = (k) => (e) => setFields(prev => ({ ...prev, [k]: e.target.value }));

  const subtiposFiltrados = idTipo
    ? SUBTIPOS_IRREG.filter(s => String(s.idTipo) === String(idTipo))
    : SUBTIPOS_IRREG;

  // Gerenciamento de períodos
  const addPeriod = () => setPeriods(prev => [...prev, { mes: '', ano: '' }]);
  const removePeriod = (i) => setPeriods(prev => prev.filter((_, idx) => idx !== i));
  const setPeriodField = (i, field, val) =>
    setPeriods(prev => prev.map((p, idx) => idx === i ? { ...p, [field]: val } : p));

  const priority = extractPriority(result?.analise);
  const prioColor = { CRITICO: '#ef4444', ALTO: '#f97316', MEDIO: '#eab308', BAIXO: '#22c55e' };

  const handleSubmit = useCallback(async () => {
    setError('');
    const missing = [];
    if (!fields.uc)                      missing.push('UC');
    if (!fields.cliente)                 missing.push('Cliente');
    if (!fields.concessionaria)          missing.push('Concessionária');
    if (!fields.descricaoIrregularidade) missing.push('Descrição');
    if (!fields.ressarcimentoEstimado)   missing.push('Valor estimado');
    const validPeriods = periods.filter(p => p.mes && p.ano);
    if (validPeriods.length === 0)       missing.push('Período');
    if (!idTipo)                         missing.push('Tipo de irregularidade');
    if (!idSubtipo)                      missing.push('Subtipo de irregularidade');
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
        JSON.stringify(validPeriods.map(p => ({ mes: String(p.mes), ano: String(p.ano) }))));
      if (idTipo)    form.append('idTipoIrregularidade',    String(idTipo));
      if (idSubtipo) form.append('idSubtipoIrregularidade', String(idSubtipo));

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
  }, [fields, periods, idTipo, idSubtipo, onSuccess]);

  const inputCls  = 'w-full px-3 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)] focus:outline-none focus:ring-1 focus:ring-blue-500';
  const selectCls = inputCls + ' cursor-pointer';
  const labelCls  = 'block text-xs opacity-60 mb-0.5';

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="w-full max-w-4xl bg-[var(--bg)] rounded-xl shadow-2xl flex flex-col border border-[var(--border)]"
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
          <SuccessPane
            modal={modal}
            periods={periods}
            onClose={onClose}
          />
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

              {/* Linha 3: CNPJ + Link + Valor */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={labelCls}>CNPJ</label>
                  <input className={inputCls} value={fields.cnpj} onChange={set('cnpj')} placeholder="00.000.000/0000-00"/>
                </div>
                <div>
                  <label className={labelCls}>Link da Fatura</label>
                  <input className={inputCls} value={fields.linkFatura} onChange={set('linkFatura')} placeholder="https://..."/>
                </div>
                <div>
                  <label className={labelCls}>Ressarcimento Estimado (R$) *</label>
                  <input className={inputCls} value={fields.ressarcimentoEstimado} onChange={set('ressarcimentoEstimado')} placeholder="0,00"/>
                </div>
              </div>

              {/* Linha 4: Tipo + Subtipo de Irregularidade */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>
                    Tipo de Irregularidade
                    {initTipo && <span className="ml-1 text-green-400/70">(sugerido pela IA)</span>}
                  </label>
                  <select className={selectCls} value={idTipo} onChange={e => setIdTipo(e.target.value)}>
                    <option value="">Selecione o tipo...</option>
                    {TIPOS_IRREG.map(t => (
                      <option key={t.id} value={t.id}>{t.nome}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>
                    Subtipo de Irregularidade
                    {initSubtipo && <span className="ml-1 text-green-400/70">(sugerido pela IA)</span>}
                  </label>
                  <select className={selectCls} value={idSubtipo} onChange={e => setIdSubtipo(e.target.value)} disabled={!idTipo}>
                    <option value="">Selecione o subtipo...</option>
                    {subtiposFiltrados.map(s => (
                      <option key={s.id} value={s.id}>{s.nome}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Linha 5: Períodos da irregularidade */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className={labelCls + ' mb-0'}>Períodos da irregularidade *</label>
                  <button
                    type="button"
                    onClick={addPeriod}
                    className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
                    </svg>
                    Adicionar período
                  </button>
                </div>
                <div className="space-y-2">
                  {periods.map((p, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <div className="flex-1">
                        {i === 0 && <span className="block text-xs opacity-40 mb-0.5">Mês</span>}
                        <select
                          className={inputCls}
                          value={p.mes}
                          onChange={e => setPeriodField(i, 'mes', e.target.value)}
                        >
                          <option value="">Selecione o mês</option>
                          {MESES_FULL.slice(1).map((m, mi) => (
                            <option key={mi+1} value={mi+1}>{m}</option>
                          ))}
                        </select>
                      </div>
                      <div className="w-28">
                        {i === 0 && <span className="block text-xs opacity-40 mb-0.5">Ano</span>}
                        <input
                          className={inputCls}
                          value={p.ano}
                          onChange={e => setPeriodField(i, 'ano', e.target.value)}
                          placeholder="Ex: 2025"
                          maxLength={4}
                        />
                      </div>
                      {periods.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removePeriod(i)}
                          className="text-red-400/70 hover:text-red-400 flex-shrink-0"
                          title="Remover período"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                          </svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Problema identificado */}
              <div>
                <label className={labelCls}>Problema identificado</label>
                <input className={inputCls} value={fields.problemaIdentificado} onChange={set('problemaIdentificado')} placeholder="Ex: F01, F02"/>
              </div>

              {/* Descrição */}
              <div>
                <label className={labelCls}>
                  Descrição da irregularidade *
                  {cf && <span className="opacity-40 ml-1">(pré-preenchida pela IA - edite se necessário)</span>}
                </label>
                <textarea
                  className={inputCls + ' resize-y'}
                  rows={7}
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
              <div className="flex gap-2">
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="px-4 py-2 text-sm rounded-lg text-white font-semibold flex items-center gap-2 disabled:opacity-50"
                  style={{ backgroundColor: '#166534' }}
                >
                  {submitting ? (
                    <><svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg> Criando...</>
                  ) : (
                    <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg> Criar Requisição</>
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* Drawer histórico de faturas da UC */
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

/* Painel de Ficha */
function FichaPanel({ ficha, ucsEmProcesso, refreshUcs }) {
  const PAGE_SIZE = 100;
  const [cols, setCols]       = useState([]);
  const [rows, setRows]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [search, setSearch]   = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({
    uc: '', cliente: '', distribuidora: '',
    fichas: [],           // ['F01','F02',...]
    valorMin: '', valorMax: '',
    desvioMin: '',
    periodoInicio: '', periodoFim: '',
  });
  const [confirmMap, setConfirmMap] = useState({}); // rowIdx -> { loading, confirmado, analise }
  const [selectedRows, setSelectedRows] = useState(new Set());
  const [ucDrawer, setUcDrawer]     = useState(null);
  const [detailRow, setDetailRow]   = useState(null);
  const [processoVinculado, setProcessoVinculado] = useState(null); // { loading, processos[] }

  const openDetailRow = useCallback((row) => {
    setDetailRow(row);
    setProcessoVinculado({ loading: true, processos: [] });
    const uc = String(row?.UC ?? '').trim();
    if (!uc) { setProcessoVinculado({ loading: false, processos: [] }); return; }
    apiClient.get('/api/v1/faturas/ficha/processo-vinculado', { params: { uc } })
      .then(r => setProcessoVinculado({
        loading: false,
        processos: r.data?.processos ?? [],
        fatura_links: r.data?.fatura_links ?? {},
      }))
      .catch(() => setProcessoVinculado({ loading: false, processos: [], fatura_links: {} }));
  }, []);
  const [bulkModal, setBulkModal]   = useState(null);
  const [batchHistory, setBatchHistory] = useState(() => readStoredJson(ANALISE_DESVIO_BATCH_HISTORY_KEY, []));
  const theadRef = useRef(null);

  const ucSet = useMemo(() => new Set((ucsEmProcesso ?? []).map(String)), [ucsEmProcesso]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil((Number(total) || 0) / PAGE_SIZE)), [total]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiClient.get(ficha.endpoint, {
        params: {
          limit: PAGE_SIZE,
          offset: (currentPage - 1) * PAGE_SIZE,
          search: search.trim() || undefined,
          uc: filters.uc.trim() || undefined,
          cliente: filters.cliente.trim() || undefined,
          distribuidora: filters.distribuidora || undefined,
          fichas: filters.fichas.length ? filters.fichas.join(',') : undefined,
          valor_min: filters.valorMin || undefined,
          valor_max: filters.valorMax || undefined,
          desvio_min: filters.desvioMin || undefined,
          periodo_inicio: filters.periodoInicio || undefined,
          periodo_fim: filters.periodoFim || undefined,
        },
      });
      setCols(res.data?.columns ?? []);
      setRows(res.data?.rows ?? []);
      setTotal(res.data?.total ?? 0);
    } catch {
      setError('Erro ao carregar dados da ficha.');
    } finally {
      setLoading(false);
    }
  }, [ficha.endpoint, currentPage, search, filters]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setCurrentPage(1);
  }, [ficha.endpoint]);
  useEffect(() => {
    setCurrentPage(1);
  }, [search, filters]);

  /* Coluna que representa a UC nessa ficha */
  const ucCol = useMemo(() => {
    if (!cols.length) return null;
    return cols.find(c => /^uc$/i.test(c) || /^id_uc$/i.test(c) || /^num_uc$/i.test(c)) ?? null;
  }, [cols]);

  /* Listas para dropdowns de filtros */
  const distribuidorasOpcoes = useMemo(() => {
    const s = new Set(rows.map(r => String(r.Concessionaria ?? '')).filter(Boolean));
    return [...s].sort();
  }, [rows]);

  const activeFiltersCount = useMemo(() => {
    let n = 0;
    if (filters.uc)            n++;
    if (filters.cliente)       n++;
    if (filters.distribuidora) n++;
    if (filters.fichas.length) n++;
    if (filters.valorMin || filters.valorMax) n++;
    if (filters.desvioMin)     n++;
    if (filters.periodoInicio || filters.periodoFim) n++;
    return n;
  }, [filters]);

  const setFilter = useCallback((k, v) => setFilters(prev => ({ ...prev, [k]: v })), []);
  const toggleFicha = useCallback((f) => setFilters(prev => ({
    ...prev,
    fichas: prev.fichas.includes(f) ? prev.fichas.filter(x => x !== f) : [...prev.fichas, f],
  })), []);
  const clearFilters = useCallback(() => setFilters({
    uc: '', cliente: '', distribuidora: '', fichas: [],
    valorMin: '', valorMax: '', desvioMin: '',
    periodoInicio: '', periodoFim: '',
  }), []);

  const visiblePageNumbers = useMemo(() => {
    const radius = 3;
    const start = Math.max(1, currentPage - radius);
    const end = Math.min(totalPages, currentPage + radius);
    const pages = [];
    for (let p = start; p <= end; p++) pages.push(p);
    return pages;
  }, [currentPage, totalPages]);

  const filtered = rows;

  const [discardedSet, setDiscardedSet] = useState(new Set()); // Set<"UC_MesRef_Empresa">

  const rowKey = useCallback((row) =>
    `${row[ucCol] ?? ''}_${row['Mes_Ref'] ?? ''}_${row['Cod_Empresa'] ?? ''}`,
  [ucCol]);

  const toggleDiscard = useCallback((row) => {
    const key = rowKey(row);
    setDiscardedSet(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [rowKey]);

  const toggleSelected = useCallback((row) => {
    const key = rowKey(row);
    setSelectedRows(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [rowKey]);

  /* Separa em 3 grupos: ativos -> em processo -> descartados */
  const { normais, emProcesso, descartados } = useMemo(() => {
    const ep = [], n = [], d = [];
    for (const r of filtered) {
      if (discardedSet.has(rowKey(r))) { d.push(r); continue; }
      const v = ucCol ? r[ucCol] : null;
      if (v != null && ucSet.has(String(v))) ep.push(r);
      else n.push(r);
    }
    return { normais: n, emProcesso: ep, descartados: d };
  }, [filtered, ucCol, ucSet, discardedSet, rowKey]);

  const emProcessoStart  = normais.length;
  const descartadosStart = normais.length + emProcesso.length;
  const allRows = useMemo(() => [...normais, ...emProcesso, ...descartados], [normais, emProcesso, descartados]);
  const selectableRows = useMemo(() => allRows.slice(0, descartadosStart), [allRows, descartadosStart]);
  const selectedCount = useMemo(
    () => selectableRows.reduce((acc, row) => acc + (selectedRows.has(rowKey(row)) ? 1 : 0), 0),
    [selectableRows, selectedRows, rowKey],
  );
  const allSelectableSelected = selectableRows.length > 0 && selectedCount === selectableRows.length;

  const toggleSelectAll = useCallback(() => {
    setSelectedRows(prev => {
      const next = new Set(prev);
      if (allSelectableSelected) {
        selectableRows.forEach(row => next.delete(rowKey(row)));
      } else {
        selectableRows.forEach(row => next.add(rowKey(row)));
      }
      return next;
    });
  }, [allSelectableSelected, selectableRows, rowKey]);

  const [confirmModal, setConfirmModal] = useState(null); // { rowIdx, row, uc, fichas, detalhe }
  const [criarReqData, setCriarReqData] = useState(null); // { modal, result }

  useEffect(() => {
    const stored = readStoredJson(ANALISE_DESVIO_RESULTS_KEY, {});
    const nextMap = {};
    allRows.forEach((row, rowIdx) => {
      const storedItem = stored[rowKey(row)];
      if (storedItem) nextMap[rowIdx] = storedItem;
    });
    setConfirmMap(prev => {
      const prevNonLoading = Object.fromEntries(
        Object.entries(prev).filter(([, value]) => !value?.loading)
      );
      return { ...nextMap, ...prevNonLoading };
    });
  }, [allRows, rowKey]);

  useEffect(() => {
    const stored = readStoredJson(ANALISE_DESVIO_RESULTS_KEY, {});
    const next = { ...stored };
    allRows.forEach((row, rowIdx) => {
      const value = confirmMap[rowIdx];
      if (value && !value.loading) next[rowKey(row)] = value;
    });
    writeStoredJson(ANALISE_DESVIO_RESULTS_KEY, next);
  }, [confirmMap, allRows, rowKey]);

  const openConfirmModal = useCallback((rowIdx, row, initialResult = null) => {
    const uc      = ucCol ? String(row[ucCol] ?? '') : '';
    const fichas  = String(row['fichas_aplicadas'] ?? '');
    const detalhe = String(row['detalhamento'] ?? '');
    setConfirmModal({
      rowIdx,
      row,
      uc,
      fichas,
      detalhe,
      initialResult: initialResult || buildSavedResultFromRow(row),
    });
  }, [ucCol]);

  const handleConfirmResult = useCallback((rowIdx, result) => {
    setConfirmMap(prev => ({ ...prev, [rowIdx]: result }));
  }, []);

  const handleSavedResult = useCallback((rowIdx, saved) => {
    const row = allRows[rowIdx];
    if (!row) return;

    setRows(prev => prev.map(item => {
      if (String(item.id ?? '') !== String(row.id ?? '')) return item;
      return {
        ...item,
        resultado_ia: saved.resultado_ia ?? item.resultado_ia,
        valor_ressarcimento_estimado: saved.valor_ressarcimento_estimado ?? item.valor_ressarcimento_estimado,
        resultado_salvo_em: saved.resultado_salvo_em ?? item.resultado_salvo_em,
      };
    }));

    const hydrated = {
      ...(confirmMap[rowIdx] || buildSavedResultFromRow(row) || {}),
      analise: saved.resultado_ia ?? confirmMap[rowIdx]?.analise ?? row.resultado_ia ?? '',
      confirmado: (confirmMap[rowIdx]?.confirmado ?? buildSavedResultFromRow({ resultado_ia: saved.resultado_ia })?.confirmado ?? false),
      calcFinanceiro: confirmMap[rowIdx]?.calcFinanceiro ?? null,
    };
    setConfirmMap(prev => ({ ...prev, [rowIdx]: hydrated }));
  }, [allRows, confirmMap]);

  const openBulkModal = useCallback(() => {
    const jobs = allRows.flatMap((row, rowIdx) => {
      if (rowIdx >= descartadosStart) return [];
      if (!selectedRows.has(rowKey(row))) return [];
      const uc = ucCol ? String(row[ucCol] ?? '') : '';
      return [{
        key: rowKey(row),
        rowIdx,
        row,
        uc,
        fichas: String(row['fichas_aplicadas'] ?? ''),
        detalhe: String(row['detalhamento'] ?? ''),
      }];
    });
    if (!jobs.length) return;
    setBulkModal({ jobs });
  }, [allRows, descartadosStart, selectedRows, rowKey, ucCol]);

  const handleBatchFinished = useCallback((summary) => {
    appendBatchHistory(summary);
    setBatchHistory(readStoredJson(ANALISE_DESVIO_BATCH_HISTORY_KEY, []));
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
            {emProcesso.length} em processo
          </div>
        )}

        {discardedSet.size > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-gray-400 px-2 py-1 rounded border border-[var(--border)]">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
            {discardedSet.size} descartado{discardedSet.size > 1 ? 's' : ''}
          </div>
        )}

        <button
          onClick={() => setShowFilters(v => !v)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors ${
            activeFiltersCount > 0
              ? 'border-blue-500 text-blue-400 bg-blue-500/10'
              : 'border-[var(--border)] hover:bg-[var(--panel)]'
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"/>
          </svg>
          Filtros{activeFiltersCount > 0 ? ` (${activeFiltersCount})` : ''}
        </button>

        {selectedCount > 0 && (
          <>
            <button
              onClick={openBulkModal}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-yellow-500/40 bg-yellow-500/10 text-yellow-300 hover:bg-yellow-500/20"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd"/>
              </svg>
              Analisar selecionados ({selectedCount})
            </button>
            <button
              onClick={() => setSelectedRows(new Set())}
              className="text-xs opacity-60 hover:opacity-100"
            >
              limpar seleção
            </button>
          </>
        )}

        {batchHistory.length > 0 && (
          <span className="text-xs opacity-50">
            último lote: {batchHistory[0]?.processed ?? 0}/{batchHistory[0]?.total ?? 0} · {batchHistory[0]?.confirmed ?? 0} confirmadas · {batchHistory[0]?.errors ?? 0} erros
          </span>
        )}

        <span className="text-xs opacity-50 ml-auto">
          página {currentPage} de {totalPages} · {filtered.length.toLocaleString('pt-BR')} nesta página · {Number(total).toLocaleString('pt-BR')} total
        </span>
      </div>

      {/* Painel de filtros estruturados */}
      {showFilters && (
        <div className="border-b border-[var(--border)] bg-[var(--panel)] px-4 py-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            {/* UC */}
            <div>
              <label className="block opacity-50 mb-0.5">UC</label>
              <input
                type="text"
                value={filters.uc}
                onChange={e => setFilter('uc', e.target.value)}
                placeholder="Código da UC..."
                className="w-full px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] focus:outline-none focus:ring-1"
              />
            </div>
            {/* Cliente */}
            <div>
              <label className="block opacity-50 mb-0.5">Cliente</label>
              <input
                type="text"
                value={filters.cliente}
                onChange={e => setFilter('cliente', e.target.value)}
                placeholder="Nome ou código..."
                className="w-full px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] focus:outline-none focus:ring-1"
              />
            </div>
            {/* Distribuidora */}
            <div>
              <label className="block opacity-50 mb-0.5">Distribuidora</label>
              <select
                value={filters.distribuidora}
                onChange={e => setFilter('distribuidora', e.target.value)}
                className="w-full px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] focus:outline-none"
              >
                <option value="">Todas</option>
                {distribuidorasOpcoes.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            {/* Período */}
            <div>
              <label className="block opacity-50 mb-0.5">Período (de → até)</label>
              <div className="flex gap-1">
                <input
                  type="month"
                  value={filters.periodoInicio}
                  onChange={e => setFilter('periodoInicio', e.target.value)}
                  className="flex-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] focus:outline-none"
                />
                <input
                  type="month"
                  value={filters.periodoFim}
                  onChange={e => setFilter('periodoFim', e.target.value)}
                  className="flex-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] focus:outline-none"
                />
              </div>
            </div>
            {/* Valor da fatura */}
            <div>
              <label className="block opacity-50 mb-0.5">Valor da fatura (R$)</label>
              <div className="flex gap-1 items-center">
                <input
                  type="number"
                  value={filters.valorMin}
                  onChange={e => setFilter('valorMin', e.target.value)}
                  placeholder="Mín"
                  className="w-full px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] focus:outline-none"
                />
                <span className="opacity-30">—</span>
                <input
                  type="number"
                  value={filters.valorMax}
                  onChange={e => setFilter('valorMax', e.target.value)}
                  placeholder="Máx"
                  className="w-full px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] focus:outline-none"
                />
              </div>
            </div>
            {/* Desvio */}
            <div>
              <label className="block opacity-50 mb-0.5">Desvio mínimo (%)</label>
              <input
                type="number"
                value={filters.desvioMin}
                onChange={e => setFilter('desvioMin', e.target.value)}
                placeholder="Ex: 1500"
                className="w-full px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] focus:outline-none"
              />
            </div>
            {/* Erro identificado */}
            <div className="col-span-2">
              <label className="block opacity-50 mb-1">Erro identificado</label>
              <div className="flex gap-2 flex-wrap">
                {['F01','F02','F03','F04','F05'].map(f => (
                  <button
                    key={f}
                    onClick={() => toggleFicha(f)}
                    className={`px-2.5 py-0.5 rounded-full border text-xs font-semibold transition-colors ${
                      filters.fichas.includes(f)
                        ? 'border-blue-500 bg-blue-500/20 text-blue-300'
                        : 'border-[var(--border)] hover:bg-[var(--panel)]'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
            {/* Valor estimado e Prioridade - em desenvolvimento */}
            <div className="col-span-2 flex items-end gap-2 opacity-40">
              <div className="flex-1">
                <label className="block mb-0.5">Valor estimado <span className="text-xs">(em desenvolvimento)</span></label>
                <input disabled placeholder="—" className="w-full px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] cursor-not-allowed"/>
              </div>
              <div className="flex-1">
                <label className="block mb-0.5">Prioridade <span className="text-xs">(em desenvolvimento)</span></label>
                <input disabled placeholder="—" className="w-full px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] cursor-not-allowed"/>
              </div>
            </div>
          </div>
          {activeFiltersCount > 0 && (
            <button
              onClick={clearFilters}
              className="mt-2 text-xs text-red-400 hover:opacity-80 underline"
            >
              Limpar todos os filtros ({activeFiltersCount})
            </button>
          )}
        </div>
      )}

      {/* Tabela Excel */}
      <div className="flex-1 overflow-auto">
        <div className="sticky top-0 z-20 px-4 py-2 border-b border-[var(--border)] bg-[var(--bg)] flex items-center gap-2 overflow-x-auto">
          <button
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1 || loading}
            className="px-2.5 py-1 text-xs rounded border border-[var(--border)] hover:bg-[var(--panel)] disabled:opacity-40"
          >
            Anterior
          </button>
          {visiblePageNumbers[0] > 1 && (
            <>
              <button
                onClick={() => setCurrentPage(1)}
                disabled={loading}
                className="px-2.5 py-1 text-xs rounded border border-[var(--border)] hover:bg-[var(--panel)] disabled:opacity-40"
              >
                1
              </button>
              {visiblePageNumbers[0] > 2 && <span className="text-xs opacity-40">...</span>}
            </>
          )}
          {visiblePageNumbers.map(page => (
            <button
              key={page}
              onClick={() => setCurrentPage(page)}
              disabled={loading}
              className="px-2.5 py-1 text-xs rounded border disabled:opacity-40"
              style={page === currentPage
                ? { backgroundColor: ficha.cor, borderColor: ficha.cor, color: '#fff' }
                : {}
              }
            >
              {page}
            </button>
          ))}
          {visiblePageNumbers[visiblePageNumbers.length - 1] < totalPages && (
            <>
              {visiblePageNumbers[visiblePageNumbers.length - 1] < totalPages - 1 && <span className="text-xs opacity-40">...</span>}
              <button
                onClick={() => setCurrentPage(totalPages)}
                disabled={loading}
                className="px-2.5 py-1 text-xs rounded border border-[var(--border)] hover:bg-[var(--panel)] disabled:opacity-40"
              >
                {totalPages}
              </button>
            </>
          )}
          <button
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages || loading}
            className="px-2.5 py-1 text-xs rounded border border-[var(--border)] hover:bg-[var(--panel)] disabled:opacity-40"
          >
            Próxima
          </button>
        </div>

        {cols.length === 0 ? (
          <div className="p-8 text-sm opacity-50 text-center">Nenhum dado encontrado para esta ficha.</div>
        ) : (
          <table className="min-w-full text-xs border-collapse" style={{ fontFamily: 'Consolas, "Courier New", monospace' }}>
            <thead ref={theadRef} className="sticky top-0 z-10">
              <tr style={{ backgroundColor: '#1e3a5f', color: '#fff' }}>
                <th className="px-2 py-2 text-center font-semibold border-r border-[#2d5080] w-8 select-none">
                  <input
                    type="checkbox"
                    checked={allSelectableSelected}
                    onChange={toggleSelectAll}
                    disabled={selectableRows.length === 0}
                  />
                </th>
                <th className="px-2 py-2 text-center font-semibold border-r border-[#2d5080] w-8 select-none">#</th>
                <th className="px-2 py-2 text-center font-semibold border-r border-[#2d5080] w-16 select-none">IA</th>
                {TABLE_COLS.filter(c => cols.includes(c)).map(col => (
                  <th
                    key={col}
                    className="px-3 py-2 text-left font-semibold whitespace-nowrap border-r border-[#2d5080] last:border-r-0"
                  >
                    {COL_LABELS[col] ?? col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={TABLE_COLS.filter(c => cols.includes(c)).length + 3}
                    className="px-4 py-8 text-center opacity-50"
                  >
                    Nenhum resultado para "{search}"
                  </td>
                </tr>
              ) : allRows.map((row, rowIdx) => {
                const ucVal      = ucCol ? row[ucCol] : null;
                const isEmProcesso = rowIdx >= emProcessoStart && rowIdx < descartadosStart && ucVal != null && ucSet.has(String(ucVal));
                const isDescartado = rowIdx >= descartadosStart;
                const isEven     = rowIdx % 2 === 0;
                const cfm        = confirmMap[rowIdx];
                const isSelected = selectedRows.has(rowKey(row));

                // Separadores de grupo
                const isSepEmProcesso  = rowIdx === emProcessoStart  && emProcesso.length  > 0;
                const isSepDescartados = rowIdx === descartadosStart && descartados.length > 0;

                let rowStyle = {};
                let rowClass = 'border-b transition-colors cursor-pointer ';

                if (isDescartado) {
                  rowStyle = { opacity: 0.4, backgroundColor: 'var(--bg)' };
                  rowClass += 'border-[var(--border)]';
                } else if (isEmProcesso) {
                  rowStyle = { backgroundColor: '#1e3a5f', color: '#e2e8f0' };
                  rowClass += 'hover:opacity-90';
                } else if (isEven) {
                  rowClass += 'bg-[var(--bg)] hover:bg-[var(--panel)] border-[var(--border)]';
                } else {
                  rowClass += 'bg-[var(--panel)] hover:brightness-95 border-[var(--border)]';
                }
                if (isSelected && !isDescartado && !isEmProcesso) {
                  rowStyle = { ...rowStyle, backgroundColor: 'rgba(250, 204, 21, 0.08)' };
                }

                const borderCol = isEmProcesso ? '#2d5080' : 'var(--border)';

                return (
                  <React.Fragment key={rowIdx}>
                    {/* Separador: início das linhas em processo */}
                    {isSepEmProcesso && (
                      <tr>
                        <td colSpan={cols.length + 3} className="px-3 py-1 text-xs font-semibold select-none" style={{ backgroundColor: '#1e3a5f', color: '#93c5fd', borderBottom: '1px solid #2d5080' }}>
                          Em processo ({emProcesso.length})
                        </td>
                      </tr>
                    )}
                    {/* Separador: início das linhas descartadas */}
                    {isSepDescartados && (
                      <tr>
                        <td colSpan={cols.length + 3} className="px-3 py-1 text-xs font-semibold select-none" style={{ backgroundColor: 'var(--panel)', color: '#6b7280', borderBottom: '1px solid var(--border)' }}>
                          Descartados ({descartados.length})
                          <button
                            className="ml-3 text-xs underline opacity-60 hover:opacity-100 font-normal"
                            onClick={() => setDiscardedSet(new Set())}
                          >
                            limpar todos
                          </button>
                        </td>
                      </tr>
                    )}
                  <tr
                    className={rowClass}
                    style={rowStyle}
                    onClick={() => !isDescartado && ucVal && setUcDrawer(String(ucVal))}
                  >
                    <td
                      className="px-2 py-1 text-center border-r select-none"
                      style={{ borderColor: borderCol }}
                      onClick={e => e.stopPropagation()}
                    >
                      {!isDescartado && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelected(row)}
                        />
                      )}
                    </td>
                    <td
                      className="px-2 py-1 text-center border-r select-none"
                      style={{ color: '#9ca3af', borderColor: borderCol }}
                    >
                      {rowIdx + 1}
                    </td>
                    {/* Célula IA + Descarte */}
                    <td
                      className="px-1 py-1 text-center border-r"
                      style={{ borderColor: borderCol }}
                      onClick={e => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-center gap-0.5">
                        {!isDescartado && (
                          cfm?.loading ? (
                            <svg className="animate-spin w-3.5 h-3.5 text-yellow-500" viewBox="0 0 24 24" fill="none" title="Processando análise">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                            </svg>
                          ) : cfm?.erro ? (
                            <span title={`Erro na análise: ${String(cfm?.analise || 'falha ao consultar IA')}`} className="text-red-400 cursor-pointer" onClick={() => openConfirmModal(rowIdx, row)}>✕</span>
                          ) : cfm?.confirmado === true ? (
                            <button title="Anomalia confirmada - clique para ver a análise" onClick={() => openConfirmModal(rowIdx, row, cfm)} className="text-green-500 font-bold hover:opacity-80">✓</button>
                          ) : cfm?.confirmado === false ? (
                            <button title="Anomalia não confirmada - clique para ver a análise" onClick={() => openConfirmModal(rowIdx, row, cfm)} className="text-red-400 hover:opacity-80">✗</button>
                          ) : (
                            <button
                              title={selectedCount > 0 && isSelected ? `Analisar lote selecionado (${selectedCount})` : 'Analisar com IA'}
                              onClick={() => selectedCount > 0 && isSelected ? openBulkModal() : openConfirmModal(rowIdx, row)}
                              className="inline-flex items-center justify-center w-5 h-5 rounded text-yellow-400 hover:bg-yellow-400/20 transition-colors"
                            >
                              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd"/>
                              </svg>
                            </button>
                          )
                        )}
                        {/* Botão detalhe */}
                        {!isDescartado && (
                          <button
                            title="Ver detalhes da anomalia"
                            onClick={(e) => { e.stopPropagation(); openDetailRow(row); }}
                            className="inline-flex items-center justify-center w-5 h-5 rounded text-blue-400 hover:bg-blue-400/20 transition-colors"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                            </svg>
                          </button>
                        )}
                        {/* Botão descarte / restaurar */}
                        <button
                          title={isDescartado ? 'Restaurar' : 'Descartar'}
                          onClick={() => toggleDiscard(row)}
                          className={`inline-flex items-center justify-center w-5 h-5 rounded transition-colors ${
                            isDescartado
                              ? 'text-green-500 hover:bg-green-500/20'
                              : 'text-gray-500 hover:bg-red-500/20 hover:text-red-400'
                          }`}
                        >
                          {isDescartado ? (
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                            </svg>
                          ) : (
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                            </svg>
                          )}
                        </button>
                      </div>
                    </td>
                    {TABLE_COLS.filter(c => cols.includes(c)).map(col => {
                      const v = row[col];
                      let cell;
                      if (col === 'Link') {
                        const isLink = /^https?:\/\//i.test(String(v ?? ''));
                        cell = isLink ? (
                          <a href={String(v)} target="_blank" rel="noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="text-blue-400 underline hover:text-blue-300" title={String(v)}>
                            Ver fatura →
                          </a>
                        ) : <span className="text-gray-400">-</span>;
                      } else if (col === 'desvio_pct_max') {
                        cell = <DesvioBar value={v} />;
                      } else if (col === 'peso_alerta_max') {
                        cell = <PesoBadge value={v} />;
                      } else if (col === 'fichas_aplicadas') {
                        cell = <FichasBadge value={v} />;
                      } else if (col === 'qtd_regras') {
                        const n = parseInt(v, 10);
                        const color = n >= 3 ? '#ef4444' : n === 2 ? '#f97316' : n === 1 ? '#eab308' : '#6b7280';
                        cell = <span style={{ color }} className="font-bold font-mono">{n > 0 ? n : '-'}</span>;
                      } else if (col === 'RS_Total_Fatura') {
                        const num = parseFloat(v);
                        cell = isNaN(num) ? <span className="text-gray-400">-</span>
                          : <span>R$ {num.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>;
                      } else if (col === 'valor_ressarcimento_estimado') {
                        cell = v == null || v === ''
                          ? <span className="text-gray-400">-</span>
                          : (
                            <span
                              className="font-medium"
                              title={row.resultado_salvo_em ? `Salvo em ${new Date(row.resultado_salvo_em).toLocaleString('pt-BR')}` : 'Resultado salvo'}
                            >
                              {formatCurrencyBRL(v)}
                            </span>
                          );
                      } else if (col === 'Mes_Ref') {
                        cell = <span className="font-mono">{formatMesRef(v)}</span>;
                      } else if (col === 'dif_pct_alerta_f02') {
                        cell = v ? <span className="text-orange-400 font-mono text-xs">{String(v)}</span> : <span className="text-gray-400">-</span>;
                      } else if (col === 'status_alerta_f02') {
                        cell = v ? <span className="text-yellow-300 text-xs font-mono">{String(v)}</span> : <span className="text-gray-400">-</span>;
                      } else {
                        cell = cellVal(v, col);
                      }
                      return (
                        <td key={col} className="px-3 py-1 whitespace-nowrap border-r last:border-r-0"
                          style={isEmProcesso ? { borderColor: '#2d5080' } : { borderColor: 'var(--border)' }}>
                          {cell}
                        </td>
                      );
                    })}
                  </tr>
                  </React.Fragment>
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
          Página: <strong className="text-white">{filtered.length.toLocaleString('pt-BR')}</strong> linhas · Total geral: <strong className="text-white">{Number(total).toLocaleString('pt-BR')}</strong>
        </span>
      </div>

      {/* Modal de análise IA */}
      {confirmModal && (
        <ConfirmIAModal
          modal={confirmModal}
          onClose={() => setConfirmModal(null)}
          onResult={handleConfirmResult}
          onSavedResult={handleSavedResult}
          onCriar={(modal, result) => setCriarReqData({ modal, result })}
        />
      )}

      {criarReqData && (
        <CriarRequisicaoModal
          modal={criarReqData.modal}
          result={criarReqData.result}
          onClose={() => { setCriarReqData(null); refreshUcs?.(); }}
          onSuccess={() => { refreshUcs?.(); }}
        />
      )}

      {bulkModal && (
        <BulkConfirmModal
          jobs={bulkModal.jobs}
          onClose={() => setBulkModal(null)}
          onItemResult={handleConfirmResult}
          onFinished={handleBatchFinished}
        />
      )}

      {/* Drawer de histórico da UC */}
      {ucDrawer && (
        <UCHistoricoDrawer uc={ucDrawer} onClose={() => setUcDrawer(null)} />
      )}

      {/* Drawer de detalhe da anomalia */}
      {detailRow && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={() => { setDetailRow(null); setProcessoVinculado(null); }}>
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-[var(--panel)] border border-[var(--panel-border)] rounded-xl shadow-2xl p-5"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="text-base font-bold">{detailRow.cliente || 'Detalhes da Anomalia'}</div>
                <div className="text-xs opacity-60 mt-0.5">
                  UC {detailRow.UC} · {detailRow.Concessionaria} · {formatMesRef(detailRow.Mes_Ref)}
                </div>
              </div>
              <button onClick={() => { setDetailRow(null); setProcessoVinculado(null); }} className="text-gray-400 hover:text-white text-lg leading-none ml-4">✕</button>
            </div>

            <div className="space-y-3 text-xs">
              {/* Fichas + Peso */}
              <div className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/10">
                <div className="flex-1">
                  <div className="opacity-60 mb-1 font-semibold">Fichas Aplicadas</div>
                  <FichasBadge value={detailRow.fichas_aplicadas} />
                </div>
                <div className="text-right">
                  <div className="opacity-60 mb-1 font-semibold">Severidade</div>
                  <PesoBadge value={detailRow.peso_alerta_max} />
                </div>
                <div className="text-right">
                  <div className="opacity-60 mb-1 font-semibold">Qtd Regras</div>
                  {(() => {
                    const n = parseInt(detailRow.qtd_regras, 10);
                    const color = n >= 3 ? '#ef4444' : n === 2 ? '#f97316' : '#eab308';
                    return <span style={{ color }} className="font-bold font-mono text-sm">{n}</span>;
                  })()}
                </div>
              </div>

              {/* F02 — Desvio */}
              {(detailRow.desvio_pct_max || detailRow.status_alerta_f02 || detailRow.dif_pct_alerta_f02) && (
                <div className="p-3 rounded-lg bg-white/5 border border-white/10">
                  <div className="opacity-60 font-semibold mb-2" style={{ color: '#0e9f6e' }}>F02 — Desvio de Média</div>
                  {detailRow.desvio_pct_max != null && (
                    <div className="mb-2"><span className="opacity-60">Desvio máximo: </span><DesvioBar value={detailRow.desvio_pct_max} /></div>
                  )}
                  {detailRow.dif_pct_alerta_f02 && (
                    <div className="mb-1"><span className="opacity-60">Por segmento: </span><span className="text-orange-400 font-mono">{detailRow.dif_pct_alerta_f02}</span></div>
                  )}
                  {detailRow.status_alerta_f02 && (
                    <div className="mb-1"><span className="opacity-60">Status: </span><span className="text-yellow-300 font-mono">{detailRow.status_alerta_f02}</span></div>
                  )}
                  {detailRow.peso_alerta_f02_detalhe && (
                    <div><span className="opacity-60">Peso por seg.: </span><span className="font-mono">{detailRow.peso_alerta_f02_detalhe}</span></div>
                  )}
                </div>
              )}

              {/* F03 — Acúmulo */}
              {detailRow.qtd_meses_f03 && (
                <div className="p-3 rounded-lg bg-white/5 border border-white/10">
                  <div className="opacity-60 font-semibold mb-2" style={{ color: '#c27803' }}>F03 — Acúmulo de Consumo</div>
                  <div className="grid grid-cols-3 gap-2">
                    <div><span className="opacity-60">Meses fixos: </span><span className="font-bold">{detailRow.qtd_meses_f03}</span></div>
                    <div><span className="opacity-60">Valor fixo: </span><span className="font-mono">{detailRow.valor_fixo_f03} kWh</span></div>
                    <div><span className="opacity-60">Consumo atual: </span><span className="font-mono">{detailRow.consumo_atual_f03} kWh</span></div>
                  </div>
                </div>
              )}

              {/* F04 — Troca de medidor */}
              {detailRow.detalhe_f04 && (
                <div className="p-3 rounded-lg bg-white/5 border border-white/10">
                  <div className="opacity-60 font-semibold mb-1" style={{ color: '#9061f9' }}>F04 — Troca de Medidor</div>
                  <div className="font-mono whitespace-pre-wrap opacity-90">{detailRow.detalhe_f04}</div>
                </div>
              )}

              {/* F05 — Quebra de leitura */}
              {detailRow.detalhe_f05 && (
                <div className="p-3 rounded-lg bg-white/5 border border-white/10">
                  <div className="opacity-60 font-semibold mb-1" style={{ color: '#e02424' }}>F05 — Quebra de Leitura</div>
                  <div className="font-mono whitespace-pre-wrap opacity-90">{detailRow.detalhe_f05}</div>
                </div>
              )}

              {/* Detalhamento completo */}
              {detailRow.detalhamento && (
                <div className="p-3 rounded-lg bg-white/5 border border-white/10">
                  <div className="opacity-60 font-semibold mb-1">Detalhamento</div>
                  <div className="whitespace-pre-wrap opacity-90 leading-relaxed">{detailRow.detalhamento}</div>
                </div>
              )}

              {/* Processos vinculados */}
              <div className="p-3 rounded-lg bg-white/5 border border-white/10">
                <div className="opacity-60 font-semibold mb-2 flex items-center gap-1.5">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
                  </svg>
                  Processos Vinculados
                </div>
                {processoVinculado?.loading ? (
                  <div className="flex items-center gap-2 opacity-50">
                    <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                    </svg>
                    Buscando...
                  </div>
                ) : processoVinculado?.processos?.length ? (
                  <div className="space-y-3">
                    {processoVinculado.processos.map(proc => (
                      <div key={proc.id_processo} className="rounded-md border border-blue-500/20 bg-blue-500/5 p-2.5 space-y-1.5">
                        {/* Link do processo */}
                        <div className="flex items-center justify-between">
                          <a
                            href={`/processos/${proc.id_processo}`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1.5 font-bold text-blue-400 hover:text-blue-300 transition-colors"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                            </svg>
                            PROC-{String(proc.id_processo).padStart(3, '0')}
                          </a>
                        </div>
                        {/* Etapa / Sub-etapa */}
                        {(proc.etapa || proc.sub_etapa) && (
                          <div className="flex flex-wrap gap-x-4 gap-y-1">
                            {proc.etapa && (
                              <span><span className="opacity-50">Etapa: </span><span className="font-medium text-[var(--fg)]">{proc.etapa}</span></span>
                            )}
                            {proc.sub_etapa && (
                              <span><span className="opacity-50">Sub-etapa: </span><span className="font-medium text-[var(--fg)]">{proc.sub_etapa}</span></span>
                            )}
                          </div>
                        )}
                        {/* Última movimentação */}
                        {proc.ultima_movimentacao && (
                          <div><span className="opacity-50">Última mov.: </span><span className="font-mono text-green-400">{proc.ultima_movimentacao}</span></div>
                        )}
                        {/* Períodos de irregularidade */}
                        {proc.periodos_irregularidade && (() => {
                          let periodos = [];
                          try { periodos = JSON.parse(proc.periodos_irregularidade); } catch { /* não é JSON */ }
                          if (Array.isArray(periodos) && periodos.length > 0) {
                            return (
                              <div>
                                <span className="opacity-50">Períodos: </span>
                                <div className="flex flex-wrap gap-1.5 mt-1">
                                  {periodos.map((p, i) => {
                                    const mes = parseInt(p.mes, 10);
                                    const label = `${MESES_PT[mes - 1] ?? String(p.mes).padStart(2,'0')}/${p.ano}`;
                                    const key = `${p.ano}-${String(p.mes).padStart(2, '0')}`;
                                    const link = processoVinculado?.fatura_links?.[key];
                                    return link ? (
                                      <a key={i} href={link} target="_blank" rel="noreferrer"
                                        className="px-2 py-0.5 rounded text-xs bg-blue-500/15 text-blue-300 hover:bg-blue-500/30 border border-blue-500/30 font-mono transition-colors">
                                        {label} →
                                      </a>
                                    ) : (
                                      <span key={i} className="px-2 py-0.5 rounded text-xs bg-white/5 font-mono border border-white/10">
                                        {label}
                                      </span>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          }
                          return <div><span className="opacity-50">Períodos: </span><span className="font-mono">{proc.periodos_irregularidade}</span></div>;
                        })()}
                        {/* Descrição da irregularidade */}
                        {proc.descricao_irregularidade && (
                          <div>
                            <div className="opacity-50 mb-0.5">Descrição:</div>
                            <div className="whitespace-pre-wrap opacity-90 leading-relaxed">{proc.descricao_irregularidade}</div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="opacity-40 italic">Nenhum processo encontrado para esta UC.</div>
                )}
              </div>

              {/* Link fatura */}
              {detailRow.Link && /^https?:\/\//i.test(String(detailRow.Link)) && (
                <div className="pt-1">
                  <a href={String(detailRow.Link)} target="_blank" rel="noreferrer"
                    className="text-blue-400 underline hover:text-blue-300">
                    Abrir fatura →
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* Componente principal */
export default function AnaliseDesvio() {
  const [activeTab, setActiveTab] = useState('resumo');
  const [ucsEmProcesso, setUcsEmProcesso] = useState([]);

  /* Carrega UCs em processo */
  const refreshUcsEmProcesso = useCallback(() => {
    apiClient.get('/api/v1/faturas/ucs-em-processo')
      .then(r => setUcsEmProcesso(r.data?.ucs ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => { refreshUcsEmProcesso(); }, [refreshUcsEmProcesso]);

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
          <div className="h-full overflow-hidden">
            <AisurePanel />
          </div>
        ) : (
          FICHAS.map(f => (
            activeTab === f.id ? (
              <div key={f.id} className="h-full flex flex-col">
                <FichaPanel
                  ficha={f}
                  ucsEmProcesso={ucsEmProcesso}
                  refreshUcs={refreshUcsEmProcesso}
                />
              </div>
            ) : null
          ))
        )}
      </div>
    </div>
  );
}
