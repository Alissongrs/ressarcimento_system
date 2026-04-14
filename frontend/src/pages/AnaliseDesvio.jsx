import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ReferenceLine, ReferenceArea, ResponsiveContainer, Cell,
  ScatterChart, Scatter, ZAxis, LabelList,
} from 'recharts';
import apiClient from '../services/apiClient';
import { addChatMessage, createChatSession, deleteChatSession, listChatMessages, listChatSessions } from '../services/chatService.js';
import { ocrQuick } from '../services/ocrService.js';
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

function inferFilenameFromLink(link, fallback = 'fatura.pdf') {
  try {
    const url = new URL(String(link || ''));
    const pathname = String(url.pathname || '');
    const lastSegment = pathname.split('/').filter(Boolean).pop() || '';
    if (/\.(pdf|png|jpg|jpeg|webp|gif|bmp)$/i.test(lastSegment)) {
      return decodeURIComponent(lastSegment);
    }
  } catch {}
  return fallback;
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

/* Extrai texto da camada de texto nativa do PDF (sem OCR/vision).
   Funciona para PDFs digitais (gerados por sistema), que é o caso de 99% das faturas.
   Retorna string vazia se o PDF for escaneado (sem texto embutido). */
async function pdfExtractNativeText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const parts = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Junta itens preservando quebras de linha por posição Y
    let lastY = null;
    const lineParts = [];
    for (const item of content.items) {
      if (!item.str) continue;
      const y = item.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lineParts.push('\n');
      }
      lineParts.push(item.str);
      lastY = y;
    }
    parts.push(lineParts.join(''));
  }
  return parts.join('\n\n').trim();
}

/* Lê um File como base64 puro (sem data URI prefix) */
async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* Extrai dados de um File para análise IA.
   PDFs: retorna pdfBase64 (enviado direto para OpenAI) + texto nativo como contexto.
   Imagens: sem pdfBase64, usa Vision via extract-pdf. */
async function extractFaturaText(file) {
  const kind = await detectRemoteFileKind(file, file.name, file.type);
  const isPDF = kind === 'pdf';
  const isImg = kind === 'image';
  if (!isPDF && !isImg) throw new Error(`tipo de arquivo não suportado: ${file.type || file.name}`);

  if (isPDF) {
    // Lê base64 do PDF puro + extrai texto nativo em paralelo
    const [pdfBase64, nativeText] = await Promise.all([
      fileToBase64(file),
      pdfExtractNativeText(file).catch(() => ''),
    ]);
    return {
      name: file.name,
      text: nativeText.trim(),   // texto nativo vai como contexto adicional
      pdfBase64,                  // PDF puro vai direto para a OpenAI
    };
  }

  // Imagem → Vision OCR
  const imgData = await fileToImageData(file);
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
  const guessedName = nameMatch?.[1] || inferFilenameFromLink(trimmed, contentType.includes('pdf') ? 'fatura.pdf' : 'fatura.jpg');
  const blob = new Blob([res.data], { type: res.data?.type || contentType || 'application/octet-stream' });
  const file = new File([blob], guessedName, { type: blob.type || contentType || 'application/octet-stream' });

  const data = await extractFaturaText(file);
  REMOTE_FATURA_CACHE.set(trimmed, data);
  return data;
}

async function runAisureConfirm({ uc, fichas, detalhe, row, faturaData, ocrText, regionBase64 }) {
  const body = {
    uc,
    fichas,
    detalhamento: detalhe,
    row_data: Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [k, String(v ?? '')])),
    fatura_link: getRowFaturaLink(row),
  };
  if (faturaData?.pdfBase64) {
    // PDF puro → OpenAI lê nativamente (melhor qualidade)
    body.fatura_pdf_base64 = faturaData.pdfBase64;
    body.fatura_pdf_name   = faturaData.name || 'fatura.pdf';
  }
  if (faturaData?.text) {
    // Texto nativo vai sempre como contexto adicional
    body.fatura_text = faturaData.text;
  }
  if (ocrText) {
    // Texto OCR Tesseract — captura campos impressos não capturados pelo pdfjs
    body.fatura_ocr_text = ocrText;
  }
  if (regionBase64) {
    // Área destacada pelo usuário para atenção especial da IA
    body.fatura_region_base64 = regionBase64;
  }
  const res = await apiClient.post('/api/v1/faturas/aisure/confirmar', body);
  return {
    confirmado: res.data.confirmado,
    analise: res.data.analise,
    calcFinanceiro: res.data.calculo_financeiro || null,
  };
}

/**
 * Extrai texto OCR Tesseract de um faturaData (se tiver pdfBase64).
 * Retorna string com o raw_text, ou '' em caso de erro/indisponibilidade.
 */
async function extractOCRText(faturaData) {
  const pdfBase64 = faturaData?.pdfBase64;
  if (!pdfBase64) return '';
  try {
    const byteChars = atob(pdfBase64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const file = new File([blob], faturaData.name || 'fatura.pdf', { type: 'application/pdf' });
    const result = await ocrQuick([file]);
    const rawTexts = (result?.results || []).map(r => (r.raw_text || '').trim()).filter(Boolean);
    return rawTexts.join('\n\n');
  } catch {
    return '';
  }
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
  const newChatRef = useRef(false); // impede que reloadSessions re-selecione após "Novo"

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
      } else if (!newChatRef.current && nextSessions.length > 0) {
        setActiveSessionId(prev => prev ?? nextSessions[0].id);
      }
      newChatRef.current = false;
    } catch {
      setSessions([]);
    } finally {
      setLoadingSessions(false);
    }
  }, []);

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
    newChatRef.current = true;
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
              onChange={e => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
              }}
              onKeyDown={onKey}
              onPaste={handlePaste}
              rows={2}
              placeholder="Pergunte sobre fichas, UCs, anomalias... (Ctrl+V para colar print)"
              className="flex-1 resize-none bg-transparent text-sm focus:outline-none leading-relaxed py-1 text-[var(--fg)] placeholder:text-[var(--fg)]/30"
              style={{ minHeight: '2.5em', maxHeight: 160, overflowY: 'auto' }}
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
  'segmentos', 'desvio_pct_max', 'status_alerta_f02', 'Link', 'alerta_historico',
];
// Colunas virtuais: não existem no banco ou são calculadas — sempre exibidas se houver dados
const VIRTUAL_COLS = new Set(['alerta_historico', 'desvio_pct_max']);

const COL_LABELS = {
  UC: 'UC', cliente: 'Cliente', Concessionaria: 'Distribuidora',
  Mes_Ref: 'Mês Ref', Tp_Tensao: 'Tensão', RS_Total_Fatura: 'Valor Fatura',
  valor_ressarcimento_estimado: 'Valor Ressarc.',
  fichas_aplicadas: 'Fichas', qtd_regras: 'Qtd', peso_alerta_max: 'Peso',
  segmentos: 'Seg.', desvio_pct_max: 'Desvio Seg.',
  status_alerta_f02: 'Status F02', Link: 'Link',
  alerta_historico: 'Histórico',
};

function DesvioBar({ value, compact = false }) {
  const pct = parseFloat(value);
  if (isNaN(pct) || pct === 0) return <span className="text-gray-400">-</span>;
  const abs = Math.min(Math.abs(pct), 500);
  const color = pct >= 200 ? '#ef4444' : pct >= 100 ? '#f97316' : pct >= 50 ? '#eab308' : '#22c55e';
  const label = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
  if (compact) {
    return (
      <span style={{ color, background: `${color}22`, borderRadius: 6, padding: '2px 6px' }}
        className="font-mono font-bold text-xs whitespace-nowrap">
        {label}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1.5 min-w-[90px]">
      <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div style={{ width: `${(abs / 500) * 100}%`, backgroundColor: color }} className="h-full rounded-full" />
      </div>
      <span style={{ color }} className="font-mono font-semibold text-xs whitespace-nowrap">
        {label}
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

const SEVERITY_COLORS = { 5: '#ef4444', 4: '#f97316', 3: '#eab308', 2: '#22c55e', 1: '#3b82f6' };
const SEVERITY_LABELS = { 5: 'Urgente', 4: 'Crítico', 3: 'Alto', 2: 'Médio', 1: 'Baixo' };

// Barra de top-riscos: chips clicáveis dos N registros mais críticos da página
function TopErrosBar({ rows, ucCol, onClickRow }) {
  const top = useMemo(() => {
    return [...rows]
      .map(r => ({
        r,
        score: (parseInt(r.peso_alerta_max, 10) || 0) * 100000 + Math.min(parseFloat(r.desvio_pct_max) || 0, 99999),
      }))
      .filter(x => x.score > 3) // só itens com peso > 0
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }, [rows]);

  if (top.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b flex-shrink-0 overflow-x-auto"
      style={{
        borderColor: 'rgba(239,68,68,0.15)',
        background: 'linear-gradient(90deg, rgba(239,68,68,0.06) 0%, transparent 60%)',
      }}>
      <span className="flex items-center gap-1.5 text-[10px] font-bold flex-shrink-0 whitespace-nowrap"
        style={{ color: '#f87171', fontFamily: "'Syne', system-ui", letterSpacing: '0.05em' }}>
        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd"/>
        </svg>
        ATENÇÃO
      </span>
      {top.map(({ r }, i) => {
        const uc = ucCol ? r[ucCol] : (r.UC ?? r.id ?? '—');
        const peso = parseInt(r.peso_alerta_max, 10) || 0;
        const desvio = parseFloat(r.desvio_pct_max);
        const col = SEVERITY_COLORS[peso] ?? '#6b7280';
        return (
          <button key={i} onClick={() => onClickRow?.(r)}
            className="flex items-center gap-1.5 rounded px-2 py-0.5 border flex-shrink-0 transition-all hover:scale-105"
            style={{
              borderColor: `${col}40`,
              background: `${col}10`,
              color: col,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '10px',
            }}>
            <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: col }} />
            <span className="font-bold">{uc}</span>
            {!isNaN(desvio) && desvio > 0 && (
              <span className="opacity-60" style={{ fontSize: '9px' }}>+{desvio.toFixed(0)}%</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Barra de distribuição de severidade — heatbar + pills filtrantes
function SeverityDistrib({ rows, activeFilter, onFilter }) {
  const LEVELS = [
    { n: 5, color: '#ef4444' }, { n: 4, color: '#f97316' },
    { n: 3, color: '#eab308' }, { n: 2, color: '#22c55e' }, { n: 1, color: '#3b82f6' },
  ];
  const counts = useMemo(() => {
    const c = {};
    rows.forEach(r => {
      const n = parseInt(r.peso_alerta_max, 10);
      if (n >= 1 && n <= 5) c[n] = (c[n] || 0) + 1;
    });
    return c;
  }, [rows]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b flex-shrink-0 flex-wrap"
      style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}>
      {/* Heatbar segmentada */}
      <div className="flex h-1 rounded overflow-hidden gap-px flex-shrink-0" style={{ width: 60 }}>
        {LEVELS.map(({ n, color }) => counts[n] > 0 && (
          <div key={n} style={{ flex: counts[n], background: color }} title={`${counts[n]} ${SEVERITY_LABELS[n]}`} />
        ))}
      </div>
      {/* Pills */}
      {LEVELS.map(({ n, color }) => !counts[n] ? null : (
        <button key={n}
          onClick={() => onFilter(activeFilter === n ? null : n)}
          className="flex items-center gap-1 rounded px-2 py-0.5 transition-all select-none flex-shrink-0"
          style={{
            background: activeFilter === n ? `${color}25` : `${color}0c`,
            color: activeFilter === n ? color : `${color}aa`,
            border: `1px solid ${activeFilter === n ? color + '50' : color + '18'}`,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '10px',
            fontWeight: activeFilter === n ? 700 : 500,
          }}>
          <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: color }} />
          {counts[n]} {SEVERITY_LABELS[n]}
        </button>
      ))}
      {activeFilter != null && (
        <button onClick={() => onFilter(null)}
          className="px-1 flex-shrink-0 hover:opacity-80"
          style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '9px', opacity: 0.35, textDecoration: 'underline' }}>
          ✕ limpar
        </button>
      )}
    </div>
  );
}

/* ── Matriz de Risco ──────────────────────────────────────────────────────────
   Scatter plot: Desvio % (eixo X) × Valor Fatura R$ (eixo Y)
   Cada ponto = UC · cor = severidade · tamanho = peso_alerta
   Quadrantes orientam a decisão: canto superior-direito = ACT NOW
────────────────────────────────────────────────────────────────────────────── */
function RiscoMatrizChart({ rows, cor }) {
  // Agrupa por UC: cada ponto representa uma UC com os piores valores históricos
  const pts = useMemo(() => {
    const groups = {};
    rows.forEach(r => {
      const uc = String(r.UC ?? r.id ?? '').trim();
      if (!uc) return;
      const x = parseFloat(r.desvio_pct_max);
      const y = parseFloat(r.RS_Total_Fatura);
      const peso = parseInt(r.peso_alerta_max, 10) || 1;
      if (!groups[uc]) {
        groups[uc] = { uc, xs: [], ys: [], pesos: [], fichasSet: new Set(), meses: [] };
      }
      if (!isNaN(x)) groups[uc].xs.push(x);
      if (!isNaN(y)) groups[uc].ys.push(y);
      groups[uc].pesos.push(peso);
      if (r.fichas_aplicadas) {
        String(r.fichas_aplicadas).split(/[,\s]+/).forEach(f => { if (f.trim()) groups[uc].fichasSet.add(f.trim()); });
      }
      if (r.Mes_Ref) groups[uc].meses.push(String(r.Mes_Ref));
    });

    const out = [];
    Object.values(groups).forEach(g => {
      const x = g.xs.length ? Math.max(...g.xs) : null;
      const y = g.ys.length ? Math.max(...g.ys) : null;
      if (x == null && y == null) return;
      if ((x ?? 0) === 0 && (y ?? 0) === 0) return;
      const peso = Math.max(...g.pesos);
      out.push({
        x: x ?? 0,
        y: y ?? 0,
        z: Math.max(1, peso) * 18,
        peso,
        uc: g.uc,
        fichas: [...g.fichasSet].filter(Boolean).join(', '),
        desvio: x ?? 0,
        valor: y ?? 0,
        qtdMeses: g.meses.length,
        meses: [...new Set(g.meses)].sort().join(', '),
      });
    });
    return out;
  }, [rows]);

  const medX = useMemo(() => {
    if (!pts.length) return 0;
    const s = [...pts].sort((a, b) => a.x - b.x);
    return s[Math.floor(s.length / 2)]?.x ?? 0;
  }, [pts]);

  const medY = useMemo(() => {
    if (!pts.length) return 0;
    const s = [...pts].sort((a, b) => a.y - b.y);
    return s[Math.floor(s.length / 2)]?.y ?? 0;
  }, [pts]);

  if (pts.length === 0) return (
    <div className="flex items-center justify-center h-32 text-xs opacity-30">
      Sem dados de desvio/valor para exibir a matriz
    </div>
  );

  const byPeso = [5,4,3,2,1].map(p => ({
    p, color: SEVERITY_COLORS[p], label: SEVERITY_LABELS[p],
    data: pts.filter(d => d.peso === p),
  })).filter(g => g.data.length > 0);

  const CustomDot = (props) => {
    const { cx, cy, payload } = props;
    const col = SEVERITY_COLORS[payload.peso] ?? '#6b7280';
    return (
      <g>
        <circle cx={cx} cy={cy} r={6} fill={col} fillOpacity={0.75} stroke={col} strokeWidth={1} />
      </g>
    );
  };

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    if (!d) return null;
    const col = SEVERITY_COLORS[d.peso] ?? '#6b7280';
    return (
      <div className="rounded-lg border px-3 py-2 text-xs shadow-xl"
        style={{ background: '#0d1a2e', borderColor: `${col}55`, color: '#e2e8f0', minWidth: 180 }}>
        <div className="font-bold font-mono mb-1" style={{ color: col }}>UC {d.uc}</div>
        {d.fichas && <div className="opacity-70 mb-1">{d.fichas}</div>}
        <div className="space-y-0.5">
          <div>Desvio máx: <span className="font-semibold" style={{ color: col }}>
            {d.desvio > 0 ? '+' : ''}{d.desvio.toFixed(1)}%
          </span></div>
          <div>Fatura máx: <span className="font-semibold">
            R$ {d.valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
          </span></div>
          <div>Severidade: <span className="font-semibold" style={{ color: col }}>{SEVERITY_LABELS[d.peso]}</span></div>
          {d.qtdMeses > 0 && (
            <div className="pt-1 border-t mt-1" style={{ borderColor: `${col}30` }}>
              <div className="opacity-60">{d.qtdMeses} mês/meses no histórico</div>
              {d.meses && <div className="opacity-40 text-[10px] mt-0.5 break-all">{d.meses}</div>}
            </div>
          )}
        </div>
      </div>
    );
  };

  const fmtMoeda = (v) => v >= 1000 ? `R$${(v/1000).toFixed(0)}k` : `R$${v.toFixed(0)}`;

  const quadrantStyle = { fontSize: 9, fill: 'rgba(255,255,255,0.18)', fontWeight: 700, letterSpacing: 1 };

  return (
    <div className="flex flex-col" style={{ background: 'rgba(0,0,0,0.18)' }}>
      {/* Legenda de quadrantes */}
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <div className="flex flex-col">
          <div className="text-[11px] font-bold tracking-wide" style={{ color: cor ?? '#60a5fa' }}>
            MATRIZ DE RISCO
          </div>
          <div className="text-[9px] opacity-40 mt-0.5">agrupado por UC · pior mês histórico · {pts.length} UCs</div>
        </div>
        <div className="flex items-center gap-3 text-[10px] opacity-60">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{background:'#ef4444'}}/> Alto desvio + alto valor = <strong>ACT NOW</strong></span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{background:'#eab308'}}/> Monitorar</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{background:'#22c55e'}}/> Baixo risco</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <ScatterChart margin={{ top: 8, right: 28, bottom: 28, left: 12 }}>
          <defs>
            <filter id="glow">
              <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
              <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="x" name="Desvio" type="number" unit="%" domain={['auto','auto']}
            tick={{ fontSize: 9, fill: '#475569' }}
            label={{ value: 'Desvio %', position: 'insideBottom', offset: -14, fontSize: 10, fill: '#475569' }} />
          <YAxis dataKey="y" name="Valor" type="number"
            tickFormatter={fmtMoeda}
            tick={{ fontSize: 9, fill: '#475569' }}
            label={{ value: 'Valor Fatura', angle: -90, position: 'insideLeft', offset: 10, fontSize: 10, fill: '#475569' }} />
          <ZAxis dataKey="z" range={[40, 220]} />
          <Tooltip content={<CustomTooltip />} />
          {/* Linhas de referência nas medianas */}
          <ReferenceLine x={medX} stroke="rgba(255,255,255,0.08)" strokeDasharray="5 3"
            label={{ value: 'mediana', position: 'insideTopRight', fontSize: 9, fill: 'rgba(255,255,255,0.2)' }} />
          <ReferenceLine y={medY} stroke="rgba(255,255,255,0.08)" strokeDasharray="5 3"
            label={{ value: 'mediana', position: 'insideTopLeft', fontSize: 9, fill: 'rgba(255,255,255,0.2)' }} />
          {/* Áreas dos quadrantes */}
          <ReferenceArea x1={medX} y1={medY} fill="rgba(239,68,68,0.06)" />
          <ReferenceArea x2={medX} y1={medY} fill="rgba(245,158,11,0.04)" />
          <ReferenceArea x1={medX} y2={medY} fill="rgba(245,158,11,0.03)" />
          <ReferenceArea x2={medX} y2={medY} fill="rgba(255,255,255,0.01)" />
          {/* Séries por severidade */}
          {byPeso.map(({ p, color, label, data }) => (
            <Scatter key={p} name={label} data={data} fill={color} fillOpacity={0.8}
              shape={<CustomDot />} />
          ))}
          <Legend iconSize={8} iconType="circle"
            wrapperStyle={{ fontSize: 10, paddingTop: 4, color: '#64748b' }} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

// Extrai o campo "Alerta Dados" do resultado_ia
// Retorna: 'SEM_HISTORICO' | 'HISTORICO_PARCIAL' | 'OK' | null (IA não rodou)
function parseAlertaDados(resultadoIa) {
  const text = String(resultadoIa || '').trim();
  if (!text) return null;
  const m = text.match(/Alerta\s+Dados\s*:\s*(SEM_HISTORICO|HISTORICO_PARCIAL|OK)/i);
  if (!m) return null;
  return m[1].toUpperCase();
}

// Extrai fichas confirmadas pela IA a partir do texto de resultado_ia
// Ex: "Fichas Confirmadas: 1 (F02)" → Set { 'F02' }
function parseConfirmadasIA(resultadoIa) {
  const text = String(resultadoIa || '');
  if (!text) return null;
  const m = text.match(/Fichas Confirmadas\s*:\s*\d+\s*\(([^)]*)\)/i);
  if (!m) return new Set(); // IA rodou mas não confirmou nada
  const lista = m[1].split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  return new Set(lista);
}

function FichasBadge({ value, resultadoIa }) {
  if (!value) return <span className="text-gray-400">-</span>;
  const raw = String(value);
  // Extrai apenas códigos F01-F05, ignora texto descritivo
  const fichas = [...new Set(raw.match(/F0[1-5]/gi) ?? [])].map(f => f.toUpperCase());
  const colors = { F01: '#1a56db', F02: '#0e9f6e', F03: '#c27803', F04: '#9061f9', F05: '#e02424' };
  const confirmadas = resultadoIa != null ? parseConfirmadasIA(resultadoIa) : null;
  if (fichas.length === 0) return <span className="text-gray-400 text-xs" title={raw}>—</span>;
  return (
    <div className="flex flex-wrap gap-0.5" title={raw}>
      {fichas.map(f => {
        const cor = colors[f] ?? '#6b7280';
        const confirmada = confirmadas != null ? confirmadas.has(f) : null;
        return (
          <span key={f}
            style={{ backgroundColor: cor + '33', color: cor, border: `1px solid ${cor}55` }}
            className="px-1 py-0 rounded text-xs font-bold inline-flex items-center gap-0.5">
            {f}
            {confirmada === true  && <span title="Confirmado pela IA" style={{ color: '#4ade80' }}>✓</span>}
            {confirmada === false && <span title="Não confirmado pela IA" style={{ color: '#f87171' }}>✗</span>}
          </span>
        );
      })}
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
  const prioColor = { CRITICO: '#ef4444', ALTO: '#f97316', MEDIO: '#eab308', BAIXO: '#4ade80' };
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
      <div className="px-3 py-2 space-y-0.5 overflow-auto max-h-[420px]" style={{ background: 'rgba(10,20,40,0.85)' }}>
        {lines.map((line, i) => {
          const upper = line.toUpperCase();
          const normalizedUpper = upper.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          let color = '#94a3b8';   // slate-400 — texto padrão
          let weight = 'normal';
          let bg = 'transparent';
          let border = undefined;
          const isBoldLine = line.startsWith('**') && line.endsWith('**');
          const displayLine = isBoldLine ? line.slice(2, -2) : line;

          // Separadores de seção: ---DADOS DA FATURA--- etc.
          if (/^---[A-Z\u00C0-\u024F\s]+---$/.test(line.trim())) {
            color = '#fbbf24';      // amber-400
            weight = '700';
            bg = 'rgba(251,191,36,0.10)';
            border = '1px solid rgba(251,191,36,0.25)';
          // Fichas F01-F05
          } else if (/^F0[1-5]\s*[—:\-]/.test(line)) {
            if (line.includes('Confirmado') && !line.includes('Não confirmado')) color = '#4ade80';
            else if (line.includes('Não confirmado')) color = '#f87171';
            else color = '#e2e8f0';
            weight = '600';
          // Prioridade
          } else if (normalizedUpper.startsWith('PRIORIDADE:')) {
            const prio = Object.keys(prioColor).find(p => normalizedUpper.includes(p));
            color = prio ? prioColor[prio] : '#facc15';
            weight = '700';
          // Fichas confirmadas / total
          } else if (normalizedUpper.startsWith('FICHAS CONFIRMADAS') || normalizedUpper.startsWith('TOTAL DE FICHAS')) {
            color = '#60a5fa';     // blue-400
            weight = '600';
          // Fichas detectadas
          } else if (normalizedUpper.startsWith('FICHAS DETECTADAS')) {
            color = '#fb923c';     // orange-400
            weight = '700';
          // Labels de identificação: UC, Cliente, Mês, Concessionária, Classe, Grupo, Modalidade
          } else if (/^(UC|CLIENTE|MÊS DE REFERÊNCIA|MES DE REFERENCIA|CONCESSIONÁRIA|CONCESSIONARIA|CLASSE|MODALIDADE|GRUPO)/.test(normalizedUpper)) {
            color = '#7dd3fc';     // sky-300
            weight = '600';
          // Causa raiz, tese regulatória, próxima ação
          } else if (normalizedUpper.startsWith('CAUSA RAIZ') || normalizedUpper.startsWith('TESE REGULATORIA') || normalizedUpper.startsWith('PROXIMA ACAO') || normalizedUpper.startsWith('PRÓXIMA AÇÃO')) {
            color = '#f0abfc';     // fuchsia-300
            weight = '600';
          // Cálculo F01/F02
          } else if (/^CALCULO F0[1-5]|^CÁLCULO F0[1-5]/i.test(normalizedUpper)) {
            color = '#34d399';     // emerald-400
            weight = '600';
          // Valor estimado simples
          } else if (normalizedUpper.startsWith('VALOR ESTIMADO SIMPLES')) {
            color = '#fde68a';     // amber-200
            weight = '700';
            bg = 'rgba(251,191,36,0.08)';
          // Nível de confiança
          } else if (normalizedUpper.startsWith('NÍVEL DE CONFIANÇA') || normalizedUpper.startsWith('NIVEL DE CONFIANCA')) {
            color = '#c4b5fd';     // violet-300
            weight = '600';
          // Tipo / Subtipo
          } else if (normalizedUpper.startsWith('TIPO DE IRREGULARIDADE') || normalizedUpper.startsWith('SUBTIPO DE IRREGULARIDADE')) {
            color = '#fdba74';     // orange-300
            weight = '600';
          // Dobro CDC
          } else if (isBoldLine && upper.includes('DOBRO')) {
            color = '#fbbf24';
            weight = '700';
            bg = 'rgba(251,191,36,0.10)';
          // Qualquer outro negrito
          } else if (isBoldLine) {
            color = '#e2e8f0';
            weight = '700';
          }
          return (
            <div
              key={i}
              style={{
                color,
                fontWeight: weight,
                lineHeight: '1.6',
                background: bg,
                border,
                borderRadius: bg !== 'transparent' ? '3px' : undefined,
                padding: bg !== 'transparent' ? '2px 5px' : undefined,
                marginTop: border ? '6px' : undefined,
                marginBottom: border ? '2px' : undefined,
              }}
            >
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
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold hover:bg-white/5 transition-colors"
            style={{ color: '#60a5fa' }}
          >
            <span>Cálculo Financeiro Estimado</span>
            <span style={{ fontSize: '10px' }}>{showCalc ? '▲' : '▼'}</span>
          </button>
          {showCalc && (
            <div className="px-3 py-2 space-y-0.5 overflow-auto max-h-80" style={{ background: 'rgba(10,20,40,0.85)' }}>
              {calcLines.map((line, i) => {
                const lower = line.toLowerCase();
                let color = '#94a3b8';
                let weight = 'normal';
                if (lower.includes('valor_total_estimado_recuperavel_max')) {
                  color = '#60a5fa'; weight = '700';
                } else if (lower.includes('valor_total_estimado_recuperavel_min')) {
                  color = '#4ade80'; weight = '700';
                } else if (lower.includes('valor_cobrado_a_maior') || lower.includes('valor_potencial_devolucao_em_dobro')) {
                  color = '#fb923c'; weight = '600';
                } else if (lower.includes('calculo_financeiro') || lower.includes('10.')) {
                  color = '#fbbf24'; weight = '700';
                } else if (lower.includes('nivel_de_confianca') || lower.includes('11.')) {
                  color = '#c4b5fd'; weight = '600';
                } else if (lower.includes('classificacao_final') || lower.includes('conclusao_final') || lower.includes('proxima_acao') || lower.includes('12.') || lower.includes('13.') || lower.includes('14.')) {
                  color = '#e2e8f0'; weight = '600';
                }
                return (
                  <div key={i} style={{ color, fontWeight: weight, lineHeight: '1.6' }}>
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

/* ── Seletor de área do PDF ──────────────────────────────────────────────── */
function PDFRegionSelector({ pdfBase64, onSelect, onClose }) {
  const canvasRef  = useRef(null);
  const overlayRef = useRef(null);
  const [rendered, setRendered]   = useState(false);
  const [page, setPage]           = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [pdfDoc, setPdfDoc]       = useState(null);
  const [dragging, setDragging]   = useState(false);
  const [start, setStart]         = useState(null);
  const [rect, setRect]           = useState(null);

  // Carrega PDF
  useEffect(() => {
    if (!pdfBase64) return;
    const bytes = atob(pdfBase64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    pdfjsLib.getDocument({ data: arr }).promise.then(doc => {
      setPdfDoc(doc);
      setTotalPages(doc.numPages);
    });
  }, [pdfBase64]);

  // Renderiza página com alta resolução (devicePixelRatio)
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    setRendered(false);
    setRect(null);
    pdfDoc.getPage(page).then(p => {
      const dpr    = window.devicePixelRatio || 1;
      const BASE_SCALE = 2.5;
      const scale  = BASE_SCALE * dpr;
      const vp     = p.getViewport({ scale });
      const canvas = canvasRef.current;
      // tamanho real do canvas (alta resolução)
      canvas.width  = vp.width;
      canvas.height = vp.height;
      // tamanho CSS (o que aparece na tela)
      canvas.style.width  = `${vp.width  / dpr}px`;
      canvas.style.height = `${vp.height / dpr}px`;
      p.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
        .then(() => setRendered(true));
    });
  }, [pdfDoc, page]);

  const getPos = (e) => {
    const b = overlayRef.current.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };

  const onMouseDown = (e) => {
    const p = getPos(e);
    setStart(p);
    setRect(null);
    setDragging(true);
  };

  const onMouseMove = (e) => {
    if (!dragging || !start) return;
    const p = getPos(e);
    setRect({
      x: Math.min(start.x, p.x), y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y),
    });
  };

  const onMouseUp = () => setDragging(false);

  const handleConfirm = () => {
    if (!rect || rect.w < 10 || rect.h < 10) return;
    const canvas  = canvasRef.current;
    const display = canvas.getBoundingClientRect();
    const sx = canvas.width  / display.width;
    const sy = canvas.height / display.height;
    const crop = document.createElement('canvas');
    crop.width  = rect.w * sx;
    crop.height = rect.h * sy;
    crop.getContext('2d').drawImage(
      canvas,
      rect.x * sx, rect.y * sy, rect.w * sx, rect.h * sy,
      0, 0, crop.width, crop.height,
    );
    onSelect(crop.toDataURL('image/png').split(',')[1]);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#0d1e35]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)] flex-shrink-0">
          <span className="text-sm font-semibold">Selecionar área da fatura</span>
          <div className="flex items-center gap-2">
            {totalPages > 1 && (
              <div className="flex items-center gap-1 text-xs">
                <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
                  className="px-2 py-1 rounded border border-[var(--border)] disabled:opacity-30 hover:bg-white/5">‹</button>
                <span className="opacity-60">Pág. {page}/{totalPages}</span>
                <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
                  className="px-2 py-1 rounded border border-[var(--border)] disabled:opacity-30 hover:bg-white/5">›</button>
              </div>
            )}
            {rect && rect.w > 10 && rect.h > 10 && (
              <button onClick={handleConfirm}
                className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold">
                Confirmar seleção
              </button>
            )}
            <button onClick={onClose} className="text-xs opacity-50 hover:opacity-100 px-2">✕ Fechar</button>
          </div>
        </div>
        {/* Hint */}
        <div className="px-4 py-1.5 text-xs opacity-50 flex-shrink-0 border-b border-[var(--border)]">
          {rendered ? 'Arraste para selecionar a área que deseja destacar para a IA' : 'Carregando PDF...'}
        </div>
        {/* Canvas */}
        <div className="overflow-auto flex-1 relative" ref={overlayRef}
             style={{ cursor: rendered ? 'crosshair' : 'wait' }}
             onMouseDown={rendered ? onMouseDown : undefined}
             onMouseMove={rendered ? onMouseMove : undefined}
             onMouseUp={rendered ? onMouseUp : undefined}>
          <canvas ref={canvasRef} style={{ display: 'block', userSelect: 'none' }} />
          {rect && rect.w > 4 && rect.h > 4 && (
            <div style={{
              position: 'absolute', left: rect.x, top: rect.y,
              width: rect.w, height: rect.h,
              border: '2px solid #3b82f6',
              background: 'rgba(59,130,246,0.18)',
              pointerEvents: 'none',
            }} />
          )}
        </div>
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
  const [regionBase64, setRegionBase64] = useState(null); // área selecionada pelo usuário
  const [showRegionSelector, setShowRegionSelector] = useState(false);
  const [estimatedValue, setEstimatedValue] = useState(() =>
    toBRCurrency(modal?.row?.valor_ressarcimento_estimado)
  );
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);
  const fileRef = useRef(null);
  const autoStartedRef = useRef(false);

  // Timer: inicia quando analyzing=true, para quando analyzing=false
  useEffect(() => {
    if (analyzing) {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [analyzing]);

  useEffect(() => {
    if (!result) return;
    if (estimatedValue) return;
    const extracted = extractValorEstimado(result.calcFinanceiro || result.analise || '');
    if (extracted) {
      setEstimatedValue(toBRCurrency(extracted));
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
      let fd = faturaData;
      // Se não há dados de fatura carregados, tenta buscar via link antes de analisar
      if (!fd?.pdfBase64 && !fd?.text) {
        const link = getRowFaturaLink(modal.row);
        if (link) {
          try {
            fd = await loadFaturaDataFromLink(link);
            setFaturaData(fd);
          } catch {
            // sem fatura — backend fará auto-fetch como fallback
          }
        }
      }
      // OCR Tesseract local — extrai texto impresso (inclui seções como "Descrição da Fatura")
      const ocrText = await extractOCRText(fd);
      const r = await runAisureConfirmWithRetry({
        uc: modal.uc,
        fichas: modal.fichas,
        detalhe: modal.detalhe,
        row: modal.row,
        faturaData: fd,
        ocrText,
        regionBase64,
      });
      setResult(r);
      onResult?.(modal.rowKey, r);
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
    if (!faturaData?.pdfBase64 && !faturaData?.text) return;
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

      onSavedResult?.(modal.rowKey, {
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
  }, [estimatedValue, modal?.row?.id, modal.rowKey, onClose, onSavedResult, result]);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60" onClick={onClose}>
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
            {getRowFaturaLink(modal.row) && (
              <div>
                <a
                  href={getRowFaturaLink(modal.row)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 hover:underline"
                >
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                  </svg>
                  Ver fatura
                </a>
              </div>
            )}
          </div>

          {/* Resultado (se já houver) */}
          {analyzing && (
            <div className="flex items-center gap-2 text-xs opacity-60 py-2">
              <svg className="animate-spin w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              <span>Auditando com IA...</span>
              <span className="font-mono tabular-nums text-blue-400 opacity-100">
                {String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}
              </span>
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

          {/* Botão marcar área + preview */}
          {!result && !analyzing && faturaData?.pdfBase64 && (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setShowRegionSelector(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-blue-500/40 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20"
                title="Selecionar área da fatura para destacar à IA"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
                </svg>
                {regionBase64 ? 'Alterar área marcada' : 'Marcar área da fatura'}
              </button>
              {regionBase64 && (
                <div className="flex items-center gap-2">
                  <img src={`data:image/png;base64,${regionBase64}`} alt="Área selecionada"
                       className="h-10 rounded border border-blue-500/40 object-contain bg-black/30"/>
                  <button onClick={() => setRegionBase64(null)}
                    className="text-xs text-red-400 opacity-60 hover:opacity-100">✕</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Seletor de área */}
        {showRegionSelector && faturaData?.pdfBase64 && (
          <PDFRegionSelector
            pdfBase64={faturaData.pdfBase64}
            onSelect={setRegionBase64}
            onClose={() => setShowRegionSelector(false)}
          />
        )}

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
              {faturaData?.pdfBase64 && (
                <button
                  onClick={() => setShowRegionSelector(true)}
                  className="px-3 py-2 text-sm rounded-lg border border-blue-500/40 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 flex items-center gap-1.5"
                  title="Selecionar área da fatura para destacar à IA"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
                  </svg>
                  {regionBase64 ? 'Alterar área' : 'Marcar área'}
                </button>
              )}
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
  const [minimized, setMinimized] = useState(false);
  const [bulkElapsed, setBulkElapsed] = useState(0);
  const bulkTimerRef = useRef(null);

  useEffect(() => {
    bulkTimerRef.current = setInterval(() => setBulkElapsed(s => s + 1), 1000);
    return () => clearInterval(bulkTimerRef.current);
  }, []);

  useEffect(() => {
    if (!running) clearInterval(bulkTimerRef.current);
  }, [running]);

  const fmtBulkTime = (s) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

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
    onItemResult?.(item.key, { loading: true });

    try {
      const link = getRowFaturaLink(item.row);
      const faturaData = link ? await loadFaturaDataFromLink(link) : null;
      if (faturaData?.name) {
        setItems(prev => prev.map(current => current.key === item.key ? { ...current, message: 'Analisando...', fileName: faturaData.name } : current));
      }
      const ocrText = await extractOCRText(faturaData);
      const result = await runAisureConfirmWithRetry({
        uc: item.uc,
        fichas: item.fichas,
        detalhe: item.detalhe,
        row: item.row,
        faturaData,
        ocrText,
      });
      setItems(prev => prev.map(current => current.key === item.key ? {
        ...current,
        status: 'done',
        message: result.confirmado ? 'Anomalia confirmada' : 'Anomalia não confirmada',
        fileName: faturaData?.name || current.fileName,
        result,
      } : current));
      onItemResult?.(item.key, result);
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || 'Erro ao conectar com o AISURE.';
      const result = { erro: true, analise: msg };
      setItems(prev => prev.map(current => current.key === item.key ? {
        ...current,
        status: 'error',
        message: msg,
        result,
      } : current));
      onItemResult?.(item.key, result);
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
        onItemResult?.(job.key, { loading: true });

        try {
          const link = getRowFaturaLink(job.row);
          const faturaData = link ? await loadFaturaDataFromLink(link) : null;
          if (faturaData?.name) {
            currentItems = currentItems.map((item, i) => i === idx ? { ...item, message: `Analisando... (${idx + 1}/${jobs.length})`, fileName: faturaData.name } : item);
            setItems(currentItems);
          }
          const ocrText = await extractOCRText(faturaData);
          const result = await runAisureConfirmWithRetry({
            uc: job.uc,
            fichas: job.fichas,
            detalhe: job.detalhe,
            row: job.row,
            faturaData,
            ocrText,
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
          onItemResult?.(job.key, result);
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
          onItemResult?.(job.key, result);
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

  // Painel minimizado — flutuante no canto inferior direito
  if (minimized) {
    return (
      <div
        className="fixed bottom-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border border-[var(--border)] cursor-pointer select-none"
        style={{ background: 'linear-gradient(135deg, #1e3a5f, #0f2340)', minWidth: 240 }}
        onClick={() => setMinimized(false)}
        title="Clique para expandir"
      >
        {running ? (
          <svg className="animate-spin w-4 h-4 text-yellow-400 flex-shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
          </svg>
        ) : (
          <svg className="w-4 h-4 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
          </svg>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-white text-xs font-semibold truncate">AISURE — Análise em lote</div>
          <div className="text-white/60 text-[11px]">
            {completed}/{items.length} · ✓{summary.confirmed} ✕{summary.errors} · <span className="font-mono tabular-nums text-blue-300">{fmtBulkTime(bulkElapsed)}</span>
            {running ? ' · processando...' : ' · concluído'}
          </div>
        </div>
        {/* barra de progresso */}
        <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-b-xl overflow-hidden bg-white/10">
          <div
            className="h-full transition-all"
            style={{ width: `${items.length ? (completed / items.length) * 100 : 0}%`, background: running ? '#facc15' : '#4ade80' }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60" onClick={!running ? onClose : undefined}>
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
            <div className="text-white/60 text-xs flex items-center gap-2">
              <span>{completed}/{items.length} processados</span>
              <span className="font-mono tabular-nums text-blue-300">{fmtBulkTime(bulkElapsed)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Botão minimizar */}
            <button
              onClick={() => setMinimized(true)}
              className="text-white/50 hover:text-white"
              title="Minimizar — continua rodando em segundo plano"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4"/>
              </svg>
            </button>
            <button onClick={onClose} disabled={running} className="text-white/50 hover:text-white disabled:opacity-30">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
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

// Converte qualquer representação numérica para o formato BR "12.789,00"
// Aceita: 12789.00 | 12,789.00 (US) | 12789,00 (BR sem milhar) | 12.789,00 (BR com milhar)
function toBRCurrency(raw) {
  if (raw == null || raw === '') return '';
  const str = String(raw).trim();
  // Detecta se tem separador de milhar: "12.789,00" ou "12,789.00"
  // Estratégia: se termina em ",XX" ou ".XX" com exatamente 2 dígitos → decimal é esse símbolo
  // Caso contrário tratar como inteiro ou float simples
  let num;
  if (/[.,]\d{2}$/.test(str)) {
    const decSep = str.slice(-3, -2); // ',' ou '.'
    const clean = str.replace(decSep === ',' ? /\./g : /,/g, '').replace(',', '.');
    num = parseFloat(clean);
  } else {
    num = parseFloat(str.replace(/,/g, ''));
  }
  if (isNaN(num)) return str;
  return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function extractValorEstimado(text) {
  if (!text) return '';
  // \*{0,2} trata markdown bold: "**R$ 39.893,89**" ou "R$ 39.893,89"
  const patterns = [
    // Novo formato
    /Valor Estimado Simples\s*:\s*\*{0,2}\s*R?\$?\s*([\d.]+(?:,\d+)?)/i,
    // Formato antigo (fallback)
    /valor_total_estimado_recuperavel_min\s*:\s*\*{0,2}\s*R?\$?\s*([\d.]+(?:,\d+)?)/i,
    /valor_total_estimado_recuperavel_max\s*:\s*\*{0,2}\s*R?\$?\s*([\d.]+(?:,\d+)?)/i,
    /valor_cobrado_a_maior_estimado\s*:\s*\*{0,2}\s*R?\$?\s*([\d.]+(?:,\d+)?)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1]; // retorna no formato original (ex: "5.678,90" ou "5678,90") — handleSubmit converte
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

  // Descrição pré-preenchida: extrai seções-chave do novo formato; fallback para formato antigo
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
    if (!analiseText) return modal.detalhe || '';

    // Novo formato: extrai só as seções relevantes, formatadas de forma limpa
    function extractSection(text, header) {
      const re = new RegExp(`---${header}---\\s*([\\s\\S]*?)(?=---|$)`, 'i');
      const m = text.match(re);
      return m ? m[1].trim() : '';
    }
    function extractField(text, label) {
      const re = new RegExp(`${label}\\s*:\\s*(.+)`, 'i');
      const m = text.match(re);
      return m ? m[1].trim() : '';
    }

    const diag  = extractSection(analiseText, 'DIAGNÓSTICO');
    const estim = extractSection(analiseText, 'ESTIMATIVA DE RESSARCIMENTO');
    const class_ = extractSection(analiseText, 'CLASSIFICAÇÃO');

    const fichas    = extractField(diag,  'Fichas Confirmadas');
    const prioridade= extractField(diag,  'Prioridade');
    const causa     = extractField(diag,  'Causa Raiz');
    const tese      = extractField(estim, 'Tese Regulatória');
    const valor     = extractField(estim, 'Valor Estimado Simples');
    const confianca = extractField(estim, 'Nível de Confiança');
    const tipo      = extractField(class_, 'Tipo de Irregularidade');
    const subtipo   = extractField(class_, 'Subtipo de Irregularidade');
    const acao      = extractField(class_, 'Próxima Ação');

    const parts = [];
    if (fichas || prioridade || causa) {
      parts.push('DIAGNÓSTICO');
      if (fichas)     parts.push(`Fichas confirmadas: ${fichas}`);
      if (prioridade) parts.push(`Prioridade: ${prioridade}`);
      if (causa)      parts.push(`Causa raiz: ${causa}`);
    }
    if (tese || valor || confianca) {
      parts.push('\nESTIMATIVA');
      if (tese)      parts.push(`Tese regulatória: ${tese}`);
      if (valor)     parts.push(`Valor estimado: ${valor}`);
      if (confianca) parts.push(`Confiança: ${confianca}`);
    }
    if (tipo || subtipo || acao) {
      parts.push('\nCLASSIFICAÇÃO');
      if (tipo)    parts.push(`Tipo: ${tipo}`);
      if (subtipo) parts.push(`Subtipo: ${subtipo}`);
      if (acao)    parts.push(`Próxima ação: ${acao}`);
    }

    return parts.length > 0 ? parts.join('\n') : analiseText;
  }

  const initPeriodo = parseMesRef(row.Mes_Ref);

  const [fields, setFields] = useState({
    uc:                      modal.uc || '',
    cliente:                 row.cliente || row.RAZAO_SOCIAL || '',
    razaoSocialFatura:       row.cliente || row.RAZAO_SOCIAL || '',
    concessionaria:          row.Concessionaria || '',
    cnpj:                    '',
    linkFatura:              row.Link || '',
    ressarcimentoEstimado:   extractValorEstimado(textSource) || String(row.RS_Total_Fatura || '').replace(/[^\d,.]/g, '') || '',
    descricaoIrregularidade: buildDescricao(),
    problemaIdentificado:    modal.fichas || '',
  });
  const [idTipo,      setIdTipo]      = useState(initTipo);
  const [idSubtipo,   setIdSubtipo]   = useState(initSubtipo);
  // Se a IA já classificou, oculta os selects por padrão (exibe badge + botão para reclassificar)
  const [showClassif, setShowClassif] = useState(!(initTipo && initSubtipo));
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
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70" onClick={onClose}>
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
              {!showClassif ? (
                /* Classificação já preenchida pela IA — exibe resumo + botão */
                <div className="flex items-center justify-between rounded border border-[var(--border)] px-3 py-2 bg-[var(--bg-subtle,#1a1a2e)]">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] opacity-50 uppercase tracking-wide">Classificação (sugerida pela IA)</span>
                    <span className="text-xs text-green-400 font-medium">
                      {TIPOS_IRREG.find(t => String(t.id) === String(idTipo))?.nome || idTipo}
                      {idSubtipo && (
                        <span className="text-gray-400 font-normal">
                          {' / '}
                          {SUBTIPOS_IRREG.find(s => String(s.id) === String(idSubtipo))?.nome || idSubtipo}
                        </span>
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowClassif(true)}
                    className="text-[11px] px-2 py-1 rounded border border-[var(--border)] opacity-70 hover:opacity-100 hover:border-blue-500 hover:text-blue-400 transition-colors"
                  >
                    Classificar irregularidade
                  </button>
                </div>
              ) : (
                /* Selects abertos (sem classificação prévia, ou após clicar no botão) */
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>Tipo de Irregularidade *</label>
                    <select className={selectCls} value={idTipo} onChange={e => setIdTipo(e.target.value)}>
                      <option value="">Selecione o tipo...</option>
                      {TIPOS_IRREG.map(t => (
                        <option key={t.id} value={t.id}>{t.nome}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Subtipo de Irregularidade *</label>
                    <select className={selectCls} value={idSubtipo} onChange={e => setIdSubtipo(e.target.value)} disabled={!idTipo}>
                      <option value="">Selecione o subtipo...</option>
                      {subtiposFiltrados.map(s => (
                        <option key={s.id} value={s.id}>{s.nome}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

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

/* ─── Gráfico de consumo F02 ─────────────────────────────────────────────── */
const COR_AUDITADO  = '#ef4444';
const COR_POSTERIOR = '#a78bfa';
const COR_MEDIA     = '#f59e0b';
// Cores por segmento (FP, Ponta, Reservado) em tons distintos
const COR_FP  = '#3b82f6'; // azul
const COR_P   = '#06b6d4'; // ciano
const COR_R   = '#6366f1'; // índigo

function TooltipConsumo({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  const total = (p?.kwh_fp ?? 0) + (p?.kwh_p ?? 0) + (p?.kwh_r ?? 0);
  const difPct = p?.dif_pct;
  const difColor = difPct == null ? '' : difPct > 100 ? '#ef4444' : difPct > 30 ? '#f97316' : difPct < -30 ? '#60a5fa' : '#6ee7b7';
  return (
    <div className="bg-[var(--panel)] border border-[var(--border)] rounded px-3 py-2 text-xs shadow-lg min-w-[150px]"
      style={p?.tipo === 'auditado' ? { borderColor: COR_AUDITADO } : {}}>
      <div className="font-bold mb-1 flex items-center gap-1.5">{label}
        {p?.tipo === 'auditado' && (
          <span className="text-xs font-semibold" style={{ color: COR_AUDITADO }}>● Auditado</span>
        )}
        {p?.tipo === 'posterior' && (
          <span className="text-xs opacity-50 font-normal">posterior</span>
        )}
        {p?.troca_medidor && (
          <span className="text-[10px] px-1 rounded font-semibold" style={{ background: 'rgba(99,102,241,0.2)', color: '#818cf8' }}>⚙ medidor</span>
        )}
      </div>
      <div className="flex justify-between gap-3">
        <span style={{ color: COR_FP }}>Fora Ponta</span>
        <span className="font-mono">{(p?.kwh_fp ?? 0).toLocaleString('pt-BR')} kWh</span>
      </div>
      {(p?.kwh_p ?? 0) > 0 && (
        <div className="flex justify-between gap-3">
          <span style={{ color: COR_P }}>Ponta</span>
          <span className="font-mono">{p.kwh_p.toLocaleString('pt-BR')} kWh</span>
        </div>
      )}
      {(p?.kwh_r ?? 0) > 0 && (
        <div className="flex justify-between gap-3">
          <span style={{ color: COR_R }}>Reservado</span>
          <span className="font-mono">{p.kwh_r.toLocaleString('pt-BR')} kWh</span>
        </div>
      )}
      <div className="border-t border-[var(--border)] mt-1 pt-1 flex justify-between gap-3 font-semibold">
        <span>Total</span>
        <span className="font-mono">{total.toLocaleString('pt-BR')} kWh</span>
      </div>
      {difPct != null && (
        <div className="flex justify-between gap-3 mt-0.5">
          <span className="opacity-60">Desvio</span>
          <span className="font-mono font-semibold" style={{ color: difColor }}>
            {difPct > 0 ? '+' : ''}{difPct.toFixed(1)}%
          </span>
        </div>
      )}
      {(p?.rs_total ?? 0) > 0 && (
        <div className="flex justify-between gap-3 opacity-60 mt-0.5">
          <span>Valor fatura</span>
          <span className="font-mono">R$ {(p.rs_total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
        </div>
      )}
    </div>
  );
}

// CustomBar: contorno vermelho/roxo no mês auditado/posterior
function CustomBarShape(props) {
  const { x, y, width, height, tipo, fill } = props;
  if (!height || height <= 0) return null;
  const stroke = tipo === 'auditado' ? COR_AUDITADO : tipo === 'posterior' ? COR_POSTERIOR : 'none';
  const strokeW = tipo === 'auditado' ? 2 : tipo === 'posterior' ? 1 : 0;
  return <rect x={x} y={y} width={width} height={height} fill={fill} stroke={stroke} strokeWidth={strokeW} rx={2} />;
}

function ConsumoDesvioChart({ uc, mesRef }) {
  const [dados, setDados]       = useState(null);
  const [loading, setLoad]      = useState(true);
  const [selectedPonto, setSelPonto] = useState(null);

  useEffect(() => {
    if (!uc) return;
    setLoad(true);
    setSelPonto(null);
    apiClient.get('/api/v1/faturas/uc-consumo-chart', { params: { uc, mes_ref: mesRef || '' } })
      .then(r => setDados(r.data))
      .catch(() => setDados(null))
      .finally(() => setLoad(false));
  }, [uc, mesRef]);

  const handleBarClick = useCallback((data) => {
    const p = data?.activePayload?.[0]?.payload ?? data?.payload ?? data;
    if (!p?.mes) return;
    if (p.link) {
      window.open(p.link, '_blank', 'noopener,noreferrer');
    } else {
      setSelPonto(prev => prev?.mes === p.mes ? null : p);
    }
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center h-40 text-sm opacity-50">Carregando gráfico...</div>
  );
  if (!dados?.pontos?.length) return (
    <div className="flex items-center justify-center h-24 text-sm opacity-40">Sem dados de consumo.</div>
  );

  const { pontos, media, mad } = dados;
  const auditado = pontos.find(p => p.tipo === 'auditado');
  const desvio   = auditado?.dif_pct ?? null;

  // Descobre se há segmentos ponta/reservado nos dados
  const temPonta     = pontos.some(p => (p.kwh_p ?? 0) > 0);
  const temReservado = pontos.some(p => (p.kwh_r ?? 0) > 0);

  // Limites MAD: faixa normal = média ± MAD
  const madSup = media > 0 && mad > 0 ? media + mad : null;
  const madInf = media > 0 && mad > 0 ? Math.max(0, media - mad) : null;

  // Pontos com troca de medidor
  const trocas = pontos.filter(p => p.troca_medidor);

  return (
    <div className="px-4 pt-4 pb-2">
      {/* Cabeçalho */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <span className="text-xs font-semibold opacity-70">Consumo por Segmento (F02)</span>
        {media > 0 && (
          <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 font-mono">
            Média: {media.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kWh
          </span>
        )}
        {mad > 0 && (
          <span className="text-xs px-2 py-0.5 rounded font-mono opacity-60" style={{ background: 'rgba(245,158,11,0.08)', color: '#fbbf24' }}>
            ±MAD: {mad.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kWh
          </span>
        )}
        {desvio !== null && (
          <span className={`text-xs px-2 py-0.5 rounded font-mono font-bold ${
            desvio > 100 ? 'bg-red-500/20 text-red-400'
            : desvio > 30 ? 'bg-orange-500/20 text-orange-400'
            : desvio < -30 ? 'bg-blue-500/20 text-blue-400'
            : 'bg-green-500/20 text-green-400'
          }`}>
            Desvio: {desvio > 0 ? '+' : ''}{desvio.toFixed(1)}%
          </span>
        )}
        {trocas.length > 0 && (
          <span className="text-xs px-2 py-0.5 rounded font-semibold" style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}>
            ⚙ Troca de medidor
          </span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart
          data={pontos}
          margin={{ top: 4, right: 40, left: 0, bottom: 4 }}
          barCategoryGap="20%"
          style={{ cursor: 'pointer' }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
          <XAxis dataKey="mes" tick={{ fontSize: 10, fill: '#9ca3af' }} tickLine={false} />
          <YAxis
            tick={{ fontSize: 10, fill: '#9ca3af' }} tickLine={false}
            tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}
          />
          <Tooltip content={<TooltipConsumo />} />

          {/* Banda de confiança ±MAD (faixa normal) */}
          {madInf != null && madSup != null && (
            <ReferenceArea y1={madInf} y2={madSup}
              fill={COR_MEDIA} fillOpacity={0.07}
              stroke={COR_MEDIA} strokeOpacity={0.25} strokeDasharray="4 4" strokeWidth={1}
            />
          )}

          {/* Média histórica */}
          {media > 0 && (
            <ReferenceLine y={media} stroke={COR_MEDIA} strokeDasharray="6 3" strokeWidth={1.5}
              label={{ value: `Média`, position: 'right', fontSize: 9, fill: COR_MEDIA }} />
          )}

          {/* Limite superior MAD */}
          {madSup != null && (
            <ReferenceLine y={madSup} stroke={COR_MEDIA} strokeDasharray="3 5" strokeWidth={1} opacity={0.45}
              label={{ value: `+MAD`, position: 'right', fontSize: 8, fill: COR_MEDIA }} />
          )}

          {/* Limite inferior MAD */}
          {madInf != null && madInf > 0 && (
            <ReferenceLine y={madInf} stroke={COR_MEDIA} strokeDasharray="3 5" strokeWidth={1} opacity={0.45}
              label={{ value: `-MAD`, position: 'right', fontSize: 8, fill: COR_MEDIA }} />
          )}

          {/* Fora Ponta — base da pilha */}
          <Bar dataKey="kwh_fp" name="Fora Ponta" stackId="seg" onClick={handleBarClick}
            shape={(props) => <CustomBarShape {...props} tipo={props?.payload?.tipo} fill={
              props?.payload?.tipo === 'auditado' ? COR_AUDITADO
              : props?.payload?.tipo === 'posterior' ? COR_POSTERIOR
              : COR_FP
            } />}>
            {pontos.map((p, i) => (
              <Cell key={i}
                fill={p.tipo === 'auditado' ? COR_AUDITADO : p.tipo === 'posterior' ? COR_POSTERIOR : COR_FP}
                fillOpacity={selectedPonto?.mes === p.mes ? 1 : p.tipo === 'historico' ? 0.55 : 0.95}
              />
            ))}
          </Bar>

          {/* Ponta — só renderiza se existir */}
          {temPonta && (
            <Bar dataKey="kwh_p" name="Ponta" stackId="seg" onClick={handleBarClick}>
              {pontos.map((p, i) => (
                <Cell key={i}
                  fill={p.tipo === 'auditado' ? '#f87171' : p.tipo === 'posterior' ? '#c4b5fd' : COR_P}
                  fillOpacity={selectedPonto?.mes === p.mes ? 1 : p.tipo === 'historico' ? 0.55 : 0.95}
                />
              ))}
            </Bar>
          )}

          {/* Reservado — só renderiza se existir */}
          {temReservado && (
            <Bar dataKey="kwh_r" name="Reservado" stackId="seg" radius={[3, 3, 0, 0]} onClick={handleBarClick}>
              {pontos.map((p, i) => (
                <Cell key={i}
                  fill={p.tipo === 'auditado' ? '#fca5a5' : p.tipo === 'posterior' ? '#ddd6fe' : COR_R}
                  fillOpacity={selectedPonto?.mes === p.mes ? 1 : p.tipo === 'historico' ? 0.55 : 0.95}
                />
              ))}
            </Bar>
          )}

          {/* Label de valor no mês auditado */}
          {auditado && (
            <ReferenceLine x={auditado.mes} stroke={COR_AUDITADO} strokeWidth={2} opacity={0.9}
              label={{
                value: `▲ ${(auditado.kwh_total || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kWh`,
                position: 'top',
                fontSize: 10,
                fontWeight: 700,
                fill: COR_AUDITADO,
              }}
            />
          )}

          {/* Troca de medidor: linha vertical roxa com label */}
          {trocas.map(p => (
            <ReferenceLine key={`troca-${p.mes}`} x={p.mes}
              stroke="#818cf8" strokeWidth={2} strokeDasharray="4 2" opacity={0.8}
              label={{ value: '⚙ medidor', position: 'insideTopLeft', fontSize: 8, fill: '#818cf8' }}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>

      {/* Legenda */}
      <div className="flex items-center gap-4 mt-1 px-1 flex-wrap">
        {[
          { cor: COR_FP,       label: 'Histórico' },
          { cor: COR_AUDITADO, label: 'Auditado' },
          ...(auditado && pontos.some(p => p.tipo === 'posterior') ? [{ cor: COR_POSTERIOR, label: 'Posterior' }] : []),
          { cor: COR_MEDIA, label: 'Média ±MAD', dash: true },
          ...(trocas.length > 0 ? [{ cor: '#818cf8', label: 'Troca medidor', dash: true }] : []),
        ].map(({ cor, label, dash }) => (
          <div key={label} className="flex items-center gap-1.5 text-xs opacity-70">
            {dash
              ? <svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke={cor} strokeWidth="2" strokeDasharray="5 3"/></svg>
              : <span style={{ background: cor }} className="inline-block w-3 h-3 rounded-sm opacity-80" />
            }
            {label}
          </div>
        ))}
        <span className="ml-auto text-[10px] opacity-30 italic">clique na barra para ver fatura</span>
      </div>

      {/* Card da fatura selecionada (quando não há link direto) */}
      {selectedPonto && (
        <div className="mx-1 mt-2 rounded-lg border px-3 py-2.5 text-xs flex items-start gap-3"
          style={{ background: 'rgba(30,58,95,0.55)', borderColor: 'rgba(59,130,246,0.35)' }}>
          <div className="flex-1 grid grid-cols-2 gap-x-6 gap-y-1">
            <div className="flex justify-between">
              <span className="opacity-50">Mês</span>
              <span className="font-mono font-semibold">{selectedPonto.mes}</span>
            </div>
            <div className="flex justify-between">
              <span className="opacity-50">Total kWh</span>
              <span className="font-mono">{(selectedPonto.kwh_total ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}</span>
            </div>
            <div className="flex justify-between">
              <span className="opacity-50">Fora Ponta</span>
              <span className="font-mono">{(selectedPonto.kwh_fp ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kWh</span>
            </div>
            {(selectedPonto.kwh_p ?? 0) > 0 && (
              <div className="flex justify-between">
                <span className="opacity-50">Ponta</span>
                <span className="font-mono">{selectedPonto.kwh_p.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kWh</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="opacity-50">Valor fatura</span>
              <span className="font-mono font-semibold">{(selectedPonto.rs_total ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
            </div>
            {selectedPonto.fichas && (
              <div className="flex justify-between">
                <span className="opacity-50">Fichas</span>
                <span className="font-semibold" style={{ color: COR_AUDITADO }}>{selectedPonto.fichas}</span>
              </div>
            )}
            {selectedPonto.ia_status && selectedPonto.ia_status !== '' && selectedPonto.ia_status !== 'PENDENTE' && (
              <div className="flex justify-between col-span-2">
                <span className="opacity-50">IA</span>
                <span className="font-semibold" style={{ color: selectedPonto.ia_status === 'CONFIRMADO' ? '#ef4444' : selectedPonto.ia_status === 'FALSO_POSITIVO' ? '#9ca3af' : '#fbbf24' }}>
                  {selectedPonto.ia_status}
                </span>
              </div>
            )}
            {!selectedPonto.link && (
              <div className="col-span-2 opacity-40 text-[10px] italic mt-0.5">Link da fatura não disponível</div>
            )}
          </div>
          <button onClick={() => setSelPonto(null)}
            className="text-white/30 hover:text-white/70 transition-colors flex-shrink-0 mt-0.5"
            title="Fechar">✕</button>
        </div>
      )}

      {/* Tabela de % desvio por mês */}
      {pontos.length > 0 && media > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="text-[10px] border-collapse w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th className="text-left px-1.5 py-1 opacity-50 font-medium whitespace-nowrap">Mês</th>
                <th className="text-right px-1.5 py-1 opacity-50 font-medium whitespace-nowrap">Total kWh</th>
                <th className="text-right px-1.5 py-1 opacity-50 font-medium whitespace-nowrap">% Desvio</th>
                <th className="text-center px-1.5 py-1 opacity-50 font-medium whitespace-nowrap">Status</th>
                <th className="text-center px-1.5 py-1 opacity-50 font-medium whitespace-nowrap">Fatura</th>
              </tr>
            </thead>
            <tbody>
              {pontos.map((p, i) => {
                const dif = p.dif_pct ?? null;
                const isAudit = p.tipo === 'auditado';
                const isSel = selectedPonto?.mes === p.mes;
                const barW = dif != null ? Math.min(100, Math.abs(dif) / 2) : 0;
                const barColor = dif == null ? '' : dif > 100 ? '#ef4444' : dif > 30 ? '#f97316' : dif < -30 ? '#60a5fa' : '#6ee7b7';
                return (
                  <tr key={p.mes}
                    className="border-b border-[var(--border)] cursor-pointer transition-colors"
                    onClick={() => handleBarClick(p)}
                    style={{
                      background: isSel ? 'rgba(59,130,246,0.12)' : isAudit ? 'rgba(239,68,68,0.08)' : i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                      borderLeft: isSel ? '2px solid #3b82f6' : '2px solid transparent',
                    }}>
                    <td className="px-1.5 py-0.5 whitespace-nowrap font-medium" style={{ color: isAudit ? COR_AUDITADO : 'inherit' }}>
                      {p.mes}
                      {p.troca_medidor && <span className="ml-1 text-[9px]" style={{ color: '#818cf8' }}>⚙</span>}
                      {isAudit && <span className="ml-1 text-[9px]" style={{ color: COR_AUDITADO }}>▲</span>}
                    </td>
                    <td className="px-1.5 py-0.5 text-right tabular-nums opacity-70">
                      {p.kwh_total.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}
                    </td>
                    <td className="px-1.5 py-0.5 text-right">
                      {dif != null ? (
                        <div className="flex items-center justify-end gap-1">
                          <div className="w-12 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                            <div className="h-full rounded-full" style={{ width: `${barW}%`, background: barColor }} />
                          </div>
                          <span className="tabular-nums font-semibold w-14 text-right" style={{ color: barColor }}>
                            {dif > 0 ? '+' : ''}{dif.toFixed(1)}%
                          </span>
                        </div>
                      ) : <span className="opacity-30">—</span>}
                    </td>
                    <td className="px-1.5 py-0.5 text-center">
                      {dif != null && (
                        <span className="text-[9px] px-1 rounded font-semibold"
                          style={
                            dif > 100 ? { background: 'rgba(239,68,68,0.15)', color: '#ef4444' }
                            : dif > 30  ? { background: 'rgba(249,115,22,0.15)', color: '#f97316' }
                            : dif < -100 ? { background: 'rgba(96,165,250,0.15)', color: '#60a5fa' }
                            : dif < -30  ? { background: 'rgba(96,165,250,0.10)', color: '#93c5fd' }
                            : { background: 'rgba(110,231,183,0.12)', color: '#6ee7b7' }
                          }>
                          {dif > 100 ? 'PICO' : dif > 30 ? 'ALTO' : dif < -100 ? 'MUITO BAIXO' : dif < -30 ? 'BAIXO' : 'NORMAL'}
                        </span>
                      )}
                    </td>
                    <td className="px-1.5 py-0.5 text-center">
                      {p.link ? (
                        <a href={p.link} target="_blank" rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="text-blue-400 hover:text-blue-300 transition-colors"
                          title="Abrir fatura">
                          🔗
                        </a>
                      ) : (
                        <span className="opacity-20">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* Drawer histórico de faturas da UC */
function UCHistoricoDrawer({ uc, mesRef, onClose }) {
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
      className="fixed inset-0 z-[9999] flex justify-end"
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

        {/* Gráfico de consumo */}
        <div className="border-b border-[var(--border)]">
          <ConsumoDesvioChart uc={uc} mesRef={mesRef} />
        </div>

        {/* Tabela de faturas */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-sm opacity-50">Carregando faturas...</div>
          ) : rows.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-sm opacity-50">Nenhuma fatura encontrada para a UC {uc}.</div>
          ) : (
            <table className="min-w-full text-xs border-collapse" style={{ fontFamily: "'JetBrains Mono', 'Consolas', monospace" }}>
              <thead className="sticky top-0">
                <tr style={{
                  background: 'linear-gradient(135deg, #0d1b2a 0%, #1e3a5f 100%)',
                  color: '#94a3b8',
                  borderBottom: '1px solid rgba(37,99,235,0.3)',
                }}>
                  {cols.map(col => (
                    <th key={col} className="px-3 py-2 text-left whitespace-nowrap"
                      style={{
                        borderRight: '1px solid rgba(255,255,255,0.06)',
                        fontFamily: "'Syne', system-ui",
                        fontWeight: 700,
                        fontSize: '11px',
                        letterSpacing: '0.03em',
                        color: '#94a3b8',
                      }}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className={`border-b border-[var(--border)] ${i % 2 === 0 ? 'bg-[var(--bg)]' : 'bg-[var(--panel)]'}`}>
                    {cols.map(col => {
                      const val = row[col];
                      const str = val == null ? '' : String(val);
                      const isLink = /^https?:\/\//i.test(str);
                      return (
                        <td key={col} className="px-3 py-1 whitespace-nowrap border-r border-[var(--border)] last:border-r-0">
                          {isLink ? (
                            <a href={str} target="_blank" rel="noreferrer"
                              className="text-blue-400 hover:text-blue-300 hover:underline inline-flex items-center gap-1">
                              <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                              </svg>
                              Ver fatura
                            </a>
                          ) : str || '-'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-2 text-xs opacity-40 border-t border-[var(--border)] flex-shrink-0">
          {rows.length} fatura{rows.length !== 1 ? 's' : ''} · últimas 72 referências
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
  const [sortCol, setSortCol] = useState(null);   // coluna ativa
  const [sortDir, setSortDir] = useState('asc');  // 'asc' | 'desc'
  const [processoVinculado, setProcessoVinculado] = useState(null); // { loading, processos[] }
  const [attachingMap, setAttachingMap] = useState({});
  const [severityFilter, setSeverityFilter] = useState(null); // null | 1-5
  const [showChart, setShowChart] = useState(false);
  const [groupBy, setGroupBy] = useState('cliente'); // 'none'|'cliente'|'UC'|'Cod_Empresa'
  const [expandedGroups, setExpandedGroups] = useState(new Set());

  const toggleGroup = useCallback((key) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  useEffect(() => { setExpandedGroups(new Set()); }, [groupBy]);

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

  const attachRawFaturaToProcess = useCallback(async (processoId, link, periodLabel) => {
    const pid = Number(processoId || 0);
    const rawLink = String(link || '').trim();
    if (!pid || !rawLink) return;
    const key = `${pid}:${rawLink}`;

    setAttachingMap((prev) => ({ ...(prev || {}), [key]: true }));
    try {
      const { data } = await apiClient.post('/api/v1/faturas/aisure/anexar-ao-processo', {
        processo_id: pid,
        url: rawLink,
        comentario: periodLabel ? `Período vinculado: ${periodLabel}` : '',
      });
      window.alert(`Fatura anexada ao processo ${pid} como "${data?.filename || 'arquivo'}".`);
    } catch (e) {
      window.alert(e?.response?.data?.error || e?.message || 'Falha ao anexar fatura ao processo.');
    } finally {
      setAttachingMap((prev) => ({ ...(prev || {}), [key]: false }));
    }
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

  const empresasOpcoes = useMemo(() => {
    const s = new Set(rows.map(r => String(r.Cod_Empresa ?? '')).filter(Boolean));
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
    row['id'] != null
      ? String(row['id'])
      : `${row[ucCol] ?? ''}_${row['Mes_Ref'] ?? ''}_${row['Cod_Empresa'] ?? ''}`,
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

  const [actionMap, setActionMap] = useState({}); // { [rowId]: { loadingAprovar, loadingDeletar, aprovado } }

  const aprovarFichaHandler = useCallback(async (row) => {
    const id = row['id'];
    if (!id) return;
    setActionMap(prev => ({ ...prev, [id]: { ...(prev[id] ?? {}), loadingAprovar: true } }));
    try {
      await apiClient.post('/api/v1/faturas/ficha/aprovar', { id: Number(id) });
      setRows(prev => prev.map(r => String(r.id) === String(id) ? { ...r, aprovado: 1 } : r));
      setActionMap(prev => ({ ...prev, [id]: { ...(prev[id] ?? {}), loadingAprovar: false, aprovado: true } }));
    } catch (e) {
      window.alert(e?.response?.data?.error || 'Falha ao aprovar');
      setActionMap(prev => ({ ...prev, [id]: { ...(prev[id] ?? {}), loadingAprovar: false } }));
    }
  }, [rowKey]);

  const deletarFichaHandler = useCallback(async (row) => {
    const id = row['id'];
    if (!id) return;
    if (!window.confirm(`Deletar anomalia ID ${id}? Ela não aparecerá mais nas listagens.`)) return;
    setActionMap(prev => ({ ...prev, [id]: { ...(prev[id] ?? {}), loadingDeletar: true } }));
    try {
      await apiClient.post('/api/v1/faturas/ficha/deletar', { id: Number(id) });
      setRows(prev => prev.filter(r => String(r.id) !== String(id)));
      setTotal(prev => Math.max(0, prev - 1));
      setActionMap(prev => { const n = { ...prev }; delete n[id]; return n; });
    } catch (e) {
      window.alert(e?.response?.data?.error || 'Falha ao deletar');
      setActionMap(prev => ({ ...prev, [id]: { ...(prev[id] ?? {}), loadingDeletar: false } }));
    }
  }, []);

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
  const allRows = useMemo(() => [...normais, ...emProcesso], [normais, emProcesso]);

  const handleSort = useCallback((col) => {
    setSortCol(prev => {
      if (prev === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); return col; }
      setSortDir('asc');
      return col;
    });
  }, []);

  const sortedRows = useMemo(() => {
    if (!sortCol) return allRows;
    const NUMERIC_COLS = new Set(['RS_Total_Fatura','valor_ressarcimento_estimado','qtd_regras','peso_alerta_max','desvio_pct_max','flag_f01','flag_f02','flag_f03','flag_f04','flag_f05']);
    return [...allRows].sort((a, b) => {
      const av = a[sortCol] ?? '';
      const bv = b[sortCol] ?? '';
      let cmp;
      if (NUMERIC_COLS.has(sortCol)) {
        cmp = (parseFloat(av) || 0) - (parseFloat(bv) || 0);
      } else if (sortCol === 'Mes_Ref') {
        cmp = String(av).localeCompare(String(bv));
      } else {
        cmp = String(av).toLowerCase().localeCompare(String(bv).toLowerCase());
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [allRows, sortCol, sortDir]);

  const displayRows = useMemo(() =>
    severityFilter == null ? sortedRows : sortedRows.filter(r => parseInt(r.peso_alerta_max, 10) === severityFilter),
  [sortedRows, severityFilter]);

  // Agrupamento por cliente / UC / Cod_Empresa
  const groupedDisplayRows = useMemo(() => {
    if (groupBy === 'none') return displayRows.map(r => ({ type: 'row', row: r }));

    const groups = new Map();
    displayRows.forEach(r => {
      const k = String(r[groupBy] ?? '—').trim() || '—';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });

    // ── UC grouping: 1 card per UC with embedded chart, no expand/collapse ──
    if (groupBy === 'UC') {
      const out = [];
      for (const [uc, ucRows] of groups) {
        const best = ucRows.reduce((prev, cur) =>
          (parseInt(cur.peso_alerta_max, 10) || 0) > (parseInt(prev.peso_alerta_max, 10) || 0) ? cur : prev
        );
        const maxDesvio = Math.max(...ucRows.map(r => parseFloat(r.desvio_pct_max) || 0));
        const maxFatura = Math.max(...ucRows.map(r => parseFloat(r.RS_Total_Fatura) || 0));
        // mesRef: use the anomaly row's Mes_Ref (prefer highest severity, fallback to last)
        const mesRef = String(best.Mes_Ref ?? '').slice(0, 7);
        const fichaSet = [...new Set(ucRows.map(r => String(r.ficha ?? r.anomalia_tipo ?? '')).filter(Boolean))];
        const summary = {
          ...best,
          desvio_pct_max: maxDesvio || best.desvio_pct_max,
          RS_Total_Fatura: maxFatura || best.RS_Total_Fatura,
          _groupCount: ucRows.length,
          _fichas: fichaSet,
        };
        out.push({ type: 'uc-header', key: uc, uc, summary, count: ucRows.length, mesRef });
        out.push({ type: 'uc-chart', key: `${uc}-chart`, uc, mesRef });
      }
      return out;
    }

    // ── All other groupings: standard collapsible groups ───────────────────
    const out = [];
    for (const [key, grpRows] of groups) {
      const best = grpRows.reduce((prev, cur) =>
        (parseInt(cur.peso_alerta_max, 10) || 0) > (parseInt(prev.peso_alerta_max, 10) || 0) ? cur : prev
      );
      const maxDesvio = Math.max(...grpRows.map(r => parseFloat(r.desvio_pct_max) || 0));
      const maxFatura = Math.max(...grpRows.map(r => parseFloat(r.RS_Total_Fatura) || 0));
      const ucs = [...new Set(grpRows.map(r => String(r.UC ?? '')).filter(Boolean))];
      const summary = {
        ...best,
        desvio_pct_max: maxDesvio || best.desvio_pct_max,
        RS_Total_Fatura: maxFatura || best.RS_Total_Fatura,
        _isGroupHeader: true, _groupKey: key, _groupCount: grpRows.length, _groupUCs: ucs,
      };
      out.push({ type: 'group', key, summary, count: grpRows.length });
      if (expandedGroups.has(key)) {
        grpRows.forEach(r => out.push({ type: 'child', row: r, parentKey: key }));
      }
    }
    return out;
  }, [displayRows, groupBy, expandedGroups]);

  const selectableRows = useMemo(() => displayRows.slice(0, descartadosStart), [displayRows, descartadosStart]);
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
    allRows.forEach((row) => {
      const storedItem = stored[rowKey(row)];
      if (storedItem) nextMap[rowKey(row)] = storedItem;
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
    allRows.forEach((row) => {
      const key = rowKey(row);
      const value = confirmMap[key];
      if (value && !value.loading) next[key] = value;
    });
    writeStoredJson(ANALISE_DESVIO_RESULTS_KEY, next);
  }, [confirmMap, allRows, rowKey]);

  const openConfirmModal = useCallback((key, row, initialResult = null) => {
    const uc      = ucCol ? String(row[ucCol] ?? '') : '';
    const fichas  = String(row['fichas_aplicadas'] ?? '');
    const detalhe = String(row['detalhamento'] ?? '');
    setConfirmModal({
      rowKey: key,
      row,
      uc,
      fichas,
      detalhe,
      initialResult: initialResult || buildSavedResultFromRow(row),
    });
  }, [ucCol]);

  const handleConfirmResult = useCallback((key, result) => {
    setConfirmMap(prev => ({ ...prev, [key]: result }));
  }, []);

  const handleSavedResult = useCallback((key, saved) => {
    const row = allRows.find(r => rowKey(r) === key);
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
      ...(confirmMap[key] || buildSavedResultFromRow(row) || {}),
      analise: saved.resultado_ia ?? confirmMap[key]?.analise ?? row.resultado_ia ?? '',
      confirmado: (confirmMap[key]?.confirmado ?? buildSavedResultFromRow({ resultado_ia: saved.resultado_ia })?.confirmado ?? false),
      calcFinanceiro: confirmMap[key]?.calcFinanceiro ?? null,
    };
    setConfirmMap(prev => ({ ...prev, [key]: hydrated }));
  }, [allRows, confirmMap, rowKey]);

  const handleExportAnalisados = useCallback(() => {
    // Filtra linhas que têm IA salva E valor de ressarcimento estimado
    const analisados = allRows.filter(row => {
      const temIA = String(row.resultado_ia ?? '').trim() !== '';
      const temValor = row.valor_ressarcimento_estimado != null && row.valor_ressarcimento_estimado !== '' && parseFloat(row.valor_ressarcimento_estimado) > 0;
      return temIA && temValor;
    });

    if (analisados.length === 0) {
      alert('Nenhum processo com IA concluída e valor de ressarcimento estimado.');
      return;
    }

    const header = [
      'UC', 'Cliente', 'Distribuidora', 'Mês Ref', 'Tensão', 'Modalidade',
      'Fichas', 'Qtd Regras', 'Peso Alerta',
      'Valor Fatura (R$)', 'Valor Ressarcimento Estimado (R$)',
      'IA Confirmou Anomalia', 'Data Análise',
    ];

    const sheetData = [
      header,
      ...analisados.map(row => {
        const analise = String(row.resultado_ia ?? '');
        const confirmedCount = Number((analise.match(/Fichas Confirmadas\s*:\s*(\d+)/i) || [])[1] || 0);
        const confirmado = confirmedCount > 0;
        const dataAnalise = row.resultado_salvo_em
          ? new Date(row.resultado_salvo_em).toLocaleDateString('pt-BR')
          : '';
        return [
          String(row.UC ?? ''),
          String(row.cliente ?? row.RAZAO_SOCIAL ?? ''),
          String(row.Concessionaria ?? ''),
          formatMesRef(row.Mes_Ref),
          String(row.Tp_Tensao ?? ''),
          String(row.Modalidade_Tarifaria ?? ''),
          String(row.fichas_aplicadas ?? ''),
          parseInt(row.qtd_regras ?? 0, 10) || 0,
          parseInt(row.peso_alerta_max ?? 0, 10) || 0,
          parseFloat(row.RS_Total_Fatura ?? 0) || 0,
          parseFloat(row.valor_ressarcimento_estimado ?? 0) || 0,
          confirmado ? 'Sim' : 'Não',
          dataAnalise,
        ];
      }),
    ];

    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    // Largura automática por coluna
    ws['!cols'] = header.map((h, i) => ({
      wch: Math.min(Math.max(h.length, ...sheetData.slice(1).map(r => String(r[i] ?? '').length)) + 2, 50),
    }));
    // Formata colunas de valor como número
    const valorCols = [9, 10]; // índices 0-based das colunas de R$
    sheetData.slice(1).forEach((_, ri) => {
      valorCols.forEach(ci => {
        const cellRef = XLSX.utils.encode_cell({ r: ri + 1, c: ci });
        if (ws[cellRef]) ws[cellRef].t = 'n';
      });
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Analisados IA');
    const date = new Date().toLocaleDateString('pt-BR').replace(/\//g, '-');
    XLSX.writeFile(wb, `analisados_ia_${date}.xlsx`);
  }, [allRows]);

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
      {/* Distribuição de severidade — quick-filter */}
      <SeverityDistrib rows={allRows} activeFilter={severityFilter} onFilter={setSeverityFilter} />
      {/* Top riscos imediatos */}
      <TopErrosBar rows={allRows} ucCol={ucCol}
        onClickRow={(row) => {
          const uc = ucCol ? String(row[ucCol] ?? '') : '';
          if (uc) setUcDrawer({ uc, mesRef: row['Mes_Ref'] ? String(row['Mes_Ref']).slice(0,7) : '' });
        }}
      />
      {/* Matriz de Risco — toggle */}
      <div className="border-b flex-shrink-0" style={{ borderColor: 'var(--border)' }}>
        <button
          onClick={() => setShowChart(v => !v)}
          className="w-full flex items-center justify-between px-4 py-1.5 transition-colors hover:bg-white/4 select-none"
          style={{ background: showChart ? `${ficha.cor}0a` : 'transparent' }}
        >
          <span className="flex items-center gap-2">
            <svg className="w-3 h-3" fill="none" stroke={ficha.cor} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"/>
            </svg>
            <span style={{ fontFamily: "'Syne', system-ui", fontSize: '11px', fontWeight: 700, color: ficha.cor, letterSpacing: '0.06em' }}>
              MATRIZ DE RISCO
            </span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '9px', opacity: 0.4, color: 'var(--fg)' }}>
              Desvio % × Valor Fatura
            </span>
          </span>
          <span style={{ fontSize: '9px', opacity: 0.4, color: ficha.cor }}>{showChart ? '▲' : '▼'}</span>
        </button>
        {showChart && (
          <RiscoMatrizChart rows={allRows} cor={ficha.cor} />
        )}
      </div>
      {/* Barra de busca */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]"
        style={{ background: 'var(--panel)' }}>
        <div className="relative flex-1 max-w-xs">
          <svg className="absolute left-2.5 top-1.5 w-3.5 h-3.5 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/>
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar em qualquer coluna..."
            className="w-full pl-8 pr-3 py-1.5 rounded border bg-[var(--bg)] focus:outline-none focus:ring-1"
            style={{
              borderColor: 'var(--border)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '11px',
              '--tw-ring-color': ficha.cor,
            }}
          />
        </div>

        {/* Status badges */}
        {emProcesso.length > 0 && (
          <div className="flex items-center gap-1 text-xs text-white px-2 py-1 rounded flex-shrink-0" style={{ backgroundColor: '#1e3a5f' }}>
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd"/>
            </svg>
            {emProcesso.length} em proc.
          </div>
        )}
        {discardedSet.size > 0 && (
          <div className="flex items-center gap-1 text-xs text-gray-400 px-2 py-1 rounded border border-[var(--border)] flex-shrink-0">
            {discardedSet.size} desc.
          </div>
        )}

        {/* Agrupar por */}
        <div className="flex items-center gap-1 flex-shrink-0 border rounded overflow-hidden" style={{ borderColor: 'var(--border)' }}>
          {[['cliente','Cliente'],['UC','UC'],['Cod_Empresa','Empresa'],['none','Todos']].map(([v, lbl]) => (
            <button key={v}
              onClick={() => setGroupBy(v)}
              className="px-2.5 py-1 text-[10px] font-semibold transition-colors"
              style={{
                background: groupBy === v ? ficha.cor : 'transparent',
                color: groupBy === v ? '#fff' : 'rgba(255,255,255,0.45)',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >{lbl}</button>
          ))}
        </div>

        {/* Filtros */}
        <button
          onClick={() => setShowFilters(v => !v)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors flex-shrink-0 ${
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

        {/* Analisar selecionados */}
        {selectedCount > 0 && (
          <>
            <button
              onClick={openBulkModal}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-yellow-500/40 bg-yellow-500/10 text-yellow-300 hover:bg-yellow-500/20 flex-shrink-0"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd"/>
              </svg>
              IA ({selectedCount})
            </button>
            <button onClick={() => setSelectedRows(new Set())} className="text-xs opacity-50 hover:opacity-100 flex-shrink-0">
              ✕
            </button>
          </>
        )}

        {/* Exportar IA */}
        {allRows.some(r => String(r.resultado_ia ?? '').trim() !== '' && parseFloat(r.valor_ressarcimento_estimado ?? 0) > 0) && (
          <button
            onClick={handleExportAnalisados}
            title="Exportar com IA concluída"
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border font-medium flex-shrink-0"
            style={{ background: 'rgba(22,163,74,0.12)', border: '1px solid rgba(22,163,74,0.3)', color: '#4ade80' }}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Exportar
          </button>
        )}

        {/* Ações secundárias — menu "⋯" */}
        <div className="relative flex-shrink-0" style={{ position: 'relative' }}>
          <details className="group">
            <summary className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded border border-[var(--border)] hover:bg-[var(--panel)] cursor-pointer select-none list-none opacity-60 hover:opacity-100">
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M6 10a2 2 0 11-4 0 2 2 0 014 0zM12 10a2 2 0 11-4 0 2 2 0 014 0zM16 12a2 2 0 100-4 2 2 0 000 4z"/>
              </svg>
            </summary>
            <div className="absolute right-0 top-full mt-1 z-50 rounded-lg border border-[var(--border)] shadow-xl overflow-hidden"
              style={{ background: 'var(--bg)', minWidth: 180 }}>
              <button
                onClick={() => {
                  if (!window.confirm('Limpar todas as análises salvas localmente?')) return;
                  localStorage.removeItem(ANALISE_DESVIO_RESULTS_KEY);
                  localStorage.removeItem(ANALISE_DESVIO_BATCH_HISTORY_KEY);
                  window.location.reload();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 text-left"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Limpar cache local
              </button>
              {batchHistory.length > 0 && (
                <div className="px-3 py-2 text-[11px] opacity-50 border-t border-[var(--border)]">
                  Último lote: {batchHistory[0]?.confirmed ?? 0} conf. · {batchHistory[0]?.errors ?? 0} err.
                </div>
              )}
            </div>
          </details>
        </div>

        <span className="text-xs opacity-40 ml-auto flex-shrink-0">
          {severityFilter != null ? `${displayRows.length} filtrados · ` : ''}{Number(total).toLocaleString('pt-BR')} total
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
          <table className="min-w-full text-xs border-collapse" style={{ fontFamily: "'JetBrains Mono', 'Consolas', monospace" }}>
            <thead ref={theadRef} className="sticky top-0 z-10 adv-thead-row">
              <tr style={{
                background: 'linear-gradient(135deg, #0d1b2a 0%, #1a2d47 60%, #1e3a5f 100%)',
                color: '#cbd5e1',
                borderBottom: `2px solid ${ficha.cor}55`,
              }}>
                <th className="px-2 py-2 text-center font-semibold w-8 select-none"
                  style={{ borderRight: '1px solid rgba(255,255,255,0.06)' }}>
                  <input
                    type="checkbox"
                    checked={allSelectableSelected}
                    onChange={toggleSelectAll}
                    disabled={selectableRows.length === 0}
                  />
                </th>
                <th className="px-2 py-2 text-center font-semibold w-8 select-none"
                  style={{ borderRight: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.3)', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace" }}>#</th>
                <th className="px-2 py-2 text-center font-semibold w-16 select-none"
                  style={{ borderRight: '1px solid rgba(255,255,255,0.06)', fontFamily: "'Syne', system-ui", fontSize: '11px', letterSpacing: '0.06em', color: '#fbbf24' }}>IA</th>
                {TABLE_COLS.filter(c => VIRTUAL_COLS.has(c) || cols.includes(c)).map(col => (
                  <th
                    key={col}
                    onClick={() => handleSort(col)}
                    className="px-3 py-2 text-left whitespace-nowrap cursor-pointer select-none"
                    style={{
                      borderRight: '1px solid rgba(255,255,255,0.06)',
                      fontFamily: "'Syne', system-ui",
                      fontSize: '11px',
                      fontWeight: 700,
                      letterSpacing: '0.03em',
                      color: sortCol === col ? ficha.cor : '#94a3b8',
                      transition: 'color 0.15s',
                    }}
                    onMouseEnter={e => { if (sortCol !== col) e.currentTarget.style.color = '#e2e8f0'; }}
                    onMouseLeave={e => { if (sortCol !== col) e.currentTarget.style.color = '#94a3b8'; }}
                  >
                    {COL_LABELS[col] ?? col}
                    <span className="ml-1 text-[9px]"
                      style={{ color: sortCol === col ? ficha.cor : 'rgba(255,255,255,0.2)' }}>
                      {sortCol === col ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={TABLE_COLS.filter(c => VIRTUAL_COLS.has(c) || cols.includes(c)).length + 3}
                    className="px-4 py-8 text-center opacity-50"
                  >
                    Nenhum resultado para "{search}"
                  </td>
                </tr>
              ) : groupedDisplayRows.map((entry, entryIdx) => {
                // ── Cabeçalho de grupo ──────────────────────────────────────────
                if (entry.type === 'group') {
                  const { key, summary, count } = entry;
                  const sev = parseInt(summary.peso_alerta_max, 10) || 0;
                  const col = SEVERITY_COLORS[sev] ?? '#6b7280';
                  const isExp = expandedGroups.has(key);
                  const desvio = parseFloat(summary.desvio_pct_max);
                  const fatura = parseFloat(summary.RS_Total_Fatura);
                  const ucsLabel = summary._groupUCs?.length > 1
                    ? `${summary._groupUCs.length} UCs`
                    : (summary._groupUCs?.[0] ?? '');
                  return (
                    <tr key={`grp-${key}`}
                      onClick={() => toggleGroup(key)}
                      className="border-b cursor-pointer select-none"
                      style={{
                        background: isExp
                          ? `linear-gradient(90deg, ${col}18 0%, transparent 100%)`
                          : `linear-gradient(90deg, ${col}0a 0%, transparent 60%)`,
                        borderColor: `${col}30`,
                        borderLeft: `3px solid ${col}`,
                      }}
                    >
                      <td className="px-2 py-1.5 text-center" style={{ color: col, fontSize: 13 }}>
                        {isExp ? '▾' : '▸'}
                      </td>
                      <td className="px-2 py-1.5 text-center text-[10px]" style={{ color: '#64748b', fontFamily: 'JetBrains Mono, monospace' }}>
                        {count}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold"
                          style={{ background: `${col}22`, color: col }}>
                          ● {SEVERITY_LABELS[sev] ?? 'S'+sev}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 font-semibold text-xs" colSpan={3}
                        style={{ color: 'rgba(255,255,255,0.9)' }}>
                        {key}
                        {ucsLabel && <span className="ml-2 text-[10px] opacity-50 font-normal">{ucsLabel}</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right text-xs font-mono" style={{ color: '#94a3b8' }}>
                        {!isNaN(fatura) ? `R$ ${fatura.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-center" colSpan={cols.length - 3}>
                        {!isNaN(desvio) && desvio !== 0 && <DesvioBar value={desvio} compact />}
                      </td>
                    </tr>
                  );
                }

                // ── UC card header (groupBy='UC') ───────────────────────────────
                if (entry.type === 'uc-header') {
                  const { uc, summary, count, mesRef } = entry;
                  const sev = parseInt(summary.peso_alerta_max, 10) || 0;
                  const col = SEVERITY_COLORS[sev] ?? '#6b7280';
                  const desvio = parseFloat(summary.desvio_pct_max);
                  const fatura = parseFloat(summary.RS_Total_Fatura);
                  const fichas = summary._fichas ?? [];
                  const totalCols = TABLE_COLS.filter(c => VIRTUAL_COLS.has(c) || cols.includes(c)).length + 3;
                  return (
                    <tr key={`uc-hdr-${uc}`}
                      className="border-b select-none"
                      style={{
                        background: `linear-gradient(90deg, ${col}18 0%, transparent 100%)`,
                        borderColor: `${col}40`,
                        borderLeft: `3px solid ${col}`,
                        borderTop: entryIdx > 0 ? `2px solid ${col}25` : undefined,
                      }}
                    >
                      <td className="px-2 py-2 text-center text-[10px]" style={{ color: '#64748b', fontFamily: 'JetBrains Mono, monospace' }}>
                        {count}
                      </td>
                      <td className="px-2 py-2">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold"
                          style={{ background: `${col}22`, color: col }}>
                          ● {SEVERITY_LABELS[sev] ?? 'S'+sev}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-bold text-sm" colSpan={3}
                        style={{ color: 'rgba(255,255,255,0.95)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.03em' }}>
                        {uc}
                        {mesRef && <span className="ml-2 text-[10px] opacity-40 font-normal">{mesRef}</span>}
                        {fichas.length > 0 && (
                          <span className="ml-2 flex-inline gap-1">
                            {fichas.map(f => (
                              <span key={f} className="ml-1 text-[10px] px-1.5 py-0.5 rounded"
                                style={{ background: `${col}25`, color: col, fontFamily: 'JetBrains Mono, monospace' }}>
                                {f}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-xs font-mono" style={{ color: '#94a3b8' }}>
                        {!isNaN(fatura) ? `R$ ${fatura.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-center" colSpan={Math.max(1, totalCols - 6)}>
                        {!isNaN(desvio) && desvio !== 0 && <DesvioBar value={desvio} compact />}
                      </td>
                    </tr>
                  );
                }

                // ── UC chart row (groupBy='UC') ─────────────────────────────────
                if (entry.type === 'uc-chart') {
                  const { uc, mesRef } = entry;
                  const totalCols = TABLE_COLS.filter(c => VIRTUAL_COLS.has(c) || cols.includes(c)).length + 3;
                  return (
                    <tr key={`uc-chart-${uc}`}
                      style={{ background: 'rgba(0,0,0,0.15)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td colSpan={totalCols} className="px-0 py-0">
                        <ConsumoDesvioChart uc={uc} mesRef={mesRef} />
                      </td>
                    </tr>
                  );
                }

                // ── Linha normal ou filho de grupo ──────────────────────────────
                const row    = entry.row;
                const isChild = entry.type === 'child';
                const rowIdx = entryIdx;
                const ucVal        = ucCol ? row[ucCol] : null;
                const rk           = rowKey(row);
                const isDescartado = discardedSet.has(rk);
                const isEmProcesso = !isDescartado && ucVal != null && ucSet.has(String(ucVal));
                const isEven       = rowIdx % 2 === 0;
                const cfm          = confirmMap[rk];
                const isSelected   = selectedRows.has(rk);
                const severityN    = parseInt(row.peso_alerta_max, 10) || 0;
                const severityCol  = SEVERITY_COLORS[severityN];

                // Separadores de grupo (apenas sem agrupamento ativo e sem ordenação)
                const isSepEmProcesso  = groupBy === 'none' && !sortCol && rowIdx === emProcessoStart  && emProcesso.length  > 0;
                const isSepDescartados = groupBy === 'none' && !sortCol && rowIdx === descartadosStart && descartados.length > 0;

                let rowStyle = isChild ? { paddingLeft: 12, borderLeft: '3px solid rgba(255,255,255,0.06)' } : {};
                let rowClass = 'border-b transition-colors cursor-pointer adv-row-hover ';

                if (isDescartado) {
                  rowStyle = { opacity: 0.35, backgroundColor: 'var(--bg)' };
                  rowClass += 'border-[var(--border)]';
                } else if (isEmProcesso) {
                  rowStyle = {
                    backgroundColor: 'rgba(30,58,95,0.85)',
                    color: '#e2e8f0',
                    borderLeft: `3px solid #3b82f660`,
                  };
                  rowClass += 'hover:opacity-90';
                } else if (isEven) {
                  rowStyle = { backgroundColor: 'transparent' };
                  rowClass += 'border-[var(--border)]';
                } else {
                  rowStyle = { backgroundColor: 'rgba(255,255,255,0.016)' };
                  rowClass += 'border-[var(--border)]';
                }
                if (isSelected && !isDescartado && !isEmProcesso) {
                  rowStyle = { ...rowStyle, backgroundColor: 'rgba(250, 204, 21, 0.08)' };
                }
                const isAprovado = Number(row['aprovado']) === 1 || (actionMap[row['id']] ?? {}).aprovado;
                if (isAprovado && !isDescartado) {
                  rowStyle = { ...rowStyle, borderLeft: '3px solid #10b981' };
                } else if (!isDescartado && !isEmProcesso && severityCol) {
                  rowStyle = { ...rowStyle, borderLeft: `3px solid ${severityCol}99` };
                }

                const borderCol = isEmProcesso ? '#2d5080' : 'var(--border)';

                return (
                  <React.Fragment key={rk}>
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
                    onClick={() => !isDescartado && ucVal && setUcDrawer({ uc: String(ucVal), mesRef: row['Mes_Ref'] ? String(row['Mes_Ref']).slice(0,7) : '' })}
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
                            <span title={`Erro na análise: ${String(cfm?.analise || 'falha ao consultar IA')}`} className="text-red-400 cursor-pointer" onClick={() => openConfirmModal(rk, row)}>✕</span>
                          ) : cfm?.confirmado === true ? (
                            <button title="Anomalia confirmada - clique para ver a análise" onClick={() => openConfirmModal(rk, row, cfm)} className="text-green-500 font-bold hover:opacity-80">✓</button>
                          ) : cfm?.confirmado === false ? (
                            <button title="Anomalia não confirmada - clique para ver a análise" onClick={() => openConfirmModal(rk, row, cfm)} className="text-red-400 hover:opacity-80">✗</button>
                          ) : (
                            <button
                              title={selectedCount > 0 && isSelected ? `Analisar lote selecionado (${selectedCount})` : 'Analisar com IA'}
                              onClick={() => selectedCount > 0 && isSelected ? openBulkModal() : openConfirmModal(rk, row)}
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
                        {/* Botão Aprovar */}
                        {!isDescartado && (() => {
                          const rowId = row['id'];
                          const act = actionMap[rowId] ?? {};
                          const jaAprovado = Number(row['aprovado']) === 1 || act.aprovado;
                          return act.loadingAprovar ? (
                            <svg className="animate-spin w-3.5 h-3.5 text-green-400" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                          ) : (
                            <button
                              title={jaAprovado ? 'Aprovado' : 'Aprovar irregularidade'}
                              onClick={() => !jaAprovado && aprovarFichaHandler(row)}
                              className={`inline-flex items-center justify-center w-5 h-5 rounded transition-colors ${jaAprovado ? 'text-green-400 cursor-default' : 'text-gray-500 hover:bg-green-500/20 hover:text-green-400'}`}
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                              </svg>
                            </button>
                          );
                        })()}
                        {/* Botão Deletar (soft-delete permanente) */}
                        {!isDescartado && (() => {
                          const rowId = row['id'];
                          const act = actionMap[rowId] ?? {};
                          return act.loadingDeletar ? (
                            <svg className="animate-spin w-3.5 h-3.5 text-red-400" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                          ) : (
                            <button
                              title="Deletar anomalia (não aparecerá mais)"
                              onClick={() => deletarFichaHandler(row)}
                              className="inline-flex items-center justify-center w-5 h-5 rounded text-gray-500 hover:bg-red-600/20 hover:text-red-500 transition-colors"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                              </svg>
                            </button>
                          );
                        })()}
                        {/* Botão descarte local / restaurar */}
                        <button
                          title={isDescartado ? 'Restaurar' : 'Descartar temporário'}
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
                    {TABLE_COLS.filter(c => VIRTUAL_COLS.has(c) || cols.includes(c)).map(col => {
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
                      } else if (col === 'alerta_historico') {
                        const alerta = parseAlertaDados(row.resultado_ia);
                        if (alerta === 'SEM_HISTORICO') {
                          cell = <span className="text-red-400 text-xs font-medium">Sem histórico: Possível reanálise</span>;
                        } else if (alerta === 'HISTORICO_PARCIAL') {
                          cell = <span className="text-yellow-400 text-xs font-medium">Histórico parcial: Possível reanálise</span>;
                        } else if (alerta === 'OK') {
                          cell = <span className="text-green-500 text-xs">OK</span>;
                        } else {
                          cell = null;
                        }
                      } else if (col === 'peso_alerta_max') {
                        cell = <PesoBadge value={v} />;
                      } else if (col === 'fichas_aplicadas') {
                        cell = <FichasBadge value={v} resultadoIa={row.resultado_ia ?? null} />;
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
                      } else if (col === 'desvio_pct_max') {
                        cell = v != null && v !== '' ? <DesvioBar value={v} compact /> : <span className="text-gray-400">-</span>;
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
        className="flex items-center justify-between px-4 py-1.5 flex-shrink-0"
        style={{
          background: 'linear-gradient(135deg, #0d1b2a 0%, #1a2d47 100%)',
          borderTop: `1px solid ${ficha.cor}33`,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '10px',
          color: '#64748b',
        }}
      >
        <span className="flex items-center gap-2">
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 18, height: 18, borderRadius: 4,
            background: `linear-gradient(135deg, ${ficha.cor}, ${ficha.cor}99)`,
            color: '#fff', fontSize: '9px', fontWeight: 800,
          }}>{ficha.label.slice(1)}</span>
          <span style={{ color: '#475569', letterSpacing: '0.04em' }}>{ficha.label} · {ficha.nome.toUpperCase()}</span>
        </span>
        <span className="flex items-center gap-3">
          {emProcesso.length > 0 && (
            <span className="flex items-center gap-1" style={{ color: '#4a90d9' }}>
              <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: '#4a90d9' }}/>
              {emProcesso.length} em proc.
            </span>
          )}
          <span style={{ color: '#334155', fontSize: '9px' }}>↙ hist. UC · ⚡ IA</span>
          {severityFilter != null && (
            <span style={{ color: SEVERITY_COLORS[severityFilter] }}>
              {SEVERITY_LABELS[severityFilter]}: {displayRows.length.toLocaleString('pt-BR')} ·
            </span>
          )}
          <span>
            <strong style={{ color: '#94a3b8' }}>{displayRows.length.toLocaleString('pt-BR')}</strong>
            <span style={{ color: '#334155' }}> / Total: </span>
            <strong style={{ color: ficha.cor }}>{Number(total).toLocaleString('pt-BR')}</strong>
          </span>
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
        <UCHistoricoDrawer uc={ucDrawer.uc} mesRef={ucDrawer.mesRef} onClose={() => setUcDrawer(null)} />
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
                  <FichasBadge value={detailRow.fichas_aplicadas} resultadoIa={detailRow.resultado_ia ?? null} />
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
                                    const attachKey = `${proc.id_processo}:${link || ''}`;
                                    const attaching = !!attachingMap[attachKey];
                                    return link ? (
                                      <span key={i} className="inline-flex items-center gap-1.5">
                                        <a href={link} target="_blank" rel="noreferrer"
                                          className="px-2 py-0.5 rounded text-xs bg-blue-500/15 text-blue-300 hover:bg-blue-500/30 border border-blue-500/30 font-mono transition-colors">
                                          {label} →
                                        </a>
                                        <button
                                          type="button"
                                          onClick={() => attachRawFaturaToProcess(proc.id_processo, link, label)}
                                          disabled={attaching}
                                          className="px-2 py-0.5 rounded text-xs border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                                          title="Anexar PDF bruto ao processo"
                                        >
                                          {attaching ? 'Anexando...' : 'Anexar PDF'}
                                        </button>
                                      </span>
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
// ─── Painel UC-cêntrico ────────────────────────────────────────────────────────
const COR_NORMAL   = '#3b82f6';  // azul — sem anomalia
const COR_ANOMALIA = '#f97316';  // laranja — anomalia detectada
const COR_CONFIRM  = '#ef4444';  // vermelho — IA confirmou

function UCTimelineTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload ?? {};
  return (
    <div className="rounded-lg border px-3 py-2 text-xs shadow-xl"
      style={{ background: '#0d1b2a', borderColor: 'rgba(255,255,255,0.12)', minWidth: 180 }}>
      <div className="font-bold mb-1" style={{ color: '#e2e8f0' }}>{label}</div>
      <div className="flex justify-between gap-4">
        <span className="opacity-60">Consumo</span>
        <span className="font-mono">{(d.kwh_total ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kWh</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="opacity-60">Valor fatura</span>
        <span className="font-mono">{(d.rs_total ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
      </div>
      {d.fichas && (
        <div className="flex justify-between gap-4 mt-1">
          <span className="opacity-60">Fichas</span>
          <span className="font-semibold" style={{ color: COR_ANOMALIA }}>{d.fichas}</span>
        </div>
      )}
      {d.ia_status && d.ia_status !== 'PENDENTE' && d.ia_status !== '' && (
        <div className="flex justify-between gap-4">
          <span className="opacity-60">IA</span>
          <span className="font-semibold" style={{ color: d.ia_status === 'CONFIRMADO' ? COR_CONFIRM : d.ia_status === 'FALSO_POSITIVO' ? '#9ca3af' : '#fbbf24' }}>
            {d.ia_status}
          </span>
        </div>
      )}
      {d.troca_medidor && (
        <div className="mt-1 text-[10px]" style={{ color: '#818cf8' }}>⚙ Troca de medidor</div>
      )}
      <div className="mt-1 text-[10px] opacity-40">{d.link ? 'Clique para abrir fatura' : 'Clique para ver detalhes'}</div>
    </div>
  );
}

function UCTimelineChart({ uc }) {
  const [dados, setDados]        = useState(null);
  const [loading, setLoad]       = useState(true);
  const [selectedPonto, setSelPonto] = useState(null);

  useEffect(() => {
    if (!uc) return;
    setLoad(true);
    setSelPonto(null);
    apiClient.get('/api/v1/faturas/uc-consumo-chart', { params: { uc, mes_ref: '' } })
      .then(r  => setDados(r.data))
      .catch(() => setDados(null))
      .finally(() => setLoad(false));
  }, [uc]);

  if (loading) return <div className="flex items-center justify-center h-32 text-xs opacity-40">Carregando histórico...</div>;
  if (!dados?.pontos?.length) return <div className="flex items-center justify-center h-24 text-xs opacity-40">Sem dados de consumo para esta UC.</div>;

  const { pontos, media, mad } = dados;
  const madSup = media > 0 && mad > 0 ? media + mad : null;
  const madInf = media > 0 && mad > 0 ? Math.max(0, media - mad) : null;

  const handleBarClick = (data) => {
    const p = data?.activePayload?.[0]?.payload ?? data?.payload ?? data;
    if (!p?.mes) return;
    if (p.link) {
      window.open(p.link, '_blank', 'noopener,noreferrer');
    } else {
      setSelPonto(prev => prev?.mes === p.mes ? null : p);
    }
  };

  const barColor = (p) => {
    if (p.ia_status === 'CONFIRMADO')    return COR_CONFIRM;
    if (p.anomalia)                      return COR_ANOMALIA;
    return COR_NORMAL;
  };

  return (
    <div className="px-4 pt-3 pb-2" style={{ background: 'rgba(0,0,0,0.15)' }}>
      {/* legenda rápida */}
      <div className="flex items-center gap-4 mb-2 flex-wrap">
        {media > 0 && (
          <span className="text-[10px] px-2 py-0.5 rounded font-mono" style={{ background: 'rgba(245,158,11,0.12)', color: '#fbbf24' }}>
            Média: {media.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kWh
          </span>
        )}
        {[
          { cor: COR_NORMAL,   label: 'Normal' },
          { cor: COR_ANOMALIA, label: 'Anomalia' },
          { cor: COR_CONFIRM,  label: 'IA Confirmado' },
        ].map(({ cor, label }) => (
          <div key={label} className="flex items-center gap-1.5 text-[10px] opacity-70">
            <span style={{ background: cor }} className="inline-block w-2.5 h-2.5 rounded-sm" />
            {label}
          </div>
        ))}
        <span className="ml-auto text-[9px] opacity-25 italic">clique na barra</span>
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={pontos} margin={{ top: 4, right: 30, left: 0, bottom: 4 }}
          barCategoryGap="18%"
          style={{ cursor: 'pointer' }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.35} />
          <XAxis dataKey="mes" tick={{ fontSize: 9, fill: '#9ca3af' }} tickLine={false} />
          <YAxis tick={{ fontSize: 9, fill: '#9ca3af' }} tickLine={false}
            tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v} />
          <Tooltip content={<UCTimelineTooltip />} />

          {madInf != null && madSup != null && (
            <ReferenceArea y1={madInf} y2={madSup} fill="#f59e0b" fillOpacity={0.06}
              stroke="#f59e0b" strokeOpacity={0.2} strokeDasharray="4 4" strokeWidth={1} />
          )}
          {media > 0 && (
            <ReferenceLine y={media} stroke="#f59e0b" strokeDasharray="6 3" strokeWidth={1.5}
              label={{ value: 'Média', position: 'right', fontSize: 8, fill: '#f59e0b' }} />
          )}

          <Bar dataKey="kwh_total" name="kWh" maxBarSize={28} radius={[2, 2, 0, 0]} onClick={handleBarClick}>
            {pontos.map((p, i) => (
              <Cell key={i} fill={barColor(p)}
                fillOpacity={selectedPonto?.mes === p.mes ? 1 : p.anomalia ? 0.9 : 0.65}
              />
            ))}
            <LabelList content={(props) => {
              const { x, y, width, index } = props;
              const p = pontos[index];
              if (!p?.fichas) return null;
              const fichaList = p.fichas.split(',').map(s => s.trim()).filter(Boolean);
              if (!fichaList.length) return null;
              const cor = p.ia_status === 'CONFIRMADO' ? '#ef4444' : FICHA_CORES[fichaList[0]] ?? '#f97316';
              return (
                <g>
                  <text x={x + width / 2} y={y - 14} textAnchor="middle"
                    fontSize={8} fontWeight={700} fill={cor}
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    {fichaList.join(' ')}
                  </text>
                  <line x1={x + width / 2} y1={y - 6} x2={x + width / 2} y2={y - 2}
                    stroke={cor} strokeWidth={1.5} strokeOpacity={0.7} />
                </g>
              );
            }} />
          </Bar>
        </ComposedChart>
      </ResponsiveContainer>

      {/* Card da fatura selecionada */}
      {selectedPonto && (
        <div className="mt-2 rounded-lg border px-3 py-2 text-[11px] flex items-start gap-3"
          style={{ background: 'rgba(15,35,65,0.7)', borderColor: 'rgba(59,130,246,0.3)' }}>
          <div className="flex-1 grid grid-cols-2 gap-x-5 gap-y-0.5">
            <div className="flex justify-between"><span className="opacity-40">Mês</span><span className="font-mono font-semibold">{selectedPonto.mes}</span></div>
            <div className="flex justify-between"><span className="opacity-40">Total kWh</span><span className="font-mono">{(selectedPonto.kwh_total ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}</span></div>
            <div className="flex justify-between"><span className="opacity-40">Valor</span><span className="font-mono">{(selectedPonto.rs_total ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span></div>
            {selectedPonto.fichas && <div className="flex justify-between"><span className="opacity-40">Fichas</span><span className="font-semibold" style={{ color: COR_ANOMALIA }}>{selectedPonto.fichas}</span></div>}
            {selectedPonto.ia_status && selectedPonto.ia_status !== '' && selectedPonto.ia_status !== 'PENDENTE' && (
              <div className="flex justify-between col-span-2">
                <span className="opacity-40">IA</span>
                <span className="font-semibold" style={{ color: selectedPonto.ia_status === 'CONFIRMADO' ? '#ef4444' : selectedPonto.ia_status === 'FALSO_POSITIVO' ? '#9ca3af' : '#fbbf24' }}>{selectedPonto.ia_status}</span>
              </div>
            )}
            {!selectedPonto.link && <div className="col-span-2 opacity-30 italic text-[9px] mt-0.5">Link da fatura não disponível</div>}
          </div>
          <button onClick={() => setSelPonto(null)} className="opacity-30 hover:opacity-70 transition-opacity flex-shrink-0">✕</button>
        </div>
      )}
    </div>
  );
}

// Cores das fichas para badges
const FICHA_CORES = { F01: '#1a56db', F02: '#0e9f6e', F03: '#c27803', F04: '#9061f9', F05: '#e02424' };
const FICHA_NOMES = { F01: 'Fórmula', F02: 'Desvio', F03: 'Acúmulo', F04: 'Medidor', F05: 'Leitura' };
const FICHAS_LIST = ['F01', 'F02', 'F03', 'F04', 'F05'];

function FichaBadge({ ficha, small }) {
  const cor = FICHA_CORES[ficha] ?? '#6b7280';
  return (
    <span className={`inline-flex items-center rounded font-mono font-semibold ${small ? 'text-[9px] px-1 py-0' : 'text-[10px] px-1.5 py-0.5'}`}
      title={FICHA_NOMES[ficha] ?? ficha}
      style={{ background: `${cor}22`, color: cor, border: `1px solid ${cor}44` }}>
      {ficha}
    </span>
  );
}

function UCResumoPanel() {
  const [ucs, setUcs]           = useState([]);
  const [loading, setLoading]   = useState(true);
  const [busca, setBusca]       = useState('');
  const [empresa, setEmpresa]   = useState('');
  const [fichaFiltro, setFichaFiltro] = useState(new Set()); // filtro por fichas ativas
  const [sortCol, setSortCol]   = useState('quantidade_erros');
  const [sortDir, setSortDir]   = useState('desc');
  const [selectedUC, setSelectedUC] = useState(null);

  const fetchUCs = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (empresa) params.empresa = empresa;
      if (busca)   params.busca   = busca;
      const r = await apiClient.get('/api/v1/faturas/ucs-resumo', { params });
      setUcs(r.data?.ucs ?? []);
    } catch { setUcs([]); }
    finally  { setLoading(false); }
  }, [empresa, busca]);

  useEffect(() => { fetchUCs(); }, [fetchUCs]);

  const toggleFichaFiltro = useCallback((f) => {
    setFichaFiltro(prev => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  }, []);

  const toggleSort = useCallback((col) => {
    setSortCol(c => {
      if (c === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); return c; }
      setSortDir('desc'); return col;
    });
  }, []);

  const filtered = useMemo(() => {
    if (fichaFiltro.size === 0) return ucs;
    return ucs.filter(u => {
      const fichas = u.fichas ?? [];
      return [...fichaFiltro].every(f => fichas.includes(f));
    });
  }, [ucs, fichaFiltro]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = a[sortCol] ?? 0;
      const bv = b[sortCol] ?? 0;
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === 'asc' ? av - bv : bv - av;
    });
  }, [filtered, sortCol, sortDir]);

  const ThU = ({ col, label, right }) => (
    <th className={`px-3 py-2 text-xs font-semibold cursor-pointer select-none whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}
      style={{ borderBottom: '1px solid var(--border)' }}
      onClick={() => toggleSort(col)}>
      {label}{sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );

  const totais = useMemo(() => sorted.reduce((acc, u) => ({
    faturas: acc.faturas + (u.quantidade_faturas ?? 0),
    erros:   acc.erros   + (u.quantidade_erros   ?? 0),
    ressarc: acc.ressarc + (u.ressarcimento_confirmado ?? 0),
  }), { faturas: 0, erros: 0, ressarc: 0 }), [sorted]);

  const fmtBRL = n => (n ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // Conta UCs com cada ficha para exibir no filtro
  const fichaContagem = useMemo(() => {
    const cnt = {};
    ucs.forEach(u => (u.fichas ?? []).forEach(f => { cnt[f] = (cnt[f] ?? 0) + 1; }));
    return cnt;
  }, [ucs]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex flex-col gap-2 px-4 py-2 border-b border-[var(--border)] flex-shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          <input type="text" placeholder="Buscar UC ou cliente..."
            value={busca} onChange={e => setBusca(e.target.value)}
            className="text-xs px-2.5 py-1.5 rounded border border-[var(--border)] bg-[var(--panel)] focus:outline-none"
            style={{ width: 220 }} />
          <input type="text" placeholder="Empresa (cod)..."
            value={empresa} onChange={e => setEmpresa(e.target.value)}
            className="text-xs px-2.5 py-1.5 rounded border border-[var(--border)] bg-[var(--panel)] focus:outline-none"
            style={{ width: 130 }} />
          <span className="text-xs opacity-40">{sorted.length} UCs</span>
          <button onClick={fetchUCs} disabled={loading}
            className="ml-auto text-xs px-3 py-1.5 rounded font-medium text-white"
            style={{ backgroundColor: '#1e3a5f' }}>
            {loading ? '↻ Carregando...' : '↻ Atualizar'}
          </button>
        </div>
        {/* Filtros por ficha */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] opacity-40 mr-1">Filtrar por ficha:</span>
          {FICHAS_LIST.map(f => {
            const ativo = fichaFiltro.has(f);
            const cor = FICHA_CORES[f];
            const cnt = fichaContagem[f] ?? 0;
            return (
              <button key={f} onClick={() => toggleFichaFiltro(f)}
                className="text-[10px] px-2 py-0.5 rounded font-mono font-semibold transition-all"
                style={{
                  background: ativo ? `${cor}30` : 'rgba(255,255,255,0.04)',
                  color: ativo ? cor : 'rgba(255,255,255,0.35)',
                  border: `1px solid ${ativo ? cor : 'rgba(255,255,255,0.08)'}`,
                }}>
                {f} {cnt > 0 && <span className="opacity-60">({cnt})</span>}
              </button>
            );
          })}
          {fichaFiltro.size > 0 && (
            <button onClick={() => setFichaFiltro(new Set())}
              className="text-[10px] px-2 py-0.5 rounded opacity-40 hover:opacity-70 transition-opacity"
              style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
              ✕ Limpar
            </button>
          )}
        </div>
      </div>

      {/* Tabela */}
      <div className="flex-1 overflow-auto">
        {loading && ucs.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-xs opacity-40">Carregando UCs...</div>
        ) : sorted.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-xs opacity-40">Nenhuma UC encontrada.</div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10" style={{ background: 'var(--panel)' }}>
              <tr>
                <ThU col="uc"                       label="UC"             right={false} />
                <ThU col="cliente"                  label="Cliente"        right={false} />
                <ThU col="distribuidora"            label="Distribuidora"  right={false} />
                <th className="px-3 py-2 text-xs font-semibold text-left whitespace-nowrap"
                  style={{ borderBottom: '1px solid var(--border)' }}>Fichas</th>
                <ThU col="quantidade_faturas"       label="Fat."           right={true}  />
                <ThU col="quantidade_erros"         label="Erros"          right={true}  />
                <ThU col="percentual_erros"         label="% Err"          right={true}  />
                <ThU col="ultima_fatura"            label="Última"         right={true}  />
                <ThU col="ressarcimento_confirmado" label="Ressarcimento"  right={true}  />
              </tr>
            </thead>
            <tbody>
              {sorted.map((u, i) => {
                const isSelected = selectedUC === u.uc;
                const temErro = u.quantidade_erros > 0;
                const pct = u.percentual_erros ?? 0;
                const pctColor = pct >= 50 ? '#ef4444' : pct >= 20 ? '#f97316' : pct > 0 ? '#fbbf24' : '#6b7280';
                const fichas = u.fichas ?? [];
                return (
                  <React.Fragment key={u.uc}>
                    <tr
                      onClick={() => setSelectedUC(isSelected ? null : u.uc)}
                      className="border-b border-[var(--border)] cursor-pointer transition-colors"
                      style={{
                        backgroundColor: isSelected
                          ? 'rgba(59,130,246,0.08)'
                          : i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                        borderLeft: isSelected ? '3px solid #3b82f6'
                          : temErro ? `3px solid ${pctColor}55` : '3px solid transparent',
                      }}
                    >
                      {/* UC */}
                      <td className="px-3 py-2 font-mono text-xs font-semibold whitespace-nowrap"
                        style={{ color: isSelected ? '#60a5fa' : 'rgba(255,255,255,0.85)' }}>
                        <span className="mr-1 opacity-40" style={{ fontSize: 9 }}>{isSelected ? '▾' : '▸'}</span>
                        {u.uc}
                      </td>
                      {/* Cliente */}
                      <td className="px-3 py-2 max-w-[180px] truncate opacity-80">{u.cliente || '—'}</td>
                      {/* Distribuidora */}
                      <td className="px-3 py-2 max-w-[140px] truncate opacity-50 text-[11px]">{u.distribuidora || '—'}</td>
                      {/* Fichas detectadas */}
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1 flex-wrap">
                          {fichas.length > 0
                            ? fichas.map(f => <FichaBadge key={f} ficha={f} small />)
                            : <span className="opacity-20 text-[10px]">—</span>}
                        </div>
                      </td>
                      {/* Faturas */}
                      <td className="px-3 py-2 text-right tabular-nums opacity-50">{u.quantidade_faturas}</td>
                      {/* Erros */}
                      <td className="px-3 py-2 text-right tabular-nums">
                        {u.quantidade_erros > 0 ? (
                          <span className="px-1.5 py-0.5 rounded font-semibold"
                            style={{ background: `${pctColor}20`, color: pctColor }}>
                            {u.quantidade_erros}
                          </span>
                        ) : <span className="opacity-20">—</span>}
                      </td>
                      {/* % Erros */}
                      <td className="px-3 py-2 text-right tabular-nums">
                        {pct > 0
                          ? <span className="font-mono text-[11px]" style={{ color: pctColor }}>{pct.toFixed(1)}%</span>
                          : <span className="opacity-20">—</span>}
                      </td>
                      {/* Última fatura */}
                      <td className="px-3 py-2 text-right font-mono text-[11px] opacity-55">{u.ultima_fatura || '—'}</td>
                      {/* Ressarcimento */}
                      <td className="px-3 py-2 text-right tabular-nums">
                        {(u.ressarcimento_confirmado ?? 0) > 0
                          ? <span className="font-semibold" style={{ color: '#10b981' }}>{fmtBRL(u.ressarcimento_confirmado)}</span>
                          : <span className="opacity-20">—</span>}
                      </td>
                    </tr>

                    {/* Timeline expandida */}
                    {isSelected && (
                      <tr>
                        <td colSpan={9} className="p-0">
                          <UCTimelineChart uc={u.uc} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>

            {sorted.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)', background: 'rgba(255,255,255,0.03)' }}>
                  <td colSpan={4} className="px-3 py-2 text-xs font-bold opacity-60">
                    Total ({sorted.length} UCs)
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold opacity-60">{totais.faturas}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold" style={{ color: COR_ANOMALIA }}>{totais.erros}</td>
                  <td className="px-3 py-2 text-right tabular-nums opacity-40">
                    {totais.faturas > 0 ? `${(totais.erros / totais.faturas * 100).toFixed(1)}%` : '—'}
                  </td>
                  <td />
                  <td className="px-3 py-2 text-right tabular-nums font-bold" style={{ color: '#10b981' }}>
                    {fmtBRL(totais.ressarc)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Painel inicial — visão geral por cliente ─────────────────────────────────
function ClientesIAPanel() {
  const [clientes, setClientes]         = useState([]);
  const [loading, setLoading]           = useState(false);
  const [busca, setBusca]               = useState('');
  const [sortCol, setSortCol]           = useState('casos_confirmados');
  const [sortDir, setSortDir]           = useState('desc');
  const [expandedClients, setExpandedClients] = useState(new Set());
  const [clienteUCs, setClienteUCs]           = useState({}); // cod_empresa -> { loading, ucs }

  const fetchClientes = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiClient.get('/api/v1/faturas/clientes-ia');
      setClientes(r.data?.clientes ?? []);
    } catch {
      setClientes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleCliente = useCallback(async (cl) => {
    const key = cl.cod_empresa ?? cl.razao_social;
    setExpandedClients(prev => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); return next; }
      next.add(key); return next;
    });
    // fetch UC detail only once
    if (clienteUCs[key] !== undefined) return;
    setClienteUCs(prev => ({ ...prev, [key]: { loading: true, ucs: [] } }));
    try {
      const params = { razao_social: cl.razao_social };
      if (cl.cod_empresa != null) params.empresa = cl.cod_empresa;
      const r = await apiClient.get('/api/v1/faturas/clientes-ia/detalhe', { params });
      // Aggregate by UC
      const ucMap = {};
      for (const f of r.data?.faturas ?? []) {
        const uc = f.uc || '—';
        if (!ucMap[uc]) ucMap[uc] = { uc, total: 0, anomalias: 0, confirmados: 0, descartados: 0, ressarcimento: 0, ultimo_mes: '' };
        ucMap[uc].total++;
        if ((f.anomalia_encontrada ?? 0) === 1) ucMap[uc].anomalias++;
        if (f.ia_status === 'CONFIRMADO') { ucMap[uc].confirmados++; ucMap[uc].ressarcimento += f.valor_ressarcimento_estimado ?? 0; }
        if (f.ia_status === 'FALSO_POSITIVO') ucMap[uc].descartados++;
        if (f.mes_ref && (!ucMap[uc].ultimo_mes || f.mes_ref > ucMap[uc].ultimo_mes)) ucMap[uc].ultimo_mes = f.mes_ref;
      }
      const ucs = Object.values(ucMap).sort((a, b) => b.anomalias - a.anomalias || a.uc.localeCompare(b.uc));
      setClienteUCs(prev => ({ ...prev, [key]: { loading: false, ucs } }));
    } catch {
      setClienteUCs(prev => ({ ...prev, [key]: { loading: false, ucs: [] } }));
    }
  }, [clienteUCs]);

  useEffect(() => { fetchClientes(); }, [fetchClientes]);

  const sorted = useMemo(() => {
    const filtered = busca
      ? clientes.filter(c => String(c.razao_social ?? '').toLowerCase().includes(busca.toLowerCase()))
      : clientes;
    return [...filtered].sort((a, b) => {
      const av = a[sortCol] ?? 0;
      const bv = b[sortCol] ?? 0;
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === 'asc' ? av - bv : bv - av;
    });
  }, [clientes, sortCol, sortDir, busca]);

  const toggleSort = useCallback((col) => {
    setSortCol(c => {
      if (c === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); return c; }
      setSortDir('desc'); return col;
    });
  }, []);

  const ThS = ({ col, label, right }) => (
    <th
      className={`px-3 py-2 text-xs font-semibold cursor-pointer select-none whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}
      style={{ borderBottom: '1px solid var(--border)' }}
      onClick={() => toggleSort(col)}
    >
      {label}{sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );

  // Totais do rodapé
  const totais = useMemo(() => sorted.reduce((acc, c) => ({
    faturas:       acc.faturas       + (c.total_faturas          ?? 0),
    analisadas:    acc.analisadas    + (c.faturas_analisadas      ?? 0),
    nao:           acc.nao           + (c.nao_analisadas          ?? 0),
    anomalias:     acc.anomalias     + (c.anomalias_encontradas   ?? 0),
    confirmados:   acc.confirmados   + (c.casos_confirmados       ?? 0),
    descartados:   acc.descartados   + (c.casos_descartados       ?? 0),
    ressarcimento: acc.ressarcimento + (c.ressarcimento_estimado  ?? 0),
  }), { faturas: 0, analisadas: 0, nao: 0, anomalias: 0, confirmados: 0, descartados: 0, ressarcimento: 0 }), [sorted]);

  const fmtN   = n  => (n ?? 0).toLocaleString('pt-BR');
  const fmtPct = n  => `${(n ?? 0).toFixed(1)}%`;
  const fmtBRL = n  => (n ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // Barra de progresso inline
  const Bar = ({ pct, cor }) => (
    <div className="flex items-center gap-1.5 mt-0.5">
      <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, pct ?? 0)}%`, background: cor }} />
      </div>
      <span className="text-[10px] opacity-50 tabular-nums w-8 text-right">{fmtPct(pct)}</span>
    </div>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Barra superior */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] flex-shrink-0 flex-wrap">
        <input
          type="text"
          placeholder="Buscar cliente..."
          value={busca}
          onChange={e => setBusca(e.target.value)}
          className="text-xs px-2.5 py-1.5 rounded border border-[var(--border)] bg-[var(--panel)] focus:outline-none"
          style={{ width: 200 }}
        />
        <span className="text-xs opacity-40">{sorted.length} cliente{sorted.length !== 1 ? 's' : ''}</span>
        <button
          onClick={fetchClientes}
          disabled={loading}
          className="ml-auto text-xs px-3 py-1.5 rounded font-medium text-white"
          style={{ backgroundColor: '#1e3a5f' }}
        >
          {loading ? '↻ Carregando...' : '↻ Atualizar'}
        </button>
      </div>

      {/* Tabela */}
      <div className="flex-1 overflow-auto">
        {loading && clientes.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-xs opacity-40">Carregando...</div>
        ) : sorted.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-xs opacity-40">
            Nenhum cliente encontrado. Execute o analisar_batch.py primeiro.
          </div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10" style={{ background: 'var(--panel)' }}>
              <tr>
                <th className="px-2 py-2 w-8" style={{ borderBottom: '1px solid var(--border)' }} />
                <ThS col="razao_social"          label="Cliente"               right={false} />
                <ThS col="total_faturas"          label="Faturas"               right={true}  />
                <ThS col="faturas_analisadas"     label="Analisadas"            right={false} />
                <ThS col="nao_analisadas"         label="Não analisadas"        right={false} />
                <ThS col="anomalias_encontradas"  label="Anomalias"             right={true}  />
                <ThS col="casos_confirmados"      label="Confirmados"           right={true}  />
                <ThS col="casos_descartados"      label="Descartados"           right={true}  />
                <ThS col="ressarcimento_estimado" label="Ressarcimento est."    right={true}  />
              </tr>
            </thead>
            <tbody>
              {sorted.map((cl, i) => {
                const clKey = cl.cod_empresa ?? cl.razao_social;
                const isExp = expandedClients.has(clKey);
                const ucData = clienteUCs[clKey];
                const rowBg = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)';
                return (
                  <React.Fragment key={`${cl.cod_empresa}-${i}`}>
                    <tr
                      className="border-b border-[var(--border)] transition-colors cursor-pointer"
                      style={{
                        backgroundColor: rowBg,
                        borderLeft: isExp ? '3px solid #059669' : '3px solid transparent',
                        background: isExp ? 'linear-gradient(90deg, rgba(5,150,105,0.08) 0%, transparent 60%)' : rowBg,
                      }}
                      onClick={() => toggleCliente(cl)}
                      onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.06)'}
                      onMouseLeave={e => e.currentTarget.style.backgroundColor = isExp ? 'linear-gradient(90deg, rgba(5,150,105,0.08) 0%, transparent 60%)' : rowBg}
                    >
                      {/* Expand toggle */}
                      <td className="px-2 py-2 text-center" style={{ color: '#059669', fontSize: 12, opacity: 0.8 }}>
                        {isExp ? '▾' : '▸'}
                      </td>

                      {/* Cliente */}
                      <td className="px-3 py-2 font-medium max-w-[220px] truncate">
                        {cl.razao_social}
                        {cl.cod_empresa != null && (
                          <span className="ml-1.5 text-[10px] opacity-30">#{cl.cod_empresa}</span>
                        )}
                      </td>

                      {/* Total faturas */}
                      <td className="px-3 py-2 text-right tabular-nums opacity-60">
                        {fmtN(cl.total_faturas)}
                      </td>

                      {/* Analisadas com barra */}
                      <td className="px-3 py-2 min-w-[140px]">
                        <span className="font-semibold tabular-nums" style={{ color: '#3b82f6' }}>
                          {fmtN(cl.faturas_analisadas)}
                        </span>
                        <Bar pct={cl.pct_analisadas} cor="#3b82f6" />
                      </td>

                      {/* Não analisadas com barra */}
                      <td className="px-3 py-2 min-w-[140px]">
                        <span className="font-semibold tabular-nums" style={{ color: '#f59e0b' }}>
                          {fmtN(cl.nao_analisadas)}
                        </span>
                        <Bar pct={cl.pct_nao_analisadas} cor="#f59e0b" />
                      </td>

                      {/* Anomalias */}
                      <td className="px-3 py-2 text-right tabular-nums">
                        {(cl.anomalias_encontradas ?? 0) > 0 ? (
                          <span className="px-1.5 py-0.5 rounded text-xs font-semibold"
                            style={{ background: 'rgba(249,115,22,0.15)', color: '#f97316' }}>
                            {fmtN(cl.anomalias_encontradas)}
                          </span>
                        ) : <span className="opacity-25">—</span>}
                      </td>

                      {/* Confirmados */}
                      <td className="px-3 py-2 text-right tabular-nums">
                        {(cl.casos_confirmados ?? 0) > 0 ? (
                          <span className="px-1.5 py-0.5 rounded text-xs font-semibold"
                            style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
                            {fmtN(cl.casos_confirmados)}
                          </span>
                        ) : <span className="opacity-25">—</span>}
                      </td>

                      {/* Descartados */}
                      <td className="px-3 py-2 text-right tabular-nums">
                        {(cl.casos_descartados ?? 0) > 0 ? (
                          <span className="px-1.5 py-0.5 rounded text-xs font-semibold"
                            style={{ background: 'rgba(107,114,128,0.15)', color: '#9ca3af' }}>
                            {fmtN(cl.casos_descartados)}
                          </span>
                        ) : <span className="opacity-25">—</span>}
                      </td>

                      {/* Ressarcimento */}
                      <td className="px-3 py-2 text-right tabular-nums">
                        {(cl.ressarcimento_estimado ?? 0) > 0 ? (
                          <span className="font-semibold" style={{ color: '#10b981' }}>
                            {fmtBRL(cl.ressarcimento_estimado)}
                          </span>
                        ) : <span className="opacity-25">—</span>}
                      </td>
                    </tr>

                    {/* UC child rows */}
                    {isExp && (
                      ucData?.loading ? (
                        <tr key={`${clKey}-loading`} style={{ background: 'rgba(5,150,105,0.04)' }}>
                          <td colSpan={9} className="px-6 py-3 text-xs opacity-40">Carregando UCs...</td>
                        </tr>
                      ) : (ucData?.ucs ?? []).map(uc => (
                        <tr key={`${clKey}-uc-${uc.uc}`}
                          className="border-b border-[var(--border)]"
                          style={{ background: 'rgba(5,150,105,0.04)', borderLeft: '3px solid rgba(5,150,105,0.25)' }}>
                          <td />
                          <td className="px-5 py-1.5 font-mono text-[11px]" style={{ color: '#34d399' }}>
                            {uc.uc}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums opacity-50">{fmtN(uc.total)}</td>
                          <td className="px-3 py-1.5 tabular-nums opacity-50" colSpan={2}>{uc.ultimo_mes || '—'}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {uc.anomalias > 0 ? (
                              <span className="px-1.5 py-0.5 rounded text-[11px] font-semibold"
                                style={{ background: 'rgba(249,115,22,0.15)', color: '#f97316' }}>
                                {fmtN(uc.anomalias)}
                              </span>
                            ) : <span className="opacity-25">—</span>}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {uc.confirmados > 0 ? (
                              <span className="px-1.5 py-0.5 rounded text-[11px] font-semibold"
                                style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
                                {fmtN(uc.confirmados)}
                              </span>
                            ) : <span className="opacity-25">—</span>}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {uc.descartados > 0 ? (
                              <span className="px-1.5 py-0.5 rounded text-[11px]"
                                style={{ background: 'rgba(107,114,128,0.1)', color: '#9ca3af' }}>
                                {fmtN(uc.descartados)}
                              </span>
                            ) : <span className="opacity-25">—</span>}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {uc.ressarcimento > 0 ? (
                              <span style={{ color: '#10b981' }}>{fmtBRL(uc.ressarcimento)}</span>
                            ) : <span className="opacity-25">—</span>}
                          </td>
                        </tr>
                      ))
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>

            {/* Rodapé totalizador */}
            {sorted.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)', background: 'rgba(255,255,255,0.03)' }}>
                  <td />
                  <td className="px-3 py-2 text-xs font-bold opacity-60">
                    Total ({sorted.length} clientes)
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold opacity-60">
                    {fmtN(totais.faturas)}
                  </td>
                  <td className="px-3 py-2 tabular-nums font-semibold" style={{ color: '#3b82f6' }}>
                    {fmtN(totais.analisadas)}
                  </td>
                  <td className="px-3 py-2 tabular-nums font-semibold" style={{ color: '#f59e0b' }}>
                    {fmtN(totais.nao)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold" style={{ color: '#f97316' }}>
                    {fmtN(totais.anomalias)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold" style={{ color: '#ef4444' }}>
                    {fmtN(totais.confirmados)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold opacity-50">
                    {fmtN(totais.descartados)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-bold" style={{ color: '#10b981' }}>
                    {fmtBRL(totais.ressarcimento)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Painel Faturas Analisadas ────────────────────────────────────────────────
function FaturasAnalisadasPanel() {
  const [rows, setRows]             = useState([]);
  const [total, setTotal]           = useState(0);
  const [loading, setLoading]       = useState(false);
  const [empresa, setEmpresa]       = useState('');
  const [anomaliaFiltro, setAnomaliaFiltro] = useState('all'); // 'all' | '1' | '0'
  const [fichasFiltro, setFichasFiltro]     = useState([]); // e.g. ['F01','F03']
  const [search, setSearch]         = useState('');
  const [distribuidora, setDistribuidora]   = useState('');
  const [periodoInicio, setPeriodoInicio]   = useState('');
  const [periodoFim, setPeriodoFim]         = useState('');
  const [page, setPage]             = useState(1);
  const PER_PAGE = 50;

  const [drawerRow, setDrawerRow]   = useState(null); // row with full analise_IA

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, per_page: PER_PAGE };
      if (empresa)        params.empresa        = empresa;
      if (anomaliaFiltro !== 'all') params.anomalia = anomaliaFiltro;
      if (search)         params.search         = search;
      if (distribuidora)  params.distribuidora  = distribuidora;
      if (periodoInicio)  params.periodo_inicio = periodoInicio;
      if (periodoFim)     params.periodo_fim    = periodoFim;
      if (fichasFiltro.length > 0) params.fichas = fichasFiltro.join(',');
      const r = await apiClient.get('/api/v1/faturas/analisadas', { params });
      setRows(r.data?.rows ?? []);
      setTotal(r.data?.total ?? 0);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [empresa, anomaliaFiltro, search, distribuidora, periodoInicio, periodoFim, fichasFiltro, page]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [empresa, anomaliaFiltro, search, distribuidora, periodoInicio, periodoFim, fichasFiltro]);

  const toggleFicha = useCallback((f) => {
    setFichasFiltro(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f]);
  }, []);


  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const fmtMoeda = (v) => v != null ? `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '—';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-[var(--border)] flex-shrink-0">
        <input
          type="text"
          placeholder="Buscar UC / cliente..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--panel)] focus:outline-none"
          style={{ width: 160 }}
        />
        <input
          type="text"
          placeholder="Distribuidora..."
          value={distribuidora}
          onChange={e => setDistribuidora(e.target.value)}
          className="px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--panel)] focus:outline-none"
          style={{ width: 130 }}
        />
        <input
          type="month"
          value={periodoInicio}
          onChange={e => setPeriodoInicio(e.target.value)}
          className="px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--panel)] focus:outline-none"
          title="Período início"
        />
        <span className="text-xs opacity-50">até</span>
        <input
          type="month"
          value={periodoFim}
          onChange={e => setPeriodoFim(e.target.value)}
          className="px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--panel)] focus:outline-none"
          title="Período fim"
        />
        {/* Anomalia toggle */}
        <div className="flex rounded overflow-hidden border border-[var(--border)] text-xs">
          {[['all','Todos'],['1','Anomalia'],['0','Sem anomalia']].map(([v, lbl]) => (
            <button key={v} onClick={() => setAnomaliaFiltro(v)}
              className="px-2 py-1 transition-colors"
              style={anomaliaFiltro === v
                ? { background: v === '1' ? '#ef4444' : v === '0' ? '#10b981' : '#3b82f6', color: '#fff' }
                : { background: 'var(--panel)', color: 'var(--fg)', opacity: 0.7 }
              }
            >{lbl}</button>
          ))}
        </div>
        {/* Fichas filter */}
        <div className="flex gap-1">
          {['F01','F02','F03','F04','F05'].map(f => (
            <button key={f} onClick={() => toggleFicha(f)}
              className="px-2 py-1 rounded text-xs font-semibold border transition-colors"
              style={fichasFiltro.includes(f)
                ? { background: FICHAS.find(x=>x.id===f.toLowerCase().replace('f0','ficha0'))?.cor ?? '#6366f1', color: '#fff', borderColor: 'transparent' }
                : { background: 'var(--panel)', color: 'var(--fg)', borderColor: 'var(--border)', opacity: 0.6 }
              }
            >{f}</button>
          ))}
        </div>
        <button onClick={fetchRows}
          className="ml-auto px-3 py-1 rounded text-xs font-medium"
          style={{ background: '#1e3a5f', color: '#fff' }}
        >Atualizar</button>
      </div>

      {/* Tabela + Drawer */}
      <div className="flex flex-1 overflow-hidden">
        {/* Tabela */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32 opacity-50 text-sm">Carregando...</div>
          ) : rows.length === 0 ? (
            <div className="flex items-center justify-center h-32 opacity-40 text-sm">Nenhuma fatura analisada encontrada</div>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 z-10" style={{ background: 'var(--panel)' }}>
                <tr>
                  {['UC','Cliente','Distribuidora','Mês','Tensão','Valor Fatura','Ressarcimento Est.','Fichas','Score','Anomalia','Aprovado','Analisado em'].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-semibold whitespace-nowrap"
                      style={{ borderBottom: '1px solid var(--border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const score = row.score_anomalia ?? 0;
                  const scoreColor = score >= 70 ? '#ef4444' : score >= 40 ? '#f97316' : score >= 15 ? '#f59e0b' : '#6b7280';
                  const scoreBg   = score >= 70 ? 'rgba(239,68,68,0.12)' : score >= 40 ? 'rgba(249,115,22,0.12)' : score >= 15 ? 'rgba(245,158,11,0.1)' : 'rgba(107,114,128,0.1)';
                  return (
                  <tr key={row.id ?? i}
                    onClick={() => setDrawerRow(row)}
                    className="cursor-pointer transition-colors hover:bg-white/5"
                    style={{
                      borderBottom: '1px solid var(--border)',
                      borderLeft: row.aprovado ? '3px solid #10b981' : '3px solid transparent',
                    }}
                  >
                    <td className="px-3 py-1.5 font-mono">{row.UC ?? '—'}</td>
                    <td className="px-3 py-1.5" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={row.RAZAO_SOCIAL ?? ''}>{row.RAZAO_SOCIAL ?? '—'}</td>
                    <td className="px-3 py-1.5" style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={row.Concessionaria ?? ''}>{row.Concessionaria ?? '—'}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{row.Mes_Ref ?? '—'}</td>
                    <td className="px-3 py-1.5">{row.Tp_Tensao ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmtMoeda(row.RS_Total_Fatura)}</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      {row.valor_ressarcimento_estimado != null && row.valor_ressarcimento_estimado !== 0
                        ? <span className="font-semibold" style={{ color: '#f59e0b' }}>{fmtMoeda(row.valor_ressarcimento_estimado)}</span>
                        : <span className="opacity-40">—</span>}
                    </td>
                    <td className="px-3 py-1.5">
                      {row.ia_fichas_confirmadas
                        ? <FichasBadge raw={row.ia_fichas_confirmadas} />
                        : <span className="opacity-40">—</span>}
                    </td>
                    {/* Score de anomalia */}
                    <td className="px-3 py-1.5 text-center">
                      {score > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="text-xs font-bold tabular-nums rounded px-1.5 py-0.5"
                            style={{ background: scoreBg, color: scoreColor }}>
                            {score}
                          </span>
                          <span className="text-[9px] opacity-30">/100</span>
                        </span>
                      ) : <span className="opacity-25">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      {row.anomalia_encontrada === 1
                        ? <span className="px-1.5 py-0.5 rounded text-xs font-semibold" style={{ backgroundColor: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>Sim</span>
                        : row.anomalia_encontrada === 0
                          ? <span className="px-1.5 py-0.5 rounded text-xs font-semibold" style={{ backgroundColor: 'rgba(16,185,129,0.15)', color: '#10b981' }}>Não</span>
                          : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      {row.aprovado
                        ? <span className="px-1.5 py-0.5 rounded text-xs font-semibold" style={{ backgroundColor: 'rgba(16,185,129,0.15)', color: '#10b981' }}>✓ Aprovado</span>
                        : <span className="opacity-30 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap opacity-60">{row.ia_analisado_em ?? '—'}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Drawer analise_IA */}
        {drawerRow && (
          <div className="flex flex-col border-l border-[var(--border)] flex-shrink-0 overflow-hidden"
            style={{ width: 480 }}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] flex-shrink-0">
              <div>
                <div className="font-semibold text-sm">{drawerRow.UC} · {drawerRow.Mes_Ref}</div>
                <div className="text-xs opacity-60">{drawerRow.RAZAO_SOCIAL}</div>
              </div>
              <button onClick={() => setDrawerRow(null)}
                className="text-lg leading-none opacity-50 hover:opacity-100 px-2">✕</button>
            </div>
            {/* Resumo rápido */}
            <div className="flex gap-3 px-4 py-2 border-b border-[var(--border)] flex-shrink-0 flex-wrap items-center">
              {drawerRow.ia_status && (
                <span className="px-2 py-0.5 rounded text-xs font-semibold"
                  style={{
                    backgroundColor: drawerRow.ia_status === 'CONFIRMADO' ? 'rgba(239,68,68,0.15)' : drawerRow.ia_status === 'INCONCLUSIVO' ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.15)',
                    color: drawerRow.ia_status === 'CONFIRMADO' ? '#ef4444' : drawerRow.ia_status === 'INCONCLUSIVO' ? '#f59e0b' : '#10b981',
                  }}>{drawerRow.ia_status}</span>
              )}
              {drawerRow.ia_fichas_confirmadas && (
                <FichasBadge raw={drawerRow.ia_fichas_confirmadas} />
              )}
              {drawerRow.valor_ressarcimento_estimado != null && drawerRow.valor_ressarcimento_estimado !== 0 && (
                <span className="text-xs font-semibold" style={{ color: '#f59e0b' }}>
                  Ressarc. est.: {fmtMoeda(drawerRow.valor_ressarcimento_estimado)}
                </span>
              )}
              {/* Score */}
              {(() => {
                const sc = drawerRow.score_anomalia ?? 0;
                if (!sc) return null;
                const c = sc >= 70 ? '#ef4444' : sc >= 40 ? '#f97316' : sc >= 15 ? '#f59e0b' : '#6b7280';
                const bg = sc >= 70 ? 'rgba(239,68,68,0.12)' : sc >= 40 ? 'rgba(249,115,22,0.12)' : 'rgba(245,158,11,0.1)';
                return (
                  <span className="ml-auto flex items-center gap-1 text-xs">
                    <span className="opacity-50">Score:</span>
                    <span className="font-bold tabular-nums px-1.5 py-0.5 rounded" style={{ background: bg, color: c }}>
                      {sc}<span className="text-[10px] opacity-40">/100</span>
                    </span>
                  </span>
                );
              })()}
            </div>
            {/* Texto da análise */}
            <div className="flex-1 overflow-auto px-4 py-3">
              {drawerRow.analise_resumo
                ? <pre className="text-xs whitespace-pre-wrap leading-relaxed opacity-90" style={{ fontFamily: 'inherit' }}>{drawerRow.analise_resumo}</pre>
                : <p className="text-xs opacity-40 italic">Texto de análise não disponível</p>
              }
            </div>
            {drawerRow.Link && /^https?:\/\//i.test(String(drawerRow.Link)) && (
              <div className="px-4 py-2 border-t border-[var(--border)] flex-shrink-0">
                <a href={String(drawerRow.Link)} target="_blank" rel="noreferrer"
                  className="text-blue-400 underline hover:text-blue-300 text-xs">
                  Abrir fatura →
                </a>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Paginação */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--border)] flex-shrink-0 text-xs opacity-70">
        <span>{total} fatura{total !== 1 ? 's' : ''} encontrada{total !== 1 ? 's' : ''}</span>
        <div className="flex items-center gap-2">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
            className="px-2 py-0.5 rounded border border-[var(--border)] disabled:opacity-30">‹ Anterior</button>
          <span>Pág. {page} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
            className="px-2 py-0.5 rounded border border-[var(--border)] disabled:opacity-30">Próxima ›</button>
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function NavItem({ id, label, sublabel, icon, cor, active, onClick, badge }) {
  return (
    <button
      onClick={() => onClick(id)}
      title={sublabel ?? label}
      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-all relative overflow-hidden"
      style={active
        ? {
            background: `linear-gradient(135deg, ${cor}22 0%, ${cor}0a 100%)`,
            color: 'var(--fg)',
            boxShadow: `inset 0 0 0 1px ${cor}30`,
          }
        : { color: 'var(--fg)', opacity: 0.5 }
      }
    >
      {active && (
        <span className="absolute left-0 top-2 bottom-2 w-[2.5px] rounded-r-full"
          style={{ background: `linear-gradient(180deg, ${cor}, ${cor}88)` }} />
      )}
      {/* Ícone */}
      <span className="flex-shrink-0 flex items-center justify-center"
        style={{ width: 26, height: 26 }}>
        {icon}
      </span>
      {/* Texto */}
      <span className="flex-1 min-w-0">
        <span className={`block text-[12.5px] leading-tight truncate ${active ? 'font-semibold' : 'font-medium'}`}
          style={{ fontFamily: "'Syne', system-ui, sans-serif", letterSpacing: active ? '-0.01em' : '0' }}>
          {label}
        </span>
        {sublabel && (
          <span className="block text-[10px] leading-tight truncate mt-0.5 opacity-40"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {sublabel}
          </span>
        )}
      </span>
      {/* Badge de contagem */}
      {badge != null && badge > 0 && (
        <span className="flex-shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded leading-none"
          style={{
            background: active ? `${cor}30` : 'rgba(255,255,255,0.06)',
            color: active ? cor : 'rgba(255,255,255,0.4)',
            fontFamily: "'JetBrains Mono', monospace",
            border: `1px solid ${active ? cor + '40' : 'rgba(255,255,255,0.08)'}`,
          }}>
          {Number(badge) > 9999 ? `${Math.round(Number(badge)/1000)}k` : Number(badge).toLocaleString('pt-BR')}
        </span>
      )}
    </button>
  );
}

function NavSection({ label }) {
  return (
    <div className="px-2.5 pt-5 pb-1.5 flex items-center gap-2">
      <span style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '9px',
        fontWeight: 700,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        opacity: 0.3,
      }}>{label}</span>
      <span className="flex-1 h-px" style={{ background: 'linear-gradient(90deg, rgba(255,255,255,0.12), transparent)' }} />
    </div>
  );
}

// Ícone quadrado colorido para fichas
function FichaIcon({ cor, num }) {
  return (
    <span className="flex items-center justify-center rounded text-white leading-none"
      style={{
        width: 22,
        height: 22,
        background: `linear-gradient(135deg, ${cor}, ${cor}bb)`,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '10px',
        fontWeight: 800,
        boxShadow: `0 1px 4px ${cor}44`,
      }}>
      {num}
    </span>
  );
}

export default function AnaliseDesvio() {
  const [activeTab, setActiveTab] = useState('por-uc');
  const [ucsEmProcesso, setUcsEmProcesso] = useState([]);
  const [fichaCounts, setFichaCounts] = useState({});

  const refreshUcsEmProcesso = useCallback(() => {
    apiClient.get('/api/v1/faturas/ucs-em-processo')
      .then(r => setUcsEmProcesso(r.data?.ucs ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => { refreshUcsEmProcesso(); }, [refreshUcsEmProcesso]);

  useEffect(() => {
    apiClient.get('/api/v1/faturas/ficha/resumo')
      .then(r => {
        const c = {};
        (r.data?.fichas ?? []).forEach(f => { c[f.key] = f.total; });
        setFichaCounts(c);
      })
      .catch(() => {});
  }, []);

  const handleSelectTab = useCallback((id) => setActiveTab(id), []);

  return (
    <div className="flex h-full overflow-hidden" style={{ fontFamily: "'Syne', 'JetBrains Mono', system-ui, sans-serif" }}>
      {/* Google Fonts: Syne + JetBrains Mono */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        .adv-thead-row th { font-family: 'Syne', system-ui, sans-serif !important; }
        .adv-data-cell { font-family: 'JetBrains Mono', monospace !important; }
        .adv-sidebar-brand { font-family: 'Syne', system-ui, sans-serif !important; }
        .adv-row-hover:hover { background: rgba(255,255,255,0.035) !important; }
      `}</style>

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <aside className="flex flex-col flex-shrink-0 overflow-y-auto overflow-x-hidden"
        style={{
          width: 214,
          borderRight: '1px solid var(--border)',
          background: 'var(--panel)',
        }}>

        {/* Cabeçalho com gradiente */}
        <div className="px-3 py-4 relative overflow-hidden" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          {/* Accent glow */}
          <div className="absolute inset-0 pointer-events-none" style={{
            background: 'linear-gradient(135deg, rgba(37,99,235,0.12) 0%, transparent 60%)',
          }} />
          <div className="flex items-center gap-2.5 relative">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0"
              style={{
                background: 'linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%)',
                boxShadow: '0 2px 8px rgba(37,99,235,0.35)',
              }}>
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            </span>
            <div className="adv-sidebar-brand">
              <div className="text-[13.5px] font-bold leading-tight" style={{ letterSpacing: '-0.02em' }}>Análise de Desvio</div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '9px', opacity: 0.35, marginTop: 2, letterSpacing: '0.05em' }}>
                AUDITORIA · FATURAS
              </div>
            </div>
          </div>

          {/* Badge UCs em processo */}
          {ucsEmProcesso.length > 0 && (
            <div className="mt-3 flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[10.5px] font-medium relative"
              style={{ background: 'rgba(37,99,235,0.1)', color: '#93c5fd', border: '1px solid rgba(37,99,235,0.2)' }}>
              <span className="w-1.5 h-1.5 rounded-full animate-pulse flex-shrink-0"
                style={{ background: '#60a5fa' }} />
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                {ucsEmProcesso.length} UCs em processo
              </span>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 px-1.5 pb-4">

          <NavSection label="Visão Geral" />
          <NavItem
            id="resumo" label="Resumo" sublabel="painel consolidado"
            cor="#2563eb" active={activeTab === 'resumo'} onClick={handleSelectTab}
            icon={
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
                  d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>
              </svg>
            }
          />

          <NavSection label="Análise por UC" />
          <NavItem
            id="por-uc" label="Por UC" sublabel="histórico completo"
            cor="#0ea5e9" active={activeTab === 'por-uc'} onClick={handleSelectTab}
            icon={
              <span className="flex items-center justify-center rounded"
                style={{ width: 22, height: 22, background: 'rgba(14,165,233,0.2)' }}>
                <svg className="w-3 h-3" fill="none" stroke="#38bdf8" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
                </svg>
              </span>
            }
          />

          <NavSection label="Auditoria IA" />
          <NavItem
            id="analisadas" label="Faturas Analisadas" sublabel="auditadas pelo modelo"
            cor="#7c3aed" active={activeTab === 'analisadas'} onClick={handleSelectTab}
            icon={
              <span className="flex items-center justify-center rounded"
                style={{ width: 22, height: 22, background: 'rgba(124,58,237,0.25)' }}>
                <svg className="w-3 h-3" fill="none" stroke="#a78bfa" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/>
                </svg>
              </span>
            }
          />
          <NavItem
            id="auditoria-ia" label="Por Cliente" sublabel="resumo por empresa"
            cor="#059669" active={activeTab === 'auditoria-ia'} onClick={handleSelectTab}
            icon={
              <span className="flex items-center justify-center rounded"
                style={{ width: 22, height: 22, background: 'rgba(5,150,105,0.2)' }}>
                <svg className="w-3 h-3" fill="none" stroke="#34d399" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
              </span>
            }
          />
        </nav>

        {/* Rodapé */}
        <div className="px-3 py-2.5 flex items-center gap-2" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <svg className="w-3 h-3 opacity-25 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path d="M3 12v3c0 1.657 3.134 3 7 3s7-1.343 7-3v-3c0 1.657-3.134 3-7 3s-7-1.343-7-3z"/>
            <path d="M3 7v3c0 1.657 3.134 3 7 3s7-1.343 7-3V7c0 1.657-3.134 3-7 3S3 8.657 3 7z"/>
            <path d="M17 5c0 1.657-3.134 3-7 3S3 6.657 3 5s3.134-3 7-3 7 1.343 7 3z"/>
          </svg>
          <span className="truncate opacity-25" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '9px', letterSpacing: '0.04em' }}>
            sgeeasy_clientes_novo
          </span>
        </div>
      </aside>

      {/* ── Conteúdo ────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden flex flex-col min-w-0">

        {/* Header da seção ativa */}
        <div className="flex items-center gap-3 px-5 py-2.5 flex-shrink-0 relative overflow-hidden"
          style={{ borderBottom: '1px solid var(--border)', background: 'var(--panel)' }}>
          {/* Subtle accent bar at the top */}
          <div className="absolute top-0 left-0 right-0 h-[2px]"
            style={{
              background: activeTab === 'por-uc'
                ? 'linear-gradient(90deg, #0ea5e9, #0ea5e944, transparent)'
                : activeTab === 'auditoria-ia'
                ? 'linear-gradient(90deg, #059669, #05966944, transparent)'
                : activeTab === 'analisadas'
                ? 'linear-gradient(90deg, #7c3aed, #7c3aed44, transparent)'
                : 'linear-gradient(90deg, #2563eb, #2563eb44, transparent)',
            }} />
          {activeTab === 'resumo' ? (
            <>
              <span className="flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0"
                style={{ background: 'rgba(37,99,235,0.15)' }}>
                <svg className="w-4 h-4" fill="none" stroke="#60a5fa" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
                    d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>
                </svg>
              </span>
              <div>
                <div className="text-[13px] font-bold leading-tight" style={{ fontFamily: "'Syne', system-ui", letterSpacing: '-0.02em' }}>Resumo</div>
                <div className="leading-tight mt-0.5 opacity-35" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px' }}>PAINEL CONSOLIDADO</div>
              </div>
            </>
          ) : activeTab === 'analisadas' ? (
            <>
              <span className="flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0"
                style={{ background: 'rgba(124,58,237,0.15)' }}>
                <svg className="w-4 h-4" fill="none" stroke="#a78bfa" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/>
                </svg>
              </span>
              <div>
                <div className="text-[13px] font-bold leading-tight" style={{ fontFamily: "'Syne', system-ui", letterSpacing: '-0.02em' }}>Faturas Analisadas</div>
                <div className="leading-tight mt-0.5 opacity-35" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px' }}>AUDITADAS PELO MODELO</div>
              </div>
            </>
          ) : activeTab === 'por-uc' ? (
            <>
              <span className="flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0"
                style={{ background: 'rgba(14,165,233,0.15)' }}>
                <svg className="w-4 h-4" fill="none" stroke="#38bdf8" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
                    d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
                </svg>
              </span>
              <div>
                <div className="text-[13px] font-bold leading-tight" style={{ fontFamily: "'Syne', system-ui", letterSpacing: '-0.02em' }}>Por UC</div>
                <div className="leading-tight mt-0.5 opacity-35" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px' }}>1 LINHA POR UNIDADE · HISTÓRICO COMPLETO</div>
              </div>
            </>
          ) : (
            <>
              <span className="flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0"
                style={{ background: 'rgba(5,150,105,0.15)' }}>
                <svg className="w-4 h-4" fill="none" stroke="#34d399" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
              </span>
              <div>
                <div className="text-[13px] font-bold leading-tight" style={{ fontFamily: "'Syne', system-ui", letterSpacing: '-0.02em' }}>Por Cliente</div>
                <div className="leading-tight mt-0.5 opacity-35" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px' }}>RESUMO POR EMPRESA</div>
              </div>
            </>
          )}
        </div>

        {/* Painel ativo */}
        <div className="flex-1 overflow-hidden">
          {activeTab === 'resumo' ? (
            <div className="h-full overflow-auto">
              <ResumoPanel onSelectTab={handleSelectTab} />
            </div>
          ) : activeTab === 'por-uc' ? (
            <div className="h-full overflow-hidden">
              <UCResumoPanel />
            </div>
          ) : activeTab === 'auditoria-ia' ? (
            <div className="h-full overflow-hidden">
              <ClientesIAPanel />
            </div>
          ) : activeTab === 'analisadas' ? (
            <div className="h-full overflow-hidden">
              <FaturasAnalisadasPanel />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
