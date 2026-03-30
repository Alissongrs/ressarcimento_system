import React, { useEffect, useRef, useState } from 'react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import { useEmailCompose } from '../context/EmailComposeContext.jsx';
import apiClient from '../services/apiClient.js';

const SIGNATURE_HTML =
  '<br/><br/><img src="/assinatura_complaint.png" alt="assinatura" style="max-width:260px;height:auto;" />';

const withSignature = (html) =>
  html && html.includes('assinatura_complaint.png') ? html : `${html || ''}${SIGNATURE_HTML}`;

const QUILL_MODULES = {
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

export default function FloatingEmailComposer() {
  const { state, closeCompose, minimize, restore, updateBody, updateField } = useEmailCompose();
  const [sending, setSending] = useState(false);
  const [sent, setSent]       = useState(false);
  const [error, setError]     = useState('');
  const [files, setFiles]     = useState([]);
  const fileRef  = useRef(null);
  const quillRef = useRef(null);

  // Habilita colar prints/screenshots diretamente no editor (como Outlook)
  useEffect(() => {
    const quill = quillRef.current?.getEditor();
    if (!quill) return;
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
  }, [state]);

  if (!state) return null;

  const { minimized, to, cc, subject, body } = state;

  const handleSend = async () => {
    if (!to.trim()) { setError('Informe o destinatário.'); return; }
    setSending(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('to', to);
      if (cc) fd.append('cc', cc);
      fd.append('subject', subject);
      fd.append('body', withSignature(body));
      fd.append('body_type', 'HTML');
      files.forEach(f => fd.append('attachments', f));
      await apiClient.post('/api/v1/mail/send', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setSent(true);
      setTimeout(() => { setSent(false); closeCompose(); }, 1800);
    } catch (e) {
      setError(e?.response?.data?.error || 'Erro ao enviar.');
    } finally {
      setSending(false);
    }
  };

  /* ── Barra minimizada ── */
  if (minimized) {
    return (
      <button
        onClick={restore}
        className="fixed bottom-4 right-6 z-[200] flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border border-[var(--border)] bg-[var(--panel)]/95 backdrop-blur-sm hover:bg-[var(--panel)] transition-colors"
      >
        <div className="w-8 h-8 rounded-lg bg-blue-600/20 flex items-center justify-center">
          <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
          </svg>
        </div>
        <div className="text-left">
          <div className="text-xs font-semibold">{subject || 'Nova mensagem'}</div>
          <div className="text-[11px] opacity-50">{to || 'Sem destinatário'}</div>
        </div>
        <svg className="w-3.5 h-3.5 opacity-40 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7"/>
        </svg>
      </button>
    );
  }

  /* ── Janela completa ── */
  return (
    <div
      className="fixed bottom-0 right-6 z-[200] flex flex-col rounded-t-xl shadow-2xl border border-[var(--border)] bg-[var(--bg)]"
      style={{ width: 640, height: 560 }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2.5 rounded-t-xl flex-shrink-0 select-none"
        style={{ background: 'linear-gradient(135deg, #1e3a5f, #0f2340)' }}
      >
        <span className="text-white text-sm font-semibold truncate max-w-[380px]">
          {subject || 'Nova mensagem'}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={minimize}
            className="w-6 h-6 rounded flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10"
            title="Minimizar"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4"/>
            </svg>
          </button>
          <button
            onClick={closeCompose}
            className="w-6 h-6 rounded flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10"
            title="Fechar"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Campos de cabeçalho */}
      <div className="flex-shrink-0 border-b border-[var(--border)]">
        <div className="flex items-center border-b border-[var(--border)] px-3">
          <span className="text-xs opacity-40 w-14 flex-shrink-0">Para</span>
          <input
            className="flex-1 py-2 text-xs bg-transparent focus:outline-none"
            value={to}
            onChange={e => updateField('to', e.target.value)}
            placeholder="destinatario@email.com"
          />
        </div>
        <div className="flex items-center border-b border-[var(--border)] px-3">
          <span className="text-xs opacity-40 w-14 flex-shrink-0">Cc</span>
          <input
            className="flex-1 py-2 text-xs bg-transparent focus:outline-none"
            value={cc}
            onChange={e => updateField('cc', e.target.value)}
            placeholder="cópia@email.com"
          />
        </div>
        <div className="flex items-center px-3">
          <span className="text-xs opacity-40 w-14 flex-shrink-0">Assunto</span>
          <input
            className="flex-1 py-2 text-xs bg-transparent focus:outline-none font-medium"
            value={subject}
            onChange={e => updateField('subject', e.target.value)}
            placeholder="Assunto do email"
          />
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        <ReactQuill
          ref={quillRef}
          theme="snow"
          value={withSignature(body)}
          onChange={updateBody}
          modules={QUILL_MODULES}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          className="flex-1 text-xs"
        />
      </div>

      {/* Rodapé */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-[var(--border)] flex-shrink-0 bg-[var(--panel)]/50">
        <div className="flex items-center gap-2">
          {/* Anexo */}
          <input ref={fileRef} type="file" multiple className="hidden" onChange={e => setFiles(Array.from(e.target.files))} />
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-[var(--border)] hover:bg-[var(--panel)] transition-colors"
            title="Anexar arquivo"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
            </svg>
            {files.length > 0 ? `${files.length} arquivo(s)` : 'Anexar'}
          </button>
          {error && <span className="text-xs text-red-400">{error}</span>}
          {sent  && <span className="text-xs text-green-400">Enviado!</span>}
        </div>

        <button
          onClick={handleSend}
          disabled={sending}
          className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-white text-sm font-semibold disabled:opacity-50 transition-colors"
          style={{ backgroundColor: '#1d4ed8' }}
        >
          {sending ? (
            <><svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg> Enviando...</>
          ) : (
            <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg> Enviar</>
          )}
        </button>
      </div>
    </div>
  );
}
