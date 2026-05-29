// src/components/requisicoes/ReqEmailModal.jsx
//
// Modal de geração e envio de email com IA para requisições.
// Extraído de AdminPlanilha.jsx (linha 2831).
//
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import { createPortal } from 'react-dom';
import { Mail, X } from 'lucide-react';
import {
  pickFirst,
  formatPeriodosIrregularidade,
} from '../../pages/utils/processosHelpers.js';
import api from '../../services/apiClient';
import { useEmailCompose } from '../../context/EmailComposeContext.jsx';

const REQ_QUILL_MODULES = {
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

const REQ_SIGNATURE_HTML =
  '<br/><br/><img src="/assinatura_complaint.png" alt="assinatura" style="max-width:260px;height:auto;" />';

const withReqSignature = (html) =>
  html && html.includes('assinatura_complaint.png') ? html : `${html || ''}${REQ_SIGNATURE_HTML}`;

export default function ReqEmailModal({ reqInfo, reqFaturas, onClose }) {
  const { openCompose } = useEmailCompose();
  const [to, setTo]           = useState('');
  const [cc, setCc]           = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody]       = useState('');
  const [generating, setGenerating] = useState(false);
  const [sending, setSending]       = useState(false);
  const [sent, setSent]             = useState(false);
  const [error, setError]           = useState('');
  const [files, setFiles]           = useState([]);
  const fileRef  = useRef(null);
  const quillRef = useRef(null);

  // Paste images inline
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
  }, [body]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError('');
    try {
      const uc          = pickFirst(reqInfo, ['uc', 'UC'], '');
      const cliente     = pickFirst(reqInfo, ['cliente', 'Cliente', 'razao_social_fatura'], '');
      const concessionaria = pickFirst(reqInfo, ['concessionaria', 'Concessionaria'], '');
      const periodos    = formatPeriodosIrregularidade(
        reqInfo?.periodos_irregularidade ?? reqInfo?.periodosIrregularidade,
      );
      const tipoNome    = pickFirst(reqInfo, ['tipo_irregularidade', 'irregularidade', 'tipoIrregularidade', 'nome_tipo_irregularidade'], '');
      const subtipoNome = pickFirst(reqInfo, ['subtipo_irregularidade', 'sub_irregularidade', 'subtipoIrregularidade', 'nome_subtipo_irregularidade'], '');
      const descricao   = pickFirst(reqInfo, ['descricao_irregularidade', 'descricaoIrregularidade'], '');
      const valor       = String(pickFirst(reqInfo, ['ressarcimento_estimado', 'valor_estimado', 'valorEstimado'], '') || '');
      const linkFatura  = pickFirst(reqInfo, ['link_fatura', 'linkFatura', 'link'], '');
      const endereco    = pickFirst(reqInfo, ['endereco_completo', 'enderecoCompleto', 'endereco'], '');

      let faturasCtx = '';
      if (Array.isArray(reqFaturas) && reqFaturas.length > 0) {
        faturasCtx = '\nFaturas vinculadas:\n' + reqFaturas
          .map(f => `- ${f?.mes_ref || f?.MesRef || ''}: ${f?.link || f?.Link || ''}`)
          .filter(l => l.trim() !== '-:')
          .join('\n');
      }

      const res = await api.post('/faturas/aisure/gerar-email', {
        uc,
        cliente,
        concessionaria,
        periodos,
        tipo_irregularidade:      tipoNome,
        subtipo_irregularidade:   subtipoNome,
        problema_identificado:    descricao,
        descricao_irregularidade: descricao,
        ressarcimento_estimado:   valor,
        link_fatura:              linkFatura,
        endereco,
        analise_ia:               '',
        calc_financeiro:          faturasCtx,
      });

      const emailText = res.data?.email || '';
      const subjectMatch = emailText.match(/<strong>Assunto:<\/strong>\s*([^<]+)/i);
      const extractedSubject = subjectMatch ? subjectMatch[1].trim() : '';
      const fallbackSubject = ['Reclamação', tipoNome, `UC ${uc}`, periodos]
        .filter(Boolean).join(' – ');
      setSubject(prev => prev || extractedSubject || fallbackSubject);
      setBody(emailText.replace(/<p><strong>Assunto:<\/strong>[^<]*<\/p>\s*/i, ''));
    } catch (e) {
      setError(e?.response?.data?.error || 'Erro ao gerar email.');
    } finally {
      setGenerating(false);
    }
  }, [reqInfo, reqFaturas]);

  useEffect(() => { handleGenerate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = async () => {
    if (!to.trim()) { setError('Informe o destinatário.'); return; }
    setSending(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('to', to);
      if (cc) fd.append('cc', cc);
      fd.append('subject', subject);
      fd.append('body', withReqSignature(body));
      fd.append('body_type', 'HTML');
      files.forEach(f => fd.append('attachments', f));
      await api.post('/mail/send', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setSent(true);
      setTimeout(() => { setSent(false); onClose(); }, 1800);
    } catch (e) {
      setError(e?.response?.data?.error || 'Erro ao enviar.');
    } finally {
      setSending(false);
    }
  };

  const handleOpenInComposer = () => {
    openCompose({ subject, body: withReqSignature(body), to, cc });
    onClose();
  };

  const uc      = pickFirst(reqInfo, ['uc', 'UC'], '');
  const cliente = pickFirst(reqInfo, ['cliente', 'Cliente', 'razao_social_fatura'], '');
  const tipoNome = pickFirst(reqInfo, ['tipo_irregularidade', 'irregularidade', 'nome_tipo_irregularidade'], '');

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative z-10 flex flex-col rounded-2xl shadow-2xl border border-[var(--border)] bg-[var(--bg)] overflow-hidden"
        style={{ width: 760, height: '88vh', maxHeight: 740 }}
        onClick={e => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-3.5 flex-shrink-0 select-none"
          style={{ background: 'linear-gradient(135deg, #1e3a5f, #0f2340)' }}
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-500/20 flex items-center justify-center flex-shrink-0">
              <Mail size={17} className="text-blue-300" />
            </div>
            <div className="min-w-0">
              <div className="text-white text-sm font-semibold">Gerar Email com IA</div>
              <div className="text-white/50 text-[11px] truncate max-w-[480px]">
                {uc && <span className="text-blue-300/80">UC {uc}</span>}
                {uc && cliente && <span className="text-white/30 mx-1.5">·</span>}
                {cliente && <span>{cliente}</span>}
                {tipoNome && <span className="text-white/30 mx-1.5">·</span>}
                {tipoNome && <span className="text-white/60">{tipoNome}</span>}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex-shrink-0 border-b border-[var(--border)]">
          {[
            { label: 'Para', value: to, set: setTo, placeholder: 'destinatario@distribuidora.com' },
            { label: 'Cc',   value: cc, set: setCc,  placeholder: 'copia@email.com' },
          ].map(({ label, value, set, placeholder }) => (
            <div key={label} className="flex items-center border-b border-[var(--border)] px-4">
              <span className="text-xs opacity-40 w-14 flex-shrink-0">{label}</span>
              <input
                className="flex-1 py-2 text-xs bg-transparent focus:outline-none"
                value={value}
                onChange={e => set(e.target.value)}
                placeholder={placeholder}
              />
            </div>
          ))}
          <div className="flex items-center px-4">
            <span className="text-xs opacity-40 w-14 flex-shrink-0">Assunto</span>
            <input
              className="flex-1 py-2 text-xs bg-transparent focus:outline-none font-medium"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Assunto do email"
            />
          </div>
        </div>

        {generating ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-blue-600/15 flex items-center justify-center">
              <svg className="animate-spin w-6 h-6 text-blue-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
            </div>
            <div className="text-center">
              <div className="text-sm font-medium">Gerando email com IA...</div>
              <div className="text-xs opacity-50 mt-1">Analisando irregularidades e montando evidências</div>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            <ReactQuill
              ref={quillRef}
              theme="snow"
              value={withReqSignature(body)}
              onChange={setBody}
              modules={REQ_QUILL_MODULES}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
              className="flex-1 text-xs"
            />
          </div>
        )}

        <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-[var(--border)] flex-shrink-0 bg-[var(--panel)]/50">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-[var(--border)] hover:bg-[var(--panel)] transition-colors disabled:opacity-40"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
              Regenerar
            </button>
            <input ref={fileRef} type="file" multiple className="hidden" onChange={e => setFiles(Array.from(e.target.files))} />
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-[var(--border)] hover:bg-[var(--panel)] transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
              </svg>
              {files.length > 0 ? `${files.length} arquivo(s)` : 'Anexar'}
            </button>
            <button
              onClick={handleOpenInComposer}
              disabled={generating || !body}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-[var(--border)] hover:bg-[var(--panel)] transition-colors disabled:opacity-40"
              title="Abrir no compositor flutuante"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
              </svg>
              Compositor
            </button>
            {error && <span className="text-xs text-red-400">{error}</span>}
            {sent  && <span className="text-xs text-green-400 font-medium">Enviado!</span>}
          </div>
          <button
            onClick={handleSend}
            disabled={sending || generating}
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
    </div>,
    document.body,
  );
}
