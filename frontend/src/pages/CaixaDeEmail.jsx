import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  Archive,
  FileText,
  Forward,
  Inbox,
  Mail,
  MailOpen,
  Paperclip,
  Reply,
  ReplyAll,
  Search,
  Send,
  Trash2,
  Filter,
  RefreshCw,
  Link2,
  Download,
  MessagesSquare,
  Minus,
  AlertTriangle,
  Clock,
  X,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import {
  downloadMailAttachment,
  forwardMailMessage,
  getMailAttachments,
  getMailFolders,
  getMailMessage,
  getMailMessages,
  linkMailToProcess,
  moveMailMessage,
  analyzeMailMessage,
  replyAllMailMessage,
  replyMailMessage,
  searchMailProcesses,
  sendMailMessage,
  setMailReadLocal,
  setMailUnreadLocal,
} from '../services/mailService';
import { withAuthToken } from '../services/apiClient';
import { useAuth } from '../context/AuthContext.jsx';
import { getEtapaSubMap } from '../services/filtersService';
import { getHistoricoById, movimentarProcesso } from '../services/requisicaoService';
import Toast from '../components/Toast';

const POLL_MS = 120_000;
const PAGE_SIZE = 500;
const REQUEST_PAGE_SIZE = Math.min(PAGE_SIZE, 200);

const cx = (...arr) => arr.filter(Boolean).join(' ');

const folderLabel = (name) => {
  const raw = String(name || '').trim();
  const s = raw.toLowerCase();
  if (s.includes('conversation history')) return { icon: FileText, label: 'Histórico de Conversas' };
  if (s.includes('faturas recebidas')) return { icon: FileText, label: 'Faturas Recebidas' };
  if (s.includes('resposta automatica') || s.includes('resposta automática')) {
    return { icon: FileText, label: 'Resposta automática' };
  }
  if (s.includes('itens enviados')) return { icon: Send, label: 'Itens Enviados' };
  if (s.includes('items deletados') || s.includes('itens deletados')) return { icon: Trash2, label: 'Itens Deletados' };
  if (s.includes('inbox') || s.includes('entrada')) return { icon: Inbox, label: 'Caixa de Entrada' };
  if (s.includes('sent') || s.includes('enviado')) return { icon: Send, label: 'Itens Enviados' };
  if (s.includes('draft') || s.includes('rascun')) return { icon: FileText, label: 'Rascunhos' };
  if (s.includes('archive') || s.includes('arquiv')) return { icon: Archive, label: 'Arquivados' };
  if (s.includes('junk') || s.includes('spam') || s.includes('lixo eletr?nico') || s.includes('lixo/spam')) {
    return { icon: Trash2, label: 'Lixo/Spam' };
  }
  if (s.includes('deleted') || s.includes('exclu')) return { icon: Trash2, label: 'Itens Deletados' };
  if (s.includes('outbox') || s.includes('caixa de sa?da')) return { icon: Send, label: 'Caixa de Saída' };
  return { icon: Mail, label: raw || 'Caixa' };
};

const dedupeFoldersByLabel = (items) => {
  const seen = new Set();
  const result = [];
  for (const folder of items || []) {
    const label = folderLabel(folder?.display_name).label;
    if (seen.has(label)) continue;
    seen.add(label);
    result.push(folder);
  }
  return result;
};

const sortFoldersForUi = (items) => {
  const list = [...(items || [])];
  list.sort((a, b) => {
    const aLabel = folderLabel(a?.display_name).label;
    const bLabel = folderLabel(b?.display_name).label;
    if (aLabel === 'Caixa de Entrada' && bLabel !== 'Caixa de Entrada') return -1;
    if (bLabel === 'Caixa de Entrada' && aLabel !== 'Caixa de Entrada') return 1;
    return aLabel.localeCompare(bLabel, 'pt-BR', { sensitivity: 'base' });
  });
  return list;
};

const formatDate = (iso) => {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
};

const formatDateTimeBR = (value) => {
  if (!value) return '';
  const raw = String(value).trim();
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return raw;
  return dt.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
};

const pick = (obj, keys, fallback = '') => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return fallback;
};

const downloadBlob = async (resp, filename) => {
  const url = window.URL.createObjectURL(resp.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  a.click();
  window.URL.revokeObjectURL(url);
};

const initials = (nameOrEmail = '') => {
  const s = String(nameOrEmail || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
};

// Paleta determinística para avatares — tons coordenados com tema escuro
const AVATAR_PALETTE = [
  { bg: 'bg-blue-500/30', ring: 'ring-blue-400/40', text: 'text-blue-100' },
  { bg: 'bg-emerald-500/30', ring: 'ring-emerald-400/40', text: 'text-emerald-100' },
  { bg: 'bg-amber-500/30', ring: 'ring-amber-400/40', text: 'text-amber-100' },
  { bg: 'bg-rose-500/30', ring: 'ring-rose-400/40', text: 'text-rose-100' },
  { bg: 'bg-violet-500/30', ring: 'ring-violet-400/40', text: 'text-violet-100' },
  { bg: 'bg-cyan-500/30', ring: 'ring-cyan-400/40', text: 'text-cyan-100' },
  { bg: 'bg-fuchsia-500/30', ring: 'ring-fuchsia-400/40', text: 'text-fuchsia-100' },
  { bg: 'bg-lime-500/30', ring: 'ring-lime-400/40', text: 'text-lime-100' },
];

const avatarColorFor = (str = '') => {
  const s = String(str || '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
};

// Bucket de datas para sticky headers ("Hoje", "Ontem", etc.)
const dateBucketOf = (iso) => {
  if (!iso) return 'mais-antigos';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return 'mais-antigos';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - 6);
  if (dt >= startOfToday) return 'hoje';
  if (dt >= startOfYesterday) return 'ontem';
  if (dt >= startOfWeek) return 'esta-semana';
  return 'mais-antigos';
};

const DATE_BUCKET_LABEL = {
  hoje: 'Hoje',
  ontem: 'Ontem',
  'esta-semana': 'Esta semana',
  'mais-antigos': 'Mais antigos',
};

const DATE_BUCKET_ORDER = ['hoje', 'ontem', 'esta-semana', 'mais-antigos'];

// Formata tamanho de arquivo em humano-legível
const formatFileSize = (bytes) => {
  if (bytes == null || Number.isNaN(Number(bytes))) return '';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

// Mapeia extensão/MIME → tom + label para card de anexo
const attachmentMetaFor = (att) => {
  const name = String(att?.name || '').toLowerCase();
  const ct = String(att?.content_type || '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  if (ct.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
    return { tone: 'bg-blue-500/20 text-blue-200 border-blue-500/30', label: 'Imagem', short: ext.toUpperCase() || 'IMG' };
  }
  if (ct === 'application/pdf' || ext === 'pdf') {
    return { tone: 'bg-rose-500/20 text-rose-200 border-rose-500/30', label: 'PDF', short: 'PDF' };
  }
  if (['xls', 'xlsx', 'csv'].includes(ext) || ct.includes('spreadsheet') || ct.includes('excel')) {
    return { tone: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30', label: 'Planilha', short: ext.toUpperCase() };
  }
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext) || ct.includes('word')) {
    return { tone: 'bg-sky-500/20 text-sky-200 border-sky-500/30', label: 'Documento', short: ext.toUpperCase() };
  }
  if (['ppt', 'pptx'].includes(ext) || ct.includes('presentation')) {
    return { tone: 'bg-amber-500/20 text-amber-200 border-amber-500/30', label: 'Apresentação', short: ext.toUpperCase() };
  }
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(ext)) {
    return { tone: 'bg-violet-500/20 text-violet-200 border-violet-500/30', label: 'Arquivo', short: ext.toUpperCase() };
  }
  if (['txt', 'md', 'log'].includes(ext) || ct.startsWith('text/')) {
    return { tone: 'bg-slate-500/20 text-slate-200 border-slate-500/30', label: 'Texto', short: ext.toUpperCase() || 'TXT' };
  }
  return { tone: 'bg-[var(--muted)]/30 text-[var(--fg)] border-[var(--border)]/40', label: 'Arquivo', short: (ext || 'FILE').toUpperCase().slice(0, 4) };
};

const QUILL_MODULES = {
  toolbar: [
    [{ font: [] }, { size: [] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ color: [] }, { background: [] }],
    [{ list: 'ordered' }, { list: 'bullet' }, { indent: '-1' }, { indent: '+1' }],
    [{ align: [] }],
    ['link'],
    ['clean'],
  ],
};

const SIGNATURE_HTML =
  '<br/><br/><img src="/assinatura_complaint.png" alt="assinatura" style="max-width:260px;height:auto;" />';

const withSignature = (html) =>
  html && html.includes('assinatura_complaint.png') ? html : `${html || ''}${SIGNATURE_HTML}`;

// remove prefixos Re:, Fw:, Enc: repetidos e normaliza
const normalizeSubject = (subj = '') => {
  let s = String(subj || '').trim();
  if (!s) return '';
  // remove prefixos comuns (re/fw/enc) repetidas
  for (let i = 0; i < 10; i++) {
    const prev = s;
    s = s.replace(/^\s*(re|fw|fwd|enc)\s*:\s*/i, '').trim();
    if (s === prev) break;
  }
  return s.toLowerCase();
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sanitizeEmailHtml = (html) =>
  String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/<base[^>]*>/gi, '');

const normalizeEmailBody = (raw) => {
  const s = String(raw || '');
  if (!s) return '';
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(s);
  if (looksLikeHtml) return sanitizeEmailHtml(s);
  const escaped = escapeHtml(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const linkified = escaped.replace(
    /(https?:\/\/[^\s<>"')\]]+)/gi,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  return linkified
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br />')}</p>`)
    .join('');
};

const KANBAN_COLUNAS = [
  'Ativos',
  'Deferidos',
  'Fluxo de Ressarcimento',
  'Faturamento',
  'Concluídos',
  'Indeferidos',
  'Suspensos',
];

const MAPA_COLUNAS_PARA_ETAPAS = {
  Ativos: 'Andamento',
  Deferidos: 'Pendente',
  'Fluxo de Ressarcimento': 'Valida??o',
  Faturamento: 'Ressarcimento',
  'Concluídos': 'Concluídos',
  Indeferidos: 'Indeferido',
  Suspensos: 'Suspenso',
};

/* =========================
   UI helpers
========================= */
const Chip = ({ children, tone = 'neutral', className = '', forceTextBlack = false }) => {
  const toneCls =
    tone === 'info'
      ? 'bg-blue-500/15 text-blue-200 border-blue-500/20'
      : tone === 'success'
      ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/20'
      : tone === 'warn'
      ? 'bg-amber-500/15 text-amber-200 border-amber-500/20'
      : tone === 'danger'
      ? 'bg-rose-500/15 text-rose-200 border-rose-500/20'
      : 'bg-[var(--muted)]/25 text-[var(--fg)] border-[var(--border)]/40';

  const style = forceTextBlack ? { color: '#000' } : undefined;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] leading-none',
        toneCls,
        className,
      )}
      style={style}
    >
      {children}
    </span>
  );
};

const IconBtn = ({ onClick, disabled, title, children, className = '' }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    disabled={disabled}
    className={cx(
      'inline-flex items-center justify-center rounded-lg border panel-border bg-[var(--panel)]/40 hover:bg-[var(--panel)] transition',
      'h-9 w-9 disabled:opacity-40 disabled:cursor-not-allowed',
      className
    )}
  >
    {children}
  </button>
);

const SkeletonRow = () => (
  <div className="p-3 border-b panel-border">
    <div className="flex items-center gap-3">
      <div className="h-9 w-9 rounded-full bg-[var(--muted)]/40 animate-pulse" />
      <div className="flex-1 space-y-2">
        <div className="h-3 w-2/3 bg-[var(--muted)]/40 rounded animate-pulse" />
        <div className="h-3 w-1/2 bg-[var(--muted)]/30 rounded animate-pulse" />
        <div className="h-2 w-5/6 bg-[var(--muted)]/25 rounded animate-pulse" />
      </div>
    </div>
  </div>
);

const Resizer = ({ onPointerDown }) => (
  <div
    role="separator"
    title="Arraste para redimensionar"
    onPointerDown={onPointerDown}
    style={{ touchAction: 'none' }}
    className={cx(
      'w-2 cursor-col-resize select-none',
      'bg-transparent hover:bg-blue-500/15 active:bg-blue-500/25'
    )}
  />
);

/* =========================
   MODALS (mant?m l?gica)
========================= */
const COMPOSE_QUILL_MODULES = {
  toolbar: [
    [{ font: [] }, { size: ['small', false, 'large', 'huge'] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ color: [] }, { background: [] }],
    [{ list: 'ordered' }, { list: 'bullet' }, { indent: '-1' }, { indent: '+1' }],
    [{ align: [] }],
    ['link', 'image'],
    ['clean'],
  ],
  clipboard: { matchVisual: false },
};

const ComposeModal = ({ open, minimized, onMinimize, onClose, onSend, seed }) => {
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [showCcBcc, setShowCcBcc] = useState(false);
  const fileRef  = useRef(null);
  const quillRef = useRef(null);

  // Paste images inline (like Outlook)
  useEffect(() => {
    const quill = quillRef.current?.getEditor();
    if (!quill || !open || minimized) return;
    const root = quill.root;
    const handlePaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = (evt) => {
            const range = quill.getSelection(true);
            quill.insertEmbed(range?.index ?? 0, 'image', evt.target.result);
            quill.setSelection((range?.index ?? 0) + 1);
          };
          reader.readAsDataURL(file);
          break;
        }
      }
    };
    root.addEventListener('paste', handlePaste);
    return () => root.removeEventListener('paste', handlePaste);
  }, [open, minimized]);

  useEffect(() => {
    if (!open) return;
    setTo(seed?.to || '');
    setCc(seed?.cc || '');
    setBcc(seed?.bcc || '');
    setSubject(seed?.subject || '');
    setBody(withSignature(seed?.body || ''));
    setFiles([]);
    setSending(false);
    setShowCcBcc(!!(seed?.cc || seed?.bcc));
  }, [open, seed]);

  if (!open || minimized) return null;

  const handleSendClick = async () => {
    setSending(true);
    await onSend({ to, cc, bcc, subject, body, files });
    setSending(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ paddingRight: '1.5rem', paddingBottom: 0 }}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative z-10 flex flex-col rounded-2xl shadow-2xl overflow-hidden"
        style={{
          width: 680,
          height: '88vh',
          maxHeight: 720,
          border: '1px solid var(--border)',
          background: 'var(--bg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header gradient ── */}
        <div
          className="flex items-center justify-between px-5 py-3 flex-shrink-0 select-none"
          style={{ background: 'linear-gradient(135deg, #1e3a5f, #0f2340)' }}
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
              <Send size={15} className="text-blue-300" />
            </div>
            <div>
              <div className="text-white text-sm font-semibold">Novo e-mail</div>
              <div className="text-white/50 text-[11px]">
                {subject ? subject : 'Sem assunto'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onMinimize}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              title="Minimizar"
              type="button"
            >
              <Minus size={13} />
            </button>
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              title="Fechar"
              type="button"
            >
              <X size={13} />
            </button>
          </div>
        </div>

        {/* ── Campos ── */}
        <div className="flex-shrink-0 border-b" style={{ borderColor: 'var(--border)' }}>
          {/* Para */}
          <div className="flex items-center border-b px-4" style={{ borderColor: 'var(--border)' }}>
            <span className="text-xs opacity-40 w-16 flex-shrink-0">Para</span>
            <input
              className="flex-1 py-2 text-xs bg-transparent focus:outline-none"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="destinatario@email.com; outro@email.com"
            />
            <button
              type="button"
              className="text-[11px] opacity-50 hover:opacity-90 px-2 py-1 shrink-0 flex items-center gap-1 transition-opacity"
              onClick={() => setShowCcBcc((v) => !v)}
            >
              {showCcBcc ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              Cc/Cco
            </button>
          </div>

          {/* Cc / Cco — colapsável */}
          {showCcBcc && (
            <>
              <div className="flex items-center border-b px-4" style={{ borderColor: 'var(--border)' }}>
                <span className="text-xs opacity-40 w-16 flex-shrink-0">Cc</span>
                <input
                  className="flex-1 py-2 text-xs bg-transparent focus:outline-none"
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  placeholder="copia@email.com"
                />
              </div>
              <div className="flex items-center border-b px-4" style={{ borderColor: 'var(--border)' }}>
                <span className="text-xs opacity-40 w-16 flex-shrink-0">Cco</span>
                <input
                  className="flex-1 py-2 text-xs bg-transparent focus:outline-none"
                  value={bcc}
                  onChange={(e) => setBcc(e.target.value)}
                  placeholder="cco@email.com"
                />
              </div>
            </>
          )}

          {/* Assunto */}
          <div className="flex items-center px-4">
            <span className="text-xs opacity-40 w-16 flex-shrink-0">Assunto</span>
            <input
              className="flex-1 py-2 text-xs bg-transparent focus:outline-none font-medium"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Assunto do e-mail"
            />
          </div>
        </div>

        {/* ── Editor ── */}
        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
          <ReactQuill
            ref={quillRef}
            theme="snow"
            value={body}
            onChange={setBody}
            modules={COMPOSE_QUILL_MODULES}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            className="flex-1 text-xs"
          />
        </div>

        {/* ── Rodapé ── */}
        <div
          className="flex items-center justify-between gap-2 px-4 py-2.5 border-t flex-shrink-0"
          style={{ borderColor: 'var(--border)', background: 'var(--panel-bg, rgba(255,255,255,0.03))' }}
        >
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => setFiles(Array.from(e.target.files || []))}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border hover:opacity-90 transition-opacity"
              style={{ borderColor: 'var(--border)' }}
            >
              <Paperclip size={13} />
              {files.length > 0 ? `${files.length} arquivo(s)` : 'Anexar'}
            </button>
          </div>

          <button
            type="button"
            onClick={handleSendClick}
            disabled={sending || !to.trim()}
            className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-white text-sm font-semibold disabled:opacity-50 transition-all"
            style={{ backgroundColor: '#1d4ed8' }}
          >
            {sending ? (
              <>
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Enviando...
              </>
            ) : (
              <>
                <Send size={14} />
                Enviar
              </>
            )}
          </button>
        </div>
      </div>

    </div>
  );
};

const ReplyForwardModal = ({ open, mode, onClose, onSend }) => {
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    if (!open) return;
    setTo('');
    setBody('');
  }, [open, mode]);

  if (!open) return null;
  const isForward = mode === 'forward';
  const title = isForward ? 'Encaminhar e-mail' : mode === 'replyAll' ? 'Responder a todos' : 'Responder e-mail';

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="sap-card w-full max-w-3xl p-4 md:p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-lg font-bold">{title}</div>
          <button className="btn-outline" onClick={onClose} type="button">
            Fechar
          </button>
        </div>

        <div className="space-y-2">
          {isForward && (
            <input
              className="input-themed w-full"
              placeholder="Para (separe com ;)"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          )}
          <ReactQuill
            theme="snow"
            value={body}
            onChange={setBody}
            modules={QUILL_MODULES}
            className="bg-[var(--panel)] text-[var(--fg)] rounded border panel-border"
          />
          <div className="rounded border panel-border bg-[var(--panel)]/20 p-2 text-xs">
            <div className="text-[11px] uppercase font-semibold opacity-70 mb-1">Assinatura fixa</div>
            <img src="/assinatura_complaint.png" alt="assinatura" className="max-w-[260px] h-auto" />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button className="btn-outline" onClick={onClose} type="button">
            Cancelar
          </button>
          <button className="btn-themed" onClick={() => onSend({ to, body })} type="button">
            Enviar
          </button>
        </div>
      </div>
      {/* eslint-disable no-undef */}
      <ProcessHistoryModal
        open={historyOpen}
        loading={historyLoading}
        items={historyItems}
        processoId={historyPid}
        onClose={() => setHistoryOpen(false)}
      />
      {/* eslint-enable no-undef */}
    </div>
  );
};

const MailAIModal = ({ open, loading, result, error, onClose, onUseDraft }) => {
  if (!open) return null;
  const passos = Array.isArray(result?.proximos_passos) ? result.proximos_passos : [];
  const assunto = result?.sugestao_email?.assunto || '';
  const corpo = result?.sugestao_email?.corpo || '';
  return (
    <div className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="sap-card w-full max-w-4xl p-4 md:p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-lg font-bold">An?lise com IA</div>
          <button className="btn-outline" onClick={onClose} type="button">
            Fechar
          </button>
        </div>

        {loading && <div className="text-sm opacity-70">Analisando...</div>}
        {error && !loading && (
          <div className="text-sm text-rose-300">{error}</div>
        )}
        {!loading && !error && (
          <div className="space-y-4">
            {result?.resumo && (
              <div>
                <div className="text-sm font-semibold mb-1">Resumo</div>
                <div className="text-sm whitespace-pre-wrap">{result.resumo}</div>
              </div>
            )}
            {result?.avaliacao && (
              <div>
                <div className="text-sm font-semibold mb-1">Avalia??o</div>
                <div className="text-sm whitespace-pre-wrap">{result.avaliacao}</div>
              </div>
            )}
            {passos.length > 0 && (
              <div>
                <div className="text-sm font-semibold mb-1">Pr?ximos passos</div>
                <ul className="list-disc pl-5 text-sm space-y-1">
                  {passos.map((p, idx) => (
                    <li key={`passo-${idx}`}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
            {(assunto || corpo) && (
              <div className="rounded-xl border panel-border bg-[var(--panel)]/20 p-3">
                <div className="text-sm font-semibold mb-2">Sugest?o de e-mail</div>
                {assunto && (
                  <div className="text-sm mb-2">
                    <span className="opacity-70">Assunto:</span> {assunto}
                  </div>
                )}
                {corpo && <div className="text-sm whitespace-pre-wrap">{corpo}</div>}
                <div className="mt-3 flex justify-end">
                  <button
                    className="btn-themed"
                    type="button"
                    onClick={() => onUseDraft({ assunto, corpo })}
                  >
                    Escrever e-mail
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const ProcessHistoryModal = ({ open, loading, items, processoId, onClose }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="sap-card w-full max-w-3xl p-4 md:p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-lg font-bold">Histórico do processo #{processoId}</div>
          <button className="btn-outline" onClick={onClose} type="button">
            Fechar
          </button>
        </div>

        {loading ? (
          <div className="text-sm opacity-70">Carregando...</div>
        ) : items.length === 0 ? (
          <div className="text-sm opacity-70">Nenhum histórico encontrado.</div>
        ) : (
          <div className="space-y-3 max-h-[60vh] overflow-auto pr-1">
            {items.map((h, idx) => {
              const dt = formatDateTimeBR(
                pick(h, ['hist_data', 'data_movimentacao', 'data', 'created_at'], ''),
              );
              const etapa = pick(h, ['etapa_nova', 'etapa', 'Etapa'], '-');
              const sub = pick(h, ['sub_etapa', 'SubEtapa'], '-');
              const comentario = pick(h, ['hist_comentario', 'comentario'], '-');
              const usuario = pick(h, ['usuario_nome', 'nome_usuario', 'user_name', 'userName', 'usuario'], '');
              const canais =
                Array.isArray(h.canais) && h.canais.length
                  ? h.canais.join(', ')
                  : pick(h, ['canal_comunicacao'], '');
              const anexos = Array.isArray(h.anexos) ? h.anexos : [];
              return (
                <div key={`hist-modal-${idx}`} className="rounded-xl border panel-border bg-[var(--panel)]/25 p-3">
                  <div className="text-xs opacity-70">
                    {dt}
                    {usuario ? ` ??" Usu?rio: ${usuario}` : ''}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <span className="sap-chip">{etapa}</span>
                    <span className="text-xs opacity-70">Sub-etapa: {sub}</span>
                    {canais ? <span className="sap-chip">{canais}</span> : null}
                  </div>
                  <div className="text-sm mt-2 whitespace-pre-wrap border-t panel-border pt-2">
                    {comentario}
                  </div>
                  {canais ? (
                    <div className="text-xs opacity-70 mt-2">
                      Canais: <span className="font-medium">{canais}</span>
                    </div>
                  ) : null}
                  {anexos.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {anexos.map((a, aIdx) => {
                        const nome = a?.nome || a?.nome_arquivo || `Anexo ${aIdx + 1}`;
                        const path = String(a?.url || a?.caminho_arquivo || '').trim();
                        const href = path.startsWith('http')
                          ? path
                          : path
                          ? `/${path.replace(/^\/+/, '')}`
                          : '';
                        return href ? (
                          <a
                            key={`hist-modal-anexo-${idx}-${aIdx}`}
                            href={withAuthToken(href)}
                            target="_blank"
                            rel="noreferrer"
                            className="sap-chip hover:opacity-90 inline-flex items-center gap-1"
                          >
                            <Paperclip size={10} />
                            {nome}
                          </a>
                        ) : (
                          <span key={`hist-modal-anexo-${idx}-${aIdx}`} className="sap-chip inline-flex items-center gap-1">
                            <Paperclip size={10} />
                            {nome}
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

const LinkProcessModal = ({
  open,
  minimized,
  onMinimize,
  onClose,
  onConfirm,
  linkedFolderId,
  loading,
  etapaSubMap,
}) => {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [attachBodyPdf, setAttachBodyPdf] = useState(true);
  const [attachAttachments, setAttachAttachments] = useState(true);
  const [moveToLinked, setMoveToLinked] = useState(false);
  const [note, setNote] = useState('');
  const [moveEnabled, setMoveEnabled] = useState(true);
  const [moveColuna, setMoveColuna] = useState('');
  const [moveEtapa, setMoveEtapa] = useState('');
  const [moveSub, setMoveSub] = useState('');
  const [moveComentario, setMoveComentario] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyItems, setHistoryItems] = useState([]);
  const [historyPid, setHistoryPid] = useState(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setResults([]);
    setSelected(null);
    setAttachBodyPdf(true);
    setAttachAttachments(true);
    setMoveToLinked(false);
    setNote('');
    setMoveEnabled(true);
    setMoveColuna('');
    setMoveEtapa('');
    setMoveSub('');
    setMoveComentario('');
    setHistoryOpen(false);
    setHistoryLoading(false);
    setHistoryItems([]);
    setHistoryPid(null);
  }, [open]);

  useEffect(() => {
    let ignore = false;
    if (!q || q.length < 2) {
      setResults([]);
      return;
    }
    (async () => {
      const data = await searchMailProcesses(q);
      if (!ignore) setResults(data || []);
    })();
    return () => {
      ignore = true;
    };
  }, [q]);

  useEffect(() => {
    if (!selected) return;
    const colunaAtual =
      selected.coluna_kanban ??
      selected.coluna_kanban_atual ??
      selected.ColunaKanban ??
      selected['Coluna Kanban Atual'] ??
      '';
    const etapaAtual = selected.etapa_atual ?? selected.EtapaAtual ?? selected['Etapa Atual'] ?? '';
    const subAtual = selected.sub_etapa ?? selected.SubEtapa ?? selected['Ultima Sub Etapa'] ?? '';
    setMoveColuna(colunaAtual || '');
    setMoveEtapa(etapaAtual || '');
    setMoveSub(subAtual || '');
  }, [selected]);

  if (!open || minimized) return null;

  const etapaSelecionada =
    moveEtapa || MAPA_COLUNAS_PARA_ETAPAS[moveColuna] || moveColuna || '';
  const moveRequiredOk = !!(moveColuna && etapaSelecionada && moveSub);
  const subList = etapaSubMap?.[etapaSelecionada] || [];
  const openHistory = async (pid) => {
    if (!pid) return;
    setHistoryPid(pid);
    setHistoryItems([]);
    setHistoryLoading(true);
    setHistoryOpen(true);
    try {
      const list = await getHistoricoById(pid);
      const sorted = (list || []).slice().sort((a, b) => {
        const da = new Date(
          String(pick(a, ['hist_data', 'data_movimentacao', 'data'], '')).replace(' ', 'T'),
        ).getTime();
        const db = new Date(
          String(pick(b, ['hist_data', 'data_movimentacao', 'data'], '')).replace(' ', 'T'),
        ).getTime();
        return (Number.isNaN(db) ? 0 : db) - (Number.isNaN(da) ? 0 : da);
      });
      setHistoryItems(sorted);
    } catch {
      setHistoryItems([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="sap-card w-full max-w-3xl p-4 md:p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-xl bg-[var(--muted)]/30 flex items-center justify-center border panel-border">
              <Link2 size={18} />
            </div>
            <div>
              <div className="text-lg font-bold">Anexar ao processo</div>
              <div className="text-xs opacity-70">Guarde evidência (PDF do corpo) + anexos no processo</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-outline" onClick={onMinimize} type="button" title="Minimizar">
              <Minus size={16} />
            </button>
            <button className="btn-outline" onClick={onClose} type="button">
              Fechar
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <input
            className="input-themed w-full"
            placeholder="Buscar por id / cliente / UC / CNPJ / concessionária"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />

          <div className="max-h-56 overflow-auto border panel-border rounded-xl bg-[var(--panel)]/25">
            {results.length === 0 && (
              <div className="text-xs opacity-70 p-3">
                Digite pelo menos <b>2 caracteres</b> para buscar.
              </div>
            )}

            {results.map((r, idx) => {
              const active = selected?.id_processo === r.id_processo;
              const cliente = r.cliente ?? r.Cliente ?? '-';
              const uc = r.uc ?? r.UC ?? '-';
              const concessionaria = r.concessionaria ?? r.Concessionaria ?? '-';
              const etapa = r.etapa_atual ?? r.EtapaAtual ?? r['Etapa Atual'];
              const coluna = r.coluna_kanban ?? r.coluna_kanban_atual ?? r.ColunaKanban;
              const ultimaEtapa = r.ultima_etapa ?? r['Ultima Etapa'];
              const ultimaSub = r.ultima_sub_etapa ?? r['Ultima Sub Etapa'];
              const status = r.status_analise ?? r.StatusAnalise;
              const prioridade = r.prioridade ?? r.Prioridade;
              const suspenso = r.suspenso ?? r.Suspenso;
              const ultimaMov = r.data_ultima_mov ?? r.data_ultima_movimentacao ?? r['Data Ultima Movimentacao'];
              return (
                <div
                  key={`${r.id_processo}-${idx}`}
                  className={cx(
                    'w-full text-left p-3 border-b panel-border hover:bg-[var(--panel)]/60 transition',
                    active && 'bg-[var(--panel)]/70'
                  )}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(r)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected(r);
                    }
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">
                        #{r.id_processo} - {cliente}
                      </div>
                      <div className="text-xs opacity-70 mt-0.5 truncate">
                        UC: {uc} . {concessionaria}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="btn-outline text-[11px] px-2 py-1 inline-flex items-center gap-1"
                        title="Ver histórico do processo"
                        onClick={(e) => {
                          e.stopPropagation();
                          openHistory(r.id_processo);
                        }}
                      >
                        <Clock size={12} />
                        Histórico
                      </button>
                      {active && <Chip tone="success" className="text-black">Selecionado</Chip>}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1 text-black">
                    {coluna ? (
                      <Chip tone="info" className="text-black" forceTextBlack>
                        Kanban: {coluna}
                      </Chip>
                    ) : null}
                    {etapa ? <Chip className="text-black">Etapa: {etapa}</Chip> : null}
                    {ultimaSub ? <Chip tone="warn" className="text-black">Sub-etapa: {ultimaSub}</Chip> : null}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={attachBodyPdf} onChange={(e) => setAttachBodyPdf(e.target.checked)} />
              Anexar corpo do e-mail (PDF)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={attachAttachments} onChange={(e) => setAttachAttachments(e.target.checked)} />
              Anexar anexos do e-mail
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={moveToLinked}
                onChange={(e) => setMoveToLinked(e.target.checked)}
                disabled={!linkedFolderId}
              />
              Mover para pasta Vinculados
            </label>
          </div>

          <textarea
            className="input-themed w-full min-h-[80px]"
            placeholder="Nota opcional para histórico do processo"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          <div className="border-t panel-border pt-3 space-y-2">
            <div className="text-sm font-semibold">Movimenta??o obrigat?ria</div>
            <div className="text-xs opacity-70">Informe coluna, etapa e sub-etapa para concluir o vínculo.</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {!moveRequiredOk && (
                  <div className="sm:col-span-2 text-xs text-amber-200 bg-amber-500/15 border border-amber-500/30 rounded-lg px-2 py-1">
                    Preencha coluna, etapa e sub-etapa para movimentar o processo.
                  </div>
                )}
                <div>
                  <div className="text-xs opacity-70 mb-1 flex items-center gap-1">
                    Coluna do Kanban
                    {moveEnabled && !moveColuna && <AlertTriangle className="h-3 w-3 text-red-400" />}
                  </div>
                  <select
                    className={cx(
                      'input-themed w-full',
                      moveEnabled && !moveColuna && 'border-red-400/40 focus:ring-red-400/40'
                    )}
                    value={moveColuna}
                    onChange={(e) => {
                      const next = e.target.value;
                      setMoveColuna(next);
                      setMoveEtapa(MAPA_COLUNAS_PARA_ETAPAS[next] || '');
                      setMoveSub('');
                    }}
                    required
                  >
                    <option value="">Selecione...</option>
                    {KANBAN_COLUNAS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <div className="text-xs opacity-70 mb-1 flex items-center gap-1">
                    Etapa
                    {moveEnabled && !etapaSelecionada && <AlertTriangle className="h-3 w-3 text-red-400" />}
                  </div>
                  <select
                    className={cx(
                      'input-themed w-full',
                      moveEnabled && !etapaSelecionada && 'border-red-400/40 focus:ring-red-400/40'
                    )}
                    value={moveEtapa}
                    onChange={(e) => {
                      setMoveEtapa(e.target.value);
                      setMoveSub('');
                    }}
                    required
                  >
                    <option value="">Selecione...</option>
                    {Object.keys(etapaSubMap || {}).map((e) => (
                      <option key={e} value={e}>
                        {e}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <div className="text-xs opacity-70 mb-1 flex items-center gap-1">
                    Sub-etapa
                    {moveEnabled && !moveSub && <AlertTriangle className="h-3 w-3 text-red-400" />}
                  </div>
                  <select
                    className={cx(
                      'input-themed w-full',
                      moveEnabled && !moveSub && 'border-red-400/40 focus:ring-red-400/40'
                    )}
                    value={moveSub}
                    onChange={(e) => setMoveSub(e.target.value)}
                    disabled={!etapaSelecionada}
                    required
                  >
                    <option value="">{etapaSelecionada ? 'Selecione a sub-etapa' : 'Selecione coluna/etapa'}</option>
                    {subList.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <div className="text-xs opacity-70 mb-1">Comentário de movimenta??o</div>
                  <input
                    className="input-themed w-full"
                    value={moveComentario}
                    onChange={(e) => setMoveComentario(e.target.value)}
                    placeholder="Comentário para histórico"
                  />
                </div>
              </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button className="btn-outline" onClick={onClose} type="button">
            Cancelar
          </button>
          <button
            className="btn-themed"
            disabled={!selected || loading || (moveEnabled && !moveRequiredOk)}
            onClick={() =>
            onConfirm({
              processoId: selected?.id_processo,
              attachBodyPdf,
              attachAttachments,
              moveToLinkedFolderId: moveToLinked ? linkedFolderId : '',
              note,
              moveProcess: moveEnabled,
              move: {
                coluna: moveColuna,
                etapa: moveEtapa,
                sub: moveSub,
                comentario: moveComentario,
              },
            })
            }
            type="button"
          >
            Anexar ao processo
          </button>
        </div>
      </div>
    </div>
  );
};

/* =========================
   PAGE
========================= */
const CaixaDeEmail = () => {
  const location = useLocation();
  const targetMessageId = useMemo(() => {
    try {
      return new URLSearchParams(location.search).get('messageId') || '';
    } catch {
      return '';
    }
  }, [location.search]);
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [folders, setFolders] = useState([]);
  const [activeFolder, setActiveFolder] = useState(null);

  const [messages, setMessages] = useState([]);
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [pendingDeepLinkMessageId, setPendingDeepLinkMessageId] = useState(targetMessageId);
  const [selectedIds, setSelectedIds] = useState([]);
  const [moveTargetFolderId, setMoveTargetFolderId] = useState('');
  const [readByMap, setReadByMap] = useState({});
  const [messagesOffset, setMessagesOffset] = useState(0);
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const [messageDetail, setMessageDetail] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [bodyHtml, setBodyHtml] = useState('');
  const [inlineBusy, setInlineBusy] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [inlineImagesEnabled, setInlineImagesEnabled] = useState(false);

  const [search, setSearch] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);

  const [toast, setToast] = useState({ open: false, type: 'success', message: '' });
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeSeed, setComposeSeed] = useState(null);
  const [composeMinimized, setComposeMinimized] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyMode, setReplyMode] = useState('reply');
  const [replyMessageId, setReplyMessageId] = useState(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkMinimized, setLinkMinimized] = useState(false);
  const [linking, setLinking] = useState(false);
  const [etapaSubMap, setEtapaSubMap] = useState({});
  const [aiOpen, setAiOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [aiError, setAiError] = useState('');

  // thread grouping
  const [groupByThread, setGroupByThread] = useState(true);

  // densidade da lista — 'comfortable' | 'compact'
  const [density, setDensity] = useState('comfortable');

  // filtros adicionais
  const [hasAttachmentFilter, setHasAttachmentFilter] = useState(false);
  const [linkedFilter, setLinkedFilter] = useState(false);
  const [last7Filter, setLast7Filter] = useState(false);

  // resizable columns
  const [sidebarW, setSidebarW] = useState(280);
  const [listW, setListW] = useState(420);
  const dragRef = useRef(null);

  // load/save layout widths
  useEffect(() => {
    setPendingDeepLinkMessageId(targetMessageId);
  }, [targetMessageId]);

  useEffect(() => {
    if (!pendingDeepLinkMessageId) return;
    let ignore = false;
    (async () => {
      try {
        const detail = await getMailMessage(pendingDeepLinkMessageId);
        if (ignore || !detail?.id) return;
        setSelectedMessage((prev) => (prev?.id === detail.id ? prev : detail));
        setMessages((prev) => {
          const list = Array.isArray(prev) ? prev : [];
          if (list.some((item) => item?.id === detail.id)) return list;
          return [detail, ...list];
        });
      } catch {
        if (!ignore) {
          setToast({ open: true, type: 'error', message: 'Falha ao abrir o e-mail do histórico.' });
        }
      } finally {
        if (!ignore) setPendingDeepLinkMessageId('');
      }
    })();
    return () => {
      ignore = true;
    };
  }, [pendingDeepLinkMessageId]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('mail_layout_v1');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed?.sidebarW) setSidebarW(parsed.sidebarW);
      if (parsed?.listW) setListW(parsed.listW);
      if (typeof parsed?.groupByThread === 'boolean') setGroupByThread(parsed.groupByThread);
      if (parsed?.density === 'compact' || parsed?.density === 'comfortable') {
        setDensity(parsed.density);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        'mail_layout_v1',
        JSON.stringify({ sidebarW, listW, groupByThread, density })
      );
    } catch {
      // ignore
    }
  }, [sidebarW, listW, groupByThread, density]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const map = await getEtapaSubMap();
        if (mounted) setEtapaSubMap(map || {});
      } catch {
        if (mounted) setEtapaSubMap({});
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!linkOpen && linkMinimized) setLinkMinimized(false);
  }, [linkOpen, linkMinimized]);

  useEffect(() => {
    if (!composeOpen && composeMinimized) setComposeMinimized(false);
  }, [composeOpen, composeMinimized]);

  const openReplyModal = useCallback((mode) => {
    if (!messageDetail?.id) return;
    setReplyMode(mode);
    setReplyMessageId(messageDetail.id);
    setReplyOpen(true);
  }, [messageDetail?.id]);

  const handleReplySend = useCallback(async ({ to, body }) => {
    if (!replyMessageId) return;
    try {
      const safeBody = withSignature(body);
      if (replyMode === 'forward') {
        const cleanTo = String(to || '').trim();
        if (!cleanTo) {
          setToast({ open: true, type: 'error', message: 'Informe o destinat?rio para encaminhar.' });
          return;
        }
        await forwardMailMessage(replyMessageId, cleanTo, safeBody);
      } else if (replyMode === 'replyAll') {
        await replyAllMailMessage(replyMessageId, safeBody);
      } else {
        await replyMailMessage(replyMessageId, safeBody);
      }
      setToast({ open: true, type: 'success', message: 'Resposta enviada.' });
      setReplyOpen(false);
      setReplyMessageId(null);
    } catch {
      setToast({ open: true, type: 'error', message: 'Falha ao enviar resposta.' });
    }
  }, [replyMessageId, replyMode]);

  useEffect(() => {
    try {
      if (localStorage.getItem('mail_link_restore') === '1') {
        localStorage.removeItem('mail_link_restore');
        setLinkMinimized(false);
        setLinkOpen(true);
      }
    } catch {
      // ignore
    }
  }, []);

  const startDrag = useCallback((type, e) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      type,
      startX: e.clientX,
      startSidebarW: sidebarW,
      startListW: listW,
    };
    try {
      e.currentTarget?.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
  }, [sidebarW, listW]);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;

      if (dragRef.current.type === 'sidebar') {
        const next = clamp(dragRef.current.startSidebarW + dx, 220, 420);
        setSidebarW(next);
      } else if (dragRef.current.type === 'list') {
        const next = clamp(dragRef.current.startListW + dx, 320, 680);
        setListW(next);
      }
    };

    const onUp = () => {
      dragRef.current = null;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const archiveFolderId = useMemo(() => {
    const target = folders.find((f) =>
      String(f.display_name || '').toLowerCase().includes('archive') ||
      String(f.display_name || '').toLowerCase().includes('arquiv')
    );
    return target?.id || '';
  }, [folders]);

  const deletedFolderId = useMemo(() => {
    const target = folders.find((f) =>
      String(f.display_name || '').toLowerCase().includes('deleted') ||
      String(f.display_name || '').toLowerCase().includes('exclu')
    );
    return target?.id || '';
  }, [folders]);

  const linkedFolderId = useMemo(() => {
    const target = folders.find((f) =>
      String(f.display_name || '').toLowerCase().includes('vinculado')
    );
    return target?.id || '';
  }, [folders]);

  // LOAD FOLDERS — useQuery; pastas raramente mudam
  const foldersQuery = useQuery({
    queryKey: ['mail-folders'],
    queryFn: async () => {
      const rawList = await getMailFolders();
      return sortFoldersForUi(dedupeFoldersByLabel(rawList));
    },
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (foldersQuery.isError) {
      setToast({ open: true, type: 'error', message: 'Falha ao carregar pastas.' });
    }
  }, [foldersQuery.isError]);

  useEffect(() => {
    const list = foldersQuery.data;
    if (!list) return;
    setFolders(list);
    const inbox = list.find((f) => String(f.display_name || '').toLowerCase().includes('inbox'));
    setActiveFolder((current) => {
      if (current?.id && list.some((f) => f.id === current.id)) return current;
      const stored = localStorage.getItem('mail_active_folder_id');
      return (
        (stored && list.find((f) => f.id === stored)) ||
        inbox ||
        list[0] ||
        null
      );
    });
    try {
      if (inbox?.id) localStorage.setItem('mail_inbox_folder_id', inbox.id);
    } catch {
      // ignore
    }
  }, [foldersQuery.data]);

  useEffect(() => {
    const stored = localStorage.getItem('mail_active_folder_id');
    if (stored && !activeFolder?.id) {
      setActiveFolder({ id: stored, display_name: 'Carregando...' });
    }
  }, [activeFolder?.id]);

  useEffect(() => {
    setMessagesOffset(0);
    setHasMoreMessages(true);
  }, [activeFolder?.id, search, onlyUnread]);

  // LOAD MESSAGES — useQuery substitui useEffect manual, mantém lista visível em refetch
  const messagesQueryKey = useMemo(
    () => ['mail-messages', activeFolder?.id || null, search || '', !!onlyUnread],
    [activeFolder?.id, search, onlyUnread]
  );

  const messagesQuery = useQuery({
    queryKey: messagesQueryKey,
    queryFn: () => getMailMessages({
      folderId: activeFolder.id,
      q: search || undefined,
      unread: undefined,
      limit: REQUEST_PAGE_SIZE,
      offset: 0,
    }),
    enabled: !!activeFolder?.id,
    refetchInterval: POLL_MS,
    placeholderData: keepPreviousData,
  });

  const isFetchingMessages = messagesQuery.isFetching;
  const loading = messagesQuery.isLoading;

  useEffect(() => {
    if (messagesQuery.isError) {
      setToast({ open: true, type: 'error', message: 'Falha ao carregar mensagens.' });
    }
  }, [messagesQuery.isError]);

  // Sincroniza data → messages local (apenas quando reset de pagina)
  useEffect(() => {
    const data = messagesQuery.data;
    if (!data) return;
    if (messagesOffset > 0) return;
    setMessages(data);
    setHasMoreMessages(data.length === REQUEST_PAGE_SIZE);
    if (data.length) {
      if (selectedMessage?.id) {
        const keep = data.find((x) => x.id === selectedMessage.id);
        if (keep) setSelectedMessage(keep);
      } else if (!pendingDeepLinkMessageId) {
        setSelectedMessage(data[0]);
      }
    } else if (!selectedMessage?.id && !pendingDeepLinkMessageId) {
      setSelectedMessage(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesQuery.data, messagesOffset]);

  // LOAD MESSAGE DETAIL — useQuery
  const messageDetailQuery = useQuery({
    queryKey: ['mail-message', selectedMessage?.id || null],
    queryFn: () => getMailMessage(selectedMessage.id),
    enabled: !!selectedMessage?.id,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  // Side-effects ao trocar de mensagem (reset de UI / placeholder otimista)
  useEffect(() => {
    if (!selectedMessage?.id) {
      setMessageDetail(null);
      setAttachments([]);
      setBodyHtml('');
      setAttachmentsOpen(false);
      setInlineImagesEnabled(false);
      return;
    }
    setMessageDetail({
      ...selectedMessage,
      body_type: '',
      body_content: '',
      snippet: selectedMessage?.snippet || selectedMessage?.body_preview || '',
    });
    setInlineImagesEnabled(true);
    setAttachmentsOpen(true);
    setBodyHtml('');
  }, [selectedMessage?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sincroniza data do useQuery → messageDetail
  useEffect(() => {
    const detail = messageDetailQuery.data;
    if (!detail || !selectedMessage?.id) return;
    if (detail.id && detail.id !== selectedMessage.id) return;
    setMessageDetail({
      ...selectedMessage,
      ...detail,
      has_attachments:
        detail?.has_attachments ?? detail?.hasAttachments ?? selectedMessage?.has_attachments ?? false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageDetailQuery.data, selectedMessage?.id]);

  useEffect(() => {
    if (messageDetailQuery.isError) {
      setToast({ open: true, type: 'error', message: 'Falha ao carregar mensagem.' });
    }
  }, [messageDetailQuery.isError]);

  const detailLoading = messageDetailQuery.isLoading;

  // Sanitização final do corpo do e-mail (memoizada).
  // Config explícita: permite http/https/cid/data nos URIs (cid: para inline images
  // já substituídos por data URLs, http/https para imagens externas), preserva tag
  // <style> e atributos target/rel; bloqueia script/iframe e handlers inline.
  const sanitizedBodyHtml = useMemo(() => {
    if (!bodyHtml) return '';
    return DOMPurify.sanitize(bodyHtml, {
      ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      ADD_TAGS: ['style'],
      ADD_ATTR: ['target', 'rel'],
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onchange', 'onsubmit'],
    });
  }, [bodyHtml]);

  // AUTO-MARK AS READ when email is opened
  useEffect(() => {
    if (!selectedMessage?.id || selectedMessage?.is_read_local) return;
    const t = setTimeout(() => markAsRead(selectedMessage), 800);
    return () => clearTimeout(t);
  }, [selectedMessage?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // LOAD ATTACHMENTS — useQuery
  const attachmentsShouldFetch = useMemo(() => {
    if (!messageDetail?.id) return false;
    const hasCid = /cid:/i.test(messageDetail?.body_content || '');
    const hasAttachments =
      messageDetail?.has_attachments ?? messageDetail?.hasAttachments ?? selectedMessage?.has_attachments ?? false;
    return !!hasAttachments || hasCid;
  }, [
    messageDetail?.id,
    messageDetail?.has_attachments,
    messageDetail?.hasAttachments,
    messageDetail?.body_content,
    selectedMessage?.has_attachments,
  ]);

  const attachmentsQuery = useQuery({
    queryKey: ['mail-attachments', messageDetail?.id || null],
    queryFn: () => getMailAttachments(messageDetail.id),
    enabled: !!messageDetail?.id && attachmentsShouldFetch,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!messageDetail?.id || !attachmentsShouldFetch) {
      setAttachments([]);
      return;
    }
    if (attachmentsQuery.isError) {
      setAttachments([]);
      return;
    }
    const data = attachmentsQuery.data;
    if (!data) return;
    setAttachments(data?.attachments || []);
  }, [messageDetail?.id, attachmentsShouldFetch, attachmentsQuery.data, attachmentsQuery.isError]);

  const blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });

  const normalizeCid = (raw) => String(raw || '').replace(/[<>]/g, '').trim();
  const cidVariants = (cidRaw, nameRaw) => {
    const out = new Set();
    const add = (v) => {
      const n = normalizeCid(v);
      if (n) out.add(n);
      if (n && n.includes('@')) out.add(n.split('@')[0]);
    };
    add(cidRaw);
    add(nameRaw);
    return Array.from(out);
  };
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  useEffect(() => {
    let ignore = false;
    const baseHtml = messageDetail?.body_content || messageDetail?.snippet || '';
    const safeHtml = normalizeEmailBody(baseHtml);
    setBodyHtml(safeHtml);
    if (!messageDetail?.id || !safeHtml || !/cid:/i.test(safeHtml)) return;

    const inlineAtts = (attachments || []).filter((a) => a?.is_inline || a?.content_id);
    const candidates = inlineAtts.length ? inlineAtts : attachments || [];
    if (!candidates.length) return;

    setInlineBusy(true);
    (async () => {
      const map = {};
      for (const att of candidates) {
        const variants = cidVariants(att.content_id, att.name);
        if (!variants.length) continue;
        try {
          const resp = await downloadMailAttachment(messageDetail.id, att.id);
          const dataUrl = await blobToDataUrl(resp.data);
          variants.forEach((cid) => {
            map[cid] = dataUrl;
          });
        } catch {
          // ignore inline attachment failure
        }
      }
      if (ignore) return;
      let out = safeHtml;
      Object.keys(map).forEach((cid) => {
        const safe = escapeRegex(cid);
        out = out.replace(new RegExp(`cid:${safe}`, 'gi'), map[cid]);
        out = out.replace(new RegExp(`cid:${escapeRegex(encodeURIComponent(cid))}`, 'gi'), map[cid]);
      });

      // fallback: replace cid:<filename>@... with attachment by filename
      (attachments || []).forEach((att) => {
        const name = normalizeCid(att?.name);
        if (!name) return;
        const dataUrl = map[name];
        if (!dataUrl) return;
        const safeName = escapeRegex(name);
        out = out.replace(new RegExp(`cid:${safeName}@[^"'\\s>]+`, 'gi'), dataUrl);
        out = out.replace(
          new RegExp(`cid:${escapeRegex(encodeURIComponent(name))}@[^"'\\s>]+`, 'gi'),
          dataUrl
        );
      });
      setBodyHtml(out);
    })().finally(() => {
      if (!ignore) setInlineBusy(false);
    });

    return () => {
      ignore = true;
    };
  }, [messageDetail?.id, messageDetail?.body_content, messageDetail?.snippet, attachments, inlineImagesEnabled]);

  const listRows = useMemo(() => {
    let rows = messages || [];
    if (onlyUnread) rows = rows.filter((m) => !m.is_read_local);
    if (hasAttachmentFilter) rows = rows.filter((m) => !!m.has_attachments);
    if (linkedFilter) rows = rows.filter((m) => !!m.linked_processo_id);
    if (last7Filter) {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      rows = rows.filter((m) => {
        const t = m.received_at ? new Date(m.received_at).getTime() : 0;
        return t >= cutoff;
      });
    }
    return rows;
  }, [messages, onlyUnread, hasAttachmentFilter, linkedFilter, last7Filter]);

  const hasActiveFilters = onlyUnread || hasAttachmentFilter || linkedFilter || last7Filter || !!search;

  const markAsReadMutation = useMutation({
    mutationFn: (msg) => setMailReadLocal(msg.id),
    onMutate: async (msg) => {
      const name = user?.nome ? String(user.nome).trim() : 'Usu?rio';
      await queryClient.cancelQueries({ queryKey: ['mail-messages'] });
      const previousData = queryClient.getQueriesData({ queryKey: ['mail-messages'] });
      queryClient.setQueriesData({ queryKey: ['mail-messages'] }, (old) =>
        (old || []).map((m) =>
          m.id === msg.id
            ? {
                ...m,
                is_read_local: true,
                read_by: Array.from(new Set([...(m.read_by || []), name])),
              }
            : m
        )
      );
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? {
                ...m,
                is_read_local: true,
                read_by: Array.from(new Set([...(m.read_by || []), name])),
              }
            : m
        )
      );
      setSelectedMessage((prev) =>
        prev?.id === msg.id
          ? {
              ...prev,
              is_read_local: true,
              read_by: Array.from(new Set([...(prev.read_by || []), name])),
            }
          : prev
      );
      setMessageDetail((prev) =>
        prev?.id === msg.id
          ? {
              ...prev,
              is_read_local: true,
              read_by: Array.from(new Set([...(prev.read_by || []), name])),
            }
          : prev
      );
      setReadByMap((prev) => ({ ...prev, [msg.id]: name }));
      return { previousData };
    },
    onError: (_err, _msg, context) => {
      if (context?.previousData) {
        context.previousData.forEach(([key, data]) => queryClient.setQueryData(key, data));
      }
      setToast({ open: true, type: 'error', message: 'Falha ao marcar como lido.' });
    },
    onSuccess: () => {
      window.dispatchEvent(new CustomEvent('mail-unread-refresh'));
    },
    // Sem invalidateQueries no onSettled: a atualização otimista é suficiente.
    // Invalidar aqui dispararia um refetch de ~4s do Graph API que fazia a lista
    // sumir/piscar mesmo com keepPreviousData. O poll de POLL_MS (2 min) sincroniza.
  });

  const markAsRead = useCallback(
    (msg) => {
      if (!msg?.id) return;
      markAsReadMutation.mutate(msg);
    },
    [markAsReadMutation]
  );

  const markAsUnreadMutation = useMutation({
    mutationFn: (msg) => setMailUnreadLocal(msg.id),
    onMutate: async (msg) => {
      const userName = user?.nome || '';
      await queryClient.cancelQueries({ queryKey: ['mail-messages'] });
      const previousData = queryClient.getQueriesData({ queryKey: ['mail-messages'] });
      queryClient.setQueriesData({ queryKey: ['mail-messages'] }, (old) =>
        (old || []).map((m) =>
          m.id === msg.id
            ? {
                ...m,
                is_read_local: false,
                read_by: (m.read_by || []).filter((n) => n !== userName),
              }
            : m
        )
      );
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? {
                ...m,
                is_read_local: false,
                read_by: (m.read_by || []).filter((n) => n !== userName),
              }
            : m
        )
      );
      setSelectedMessage((prev) =>
        prev?.id === msg.id
          ? {
              ...prev,
              is_read_local: false,
              read_by: (prev.read_by || []).filter((n) => n !== userName),
            }
          : prev
      );
      setMessageDetail((prev) =>
        prev?.id === msg.id
          ? {
              ...prev,
              is_read_local: false,
              read_by: (prev.read_by || []).filter((n) => n !== userName),
            }
          : prev
      );
      return { previousData };
    },
    onError: (_err, _msg, context) => {
      if (context?.previousData) {
        context.previousData.forEach(([key, data]) => queryClient.setQueryData(key, data));
      }
      setToast({ open: true, type: 'error', message: 'Falha ao marcar como não lido.' });
    },
    onSuccess: () => {
      window.dispatchEvent(new CustomEvent('mail-unread-refresh'));
    },
    // Sem invalidateQueries — vide markAsReadMutation acima.
  });

  const markAsUnread = useCallback(
    (msg) => {
      if (!msg?.id) return;
      markAsUnreadMutation.mutate(msg);
    },
    [markAsUnreadMutation]
  );

  const handleLoadMore = useCallback(async () => {
    if (!activeFolder?.id || loadingMore || !hasMoreMessages) return;
    setLoadingMore(true);
    try {
    const nextOffset = messagesOffset + REQUEST_PAGE_SIZE;
      const list = await getMailMessages({
        folderId: activeFolder.id,
        q: search || undefined,
        unread: undefined,
        limit: REQUEST_PAGE_SIZE,
        offset: nextOffset,
      });
      setMessages((prev) => {
        const seen = new Set();
        (prev || []).forEach((m) => {
          if (m?.id) seen.add(m.id);
        });
        const extra = (list || []).filter((m) => m?.id && !seen.has(m.id));
        return [...(prev || []), ...extra];
      });
      setMessagesOffset(nextOffset);
      setHasMoreMessages((list || []).length === REQUEST_PAGE_SIZE);
    } catch {
      setToast({ open: true, type: 'error', message: 'Falha ao carregar mais mensagens.' });
    } finally {
      setLoadingMore(false);
    }
  }, [activeFolder?.id, hasMoreMessages, loadingMore, messagesOffset, onlyUnread, search]);

  // thread key: prefer thread_id, fallback subject normalized
  const getThreadKey = useCallback((m) => {
    if (!m) return '';
    return m.thread_id || normalizeSubject(m.subject) || String(m.id || '');
  }, []);

  // grouped list for UI
  const grouped = useMemo(() => {
    if (!groupByThread) {
      return listRows.map((m) => ({
        kind: 'single',
        key: m.id,
        latest: m,
        items: [m],
        count: 1,
        unreadCount: m.is_read_local ? 0 : 1,
        hasAttachments: !!m.has_attachments,
        linkedProcessId: m.linked_processo_id || null,
      }));
    }

    const map = new Map();
    for (const m of listRows) {
      const key = getThreadKey(m);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(m);
    }

    const groups = [];
    for (const [key, items] of map.entries()) {
      items.sort((a, b) => new Date(b.received_at || 0) - new Date(a.received_at || 0));
      const latest = items[0];
      const unreadCount = items.reduce((acc, x) => acc + (x.is_read_local ? 0 : 1), 0);
      const hasAttachments = items.some((x) => !!x.has_attachments);
      const linkedProcessId = items.find((x) => x.linked_processo_id)?.linked_processo_id || null;
      const readBy = Array.from(
        new Set(
          items.flatMap((x) => (Array.isArray(x.read_by) ? x.read_by : []))
        )
      );

      groups.push({
        kind: 'thread',
        key,
        latest,
        items,
        count: items.length,
        unreadCount,
        hasAttachments,
        linkedProcessId,
        readBy,
      });
    }

    groups.sort((a, b) => new Date(b.latest?.received_at || 0) - new Date(a.latest?.received_at || 0));
    return groups;
  }, [listRows, groupByThread, getThreadKey]);

  // Agrupa os groups por bucket de data para sticky headers
  const groupedByDate = useMemo(() => {
    const buckets = { hoje: [], ontem: [], 'esta-semana': [], 'mais-antigos': [] };
    for (const g of grouped) {
      const bucket = dateBucketOf(g.latest?.received_at);
      buckets[bucket].push(g);
    }
    return DATE_BUCKET_ORDER
      .map((key) => ({ key, label: DATE_BUCKET_LABEL[key], items: buckets[key] }))
      .filter((b) => b.items.length > 0);
  }, [grouped]);

  // selected thread items (for right panel)
  const selectedThread = useMemo(() => {
    if (!groupByThread || !selectedMessage) return null;
    const key = getThreadKey(selectedMessage);
    if (!key) return null;
    const g = grouped.find((x) => x.key === key);
    return g || null;
  }, [groupByThread, selectedMessage, grouped, getThreadKey]);

  const activeFolderMeta = useMemo(() => folderLabel(activeFolder?.display_name || 'Caixa'), [activeFolder?.display_name]);
  const effectiveHasAttachments = useMemo(
    () => messageDetail?.has_attachments ?? messageDetail?.hasAttachments ?? selectedMessage?.has_attachments ?? false,
    [messageDetail?.has_attachments, messageDetail?.hasAttachments, selectedMessage?.has_attachments]
  );

  const allSelected = useMemo(() => {
    if (!grouped.length) return false;
    return grouped.every((g) => selectedIds.includes(g.latest?.id));
  }, [grouped, selectedIds]);

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds([]);
      return;
    }
    setSelectedIds(grouped.map((g) => g.latest?.id).filter(Boolean));
  }, [allSelected, grouped]);

  const toggleSelectOne = useCallback((id) => {
    if (!id) return;
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const bulkMarkRead = useCallback(async () => {
    if (!selectedIds.length) return;
    const ids = [...selectedIds];
    try {
      await Promise.all(ids.map((id) => setMailReadLocal(id)));
      const name = user?.nome ? String(user.nome).trim() : 'Usu?rio';
      const applyRead = (m) =>
        ids.includes(m.id)
          ? {
              ...m,
              is_read_local: true,
              read_by: Array.isArray(m.read_by)
                ? Array.from(new Set([...m.read_by, name]))
                : [name],
            }
          : m;
      queryClient.setQueriesData({ queryKey: ['mail-messages'] }, (old) =>
        (old || []).map(applyRead)
      );
      setMessages((prev) => prev.map(applyRead));
      setSelectedMessage((prev) =>
        prev?.id && ids.includes(prev.id)
          ? {
              ...prev,
              is_read_local: true,
              read_by: Array.from(new Set([...(prev.read_by || []), name])),
            }
          : prev
      );
      setMessageDetail((prev) =>
        prev?.id && ids.includes(prev.id)
          ? {
              ...prev,
              is_read_local: true,
              read_by: Array.from(new Set([...(prev.read_by || []), name])),
            }
          : prev
      );
      setReadByMap((prev) => {
        const next = { ...prev };
        ids.forEach((id) => {
          next[id] = name;
        });
        return next;
      });
      if (selectedMessage?.id && ids.includes(selectedMessage.id)) {
        const detail = await getMailMessage(selectedMessage.id);
        setMessageDetail(detail);
      }
      queryClient.invalidateQueries({ queryKey: ['mail-messages'] });
      window.dispatchEvent(new CustomEvent('mail-unread-refresh'));
    } catch {
      setToast({ open: true, type: 'error', message: 'Falha ao marcar selecionados como lidos.' });
    }
  }, [selectedIds, user?.nome, selectedMessage?.id, queryClient]);

  const bulkMarkUnread = useCallback(async () => {
    if (!selectedIds.length) return;
    const ids = [...selectedIds];
    try {
      await Promise.all(ids.map((id) => setMailUnreadLocal(id)));
      const applyUnread = (m) =>
        ids.includes(m.id)
          ? {
              ...m,
              is_read_local: false,
              read_by: Array.isArray(m.read_by)
                ? m.read_by.filter((n) => n && n !== user?.nome)
                : m.read_by,
            }
          : m;
      queryClient.setQueriesData({ queryKey: ['mail-messages'] }, (old) =>
        (old || []).map(applyUnread)
      );
      setMessages((prev) => prev.map(applyUnread));
      setSelectedMessage((prev) =>
        prev?.id && ids.includes(prev.id)
          ? {
              ...prev,
              is_read_local: false,
              read_by: Array.isArray(prev.read_by)
                ? prev.read_by.filter((n) => n && n !== user?.nome)
                : prev.read_by,
            }
          : prev
      );
      setMessageDetail((prev) =>
        prev?.id && ids.includes(prev.id)
          ? {
              ...prev,
              is_read_local: false,
              read_by: Array.isArray(prev.read_by)
                ? prev.read_by.filter((n) => n && n !== user?.nome)
                : prev.read_by,
            }
          : prev
      );
      setReadByMap((prev) => {
        const next = { ...prev };
        ids.forEach((id) => {
          delete next[id];
        });
        return next;
      });
      if (selectedMessage?.id && ids.includes(selectedMessage.id)) {
        const detail = await getMailMessage(selectedMessage.id);
        setMessageDetail(detail);
      }
      queryClient.invalidateQueries({ queryKey: ['mail-messages'] });
      window.dispatchEvent(new CustomEvent('mail-unread-refresh'));
    } catch {
      setToast({ open: true, type: 'error', message: 'Falha ao marcar selecionados como não lidos.' });
    }
  }, [selectedIds, user?.nome, selectedMessage?.id, queryClient]);

  useEffect(() => {
    if (!grouped.length) {
      setSelectedIds([]);
      return;
    }
    const valid = new Set(grouped.map((g) => g.latest?.id).filter(Boolean));
    setSelectedIds((prev) => prev.filter((id) => valid.has(id)));
  }, [grouped]);

  useEffect(() => {
    if (!Array.isArray(messages)) return;
    let inboxId = '';
    try {
      inboxId = localStorage.getItem('mail_inbox_folder_id') || '';
    } catch {}
    if (inboxId && activeFolder?.id !== inboxId) return;
    const count = groupByThread
      ? grouped.filter((g) => !g.latest?.is_read_local).length
      : messages.filter((m) => !m.is_read_local).length;
    window.dispatchEvent(new CustomEvent('mail-unread-set', { detail: { count } }));
  }, [messages, grouped, groupByThread, activeFolder?.id]);
  const ActiveIcon = activeFolderMeta.icon || Mail;
  const handleMove = async (folderId) => {
    if (!selectedMessage || !folderId) return;
    try {
      await moveMailMessage(selectedMessage.id, folderId);
      setToast({ open: true, type: 'success', message: 'Movido com sucesso.' });
      queryClient.invalidateQueries({ queryKey: ['mail-messages'] });
    } catch {
      setToast({ open: true, type: 'error', message: 'Falha ao mover.' });
    }
  };

  const handleMoveSelectedToFolder = async () => {
    if (!moveTargetFolderId) return;
    if (!selectedIds.length) {
      setToast({ open: true, type: 'info', message: 'Selecione ao menos um e-mail.' });
      return;
    }
    const ids = [...selectedIds];
    try {
      await Promise.all(ids.map((id) => moveMailMessage(id, moveTargetFolderId)));
      setToast({ open: true, type: 'success', message: 'E-mails movidos com sucesso.' });
      const removeMoved = (list) => (list || []).filter((m) => !ids.includes(m.id));
      queryClient.setQueriesData({ queryKey: ['mail-messages'] }, removeMoved);
      setMessages(removeMoved);
      setSelectedIds([]);
      if (selectedMessage?.id && ids.includes(selectedMessage.id)) {
        setSelectedMessage(null);
      }
      queryClient.invalidateQueries({ queryKey: ['mail-messages'] });
      setMoveTargetFolderId('');
    } catch {
      setToast({ open: true, type: 'error', message: 'Falha ao mover e-mails.' });
    }
  };

  const handleSend = async ({ to, cc, bcc, subject, body, files }) => {
    const fd = new FormData();
    fd.append('to', to);
    if (cc) fd.append('cc', cc);
    if (bcc) fd.append('bcc', bcc);
    fd.append('subject', subject);
    const signatureHtml =
      '<br/><br/><img src="/assinatura_complaint.png" alt="assinatura" style="max-width:260px;height:auto;" />';
    const bodyWithSignature = body.includes('assinatura_complaint.png')
      ? body
      : `${body || ''}${signatureHtml}`;
    fd.append('body', bodyWithSignature);
    fd.append('body_type', 'HTML');
    (files || []).forEach((f) => fd.append('attachments', f));

    try {
      await sendMailMessage(fd);
      setToast({ open: true, type: 'success', message: 'E-mail enviado.' });
      setComposeOpen(false);
      queryClient.invalidateQueries({ queryKey: ['mail-messages'] });
    } catch {
      setToast({ open: true, type: 'error', message: 'Falha ao enviar e-mail.' });
    }
  };

  const handleLink = async (payload) => {
    if (!selectedMessage?.id) return;
    setLinking(true);
    try {
      const resp = await linkMailToProcess(selectedMessage.id, payload);
      const historyOk = !!resp?.data?.history_ok;
      setToast({
        open: true,
        type: historyOk ? 'success' : 'info',
        message: historyOk
          ? `Email vinculado ao processo ID#${payload.processoId} e histórico atualizado`
          : `Email vinculado ao processo ID#${payload.processoId}`,
      });
      if (payload?.moveProcess) {
        const etapa =
          payload?.move?.etapa ||
          MAPA_COLUNAS_PARA_ETAPAS[payload?.move?.coluna] ||
          payload?.move?.coluna;
        try {
          await movimentarProcesso(payload.processoId, {
            etapa_atual: etapa || '',
            sub_etapa: payload?.move?.sub || '',
            comentario: payload?.move?.comentario || '',
          });
        } catch {
          setToast({
            open: true,
            type: 'error',
            message: 'Email vinculado, mas falha ao movimentar processo.',
          });
        }
      }
      setLinkOpen(false);
      queryClient.invalidateQueries({ queryKey: ['mail-messages'] });
    } catch (err) {
      const msg = err?.response?.data?.error || 'Falha ao vincular e-mail.';
      setToast({ open: true, type: 'error', message: msg });
    } finally {
      setLinking(false);
    }
  };

  const handleAnalyzeAI = async () => {
    if (!messageDetail?.id) return;
    const linkedPid =
      messageDetail?.linked_processo_id ||
      selectedMessage?.linked_processo_id ||
      selectedThread?.linkedProcessId ||
      null;
    if (!linkedPid) {
      setToast({ open: true, type: 'info', message: 'Vincule o e-mail a um processo para analisar.' });
      return;
    }
    setAiOpen(true);
    setAiLoading(true);
    setAiError('');
    setAiResult(null);
    try {
      const data = await analyzeMailMessage(messageDetail.id);
      setAiResult(data?.result || data);
    } catch (err) {
      const msg = err?.response?.data?.error || 'Falha ao analisar com IA.';
      const details = err?.response?.data?.details;
      setAiError(details ? `${msg} (${details})` : msg);
    } finally {
      setAiLoading(false);
    }
  };

  const handleUseDraft = ({ assunto, corpo }) => {
    const subjectSeed = assunto || (messageDetail?.subject ? `Re: ${messageDetail.subject}` : '');
    setComposeSeed({
      to: messageDetail?.from_email || '',
      cc: '',
      bcc: '',
      subject: subjectSeed,
      body: corpo || '',
    });
    setComposeOpen(true);
    setComposeMinimized(false);
  };

  return (
    <div
      className="bg-[var(--bg)] text-[var(--fg)] mail-shell flex flex-col"
      style={{ height: 'calc(125vh - 80px)' }}
    >
      {/* TOP BAR */}
      <div className="shrink-0 border-b panel-border bg-[var(--bg)]/75 backdrop-blur mail-header">
        <div className="px-3 py-1.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <ActiveIcon size={14} className="opacity-70 shrink-0" />
            <div className="text-sm font-semibold truncate">{activeFolderMeta.label}</div>
            <div className="text-[11px] opacity-60 truncate hidden md:block">
              · {onlyUnread ? 'Não lidos' : 'Todos'}{search ? ` · "${search}"` : ''}
            </div>
          </div>

          <div className="flex items-center gap-1">
            <IconBtn title="Atualizar" onClick={() => messagesQuery.refetch()}>
              <RefreshCw size={14} />
            </IconBtn>
          </div>
        </div>
      </div>

      {/* LAYOUT */}
      <div className="flex flex-1 min-h-0">
        {/* SIDEBAR */}
        <aside
          className="shrink-0 border-r panel-border bg-[var(--panel)]/45 backdrop-blur mail-sidebar h-full flex flex-col"
          style={{ width: sidebarW }}
        >
          {/* "+ Novo email" — prominente no topo */}
          <div className="shrink-0 p-2 border-b panel-border">
            <button
              className="btn-themed w-full text-sm py-2 inline-flex items-center justify-center gap-2 font-semibold"
              onClick={() => {
                setComposeOpen(true);
                setComposeMinimized(false);
              }}
              type="button"
            >
              <Send size={14} />
              Novo email
            </button>
          </div>

          {/* Ações rápidas */}
          <div className="shrink-0 px-2 pt-2 space-y-1">
            <button
              type="button"
              className="btn-outline text-[11px] px-2 py-1 w-full inline-flex items-center gap-2"
              onClick={() => selectedMessage && markAsRead(selectedMessage)}
              disabled={!selectedMessage}
              title="Marcar como lido"
            >
              <MailOpen size={13} />
              <span>Marcar como lido</span>
            </button>
            <button
              type="button"
              className="btn-outline text-[11px] px-2 py-1 w-full inline-flex items-center gap-2"
              onClick={() => selectedMessage && markAsUnread(selectedMessage)}
              disabled={!selectedMessage || !selectedMessage.is_read_local}
              title="Marcar como não lido"
            >
              <Mail size={13} />
              <span>Marcar como não lido</span>
            </button>
          </div>

          {/* Cabeçalho "Pastas" */}
          <div className="shrink-0 px-3 pt-3 pb-1">
            <div className="text-[10px] font-semibold opacity-50 uppercase tracking-wider">Pastas</div>
          </div>

          {/* Lista de pastas (scroll interno) */}
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-0.5">
            {folders.map((f) => {
              const meta = folderLabel(f.display_name);
              const Icon = meta.icon;
              const isActive = activeFolder?.id === f.id;

              return (
                <button
                  key={f.id}
                  onClick={() => {
                    setActiveFolder(f);
                    try {
                      localStorage.setItem('mail_active_folder_id', f.id);
                    } catch {}
                  }}
                  className={cx(
                    'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition',
                    isActive
                      ? 'bg-[var(--panel)]/70 text-[var(--fg)]'
                      : 'bg-transparent hover:bg-[var(--panel)]/40'
                  )}
                  type="button"
                >
                  <Icon size={14} className="shrink-0 opacity-70" />
                  <div className="min-w-0 flex-1 text-[13px] truncate">{meta.label}</div>
                  {isActive && <div className="h-1.5 w-1.5 rounded-full bg-emerald-400/80 shrink-0" />}
                </button>
              );
            })}
          </div>

          {/* Mover selecionados (só aparece quando há seleção) */}
          {selectedIds.length > 0 && (
            <div className="shrink-0 p-2 border-t panel-border space-y-1.5 bg-[var(--panel)]/30">
              <div className="text-[10px] opacity-60 px-1">
                {selectedIds.length} selecionado(s)
              </div>
              <select
                className="input-themed text-xs w-full"
                value={moveTargetFolderId}
                onChange={(e) => setMoveTargetFolderId(e.target.value)}
              >
                <option value="">Mover para...</option>
                {folders.map((f) => (
                  <option key={`mv-${f.id}`} value={f.id}>
                    {folderLabel(f.display_name).label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-outline text-[11px] px-2 py-1 w-full"
                onClick={handleMoveSelectedToFolder}
                disabled={!moveTargetFolderId}
              >
                Mover {selectedIds.length}
              </button>
            </div>
          )}
        </aside>

        {/* RESIZER 1 */}
        <Resizer onPointerDown={(e) => startDrag('sidebar', e)} />

        {/* MESSAGE LIST */}
        <section
          className="relative shrink-0 border-r panel-border bg-[var(--bg)] mail-list flex flex-col"
          style={{ width: listW, height: '100%' }}
        >
          <div className="border-b panel-border bg-[var(--bg)]/75 backdrop-blur">
            <div className="p-2 space-y-2">
              <div className="flex items-center gap-2">
                <div className="relative w-full">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-70" />
                  <input
                    className="input-themed w-full pl-9 pr-9"
                    placeholder="Buscar por assunto, remetente..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 opacity-60 hover:opacity-100 transition"
                      title="Limpar busca"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>

                <IconBtn title="Atualizar" onClick={() => messagesQuery.refetch()}>
                  <RefreshCw size={16} />
                </IconBtn>
              </div>

              {/* Chips de filtro (V8) */}
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  className={cx(
                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] transition',
                    onlyUnread
                      ? 'bg-blue-500/20 text-blue-200 border-blue-500/40'
                      : 'bg-[var(--panel)]/25 border-[var(--border)]/40 hover:bg-[var(--panel)]/45'
                  )}
                  onClick={() => setOnlyUnread((v) => !v)}
                >
                  <Mail size={12} />
                  Não lidos
                </button>
                <button
                  type="button"
                  className={cx(
                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] transition',
                    hasAttachmentFilter
                      ? 'bg-amber-500/20 text-amber-200 border-amber-500/40'
                      : 'bg-[var(--panel)]/25 border-[var(--border)]/40 hover:bg-[var(--panel)]/45'
                  )}
                  onClick={() => setHasAttachmentFilter((v) => !v)}
                >
                  <Paperclip size={12} />
                  Com anexo
                </button>
                <button
                  type="button"
                  className={cx(
                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] transition',
                    linkedFilter
                      ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40'
                      : 'bg-[var(--panel)]/25 border-[var(--border)]/40 hover:bg-[var(--panel)]/45'
                  )}
                  onClick={() => setLinkedFilter((v) => !v)}
                >
                  <Link2 size={12} />
                  Vinculados
                </button>
                <button
                  type="button"
                  className={cx(
                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] transition',
                    last7Filter
                      ? 'bg-violet-500/20 text-violet-200 border-violet-500/40'
                      : 'bg-[var(--panel)]/25 border-[var(--border)]/40 hover:bg-[var(--panel)]/45'
                  )}
                  onClick={() => setLast7Filter((v) => !v)}
                >
                  <Clock size={12} />
                  7 dias
                </button>
              </div>

              {/* Toolbar inferior: seleção, conversas, densidade */}
              <div className="flex items-center justify-between text-[11px] gap-2">
                <label className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border panel-border bg-[var(--panel)]/15 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                  />
                  Todos
                </label>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className={cx(
                      'inline-flex items-center gap-1.5 px-2 py-1 rounded-full border transition',
                      groupByThread
                        ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30'
                        : 'bg-[var(--panel)]/25 border-[var(--border)]/40 hover:bg-[var(--panel)]/40'
                    )}
                    onClick={() => setGroupByThread((v) => !v)}
                    title="Agrupar mensagens por conversa"
                  >
                    <MessagesSquare size={12} />
                    Conversas
                  </button>
                  <button
                    type="button"
                    className={cx(
                      'inline-flex items-center gap-1.5 px-2 py-1 rounded-full border transition',
                      density === 'compact'
                        ? 'bg-[var(--accent)]/20 text-[var(--accent)] border-[var(--accent)]/40'
                        : 'bg-[var(--panel)]/25 border-[var(--border)]/40 hover:bg-[var(--panel)]/40'
                    )}
                    onClick={() => setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact'))}
                    title={density === 'compact' ? 'Mudar para confortável' : 'Mudar para compacto'}
                  >
                    <Minus size={12} />
                    {density === 'compact' ? 'Compacto' : 'Confortável'}
                  </button>
                </div>
              </div>
            </div>

            {/* Progress bar V9 — substitui o "Atualizando..." textual */}
            {isFetchingMessages && grouped.length > 0 && (
              <div className="mail-progress-track" aria-label="Atualizando mensagens" />
            )}
          </div>

          <div className="flex-1 overflow-y-auto pb-16 relative">
            {loading && grouped.length === 0 && (
              <>
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
              </>
            )}

            {/* Empty state ilustrado V7 */}
            {!loading && grouped.length === 0 && (
              <div className="p-10 text-center">
                <div className="mx-auto h-20 w-20 rounded-3xl border panel-border bg-gradient-to-br from-[var(--panel)]/40 to-[var(--panel)]/10 flex items-center justify-center shadow-soft">
                  <Inbox size={40} className="opacity-60" />
                </div>
                <div className="mt-5 text-base font-semibold">
                  {hasActiveFilters ? 'Nenhuma mensagem encontrada' : 'Caixa vazia'}
                </div>
                <div className="mt-1 text-xs opacity-70 max-w-xs mx-auto">
                  {hasActiveFilters
                    ? 'Tente ajustar os filtros aplicados ou trocar de pasta.'
                    : 'Quando chegar uma mensagem nova, ela aparece aqui.'}
                </div>
                {hasActiveFilters && (
                  <button
                    type="button"
                    className="mt-5 inline-flex items-center gap-2 btn-outline text-xs"
                    onClick={() => {
                      setSearch('');
                      setOnlyUnread(false);
                      setHasAttachmentFilter(false);
                      setLinkedFilter(false);
                      setLast7Filter(false);
                    }}
                  >
                    <X size={12} />
                    Limpar filtros
                  </button>
                )}
              </div>
            )}

            {/* Lista com sticky headers por data V3 */}
            {grouped.length > 0 &&
              groupedByDate.map((bucket) => (
                <div key={bucket.key}>
                  <div className="sticky top-0 z-10 px-3 py-1.5 text-[10px] uppercase tracking-wider font-semibold opacity-70 bg-[var(--bg)]/90 backdrop-blur border-b panel-border">
                    {bucket.label}
                    <span className="ml-2 opacity-60 normal-case font-normal">{bucket.items.length}</span>
                  </div>
                  {bucket.items.map((g) => {
                    const m = g.latest;
                    const active = selectedMessage?.id === m.id;
                    const who = m.from_name || m.from_email || '(Sem remetente)';
                    const subject = m.subject || '(Sem assunto)';
                    const isUnread = !m.is_read_local;
                    const palette = avatarColorFor(m.from_email || who);
                    const readByNames =
                      g.kind === 'thread'
                        ? Array.isArray(g.readBy)
                          ? g.readBy
                          : []
                        : Array.isArray(m.read_by)
                          ? m.read_by
                          : [];
                    const localReadName = readByMap[m.id] || (m.is_read_local ? user?.nome || 'você' : '');
                    const mergedReadBy = localReadName
                      ? Array.from(new Set([...readByNames, localReadName]))
                      : readByNames;

                    // Densidade V11 — afeta paddings/tamanhos
                    const isCompact = density === 'compact';
                    const avatarSize = isCompact ? 'h-8 w-8' : 'h-10 w-10';
                    const avatarText = isCompact ? 'text-[10px]' : 'text-xs';
                    const itemPadding = isCompact ? 'px-3 py-2' : 'px-3 py-3';

                    return (
                      <div
                        key={g.key}
                        className={cx(
                          'relative w-full text-left border-b panel-border transition group mail-list-item',
                          itemPadding,
                          active
                            ? 'bg-[var(--panel)]/55 mail-list-item--active'
                            : 'hover:bg-[var(--panel)]/45',
                          // V2: borda lateral 3px em não lidos
                          isUnread
                            ? 'border-l-[3px] border-l-[var(--accent)] pl-[9px]'
                            : 'border-l-[3px] border-l-transparent'
                        )}
                        onClick={() => setSelectedMessage(m)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedMessage(m);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        title={g.linkedProcessId ? `Vinculado ao processo #${g.linkedProcessId}` : ''}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={selectedIds.includes(m.id)}
                            onChange={() => toggleSelectOne(m.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="mt-2"
                            aria-label="Selecionar mensagem"
                          />

                          {/* V1: avatar com cor determinística + V2 reforço dot não-lido */}
                          <div className="relative shrink-0">
                            <div
                              className={cx(
                                'rounded-full flex items-center justify-center font-bold ring-1',
                                avatarSize,
                                avatarText,
                                palette.bg,
                                palette.ring,
                                palette.text
                              )}
                              aria-hidden="true"
                            >
                              {initials(who)}
                            </div>
                            {isUnread && (
                              <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-[var(--accent)] ring-2 ring-[var(--bg)]" />
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <div className={cx('text-sm truncate', isUnread ? 'font-semibold' : 'font-medium')}>
                                {who}
                              </div>
                              <div className="text-[11px] opacity-70 shrink-0">{formatDate(m.received_at)}</div>
                            </div>

                            <div className={cx('text-sm truncate', isUnread ? 'opacity-100' : 'opacity-85')}>
                              {subject}
                            </div>

                            {!isCompact && (
                              <div className="text-xs opacity-70 truncate mt-0.5">{m.snippet}</div>
                            )}

                            {!isCompact && mergedReadBy.length > 0 && (
                              <div className="text-[11px] opacity-60 mt-0.5">
                                Lido por {mergedReadBy.join(', ')}
                              </div>
                            )}

                            <div className={cx('flex flex-wrap items-center gap-1.5', isCompact ? 'mt-1' : 'mt-2')}>
                              {/* V5: badge prominente para vinculados */}
                              {g.linkedProcessId && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500/20 text-emerald-200 border border-emerald-500/30 text-[10px] font-semibold">
                                  <Link2 size={10} />
                                  #{g.linkedProcessId}
                                </span>
                              )}
                              {g.kind === 'thread' && g.count > 1 && (
                                <Chip>
                                  <MessagesSquare size={10} /> {g.count}
                                </Chip>
                              )}
                              {g.hasAttachments && (
                                <Chip>
                                  <Paperclip size={10} />
                                </Chip>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* V4: ações rápidas no hover */}
                        <div className="absolute right-2 top-2 hidden group-hover:flex items-center gap-1 bg-[var(--bg)]/85 backdrop-blur rounded-lg border panel-border px-1 py-0.5 shadow-soft">
                          {isUnread ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                markAsRead(m);
                              }}
                              title="Marcar como lido"
                              className="h-7 w-7 rounded-md hover:bg-[var(--panel)]/60 flex items-center justify-center"
                            >
                              <MailOpen size={13} />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                markAsUnread(m);
                              }}
                              title="Marcar como não lido"
                              className="h-7 w-7 rounded-md hover:bg-[var(--panel)]/60 flex items-center justify-center"
                            >
                              <Mail size={13} />
                            </button>
                          )}
                          {archiveFolderId && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedMessage(m);
                                handleMove(archiveFolderId);
                              }}
                              title="Arquivar"
                              className="h-7 w-7 rounded-md hover:bg-[var(--panel)]/60 flex items-center justify-center"
                            >
                              <Archive size={13} />
                            </button>
                          )}
                          {deletedFolderId && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedMessage(m);
                                handleMove(deletedFolderId);
                              }}
                              title="Excluir"
                              className="h-7 w-7 rounded-md hover:bg-rose-500/20 hover:text-rose-200 flex items-center justify-center"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}

            {!loading && grouped.length > 0 && (
              <div className="p-3 border-t panel-border">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={!hasMoreMessages || loadingMore}
                  className={cx(
                    'w-full btn-outline',
                    (!hasMoreMessages || loadingMore) && 'opacity-60 cursor-not-allowed'
                  )}
                >
                  {loadingMore ? 'Carregando...' : hasMoreMessages ? 'Carregar mais' : 'Sem mais mensagens'}
                </button>
              </div>
            )}
          </div>

          {/* V6: FAB Novo e-mail */}
          <button
            type="button"
            onClick={() => {
              setComposeOpen(true);
              setComposeMinimized(false);
            }}
            title="Novo e-mail"
            className="absolute bottom-5 right-5 z-20 h-14 w-14 rounded-full bg-[var(--accent)] hover:brightness-110 active:scale-95 shadow-elevated flex items-center justify-center transition transform"
          >
            <Send size={20} className="text-white" />
          </button>
        </section>

        {/* RESIZER 2 */}
        <Resizer onPointerDown={(e) => startDrag('list', e)} />

        {/* READER */}
        <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          {!messageDetail && (
            <div className="flex-1 flex flex-col items-center justify-center opacity-70 p-4">
              <div className="h-16 w-16 rounded-3xl border panel-border bg-[var(--panel)]/25 flex items-center justify-center">
                <Mail size={28} />
              </div>
              <p className="mt-4 text-lg font-semibold">Selecione um e-mail para ler</p>
              <p className="mt-1 text-xs opacity-70">Use "Anexar ao processo" para registrar evidências.</p>
            </div>
          )}

          {messageDetail && (
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-4">
              <div className="sap-card overflow-hidden flex-1 min-h-0 flex flex-col">
                {/* header */}
                <div className="shrink-0 border-b panel-border bg-[var(--panel)]/35 backdrop-blur">
                  <div className="p-4 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-lg md:text-xl font-bold truncate">
                        {messageDetail.subject || '(Sem assunto)'}
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs opacity-80">
                        <Chip>
                          De: {messageDetail.from_name || ''} &lt;{messageDetail.from_email || ''}&gt;
                        </Chip>
                        <Chip>Data: {formatDate(messageDetail.received_at)}</Chip>
                        {!!messageDetail.to?.length && <Chip>Para: {messageDetail.to.join('; ')}</Chip>}
                        {!!messageDetail.cc?.length && <Chip>Cc: {messageDetail.cc.join('; ')}</Chip>}
                        {(() => {
                          const readByNames = Array.from(new Set([
                            ...(Array.isArray(messageDetail.read_by) ? messageDetail.read_by : []),
                            ...(readByMap[messageDetail.id]
                              ? [readByMap[messageDetail.id]]
                              : messageDetail.is_read_local
                                ? [user?.nome || 'você']
                                : []),
                          ])).filter(Boolean);
                          return readByNames.length > 0 ? (
                            <Chip tone="success">
                              Lido por {readByNames.join(', ')}
                            </Chip>
                          ) : null;
                        })()}
                      </div>
                    </div>

                    {/* actions */}
                      <div className="flex flex-wrap gap-2 justify-end">
                        <button
                          className="btn-themed text-xs"
                          onClick={() => {
                            setLinkMinimized(false);
                            setLinkOpen(true);
                          }}
                          type="button"
                        >
                          Anexar ao processo
                        </button>

                      <div className="flex items-center gap-2">
                        {(messageDetail?.linked_processo_id ||
                          selectedMessage?.linked_processo_id ||
                          selectedThread?.linkedProcessId) && (
                          <IconBtn title="Analisar com IA" onClick={handleAnalyzeAI}>
                            <MessagesSquare size={16} />
                          </IconBtn>
                        )}

                        <IconBtn title="Responder" onClick={() => openReplyModal('reply')}>
                          <Reply size={16} />
                        </IconBtn>

                        <IconBtn title="Responder a todos" onClick={() => openReplyModal('replyAll')}>
                          <ReplyAll size={16} />
                        </IconBtn>

                        <IconBtn
                          title="Encaminhar"
                          onClick={() => openReplyModal('forward')}
                        >
                          <Forward size={16} />
                        </IconBtn>


                        <IconBtn title="Arquivar" disabled={!archiveFolderId} onClick={() => handleMove(archiveFolderId)}>
                          <Archive size={16} />
                        </IconBtn>

                        <IconBtn title="Excluir" disabled={!deletedFolderId} onClick={() => handleMove(deletedFolderId)}>
                          <Trash2 size={16} />
                        </IconBtn>
                      </div>
                    </div>
                  </div>
                </div>

                {/* body */}
                <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
                  <div className="rounded-2xl border panel-border bg-[var(--bg)]/35 p-4">
                    {detailLoading && (
                      <div className="text-xs opacity-70 mb-2">Carregando conteúdo...</div>
                    )}
                    <div
                      className="email-body text-sm leading-relaxed"
                      style={{ wordBreak: 'break-word' }}
                      dangerouslySetInnerHTML={{ __html: sanitizedBodyHtml }}
                    />
                    {inlineBusy && (
                      <div className="mt-2 text-[11px] opacity-60">Carregando imagens...</div>
                    )}
                  </div>

                  {/* conversation/thread list */}
                  {groupByThread && selectedThread?.kind === 'thread' && selectedThread.count > 1 && (
                    <div className="rounded-2xl border panel-border bg-[var(--panel)]/25 overflow-hidden">
                      <div className="p-3 border-b panel-border flex items-center justify-between">
                        <div className="text-sm font-semibold">Conversa</div>
                        <Chip>{selectedThread.count} mensagens</Chip>
                      </div>
                      <div className="max-h-56 overflow-auto">
                        {selectedThread.items.map((itm) => {
                          const isActive = itm.id === selectedMessage?.id;
                          return (
                            <button
                              key={itm.id}
                              type="button"
                              onClick={() => setSelectedMessage(itm)}
                              className={cx(
                                'w-full text-left p-3 border-b panel-border hover:bg-[var(--panel)]/40 transition',
                                isActive && 'bg-[var(--panel)]/60'
                              )}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className={cx('text-sm truncate', itm.is_read ? 'font-medium' : 'font-semibold')}>
                                  {itm.from_name || itm.from_email || '(Sem remetente)'}
                                </div>
                                <div className="text-[11px] opacity-70 shrink-0">{formatDate(itm.received_at)}</div>
                              </div>
                              <div className="text-xs opacity-70 truncate mt-0.5">{itm.snippet}</div>
                              <div className="mt-2 flex items-center gap-2">
                                {!itm.is_read_local && <Chip tone="info">Não lido</Chip>}
                                {itm.has_attachments && (
                                  <Chip>
                                    <Paperclip size={12} /> Anexo
                                  </Chip>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* attachments — V10 cards visuais */}
                  {attachments.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <div className="text-sm font-semibold flex items-center gap-2">
                          <Paperclip size={14} className="opacity-70" />
                          Anexos
                        </div>
                        <Chip>{attachments.length} arquivo(s)</Chip>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {attachments.map((a) => {
                          const meta = attachmentMetaFor(a);
                          const sizeLabel = formatFileSize(a.size);
                          return (
                            <div
                              key={a.id}
                              className="group flex items-center gap-3 border panel-border rounded-xl p-2.5 bg-[var(--panel)]/30 hover:bg-[var(--panel)]/50 transition"
                            >
                              <div
                                className={cx(
                                  'shrink-0 h-11 w-11 rounded-lg border flex items-center justify-center text-[10px] font-bold tracking-wide',
                                  meta.tone
                                )}
                              >
                                {meta.short}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium truncate" title={a.name}>
                                  {a.name}
                                </div>
                                <div className="text-[11px] opacity-70 truncate flex items-center gap-1.5">
                                  <span>{meta.label}</span>
                                  {sizeLabel && (
                                    <>
                                      <span className="opacity-50">·</span>
                                      <span>{sizeLabel}</span>
                                    </>
                                  )}
                                </div>
                              </div>
                              <button
                                className="shrink-0 h-8 w-8 rounded-lg border panel-border bg-[var(--panel)]/40 hover:bg-[var(--panel)] transition flex items-center justify-center opacity-70 group-hover:opacity-100"
                                onClick={() =>
                                  downloadMailAttachment(messageDetail.id, a.id).then((resp) => downloadBlob(resp, a.name))
                                }
                                type="button"
                                title="Baixar anexo"
                              >
                                <Download size={14} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      <ComposeModal
        open={composeOpen}
        minimized={composeMinimized}
        onMinimize={() => setComposeMinimized(true)}
        onClose={() => setComposeOpen(false)}
        onSend={handleSend}
        seed={composeSeed}
      />
      {composeOpen && composeMinimized && (
        <button
          type="button"
          onClick={() => setComposeMinimized(false)}
          className="fixed bottom-4 right-6 z-[200] flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border transition-colors"
          style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
          title="Expandir novo e-mail"
        >
          <div className="w-8 h-8 rounded-lg bg-blue-600/20 flex items-center justify-center">
            <Send size={14} className="text-blue-400" />
          </div>
          <div className="text-left">
            <div className="text-xs font-semibold">Novo e-mail</div>
            <div className="text-[11px] opacity-50">Clique para continuar</div>
          </div>
          <ChevronUp size={13} className="opacity-40 ml-1" />
        </button>
      )}
      <ReplyForwardModal
        open={replyOpen}
        mode={replyMode}
        onClose={() => setReplyOpen(false)}
        onSend={handleReplySend}
      />
      <MailAIModal
        open={aiOpen}
        loading={aiLoading}
        result={aiResult}
        error={aiError}
        onClose={() => setAiOpen(false)}
        onUseDraft={handleUseDraft}
      />
      <LinkProcessModal
        open={linkOpen}
        minimized={linkMinimized}
        onMinimize={() => {
          setLinkMinimized(true);
          try {
            localStorage.setItem('mail_link_minimized', '1');
            window.dispatchEvent(new CustomEvent('mail-link-minimized', { detail: { minimized: true } }));
          } catch {
            // ignore
          }
        }}
        onClose={() => {
          setLinkMinimized(false);
          setLinkOpen(false);
          try {
            localStorage.removeItem('mail_link_minimized');
            window.dispatchEvent(new CustomEvent('mail-link-minimized', { detail: { minimized: false } }));
          } catch {
            // ignore
          }
        }}
        onConfirm={(payload) => {
          setLinkMinimized(false);
          try {
            localStorage.removeItem('mail_link_minimized');
            window.dispatchEvent(new CustomEvent('mail-link-minimized', { detail: { minimized: false } }));
          } catch {
            // ignore
          }
          handleLink(payload);
        }}
        linkedFolderId={linkedFolderId}
        loading={linking}
        etapaSubMap={etapaSubMap}
      />

      {linkOpen && linkMinimized && (
        <div className="fixed left-4 bottom-4 z-50">
          <button
            type="button"
            onClick={() => setLinkMinimized(false)}
            className="sap-card px-4 py-3 border panel-border bg-[var(--panel)]/90 shadow-lg flex items-center gap-3"
            title="Expandir anexar ao processo"
          >
            <div className="h-9 w-9 rounded-lg bg-[var(--muted)]/30 flex items-center justify-center border panel-border">
              <Link2 size={16} />
            </div>
            <div className="text-left">
              <div className="text-sm font-semibold">Anexar ao processo</div>
              <div className="text-[11px] opacity-70">Clique para continuar</div>
            </div>
          </button>
        </div>
      )}

      <Toast
        open={toast.open}
        type={toast.type}
        message={toast.message}
        onClose={() => setToast((t) => ({ ...t, open: false }))}
      />
    </div>
  );
};

export default CaixaDeEmail;
